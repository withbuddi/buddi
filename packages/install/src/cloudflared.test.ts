/**
 * The connector the supervisor runs: its lifecycle with a fake cloudflared (a
 * script that prints the "Registered tunnel connection" line and sleeps), the
 * status it goes through, the system service it never fights, the binary it
 * finds or downloads, and the verifier that stands between a download and a
 * run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  connectorReadRetryDelay,
  connectorEnv,
  createConnector,
  downloadCloudflared,
  downloadedBinary,
  findOnPath,
  findSystemDaemon,
  parseChecksums,
  releaseAsset,
  removeDownloaded,
  sha256,
  verifyAsset,
  VerifyError,
  type Connector,
  type ConnectorPlan,
  type ConnectorStatus,
} from './cloudflared.js';
import { controlSocket, listenOnSocket, supervisorSocket, type SupervisorStatus } from './supervisor.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = 'eyJhIjoiYWNjb3VudCIsInQiOiJ0dW5uZWwiLCJzIjoic2VjcmV0In0=';
const PLIST = '/Library/LaunchDaemons/com.cloudflare.cloudflared.plist';

const connectors: Connector[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(connectors.splice(0).map(c => c.close()));
  await Promise.all(servers.splice(0).map(s => new Promise(resolve => s.close(resolve))));
});

/** A fake cloudflared: checks its argv and env, notes them, says it registered, sleeps. */
async function fakeCloudflared(dir: string, { register = true } = {}): Promise<string> {
  const file = path.join(dir, 'cloudflared');
  await writeFile(file, [
    '#!/bin/sh',
    '[ "$*" = "tunnel --no-autoupdate run" ] || { echo "bad argv: $*" >&2; exit 9; }',
    '[ -n "$TUNNEL_TOKEN" ] || { echo "no token" >&2; exit 8; }',
    `printf '%s|%s|%s' "$#" "$TUNNEL_TOKEN" "\${DATABASE_URL:-none}" > "${path.join(dir, 'seen')}"`,
    'echo "INF Starting tunnel"',
    register ? 'echo "2026-10-05T00:00:00Z INF Registered tunnel connection connIndex=0 location=ams01 protocol=quic" >&2' : '',
    'exec /bin/sleep 30',
    '',
  ].join('\n'));
  await chmod(file, 0o755);
  return file;
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function setup(options: { token?: () => Promise<string | null>; plan?: ConnectorPlan; exists?: (file: string) => boolean; register?: boolean; platform?: NodeJS.Platform; download?: () => Promise<{ path: string }>; pathEnv?: string } = {}) {
  const data = await mkdtemp(path.join(tmpdir(), 'buddi-connector-'));
  const bin = path.join(data, 'pathbin');
  await mkdir(bin);
  const binary = await fakeCloudflared(bin, { register: options.register ?? true });
  let plan: ConnectorPlan = options.plan ?? { wanted: true, mode: 'buddi', tunnelId: 'tunnel-1' };
  const tokenReads = vi.fn(options.token ?? (async (): Promise<string | null> => TOKEN));
  const lines: string[] = [];
  const connector = createConnector({
    data, platform: options.platform ?? 'linux', arch: 'x64',
    env: { PATH: options.pathEnv ?? bin, HOME: data, DATABASE_URL: 'postgres://secret@localhost/buddi' },
    plan: async () => plan,
    token: tokenReads,
    exists: options.exists ?? (file => file.startsWith(data) && existsSync(file)),
    download: options.download ?? (async () => { throw new VerifyError('no network in tests'); }),
    log: line => lines.push(line),
    restartDelay: () => 30,
  });
  connectors.push(connector);
  return { data, bin, binary, connector, tokenReads, lines, setPlan: (next: ConnectorPlan) => { plan = next; } };
}

describe('the connector the supervisor runs', () => {
  test('starts cloudflared with the token in its environment, never in argv, and is running once it registers', async () => {
    const w = await setup();
    const first = await w.connector.sync();
    expect(['starting', 'running']).toContain(first.state);
    expect(first.binary).toEqual({ path: w.binary, source: 'path' });
    await until(() => w.connector.status().state === 'running');
    expect(w.connector.status().pid).toEqual(expect.any(Number));
    // argv held three words; the token came through TUNNEL_TOKEN; nothing of buddi's environment came along.
    expect(await readFile(path.join(w.bin, 'seen'), 'utf8')).toBe(`3|${TOKEN}|none`);
    const log = await readFile(path.join(w.data, 'logs', 'cloudflared.log'), 'utf8');
    expect(log).toContain('Registered tunnel connection');
    expect(w.lines.join('\n')).not.toContain(TOKEN);
    expect(w.tokenReads).toHaveBeenCalledTimes(1);
    // A second sync leaves the running child alone.
    const pid = w.connector.status().pid;
    expect((await w.connector.sync()).pid).toBe(pid);
    expect(w.tokenReads).toHaveBeenCalledTimes(1);
  });

  test('restarts with backoff after it dies, reading the token again, and stops when the setting says so', async () => {
    const w = await setup();
    await w.connector.sync();
    await until(() => w.connector.status().state === 'running');
    const pid = w.connector.status().pid!;
    process.kill(pid, 'SIGKILL');
    await until(() => w.connector.status().state === 'starting');
    expect(w.connector.status().detail).toContain('starting it again');
    await until(() => w.connector.status().state === 'running' && w.connector.status().pid !== pid);
    expect(w.tokenReads).toHaveBeenCalledTimes(2);

    const second = w.connector.status().pid!;
    w.setPlan({ wanted: false, mode: 'buddi', tunnelId: null });
    const stopped = await w.connector.sync();
    expect(stopped).toMatchObject({ state: 'stopped', pid: null });
    expect(() => process.kill(second, 0)).toThrow();
  });

  test('a new tunnel restarts the child', async () => {
    const w = await setup();
    await w.connector.sync();
    await until(() => w.connector.status().state === 'running');
    const pid = w.connector.status().pid;
    w.setPlan({ wanted: true, mode: 'buddi', tunnelId: 'tunnel-2' });
    await w.connector.sync();
    await until(() => w.connector.status().state === 'running');
    expect(w.connector.status().pid).not.toBe(pid);
  });

  test('stays starting until cloudflared registers a connection', async () => {
    const w = await setup({ register: false });
    await w.connector.sync();
    await until(() => existsSync(path.join(w.bin, 'seen')));
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(w.connector.status().state).toBe('starting');
  });

  test('close stops the child for good', async () => {
    const w = await setup();
    await w.connector.sync();
    await until(() => w.connector.status().state === 'running');
    const pid = w.connector.status().pid!;
    await w.connector.close();
    expect(() => process.kill(pid, 0)).toThrow();
    expect((await w.connector.sync()).state).toBe('stopped');
  });
});

describe('Cloudflare’s system service', () => {
  test('is found where `cloudflared service install` puts it', () => {
    expect(findSystemDaemon('darwin', file => file === PLIST)).toBe(PLIST);
    expect(findSystemDaemon('linux', file => file === '/etc/systemd/system/cloudflared.service')).toBe('/etc/systemd/system/cloudflared.service');
    expect(findSystemDaemon('darwin', () => false)).toBeNull();
  });

  test('is never fought: with one installed buddi starts nothing and says why', async () => {
    let data = '';
    const w = await setup({ platform: 'darwin', exists: file => file === PLIST || (data !== '' && file.startsWith(data) && existsSync(file)) });
    data = w.data;
    const status = await w.connector.sync();
    expect(status).toMatchObject({ state: 'system-daemon', mode: 'buddi', systemDaemon: PLIST, pid: null });
    expect(status.detail).toContain('Two connectors for one tunnel fight');
    expect(w.tokenReads).not.toHaveBeenCalled();
  });

  test('stops buddi’s own when one appears, and starts it again once it is gone', async () => {
    let daemon = false;
    let data = '';
    const w = await setup({ platform: 'darwin', exists: file => (daemon && file === PLIST) || (data !== '' && file.startsWith(data) && existsSync(file)) });
    data = w.data;
    await w.connector.sync();
    await until(() => w.connector.status().state === 'running');
    daemon = true;
    expect((await w.connector.sync()).state).toBe('system-daemon');
    daemon = false;
    await w.connector.sync();
    await until(() => w.connector.status().state === 'running');
  });

  test('is used when the owner chose it: buddi starts none', async () => {
    const w = await setup({ plan: { wanted: true, mode: 'system', tunnelId: 'tunnel-1' } });
    const status = await w.connector.sync();
    expect(status).toMatchObject({ state: 'system-daemon', mode: 'system', pid: null });
    expect(w.tokenReads).not.toHaveBeenCalled();
  });
});

describe('a read that fails', () => {
  afterEach(() => { vi.useRealTimers(); });

  test('waits 30 s, doubling to 10 min', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(connectorReadRetryDelay)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
  });

  test('retries a setting it could not read on that schedule, and stops once it reads', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const plan = vi.fn<() => Promise<ConnectorPlan>>()
      .mockRejectedValueOnce(new Error('database down'))
      .mockRejectedValueOnce(new Error('database down'))
      .mockResolvedValue({ wanted: false, mode: 'buddi', tunnelId: null });
    const data = await mkdtemp(path.join(tmpdir(), 'buddi-connector-'));
    const connector = createConnector({ data, platform: 'linux', env: { PATH: '/nowhere' }, plan, token: async () => TOKEN, log: () => undefined });
    connectors.push(connector);

    expect(await connector.sync()).toMatchObject({ state: 'starting', detail: expect.stringContaining('trying again in 30 s') });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(plan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(plan).toHaveBeenCalledTimes(2);
    expect(connector.status().detail).toContain('trying again in 1 min');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(plan).toHaveBeenCalledTimes(3);
    expect(connector.status()).toMatchObject({ state: 'stopped' });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(plan).toHaveBeenCalledTimes(3);
  });

  test('retries a token read that threw, but a vault with no token is stopped and left alone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const token = vi.fn<() => Promise<string | null>>()
      .mockRejectedValueOnce(new Error('keychain locked'))
      .mockResolvedValue(null);
    const w = await setup({ token });
    expect(await w.connector.sync()).toMatchObject({ state: 'starting', detail: expect.stringContaining('connector token; trying again in 30 s') });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(token).toHaveBeenCalledTimes(2);
    expect(w.connector.status()).toMatchObject({ state: 'stopped', pid: null, detail: expect.stringContaining('no connector token') });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(token).toHaveBeenCalledTimes(2);
  });
});

describe('the cloudflared binary', () => {
  test('is found on PATH, and in Homebrew’s prefixes a launchd PATH leaves out', () => {
    expect(findOnPath('cloudflared', '/usr/bin:/bin', 'darwin', file => file === '/opt/homebrew/bin/cloudflared')).toBe('/opt/homebrew/bin/cloudflared');
    expect(findOnPath('cloudflared', '/x/bin', 'linux', file => file === '/x/bin/cloudflared')).toBe('/x/bin/cloudflared');
    expect(findOnPath('cloudflared', 'relative/bin', 'linux', file => file === 'relative/bin/cloudflared')).toBeNull();
  });

  test('is missing-binary with the reason, and the brew line on a Mac with brew; a failed download is not retried at once', async () => {
    const brewDir = await mkdtemp(path.join(tmpdir(), 'buddi-brew-'));
    await writeFile(path.join(brewDir, 'brew'), '#!/bin/sh\n', { mode: 0o755 });
    const download = vi.fn(async () => { throw new VerifyError('The downloaded cloudflared-darwin-arm64.tgz doesn’t match the checksum Cloudflare published, so buddi deleted it.'); });
    let data = '';
    const w = await setup({ platform: 'darwin', pathEnv: brewDir, download, exists: file => file === path.join(brewDir, 'brew') || (data !== '' && file.startsWith(data) && existsSync(file)) });
    data = w.data;
    const status = await w.connector.sync();
    expect(status).toMatchObject({ state: 'missing-binary', binary: null, brew: 'brew install cloudflared' });
    expect(status.detail).toContain('doesn’t match the checksum');
    await w.connector.sync();
    expect(download).toHaveBeenCalledTimes(1);
  });

  test('is downloaded into <data>/bin when missing, run from there, and removed by Remove', async () => {
    let data = '';
    const download = vi.fn(async () => {
      const target = downloadedBinary(data, 'linux');
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await readFile(path.join(data, 'pathbin', 'cloudflared')), { mode: 0o700 });
      return { path: target };
    });
    const w = await setup({ pathEnv: '/nowhere', download });
    data = w.data;
    const status = await w.connector.sync();
    expect(status.binary).toEqual({ path: downloadedBinary(data, 'linux'), source: 'downloaded' });
    await until(() => w.connector.status().state === 'running');
    const removed = await w.connector.remove();
    expect(removed).toMatchObject({ state: 'stopped', pid: null, removedBinary: true, binary: null });
    expect(existsSync(downloadedBinary(data, 'linux'))).toBe(false);
  });

  test('Remove never deletes a cloudflared buddi did not download', async () => {
    const w = await setup();
    await w.connector.sync();
    const removed = await w.connector.remove();
    expect(removed.removedBinary).toBe(false);
    expect(existsSync(w.binary)).toBe(true);
    expect(await removeDownloaded(w.data, 'linux')).toBe(false);
  });

  test('the child’s environment carries the token and nothing of buddi’s', () => {
    const env = connectorEnv({ PATH: '/bin', HOME: '/h', DATABASE_URL: 'postgres://x', BUDDI_VAULT_KEY: 'k' }, TOKEN);
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', TUNNEL_TOKEN: TOKEN });
  });
});

describe('the download verifier', () => {
  const FAKE = '#!/bin/sh\necho fake cloudflared\n';

  test('reads the checksums a release publishes', async () => {
    const body = await readFile(path.join(HERE, 'fixtures', 'cloudflared-release-body.md'), 'utf8');
    const sums = parseChecksums(body);
    expect(sums.get('cloudflared-linux-amd64')).toBe(sha256(Buffer.from(FAKE)));
    expect(sums.get('cloudflared-amd64.pkg')).toBe('48d0d3b28b3b5d142490f57316981b65ae46fbbe33408c22b0a4a11b5242de50');
    expect(sums.size).toBe(5);
  });

  test('passes matching bytes and refuses a mismatch, a missing checksum and a wrong GitHub digest', async () => {
    const sums = parseChecksums(await readFile(path.join(HERE, 'fixtures', 'cloudflared-release-body.md'), 'utf8'));
    const bytes = Buffer.from(FAKE);
    expect(verifyAsset(bytes, 'cloudflared-linux-amd64', sums)).toBe(sha256(bytes));
    expect(verifyAsset(bytes, 'cloudflared-linux-amd64', sums, `sha256:${sha256(bytes)}`)).toBe(sha256(bytes));
    expect(() => verifyAsset(bytes, 'cloudflared-linux-arm64', sums)).toThrow('doesn’t match the checksum');
    expect(() => verifyAsset(bytes, 'cloudflared-linux-arm', sums)).toThrow('lists no checksum');
    expect(() => verifyAsset(bytes, 'cloudflared-linux-amd64', sums, 'sha256:00')).toThrow('GitHub’s digest');
  });

  test('names the asset for each platform', () => {
    expect(releaseAsset('darwin', 'arm64')).toBe('cloudflared-darwin-arm64.tgz');
    expect(releaseAsset('darwin', 'x64')).toBe('cloudflared-darwin-amd64.tgz');
    expect(releaseAsset('linux', 'x64')).toBe('cloudflared-linux-amd64');
    expect(releaseAsset('linux', 'arm64')).toBe('cloudflared-linux-arm64');
    expect(releaseAsset('win32', 'x64')).toBe('cloudflared-windows-amd64.exe');
    expect(releaseAsset('freebsd', 'x64')).toBeNull();
  });

  /** GitHub, faked: the release JSON and the asset bytes. */
  function github(body: string, assets: Record<string, Uint8Array>) {
    return vi.fn(async (url: string) => {
      if (url.endsWith('/releases/latest')) {
        return new Response(JSON.stringify({ tag_name: '2026.9.3', body, assets: Object.keys(assets).map(name => ({ name, browser_download_url: `https://github.com/cloudflare/cloudflared/releases/download/2026.9.3/${name}` })) }), { status: 200 });
      }
      const name = url.split('/').pop()!;
      return assets[name] ? new Response(assets[name], { status: 200 }) : new Response('', { status: 404 });
    });
  }

  test('downloads a Linux binary, verified, into <data>/bin with mode 0700', async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'buddi-dl-'));
    const body = await readFile(path.join(HERE, 'fixtures', 'cloudflared-release-body.md'), 'utf8');
    const got = await downloadCloudflared({ data, platform: 'linux', arch: 'x64', fetch: github(body, { 'cloudflared-linux-amd64': Buffer.from(FAKE) }) });
    expect(got).toMatchObject({ path: downloadedBinary(data, 'linux'), version: '2026.9.3', sha256: sha256(Buffer.from(FAKE)) });
    expect(await readFile(got.path, 'utf8')).toBe(FAKE);
    expect(statSync(got.path).mode & 0o777).toBe(0o700);
  });

  test('never leaves an unverified binary behind', async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'buddi-dl-'));
    const body = await readFile(path.join(HERE, 'fixtures', 'cloudflared-release-body.md'), 'utf8');
    await expect(downloadCloudflared({ data, platform: 'linux', arch: 'arm64', fetch: github(body, { 'cloudflared-linux-arm64': Buffer.from(FAKE) }) })).rejects.toThrow(VerifyError);
    expect(existsSync(downloadedBinary(data, 'linux'))).toBe(false);
    await expect(downloadCloudflared({ data, platform: 'linux', arch: 'x64', fetch: github(body, { 'cloudflared-linux-amd64': Buffer.from('tampered') }) })).rejects.toThrow('doesn’t match the checksum');
    expect(existsSync(downloadedBinary(data, 'linux'))).toBe(false);
  });

  test('unpacks a Mac .tgz after checking it', async () => {
    const work = await mkdtemp(path.join(tmpdir(), 'buddi-tgz-'));
    await writeFile(path.join(work, 'cloudflared'), FAKE, { mode: 0o755 });
    const archive = path.join(work, 'cloudflared-darwin-arm64.tgz');
    expect(spawnSync('tar', ['-czf', archive, '-C', work, 'cloudflared']).status).toBe(0);
    const bytes = await readFile(archive);
    const body = `### SHA256 Checksums:\n\`\`\`\ncloudflared-darwin-arm64.tgz: ${sha256(bytes)}\n\`\`\`\n`;
    const data = await mkdtemp(path.join(tmpdir(), 'buddi-dl-'));
    const got = await downloadCloudflared({ data, platform: 'darwin', arch: 'arm64', fetch: github(body, { 'cloudflared-darwin-arm64.tgz': bytes }) });
    expect(await readFile(got.path, 'utf8')).toBe(FAKE);
    expect(statSync(got.path).mode & 0o777).toBe(0o700);
    await rm(work, { recursive: true, force: true });
  });
});

describe('the control socket’s /connector', () => {
  const STATUS: SupervisorStatus = { phase: 'ready', supervisorPid: 1, installRoot: '/i', nodePath: '/n', database: 'running', databasePid: 2, gateway: 'running', gatewayPid: 3 };
  const VIEW: ConnectorStatus = { state: 'running', mode: 'buddi', systemDaemon: null, binary: null, pid: 9, log: '/d/logs/cloudflared.log' };

  function call(socket: string, method: string, body?: unknown): Promise<{ status: number; body: unknown }> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: socket, path: '/connector', method, headers: { host: 'localhost' } }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
      });
      req.once('error', reject);
      req.end(payload);
    });
  }

  test('answers the status, sync and remove, and refuses anything else', async () => {
    const sync = vi.fn(async () => VIEW);
    const remove = vi.fn(async () => ({ ...VIEW, state: 'stopped' as const, pid: null, removedBinary: true }));
    const server = controlSocket({ status: () => STATUS, action: async () => {}, connector: { status: () => VIEW, sync, remove } });
    servers.push(server);
    const socket = supervisorSocket(await mkdtemp(path.join(tmpdir(), 'buddi-sock-')));
    await listenOnSocket(server, socket);
    expect(await call(socket, 'GET')).toEqual({ status: 200, body: VIEW });
    expect((await call(socket, 'POST', { action: 'sync' })).body).toEqual(VIEW);
    expect((await call(socket, 'POST', { action: 'remove' })).body).toMatchObject({ state: 'stopped', removedBinary: true });
    expect((await call(socket, 'POST', { action: 'start', token: TOKEN })).status).toBe(400);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test('is absent without a connector', async () => {
    const server = controlSocket({ status: () => STATUS, action: async () => {} });
    servers.push(server);
    const socket = supervisorSocket(await mkdtemp(path.join(tmpdir(), 'buddi-sock-')));
    await listenOnSocket(server, socket);
    expect((await call(socket, 'GET')).status).toBe(404);
  });
});
