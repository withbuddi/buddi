/**
 * The private, managed Postgres cluster: its binaries, its initialization, its
 * authenticated startup and the liveness probe that watches it.
 *
 * `@buddi/core` arrives as an argument rather than an import, because this
 * module is loaded by the launcher before `environment()` has finished
 * rewriting the environment those packages read at import time.
 */
import { cp, mkdir, readFile, rename, writeFile, symlink, chmod, stat } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { nativeEnvironment } from './environment.js';
import type { InstallContext, ReadyContext } from './environment.js';

const exec = promisify(execFile);
export const BINARY_VERSION = '18.4.0-beta.17';

/** Copy into writable private storage; --ignore-scripts and read-only global installs work. */
export async function binaries(ctx: InstallContext): Promise<string> {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Managed Postgres startup is currently supported on macOS and Linux only. Windows process management is not implemented yet.');
  const name = `@embedded-postgres/${process.platform}-${process.arch}`;
  let entry: string;
  // A per-platform package name is computed, so this is the one specifier that
  // a typed static import cannot express.
  const resolve = createRequire(path.join(ctx.root, 'package.json')).resolve;
  try { entry = resolve(name); }
  catch { throw new Error(`Postgres binaries missing for ${process.platform}/${process.arch}; reinstall with optional dependencies enabled.`); }
  const native = path.resolve(path.dirname(entry), '../native');
  const dest = path.join(ctx.data, 'runtime', `postgres-${BINARY_VERSION}-${process.platform}-${process.arch}`);
  if (!existsSync(path.join(dest, '.ready'))) {
    await mkdir(dest, { recursive: true, mode: 0o700 });
    await cp(native, dest, { recursive: true, force: true });
    const links = JSON.parse(await readFile(path.join(native, 'pg-symlinks.json'), 'utf8').catch(() => '[]')) as { source: string; target: string }[];
    // Upstream's source is the link destination; target is the link to create.
    for (const { source, target } of links) {
      const rebase = (value: string): string => {
        const normalized = value.replaceAll('\\', '/');
        const suffix = normalized.includes('/native/') ? normalized.split('/native/').pop() as string : normalized.replace(/^native\//, '');
        const resolved = path.resolve(dest, suffix);
        if (!resolved.startsWith(dest + path.sep)) throw new Error('Invalid path in Postgres symlink manifest');
        return resolved;
      };
      const from = rebase(source), to = rebase(target);
      try { await symlink(path.relative(path.dirname(to), from), to); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    // This upstream binary distribution contains server tools only. Packaged
    // backup/restore is deliberately disabled until client tools are shipped.
    for (const name of ['initdb', 'postgres', 'pg_ctl']) {
      const file = path.join(dest, 'bin', name);
      await chmod(file, (await stat(file)).mode | 0o500);
      await exec(file, ['--version'], { timeout: 10_000, env: nativeEnvironment(ctx.env) });
    }
    await writeFile(path.join(dest, '.ready'), BINARY_VERSION, { mode: 0o600 });
  }
  return path.join(dest, 'bin');
}

export async function stopChild(child: ChildProcess | undefined, signal: NodeJS.Signals = 'SIGTERM', timeout = 15_000): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill(signal);
  });
}

/** A bounded liveness probe over a database this supervisor did not necessarily spawn. */
export interface DatabaseMonitor {
  /** Resolves once the database is considered gone. */
  exited: Promise<void>;
  /** Declare it gone now (a spawned child's `exit` event does this). */
  fail(): void;
  readonly alive: boolean;
  stop(): void;
}

/** One bounded probe at a time, for both spawned and adopted servers. */
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

export async function startDatabase(ctx: ReadyContext, core: typeof import('@buddi/core')): Promise<ManagedDatabase> {
  if (ctx.state.database === 'external') {
    if (!ctx.env.DATABASE_URL) throw new Error('External database selected; set DATABASE_URL in the data directory .env. No local cluster was created.');
    return { stop: async () => {}, pid: null, alive: true, exited: new Promise<void>(() => {}) };
  }
  if (ctx.env.DATABASE_URL) throw new Error('This installation owns a managed cluster; remove DATABASE_URL or use a separate data directory for an external database.');
  const vault = core.createVault({ env: ctx.env });
  if (!vault) throw new Error('Managed Postgres requires an available vault.');
  const cluster = path.join(ctx.data, 'postgres');
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
  const bin = await binaries(ctx);
  if (!existsSync(path.join(cluster, 'PG_VERSION'))) {
    if (existsSync(cluster)) throw new Error('The postgres directory is incomplete or unrecognized. It was preserved; inspect it before retrying.');
    const stage = path.join(ctx.data, `postgres-init-${process.pid}-${Date.now()}`);
    await initializeCluster(bin, stage, adminPassword, ctx.env);
    await rename(stage, cluster);
  }
  const major = (await readFile(path.join(cluster, 'PG_VERSION'), 'utf8')).trim();
  if (major !== BINARY_VERSION.split('.')[0]) throw new Error(`Cluster is Postgres ${major}; this release bundles ${BINARY_VERSION}. Explicit backup/restore is required; no automatic major upgrade.`);
  // A SIGKILL of the supervisor can leave Postgres alive. pg_ctl checks this
  // exact cluster; below we authenticate and verify data_directory before adoption.
  let adoptedPid: number | undefined;
  try {
    await exec(path.join(bin, 'pg_ctl'), ['status', '-D', cluster], { timeout: 5000, env: nativeEnvironment(ctx.env) });
    adoptedPid = Number((await readFile(path.join(cluster, 'postmaster.pid'), 'utf8')).split('\n')[0]);
    if (!Number.isInteger(adoptedPid) || adoptedPid <= 0) throw new Error('Invalid Postgres pid');
  } catch { adoptedPid = undefined; }
  const log = createWriteStream(path.join(ctx.data, 'logs/postgres.log'), { flags: 'a', mode: 0o600 });
  const child = adoptedPid ? undefined : spawn(path.join(bin, 'postgres'), ['-D', cluster, '-p', String(ctx.state.dbPort), '-h', '127.0.0.1', '-k', ''], { env: nativeEnvironment(ctx.env), stdio: ['ignore', 'pipe', 'pipe'] });
  child?.stdout?.pipe(log, { end: false }); child?.stderr?.pipe(log, { end: false });
  let failed: Error | undefined;
  child?.on('error', error => { failed = error; });
  const { Client } = (await import('pg')).default;
  const connection = { host: '127.0.0.1', port: ctx.state.dbPort, user: 'buddi_admin', password: adminPassword, database: 'postgres', connectionTimeoutMillis: 500, query_timeout: 1000 };
  const deadline = Date.now() + 30_000;
  try {
    for (;;) {
      if (failed || (child && (child.exitCode !== null || child.signalCode !== null))) throw new Error('Postgres failed to start; inspect logs/postgres.log (port conflict or an existing server).');
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
        if ((error as Error).message === 'database-port-conflict') throw new Error(`Database port ${ctx.state.dbPort} belongs to a different cluster. No roles or databases on it were changed.`);
        if (Date.now() > deadline) throw new Error(`Could not authenticate the managed cluster on port ${ctx.state.dbPort}; check for a port conflict and inspect logs/postgres.log.`);
        await new Promise(resolve => setTimeout(resolve, 150));
      } finally { await client.end().catch(() => {}); }
    }
  } catch (error) { await stopChild(child, 'SIGINT'); log.end(); throw error; }
  ctx.env.DATABASE_URL = `postgres://buddi:${encodeURIComponent(password)}@127.0.0.1:${ctx.state.dbPort}/buddi`;
  const monitor = watchDatabase(async () => {
    const client = new Client(connection);
    client.on('error', () => {});
    try {
      await client.connect();
      const result = await client.query<{ data_directory: string }>('SHOW data_directory');
      if (path.resolve(result.rows[0]!.data_directory) !== cluster) throw new Error('Cluster identity changed');
    } finally { await client.end().catch(() => {}); }
  });
  child?.once('exit', monitor.fail);
  if (child && (child.exitCode !== null || child.signalCode !== null)) monitor.fail();
  return { pid: child?.pid ?? adoptedPid, child, exited: monitor.exited, get alive() { return monitor.alive; }, stop: async () => {
    monitor.stop();
    if (child) await stopChild(child, 'SIGINT');
    else {
      let running = true;
      try { await exec(path.join(bin, 'pg_ctl'), ['status', '-D', cluster], { timeout: 5000, env: nativeEnvironment(ctx.env) }); }
      catch (error) { if ((error as { code?: unknown }).code === 3) running = false; else throw error; }
      if (running) await exec(path.join(bin, 'pg_ctl'), ['stop', '-D', cluster, '-m', 'fast', '-t', '15'], { timeout: 20_000, env: nativeEnvironment(ctx.env) });
    }
    log.end();
  } };
}
