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
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createWriteStream, existsSync, openSync, closeSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { readFile, chmod, unlink, lstat, mkdir, rename, copyFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, initialize, atomicJson, stopChild, portMovedLines, launchAgentLabel, launchAgentPlist, systemdUnitPath, nativeEnvironment, SERVICE_UNIT_VAR } from './environment.js';
import { APP_UNINSTALL_EXIT, UNINSTALL_REQUEST, createProductUninstall } from './product-uninstall.js';
import type { ProductUninstall } from './product-uninstall.js';
import { installShim, shimsFor } from './cli-shim.js';
import type { ShimOutcome } from './cli-shim.js';
import type { InstallContext, ReadyContext } from './environment.js';
import { createBackupService, isIncomingPath, isSafeArchiveName, parseSchedule, sweepIncoming } from './backup.js';
import type { BackupControl } from './backup.js';
import { startDatabase } from './postgres.js';
import type { ManagedDatabase } from './postgres.js';
import { createUpgradeService, finishUpgrade, handOver, installedVersion, isVersion, recoverySentence, statusOnSocket, TICK_INTERVAL_MS } from './upgrade.js';
import type { UpgradeControl, UpgradeInProgress } from './upgrade.js';
import { APP_RESTART_EXIT, appLayout } from './app-layout.js';

/** The launcher, as the supervisor spawns it for the gateway child. */
const LAUNCHER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'launcher.js');

/**
 * Is there an upgrade waiting to be finished?
 *
 * The marker, not the phase: a crash between installing the new code and
 * writing an outcome can leave any phase at all on disk, and only
 * `state.upgrade` says which upgrade was under way and what it backed up.
 */
export function pendingUpgrade(marker: UpgradeInProgress | undefined): UpgradeInProgress | undefined {
  if (!marker || typeof marker !== 'object') return undefined;
  const { from, to, startedAt } = marker;
  const named = [from, to, startedAt].every(value => typeof value === 'string' && value !== '');
  return named ? marker : undefined;
}

/** The control socket of the installation whose data directory this is. */
export function supervisorSocket(data: string): string {
  return path.join(data, 'supervisor.sock');
}

/** The moved-port line for `/status`, for a day after the move. */
function portNotice(moved: { at: string } | undefined): { portNotice?: string } {
  if (!moved || Date.now() - Date.parse(moved.at) > 24 * 60 * 60_000) return {};
  const lines = portMovedLines(moved as Parameters<typeof portMovedLines>[0]);
  return lines.length === 0 ? {} : { portNotice: lines.join(' ') };
}

/** Single quotes for sh. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * One shell command with macOS's administrator prompt (osascript's `with
 * administrator privileges`): the owner sees the system dialog, once. Throws
 * when it is declined or fails.
 */
function runAsAdmin(command: string): Promise<void> {
  const script = `do shell script ${JSON.stringify(command)} with administrator privileges`;
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 120_000 }, (error) => (error ? reject(error) : resolve()));
  });
}

export function restartDelay(failures: number): number { return Math.min(30_000, 2000 * 2 ** Math.min(failures, 4)); }

/**
 * How long a handed-over supervisor waits to leave on its own before it is
 * made to. Long enough for an orderly exit, short enough that nobody notices.
 */
export const HANDOVER_GRACE_MS = 5_000;

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
  /** The installed product version, and whether it is being replaced. */
  current?: string;
  upgrading?: boolean;
  /** A recorded port another program took, moved within the last day: the app says it once. */
  portNotice?: string;
}

export interface ControlSocketOptions {
  status: () => SupervisorStatus;
  action: (name: string) => Promise<void>;
  /** The backup verbs, when this supervisor has an installation to back up. */
  backup?: BackupControl | undefined;
  /** The version and upgrade verbs, for the same reason. */
  upgrade?: UpgradeControl | undefined;
  /** The data directory, for the one path clients may name: `<data>/incoming/`. */
  data?: string | undefined;
  /** Uninstall from the product (product-uninstall.ts). */
  uninstall?: ProductUninstall | undefined;
  /** buddi.app's command line tool (cli-shim.ts); absent outside the app. */
  cli?: { status: () => { available: boolean; installed: string[]; reason?: string }; install: () => Promise<ShimOutcome> } | undefined;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

/** A control-socket body. Small on purpose: nothing here is ever a megabyte. */
async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += (chunk as Buffer).length;
    if (bytes > 64_000) return null;
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * The maintenance API, served on a Unix domain socket in the data directory.
 *
 * There is no token, no session and no CSRF here, deliberately: the socket
 * file is mode 0600 inside a 0700 data directory, so the only process that can
 * open it already runs as the owning user — the user who could equally read
 * the vault key or signal the supervisor directly. A credential on top of that
 * would guard nothing, and every credential is one more thing to leak. What
 * the socket exposes is still narrow: no arbitrary command, SQL or environment
 * input, only start, stop, restart, status and the backup verbs.
 *
 * The backup verbs are where "no path input" needed one exception, and it is
 * the narrow one: a client names an *archive* by the name it read from
 * `GET /backups`, and the name is joined to the backups directory here after
 * being checked for a separator, a `..` and the shape of a name we write. The
 * single path a client may send is an upload the gateway itself put under
 * `<data>/incoming/`, and that is checked to be under that directory, resolved,
 * before it is passed on.
 */
export function controlSocket({ status, action, backup, upgrade, data, uninstall, cli }: ControlSocketOptions): Server {
  return createServer((req, res) => {
    void handle(req, res).catch(() => send(res, 500, { error: 'The supervisor could not complete that action.' }));
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // A Unix socket has no host. Clients send `localhost` or nothing; anything
    // else is a confused browser-shaped request, and rejecting it is one line.
    const host = req.headers.host;
    if (host !== undefined && host !== '' && !/^localhost(:\d+)?$/i.test(host)) return send(res, 403, { error: 'unexpected host' });
    const route = (req.url ?? '/').split('?')[0] as string;
    const method = req.method ?? 'GET';
    if (method === 'GET' && route === '/status') {
      const base = status();
      if (!backup) return send(res, 200, base);
      return send(res, 200, { ...base, recovery: await recovery(), lastBackupAt: await backup.lastBackupAt() });
    }
    if (method === 'POST' && ['/start', '/stop', '/restart'].includes(route)) {
      // One hand on the lever at a time: a restore is already stopping and
      // starting the gateway around a database it is replacing.
      if (backup?.busy()) return send(res, 409, { error: 'A restore is running.' });
      // An upgrade is the same lever: it stops the gateway, replaces the code
      // under it and hands over to a new supervisor.
      if (upgrade?.busy()) return send(res, 409, { error: 'An upgrade is running.' });
      const name = route.slice(1);
      /*
       * `start` and `stop` are answered when they are done, with the status
       * that is true afterwards. Neither kills the caller: the CLI's
       * `buddi service stop` is a separate process, and the dashboard has
       * already put its own reply on the wire before it asks.
       */
      if (name === 'start' || name === 'stop') {
        await action(name);
        return send(res, 200, status());
      }
      /*
       * `restart` is the one that kills the caller.
       *
       * When it comes from the dashboard the gateway composing the reply is
       * the child being replaced, and a reply written after that is written to
       * a socket nobody is reading. So the request is acknowledged first and
       * performed after — which is also what lets the dashboard treat the
       * acknowledgement as "the supervisor has this now" before it finishes
       * leaving recovery.
       */
      const running = action(name);
      running.catch(() => {});
      send(res, 202, status());
      await running;
      return;
    }

    if (route === '/version') {
      if (!upgrade) return send(res, 404, { error: 'no such endpoint' });
      if (method === 'GET') return send(res, 200, await upgrade.view());
    }
    if (route === '/version/check') {
      if (!upgrade) return send(res, 404, { error: 'no such endpoint' });
      // A check the owner asked for runs whatever the switch says; the switch
      // only decides whether the daily tick asks on its own.
      if (method === 'POST') return send(res, 200, await upgrade.check());
      if (method === 'PUT') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'The body has to be a JSON object.' });
        if (typeof body.enabled !== 'boolean') return send(res, 400, { error: '"enabled" must be true or false.' });
        return send(res, 200, await upgrade.setCheckEnabled(body.enabled));
      }
    }
    if (route === '/upgrade' && method === 'POST') {
      if (!upgrade) return send(res, 404, { error: 'no such endpoint' });
      const body = await readBody(req);
      if (body === null) return send(res, 400, { error: 'The body has to be a JSON object.' });
      // A version, not a range, a tag or anything npm would resolve for us:
      // everything downstream records it, compares it and checks it against
      // what ended up on disk. See VERSION_PATTERN in upgrade.ts.
      if (body.version !== undefined && !isVersion(body.version)) {
        return send(res, 400, { error: '"version" must be a version like 1.2.3.' });
      }
      const started = upgrade.start(optionalString(body.version));
      if ('status' in started) return send(res, started.status, { error: started.error });
      return send(res, 202, { job: started });
    }

    if (route === '/backups' && method === 'GET') {
      if (!backup) return send(res, 404, { error: 'no such endpoint' });
      return send(res, 200, await backup.list());
    }
    if (route === '/backup' && method === 'POST') {
      if (!backup) return send(res, 404, { error: 'no such endpoint' });
      if (backup.busy()) return send(res, 409, { error: 'A restore is running.' });
      // An upgrade has the same lever: it takes its own backup, stops the
      // gateway and replaces the code that would write the next one.
      if (upgrade?.busy()) return send(res, 409, { error: 'An upgrade is running.' });
      const body = await readBody(req);
      if (body === null) return send(res, 400, { error: 'The body has to be a JSON object.' });
      if (body.encrypt !== undefined && typeof body.encrypt !== 'boolean') {
        return send(res, 400, { error: '"encrypt" must be true or false.' });
      }
      const started = backup.create(body.encrypt as boolean | undefined);
      if ('status' in started) return send(res, started.status, { error: started.error });
      return send(res, 202, { job: started });
    }
    if (route === '/verify' && method === 'POST') {
      if (!backup) return send(res, 404, { error: 'no such endpoint' });
      const body = await readBody(req);
      if (body === null) return send(res, 400, { error: 'The body has to be a JSON object.' });
      if (!isSafeArchiveName(body.name)) return send(res, 400, { error: 'That is not the name of a backup.' });
      return send(res, 202, { job: backup.verify(body.name) });
    }
    if (route === '/restore' && method === 'POST') {
      if (!backup) return send(res, 404, { error: 'no such endpoint' });
      if (upgrade?.busy()) return send(res, 409, { error: 'An upgrade is running.' });
      const body = await readBody(req);
      if (body === null) return send(res, 400, { error: 'The body has to be a JSON object.' });
      // Exactly one of the two, and the path only under `<data>/incoming/`.
      const named = body.name !== undefined, given = body.path !== undefined;
      if (named === given) return send(res, 400, { error: 'Name one backup, by name or by uploaded file.' });
      if (named && !isSafeArchiveName(body.name)) return send(res, 400, { error: 'That is not the name of a backup.' });
      if (given && (data === undefined || !isIncomingPath(data, body.path))) {
        return send(res, 400, { error: 'An uploaded backup has to be one buddi received itself.' });
      }
      const outcome = await backup.restore({
        ...(named ? { name: body.name as string } : {}),
        ...(given ? { path: body.path as string } : {}),
        ...(optionalString(body.passphrase) === undefined ? {} : { passphrase: body.passphrase as string }),
        ...(optionalString(body.confirm) === undefined ? {} : { confirm: body.confirm as string }),
      });
      if ('status' in outcome) return send(res, outcome.status, { error: outcome.error });
      return send(res, 202, { job: outcome });
    }
    if (route === '/cli') {
      if (!cli) return send(res, 404, { error: 'no such endpoint' });
      if (method === 'GET') return send(res, 200, cli.status());
      if (method === 'POST') {
        const outcome = await cli.install();
        return outcome.ok ? send(res, 200, { file: outcome.file, lines: outcome.lines }) : send(res, outcome.status, { error: outcome.error });
      }
    }
    if (route === '/uninstall' && method === 'GET') {
      if (!uninstall) return send(res, 404, { error: 'no such endpoint' });
      return send(res, 200, uninstall.plan());
    }
    if (route === '/uninstall/backup' && method === 'POST') {
      if (!uninstall) return send(res, 404, { error: 'no such endpoint' });
      if (backup?.busy()) return send(res, 409, { error: 'A restore is running.' });
      if (upgrade?.busy()) return send(res, 409, { error: 'An upgrade is running.' });
      const started = uninstall.keepLast();
      if ('status' in started) return send(res, started.status, { error: started.error });
      return send(res, 202, { job: started });
    }
    if (route === '/uninstall' && method === 'POST') {
      if (!uninstall) return send(res, 404, { error: 'no such endpoint' });
      if (backup?.busy()) return send(res, 409, { error: 'A restore is running.' });
      if (upgrade?.busy()) return send(res, 409, { error: 'An upgrade is running.' });
      const body = await readBody(req);
      if (body === null) return send(res, 400, { error: 'The body has to be a JSON object.' });
      if (body.keepData !== undefined && typeof body.keepData !== 'boolean') return send(res, 400, { error: '"keepData" must be true or false.' });
      const outcome = uninstall.start({ keepData: body.keepData === true });
      return send(res, outcome.status, outcome.error === undefined ? { accepted: true } : { error: outcome.error });
    }
    const jobRoute = /^\/jobs\/([0-9a-f-]{36})$/i.exec(route);
    if (jobRoute && method === 'GET') {
      if (!backup && !upgrade && !uninstall) return send(res, 404, { error: 'no such endpoint' });
      // One job route for every store: a client that was handed an id polls it
      // without having to remember which verb produced it.
      const job = backup?.job(jobRoute[1] as string) ?? upgrade?.job(jobRoute[1] as string) ?? uninstall?.job(jobRoute[1] as string);
      return job ? send(res, 200, job) : send(res, 404, { error: 'no such job' });
    }
    if (route === '/schedule') {
      if (!backup) return send(res, 404, { error: 'no such endpoint' });
      if (method === 'GET') return send(res, 200, await backup.schedule());
      if (method === 'PUT') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'The body has to be a JSON object.' });
        const parsed = parseSchedule(body);
        if ('error' in parsed) return send(res, 400, { error: parsed.error });
        const saved = await backup.setSchedule(parsed.schedule);
        if ('error' in saved) return send(res, 400, { error: saved.error });
        return send(res, 200, saved.schedule);
      }
    }
    if (route === '/passphrase') {
      if (!backup) return send(res, 404, { error: 'no such endpoint' });
      if (method === 'GET') return send(res, 200, { passphrase: await backup.passphrase() });
      if (method === 'PUT') {
        const body = await readBody(req);
        if (body === null) return send(res, 400, { error: 'The body has to be a JSON object.' });
        if (typeof body.passphrase !== 'string' || normalizePassphraseText(body.passphrase) === '') {
          return send(res, 400, { error: 'A passphrase cannot be empty.' });
        }
        await backup.setPassphrase(body.passphrase);
        return send(res, 200, { passphrase: await backup.passphrase() });
      }
    }
    send(res, 404, { error: 'no such endpoint' });
  }

  async function recovery(): Promise<boolean> {
    return backup?.inRecovery ? await backup.inRecovery() : false;
  }
}

/**
 * The same normalization `@buddi/core` does, repeated in four characters'
 * worth of regex rather than imported: nothing in this module may take a value
 * import from a `@buddi/*` package (see the note at the top of the file).
 */
function normalizePassphraseText(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

/**
 * Bind the control socket, replacing a stale file a killed supervisor left.
 *
 * The bind itself is what makes the file, so its mode is the process umask for
 * an instant before the `chmod`. The data directory is 0700, so no other user
 * can reach the path in that window either way.
 */
export async function listenOnSocket(server: Server, socket: string): Promise<void> {
  // Only a socket is replaced: a killed supervisor leaves exactly that. Any
  // other entry at the path is somebody else's, and refusing beats deleting it.
  try {
    const entry = await lstat(socket);
    if (!entry.isSocket()) throw new Error(`${socket} exists and is not a socket; move it aside before starting buddi.`);
    await unlink(socket);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => resolve());
  });
  await chmod(socket, 0o600);
}

export async function supervise(ctx: InstallContext): Promise<void> {
  /*
   * The environment as this supervisor was started with it, captured before
   * anything hydrates a database password or a vault key into it: it is what
   * the successor of an upgrade is spawned with, and a secret that travelled
   * through a restart would outlive the process that was allowed to hold it.
   */
  const startEnv = { ...ctx.env };
  const release = await acquireLock(ctx.data);
  let database: ManagedDatabase | undefined, server: Server | undefined, child: ChildProcess | undefined, retry: NodeJS.Timeout | undefined, log: WriteStream | undefined;
  let backup: BackupControl | undefined, scheduleTick: NodeJS.Timeout | undefined;
  let upgrade: UpgradeControl | undefined, upgradeTick: NodeJS.Timeout | undefined, handingOver = false;
  let uninstall: ProductUninstall | undefined, leavingForUninstall = false;
  /** Has a pending upgrade been written into the history yet? */
  let resolved = false, pending: UpgradeInProgress | undefined;
  let desired = true, closing = false, chain: Promise<void> = Promise.resolve();
  let failures = 0;
  const stopGateway = async () => {
    desired = false; clearTimeout(retry);
    // The log is the only account of why a gateway went away: without this
    // line a stop and a crash look the same in logs/gateway.log.
    if (child) console.error(`supervisor: stopping the gateway (pid ${child.pid}).`);
    await stopChild(child); child = undefined;
  };
  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>(resolve => { resolveShutdown = resolve; });
  const onSignal = () => { closing = true; desired = false; resolveShutdown(); };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  try {
    await initialize(ctx);
    const ready = ctx as ReadyContext;
    /*
     * An upgrade that installed new code and handed over is finished here, by
     * the code it installed. `phase` says whether there is one; it is read
     * before the migration below rewrites it, and the entry it produces is
     * what the dashboard, the CLI and the doctor all report afterwards.
     */
    pending = pendingUpgrade(ready.state.upgrade);
    const current = await installedVersion(ready.root);
    const core = await import('@buddi/core');
    const gateway = await import('@buddi/gateway');
    database = await startDatabase(ready, core);
    database.exited.then(() => {
      if (!closing) { console.error('Managed Postgres exited; stopping the gateway. Restart buddi after checking logs/postgres.log.'); onSignal(); }
    });
    /*
     * `migrating` is not written over a pending upgrade. The marker in
     * `state.upgrade` is the only thing that says an upgrade is half done, and
     * a crash while these migrations run — the most likely moment for one —
     * would otherwise leave a phase that says `migrating` and nothing that
     * says which upgrade, so the next start would migrate as if none were
     * under way. The marker is cleared in `finishUpgrade`, with the outcome.
     */
    if (!pending) { ready.state.phase = 'migrating'; await atomicJson(path.join(ready.data, 'installation.json'), ready.state); }
    const pool = core.createPool(ready.env.DATABASE_URL as string);
    let migrationFailure: string | undefined;
    try {
      /*
       * The refusal, the migrations and the account of them — the gateway's
       * own `migrateAtStart`, which is also what a checkout's `buddi serve`
       * runs on itself. One function so that "a start migrates" means the same
       * thing here and there: schema newer than this code refuses before
       * anything runs; core and the compiled-in plugins throw; an installed
       * third-party plugin whose migrations will not apply is that plugin
       * failing to load, not this installation failing to start
       * (docs/install.md §7), reported on the log and by the Plugins page.
       */
      await gateway.migrateAtStart(pool, ready.env, { log: line => console.error(`supervisor: ${line}`) });
    }
    catch (error) {
      // A migration that fails during an upgrade is not a supervisor that
      // fails to start: the owner needs a process that can still be asked what
      // happened, and one sentence telling them the way back. Every other
      // start still throws, exactly as before.
      if (!pending) throw error;
      migrationFailure = error instanceof Error ? error.message : String(error);
    }
    finally { await pool.end(); }
    if (pending) {
      const entry = await finishUpgrade(ready, pending, migrationFailure === undefined ? { ok: true } : { ok: false, error: migrationFailure });
      resolved = true;
      // `finishing` is the entry a recovery produces: the old code was put
      // back and came up, so the upgrade is over without having arrived.
      console.error(entry.outcome === 'done'
        ? `upgrade: ${entry.from} to ${entry.to} finished.`
        : entry.step === 'finishing' ? `upgrade: ${entry.error}.` : recoverySentence(entry, { app: appLayout(process.env) !== undefined }));
    } else {
      ready.state.phase = 'ready'; await atomicJson(path.join(ready.data, 'installation.json'), ready.state);
    }
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
      console.error(`supervisor: gateway started (pid ${child.pid}).`);
      child.stdout!.pipe(log!, { end: false }); child.stderr!.pipe(log!, { end: false });
      child.once('error', () => console.error('Gateway could not start; check the installed Node executable.'));
      child.once('close', () => {
        if (Date.now() - started >= 60_000) failures = 0;
        if (desired && !closing && database!.alive) retry = setTimeout(start, restartDelay(failures++));
      });
    };
    // Backups run here rather than in the gateway: the supervisor is the
    // process that owns the database and can stop the gateway, which is what a
    // restore needs. The minute tick is the whole schedule — see backup.ts.
    backup = createBackupService({
      ctx: ready, core, gateway,
      stopGateway: async () => { await stopGateway(); },
      startGateway: () => start(),
      log: line => console.error(line),
    });
    // An upload the owner never restored from is a whole installation's worth
    // of bytes in a directory nothing reads. A day is long enough for anyone
    // who meant to go through with it.
    const swept = await sweepIncoming(ready.data).catch(() => [] as string[]);
    if (swept.length > 0) console.error(`backup: discarded ${swept.length} uploaded archive(s) nobody restored from`);
    scheduleTick = setInterval(() => {
      void backup!.tick().catch(err => console.error(`backup: the schedule tick failed: ${err instanceof Error ? err.message : String(err)}`));
    }, 60_000);
    if (typeof scheduleTick.unref === 'function') scheduleTick.unref();
    // Upgrading runs here for the same reason backing up does, and one more:
    // the supervisor is the only process that survives the code being replaced
    // under it, because it is the one that hands over. See upgrade.ts.
    upgrade = createUpgradeService({
      ctx: ready, current, backup,
      stopGateway: async () => { await stopGateway(); },
      startGateway: () => start(),
      restart: () => { handingOver = true; onSignal(); },
      http: gateway.defaultHttpTransport,
      log: line => console.error(line),
    });
    // Uninstall from the product: the last backup and its words first, then the removal (product-uninstall.ts).
    const home = os.homedir();
    const appFinishes = appLayout(process.env) !== undefined;
    uninstall = createProductUninstall({
      data: ready.data, home, backup, appFinishes,
      plan: () => {
        const unit = process.platform === 'darwin' ? launchAgentPlist(ready.data, home) : process.platform === 'linux' ? systemdUnitPath(ready.data, ready.env, home) : undefined;
        const bundle = process.env.BUDDI_APP_BUNDLE?.trim();
        return {
          data: ready.data,
          ...(core.vaultSelection({ env: ready.env }) === 'keychain' && ready.env.BUDDI_VAULT_SERVICE ? { keychain: ready.env.BUDDI_VAULT_SERVICE } : {}),
          ...(unit !== undefined && existsSync(unit) ? { service: process.platform === 'darwin' ? `launchd agent ${launchAgentLabel(ready.data)}` : `systemd user unit ${launchAgentLabel(ready.data)}.service` } : {}),
          ...(appFinishes && bundle ? { app: bundle } : {}),
          backups: path.join(home, 'buddi-backups'),
          appFinishes,
        };
      },
      exists: existsSync,
      move: async (from, to) => {
        await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
        try { await rename(from, to); } catch { await copyFile(from, to); await rm(from, { force: true }); }
      },
      writePrivate: async (file, text) => {
        await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(file, text, { mode: 0o600 });
        await chmod(file, 0o600);
      },
      writeRequest: request => atomicJson(path.join(ready.data, UNINSTALL_REQUEST), request),
      exitForApp: () => { console.error('supervisor: stopping so buddi.app can remove buddi.'); leavingForUninstall = true; onSignal(); },
      spawnUninstall: (argv, logFile) => {
        mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
        const fd = openSync(logFile, 'a', 0o600);
        const env = { ...nativeEnvironment(startEnv), BUDDI_DATA_DIR: ready.data,
          ...Object.fromEntries(['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'].filter(key => typeof startEnv[key] === 'string').map(key => [key, startEnv[key] as string])) };
        // systemd stops every process in the unit's cgroup with it: the uninstall runs in a transient scope of its own.
        const [command, args] = startEnv[SERVICE_UNIT_VAR]
          ? ['systemd-run', ['--user', '--collect', '--quiet', '--scope', process.execPath, LAUNCHER, ...argv]]
          : [process.execPath, [LAUNCHER, ...argv]];
        console.error(`supervisor: removing buddi; the account is in ${logFile}.`);
        const child = spawn(command as string, args as string[], { detached: true, stdio: ['ignore', fd, fd], env, cwd: home });
        child.unref();
        closeSync(fd);
      },
    });
    // buddi.app's command line tool: one code path for the app's menu and Settings → System (cli-shim.ts).
    const appBundle = process.env.BUDDI_APP_BUNDLE?.trim();
    const shimDeps = () => ({
      home,
      searchPath: (startEnv.PATH ?? '').split(':'),
      exists: existsSync,
      realPath: (file: string) => { try { return realpathSync(file); } catch { return undefined; } },
      read: (file: string) => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } },
      write: async (file: string, text: string) => {
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, text, { mode: 0o755 });
        await chmod(file, 0o755);
      },
      writeAsAdmin: async (file: string, text: string) => {
        const staged = path.join(ready.data, `.cli-shim-${process.pid}`);
        await writeFile(staged, text, { mode: 0o755 });
        try { await runAsAdmin(`/bin/mkdir -p ${shellQuote(path.dirname(file))} && /usr/bin/install -m 0755 ${shellQuote(staged)} ${shellQuote(file)}`); }
        finally { await rm(staged, { force: true }); }
      },
      remove: (file: string) => rm(file, { force: true }),
      removeAsAdmin: (file: string) => runAsAdmin(`/bin/rm -f ${shellQuote(file)}`),
    });
    const cli = appFinishes && appBundle ? {
      status: () => ({ available: true, installed: shimsFor(ready.data, shimDeps()) }),
      install: () => installShim({ app: appBundle, data: ready.data }, shimDeps()),
    } : {
      status: () => ({ available: false, installed: [] as string[], reason: 'This buddi came from npm, and its buddi command is already on your PATH.' }),
      install: async (): Promise<ShimOutcome> => ({ ok: false, status: 409, error: 'This buddi came from npm, and its buddi command is already on your PATH.' }),
    };
    server = controlSocket({
      status: () => ({ phase: ready.state.phase, supervisorPid: process.pid, installRoot: ready.root, nodePath: process.execPath, database: database!.pid ? (database!.alive ? 'running' : 'failed') : 'external', databasePid: database!.pid,
        gateway: child && child.exitCode === null && child.signalCode === null ? 'running' : 'stopped', gatewayPid: child?.pid ?? null,
        current, upgrading: upgrade!.busy(), ...portNotice(ready.state.portMoved) }),
      action: name => { console.error(`supervisor: ${name} asked for on the control socket.`); chain = chain.catch(() => {}).then(async () => { if (name !== 'start') await stopGateway(); if (name !== 'stop') start(); }); return chain; },
      backup, upgrade, data: ready.data, uninstall, cli,
    });
    await listenOnSocket(server, supervisorSocket(ready.data));
    if (migrationFailure === undefined) start();
    else console.error('supervisor: the gateway was not started; this installation is in upgrade-failed.');
    // The daily version check: once at start, now that the installation is up,
    // and then on the hour, which is only ever a question about the clock —
    // `tick` itself refuses to ask the registry more than once a day.
    const tick = (): void => {
      void upgrade!.tick().catch(err => console.error(`upgrade: the version check failed: ${err instanceof Error ? err.message : String(err)}`));
    };
    upgradeTick = setInterval(tick, Number(ready.env.BUDDI_UPGRADE_TICK_MS) || TICK_INTERVAL_MS);
    if (typeof upgradeTick.unref === 'function') upgradeTick.unref();
    tick();
    console.log('Buddi supervisor ready.');
    await shutdown;
  } catch (error) {
    /*
     * The new code could not start at all — a cluster it cannot run, a file
     * the install did not land. That is an upgrade that failed just as much as
     * a migration that threw, and without this it would be a `phase:
     * upgrading` nobody ever writes an outcome for. The start still fails:
     * there is no database here to serve a control socket around.
     */
    if (pending && !resolved) {
      const entry = await finishUpgrade(ctx as ReadyContext, pending, { ok: false, error: error instanceof Error ? error.message : String(error) }, 'starting')
        .catch(() => undefined);
      if (entry) console.error(recoverySentence(entry, { app: appLayout(process.env) !== undefined }));
    }
    throw error;
  } finally {
    closing = true;
    clearInterval(scheduleTick);
    clearInterval(upgradeTick);
    await chain.catch(() => {});
    await stopGateway();
    if (server?.listening) {
      /*
       * `close` stops the supervisor listening; it does not touch the
       * connections already open, and `node:http`'s default agent keeps its
       * connections alive — the dashboard and the CLI both poll `/jobs/:id`
       * right up to the hand-over. A socket left open that way is a handle
       * that holds the event loop, which is how a handed-over supervisor ends
       * up alive and idle for the rest of the login session.
       */
      const closed = new Promise(resolve => server!.close(resolve));
      server.closeAllConnections();
      await closed;
    }
    try { await database?.stop(); }
    finally {
      log?.end(); await release();
      process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
    }
  }
  // buddi.app finishes an uninstall the owner started in Settings → System (product-uninstall.ts).
  if (leavingForUninstall) {
    process.exitCode = APP_UNINSTALL_EXIT;
    const grace = setTimeout(() => process.exit(APP_UNINSTALL_EXIT), HANDOVER_GRACE_MS);
    grace.unref?.();
    return;
  }
  /*
   * The hand-over, after everything above has let go: the lock, the socket,
   * the database. It is last on purpose — the successor takes the same lock,
   * and a supervisor that started its replacement before releasing it would
   * hand the new code an installation it cannot open.
   */
  if (handingOver) {
    const marker = ctx.state?.upgrade;
    const result = await handOver({
      ctx, launcher: LAUNCHER, env: startEnv,
      /*
       * The successor is ready when it serves, not when it holds the lock: it
       * takes the lock first and then starts a cluster and runs migrations,
       * either of which can still kill it. `/status` naming the version we
       * installed is the whole hand-over, observed rather than assumed.
       */
      ready: async () => {
        const status = await statusOnSocket(supervisorSocket(ctx.data));
        if (status !== undefined && status.current === marker?.to) return true;
        /*
         * Or the successor has already been and written an outcome.
         *
         * `phase: 'upgrading'` is what this process wrote before handing over,
         * and `finishUpgrade` in the successor is the only thing that replaces
         * it. A successor that migrated, recorded the outcome and was then
         * stopped — by an owner following the recovery sentence, or by the
         * release smoke — leaves a socket that does not answer and a file that
         * says the upgrade is over. Waiting another two minutes for it and
         * then spawning a second supervisor over the top is how one idle
         * process per upgrade used to survive the run.
         */
        const written = await readFile(path.join(ctx.data, 'installation.json'), 'utf8')
          .then(text => (JSON.parse(text) as { phase?: string }).phase)
          .catch(() => undefined);
        return written !== undefined && written !== 'upgrading';
      },
    });
    /*
     * Nothing answered, twice. That is an upgrade that failed, and the one
     * thing this process can still do for its owner is write down that it did
     * — with the archive taken first — before it goes. The marker stays, so a
     * successor that turns up late still finishes the upgrade properly.
     */
    if (!result.ok && marker) {
      const entry = await finishUpgrade(ctx as ReadyContext, marker, { ok: false, error: `the upgraded supervisor did not answer on ${supervisorSocket(ctx.data)}` }, 'starting')
        .catch(() => undefined);
      if (entry) console.error(recoverySentence(entry, { app: appLayout(process.env) !== undefined }));
    }
    /*
     * And then go, whatever is still holding the loop.
     *
     * Everything this process owns has been let go of by here, but a handle
     * nobody remembers — a client socket, a stream, a timer in a package this
     * imported — is enough to keep it alive, and what that leaves behind is an
     * idle supervisor per upgrade until the next login. The successor is
     * serving; there is nothing this process can still be for. The timer is
     * unref'd so a process that was going to exit anyway exits silently.
     */
    // buddi.app reads this status as "start `current` again, now" (app-layout.ts).
    const status = result.plan.mode === 'app' ? APP_RESTART_EXIT : 0;
    if (status !== 0) process.exitCode = status;
    const grace = setTimeout(() => {
      console.error('supervisor: handed over, but something is still holding this process open; exiting.');
      process.exit(status);
    }, HANDOVER_GRACE_MS);
    grace.unref?.();
  }
}
