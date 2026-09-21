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
  /**
   * Stop after this filename (inclusive), leaving anything later unapplied.
   *
   * A restore rebuilds the schema at the level the dump was taken at, not at
   * the level this build happens to ship: data copied back into a table that a
   * newer migration has already reshaped would not fit. The newer migrations
   * are then applied on top, in a second pass, with the data in place — which
   * is exactly what they were written to handle.
   *
   * A name that is not in the directory is an error, not a silent full run.
   */
  upTo?: string | undefined;
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
    // A directory that is not there used to be "nothing to do", which is the
    // one answer it cannot be: a manifest that names a migrations directory is
    // a plugin saying it owns tables, and the usual way to get here is a path
    // built wrongly — `new URL(...).pathname` percent-encodes a space, so an
    // installation under "owner data" or "Application Support" silently
    // applied no migrations at all and installed a plugin owning an empty
    // schema. An empty `migrationsDir` is how a plugin says it owns nothing.
    if (e.code === 'ENOENT') {
      throw new Error(
        `migrate: ${schema}: no migrations directory at ${opts.dir} ` +
          '(a plugin that owns no tables leaves migrationsDir empty)',
        { cause: err },
      );
    }
    throw err;
  }
  let files = entries.filter((f) => f.endsWith('.sql')).sort();
  if (opts.upTo !== undefined) {
    const stop = files.indexOf(opts.upTo);
    if (stop === -1) {
      throw new Error(
        `migrate upTo: ${schema}/${opts.upTo} is not in ${opts.dir} ` +
          `(this build ships ${files.length} migration(s) for that schema)`,
      );
    }
    files = files.slice(0, stop + 1);
  }

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
