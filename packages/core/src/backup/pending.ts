/**
 * Plugin data a restore kept for later.
 *
 * A restore into an installation that does not have a plugin yet — the normal
 * order on a fresh install: restore first, install the plugins after — cannot
 * rebuild that plugin's schema, because the schema comes from the plugin's own
 * migrations. It used to report the rows as "not loaded" and move on, and the
 * plugin installed afterwards came up with empty tables while the owner's data
 * sat in an archive nobody would open again.
 *
 * So that schema's part of the archive is kept: its COPY files and its slices
 * of `tables.json`, `sequences.json` and `migrations.json`, under
 * `<data>/restore/pending/<schema>/`, recorded in `core.pending_plugin_data`.
 * When the plugin is installed and its migrations have run (or at the next
 * start, for a plugin that is already there), `loadPendingPluginData` puts the
 * rows in:
 *
 *  - only when the plugin's ledger holds every migration the archive was taken
 *    at — data from a newer schema than the installed plugin's is not forced
 *    into older tables;
 *  - only into tables that exist and are empty — a table with rows is never
 *    overwritten; it stays staged and is named, so the owner can decide;
 *  - with foreign keys held off and added back, which re-checks every row;
 *  - sequences moved forward to the archive's, never back;
 *  - all in one transaction per schema, with the record updated in it, so a
 *    crash at any point either loaded and forgot, or did neither.
 *
 * The staged files are plaintext table data even when the archive was
 * encrypted. They live in the data dir, which holds the database's own files
 * on a packaged install, and are written owner-only (0700 / 0600).
 */
import { createReadStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Pool } from 'pg';
import copyStreams from 'pg-copy-streams';
import { quote } from './dump.js';
import { foreignKeysOf } from './load.js';
import {
  DB_MIGRATIONS_NAME,
  DIR_MODE,
  FILE_MODE,
  SEQUENCES_NAME,
  TABLES_NAME,
  copyFileName,
  type DumpedMigrations,
  type DumpedSequence,
  type DumpedTable,
} from './manifest.js';

const { from: copyFrom } = copyStreams;

/** `<data>/restore/pending` — one directory per schema below it. */
export function pendingDataRoot(dataDir: string): string {
  return path.join(dataDir, 'restore', 'pending');
}

export interface PendingTable {
  /** `schema.table`. */
  table: string;
  rows: number;
  /** Why this table is still staged after an attempt (it had rows), or null. */
  kept: string | null;
}

export interface PendingPluginData {
  schema: string;
  archive: string;
  stagedPath: string;
  tables: PendingTable[];
  rows: number;
  /** The archive's migration filenames for this schema. */
  migrations: string[];
  /** Why the last attempt left it waiting; null before any attempt. */
  reason: string | null;
  createdAt: string;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

async function writePrivate(file: string, body: string): Promise<void> {
  await writeFile(file, body, { mode: FILE_MODE });
  await chmod(file, FILE_MODE);
}

/**
 * Copy one schema's part of an unpacked archive into `dest`.
 *
 * `dest` is written fresh (the caller swaps it into place). Every directory is
 * 0700 and every file 0600: this is table data, and on an encrypted archive it
 * is the only plaintext copy outside the database.
 */
export async function writePendingSlice(
  stageDir: string,
  schema: string,
  dest: string,
): Promise<{ tables: PendingTable[]; rows: number; migrations: string[] }> {
  const tables = (await readJson<DumpedTable[]>(path.join(stageDir, TABLES_NAME))).filter(
    (t) => t.schema === schema,
  );
  const sequences = (await readJson<DumpedSequence[]>(path.join(stageDir, SEQUENCES_NAME))).filter(
    (s) => s.schema === schema,
  );
  const migrations = await readJson<DumpedMigrations>(path.join(stageDir, DB_MIGRATIONS_NAME));
  const plugins: DumpedMigrations['plugins'] = {};
  for (const [key, entry] of Object.entries(migrations.plugins)) {
    if (entry.schema === schema) plugins[key] = entry;
  }
  const filenames = Object.values(plugins).flatMap((e) => e.filenames);

  await rm(dest, { recursive: true, force: true });
  await mkdir(path.join(dest, 'db'), { recursive: true, mode: DIR_MODE });
  await chmod(dest, DIR_MODE);
  await chmod(path.join(dest, 'db'), DIR_MODE);
  for (const table of tables) {
    // quote() refuses a name that is not a plain identifier: the archive is
    // the untrusted half, and these names become file names and SQL later.
    quote(table.schema);
    quote(table.table);
    const name = copyFileName(table.schema, table.table);
    await copyFile(path.join(stageDir, name), path.join(dest, name));
    await chmod(path.join(dest, name), FILE_MODE);
  }
  await writePrivate(path.join(dest, TABLES_NAME), `${JSON.stringify(tables, null, 2)}\n`);
  await writePrivate(path.join(dest, SEQUENCES_NAME), `${JSON.stringify(sequences, null, 2)}\n`);
  await writePrivate(
    path.join(dest, DB_MIGRATIONS_NAME),
    `${JSON.stringify({ core: [], plugins } satisfies DumpedMigrations, null, 2)}\n`,
  );
  return {
    tables: tables.map((t) => ({ table: `${t.schema}.${t.table}`, rows: t.rows, kept: null })),
    rows: tables.reduce((sum, t) => sum + t.rows, 0),
    migrations: filenames,
  };
}

interface Queryable {
  query: Pool['query'];
}

/** Record (or replace) one schema's staged data. */
export async function recordPendingPluginData(
  db: Queryable,
  entry: Omit<PendingPluginData, 'reason' | 'createdAt'>,
): Promise<void> {
  await db.query(
    `insert into core.pending_plugin_data (schema, archive, staged_path, tables, rows, migrations, reason)
     values ($1, $2, $3, $4::jsonb, $5, $6::jsonb, null)
     on conflict (schema) do update set
       archive = excluded.archive, staged_path = excluded.staged_path, tables = excluded.tables,
       rows = excluded.rows, migrations = excluded.migrations, reason = null,
       created_at = now(), updated_at = now()`,
    [
      entry.schema,
      entry.archive,
      entry.stagedPath,
      JSON.stringify(entry.tables),
      entry.rows,
      JSON.stringify(entry.migrations),
    ],
  );
}

interface PendingRow {
  schema: string;
  archive: string;
  staged_path: string;
  tables: PendingTable[];
  rows: string;
  migrations: string[];
  reason: string | null;
  created_at: Date;
}

function fromRow(row: PendingRow): PendingPluginData {
  return {
    schema: row.schema,
    archive: row.archive,
    stagedPath: row.staged_path,
    tables: row.tables,
    rows: Number(row.rows),
    migrations: row.migrations,
    reason: row.reason,
    createdAt: row.created_at.toISOString(),
  };
}

/** Everything waiting. An installation that predates the table has nothing. */
export async function listPendingPluginData(db: Queryable): Promise<PendingPluginData[]> {
  try {
    const { rows } = await db.query<PendingRow>(
      `select schema, archive, staged_path, tables, rows::text as rows, migrations, reason, created_at
         from core.pending_plugin_data order by schema`,
    );
    return rows.map(fromRow);
  } catch {
    return [];
  }
}

/**
 * Drop the records whose staged files are not on this machine.
 *
 * The record is a core table, so a backup carries it — but not the files it
 * points at. An archive taken while data was waiting, restored elsewhere,
 * brings rows that name another machine's directories. Returns what it forgot.
 */
export async function forgetUnstagedPluginData(db: Queryable): Promise<PendingPluginData[]> {
  const gone = (await listPendingPluginData(db)).filter((p) => !existsSync(p.stagedPath));
  if (gone.length > 0) {
    await db.query(`delete from core.pending_plugin_data where schema = any($1)`, [gone.map((g) => g.schema)]);
  }
  return gone;
}

export type PendingLoadOutcome =
  /** Nothing was waiting for this schema. */
  | { kind: 'none'; schema: string }
  /** Every table loaded; the record and the staged files are gone. */
  | { kind: 'loaded'; schema: string; tables: Array<{ table: string; rows: number }>; sequences: number }
  /** Some tables loaded; the rest had rows and stay staged. */
  | {
      kind: 'partial';
      schema: string;
      tables: Array<{ table: string; rows: number }>;
      kept: PendingTable[];
      sequences: number;
    }
  /** Nothing loaded; `reason` says why, and the record says it too. */
  | { kind: 'waiting'; schema: string; reason: string };

/** The next value a sequence hands out, as a bigint. */
function nextOf(lastValue: string, isCalled: boolean): bigint {
  return BigInt(lastValue) + (isCalled ? 1n : 0n);
}

/**
 * Load one schema's staged data, if it can be loaded now.
 *
 * Never throws for a reason the owner can act on (the plugin is not migrated
 * far enough, a table is missing, a row fails its foreign key): those leave
 * the data staged, the reason on the record, and come back as `waiting`.
 */
export async function loadPendingPluginData(
  pool: Pool,
  schema: string,
  opts: { log?: (line: string) => void } = {},
): Promise<PendingLoadOutcome> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const pending = (await listPendingPluginData(pool)).find((p) => p.schema === schema);
  if (pending === undefined) return { kind: 'none', schema };

  const wait = async (reason: string): Promise<PendingLoadOutcome> => {
    await pool
      .query(`update core.pending_plugin_data set reason = $2, updated_at = now() where schema = $1`, [schema, reason])
      .catch(() => {});
    log(`restore: ${schema} data from ${pending.archive} is still waiting — ${reason}`);
    return { kind: 'waiting', schema, reason };
  };

  if (!existsSync(pending.stagedPath)) {
    return wait(`its staged files are not at ${pending.stagedPath} any more`);
  }

  /* The migration level --------------------------------------------- */
  const { rows: ledgerRows } = await pool.query<{ filename: string }>(
    `select filename from core.migrations where schema = $1`,
    [schema],
  );
  const ledger = new Set(ledgerRows.map((r) => r.filename));
  const behind = pending.migrations.filter((f) => !ledger.has(f));
  if (behind.length > 0) {
    return wait(
      ledger.size === 0
        ? 'the plugin that owns it has not migrated here yet'
        : `the installed plugin is at an older schema than the backup (missing ${behind.join(', ')}); update it`,
    );
  }

  let tables: DumpedTable[];
  let sequences: DumpedSequence[];
  try {
    tables = await readJson<DumpedTable[]>(path.join(pending.stagedPath, TABLES_NAME));
    sequences = await readJson<DumpedSequence[]>(path.join(pending.stagedPath, SEQUENCES_NAME));
  } catch (err) {
    return wait(`its staged files could not be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const client = await pool.connect();
  try {
    await client.query('begin');
    // The row lock is what makes an install and a start racing load once: the
    // second waits here, then finds the record gone.
    const locked = await client.query<{ tables: PendingTable[] }>(
      `select tables from core.pending_plugin_data where schema = $1 for update`,
      [schema],
    );
    const lockedRow = locked.rows[0];
    if (lockedRow === undefined) {
      await client.query('rollback');
      return { kind: 'none', schema };
    }
    // The record, read under the lock, says which tables are still waiting: a
    // table an earlier attempt loaded is gone from it even if the slice's own
    // list on disk was not rewritten.
    const waitingNames = new Set(lockedRow.tables.map((t) => t.table));
    tables = tables.filter((t) => t.schema === schema && waitingNames.has(`${t.schema}.${t.table}`));

    await client.query(`savepoint replica_mode`);
    try {
      // Triggers off where the role may, so a plugin's insert triggers do not
      // rewrite restored rows. Foreign keys are handled below either way.
      await client.query(`set local session_replication_role = replica`);
      await client.query(`release savepoint replica_mode`);
    } catch {
      await client.query(`rollback to savepoint replica_mode`);
      await client.query(`release savepoint replica_mode`);
    }

    const loadable: DumpedTable[] = [];
    const kept: PendingTable[] = [];
    const missing: string[] = [];
    for (const table of tables) {
      const qualified = `${quote(table.schema)}.${quote(table.table)}`;
      const name = `${table.schema}.${table.table}`;
      const { rows: cols } = await client.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_schema = $1 and table_name = $2`,
        [table.schema, table.table],
      );
      if (cols.length === 0) {
        missing.push(`${name} does not exist in the installed plugin`);
        continue;
      }
      const have = new Set(cols.map((c) => c.column_name));
      const absent = table.columns.filter((c) => !have.has(c));
      if (absent.length > 0) {
        missing.push(`${name} has no column ${absent.join(', ')} in the installed plugin`);
        continue;
      }
      const { rows: counted } = await client.query<{ n: string }>(`select count(*)::text as n from ${qualified}`);
      const existing = Number(counted[0]?.n ?? '0');
      if (existing > 0) {
        kept.push({
          table: name,
          rows: table.rows,
          kept: `${name} already has ${existing} row(s), so the backup's ${table.rows} were not loaded over them`,
        });
        continue;
      }
      loadable.push(table);
    }
    if (missing.length > 0) {
      await client.query('rollback');
      return wait(missing.join('; '));
    }

    const heldKeys = loadable.length > 0 ? await foreignKeysOf(client, loadable) : [];
    for (const key of heldKeys) {
      await client.query(`alter table ${key.table} drop constraint ${quote(key.name)}`);
    }
    for (const table of loadable) {
      const qualified = `${quote(table.schema)}.${quote(table.table)}`;
      const columns = table.columns.map(quote).join(', ');
      const sink = client.query(copyFrom(`copy ${qualified} (${columns}) from stdin`));
      await pipeline(createReadStream(path.join(pending.stagedPath, copyFileName(table.schema, table.table))), sink);
    }
    // Adding a key back validates every row: data that does not fit fails
    // here, inside the transaction, and nothing was loaded.
    for (const key of heldKeys) {
      await client.query(`alter table ${key.table} add constraint ${quote(key.name)} ${key.definition}`);
    }

    // Forward only. A table that was kept may already have handed out ids
    // past the archive's, and moving its sequence back would collide.
    let reset = 0;
    if (loadable.length > 0) {
      for (const sequence of sequences) {
        if (sequence.schema !== schema) continue;
        const qualified = `${quote(sequence.schema)}.${quote(sequence.name)}`;
        const exists = await client.query<{ r: string | null }>(`select to_regclass($1)::text as r`, [qualified]);
        if (!exists.rows[0]?.r) continue;
        const current = await client.query<{ last_value: string; is_called: boolean }>(
          `select last_value::text as last_value, is_called from ${qualified}`,
        );
        const now = current.rows[0];
        if (now && nextOf(now.last_value, now.is_called) >= nextOf(sequence.lastValue, sequence.isCalled)) continue;
        await client.query(`select setval($1::regclass, $2::bigint, $3)`, [
          qualified,
          sequence.lastValue,
          sequence.isCalled,
        ]);
        reset += 1;
      }
    }

    const done = loadable.map((t) => ({ table: `${t.schema}.${t.table}`, rows: t.rows }));
    if (kept.length === 0) {
      await client.query(`delete from core.pending_plugin_data where schema = $1`, [schema]);
    } else {
      await client.query(
        `update core.pending_plugin_data
            set tables = $2::jsonb, rows = $3, reason = $4, updated_at = now()
          where schema = $1`,
        [
          schema,
          JSON.stringify(kept),
          kept.reduce((sum, t) => sum + t.rows, 0),
          `${kept.length} table(s) already had rows and were left staged`,
        ],
      );
    }
    await client.query('commit');

    const rows = done.reduce((sum, t) => sum + t.rows, 0);
    if (kept.length === 0) {
      await rm(pending.stagedPath, { recursive: true, force: true }).catch(() => {});
      log(`restore: loaded ${schema} data from ${pending.archive} — ${done.length} table(s), ${rows} row(s)`);
      return { kind: 'loaded', schema, tables: done, sequences: reset };
    }
    // The loaded tables' files are not needed again; the list on disk follows
    // the record, though the record is what is read.
    for (const table of loadable) {
      await rm(path.join(pending.stagedPath, copyFileName(table.schema, table.table)), { force: true }).catch(() => {});
    }
    const keptNames = new Set(kept.map((k) => k.table));
    await writePrivate(
      path.join(pending.stagedPath, TABLES_NAME),
      `${JSON.stringify(tables.filter((t) => keptNames.has(`${t.schema}.${t.table}`)), null, 2)}\n`,
    ).catch(() => {});
    log(
      `restore: loaded ${done.length} ${schema} table(s) (${rows} row(s)) from ${pending.archive}; ` +
        `left staged at ${pending.stagedPath} because they already had rows: ${kept.map((k) => k.table).join(', ')}`,
    );
    return { kind: 'partial', schema, tables: done, kept, sequences: reset };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    return wait(`loading it failed and nothing was changed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    client.release();
  }
}

/**
 * Load every waiting schema among `schemas` — the ones whose plugin is here.
 * A schema with nothing waiting costs one query.
 */
export async function loadPendingForSchemas(
  pool: Pool,
  schemas: readonly string[],
  opts: { log?: (line: string) => void } = {},
): Promise<PendingLoadOutcome[]> {
  const waiting = new Set((await listPendingPluginData(pool)).map((p) => p.schema));
  const outcomes: PendingLoadOutcome[] = [];
  for (const schema of schemas) {
    if (!waiting.has(schema)) continue;
    outcomes.push(await loadPendingPluginData(pool, schema, opts));
  }
  return outcomes;
}
