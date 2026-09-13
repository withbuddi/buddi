import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Pool } from 'pg';

const { Pool: PgPool } = pg;

export type MigrateOptions = {
  /** Postgres schema the migrations own. Created if missing. */
  schema: string;
  /** Directory of *.sql files, applied in filename order. */
  dir: string;
};

export type AppliedMigration = { schema: string; filename: string };

/** Absolute path to core's own migrations directory (ships with the package). */
export const CORE_MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrations',
);

export const CORE_SCHEMA = 'core';

export function createPool(databaseUrl: string): Pool {
  if (!databaseUrl || databaseUrl.trim() === '') {
    throw new Error('createPool: databaseUrl is required');
  }
  return new PgPool({ connectionString: databaseUrl });
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

function quoteIdent(name: string): string {
  if (!IDENT.test(name)) {
    throw new Error(`invalid schema identifier: ${name}`);
  }
  return `"${name}"`;
}

/**
 * Apply pending migrations for one schema.
 *
 * - `core.migrations` is created first, always, whatever schema is migrating.
 * - The target schema is created if missing.
 * - Each file runs in its own transaction with
 *   `SET LOCAL search_path TO <schema>, public`, then is recorded.
 * - Already-applied files are skipped (tracked by (schema, filename)).
 */
export async function migrate(
  pool: Pool,
  opts: MigrateOptions,
): Promise<AppliedMigration[]> {
  const schema = opts.schema;
  const qSchema = quoteIdent(schema);

  await pool.query(`create schema if not exists "core"`);
  await pool.query(
    `create table if not exists core.migrations (
       schema text not null,
       filename text not null,
       applied_at timestamptz not null default now(),
       primary key (schema, filename)
     )`,
  );
  await pool.query(`create schema if not exists ${qSchema}`);

  let entries: string[];
  try {
    entries = await readdir(opts.dir);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return [];
    throw err;
  }
  const files = entries.filter((f) => f.endsWith('.sql')).sort();

  const { rows } = await pool.query<{ filename: string }>(
    `select filename from core.migrations where schema = $1`,
    [schema],
  );
  const done = new Set(rows.map((r) => r.filename));

  const applied: AppliedMigration[] = [];
  for (const filename of files) {
    if (done.has(filename)) continue;
    const sql = await readFile(path.join(opts.dir, filename), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local search_path to ${qSchema}, public`);
      await client.query(sql);
      await client.query(
        `insert into core.migrations (schema, filename) values ($1, $2)`,
        [schema, filename],
      );
      await client.query('commit');
      applied.push({ schema, filename });
    } catch (err) {
      await client.query('rollback').catch(() => {});
      throw new Error(
        `migration failed: ${schema}/${filename}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    } finally {
      client.release();
    }
  }
  return applied;
}

/** Apply core's own migrations. */
export async function migrateCore(pool: Pool): Promise<AppliedMigration[]> {
  return migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
}
