/**
 * Cloudflare's connector, run by the supervisor (slate R73vdX4bOO).
 *
 * When Cloudflare Access is on and "Set it up for me" made a tunnel, the
 * supervisor runs `cloudflared tunnel --no-autoupdate run` as a managed child,
 * user-level, like Postgres: restarted with backoff, stopped with buddi. The
 * tunnel's connector token is read from the owner secret store at each spawn
 * and handed to the child in `TUNNEL_TOKEN` — never in argv, where `ps` shows
 * it, and never in a log line.
 *
 * The binary: `cloudflared` on PATH (and Homebrew's prefixes, which a launchd
 * PATH leaves out), else the one buddi downloaded into `<data>/bin/`, else
 * the official release for this platform from GitHub, checked against the
 * SHA-256 Cloudflare publishes with the release before anything runs.
 *
 * A system service installed by `sudo cloudflared service install` (an
 * earlier setup's) is detected and never fought: two connectors for one
 * tunnel take turns dropping each other's connections. The status says
 * `system-daemon`, and buddi starts nothing until it is uninstalled or the
 * owner chose to use it instead.
 *
 * Nothing here imports a `@buddi/*` value: the supervisor hands in what it
 * reads from the database (see the note at the top of supervisor.ts).
 */
import { spawn as nodeSpawn, execFile } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { stopChild } from './environment.js';

/** The gateway's backoff: 2 s doubling to 30 s. */
export function connectorRestartDelay(failures: number): number { return Math.min(30_000, 2000 * 2 ** Math.min(failures, 4)); }

export type ConnectorState = 'running' | 'starting' | 'stopped' | 'missing-binary' | 'system-daemon';

/** What `GET /connector` answers, and what the setup step shows. */
export interface ConnectorStatus {
  state: ConnectorState;
  /** buddi runs its own, or the owner chose the system service. */
  mode: 'buddi' | 'system';
  /** The system service's file, when one is installed. */
  systemDaemon: string | null;
  /** The cloudflared buddi runs, and where it came from. */
  binary: { path: string; source: 'path' | 'downloaded' } | null;
  /** One sentence: why it is missing, stopped or retrying. */
  detail?: string | undefined;
  /** The Homebrew line, on a Mac with brew, when the binary is missing. */
  brew?: string | undefined;
  pid: number | null;
  /** Where cloudflared's own lines go. */
  log: string;
}

/** What the database says the connector should be. */
export interface ConnectorPlan {
  wanted: boolean;
  mode: 'buddi' | 'system';
  /** The tunnel the token belongs to: a change restarts the child. */
  tunnelId: string | null;
}

/** The line cloudflared prints once an edge connection is up. */
export const REGISTERED_LINE = /Registered tunnel connection/;

/** The system service `sudo cloudflared service install` leaves behind. */
export function systemDaemonFiles(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') return ['/Library/LaunchDaemons/com.cloudflare.cloudflared.plist'];
  if (platform === 'linux') return ['/etc/systemd/system/cloudflared.service', '/etc/init.d/cloudflared'];
  return [];
}

export function findSystemDaemon(platform: NodeJS.Platform, exists: (file: string) => boolean = existsSync): string | null {
  return systemDaemonFiles(platform).find(file => exists(file)) ?? null;
}

/** The line that removes it, said beside the reason. */
export const SYSTEM_DAEMON_UNINSTALL = 'sudo cloudflared service uninstall';

/** Where a downloaded cloudflared lives. buddi writes nothing else there. */
export function downloadedBinary(data: string, platform: NodeJS.Platform = process.platform): string {
  return path.join(data, 'bin', platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
}

/** Directories a launchd or systemd PATH leaves out but cloudflared is usually in. */
function extraDirs(platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') return ['/opt/homebrew/bin', '/usr/local/bin'];
  if (platform === 'linux') return ['/usr/local/bin', '/usr/bin'];
  return [];
}

/** A program on PATH (and the extra prefixes), or null. */
export function findOnPath(name: string, pathEnv: string | undefined, platform: NodeJS.Platform, exists: (file: string) => boolean = existsSync): string | null {
  const dirs = [...(pathEnv ?? '').split(path.delimiter), ...extraDirs(platform)].filter(dir => dir !== '' && path.isAbsolute(dir));
  const file = platform === 'win32' ? `${name}.exe` : name;
  for (const dir of dirs) {
    const candidate = path.join(dir, file);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** The release asset for this platform, or null when Cloudflare publishes none. */
export function releaseAsset(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `cloudflared-darwin-${arch === 'x64' ? 'amd64' : 'arm64'}.tgz`;
  if (platform === 'linux') {
    const name = ({ x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' } as Record<string, string>)[arch];
    return name ? `cloudflared-linux-${name}` : null;
  }
  if (platform === 'win32' && arch === 'x64') return 'cloudflared-windows-amd64.exe';
  return null;
}

/**
 * The checksums in a release's notes: Cloudflare ends every release body with
 * a "SHA256 Checksums" block of `<asset>: <hex>` lines.
 */
export function parseChecksums(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9._-]+):\s*([0-9a-fA-F]{64})\s*$/.exec(line);
    if (match) out.set(match[1] as string, (match[2] as string).toLowerCase());
  }
  return out;
}

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export class VerifyError extends Error {}

/**
 * The bytes checked against the published checksum, and against GitHub's own
 * digest for the asset when it gives one. Throws unless every published value
 * matches; a release without a checksum for the asset is refused, not trusted.
 */
export function verifyAsset(bytes: Uint8Array, asset: string, published: Map<string, string>, githubDigest?: string | null): string {
  const expected = published.get(asset);
  if (!expected) throw new VerifyError(`Cloudflare’s release lists no checksum for ${asset}, so buddi won’t run it.`);
  const actual = sha256(bytes);
  if (actual !== expected) throw new VerifyError(`The downloaded ${asset} doesn’t match the checksum Cloudflare published, so buddi deleted it.`);
  if (githubDigest) {
    const digest = githubDigest.replace(/^sha256:/i, '').toLowerCase();
    if (digest !== actual) throw new VerifyError(`The downloaded ${asset} doesn’t match GitHub’s digest for it, so buddi deleted it.`);
  }
  return actual;
}

export const RELEASE_URL = 'https://api.github.com/repos/cloudflare/cloudflared/releases/latest';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Download, verify and install cloudflared into `<data>/bin/`, mode 0700.
 * Returns the path. Nothing touches the final path before the bytes check.
 */
export async function downloadCloudflared(options: {
  data: string; platform: NodeJS.Platform; arch: string; fetch?: Fetch;
  /** Unpack a .tgz into a directory (tests pass their own). */
  untar?: (archive: string, into: string) => Promise<void>;
}): Promise<{ path: string; version: string; sha256: string }> {
  const { data, platform, arch } = options;
  const request = options.fetch ?? fetch;
  const asset = releaseAsset(platform, arch);
  if (!asset) throw new VerifyError(`Cloudflare publishes no cloudflared for ${platform} on ${arch}.`);
  const headers = { 'User-Agent': 'buddi', Accept: 'application/vnd.github+json' };
  const meta = await request(RELEASE_URL, { headers, signal: AbortSignal.timeout(20_000) });
  if (!meta.ok) throw new VerifyError(`GitHub answered ${meta.status} for cloudflared’s latest release.`);
  const release = await meta.json() as { tag_name?: string; body?: string; assets?: Array<{ name?: string; browser_download_url?: string; digest?: string | null }> };
  const entry = (release.assets ?? []).find(a => a.name === asset);
  const url = entry?.browser_download_url ?? '';
  if (!entry || !/^https:\/\/github\.com\/cloudflare\/cloudflared\/releases\/download\//.test(url)) {
    throw new VerifyError(`cloudflared’s latest release has no ${asset}.`);
  }
  const published = parseChecksums(release.body ?? '');
  const response = await request(url, { headers: { 'User-Agent': 'buddi' }, signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new VerifyError(`GitHub answered ${response.status} for ${asset}.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = verifyAsset(bytes, asset, published, entry.digest ?? null);

  const bin = path.dirname(downloadedBinary(data, platform));
  await mkdir(bin, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(bin, '.download-'));
  try {
    let unpacked: string;
    if (asset.endsWith('.tgz')) {
      const archive = path.join(staging, asset);
      await writeFile(archive, bytes, { mode: 0o600 });
      await (options.untar ?? untar)(archive, staging);
      unpacked = path.join(staging, 'cloudflared');
      if (!existsSync(unpacked)) throw new VerifyError(`${asset} held no cloudflared.`);
    } else {
      unpacked = path.join(staging, 'cloudflared');
      await writeFile(unpacked, bytes, { mode: 0o700 });
    }
    await chmod(unpacked, 0o700);
    const target = downloadedBinary(data, platform);
    await rename(unpacked, target);
    const version = typeof release.tag_name === 'string' ? release.tag_name : '';
    await writeFile(path.join(bin, 'cloudflared.json'), `${JSON.stringify({ version, asset, sha256: digest, at: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    return { path: target, version, sha256: digest };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

function untar(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xzf', archive, '-C', into, 'cloudflared'], { timeout: 60_000 }, error => (error ? reject(new VerifyError(`${path.basename(archive)} could not be unpacked.`)) : resolve()));
  });
}

/** Remove what buddi downloaded. Only `<data>/bin/cloudflared` and its note: buddi wrote nothing else. */
export async function removeDownloaded(data: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  const file = downloadedBinary(data, platform);
  const had = existsSync(file);
  await rm(file, { force: true });
  await rm(path.join(path.dirname(file), 'cloudflared.json'), { force: true });
  return had;
}

/** The environment the child gets: enough to run, nothing of buddi's. */
export function connectorEnv(env: NodeJS.ProcessEnv, token: string): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'USERPROFILE', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];
  const out: NodeJS.ProcessEnv = {};
  for (const key of keep) if (typeof env[key] === 'string') out[key] = env[key];
  out.TUNNEL_TOKEN = token;
  return out;
}

/** How long a failed download is not tried again: the setup polls every few seconds. */
export const DOWNLOAD_RETRY_MS = 10 * 60_000;

export interface ConnectorDeps {
  data: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  /** What the database says, read at every sync. */
  plan: () => Promise<ConnectorPlan>;
  /** The connector token, from the owner secret store, read at spawn only. */
  token: () => Promise<string | null>;
  exists?: (file: string) => boolean;
  download?: () => Promise<{ path: string }>;
  spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
  log?: (line: string) => void;
  now?: () => number;
  restartDelay?: (failures: number) => number;
}

export interface Connector {
  /** Read the plan and make the child match it. Serialized; never throws. */
  sync(): Promise<ConnectorStatus>;
  status(): ConnectorStatus;
  /** Stop the child and delete the binary when buddi downloaded it. */
  remove(): Promise<ConnectorStatus & { removedBinary: boolean }>;
  /** Stop for good: the supervisor is leaving. */
  close(): Promise<void>;
}

export function createConnector(deps: ConnectorDeps): Connector {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? process.arch;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const say = deps.log ?? ((line: string) => console.error(line));
  const now = deps.now ?? Date.now;
  const delay = deps.restartDelay ?? connectorRestartDelay;
  const spawn = deps.spawn ?? nodeSpawn;
  const logFile = path.join(deps.data, 'logs', 'cloudflared.log');
  const download = deps.download ?? (() => downloadCloudflared({ data: deps.data, platform, arch }));

  let child: ChildProcess | undefined;
  let state: ConnectorState = 'stopped';
  let mode: 'buddi' | 'system' = 'buddi';
  let detail: string | undefined;
  let brew: string | undefined;
  let binary: ConnectorStatus['binary'] = null;
  let desired = false, closed = false;
  let tunnelId: string | null = null;
  let failures = 0, retry: NodeJS.Timeout | undefined, retryPending = false;
  let downloadFailedAt = 0, downloadError: string | undefined;
  let log: WriteStream | undefined;
  let chain: Promise<unknown> = Promise.resolve();

  const alive = (): boolean => !!child && child.exitCode === null && child.signalCode === null;
  const status = (): ConnectorStatus => ({
    state, mode, systemDaemon: findSystemDaemon(platform, exists), binary,
    ...(detail === undefined ? {} : { detail }), ...(brew === undefined ? {} : { brew }),
    pid: alive() ? child!.pid ?? null : null, log: logFile,
  });
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = chain.catch(() => {}).then(work);
    chain = run;
    return run;
  };

  async function stop(): Promise<void> {
    desired = false;
    clearTimeout(retry);
    retryPending = false;
    if (alive()) say(`supervisor: stopping cloudflared (pid ${child!.pid}).`);
    await stopChild(child, 'SIGTERM', 10_000);
    child = undefined;
  }

  async function resolveBinary(): Promise<ConnectorStatus['binary']> {
    const onPath = findOnPath('cloudflared', env.PATH, platform, exists);
    if (onPath) return { path: onPath, source: 'path' };
    const mine = downloadedBinary(deps.data, platform);
    if (exists(mine)) return { path: mine, source: 'downloaded' };
    if (downloadFailedAt && now() - downloadFailedAt < DOWNLOAD_RETRY_MS) return null;
    state = 'starting';
    detail = 'Downloading cloudflared from Cloudflare’s releases on GitHub.';
    say('supervisor: downloading cloudflared from github.com/cloudflare/cloudflared.');
    try {
      const got = await download();
      downloadFailedAt = 0; downloadError = undefined;
      say(`supervisor: cloudflared downloaded and verified (${got.path}).`);
      return { path: got.path, source: 'downloaded' };
    } catch (error) {
      downloadFailedAt = now();
      downloadError = error instanceof VerifyError ? error.message : 'cloudflared could not be downloaded from GitHub.';
      say(`supervisor: ${downloadError}`);
      return null;
    }
  }

  function start(bin: string, token: string): void {
    if (closed || !desired || alive()) return;
    if (!log) {
      try {
        mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
        // Created 0700 like every directory buddi makes in its data dir.
        log = createWriteStream(logFile, { flags: 'a', mode: 0o600 });
        log.on('error', () => { log = undefined; });
      } catch { log = undefined; }
    }
    const started = now();
    state = 'starting';
    detail = undefined;
    const proc = spawn(bin, ['tunnel', '--no-autoupdate', 'run'], { env: connectorEnv(env, token), stdio: ['ignore', 'pipe', 'pipe'] });
    child = proc;
    say(`supervisor: cloudflared started (pid ${proc.pid}).`);
    const watch = (chunk: Buffer): void => {
      log?.write(chunk);
      if (child === proc && state !== 'running' && REGISTERED_LINE.test(chunk.toString('utf8'))) {
        state = 'running';
        say('supervisor: cloudflared connected to Cloudflare.');
      }
    };
    proc.stdout?.on('data', watch);
    proc.stderr?.on('data', watch);
    proc.once('error', () => {
      if (child !== proc) return;
      detail = 'cloudflared could not be started.';
    });
    proc.once('close', (code, signal) => {
      if (child !== proc) return;
      child = undefined;
      if (now() - started >= 60_000) failures = 0;
      if (!desired || closed) { state = 'stopped'; return; }
      const wait = delay(failures++);
      state = 'starting';
      detail = `cloudflared stopped (${signal ?? `exit ${code}`}); starting it again in ${Math.round(wait / 1000)} s. Its lines are in logs/cloudflared.log.`;
      say(`supervisor: cloudflared exited (${signal ?? `code ${code}`}); restarting in ${wait} ms.`);
      clearTimeout(retry);
      retryPending = true;
      retry = setTimeout(() => { retryPending = false; void serial(() => spawnWithToken(bin)); }, wait);
      retry.unref?.();
    });
  }

  async function spawnWithToken(bin: string): Promise<void> {
    if (closed || !desired || alive()) return;
    let token: string | null = null;
    try { token = await deps.token(); } catch { token = null; }
    if (!token) {
      state = 'stopped';
      detail = 'buddi has no connector token for the tunnel. Set it up again.';
      return;
    }
    start(bin, token);
  }

  async function reconcile(): Promise<ConnectorStatus> {
    if (closed) return status();
    let plan: ConnectorPlan;
    try { plan = await deps.plan(); }
    catch { detail = 'buddi could not read its Cloudflare setting.'; return status(); }
    mode = plan.mode;
    brew = undefined;
    if (!plan.wanted) {
      await stop();
      state = 'stopped'; detail = undefined; tunnelId = null;
      return status();
    }
    const daemon = findSystemDaemon(platform, exists);
    if (plan.mode === 'system' || daemon) {
      await stop();
      state = 'system-daemon';
      detail = plan.mode === 'system'
        ? (daemon ? 'Cloudflare’s system service runs the connector; buddi starts none of its own.' : 'You chose Cloudflare’s system service, but none is installed.')
        : 'Cloudflare’s system service is installed. Two connectors for one tunnel fight, so buddi starts none of its own.';
      return status();
    }
    if (alive() && tunnelId === plan.tunnelId) return status();
    if (retryPending && tunnelId === plan.tunnelId) { desired = true; return status(); }
    if (alive() || retryPending) await stop();
    desired = true;
    tunnelId = plan.tunnelId;
    binary = await resolveBinary();
    if (!binary) {
      state = 'missing-binary';
      detail = downloadError ?? 'cloudflared isn’t on this computer.';
      if (platform === 'darwin' && findOnPath('brew', env.PATH, platform, exists)) brew = 'brew install cloudflared';
      return status();
    }
    failures = 0;
    await spawnWithToken(binary.path);
    return status();
  }

  return {
    sync: () => serial(reconcile),
    status,
    remove: () => serial(async () => {
      await stop();
      state = 'stopped'; detail = undefined; tunnelId = null;
      const removedBinary = await removeDownloaded(deps.data, platform);
      if (binary?.source === 'downloaded') binary = null;
      downloadFailedAt = 0; downloadError = undefined;
      return { ...status(), removedBinary };
    }),
    close: () => serial(async () => {
      closed = true;
      await stop();
      state = 'stopped';
      log?.end();
      log = undefined;
    }),
  };
}
