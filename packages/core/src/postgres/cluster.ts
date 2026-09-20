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
import { readFile, rename } from 'node:fs/promises';
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
  // A SIGKILL of the supervisor can leave Postgres alive. pg_ctl checks this
  // exact cluster; a survivor is stopped rather than adopted, so the server we
  // watch below is always our own child. Below we authenticate and verify
  // data_directory anyway, against a foreign server on the selected port.
  let orphaned = true;
  try { await exec(path.join(bin, 'pg_ctl'), ['status', '-D', cluster], { timeout: 5000, env: nativeEnvironment(env) }); }
  catch { orphaned = false; }
  if (orphaned) {
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
