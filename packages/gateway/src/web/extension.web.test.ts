import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type AgentCatalog, type ToolContext } from '@buddi/core';
import { BrowserService, type BrowserController, type BrowserDriver } from '@buddi/tool-browser';
import WebSocket from 'ws';
import { ExtensionEndpoint } from './extension.js';
import { startWebServer, type WebServer } from './server.js';

const TOKEN = 'fixture-extension-dashboard-token';
/** A plausible unpacked extension ID: thirty-two letters, a to p. */
const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;

const servers: WebServer[] = [];
const dirs: string[] = [];
const sockets: WebSocket[] = [];
const browsers: BrowserController[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(browsers.splice(0).map((b) => b.shutdown()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(options: { pingMs?: number; commandTimeoutMs?: number } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'buddi-extension-'));
  dirs.push(dir);
  const env = { BUDDI_DATA_DIR: dir, BUDDI_EXTENSION_DIR: path.join(dir, 'extension') };
  const extension = new ExtensionEndpoint({ env, ...options });
  const driver: BrowserDriver = { start: vi.fn(), perform: vi.fn(), observe: vi.fn(), screenshot: vi.fn(), close: vi.fn() };
  const browser = new BrowserService(driver); browsers.push(browser); await browser.enable();
  const app = await startWebServer({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
    registry: new ToolRegistry(), catalog: {} as AgentCatalog, ctx: { ownerId: 'owner' } as ToolContext,
    timezone: 'UTC', now: () => new Date(), config: { enabled: true, host: '127.0.0.1', port: 0 },
    openAccess: true, token: TOKEN, env, extension, browser });
  servers.push(app);
  return { app, dir, env, extension, origin: `http://127.0.0.1:${app.port}`, socketUrl: `ws://127.0.0.1:${app.port}/api/extension/socket` };
}

async function session(origin: string) {
  const res = await fetch(`${origin}/api/session`, { redirect: 'manual' });
  const pairs = res.headers.getSetCookie().map((line) => line.split(';')[0]!);
  const csrf = pairs.find((p) => p.startsWith('buddi_csrf='))?.slice('buddi_csrf='.length) ?? '';
  return { Cookie: pairs.join('; '), 'X-Buddi-CSRF': csrf, Origin: origin, 'Content-Type': 'application/json' };
}

/** A fake extension: the frames it received, and the ones it sends back. */
function connect(url: string, headers: Record<string, string> = { Origin: ORIGIN }) {
  const socket = new WebSocket(url, { headers });
  sockets.push(socket);
  const seen: Array<Record<string, unknown>> = [];
  socket.on('message', (data) => seen.push(JSON.parse(String(data)) as Record<string, unknown>));
  const open = new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
  const next = async (type: string): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 400; i++) {
      const frame = seen.find((f) => f.type === type);
      if (frame) return frame;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no ${type} frame arrived; saw ${JSON.stringify(seen)}`);
  };
  return { socket, seen, open, next, send: (frame: unknown) => socket.send(JSON.stringify(frame)) };
}

describe('the browser extension endpoint', () => {
  it('asks for a code, pairs through the route, and stores only a hash', async () => {
    const { dir, socketUrl, origin, extension } = await setup();
    const headers = await session(origin);
    expect(await (await fetch(`${origin}/api/extension`, { headers })).json())
      .toMatchObject({ connected: false, pending: false, path: path.join(dir, 'extension') });

    const client = connect(socketUrl);
    await client.open;
    client.send({ type: 'hello', extension: '0.1.0', token: null });
    const pair = await client.next('pair');
    expect(String(pair.code)).toMatch(/^\d{3} \d{3}$/);
    expect(await (await fetch(`${origin}/api/extension`, { headers })).json()).toMatchObject({ pending: true, connected: false });

    // The wrong code never pairs, and never says which digit was wrong.
    expect((await fetch(`${origin}/api/extension/pair`, { method: 'POST', headers, body: JSON.stringify({ code: '000 000' }) })).status).toBe(403);
    const response = await fetch(`${origin}/api/extension/pair`, { method: 'POST', headers, body: JSON.stringify({ code: String(pair.code) }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ connected: true, pending: false, extension: '0.1.0' });

    const paired = await client.next('paired');
    const token = String(paired.token);
    expect(token.length).toBeGreaterThan(32);
    const record = JSON.parse(await readFile(path.join(dir, 'extension.json'), 'utf8'));
    expect(record.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(record)).not.toContain(token);
    expect(extension.connected()).toBe(true);

    // Forgetting it closes the socket and leaves nothing on disk.
    expect((await fetch(`${origin}/api/extension/pair`, { method: 'DELETE', headers })).status).toBe(200);
    expect(extension.connected()).toBe(false);
    await expect(readFile(path.join(dir, 'extension.json'), 'utf8')).rejects.toThrow();
  });

  it('recognises a stored token and lets the newest connection replace the first', async () => {
    const { socketUrl, origin, extension } = await setup();
    const headers = await session(origin);
    const first = connect(socketUrl);
    await first.open;
    first.send({ type: 'hello', extension: '0.1.0', token: null });
    const code = String((await first.next('pair')).code);
    await fetch(`${origin}/api/extension/pair`, { method: 'POST', headers, body: JSON.stringify({ code }) });
    const token = String((await first.next('paired')).token);

    const second = connect(socketUrl);
    await second.open;
    second.send({ type: 'hello', extension: '0.2.0', token });
    expect(await second.next('paired')).toMatchObject({ installation: expect.stringContaining('127.0.0.1:') });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(first.socket.readyState).toBe(WebSocket.CLOSED);
    expect(extension.connected()).toBe(true);
    expect(await (await fetch(`${origin}/api/extension`, { headers })).json()).toMatchObject({ connected: true, extension: '0.2.0' });

    // A token this buddi never issued is asked to pair again, not admitted.
    const stranger = connect(socketUrl);
    await stranger.open;
    stranger.send({ type: 'hello', extension: '0.2.0', token: 'not-the-token' });
    expect(await stranger.next('pair')).toBeTruthy();
  });

  it('pings, carries a command round trip, and fails a silent extension with one sentence', async () => {
    const { socketUrl, origin, extension } = await setup({ pingMs: 20, commandTimeoutMs: 120 });
    const headers = await session(origin);
    const client = connect(socketUrl);
    await client.open;
    client.send({ type: 'hello', extension: '0.1.0', token: null });
    const code = String((await client.next('pair')).code);
    await fetch(`${origin}/api/extension/pair`, { method: 'POST', headers, body: JSON.stringify({ code }) });
    await client.next('paired');
    // A live extension answers every ping; three unanswered ones close it.
    client.socket.on('message', (data) => {
      if ((JSON.parse(String(data)) as { type?: string }).type === 'ping') client.send({ type: 'pong' });
    });
    await client.next('ping');

    client.socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      if (frame.type !== 'command' || frame.name !== 'observe') return;
      client.send({ type: 'result', id: frame.id, ok: true, observation: { url: 'https://example.com/', tree: 'Frame 0' }, screenshot: null });
    });
    await expect(extension.send({ name: 'observe', session: 's1', args: {} }))
      .resolves.toMatchObject({ observation: { url: 'https://example.com/' } });

    // A refusal the extension classified as "nothing was dispatched".
    client.socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      if (frame.type !== 'command' || frame.name !== 'click') return;
      client.send({ type: 'result', id: frame.id, ok: false, error: 'That element is gone.', precondition: true });
    });
    await expect(extension.send({ name: 'click', session: 's1', args: {} })).rejects.toThrow('That element is gone.');

    // Nothing answers `fill`: the caller waits the timeout and is told so.
    await expect(extension.send({ name: 'fill', session: 's1', args: {} })).rejects.toThrow(/did not answer within a minute/);
  });

  it('upgrades only the extension socket, only from loopback, only from a chrome-extension origin', async () => {
    const { app, socketUrl, origin } = await setup();
    await expect(connect(socketUrl, { Origin: origin }).open).rejects.toThrow();
    await expect(connect(socketUrl, { Origin: 'chrome-extension://short' }).open).rejects.toThrow();
    await expect(connect(`ws://127.0.0.1:${app.port}/api/chat`).open).rejects.toThrow();

    // A socket that is not on this machine, and a loopback socket behind a
    // proxy, are both refused. Emitted directly so the test needs no interface
    // other than loopback and no network at all.
    const refused = (remoteAddress: string, headers: Record<string, string>): Promise<string> => new Promise((resolve) => {
      const socket = new PassThrough();
      let written = '';
      socket.on('data', (chunk: Buffer) => { written += chunk.toString(); });
      socket.on('close', () => resolve(written));
      app.server.emit('upgrade', { url: '/api/extension/socket', headers: { origin: ORIGIN, ...headers }, socket: { remoteAddress } }, socket, Buffer.alloc(0));
    });
    expect(await refused('203.0.113.7', {})).toContain('403');
    expect(await refused('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' })).toContain('403');
  });
});
