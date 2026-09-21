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
import { ToolRegistry, type AgentCatalog, type ToolContext } from '@buddi/core';
import type { BrowserController, BrowserHand, BrowserStatus, HandFrame, HandInput } from '@buddi/tool-browser';
import { startWebServer, type WebServer } from './server.js';

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
    registry: new ToolRegistry(), catalog: {} as AgentCatalog, ctx: { ownerId: 'owner' } as ToolContext,
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
  const pictures: Buffer[] = [];
  socket.on('message', (data, isBinary) => {
    if (isBinary) pictures.push(data as Buffer);
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

    // A frame: the metadata line, then the bytes it describes.
    frame({ jpeg: Buffer.from('a-jpeg'), metadata });
    expect(await hand.next('frame')).toMatchObject({ metadata: { deviceWidth: 1280 } });
    await vi.waitFor(() => expect(hand.pictures.map((p) => p.toString())).toEqual(['a-jpeg']));

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
    // Nothing the owner typed is anywhere near a log line.
    expect(lines.join('\n')).not.toMatch(/hunter/);
    for (const character of 'hunter2') expect(lines.some((line) => line.includes(character) && line.includes('hunter'))).toBe(false);
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
