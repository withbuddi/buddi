/**
 * The private, managed Postgres cluster: its initialization, its authenticated
 * startup and the liveness probe that watches it.
 *
 * Nothing here knows about an installation, a supervisor or a CLI: the caller
 * passes a data directory, a port, a vault and an environment, and gets back a
 * child process it owns. A leftover postmaster from a dead supervisor is
 * stopped and started again as our own child — never adopted — so there is
 * exactly one lifecycle: a spawned child plus the probe.
 */
import { readFile, rename, unlink } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { prepareBinaries, nativeEnvironment, BINARY_VERSION } from './binaries.js';
import type { Vault } from '../vault/index.js';

const exec = promisify(execFile);
const { Client } = pg;

export async function stopChild(child: ChildProcess | undefined, signal: NodeJS.Signals = 'SIGTERM', timeout = 15_000): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill(signal);
  });
}

/** What a cluster's `postmaster.pid` turns out to describe. */
export type ClusterOccupancy = 'free' | 'orphan' | 'stale';

/** What answers — if anything — on the port a pid file records. */
export type PortIdentity = 'ours' | 'other' | 'unreachable' | 'unknown';

/** The three questions the occupancy check asks; the real ones are pg_ctl, the port and /proc. */
export interface OccupancyChecks {
  /** `pg_ctl status -D <cluster>`: true when it reports a running server. */
  status: () => Promise<boolean>;
  /** Which cluster, if any, is serving that port. */
  identity: (port: number) => Promise<PortIdentity>;
  /** The command name behind a pid, where the OS will say (Linux's `/proc`). */
  command: (pid: number) => Promise<string | undefined>;
}

/**
 * Whether a postmaster really owns this cluster.
 *
 * `pg_ctl status` believes `postmaster.pid`, and a pid file outlives the
 * process that wrote it: a container killed outright, or a machine that
 * rebooted, leaves one behind. Pids start small again afterwards, so the
 * number in that file is quite likely some live, unrelated process — and
 * stopping *that* signals a stranger, waits, and reports that the server would
 * not shut down, which is how a startup ends in "a Postgres server is already
 * running and could not be stopped" with no Postgres server anywhere.
 *
 * So a claimed server is believed only when something outside the file backs
 * it up: the port the file records answers for this very cluster, or the OS
 * says that pid is a postgres. Anything else is a leftover file, and deleting
 * one is safe precisely because nothing is behind it.
 */
export async function inspectCluster(cluster: string, checks: OccupancyChecks): Promise<ClusterOccupancy> {
  if (!await checks.status()) return 'free';
  // postmaster.pid: the pid on line 1, the port on line 4.
  const lines = (await readFile(path.join(cluster, 'postmaster.pid'), 'utf8').catch(() => '')).split('\n');
  const pid = Number(lines[0]);
  const port = Number(lines[3]);
  if (Number.isInteger(port) && port > 0 && port <= 65535) {
    const identity = await checks.identity(port);
    // `unknown` is a server that answered without saying whose it is. Ambiguity
    // is not a licence to delete another server's pid file.
    if (identity === 'ours' || identity === 'unknown') return 'orphan';
  }
  if (Number.isInteger(pid) && pid > 0 && (await checks.command(pid)) === 'postgres') return 'orphan';
  return 'stale';
}

/** Ask a port which cluster it serves. Only this cluster's own answer is `ours`. */
async function portIdentity(cluster: string, connection: pg.ClientConfig): Promise<PortIdentity> {
  const client = new Client(connection);
  client.on('error', () => {});
  try {
    await client.connect();
    const result = await client.query<{ data_directory: string }>('SHOW data_directory');
    return path.resolve(result.rows[0]!.data_directory) === cluster ? 'ours' : 'other';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].includes(code as string) ? 'unreachable' : 'unknown';
  } finally { await client.end().catch(() => {}); }
}

/** What the OS calls a pid, on the one platform that will simply tell us. */
async function processCommand(pid: number): Promise<string | undefined> {
  if (process.platform !== 'linux') return undefined;
  return (await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '')).trim() || undefined;
}

/** A bounded liveness probe over the database this process started. */
export interface DatabaseMonitor {
  /** Resolves once the database is considered gone. */
  exited: Promise<void>;
  /** Declare it gone now (a spawned child's `exit` event does this). */
  fail(): void;
  readonly alive: boolean;
  stop(): void;
}

/** One bounded probe at a time: a live pid is not a working server. */
export function watchDatabase(probe: () => Promise<void>, { interval = 1000, failures = 3 }: { interval?: number; failures?: number } = {}): DatabaseMonitor {
  let timer: NodeJS.Timeout, stopped = false, alive = true, misses = 0;
  let finish!: () => void;
  const exited = new Promise<void>(resolve => { finish = resolve; });
  const fail = () => { if (!stopped && alive) { alive = false; clearTimeout(timer); finish(); } };
  const tick = async () => {
    try { await probe(); misses = 0; } catch { if (++misses >= failures) fail(); }
    if (!stopped && alive) timer = setTimeout(tick, interval);
  };
  timer = setTimeout(tick, interval);
  return { exited, fail, get alive() { return alive; }, stop() { stopped = true; clearTimeout(timer); } };
}

/** The database this installation runs on, managed or external. */
export interface ManagedDatabase {
  pid: number | null | undefined;
  child?: ChildProcess | undefined;
  exited: Promise<void>;
  readonly alive: boolean;
  stop(): Promise<void>;
}

/** A managed cluster also knows the URL its application role connects with. */
export interface ManagedCluster extends ManagedDatabase {
  readonly url: string;
}

export interface ManagedClusterOptions {
  /** The installation root the Postgres binary package is resolved from. */
  root: string;
  /** Private storage: the cluster is `<dataDir>/postgres`, the binaries `<dataDir>/runtime`. */
  dataDir: string;
  /** The loopback port the postmaster listens on. */
  port: number;
  /** Holds the cluster administrator and application role passwords. */
  vault: Vault;
  /** Where the postmaster's output is appended. */
  logFile: string;
  env?: NodeJS.ProcessEnv;
  /** Diagnostics about the cluster's lifecycle; defaults to stderr. */
  log?: (line: string) => void;
}

async function initializeCluster(bin: string, stage: string, password: string, env: NodeJS.ProcessEnv): Promise<void> {
  // initdb opens /dev/stdin as a file. Give it a real kernel pipe (Node's
  // socket-backed stdio cannot be reopened this way on Linux). The shell program
  // is fixed; paths are positional arguments and the password travels only on stdin.
  const child = spawn('/bin/sh', ['-c', '/bin/cat | exec "$@"', 'buddi-initdb', path.join(bin, 'initdb'), '-D', stage, '-U', 'buddi_admin', '--auth=scram-sha-256', '--pwfile=/dev/stdin', '--encoding=UTF8', '--locale=C'],
    { env: nativeEnvironment(env), detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }, 60_000);
    child.stdin?.on('error', () => {});
    child.once('error', () => { clearTimeout(timer); reject(new Error('Could not launch initdb.')); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('initdb failed or timed out; its staging directory was preserved.')); });
    child.stdin?.end(password + '\n');
  });
}

export async function startManagedCluster({ root, dataDir, port, vault, logFile, env = process.env, log: diagnostic = (line: string) => console.error(line) }: ManagedClusterOptions): Promise<ManagedCluster> {
  const cluster = path.join(dataDir, 'postgres');
  let adminPassword = await vault.get('BUDDI_DB_ADMIN_PASSWORD');
  if (!adminPassword) {
    if (existsSync(path.join(cluster, 'PG_VERSION'))) throw new Error('The cluster administrator credential is missing. Restore it; the cluster was not changed.');
    adminPassword = randomBytes(32).toString('base64url');
    await vault.set('BUDDI_DB_ADMIN_PASSWORD', adminPassword);
  }
  let password = await vault.get('BUDDI_DB_PASSWORD');
  if (!password) {
    if (existsSync(path.join(cluster, 'PG_VERSION'))) throw new Error('The cluster exists but its vault password is missing. Restore the credential; the cluster was not changed.');
    password = randomBytes(32).toString('base64url');
    await vault.set('BUDDI_DB_PASSWORD', password);
  }
  const bin = await prepareBinaries({ root, dataDir, env });
  if (!existsSync(path.join(cluster, 'PG_VERSION'))) {
    if (existsSync(cluster)) throw new Error('The postgres directory is incomplete or unrecognized. It was preserved; inspect it before retrying.');
    const stage = path.join(dataDir, `postgres-init-${process.pid}-${Date.now()}`);
    await initializeCluster(bin, stage, adminPassword, env);
    await rename(stage, cluster);
  }
  const major = (await readFile(path.join(cluster, 'PG_VERSION'), 'utf8')).trim();
  if (major !== BINARY_VERSION.split('.')[0]) throw new Error(`Cluster is Postgres ${major}; this release bundles ${BINARY_VERSION}. Explicit backup/restore is required; no automatic major upgrade.`);
  // A SIGKILL of the supervisor can leave Postgres alive. A survivor is
  // stopped rather than adopted, so the server we watch below is always our
  // own child — but only a survivor `inspectCluster` could actually find is
  // treated as one; a pid file with nothing behind it is removed instead.
  // Below we authenticate and verify data_directory anyway, against a foreign
  // server on the selected port.
  const occupancy = await inspectCluster(cluster, {
    status: async () => {
      try { await exec(path.join(bin, 'pg_ctl'), ['status', '-D', cluster], { timeout: 5000, env: nativeEnvironment(env) }); return true; }
      catch { return false; }
    },
    identity: recorded => portIdentity(cluster, { host: '127.0.0.1', port: recorded, user: 'buddi_admin', password: adminPassword, database: 'postgres', connectionTimeoutMillis: 1000, query_timeout: 1000 }),
    command: processCommand,
  });
  if (occupancy === 'stale') {
    diagnostic('A stale postmaster.pid from a previous run was removed.');
    await unlink(path.join(cluster, 'postmaster.pid')).catch(() => {});
  }
  if (occupancy === 'orphan') {
    diagnostic('Stopping an orphaned Postgres server left on this cluster by a previous supervisor.');
    try { await exec(path.join(bin, 'pg_ctl'), ['stop', '-D', cluster, '-m', 'fast', '-t', '15'], { timeout: 20_000, env: nativeEnvironment(env) }); }
    catch (error) {
      // It may have finished shutting down on its own between the status check
      // and this stop, which is exactly the state we wanted. Anything else is
      // fatal: never start a second postmaster on a cluster someone still owns.
      let stopped = false;
      try { await exec(path.join(bin, 'pg_ctl'), ['status', '-D', cluster], { timeout: 5000, env: nativeEnvironment(env) }); }
      catch { stopped = true; }
      if (!stopped) throw new Error(`A Postgres server is already running on ${cluster} and could not be stopped (${(error as Error).message}). No new server was started; stop it before retrying.`);
    }
  }
  const log = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
  const child = spawn(path.join(bin, 'postgres'), ['-D', cluster, '-p', String(port), '-h', '127.0.0.1', '-k', ''], { env: nativeEnvironment(env), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.pipe(log, { end: false }); child.stderr?.pipe(log, { end: false });
  let failed: Error | undefined;
  child.on('error', error => { failed = error; });
  const connection = { host: '127.0.0.1', port, user: 'buddi_admin', password: adminPassword, database: 'postgres', connectionTimeoutMillis: 500, query_timeout: 1000 };
  const deadline = Date.now() + 30_000;
  try {
    for (;;) {
      if (failed || child.exitCode !== null || child.signalCode !== null) throw new Error('Postgres failed to start; inspect logs/postgres.log (port conflict or an existing server).');
      const client = new Client(connection);
      client.on('error', () => {});
      try {
        await client.connect();
        // Never mistake another Postgres on the selected port for our child.
        const result = await client.query<{ data_directory: string }>('SHOW data_directory');
        if (path.resolve(result.rows[0]!.data_directory) !== cluster) throw new Error('database-port-conflict');
        const role = await client.query("SELECT 1 FROM pg_roles WHERE rolname = 'buddi'");
        if (!role.rowCount) {
          await client.query('CREATE ROLE buddi LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');
        }
        // Resync restored/rotated credentials; let Postgres quote identifiers and literals.
        const sql = await client.query<{ statement: string }>("SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', $1::text, $2::text) AS statement", ['buddi', password]);
        await client.query(sql.rows[0]!.statement);
        const found = await client.query("SELECT 1 FROM pg_database WHERE datname = 'buddi'");
        if (!found.rowCount) await client.query('CREATE DATABASE buddi OWNER buddi');
        break;
      } catch (error) {
        if ((error as Error).message === 'database-port-conflict') throw new Error(`Database port ${port} belongs to a different cluster. No roles or databases on it were changed.`);
        if (Date.now() > deadline) throw new Error(`Could not authenticate the managed cluster on port ${port}; check for a port conflict and inspect logs/postgres.log.`);
        await new Promise(resolve => setTimeout(resolve, 150));
      } finally { await client.end().catch(() => {}); }
    }
  } catch (error) { await stopChild(child, 'SIGINT'); log.end(); throw error; }
  const url = `postgres://buddi:${encodeURIComponent(password)}@127.0.0.1:${port}/buddi`;
  const monitor = watchDatabase(async () => {
    const client = new Client(connection);
    client.on('error', () => {});
    try {
      await client.connect();
      const result = await client.query<{ data_directory: string }>('SHOW data_directory');
      if (path.resolve(result.rows[0]!.data_directory) !== cluster) throw new Error('Cluster identity changed');
    } finally { await client.end().catch(() => {}); }
  });
  child.once('exit', monitor.fail);
  if (child.exitCode !== null || child.signalCode !== null) monitor.fail();
  return { pid: child.pid, child, url, exited: monitor.exited, get alive() { return monitor.alive; }, stop: async () => {
    monitor.stop();
    await stopChild(child, 'SIGINT');
    log.end();
  } };
}
