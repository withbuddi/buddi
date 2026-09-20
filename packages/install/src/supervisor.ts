/**
 * The supervisor: one per installation, owner of the managed database and of
 * the gateway process, plus the narrow control surface that starts and stops
 * the gateway.
 *
 * `@buddi/core` and `@buddi/gateway` are imported dynamically, after
 * `environment()` has rewritten the environment their path constants are
 * computed from at import time. Types are imported statically; they are erased.
 */
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { readdir, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, initialize, atomicJson, stopChild } from './environment.js';
import type { InstallContext, ReadyContext } from './environment.js';
import { startDatabase } from './postgres.js';
import type { ManagedDatabase } from './postgres.js';

/** The launcher, as the supervisor spawns it for the gateway child. */
const LAUNCHER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'launcher.js');

/** The control socket of the installation whose data directory this is. */
export function supervisorSocket(data: string): string {
  return path.join(data, 'supervisor.sock');
}

export function restartDelay(failures: number): number { return Math.min(30_000, 2000 * 2 ** Math.min(failures, 4)); }

/** What `/status` reports; the CLI prints it verbatim. */
export interface SupervisorStatus {
  phase: string | undefined;
  supervisorPid: number;
  installRoot: string;
  nodePath: string;
  database: string;
  databasePid: number | null | undefined;
  gateway: string;
  gatewayPid: number | null;
}

export interface ControlSocketOptions {
  status: () => SupervisorStatus;
  action: (name: string) => Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

/**
 * The maintenance API, served on a Unix domain socket in the data directory.
 *
 * There is no token, no session and no CSRF here, deliberately: the socket
 * file is mode 0600 inside a 0700 data directory, so the only process that can
 * open it already runs as the owning user — the user who could equally read
 * the vault key or signal the supervisor directly. A credential on top of that
 * would guard nothing, and every credential is one more thing to leak. What
 * the socket exposes is still narrow: no arbitrary command, path, SQL or
 * environment input, only start, stop, restart and status.
 */
export function controlSocket({ status, action }: ControlSocketOptions): Server {
  return createServer((req, res) => {
    void handle(req, res).catch(() => send(res, 500, { error: 'The supervisor could not complete that action.' }));
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A Unix socket has no host. Clients send `localhost` or nothing; anything
    // else is a confused browser-shaped request, and rejecting it is one line.
    const host = req.headers.host;
    if (host !== undefined && host !== '' && !/^localhost(:\d+)?$/i.test(host)) return send(res, 403, { error: 'unexpected host' });
    const route = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && route === '/status') return send(res, 200, status());
    if (req.method === 'POST' && ['/start', '/stop', '/restart'].includes(route as string)) {
      await action((route as string).slice(1));
      return send(res, 200, status());
    }
    send(res, 404, { error: 'no such endpoint' });
  }
}

/**
 * Bind the control socket, replacing a stale file a killed supervisor left.
 *
 * The bind itself is what makes the file, so its mode is the process umask for
 * an instant before the `chmod`. The data directory is 0700, so no other user
 * can reach the path in that window either way.
 */
export async function listenOnSocket(server: Server, socket: string): Promise<void> {
  await unlink(socket).catch(() => {});
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => resolve());
  });
  await chmod(socket, 0o600);
}

export async function supervise(ctx: InstallContext): Promise<void> {
  const release = await acquireLock(ctx.data);
  let database: ManagedDatabase | undefined, server: Server | undefined, child: ChildProcess | undefined, retry: NodeJS.Timeout | undefined, log: WriteStream | undefined;
  let desired = true, closing = false, chain: Promise<void> = Promise.resolve();
  let failures = 0;
  const stopGateway = async () => {
    desired = false; clearTimeout(retry);
    await stopChild(child); child = undefined;
  };
  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>(resolve => { resolveShutdown = resolve; });
  const onSignal = () => { closing = true; desired = false; resolveShutdown(); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    await initialize(ctx);
    const ready = ctx as ReadyContext;
    const core = await import('@buddi/core');
    const gateway = await import('@buddi/gateway');
    database = await startDatabase(ready, core);
    database.exited.then(() => {
      if (!closing) { console.error('Managed Postgres exited; stopping the gateway. Restart buddi after checking logs/postgres.log.'); onSignal(); }
    });
    ready.state.phase = 'migrating'; await atomicJson(path.join(ready.data, 'installation.json'), ready.state);
    const pool = core.createPool(ready.env.DATABASE_URL as string);
    try {
      const exists = await pool.query<{ table_name: string | null }>("SELECT to_regclass('core.migrations') AS table_name");
      if (exists.rows[0]!.table_name) {
        const shipped = new Map([['core', new Set(await readdir(core.CORE_MIGRATIONS_DIR))]]);
        for (const manifest of gateway.installedManifests()) {
          if (manifest.migrationsDir) shipped.set(manifest.schema, new Set(await readdir(manifest.migrationsDir)));
        }
        const applied = await pool.query<{ schema: string; filename: string }>('SELECT schema, filename FROM core.migrations');
        if (applied.rows.some(row => shipped.has(row.schema) && !shipped.get(row.schema)!.has(row.filename))) {
          throw new Error('Database schema is newer than this release. Install the matching release; no migration or gateway start was attempted.');
        }
      }
      await core.runMigrations(pool, gateway.installedManifests());
    }
    finally { await pool.end(); }
    ready.state.phase = 'ready'; await atomicJson(path.join(ready.data, 'installation.json'), ready.state);
    await gateway.ensureWebToken({ env: ready.env });
    // The gateway's Settings page is the other client of the control socket.
    ready.env.BUDDI_SUPERVISOR_SOCKET = supervisorSocket(ready.data);
    log = createWriteStream(path.join(ready.data, 'logs/gateway.log'), { flags: 'a', mode: 0o600 });
    const start = () => {
      desired = true;
      clearTimeout(retry);
      if (closing || !database!.alive || (child && child.exitCode === null && child.signalCode === null)) return;
      const started = Date.now();
      child = spawn(process.execPath, [LAUNCHER, '__gateway'], { env: ready.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      child.stdout!.pipe(log!, { end: false }); child.stderr!.pipe(log!, { end: false });
      child.once('error', () => console.error('Gateway could not start; check the installed Node executable.'));
      child.once('close', () => {
        if (Date.now() - started >= 60_000) failures = 0;
        if (desired && !closing && database!.alive) retry = setTimeout(start, restartDelay(failures++));
      });
    };
    server = controlSocket({
      status: () => ({ phase: ready.state.phase, supervisorPid: process.pid, installRoot: ready.root, nodePath: process.execPath, database: database!.pid ? (database!.alive ? 'running' : 'failed') : 'external', databasePid: database!.pid,
        gateway: child && child.exitCode === null && child.signalCode === null ? 'running' : 'stopped', gatewayPid: child?.pid ?? null }),
      action: name => { chain = chain.catch(() => {}).then(async () => { if (name !== 'start') await stopGateway(); if (name !== 'stop') start(); }); return chain; },
    });
    await listenOnSocket(server, supervisorSocket(ready.data));
    start();
    console.log('Buddi supervisor ready.');
    await shutdown;
  } finally {
    closing = true;
    await chain.catch(() => {});
    await stopGateway();
    if (server?.listening) await new Promise(resolve => server!.close(resolve));
    try { await database?.stop(); }
    finally {
      log?.end(); await release();
      process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    }
  }
}
