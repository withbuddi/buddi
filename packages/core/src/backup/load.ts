/**
 * The database half of a restore.
 *
 * The archive carries data, not DDL, so the schema has to come from somewhere:
 * it comes from our own migrations, replayed **up to the level the dump was
 * taken at**. That is the whole trick of this design. A dump taken three
 * migrations ago is loaded into the schema as it was three migrations ago —
 * where its columns still fit — and the newer migrations then run on top of the
 * restored data, which is what they were written to do. It also means a restore
 * needs no `pg_restore`, no version match between client and server, and no
 * binary at all.
 *
 * Order, and each step's reason:
 *
 *  1. drop and rebuild the buddi-owned schemas at the dump's level;
 *  2. load every table in one transaction with `session_replication_role =
 *     replica`, so foreign keys and triggers do not fire against half-loaded
 *     data and the whole load is all-or-nothing;
 *  3. reset every sequence, so the next insert gets the next id rather than 1;
 *  4. apply the migrations the dump did not have.
 *
 * A plugin whose package is not installed here cannot have its schema rebuilt.
 * That is reported as "not loaded", never thrown: an owner restoring on a new
 * machine should get their core installation back even if one plugin is still
 * to be reinstalled.
 */
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Pool, PoolClient } from 'pg';
import copyStreams from 'pg-copy-streams';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, migrate, type AppliedMigration } from '../db.js';
import {
  DB_MIGRATIONS_NAME,
  SEQUENCES_NAME,
  TABLES_NAME,
  copyFileName,
  type DumpedMigrations,
  type DumpedSequence,
  type DumpedTable,
} from './manifest.js';
import { quote } from './dump.js';

const { from: copyFrom } = copyStreams;

export class LoadError extends Error {}

/** Where the migrations for one schema live in *this* build. */
export interface MigrationSource {
  schema: string;
  /** Absolute directory of `*.sql`. Empty means the plugin owns no tables. */
  dir: string;
  /** The plugin's name, for the report. Core omits it. */
  plugin?: string;
}

export interface LoadOptions {
  /** Core's migrations. Defaults to the ones this package ships. */
  coreMigrationsDir?: string;
  /** One per installed plugin that has a schema. Anything missing is reported. */
  pluginMigrations?: readonly MigrationSource[];
  onProgress?: ((step: { phase: string; detail?: string }) => void) | undefined;
}

export interface LoadReport {
  /** `schema.table` → rows copied in. */
  loaded: Array<{ table: string; rows: number }>;
  sequences: number;
  /** What the dump held that this installation could not take: a plugin schema
   * it cannot rebuild, or a table its migrations do not create. */
  notLoaded: Array<{ schema: string; table?: string; rows: number; reason: string }>;
  /** Migrations newer than the dump, applied after the data was in place. */
  applied: AppliedMigration[];
  /** True when `session_replication_role = replica` was refused (not fatal). */
  triggersLeftOn: boolean;
}

async function readJson<T>(file: string): Promise<T> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (err) {
    throw new LoadError(
      `${path.basename(file)} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * `setval` arguments for one sequence.
 *
 * Kept pure because the bug it prevents is silent and only shows up later: a
 * sequence restored with `is_called = false` hands out its own last value
 * again, and the first insert after a restore fails on a duplicate key.
 */
export function setvalFor(sequence: DumpedSequence): { sql: string; params: [string, string, boolean] } {
  return {
    sql: `select setval($1::regclass, $2::bigint, $3)`,
    params: [
      `${quote(sequence.schema)}.${quote(sequence.name)}`,
      sequence.lastValue,
      sequence.isCalled,
    ],
  };
}

/** Which schemas this build can rebuild, and which it cannot. */
export function planSchemas(
  migrations: DumpedMigrations,
  sources: readonly MigrationSource[],
): { rebuild: Array<{ schema: string; dir: string; upTo: string | undefined }>; missing: string[] } {
  const rebuild: Array<{ schema: string; dir: string; upTo: string | undefined }> = [];
  const missing: string[] = [];
  for (const entry of Object.values(migrations.plugins)) {
    const source = sources.find((s) => s.schema === entry.schema && s.dir.trim() !== '');
    if (!source) {
      missing.push(entry.schema);
      continue;
    }
    rebuild.push({
      schema: entry.schema,
      dir: source.dir,
      upTo: entry.filenames[entry.filenames.length - 1],
    });
  }
  rebuild.sort((a, b) => a.schema.localeCompare(b.schema));
  return { rebuild, missing };
}

async function tablesPresent(client: PoolClient, schemas: string[]): Promise<Set<string>> {
  const { rows } = await client.query<{ schema: string; table: string }>(
    `select n.nspname as schema, c.relname as "table"
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname = any($1)`,
    [schemas],
  );
  return new Set(rows.map((r) => `${r.schema}.${r.table}`));
}

export async function loadDatabase(
  pool: Pool,
  stageDir: string,
  opts: LoadOptions = {},
): Promise<LoadReport> {
  const progress = opts.onProgress ?? ((): void => {});
  const migrations = await readJson<DumpedMigrations>(path.join(stageDir, DB_MIGRATIONS_NAME));
  const tables = await readJson<DumpedTable[]>(path.join(stageDir, TABLES_NAME));
  const sequences = await readJson<DumpedSequence[]>(path.join(stageDir, SEQUENCES_NAME));

  const plan = planSchemas(migrations, opts.pluginMigrations ?? []);
  const coreDir = opts.coreMigrationsDir ?? CORE_MIGRATIONS_DIR;
  const rebuilt = new Set<string>([CORE_SCHEMA, ...plan.rebuild.map((r) => r.schema)]);

  /* 1. the schema, at the dump's level ------------------------------- */
  progress({ phase: 'database', detail: 'rebuilding the schema at the level the dump was taken at' });

  // Every schema this installation owns goes, not only the ones the dump has:
  // a table left behind from a schema the dump does not know would survive the
  // restore and be a row of somebody else's data in a restored installation.
  const owned = new Set<string>([CORE_SCHEMA, ...Object.keys(migrations.plugins)]);
  try {
    const { rows } = await pool.query<{ schema: string }>(`select distinct schema from core.migrations`);
    for (const row of rows) owned.add(row.schema);
  } catch {
    // Nothing has ever migrated here. There is nothing to drop.
  }
  for (const schema of [...owned].sort()) {
    await pool.query(`drop schema if exists ${quote(schema)} cascade`);
  }

  const coreUpTo = migrations.core[migrations.core.length - 1];
  await migrate(pool, { schema: CORE_SCHEMA, dir: coreDir, ...(coreUpTo ? { upTo: coreUpTo } : {}) });
  for (const entry of plan.rebuild) {
    await migrate(pool, {
      schema: entry.schema,
      dir: entry.dir,
      ...(entry.upTo ? { upTo: entry.upTo } : {}),
    });
  }

  /* 2. the data, in one transaction ---------------------------------- */
  progress({ phase: 'database', detail: `loading ${tables.length} table(s)` });
  const client = await pool.connect();
  const loaded: LoadReport['loaded'] = [];
  const skipped: LoadReport['notLoaded'] = [];
  let triggersLeftOn = false;
  try {
    await client.query('begin');
    try {
      // Replica mode is what makes the order of the COPYs irrelevant and the
      // load atomic. A role without the privilege is not a reason to refuse the
      // restore: the tables are copied in dependency order anyway.
      await client.query(`set local session_replication_role = replica`);
    } catch {
      triggersLeftOn = true;
    }

    const present = await tablesPresent(client, [...rebuilt]);
    const targets = tables.filter((t) => rebuilt.has(t.schema));
    const copyable = targets.filter((t) => present.has(`${t.schema}.${t.table}`));
    if (copyable.length > 0) {
      // Seed rows a migration inserted would collide with the dump's own rows.
      // The dump is the truth here, so the freshly migrated tables are emptied.
      const list = copyable.map((t) => `${quote(t.schema)}.${quote(t.table)}`).join(', ');
      await client.query(`truncate ${list} restart identity cascade`);
    }

    for (const table of targets) {
      const qualified = `${quote(table.schema)}.${quote(table.table)}`;
      if (!present.has(`${table.schema}.${table.table}`)) {
        // A table no migration in this build creates: a leftover from a branch,
        // or a plugin that was uninstalled. Its rows are named in the report and
        // stay in the archive; refusing the whole restore over one such table
        // would be losing an installation to save a stale one.
        skipped.push({
          schema: table.schema,
          table: `${table.schema}.${table.table}`,
          rows: table.rows,
          reason: 'no migration in this build creates it, so there was nowhere to put its rows',
        });
        continue;
      }
      const file = path.join(stageDir, copyFileName(table.schema, table.table));
      const columns = table.columns.map(quote).join(', ');
      const sink = client.query(copyFrom(`copy ${qualified} (${columns}) from stdin`));
      await pipeline(createReadStream(file), sink);
      loaded.push({ table: `${table.schema}.${table.table}`, rows: table.rows });
    }

    /* 3. the sequences ---------------------------------------------- */
    let reset = 0;
    for (const sequence of sequences) {
      if (!rebuilt.has(sequence.schema)) continue;
      const { sql, params } = setvalFor(sequence);
      await client.query(sql, params);
      reset += 1;
    }

    // A plugin whose schema could not be rebuilt must not keep its rows in the
    // ledger: they would tell a later `buddi plugins install` that migrations
    // it never ran are already applied.
    if (plan.missing.length > 0) {
      await client.query(`delete from core.migrations where schema = any($1)`, [plan.missing]);
    }

    await client.query('commit');

    const report: LoadReport = {
      loaded,
      sequences: reset,
      notLoaded: [
        ...plan.missing.map((schema) => ({
          schema,
          rows: tables.filter((t) => t.schema === schema).reduce((sum, t) => sum + t.rows, 0),
          reason: `no plugin installed here owns schema "${schema}"; its tables were not restored`,
        })),
        ...skipped,
      ],
      applied: [],
      triggersLeftOn,
    };

    /* 4. the migrations the dump did not have ------------------------ */
    progress({ phase: 'database', detail: 'applying migrations newer than the dump' });
    report.applied.push(...(await migrate(pool, { schema: CORE_SCHEMA, dir: coreDir })));
    for (const entry of plan.rebuild) {
      report.applied.push(...(await migrate(pool, { schema: entry.schema, dir: entry.dir })));
    }
    return report;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err instanceof LoadError
      ? err
      : new LoadError(
          `the database could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
  } finally {
    client.release();
  }
}
