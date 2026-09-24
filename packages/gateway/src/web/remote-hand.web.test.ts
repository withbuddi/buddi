/**
 * The remote hand's socket, end to end through a real server.
 *
 * The fake here is the host controller, because the one thing that cannot be
 * faked is the gate: the session cookie on the upgrade, the CSRF token as the
 * first frame, one hand at a time, and — the promise the panel makes to the
 * owner — that no keystroke reaches the log.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { ToolRegistry, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import type { BrowserController, BrowserHand, BrowserStatus, HandFrame, HandInput } from '@buddi/tool-browser';
import { startWebServer, type WebServer } from './server.js';
import { packFrame } from './remote-hand.js';

/** The dashboard's half of `packFrame`: one message, header then JPEG. */
function unpack(message: Buffer): { metadata: Record<string, number>; jpeg: Buffer } {
  const length = message.readUInt16BE(1);
  return { metadata: JSON.parse(message.subarray(3, 3 + length).toString('utf8')) as Record<string, number>,
    jpeg: message.subarray(3 + length) };
}

const TOKEN = 'fixture-remote-hand-token';
const SESSION = 'browser-session-1';
const servers: WebServer[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** A controller with one paused session and a hand that records what it gets. */
function controller() {
  const input: HandInput[] = [];
  let onFrame: ((frame: HandFrame) => void) | undefined;
  const hand: BrowserHand = {
    start: async (handler) => { onFrame = handler; },
    input: async (event) => { input.push(event); },
    stop: vi.fn(async () => { onFrame = undefined; }),
  };
  let state: BrowserStatus['state'] = 'paused';
  const status = (scope?: { sessionId?: string }): BrowserStatus => {
    const mine = !scope?.sessionId || scope.sessionId === SESSION;
    return { state, enabled: true, busy: false, hasScreenshot: false, mode: 'extension',
      ...(mine ? { session: { id: SESSION, agentId: 'concierge', conversationId: 'c1', requestId: 'r1', task: 'Sign in', expiresAt: new Date(Date.now() + 60_000).toISOString(), steps: 1, maxSteps: 80 } } : {}) };
  };
  const browser: BrowserController = {
    enable: async () => {}, shutdown: async () => {}, status,
    screenshot: () => undefined, execute: async () => ({}),
    control: async (action) => { state = action === 'takeover' ? 'paused' : 'running'; return status(); },
    hand: (scope) => (scope?.sessionId === SESSION ? { supported: true, hand } : { supported: true, message: 'gone' }),
  };
  return { browser, hand, input, frame: (picture: HandFrame) => onFrame?.(picture) };
}

async function setup(browser: BrowserController, log?: (line: string) => void) {
  const app = await startWebServer({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
    registry: new ToolRegistry(), catalog: {} as AgentCatalog, ctx: { ownerId: 'owner' } as CoreToolContext,
    timezone: 'UTC', now: () => new Date(), config: { enabled: true, host: '127.0.0.1', port: 0 },
    openAccess: true, token: TOKEN, browser, ...(log ? { log } : {}) });
  servers.push(app);
  const origin = `http://127.0.0.1:${app.port}`;
  const res = await fetch(`${origin}/api/session`, { redirect: 'manual' });
  const pairs = res.headers.getSetCookie().map((line) => line.split(';')[0]!);
  const csrf = pairs.find((p) => p.startsWith('buddi_csrf='))?.slice('buddi_csrf='.length) ?? '';
  const cookie = pairs.join('; ');
  return { app, origin, csrf, cookie,
    headers: { Cookie: cookie, 'X-Buddi-CSRF': csrf, Origin: origin, 'Content-Type': 'application/json' },
    url: `ws://127.0.0.1:${app.port}/api/browser/hand` };
}

/** A dashboard tab: the text frames it saw, and the pictures it was sent. */
function drive(url: string, headers: Record<string, string>) {
  const socket = new WebSocket(url, { headers });
  sockets.push(socket);
  const seen: Array<Record<string, unknown>> = [];
  const pictures: Array<{ metadata: Record<string, number>; jpeg: Buffer }> = [];
  socket.on('message', (data, isBinary) => {
    if (isBinary) pictures.push(unpack(data as Buffer));
    else seen.push(JSON.parse(String(data)) as Record<string, unknown>);
  });
  const closed = new Promise<number>((resolve) => socket.once('close', (code) => resolve(code)));
  const open = new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
  const next = async (type: string): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 300; i++) {
      const frame = seen.find((f) => f.type === type);
      if (frame) return frame;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`no ${type} frame arrived; saw ${JSON.stringify(seen)}`);
  };
  const send = (frame: unknown) => socket.send(JSON.stringify(frame));
  return { socket, seen, pictures, open, closed, next, send };
}

const metadata = { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 };

describe('the remote hand socket', () => {
  it('needs a session and the CSRF token, and then drives one browser session', async () => {
    const { browser, input, frame } = controller();
    const { url, headers, csrf, origin } = await setup(browser);

    // No cookie at all: refused at the upgrade, before any frame.
    const anonymous = new WebSocket(url, { headers: { Origin: origin } });
    sockets.push(anonymous);
    await expect(new Promise((_resolve, reject) => { anonymous.once('error', reject); anonymous.once('open', () => reject(new Error('opened'))); }))
      .rejects.toThrow(/401/);

    // A session, but the CSRF token the page holds is missing.
    const forged = drive(url, { Cookie: headers.Cookie, Origin: origin });
    await forged.open;
    forged.send({ type: 'hello', csrf: 'not-the-token', sessionId: SESSION });
    expect(await forged.closed).toBe(1008);

    const hand = drive(url, { Cookie: headers.Cookie, Origin: origin });
    await hand.open;
    hand.send({ type: 'hello', csrf, sessionId: SESSION });
    expect(await hand.next('driving')).toMatchObject({ sessionId: SESSION });

    // A frame: one message, carrying both what it is and what it shows.
    frame({ jpeg: Buffer.from('a-jpeg'), metadata });
    await vi.waitFor(() => expect(hand.pictures.map((p) => p.jpeg.toString())).toEqual(['a-jpeg']));
    expect(hand.pictures[0]!.metadata).toMatchObject({ deviceWidth: 1280 });

    hand.send({ type: 'input', input: { kind: 'mouse', type: 'mousePressed', x: 30, y: 40, button: 'left', clickCount: 1, modifiers: 0 } });
    await vi.waitFor(() => expect(input).toHaveLength(1));
    expect(input[0]).toMatchObject({ kind: 'mouse', x: 30, y: 40 });
  });

  it('refuses a second tab rather than fighting it for the mouse', async () => {
    const { browser } = controller();
    const { url, headers, csrf, origin } = await setup(browser);
    const first = drive(url, { Cookie: headers.Cookie, Origin: origin });
    await first.open;
    first.send({ type: 'hello', csrf, sessionId: SESSION });
    await first.next('driving');

    const second = drive(url, { Cookie: headers.Cookie, Origin: origin });
    await second.open;
    second.send({ type: 'hello', csrf, sessionId: SESSION });
    expect(await second.next('refused')).toMatchObject({ error: 'Another tab is driving.' });
    await second.closed;
    // The first tab keeps the wheel.
    expect(first.socket.readyState).toBe(WebSocket.OPEN);
  });

  it('validates every event, and never lets a keystroke reach the log', async () => {
    const lines: string[] = [];
    const { browser, input } = controller();
    const { url, headers, csrf, origin } = await setup(browser, (line) => lines.push(line));
    const hand = drive(url, { Cookie: headers.Cookie, Origin: origin });
    await hand.open;
    hand.send({ type: 'hello', csrf, sessionId: SESSION });
    await hand.next('driving');

    // A key name that is not a key, a coordinate off the end of any page, and
    // a `text` that is a paragraph rather than a keystroke.
    hand.send({ type: 'input', input: { kind: 'key', type: 'keyDown', key: 'rm -rf /', code: 'KeyA', modifiers: 0 } });
    hand.send({ type: 'input', input: { kind: 'mouse', type: 'mousePressed', x: 900_000, y: 2, button: 'left', clickCount: 1, modifiers: 0 } });
    hand.send({ type: 'input', input: { kind: 'key', type: 'char', key: 'a', code: 'KeyA', text: 'hunter2-the-whole-password', modifiers: 0 } });
    await vi.waitFor(() => expect(hand.seen.filter((f) => f.type === 'refused')).toHaveLength(3));
    expect(input).toHaveLength(0);

    // A real password, typed one character at a time, the way the page sends it.
    for (const character of 'hunter2') {
      hand.send({ type: 'input', input: { kind: 'key', type: 'char', key: character, code: `Key${character.toUpperCase()}`, text: character, modifiers: 0 } });
    }
    await vi.waitFor(() => expect(input).toHaveLength(7));
    expect(input.map((event) => (event as { text?: string }).text).join('')).toBe('hunter2');

    // And the same password pasted, which is the one string here longer than
    // a keystroke. It reaches the host whole and the log not at all.
    hand.send({ type: 'input', input: { kind: 'text', text: 'hunter2\nthe whole password' } });
    await vi.waitFor(() => expect(input).toHaveLength(8));
    expect(input.at(-1)).toEqual({ kind: 'text', text: 'hunter2\nthe whole password' });

    // Nothing the owner typed or pasted is anywhere near a log line.
    expect(lines.join('\n')).not.toMatch(/hunter|password/);
    for (const character of 'hunter2') expect(lines.some((line) => line.includes(character) && line.includes('hunter'))).toBe(false);
  });

  it('types one character per keystroke, and takes a paste only as text', async () => {
    const { browser, input } = controller();
    const { url, headers, csrf, origin } = await setup(browser);
    const hand = drive(url, { Cookie: headers.Cookie, Origin: origin });
    await hand.open;
    hand.send({ type: 'hello', csrf, sessionId: SESSION });
    await hand.next('driving');

    // "ame" as the dashboard now sends it: one `char` per key, no keyDown
    // carrying the character behind it, so the page inserts each letter once.
    for (const character of 'ame') {
      hand.send({ type: 'input', input: { kind: 'key', type: 'char', key: character, code: `Key${character.toUpperCase()}`, text: character, modifiers: 0 } });
    }
    await vi.waitFor(() => expect(input).toHaveLength(3));
    expect(input.map((event) => (event as { text?: string }).text).join('')).toBe('ame');
    expect(input.every((event) => event.kind === 'key' && event.type === 'char')).toBe(true);

    // A keyDown that carries text is refused outright rather than forwarded to
    // a backend that would type it a second time.
    hand.send({ type: 'input', input: { kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 } });
    // A paste of a page, a paste of nothing, and a paste with an escape
    // sequence in it are all not pastes.
    hand.send({ type: 'input', input: { kind: 'text', text: 'x'.repeat(4_001) } });
    hand.send({ type: 'input', input: { kind: 'text', text: '' } });
    hand.send({ type: 'input', input: { kind: 'text', text: 'one\u0007two' } });
    await vi.waitFor(() => expect(hand.seen.filter((f) => f.type === 'refused')).toHaveLength(4));
    expect(input).toHaveLength(3);

    // What a paste is: text, with a newline and a tab as the only controls.
    hand.send({ type: 'input', input: { kind: 'text', text: 'one\ntwo\tthree' } });
    await vi.waitFor(() => expect(input).toHaveLength(4));
    expect(input.at(-1)).toEqual({ kind: 'text', text: 'one\ntwo\tthree' });
  });

  it('answers Take over with whether this screen can be driven, and ends the hand on resume', async () => {
    const { browser, hand: driverHand } = controller();
    const { url, headers, origin, csrf } = await setup(browser);
    const taken = await fetch(`${origin}/api/browser/takeover`, { method: 'POST', headers, body: JSON.stringify({ sessionId: SESSION }) });
    expect(await taken.json()).toMatchObject({ hand: true });

    const hand = drive(url, { Cookie: headers.Cookie, Origin: origin });
    await hand.open;
    hand.send({ type: 'hello', csrf, sessionId: SESSION });
    await hand.next('driving');

    const given = await fetch(`${origin}/api/browser/resume`, { method: 'POST', headers, body: JSON.stringify({ sessionId: SESSION }) });
    expect(given.status).toBe(200);
    expect(await hand.next('ended')).toMatchObject({ error: 'You gave the screen back.' });
    await hand.closed;
    expect(driverHand.stop).toHaveBeenCalled();
  });

  it('says so when the mode has no hand of its own', async () => {
    const { browser } = controller();
    browser.hand = () => ({ supported: false, message: 'Take over at the computer for this mode.' });
    const { url, headers, origin, csrf } = await setup(browser);
    const taken = await fetch(`${origin}/api/browser/takeover`, { method: 'POST', headers, body: JSON.stringify({ sessionId: SESSION }) });
    expect(await taken.json()).toMatchObject({ hand: false, handMessage: 'Take over at the computer for this mode.' });
    const hand = drive(url, { Cookie: headers.Cookie, Origin: origin });
    await hand.open;
    hand.send({ type: 'hello', csrf, sessionId: SESSION });
    expect(await hand.next('refused')).toMatchObject({ supported: false, error: 'Take over at the computer for this mode.' });
  });
});

/*
 * The endpoint on its own, so the lease, the heartbeat and the drain can be
 * driven directly: the server's authorize is the real gate, and these are
 * about what happens to a socket that was already let through.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SessionStore, type Session } from './sessions.js';
import { RemoteHandEndpoint } from './remote-hand.js';

const bare: Server[] = [];
afterEach(async () => {
  await Promise.all(bare.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function lease(): Session {
  const now = new Date();
  return { id: 'dashboard-session', csrf: 'csrf-token', scope: 'local', via: 'local', ttlMs: 60_000,
    createdAt: now, expiresAt: new Date(now.getTime() + 60_000), cookieIssuedAt: now };
}

/** A hand that records what it is given and can be made slow or angry. */
function slowHand() {
  const input: HandInput[] = [];
  const stopped = vi.fn(async () => {});
  let delay = 0;
  let refuse: Error | undefined;
  let paint: ((frame: HandFrame) => void) | undefined;
  const hand: BrowserHand = {
    start: async (onFrame) => { paint = onFrame; },
    input: async (event) => {
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (refuse) throw refuse;
      input.push(event);
    },
    stop: stopped,
  };
  return { hand, input, stopped, slow: (ms: number) => { delay = ms; }, angry: (error: Error) => { refuse = error; },
    paint: (bytes: Buffer) => paint?.({ jpeg: bytes, metadata: { deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 0 } }) };
}

async function endpoint(options: { session?: () => Session | null; hand?: BrowserHand; log?: (line: string) => void } & Record<string, number | unknown> = {}) {
  const { browser } = controller();
  const { hand } = options;
  if (hand) browser.hand = () => ({ supported: true, hand });
  const session = options.session ?? (() => lease());
  const endpoint = new RemoteHandEndpoint({
    authorize: async () => session(),
    browser: () => browser,
    ...(options.log ? { log: options.log } : {}),
    ...(typeof options.pingMs === 'number' ? { pingMs: options.pingMs } : {}),
    ...(typeof options.idleMs === 'number' ? { idleMs: options.idleMs } : {}),
    ...(typeof options.lifetimeMs === 'number' ? { lifetimeMs: options.lifetimeMs } : {}),
    ...(typeof options.congestionMs === 'number' ? { congestionMs: options.congestionMs } : {}),
  });
  const server = createServer((_req, res) => res.end());
  bare.push(server);
  server.on('upgrade', (req, socket, head) => endpoint.upgrade(req, socket as never, head));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/browser/hand`;
  const tab = drive(url, { Origin: 'http://127.0.0.1' });
  await tab.open;
  tab.send({ type: 'hello', csrf: 'csrf-token', sessionId: SESSION });
  await tab.next('driving');
  return { endpoint, tab };
}

describe('a hand that has already been let through', () => {
  it('dies with its session rather than driving on', async () => {
    let allowed: Session | null = lease();
    const hand = slowHand();
    const { tab } = await endpoint({ hand: hand.hand, session: () => allowed });
    tab.send({ type: 'input', input: { kind: 'mouse', type: 'mouseMoved', x: 1, y: 1, button: 'none', clickCount: 0, modifiers: 0 } });
    await vi.waitFor(() => expect(hand.input).toHaveLength(1));

    // The session expired, was destroyed, or the tailnet identity it was
    // minted for is no longer allowed. The next input is the last thing that
    // happens, and it does not reach the browser.
    allowed = null;
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    tab.send({ type: 'input', input: { kind: 'key', type: 'char', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 } });
    expect(await tab.next('ended')).toMatchObject({ error: 'Your session ended. Sign in again.' });
    expect(hand.input).toHaveLength(1);
    expect(hand.stopped).toHaveBeenCalled();
  });

  it('is revoked the moment the session behind it is forgotten', async () => {
    const hand = slowHand();
    const { endpoint: live, tab } = await endpoint({ hand: hand.hand });
    live.revoke((id) => id === 'dashboard-session', 'Tailscale access changed. Sign in again.');
    expect(await tab.next('ended')).toMatchObject({ error: 'Tailscale access changed. Sign in again.' });
    expect(hand.stopped).toHaveBeenCalled();
  });

  it('ends at its absolute lifetime, and when nobody has touched it', async () => {
    const hand = slowHand();
    const { tab } = await endpoint({ hand: hand.hand, pingMs: 20, idleMs: 40 });
    expect(await tab.next('ended')).toMatchObject({ error: 'The take-over went idle.' });
    expect(hand.stopped).toHaveBeenCalled();

    const second = slowHand();
    const later = await endpoint({ hand: second.hand, pingMs: 20, lifetimeMs: 40 });
    expect(await later.tab.next('ended')).toMatchObject({ error: expect.stringContaining('reached its limit') });
  });

  it('terminates a client that stops answering, and stops the screencast', async () => {
    const hand = slowHand();
    const { tab } = await endpoint({ hand: hand.hand, pingMs: 20, idleMs: 60_000 });
    // A phone that walked out of range: the socket is open, nothing is read,
    // and no pong will ever come back.
    (tab.socket as unknown as { _socket: { pause(): void } })._socket.pause();
    await vi.waitFor(() => expect(hand.stopped).toHaveBeenCalled(), { timeout: 2_000 });
  });

  it('drops frames a stalled client cannot take, and gives up on it', async () => {
    const lines: string[] = [];
    const hand = slowHand();
    const { tab } = await endpoint({ hand: hand.hand, pingMs: 25, congestionMs: 0, idleMs: 60_000, log: (line) => lines.push(line) });
    // Nothing is being read off the socket any more, so every frame stays in
    // this process's memory rather than reaching a viewer.
    (tab.socket as unknown as { _socket: { pause(): void } })._socket.pause();
    const big = Buffer.alloc(2 * 1024 * 1024, 1);
    for (let i = 0; i < 40; i++) { hand.paint(big); await new Promise((resolve) => setTimeout(resolve, 5)); }
    await vi.waitFor(() => expect(lines).toContain('browser hand: socket fell too far behind'), { timeout: 2_000 });
    expect(hand.stopped).toHaveBeenCalled();
  });

  it('coalesces a drag to where the finger is, and never puts a round trip between two keystrokes', async () => {
    const hand = slowHand();
    const { tab } = await endpoint({ hand: hand.hand });
    // The host takes a while over each event, exactly as a host on the other
    // end of a link does.
    hand.slow(30);
    for (let i = 0; i < 20; i++) tab.send({ type: 'input', input: { kind: 'mouse', type: 'mouseMoved', x: 100 + i, y: 200, button: 'none', clickCount: 0, modifiers: 0 } });
    tab.send({ type: 'input', input: { kind: 'mouse', type: 'mousePressed', x: 119, y: 200, button: 'left', clickCount: 1, modifiers: 0 } });
    await vi.waitFor(() => expect(hand.input.at(-1)).toMatchObject({ type: 'mousePressed' }), { timeout: 5_000 });
    const moves = hand.input.filter((event) => event.kind === 'mouse' && event.type === 'mouseMoved');
    // Every position but the last was somewhere the pointer had already left.
    expect(moves.length).toBeLessThan(20);
    expect(moves.at(-1)).toMatchObject({ x: 119, y: 200 });
    // And the press landed where the drag ended, after it.
    expect(hand.input.at(-1)).toMatchObject({ x: 119, y: 200 });

    // Four keystrokes, in order, without waiting for each other's result:
    // one host round trip for the batch rather than four.
    hand.input.length = 0;
    const start = Date.now();
    for (const key of ['a', 'b', 'c', 'd']) tab.send({ type: 'input', input: { kind: 'key', type: 'char', key, code: 'KeyA', text: key, modifiers: 0 } });
    await vi.waitFor(() => expect(hand.input).toHaveLength(4), { timeout: 5_000 });
    expect(hand.input.map((event) => (event as { text?: string }).text)).toEqual(['a', 'b', 'c', 'd']);
    expect(Date.now() - start).toBeLessThan(4 * 30);

    hand.slow(0);
    tab.send({ type: 'bye' });
    await tab.next('ended');
  });

  it('drains what is in flight and lets go of everything still pressed', async () => {
    const hand = slowHand();
    const { endpoint: live, tab } = await endpoint({ hand: hand.hand });
    tab.send({ type: 'input', input: { kind: 'mouse', type: 'mousePressed', x: 30, y: 40, button: 'left', clickCount: 1, modifiers: 0 } });
    tab.send({ type: 'input', input: { kind: 'key', type: 'keyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 8 } });
    await vi.waitFor(() => expect(hand.input).toHaveLength(2));

    // A slow input still on its way out when Resume arrives.
    hand.slow(60);
    tab.send({ type: 'input', input: { kind: 'key', type: 'char', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await live.close(SESSION, 'You gave the screen back.');

    // Nothing was still executing when close returned, the button and the key
    // were let go of, and the screencast stopped after both.
    expect(hand.input.map((event) => (event as { type?: string }).type)).toEqual(['mousePressed', 'keyDown', 'char', 'mouseReleased', 'keyUp']);
    expect(hand.input.at(-2)).toMatchObject({ kind: 'mouse', type: 'mouseReleased', x: 30, y: 40, button: 'left' });
    expect(hand.input.at(-1)).toMatchObject({ kind: 'key', type: 'keyUp', key: 'Shift' });
    expect(hand.stopped).toHaveBeenCalled();
  });

  it('refuses new input once the hand is closing', async () => {
    const hand = slowHand();
    hand.slow(40);
    const { endpoint: live, tab } = await endpoint({ hand: hand.hand });
    tab.send({ type: 'input', input: { kind: 'key', type: 'char', key: 'a', code: 'KeyA', text: 'a', modifiers: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const closing = live.close(SESSION, 'You gave the screen back.');
    tab.send({ type: 'input', input: { kind: 'key', type: 'char', key: 'b', code: 'KeyB', text: 'b', modifiers: 0 } });
    await closing;
    expect(hand.input.filter((event) => (event as { text?: string }).text === 'b')).toHaveLength(0);
  });

  it('never writes what the host said about an input into the log', async () => {
    const lines: string[] = [];
    const hand = slowHand();
    // What Playwright does with a key it does not know: it quotes it back.
    hand.angry(new Error('Unknown key: "hunter2"'));
    const { tab } = await endpoint({ hand: hand.hand, log: (line) => lines.push(line) });
    tab.send({ type: 'input', input: { kind: 'key', type: 'char', key: 'h', code: 'KeyH', text: 'h', modifiers: 0 } });
    expect(await tab.next('ended')).toMatchObject({ error: expect.stringContaining('Take over again') });
    expect(lines.join('\n')).not.toMatch(/hunter2|Unknown key/);
    expect(lines).toContain('browser hand: input failed at the host');
  });
});
