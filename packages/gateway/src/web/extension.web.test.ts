import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import { BrowserOpenedError, BrowserService, type BrowserController, type BrowserDriver } from '@buddi/tool-browser';
import WebSocket from 'ws';
import { ExtensionEndpoint, extensionEndpoint, MIN_EXTENSION_VERSION, readExtensionLogin } from './extension.js';
import { startWebServer, type WebServer } from './server.js';
import { csrfCookieName, portOf } from './http.js';

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

async function setup(options: { pingMs?: number; commandTimeoutMs?: number; cancelGraceMs?: number; authTimeoutMs?: number; log?: (line: string) => void } = {}) {
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
  const csrf = pairs.find((p) => p.startsWith(`${csrfCookieName(portOf(new URL(origin)))}=`))?.slice(`${csrfCookieName(portOf(new URL(origin)))}=`.length) ?? '';
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

describe('the pairing on disk', () => {
  it('is read again only when the file changes, and says so right through a pairing and a forget', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-extension-'));
    dirs.push(dir);
    const extension = new ExtensionEndpoint({ env: { BUDDI_DATA_DIR: dir, BUDDI_EXTENSION_DIR: path.join(dir, 'extension') } });
    const file = path.join(dir, 'extension.json');
    expect(extension.paired()).toBe(false);
    await writeFile(file, JSON.stringify({ tokenHash: 'abc' }));
    expect(extension.paired()).toBe(true);
    expect(extension.paired()).toBe(true);
    await writeFile(file, JSON.stringify({ tokenHash: '' }));
    expect(extension.paired()).toBe(false);
    await rm(file);
    expect(extension.paired()).toBe(false);
    extension.shutdown();
  });
});

describe('the browser extension endpoint', () => {
  it('asks for a code, pairs through the route, and stores only a hash', async () => {
    const { dir, socketUrl, origin, extension } = await setup();
    const headers = await session(origin);
    expect(await (await fetch(`${origin}/api/extension`, { headers })).json())
      .toMatchObject({ connected: false, pending: false, path: path.join(dir, 'extension') });
    // Its own version, plain, so the page can compare it with the extension's.
    expect(((await (await fetch(`${origin}/api/extension`, { headers })).json()) as { buddi?: string }).buddi).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
    // The oldest extension it works with, in Chrome's scheme; the store's first build (0.1.0) meets it.
    expect(((await (await fetch(`${origin}/api/extension`, { headers })).json()) as { extensionMinimum?: string }).extensionMinimum).toBe(MIN_EXTENSION_VERSION);
    expect(MIN_EXTENSION_VERSION).toMatch(/^\d+(\.\d+){0,3}$/);

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

    // A failure after the tab opened carries the page, so the tool can say "opened, then this failed".
    client.socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as Record<string, unknown>;
      if (frame.type !== 'command' || frame.name !== 'navigate') return;
      client.send({ type: 'result', id: frame.id, ok: false, error: 'The tab closed while it was loading.', precondition: false,
        page: { tabId: 'tab-1', url: 'https://example.com/', title: 'Example' } });
    });
    const opened = await extension.send({ name: 'navigate', session: 's1', args: { url: 'https://example.com/' } }).catch((error: unknown) => error);
    expect(opened).toBeInstanceOf(BrowserOpenedError);
    expect((opened as BrowserOpenedError).page).toEqual({ tabId: 'tab-1', url: 'https://example.com/', title: 'Example' });

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

  it('hands the owner\'s Take over and Give it back from a tab to that session, and nothing else', async () => {
    const { socketUrl, origin, extension } = await setup();
    const headers = await session(origin);
    const client = connect(socketUrl);
    await client.open;
    await client.hello(null);
    const code = String((await client.next('pair')).code);
    await fetch(`${origin}/api/extension/pair`, { method: 'POST', headers, body: JSON.stringify({ code }) });
    await client.next('paired');
    const heard: string[] = [];
    const stop = extension.events('s1', (event) => heard.push(event));
    client.send({ type: 'event', name: 'takeover', session: 's1' });
    client.send({ type: 'event', name: 'giveback', session: 's1' });
    client.send({ type: 'event', name: 'navigate', session: 's1' });
    client.send({ type: 'event', name: 'giveback', session: 'someone-else' });
    await vi.waitFor(() => expect(heard).toEqual(['takeover', 'giveback']));
    stop();
  });

  it('hands a sign-in answered in a held tab to that session, only from the paired socket, and logs none of it', async () => {
    const lines: string[] = [];
    const { socketUrl, origin, extension } = await setup({ log: (line: string) => lines.push(line) } as never);
    const headers = await session(origin);
    const heard: unknown[] = [];
    const stop = extension.logins('s1', (login) => { heard.push(login); });
    // A socket that never paired is not believed.
    const stranger = connect(socketUrl);
    await stranger.open;
    stranger.send({ type: 'login', session: 's1', decision: 'save', origin: 'https://www.amazon.com', username: 'sam', password: 'stranger-pass' });
    const client = connect(socketUrl);
    await client.open;
    await client.hello(null);
    const code = String((await client.next('pair')).code);
    await fetch(`${origin}/api/extension/pair`, { method: 'POST', headers, body: JSON.stringify({ code }) });
    await client.next('paired');
    client.send({ type: 'login', session: 's1', decision: 'save', origin: 'https://www.amazon.com/ap/signin', username: 'sam', password: 'fixture-pass-7Qz!' });
    client.send({ type: 'login', session: 's1', decision: 'save', origin: 'https://www.amazon.com', username: 'sam' });
    client.send({ type: 'login', session: 's1', decision: 'never', origin: 'https://bank.test', username: 'sam', password: 'never-carries-one' });
    client.send({ type: 'login', session: 's1', decision: 'never', origin: 'https://bank.test', username: 'sam' });
    client.send({ type: 'login', session: 's1', decision: 'save', origin: 'chrome://settings', username: 'sam', password: 'x' });
    client.send({ type: 'login', session: 'someone-else', decision: 'never', origin: 'https://bank.test', username: 'sam' });
    await vi.waitFor(() => expect(heard).toEqual([
      { decision: 'save', origin: 'https://www.amazon.com', username: 'sam', password: 'fixture-pass-7Qz!' },
      { decision: 'never', origin: 'https://bank.test', username: 'sam' },
    ]));
    expect(lines.join('\n')).not.toContain('fixture-pass');
    stop();
  });

  it('answers a Save with what became of it, by the id the tab sent: kept, the keeper’s reason, or gone', async () => {
    const { socketUrl, origin, extension } = await setup();
    const headers = await session(origin);
    const client = connect(socketUrl);
    await client.open;
    await client.hello(null);
    const code = String((await client.next('pair')).code);
    await fetch(`${origin}/api/extension/pair`, { method: 'POST', headers, body: JSON.stringify({ code }) });
    await client.next('paired');
    let answer: { saved: true } | { saved: false; reason: string } = { saved: true };
    const stop = extension.logins('s1', async () => answer);
    const ackFor = async (id: string) => {
      await vi.waitFor(() => expect(client.seen.some((frame) => frame.type === 'loginAck' && frame.id === id)).toBe(true));
      return client.seen.find((frame) => frame.type === 'loginAck' && frame.id === id)!;
    };
    client.send({ type: 'login', session: 's1', decision: 'save', origin: 'https://www.amazon.com', username: 'sam', password: 'fixture-pass-7Qz!', id: 'ack-1' });
    expect(await ackFor('ack-1')).toEqual({ type: 'loginAck', id: 'ack-1', saved: true });
    answer = { saved: false, reason: 'buddi could not keep that login. Try again, or add it in Settings → Keys and secrets.' };
    client.send({ type: 'login', session: 's1', decision: 'save', origin: 'https://www.amazon.com', username: 'sam', password: 'fixture-pass-7Qz!', id: 'ack-2' });
    const refused = await ackFor('ack-2');
    expect(refused).toEqual({ type: 'loginAck', id: 'ack-2', saved: false, reason: answer.reason });
    expect(JSON.stringify(refused)).not.toContain('fixture-pass');
    stop();
    // Nobody holds that page any more: the tab is told the question is gone.
    client.send({ type: 'login', session: 's1', decision: 'save', origin: 'https://www.amazon.com', username: 'sam', password: 'fixture-pass-7Qz!', id: 'ack-3' });
    expect(await ackFor('ack-3')).toMatchObject({ id: 'ack-3', saved: false, reason: expect.stringContaining('That question is gone') });
    // A check (should the tab ask at all?) is answered with the keeper's word; with nobody listening, nothing to ask.
    const stopCheck = extension.logins('s1', async (login) => (login.decision === 'check' ? { ask: 'update' as const } : { saved: true as const }));
    client.send({ type: 'login', session: 's1', decision: 'check', origin: 'https://www.amazon.com', username: 'sam', password: 'fixture-pass-7Qz!', id: 'check-1' });
    expect(await ackFor('check-1')).toEqual({ type: 'loginAck', id: 'check-1', ask: 'update' });
    stopCheck();
    client.send({ type: 'login', session: 's1', decision: 'check', origin: 'https://www.amazon.com', username: 'sam', password: 'fixture-pass-7Qz!', id: 'check-2' });
    expect(await ackFor('check-2')).toEqual({ type: 'loginAck', id: 'check-2', ask: 'none' });
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

describe('a fresh install, no pairing record', () => {
  /*
   * What the owner hit on a fresh pair: the popup showed "Pairing" and a code
   * and buddi said no browser was waiting, with nothing in the log either way.
   * The socket waiting for its code heard nothing, so Chrome stopped the idle
   * worker half a minute in. Now it is pinged while it waits, and every
   * attempt is one line in the log, never the code.
   */
  it('registers the browser as pending, pings it while it waits, and logs the attempt without the code', async () => {
    const lines: string[] = [];
    const { socketUrl, origin, dir } = await setup({ pingMs: 40, log: (line) => lines.push(line) });
    await expect(readFile(path.join(dir, 'extension.json'), 'utf8')).rejects.toThrow();
    const headers = await session(origin);
    const ext = connect(socketUrl);
    await ext.open;
    await ext.hello(null);
    const pair = await ext.next('pair');
    expect(await (await fetch(`${origin}/api/extension`, { headers })).json()).toMatchObject({ connected: false, pending: true });
    await ext.next('ping');
    expect(ext.socket.readyState).toBe(WebSocket.OPEN);
    expect(lines).toContain(`extension: socket accepted from ${'a'.repeat(32)}`);
    expect(lines.some((line) => /hello from a{32} \(0\.1\.0\), no pairing yet: waiting for the code/.test(line))).toBe(true);
    const digits = String(pair.code).replace(/[^0-9]/g, '');
    expect(lines.join('\n')).not.toContain(digits);
    expect(lines.join('\n')).not.toContain(String(pair.code));
    // The owner types it in the app window: paired, and logged as such.
    const answer = await fetch(`${origin}/api/extension/pair`, { method: 'POST', headers, body: JSON.stringify({ code: pair.code }) });
    expect(answer.status).toBe(200);
    expect(await ext.next('paired')).toMatchObject({ type: 'paired' });
    expect(lines).toContain(`extension: paired with ${'a'.repeat(32)}`);
    expect(lines.join('\n')).not.toMatch(/token/i);
  });

  it('logs a refused socket with its reason', async () => {
    const lines: string[] = [];
    const { socketUrl } = await setup({ log: (line) => lines.push(line) });
    const refused = new WebSocket(socketUrl, { headers: { Origin: 'https://example.com' } });
    await new Promise<void>((resolve) => { refused.once('error', () => resolve()); refused.once('close', () => resolve()); });
    expect(lines.some((line) => line.startsWith('extension: socket refused (403): not a Chrome extension origin (https://example.com)'))).toBe(true);
  });

  it('says whether buddi runs from a checkout, for the Install unpacked item', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-extension-'));
    dirs.push(dir);
    const packaged = new ExtensionEndpoint({ env: { BUDDI_DATA_DIR: dir, BUDDI_EXTENSION_DIR: dir, BUDDI_RUNTIME_CHECKOUT: '0' } });
    expect((await packaged.view()).checkout).toBe(false);
    packaged.shutdown();
    const checkout = new ExtensionEndpoint({ env: { BUDDI_DATA_DIR: dir, BUDDI_EXTENSION_DIR: dir, BUDDI_RUNTIME_CHECKOUT: '1' } });
    expect((await checkout.view()).checkout).toBe(true);
    checkout.shutdown();
    // This test runs in a checkout: without the override, it says so.
    const plain = new ExtensionEndpoint({ env: { BUDDI_DATA_DIR: dir, BUDDI_EXTENSION_DIR: dir } });
    expect((await plain.view()).checkout).toBe(true);
    plain.shutdown();
  });

  it('takes the server’s log even when the browser host made the endpoint first', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-extension-'));
    dirs.push(dir);
    const env = { BUDDI_DATA_DIR: dir };
    const first = extensionEndpoint(env);
    const lines: string[] = [];
    expect(extensionEndpoint(env, (line) => lines.push(line))).toBe(first);
    expect((await first.pair('123456')).status).toBe(409);
    expect(lines).toContain('extension: a code was typed with no browser waiting');
    first.shutdown();
  });
});

describe('a login frame, read strictly', () => {
  it('takes an http(s) origin, the password only with Save, and nothing longer than a form field', () => {
    expect(readExtensionLogin({ session: 's', decision: 'save', origin: 'https://a.test/x', username: 'u', password: 'p' })).toEqual({ session: 's', login: { decision: 'save', origin: 'https://a.test', username: 'u', password: 'p' } });
    expect(readExtensionLogin({ session: 's', decision: 'save', origin: 'https://a.test', username: 'u', password: 'p'.repeat(2000) })).toBeUndefined();
    expect(readExtensionLogin({ session: 's', decision: 'later', origin: 'https://a.test', username: 'u' })).toBeUndefined();
    expect(readExtensionLogin({ session: 's', decision: 'never', origin: 'file:///etc', username: 'u' })).toBeUndefined();
    expect(readExtensionLogin({ session: 's', decision: 'never', origin: 'https://a.test', username: 'u' })).toEqual({ session: 's', login: { decision: 'never', origin: 'https://a.test', username: 'u' } });
    expect(readExtensionLogin({ session: 's', decision: 'save', origin: 'https://a.test', username: 'u', password: 'p', id: 'ack-1' })).toMatchObject({ id: 'ack-1' });
    expect(readExtensionLogin({ session: 's', decision: 'save', origin: 'https://a.test', username: 'u', password: 'p', id: 'no spaces <b>' })).toBeUndefined();
  });
});
