/**
 * The database half of a backup, taken over the ordinary `pg` connection.
 *
 * There is no `pg_dump` here, and that is deliberate: the bundled Postgres
 * (`@embedded-postgres/*`, and the zonky jars it is built from) ships `initdb`,
 * `pg_ctl` and `postgres` and nothing else. An engine that shelled out to
 * `pg_dump` would work only on a developer's machine with Homebrew Postgres
 * installed and would fail on exactly the installations a backup is for. So
 * every table in the buddi-owned schemas is copied out with `COPY … TO STDOUT`
 * and the schema itself is rebuilt on restore from our own migrations, which
 * are the one description of it that ships with the code.
 *
 * "Buddi-owned" means: `core`, plus every schema a plugin has recorded
 * migrations for in `core.migrations`. A schema nothing of ours migrated is
 * somebody else's and is left alone.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Pool, PoolClient } from 'pg';
import copyStreams from 'pg-copy-streams';
import {
  DB_DIR_NAME,
  DB_MIGRATIONS_NAME,
  SEQUENCES_NAME,
  TABLES_NAME,
  copyFileName,
  type DumpedMigrations,
  type DumpedSequence,
  type DumpedTable,
  type MigrationRecord,
} from './manifest.js';

const { to: copyTo } = copyStreams;

export class DumpError extends Error {}

export interface DumpResult {
  tables: DumpedTable[];
  sequences: DumpedSequence[];
  migrations: DumpedMigrations;
  /** The ledger as rows, for the manifest. */
  records: MigrationRecord[];
  postgresMajor: number;
}

/** Identifiers we are willing to interpolate into SQL. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

export function quote(name: string): string {
  if (!IDENT.test(name)) throw new DumpError(`refusing to use ${JSON.stringify(name)} as an identifier`);
  return `"${name}"`;
}

/* ------------------------------------------------------------------ *
 * Dump order
 * ------------------------------------------------------------------ */

export interface TableRef {
  schema: string;
  table: string;
}

export interface ForeignKey {
  /** The table that holds the reference. */
  from: TableRef;
  /** The table it points at. */
  to: TableRef;
}

const key = (t: TableRef): string => `${t.schema}.${t.table}`;

/**
 * Parents before children.
 *
 * The load runs with `session_replication_role = replica`, so foreign keys are
 * not checked while the data goes in and any order would technically work. The
 * order is computed anyway because the failure it guards is not the happy path:
 * a target where that setting is refused (a non-superuser role) then still
 * loads, and a human reading the archive gets the tables in an order that makes
 * sense. A cycle — two tables referencing each other — is not an error; it is
 * broken by taking the table as it stands, since replica mode handles it.
 */
export function orderTables(tables: readonly TableRef[], foreignKeys: readonly ForeignKey[]): TableRef[] {
  const present = new Set(tables.map(key));
  const parents = new Map<string, Set<string>>();
  for (const t of tables) parents.set(key(t), new Set());
  for (const fk of foreignKeys) {
    const child = key(fk.from);
    const parent = key(fk.to);
    if (child === parent || !present.has(child) || !present.has(parent)) continue;
    parents.get(child)?.add(parent);
  }

  const byName = new Map(tables.map((t) => [key(t), t]));
  const sorted = [...byName.keys()].sort();
  const done = new Set<string>();
  const out: TableRef[] = [];
  const visit = (name: string, seen: Set<string>): void => {
    if (done.has(name) || seen.has(name)) return;
    seen.add(name);
    for (const parent of [...(parents.get(name) ?? [])].sort()) visit(parent, seen);
    seen.delete(name);
    if (done.has(name)) return;
    done.add(name);
    const ref = byName.get(name);
    if (ref) out.push(ref);
  };
  for (const name of sorted) visit(name, new Set());
  return out;
}

/* ------------------------------------------------------------------ *
 * Reading the shape
 * ------------------------------------------------------------------ */

/** `core`, plus every schema a plugin has migrated here. */
export async function ownedSchemas(client: PoolClient | Pool): Promise<string[]> {
  const schemas = new Set<string>(['core']);
  if (await hasLedger(client)) {
    const { rows } = await client.query<{ schema: string }>(
      `select distinct schema from core.migrations`,
    );
    for (const row of rows) schemas.add(row.schema);
  }
  return [...schemas].filter((s) => IDENT.test(s)).sort();
}

/**
 * Is there a migration ledger to read?
 *
 * Asked rather than attempted, because the whole dump runs inside one
 * `repeatable read` transaction: a `select` against a table that is not there
 * aborts that transaction, and every query after it fails with "current
 * transaction is aborted" however carefully the first one was caught. A
 * database nothing has migrated is a real state — it is what a restore into a
 * brand new database starts from — so this has to be a question.
 */
async function hasLedger(client: PoolClient | Pool): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    `select to_regclass('core.migrations') is not null as present`,
  );
  return rows[0]?.present === true;
}

async function tablesIn(client: PoolClient, schemas: string[]): Promise<TableRef[]> {
  const { rows } = await client.query<{ schema: string; table: string }>(
    `select n.nspname as schema, c.relname as "table"
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and n.nspname = any($1)
      order by 1, 2`,
    [schemas],
  );
  return rows;
}

async function foreignKeysIn(client: PoolClient, schemas: string[]): Promise<ForeignKey[]> {
  const { rows } = await client.query<{
    from_schema: string;
    from_table: string;
    to_schema: string;
    to_table: string;
  }>(
    `select fn.nspname as from_schema, f.relname as from_table,
            tn.nspname as to_schema,   t.relname as to_table
       from pg_constraint con
       join pg_class f on f.oid = con.conrelid
       join pg_namespace fn on fn.oid = f.relnamespace
       join pg_class t on t.oid = con.confrelid
       join pg_namespace tn on tn.oid = t.relnamespace
      where con.contype = 'f' and fn.nspname = any($1)`,
    [schemas],
  );
  return rows.map((r) => ({
    from: { schema: r.from_schema, table: r.from_table },
    to: { schema: r.to_schema, table: r.to_table },
  }));
}

/**
 * The columns COPY will carry: every ordinary one, in attribute order.
 *
 * Generated columns are left out on purpose — Postgres computes them and
 * refuses to have them copied in — so the COPY file and the column list in
 * `tables.json` agree with what the loader is allowed to write.
 *
 * An **identity** column (`attidentity <> ''`) is kept, including
 * `generated always as identity`. `COPY … FROM` is allowed to supply a value
 * for one where `INSERT` would need `OVERRIDING SYSTEM VALUE` (a clause COPY
 * has no syntax for at all), which is the same exemption `pg_dump` relies on.
 * Leaving such a column out would be the alternative, and it would mean
 * restoring every row with a new id and every foreign key pointing at the
 * wrong one: data loss, to avoid a clause that is not needed. The sequence
 * behind the column is dumped and reset with the others.
 */
async function columnsOf(client: PoolClient, table: TableRef): Promise<string[]> {
  const { rows } = await client.query<{ name: string }>(
    `select a.attname as name
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1 and c.relname = $2
        and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
      order by a.attnum`,
    [table.schema, table.table],
  );
  return rows.map((r) => r.name);
}

async function sequencesIn(client: PoolClient, schemas: string[]): Promise<DumpedSequence[]> {
  const { rows } = await client.query<{ schema: string; name: string }>(
    `select n.nspname as schema, c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'S' and n.nspname = any($1)
      order by 1, 2`,
    [schemas],
  );
  const out: DumpedSequence[] = [];
  for (const row of rows) {
    const { rows: state } = await client.query<{ last_value: string; is_called: boolean }>(
      `select last_value::text as last_value, is_called from ${quote(row.schema)}.${quote(row.name)}`,
    );
    out.push({
      schema: row.schema,
      name: row.name,
      lastValue: state[0]?.last_value ?? '1',
      isCalled: state[0]?.is_called ?? false,
    });
  }
  return out;
}

async function ledger(client: PoolClient): Promise<MigrationRecord[]> {
  if (!(await hasLedger(client))) return [];
  const { rows } = await client.query<{ schema: string; filename: string; applied_at: unknown }>(
    `select schema, filename, applied_at from core.migrations order by schema, filename`,
  );
  return rows.map((row) => ({
    schema: row.schema,
    filename: row.filename,
    appliedAt:
      row.applied_at instanceof Date ? row.applied_at.toISOString() : (row.applied_at as string | null),
    sha256: null,
  }));
}

/** The ledger, split the way `db/migrations.json` carries it. */
export function splitMigrations(records: readonly MigrationRecord[]): DumpedMigrations {
  const out: DumpedMigrations = { core: [], plugins: {} };
  for (const record of records) {
    if (record.schema === 'core') {
      out.core.push(record.filename);
      continue;
    }
    const entry = (out.plugins[record.schema] ??= { schema: record.schema, filenames: [] });
    entry.filenames.push(record.filename);
  }
  out.core.sort();
  for (const entry of Object.values(out.plugins)) entry.filenames.sort();
  return out;
}

export function postgresMajorFrom(version: string): number {
  const match = /PostgreSQL (\d+)/.exec(version);
  return match ? Number(match[1]) : 0;
}

/* ------------------------------------------------------------------ *
 * The dump
 * ------------------------------------------------------------------ */

/**
 * Copy every buddi-owned table into `<stageDir>/db/`.
 *
 * All of it — the table list, every COPY, the sequences and the migration
 * ledger — runs on **one** client inside a single
 * `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` transaction, because the
 * gateway keeps running while a scheduled backup is taken. Table by table over
 * a pool would give each table a different snapshot, and a row inserted into a
 * child table between two COPYs would arrive in the archive pointing at a
 * parent row that is not in it: a backup that cannot be restored, produced by a
 * backup that reported success.
 */
export async function dumpDatabase(pool: Pool, stageDir: string): Promise<DumpResult> {
  const dbDir = path.join(stageDir, DB_DIR_NAME);
  await mkdir(dbDir, { recursive: true, mode: 0o700 });

  const client = await pool.connect();
  try {
    await client.query('begin isolation level repeatable read read only');

    const { rows: versionRows } = await client.query<{ version: string }>('select version()');
    const postgresMajor = postgresMajorFrom(versionRows[0]?.version ?? '');

    const schemas = await ownedSchemas(client);
    const ordered = orderTables(await tablesIn(client, schemas), await foreignKeysIn(client, schemas));

    const tables: DumpedTable[] = [];
    for (const ref of ordered) {
      const columns = await columnsOf(client, ref);
      const qualified = `${quote(ref.schema)}.${quote(ref.table)}`;
      const list = columns.map(quote).join(', ');
      const file = path.join(stageDir, copyFileName(ref.schema, ref.table));
      // `COPY (select …) TO STDOUT` rather than `COPY <table> TO STDOUT`: the
      // explicit column list is what makes the file readable by a target whose
      // table has since gained a column.
      const source = client.query(copyTo(`copy (select ${list} from ${qualified}) to stdout`));
      await pipeline(source, createWriteStream(file, { mode: 0o600 }));
      const { rows: counted } = await client.query<{ n: string }>(
        `select count(*)::text as n from ${qualified}`,
      );
      tables.push({ ...ref, columns, rows: Number(counted[0]?.n ?? '0') });
    }

    const sequences = await sequencesIn(client, schemas);
    const records = await ledger(client);
    const migrations = splitMigrations(records);

    await client.query('commit');

    await writeFile(path.join(stageDir, TABLES_NAME), `${JSON.stringify(tables, null, 2)}\n`, {
      mode: 0o600,
    });
    await writeFile(path.join(stageDir, SEQUENCES_NAME), `${JSON.stringify(sequences, null, 2)}\n`, {
      mode: 0o600,
    });
    await writeFile(
      path.join(stageDir, DB_MIGRATIONS_NAME),
      `${JSON.stringify(migrations, null, 2)}\n`,
      { mode: 0o600 },
    );

    return { tables, sequences, migrations, records, postgresMajor };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err instanceof DumpError
      ? err
      : new DumpError(`the database could not be dumped: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        });
  } finally {
    client.release();
  }
}
