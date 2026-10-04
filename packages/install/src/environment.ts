/**
 * The packaged installation's environment: data directory, private files,
 * persisted installation state and the startup lock.
 *
 * Nothing here may import a `@buddi/*` package, not even lazily from a
 * function that runs later: `environment()` rewrites `process.env` and the
 * path constants in those packages are evaluated at *import* time, so the
 * first Buddi import has to happen after it. Everything this module needs is
 * Node's own standard library plus `dotenv`.
 */
import { mkdir, readFile, writeFile, rename, open, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync, constants } from 'node:fs';
import { randomBytes, createHash, createHmac } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import type { ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';

/** What a packaged installation persists in `installation.json`. */
export interface InstallationState {
  version: number;
  database: 'managed' | 'external';
  webPort: number;
  dbPort: number;
  phase?: string;
  /**
   * The upgrade that is half done, while `phase` is `upgrading` or
   * `upgrade-failed`. Written by the supervisor that installed the new code
   * and read by the one that finishes the job. See `upgrade.ts`.
   */
  upgrade?: { from: string; to: string; backup?: string; startedAt: string };
  /**
   * Who this installation is, written when it is first provisioned (and added
   * to an older file at the next start): always `packaged`, the data
   * directory it was made for and its keychain namespace. `buddi uninstall`
   * refuses when the folder or the namespace it is about to touch is not the
   * one written here (a copied folder, a stray `BUDDI_DATA_DIR`).
   */
  kind?: 'packaged';
  dataDir?: string;
  vaultService?: string;
  /**
   * A recorded port another program had taken at a start, and where buddi
   * moved: said once in the app, the CLI and Settings (the extension has to
   * be paired again with the new address). `at` is when.
   */
  portMoved?: { web?: { from: number; to: number }; db?: { from: number; to: number }; at: string };
}

/** The one line the app and the CLI say about a moved port. */
export function portMovedLines(moved: InstallationState['portMoved']): string[] {
  if (!moved) return [];
  const lines: string[] = [];
  if (moved.web) lines.push(`Port ${moved.web.from} was taken by another program; buddi now listens on ${moved.web.to}.`);
  if (moved.db) lines.push(`Port ${moved.db.from} was taken by another program; buddi's database now uses ${moved.db.to}.`);
  return lines;
}

/** Is this port free to listen on at 127.0.0.1 right now? */
export async function portFree(port: number): Promise<boolean> {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => resolve()); });
    return true;
  } catch (error) {
    if (errorCode(error) === 'EADDRINUSE' || errorCode(error) === 'EACCES') return false;
    throw error;
  } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
}

export interface PortMoveDeps {
  free: (port: number) => Promise<boolean>;
  pick: () => Promise<number>;
  /** The port our own cluster's `postmaster.pid` records, when there is one (an orphan we will stop, not a stranger). */
  ownClusterPort: () => number | undefined;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
  /** How many times a taken port is looked at again before it is given up: a gateway that just died lets go in a moment. */
  tries?: number;
}

/**
 * The recorded ports, checked at a start: one another program has taken is
 * replaced with a free one, and the state says so. Returns the state to
 * write, or undefined when nothing moved.
 */
export async function movePortsIfTaken(state: InstallationState, deps: PortMoveDeps): Promise<InstallationState | undefined> {
  const tries = deps.tries ?? 5;
  const taken = async (port: number): Promise<boolean> => {
    for (let i = 0; i < tries; i++) {
      if (await deps.free(port)) return false;
      if (i < tries - 1) await deps.sleep(1000);
    }
    return true;
  };
  const moved: NonNullable<InstallationState['portMoved']> = { at: deps.now().toISOString() };
  let webPort = state.webPort, dbPort = state.dbPort;
  if (await taken(webPort)) {
    let to = await deps.pick();
    while (to === dbPort) to = await deps.pick();
    moved.web = { from: webPort, to };
    webPort = to;
  }
  if (state.database === 'managed' && deps.ownClusterPort() !== dbPort && await taken(dbPort)) {
    let to = await deps.pick();
    while (to === webPort) to = await deps.pick();
    moved.db = { from: dbPort, to };
    dbPort = to;
  }
  if (!moved.web && !moved.db) return undefined;
  return { ...state, webPort, dbPort, portMoved: moved };
}

/** The keychain namespace of the installation in `data`: `buddi.install.<sha256(data)[:20]>`. */
export function vaultServiceFor(data: string): string {
  return `buddi.install.${createHash('sha256').update(data).digest('hex').slice(0, 20)}`;
}

/**
 * Does `installation.json` name a different installation than the one at
 * hand? The sentence that says so, or undefined when it matches (or is too
 * old to say).
 */
export function identityMismatch(state: InstallationState | undefined, data: string, vaultService: string | undefined): string | undefined {
  if (!state) return undefined;
  if (state.dataDir !== undefined && path.resolve(state.dataDir) !== path.resolve(data)) {
    return `${path.join(data, 'installation.json')} was written for the installation in ${state.dataDir}, not ${data}.`;
  }
  if (state.vaultService !== undefined && vaultService !== undefined && state.vaultService !== vaultService) {
    return `${path.join(data, 'installation.json')} names the keychain namespace ${state.vaultService}, but this run would use ${vaultService}.`;
  }
  return undefined;
}

/** The install root, its data directory, the mutated environment and the state. */
export interface InstallContext {
  root: string;
  data: string;
  env: NodeJS.ProcessEnv;
  state?: InstallationState;
}

/** A context after `initialize()`, which always leaves the state written. */
export type ReadyContext = InstallContext & { state: InstallationState };

/** An `execFile`-shaped failure: `launchctl` is read through its exit code. */
type ProcessFailure = { code?: unknown; stderr?: string };

function failure(error: unknown): ProcessFailure {
  return (error ?? {}) as ProcessFailure;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Native utilities need OS context, not provider, vault or database credentials. */
export function nativeEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'USER', 'LOGNAME', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']
    .filter(key => typeof env[key] === 'string').map(key => [key, env[key] as string]));
}

/**
 * Stop a child and make sure it is gone. The managed cluster's own child is
 * stopped by the identical helper in `@buddi/core`; this copy exists because
 * nothing in this module may import a `@buddi/*` package (see above).
 */
export async function stopChild(child: ChildProcess | undefined, signal: NodeJS.Signals = 'SIGTERM', timeout = 15_000): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill(signal);
  });
}

/** The one HTTP seam this module has; tests pass their own. */
export type ReadyRequest = (url: string, init?: RequestInit) => Promise<Response>;

export async function dashboardReady(port: number, token: string, request: ReadyRequest = fetch): Promise<boolean> {
  const challenge = randomBytes(32).toString('hex');
  const response = await request(`http://127.0.0.1:${port}/_buddi/ready?challenge=${challenge}`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
  if (response.status !== 200) return false;
  const body = await response.json() as { proof?: string };
  return body.proof === createHmac('sha256', token).update(`buddi-ready-v1:${challenge}`).digest('hex');
}

/**
 * The LaunchAgent this installation installs, named after its data directory
 * so two installations never share a job. Written by `launcher.ts` and read by
 * `upgrade.ts`, which has to know whether launchd will restart the supervisor.
 */
export function launchAgentLabel(data: string): string {
  return `com.buddi.install.${createHash('sha256').update(data).digest('hex').slice(0, 12)}`;
}

export function launchAgentPlist(data: string, home: string = os.homedir()): string {
  return path.join(home, 'Library/LaunchAgents', `${launchAgentLabel(data)}.plist`);
}

/**
 * The systemd *user* unit this installation installs on Linux — the same label,
 * so `restartPlan` reads one name on both platforms. The unit sets
 * `BUDDI_SERVICE_UNIT` to it, which is how a supervisor knows it is systemd's
 * job (systemd has no `XPC_SERVICE_NAME`; `INVOCATION_ID` names any unit).
 */
export const SERVICE_UNIT_VAR = 'BUDDI_SERVICE_UNIT';

export function systemdUnitPath(data: string, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const config = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config');
  return path.join(config, 'systemd', 'user', `${launchAgentLabel(data)}.service`);
}

/**
 * `systemctl --user`, as the caller runs it. `daemon-reload` reads the unit
 * that was just written, `enable` makes it start at login, and `restart`
 * (rather than `start`) is what makes a re-run of `buddi` after an upgrade pick
 * up the unit file's new contents when the job is already running.
 */
export async function reloadSystemdUnit(exec: LaunchctlExec, unit: string): Promise<void> {
  await exec('systemctl', ['--user', 'daemon-reload']);
  await exec('systemctl', ['--user', 'enable', unit]);
  await exec('systemctl', ['--user', 'restart', unit]);
}

/** `launchctl`, as the caller runs it. Only its rejection is inspected. */
export type LaunchctlExec = (command: string, args: string[]) => Promise<unknown>;

export async function reloadLaunchAgent(exec: LaunchctlExec, domain: string, label: string, plist: string): Promise<void> {
  let unloaded = false;
  try { await exec('launchctl', ['bootout', `${domain}/${label}`]); unloaded = true; }
  catch (error) {
    if (failure(error).code !== 3 || !/No such process|Could not find service/i.test(failure(error).stderr ?? '')) throw error;
  }
  // bootout returns while launchd may still be removing a running job.
  if (unloaded) {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { await exec('launchctl', ['print', `${domain}/${label}`]); }
      catch (error) {
        if (failure(error).code === 113 && /Could not find service/i.test(failure(error).stderr ?? '')) break;
        throw error;
      }
      if (Date.now() >= deadline) throw new Error('LaunchAgent did not unload within 20 seconds; inspect its log before retrying.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  await exec('launchctl', ['bootstrap', domain, plist]);
}

/** Open without following a symlink, then validate the actual file descriptor. */
export async function readPrivateFile(file: string): Promise<string | undefined> {
  let fd: FileHandle | undefined;
  try {
    fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await fd.stat();
    if (!info.isFile() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) {
      throw new Error(`Unsafe private file ${file}: expected an owner-only regular file (mode 0600).`);
    }
    return await fd.readFile('utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined;
    if (errorCode(error) === 'ELOOP') throw new Error(`Unsafe private file ${file}: symbolic links are not allowed.`);
    throw error;
  } finally { await fd?.close(); }
}

export function defaultDataDir(platform: NodeJS.Platform | string = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  if (env.BUDDI_DATA_DIR) return path.resolve(env.BUDDI_DATA_DIR);
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'buddi');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'buddi');
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'buddi');
}

/** Where the agents' Chromium lives when buddi fetched it: inside the data directory, with everything else buddi owns. */
export function browsersDir(data: string): string {
  return path.join(data, 'browser', 'engines');
}

/** Playwright's own cache, where its browsers go when `PLAYWRIGHT_BROWSERS_PATH` is not set. */
export function playwrightCacheDir(platform: NodeJS.Platform | string = process.platform, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Caches', 'ms-playwright');
  if (platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ms-playwright');
  return path.join(env.XDG_CACHE_HOME || path.join(home, '.cache'), 'ms-playwright');
}

/** What `browsersPath` reads, injectable so a test says what is on disk. */
export interface BrowsersPathDeps {
  platform?: NodeJS.Platform | string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (dir: string) => boolean;
  /** The names in a directory; empty when it does not exist. */
  list?: (dir: string) => string[];
}

function listDir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/**
 * The value for `PLAYWRIGHT_BROWSERS_PATH`, or undefined to leave Playwright
 * at its own cache.
 *
 * The data directory is the place: a container's volume keeps it, and a
 * backup of the data directory is a backup of everything buddi owns. One
 * exception, so an existing install does not fetch 150 MB again: when the
 * data-directory location does not exist yet and Playwright's cache already
 * holds a Chromium build, the cache stays in use. `buddi browser install`
 * creates the data-directory location, and from then on it wins. A value the
 * owner set themselves is kept.
 *
 * Playwright reads the variable once, when its module loads, so this is set
 * before any `@buddi/*` import (see the header of this file).
 */
export function browsersPath(data: string, deps: BrowsersPathDeps = {}): string | undefined {
  const env = deps.env ?? process.env;
  if (env.PLAYWRIGHT_BROWSERS_PATH) return env.PLAYWRIGHT_BROWSERS_PATH;
  const own = browsersDir(data);
  if ((deps.exists ?? existsSync)(own)) return own;
  const cache = playwrightCacheDir(deps.platform ?? process.platform, env, deps.home ?? os.homedir());
  const cached = (deps.list ?? listDir)(cache).some((name) => /^chromium-\d+$/.test(name));
  return cached ? undefined : own;
}

export async function atomicJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(tmp, file);
}

export async function freePort(preferred = 0): Promise<number> {
  const server = net.createServer();
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(preferred, '127.0.0.1', () => resolve()); });
    return (server.address() as AddressInfo).port;
  } catch (error) {
    if (preferred && errorCode(error) === 'EADDRINUSE') return freePort();
    throw error;
  } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
}

/** Called before importing any Buddi package: path constants are evaluated on import. */
export async function environment(root: string, env: NodeJS.ProcessEnv = process.env): Promise<InstallContext> {
  const data = defaultDataDir(process.platform, env);
  env.BUDDI_INSTALL_ROOT = root;
  env.BUDDI_DATA_DIR = data;
  env.BUDDI_ENV_FILE = path.join(data, '.env');
  env.BUDDI_AGENTS_DIR = path.join(data, 'agents');
  env.BUDDI_SKILLS_DIR = path.join(data, 'skills');
  env.BUDDI_HOME = data;
  env.BUDDI_WEB_ASSETS = path.join(root, 'packages/web/dist');
  env.BUDDI_WEB_REQUIRE_AUTH = '1';
  const browsers = browsersPath(data, { env });
  if (browsers !== undefined) env.PLAYWRIGHT_BROWSERS_PATH = browsers;
  const { parse, populate } = (await import('dotenv')).default;
  const settings = await readPrivateFile(env.BUDDI_ENV_FILE);
  if (settings !== undefined) populate(env as Record<string, string>, parse(settings));
  // A separate keychain namespace prevents a test or second install sharing credentials.
  env.BUDDI_VAULT_SERVICE = vaultServiceFor(data);
  env.BUDDI_VAULT_FILE = path.join(data, 'vault.json');
  if ((env.BUDDI_VAULT || (process.platform === 'darwin' ? 'keychain' : 'file')) === 'file') {
    const keyFile = path.join(data, 'vault-key');
    const key = await readPrivateFile(keyFile);
    if (key !== undefined) env.BUDDI_VAULT_KEY = key.trim();
  }
  const stateFile = path.join(data, 'installation.json');
  let state: InstallationState | undefined;
  if (existsSync(stateFile)) {
    state = JSON.parse(await readFile(stateFile, 'utf8')) as InstallationState;
    // An installation written before the control socket still carries a
    // `controlPort`. It is ignored, not an error.
    if (state.version !== 1 || !['managed', 'external'].includes(state.database) ||
        ![state.webPort, state.dbPort].every(p => Number.isInteger(p) && p > 0 && p <= 65535)) {
      throw new Error('Invalid installation.json; preserve the data directory and restore its configuration.');
    }
    env.BUDDI_WEB_PORT = String(state.webPort);
    env.BUDDI_DB_PORT = String(state.dbPort);
  }
  // The packaged foundation never expands the network bind through ambient settings.
  env.BUDDI_WEB_HOST = '127.0.0.1';
  delete env.BUDDI_WEB_PUBLIC_ORIGIN;
  return { root, data, env, state };
}

/** The supervisor holds this lock throughout its lifetime, including initialization. */
export async function acquireLock(data: string): Promise<() => Promise<void>> {
  await mkdir(data, { recursive: true, mode: 0o700 });
  const file = path.join(data, 'supervisor.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = await open(file, 'wx', 0o600);
      await fd.writeFile(String(process.pid));
      await fd.close();
      return async () => {
        if ((await readFile(file, 'utf8').catch(() => '')) === String(process.pid)) {
          await unlink(file);
        }
      };
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error;
      // Serialize stale-lock recovery too. Otherwise two starters could move
      // each other's newly acquired lock after both observed the old pid.
      let recovery: FileHandle;
      try { recovery = await open(`${file}.recovery`, 'wx', 0o600); }
      catch { throw new Error('Supervisor lock recovery is in progress. If interrupted, inspect supervisor.lock.recovery before retrying.'); }
      try {
        const pid = Number(await readFile(file, 'utf8').catch(() => ''));
        let stale = false;
        if (Number.isInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); } catch (e) { stale = errorCode(e) === 'ESRCH'; }
        } else if (existsSync(file)) {
          stale = Date.now() - (await stat(file)).mtimeMs > 30_000;
        }
        if (existsSync(file)) {
          if (!stale) throw new Error('This installation already has a supervisor (or startup is in progress).');
          await rename(file, `${file}.stale-${Date.now()}-${process.pid}`);
        }
      } finally { await recovery.close(); await unlink(`${file}.recovery`); }
    }
  }
  throw new Error('Could not acquire the installation lock.');
}

function identity(data: string): Pick<InstallationState, 'kind' | 'dataDir' | 'vaultService'> {
  return { kind: 'packaged', dataDir: path.resolve(data), vaultService: vaultServiceFor(path.resolve(data)) };
}

export async function initialize(ctx: InstallContext): Promise<void> {
  // `incoming` is where the dashboard writes an uploaded archive, and the one
  // directory the control socket accepts a path inside.
  for (const name of ['logs', 'agents', 'skills', 'artifacts', 'backups', 'incoming']) {
    await mkdir(path.join(ctx.data, name), { recursive: true, mode: 0o700 });
  }
  const envFile = ctx.env.BUDDI_ENV_FILE ?? path.join(ctx.data, '.env');
  if (!existsSync(envFile)) await writeFile(envFile, '# Buddi settings. Credentials belong in the vault.\n', { flag: 'wx', mode: 0o600 });
  if ((ctx.env.BUDDI_VAULT || (process.platform === 'darwin' ? 'keychain' : 'file')) === 'file' && !ctx.env.BUDDI_VAULT_KEY) {
    const key = randomBytes(32).toString('base64url');
    await writeFile(path.join(ctx.data, 'vault-key'), key, { flag: 'wx', mode: 0o600 });
    ctx.env.BUDDI_VAULT_KEY = key;
  }
  if (!ctx.state) {
    const webPort = await freePort(Number(ctx.env.BUDDI_WEB_PORT) || 4317);
    let dbPort = await freePort();
    while (dbPort === webPort) dbPort = await freePort();
    ctx.state = { version: 1, database: ctx.env.DATABASE_URL ? 'external' : 'managed', webPort, dbPort, phase: 'provisioning', ...identity(ctx.data) };
    await atomicJson(path.join(ctx.data, 'installation.json'), ctx.state);
  } else {
    // A recorded port another program took since: moved, and said (portMovedLines).
    const movedState = await movePortsIfTaken(ctx.state, {
      free: portFree,
      pick: () => freePort(),
      ownClusterPort: () => {
        const pid = (() => { try { return readFileSync(path.join(ctx.data, 'postgres', 'postmaster.pid'), 'utf8'); } catch { return ''; } })();
        const port = Number(pid.split('\n')[3]);
        return Number.isInteger(port) && port > 0 ? port : undefined;
      },
      sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
      now: () => new Date(),
    });
    if (movedState) {
      ctx.state = movedState;
      await atomicJson(path.join(ctx.data, 'installation.json'), ctx.state);
      for (const line of portMovedLines(movedState.portMoved)) console.error(`supervisor: ${line}`);
    }
  }
  if (ctx.state.kind === undefined || ctx.state.dataDir === undefined || ctx.state.vaultService === undefined) {
    // An installation provisioned before the file said who it is: said now, once.
    ctx.state = { ...ctx.state, ...identity(ctx.data) };
    await atomicJson(path.join(ctx.data, 'installation.json'), ctx.state);
  }
  ctx.env.BUDDI_WEB_PORT = String(ctx.state.webPort);
  ctx.env.BUDDI_DB_PORT = String(ctx.state.dbPort);
}
