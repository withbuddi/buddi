/**
 * Postgres, through the container.
 *
 * `pg_dump` and `pg_restore` are version-locked to the server: a Homebrew
 * `pg_dump 15` cannot read a Postgres 16 server, and the owner of a personal
 * installation should not have to know that. So both run *inside* the compose
 * service, over `docker compose exec -T postgres`, and the bytes travel on the
 * process's stdin/stdout. Nothing but Docker is required on the host — which is
 * already true for running buddi at all.
 */
import type { Pool } from 'pg';
import { spawnCapture } from './archive.js';
import type { MigrationRecord, TableCount } from './manifest.js';

/** The compose service the database is, same constant `buddi db` uses. */
export const DB_SERVICE = 'postgres';

export interface DatabaseTarget {
  user: string;
  password: string;
  host: string;
  port: string;
  database: string;
}

export class DumpError extends Error {}

/** Pull the pieces out of `DATABASE_URL`. The password is never printed. */
export function parseDatabaseUrl(url: string): DatabaseTarget {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DumpError(`DATABASE_URL is not a URL: ${url.replace(/:\/\/[^@]*@/, '://***@')}`);
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (database === '') throw new DumpError('DATABASE_URL names no database');
  return {
    user: decodeURIComponent(parsed.username) || 'postgres',
    password: decodeURIComponent(parsed.password),
    host: parsed.hostname,
    port: parsed.port || '5432',
    database,
  };
}

/** The same URL pointed at another database on the same server. */
export function urlForDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Postgres identifiers we are willing to interpolate. */
const DB_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

export function assertDatabaseName(name: string): string {
  if (!DB_NAME.test(name)) {
    throw new DumpError(
      `refusing to use ${JSON.stringify(name)} as a database name (letters, digits, _ and $)`,
    );
  }
  return name;
}

function composeArgs(target: DatabaseTarget, tool: string, rest: string[]): string[] {
  return [
    'compose',
    'exec',
    '-T',
    '-e',
    `PGPASSWORD=${target.password}`,
    DB_SERVICE,
    tool,
    '-U',
    target.user,
    ...rest,
  ];
}

/**
 * `pg_dump -Fc` into `outFile`.
 *
 * Custom format, not plain SQL: it is compressed, it restores selectively, and
 * — the reason it matters here — `pg_restore --single-transaction` can put the
 * whole thing back atomically, which plain SQL piped to `psql` cannot.
 */
export async function dumpDatabase(opts: {
  repoRoot: string;
  target: DatabaseTarget;
  outFile: string;
  timeoutMs?: number;
}): Promise<void> {
  const args = composeArgs(opts.target, 'pg_dump', [
    '-d',
    assertDatabaseName(opts.target.database),
    '-Fc',
    '--no-owner',
    '--no-acl',
  ]);
  const res = await spawnCapture('docker', args, {
    cwd: opts.repoRoot,
    stdoutFile: opts.outFile,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  if (res.code !== 0) {
    throw new DumpError(
      `pg_dump failed (exit ${res.code}) — is the container up? \`buddi db up\`\n${res.stderr.trim()}`,
    );
  }
}

/**
 * `pg_restore` from a file, into `database`.
 *
 * `--single-transaction` is what makes a restore all-or-nothing: a dump that
 * fails halfway leaves the target exactly as it was rather than half-populated,
 * which is the difference between a failed restore and a destroyed database.
 * `--clean --if-exists` drops what the dump is about to recreate, so restoring
 * over the same schema twice is idempotent.
 */
export async function restoreDatabase(opts: {
  repoRoot: string;
  target: DatabaseTarget;
  database: string;
  inFile: string;
  timeoutMs?: number;
}): Promise<string> {
  const args = composeArgs(opts.target, 'pg_restore', [
    '-d',
    assertDatabaseName(opts.database),
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-acl',
    '--single-transaction',
  ]);
  const res = await spawnCapture('docker', args, {
    cwd: opts.repoRoot,
    stdinFile: opts.inFile,
    ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
  });
  if (res.code !== 0) {
    throw new DumpError(
      `pg_restore failed (exit ${res.code}); the target was left unchanged (--single-transaction)\n${res.stderr.trim()}`,
    );
  }
  return res.stderr.trim();
}

/** `create database <name>` through the container, so no client is needed. */
export async function createDatabase(opts: {
  repoRoot: string;
  target: DatabaseTarget;
  database: string;
}): Promise<void> {
  const name = assertDatabaseName(opts.database);
  const args = composeArgs(opts.target, 'psql', [
    '-d',
    'postgres',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `create database "${name}"`,
  ]);
  const res = await spawnCapture('docker', args, { cwd: opts.repoRoot, timeoutMs: 60_000 });
  if (res.code !== 0) {
    throw new DumpError(`could not create database ${name}: ${res.stderr.trim()}`);
  }
}

export async function databaseExists(opts: {
  repoRoot: string;
  target: DatabaseTarget;
  database: string;
}): Promise<boolean> {
  const args = composeArgs(opts.target, 'psql', [
    '-d',
    'postgres',
    '-tAc',
    `select 1 from pg_database where datname = '${assertDatabaseName(opts.database)}'`,
  ]);
  const res = await spawnCapture('docker', args, { cwd: opts.repoRoot, timeoutMs: 60_000 });
  return res.code === 0 && res.stdout.toString('utf8').trim() === '1';
}

/* ------------------------------------------------------------------ *
 * What the manifest records about the database
 * ------------------------------------------------------------------ */

const USER_SCHEMAS = `nspname not in ('pg_catalog','information_schema','pg_toast')
                      and nspname not like 'pg_temp%' and nspname not like 'pg_toast_temp%'`;

/**
 * Exact row counts, table by table.
 *
 * `reltuples` would be free and is an estimate; a backup manifest whose numbers
 * are approximately right is useless for the one job it has — letting the owner
 * compare "what I backed up" with "what came back". A personal installation has
 * tens of tables, so the honest count is affordable.
 */
export async function tableCounts(pool: Pool): Promise<TableCount[]> {
  const { rows } = await pool.query<{ schema: string; table: string }>(
    `select n.nspname as schema, c.relname as table
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and ${USER_SCHEMAS}
      order by 1, 2`,
  );
  const counts: TableCount[] = [];
  for (const row of rows) {
    const { rows: got } = await pool.query<{ n: string }>(
      `select count(*)::text as n from "${row.schema}"."${row.table}"`,
    );
    counts.push({ table: `${row.schema}.${row.table}`, rows: Number(got[0]?.n ?? '0') });
  }
  return counts;
}

/** How full the target is, for the restore guard. Cheap: no per-table count. */
export async function databaseFootprint(
  pool: Pool,
): Promise<{ tables: number; rows: number }> {
  const counts = await tableCounts(pool);
  return {
    tables: counts.length,
    rows: counts.reduce((sum, c) => sum + c.rows, 0),
  };
}

/**
 * The migration ledger, with each file's checksum where the file is still on
 * this machine. A manifest that records *which* schema the dump is of turns a
 * restore into a decision the owner can make ("this is from before the finance
 * migration") instead of a surprise.
 */
export async function migrationRecords(
  pool: Pool,
  checksums: Map<string, string>,
): Promise<MigrationRecord[]> {
  try {
    const { rows } = await pool.query<{ schema: string; filename: string; applied_at: unknown }>(
      `select schema, filename, applied_at from core.migrations order by schema, filename`,
    );
    return rows.map((row) => ({
      schema: row.schema,
      filename: row.filename,
      appliedAt:
        row.applied_at instanceof Date ? row.applied_at.toISOString() : (row.applied_at as string | null),
      sha256: checksums.get(`${row.schema}/${row.filename}`) ?? null,
    }));
  } catch {
    // No `core.migrations` is a real state (a database that was never
    // migrated). An empty ledger is the truthful answer, not a crash.
    return [];
  }
}
