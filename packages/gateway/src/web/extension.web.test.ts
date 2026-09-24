import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type AgentCatalog, type CoreToolContext } from '@buddi/core';
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

/** What a gateway holding the token signs this socket's nonce with. */
const proofOf = (token: string, nonce: unknown) =>
  createHmac('sha256', createHash('sha256').update(token).digest('hex')).update(String(nonce)).digest('hex');

async function setup(options: { pingMs?: number; commandTimeoutMs?: number; cancelGraceMs?: number; authTimeoutMs?: number } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'buddi-extension-'));
  dirs.push(dir);
  const env = { BUDDI_DATA_DIR: dir, BUDDI_EXTENSION_DIR: path.join(dir, 'extension') };
  const extension = new ExtensionEndpoint({ env, ...options });
  const driver: BrowserDriver = { start: vi.fn(), perform: vi.fn(), observe: vi.fn(), screenshot: vi.fn(), close: vi.fn() };
  const browser = new BrowserService(driver); browsers.push(browser); await browser.enable();
  const app = await startWebServer({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
    registry: new ToolRegistry(), catalog: {} as AgentCatalog, ctx: { ownerId: 'owner' } as CoreToolContext,
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
  const send = (frame: unknown) => socket.send(JSON.stringify(frame));

  /**
   * The handshake as the extension does it: a nonce, the gateway's proof, and
   * only then the token.
   */
  const hello = async (token: string | null, version = '0.1.0') => {
    const nonce = `nonce-${Math.random().toString(36).slice(2)}`;
    send({ type: 'hello', extension: version, nonce, paired: token !== null });
    return nonce;
  };
  const handshake = async (token: string, version = '0.1.0') => {
    const nonce = await hello(token, version);
    const challenge = await next('challenge');
    if (challenge.proof !== proofOf(token, nonce)) throw new Error('the gateway could not prove it holds the token');
    send({ type: 'auth', token });
    return next('paired');
  };
  return { socket, seen, open, next, send, hello, handshake };
}

describe('the browser extension endpoint', () => {
  it('asks for a code, pairs through the route, and stores only a hash', async () => {
    const { dir, socketUrl, origin, extension } = await setup();
    const headers = await session(origin);
    expect(await (await fetch(`${origin}/api/extension`, { headers })).json())
      .toMatchObject({ connected: false, pending: false, path: path.join(dir, 'extension') });

    const client = connect(socketUrl);
    await client.open;
    await client.hello(null);
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

  it('is not connected until the paired frame has left the building', async () => {
    const { socketUrl, extension } = await setup();
    const client = connect(socketUrl);
    await client.open;
    await client.hello(null);
    const code = String((await client.next('pair')).code);

    // The socket is adopted synchronously inside `pair`, but the browser is not
    // paired until it has read the frame saying so: a command dispatched in
    // that window is the one an owner sends right after typing the code.
    const pairing = extension.pair(code);
    expect(extension.connected()).toBe(false);
    await expect(extension.send({ name: 'observe', session: 's1', args: {} })).rejects.toThrow(/not connected/i);
    expect(await pairing).toMatchObject({ status: 200 });
    expect(extension.connected()).toBe(true);
    expect(client.seen.some((frame) => frame['type'] === 'command')).toBe(false);
  });

  it('recognises a stored token and lets the newest connection replace the first', async () => {
    const { socketUrl, origin, extension } = await setup();
    const headers = await session(origin);
    const first = connect(socketUrl);
    await first.open;
    await first.hello(null);
    const code = String((await first.next('pair')).code);
    await fetch(`${origin}/api/extension/pair`, { method: 'POST', headers, body: JSON.stringify({ code }) });
    const token = String((await first.next('paired')).token);

    const second = connect(socketUrl);
    await second.open;
    expect(await second.handshake(token, '0.2.0')).toMatchObject({ installation: expect.stringContaining('127.0.0.1:') });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(first.socket.readyState).toBe(WebSocket.CLOSED);
    expect(extension.connected()).toBe(true);
    expect(await (await fetch(`${origin}/api/extension`, { headers })).json()).toMatchObject({ connected: true, extension: '0.2.0' });

    // A browser holding the wrong token never gets past the proof: it cannot
    // reproduce the signature, and the gateway closes it when it tries anyway.
    const stranger = connect(socketUrl);
    await stranger.open;
    const nonce = await stranger.hello('not-the-token');
    const challenge = await stranger.next('challenge');
    expect(challenge.proof).not.toBe(proofOf('not-the-token', nonce));
    expect(challenge.proof).toBe(proofOf(token, nonce));
    stranger.send({ type: 'auth', token: 'not-the-token' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stranger.socket.readyState).toBe(WebSocket.CLOSED);
    expect(extension.connected()).toBe(true);
  });

  it('never sends a command to a socket that has not finished the handshake', async () => {
    const { socketUrl, origin, extension } = await setup({ commandTimeoutMs: 80 });
    const headers = await session(origin);
    const first = connect(socketUrl);
    await first.open;
    await first.hello(null);
    const code = String((await first.next('pair')).code);
    await fetch(`${origin}/api/extension/pair`, { method: 'POST', headers, body: JSON.stringify({ code }) });
    const token = String((await first.next('paired')).token);
    first.socket.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Half-way through: the proof is out, the token has not come back.
    const half = connect(socketUrl);
    await half.open;
    await half.hello(token);
    await half.next('challenge');
    expect(extension.connected()).toBe(false);
    await expect(extension.send({ name: 'observe', session: 's1', args: {} })).rejects.toThrow(/not connected/i);
    expect(half.seen.some((frame) => frame['type'] === 'command')).toBe(false);
  });

  it('pairs with one extension id and refuses another', async () => {
    const { socketUrl, origin, dir } = await setup();
    const headers = await session(origin);
    const first = connect(socketUrl);
    await first.open;
    await first.hello(null);
    const code = String((await first.next('pair')).code);
    await fetch(`${origin}/api/extension/pair`, { method: 'POST', headers, body: JSON.stringify({ code }) });
    const token = String((await first.next('paired')).token);
    expect(JSON.parse(await readFile(path.join(dir, 'extension.json'), 'utf8')).extensionId).toBe('a'.repeat(32));

    const other = connect(socketUrl, { Origin: `chrome-extension://${'b'.repeat(32)}` });
    await other.open;
    await other.hello(token);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(other.seen).toEqual([]);
    expect(other.socket.readyState).toBe(WebSocket.CLOSED);
  });

  it('spends a pairing code after five wrong tries, and counts them against the rate limiter', async () => {
    const { socketUrl, origin } = await setup();
    const headers = await session(origin);
    const client = connect(socketUrl);
    await client.open;
    await client.hello(null);
    const code = String((await client.next('pair')).code);
    const wrong = code === '000 000' ? '111 111' : '000 000';
    const attempt = (body: string) => fetch(`${origin}/api/extension/pair`, { method: 'POST', headers, body });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await attempt(JSON.stringify({ code: wrong }))).status);
    expect(statuses).toEqual([403, 403, 403, 403, 429]);
    // The code it was showing is spent, and the browser is told to start over.
    expect(await client.next('rehello')).toMatchObject({ reason: expect.stringContaining('Too many wrong') });
    // Five wrong answers is also this session's whole pairing budget, so the
    // sixth is refused by the gateway before the endpoint is asked at all —
    // an empty 429, not the endpoint's sentence.
    const sixth = await attempt(JSON.stringify({ code }));
    expect(sixth.status).toBe(429);
    expect(await sixth.text()).toBe('');
  });

  it('pairs even when local sign-in attempts have exhausted the shared rate limiter', async () => {
    const { socketUrl, origin } = await setup();
    const headers = await session(origin);
    // Anything else on this machine failing to sign in: on loopback every
    // client shares one remote key, so ten of these used to lock the owner out
    // of pairing on their very first attempt.
    for (let i = 0; i < 12; i++) {
      await fetch(`${origin}/?t=not-a-ticket`, { redirect: 'manual' });
    }
    const client = connect(socketUrl);
    await client.open;
    await client.hello(null);
    const code = String((await client.next('pair')).code);
    const res = await fetch(`${origin}/api/extension/pair`, { method: 'POST', headers, body: JSON.stringify({ code }) });
    expect(res.status).toBe(200);
    await client.next('paired');
  });

  it('pings, carries a command round trip, and fails a silent extension with one sentence', async () => {
    const { socketUrl, origin, extension } = await setup({ pingMs: 20, commandTimeoutMs: 120, cancelGraceMs: 200 });
    const headers = await session(origin);
    const client = connect(socketUrl);
    await client.open;
    await client.hello(null);
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

    // Nothing answers `fill`: the caller waits the timeout, is told so, and the
    // browser is told to abandon the command rather than act on it late.
    await expect(extension.send({ name: 'fill', session: 's1', args: {} })).rejects.toThrow(/did not answer within a minute/);
    const cancel = await client.next('cancel');
    const abandoned = client.seen.find((frame) => frame['type'] === 'command' && frame['name'] === 'fill');
    expect(cancel['id']).toBe(abandoned!['id']);

    // The driver is held until the extension says it stopped.
    let settled = false;
    const idle = extension.idle().then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settled).toBe(false);
    client.send({ type: 'result', id: cancel['id'], ok: false, error: 'cancelled', precondition: true });
    await idle;
    expect(settled).toBe(true);
  });

  it('counts pongs only from the browser it is talking to', async () => {
    const { socketUrl, origin, extension } = await setup({ pingMs: 30 });
    const headers = await session(origin);
    const client = connect(socketUrl);
    await client.open;
    await client.hello(null);
    const code = String((await client.next('pair')).code);
    await fetch(`${origin}/api/extension/pair`, { method: 'POST', headers, body: JSON.stringify({ code }) });
    await client.next('paired');

    // Another socket answers every ping enthusiastically; it proves nothing
    // about the browser that is meant to be answering.
    const stranger = connect(socketUrl);
    await stranger.open;
    const pongs = setInterval(() => stranger.send({ type: 'pong' }), 10);
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(extension.connected()).toBe(false);
    } finally { clearInterval(pongs); }
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
