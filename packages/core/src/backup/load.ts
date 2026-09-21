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
import { createReadStream, existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Pool, PoolClient } from 'pg';
import copyStreams from 'pg-copy-streams';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, migrate, type AppliedMigration } from '../db.js';
import {
  DB_MIGRATIONS_NAME,
  MANIFEST_FORMAT,
  MANIFEST_NAME,
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

/**
 * Schema names a restore will never drop, whoever asks it to.
 *
 * `public` is not buddi's — it is Postgres's own, and on a shared server it
 * holds whatever else that database does. The catalog schemas are worse: a
 * `drop schema pg_catalog cascade` is the end of the cluster. The archive is
 * the untrusted half of a restore, so a name it supplies is checked against
 * this list rather than quoted into SQL and hoped about.
 */
const NEVER_DROP = new Set(['public', 'information_schema']);

export function schemaDropProblem(schema: string): string | null {
  if (NEVER_DROP.has(schema) || schema.startsWith('pg_')) {
    return `refusing to drop schema "${schema}": it is not buddi's to drop`;
  }
  try {
    quote(schema);
  } catch {
    return `refusing to use ${JSON.stringify(schema)} as a schema name`;
  }
  return null;
}

/**
 * Which schemas this restore may drop.
 *
 * Three sources, and the archive is not one of them: `core`, the schemas this
 * build ships migrations for, and the schemas the *target's own* ledger says it
 * migrated. A schema that only the archive names cannot be rebuilt here anyway
 * (`planSchemas` reports it as missing), so dropping it on the archive's word
 * would be taking an instruction from a file someone else wrote.
 */
export function schemasToDrop(
  sources: readonly MigrationSource[],
  targetLedger: readonly string[],
): string[] {
  const owned = new Set<string>([CORE_SCHEMA]);
  for (const source of sources) if (source.schema.trim() !== '') owned.add(source.schema);
  for (const schema of targetLedger) owned.add(schema);
  return [...owned].sort();
}

/** Is `upTo` a file this build actually ships for that schema? */
async function assertUpTo(schema: string, dir: string, upTo: string | undefined): Promise<void> {
  if (upTo === undefined) return;
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
  } catch {
    throw new LoadError(`${schema}: ${dir} is not a migrations directory this build can read`);
  }
  if (!files.includes(upTo)) {
    throw new LoadError(
      `the archive's schema for "${schema}" stops at ${upTo}, which this build does not ship. ` +
        'The backup was taken by a newer buddi; upgrade before restoring it. Nothing was changed.',
    );
  }
}

/** The manifest's format, when the stage holds one. Refused before any drop. */
async function assertManifestFormat(stageDir: string): Promise<void> {
  const file = path.join(stageDir, MANIFEST_NAME);
  if (!existsSync(file)) return;
  let format: unknown;
  try {
    format = (JSON.parse(await readFile(file, 'utf8')) as { format?: unknown }).format;
  } catch (err) {
    throw new LoadError(
      `${MANIFEST_NAME} could not be read: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof format !== 'number' || format > MANIFEST_FORMAT) {
    throw new LoadError(
      `this archive is format ${String(format)}; this build reads format ${MANIFEST_FORMAT}. ` +
        'Upgrade buddi before restoring it. Nothing was changed.',
    );
  }
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

  /* 0. everything that can refuse, before anything is dropped -------- */
  // A restore that fails in the middle is a restore that destroyed a working
  // installation to load an archive it then could not load. Everything that
  // can say no — the format, the schema names, the migration levels — says it
  // here, with the target still untouched.
  await assertManifestFormat(stageDir);

  const coreUpTo = migrations.core[migrations.core.length - 1];
  const targetLedger: string[] = [];
  try {
    const { rows } = await pool.query<{ schema: string }>(`select distinct schema from core.migrations`);
    for (const row of rows) targetLedger.push(row.schema);
  } catch {
    // Nothing has ever migrated here. There is nothing to drop.
  }

  // Both lists are checked: the archive's names never reach a `drop`, but one
  // naming `public` is a malformed or hostile archive and is worth refusing
  // outright rather than quietly ignoring.
  const owned = schemasToDrop(opts.pluginMigrations ?? [], targetLedger);
  for (const schema of [...Object.keys(migrations.plugins), ...owned]) {
    const problem = schemaDropProblem(schema);
    if (problem !== null) throw new LoadError(`${problem}. Nothing was changed.`);
  }

  await assertUpTo(CORE_SCHEMA, coreDir, coreUpTo);
  for (const entry of plan.rebuild) await assertUpTo(entry.schema, entry.dir, entry.upTo);

  /* 1. the schema, at the dump's level ------------------------------- */
  progress({ phase: 'database', detail: 'rebuilding the schema at the level the dump was taken at' });

  // Every schema this installation owns goes, not only the ones the dump has:
  // a table left behind from a schema the dump does not know would survive the
  // restore and be a row of somebody else's data in a restored installation.
  for (const schema of owned) {
    await pool.query(`drop schema if exists ${quote(schema)} cascade`);
  }

  await migrate(pool, { schema: CORE_SCHEMA, dir: coreDir, ...(coreUpTo ? { upTo: coreUpTo } : {}) });
  for (const entry of plan.rebuild) {
    await migrate(pool, {
      schema: entry.schema,
      dir: entry.dir,
      ...(entry.upTo ? { upTo: entry.upTo } : {}),
    });
  }

  /*
   * Everything else this installation owns, back at its current level.
   *
   * A schema is dropped above because this build ships migrations for it or
   * the target's own ledger named it, and it is rebuilt only when the archive
   * names it too. An archive that does not name it — a snapshot of a target
   * taken before that plugin first migrated, or an archive from an
   * installation that never had the plugin — used to leave the schema dropped
   * and absent, with no ledger row to say so: an installed plugin whose tables
   * were simply gone until something migrated the database again. It carries
   * no data here, so empty and migrated is the right state, and it is the
   * state the next start would have produced anyway.
   *
   * It runs in step 4, after the load has committed, because the load rewrites
   * `core.migrations` from the archive: a schema migrated before the COPY
   * would end up present and unrecorded.
   */
  const unrebuilt = (opts.pluginMigrations ?? []).filter(
    (source) =>
      source.dir.trim() !== '' && source.schema !== CORE_SCHEMA && !rebuilt.has(source.schema),
  );


  /* 2. the data, in one transaction ---------------------------------- */
  progress({ phase: 'database', detail: `loading ${tables.length} table(s)` });
  const client = await pool.connect();
  const loaded: LoadReport['loaded'] = [];
  const skipped: LoadReport['notLoaded'] = [];
  let triggersLeftOn = false;
  try {
    await client.query('begin');
    // Replica mode is what makes the order of the COPYs irrelevant and the
    // load atomic. A role without the privilege is not a reason to refuse the
    // restore: the tables are copied in dependency order anyway.
    //
    // The savepoint is what makes that fallback real. A packaged installation
    // runs as an ordinary role, which Postgres refuses this parameter — and a
    // refused statement aborts the *whole* transaction, so without a savepoint
    // to roll back to, every COPY below would fail with "current transaction is
    // aborted" and the restore would end rolled back.
    await client.query(`savepoint replica_mode`);
    try {
      await client.query(`set local session_replication_role = replica`);
      await client.query(`release savepoint replica_mode`);
    } catch {
      await client.query(`rollback to savepoint replica_mode`);
      await client.query(`release savepoint replica_mode`);
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
    // On the same client, inside the transaction, after the COPYs — but note
    // that `setval` is NOT transactional: a rollback below this point leaves
    // the sequences where these calls put them. That is why it runs last, when
    // nothing except the commit itself is still to fail, and why a rolled-back
    // load leaves sequences advanced rather than wrong: the next id is simply
    // higher than it needed to be, which nothing depends on.
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
    for (const source of unrebuilt) {
      try {
        report.applied.push(...(await migrate(pool, { schema: source.schema, dir: source.dir })));
      } catch (err) {
        // Reported, never fatal: this schema is not in the archive, so failing
        // the restore over it would lose an installation to save nothing.
        report.notLoaded.push({
          schema: source.schema,
          rows: 0,
          reason:
            'the archive does not describe it and this build could not create it either: ' +
            `${err instanceof Error ? err.message : String(err)}`,
        });
      }
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
