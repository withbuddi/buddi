/**
 * Your Chrome, live: the second frame source behind the remote hand.
 *
 * A real server, the real extension endpoint, the real `ExtensionDriver`, and
 * a fake extension on the socket that answers commands and paints frames as
 * binary messages, the way the extension does. What is checked is the whole
 * path a picture takes — extension socket, driver, the Canvas's picture, the
 * hand socket, the dashboard — and the owner's input and copy coming back.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { ToolRegistry, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import { ExtensionDriver, type BrowserController, type BrowserStatus } from '@buddi/tool-browser';
import { ExtensionEndpoint, GATEWAY_FEATURES, instanceName, readExtensionFrame } from './extension.js';
import { startWebServer, type WebServer } from './server.js';
import { csrfCookieName } from './http.js';

const TOKEN = 'fixture-extension-live-token';
const ORIGIN = `chrome-extension://${'b'.repeat(32)}`;
const servers: WebServer[] = [];
const sockets: WebSocket[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A frame as the extension packs it: version, header length, the header with the session, the JPEG. */
function packed(session: string, jpeg: string, extra: Record<string, unknown> = {}): Buffer {
  const head = Buffer.from(JSON.stringify({ session, deviceWidth: 1280, deviceHeight: 800, pageScaleFactor: 1, offsetTop: 0, scrollOffsetX: 0, scrollOffsetY: 12, url: 'https://shop.test/orders', ...extra }));
  const prefix = Buffer.alloc(3);
  prefix.writeUInt8(1, 0);
  prefix.writeUInt16BE(head.length, 1);
  return Buffer.concat([prefix, head, Buffer.from(jpeg)]);
}

/** The dashboard's half of `packFrame`. */
function unpack(message: Buffer): { metadata: Record<string, unknown>; jpeg: string } {
  const length = message.readUInt16BE(1);
  return { metadata: JSON.parse(message.subarray(3, 3 + length).toString('utf8')) as Record<string, unknown>, jpeg: message.subarray(3 + length).toString() };
}

async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 400; i++) {
    const found = read();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${what} never came`);
}

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'buddi-live-'));
  dirs.push(dir);
  const env = { BUDDI_DATA_DIR: dir, BUDDI_EXTENSION_DIR: path.join(dir, 'extension') };
  const extension = new ExtensionEndpoint({ env });
  const driver = new ExtensionDriver(extension);
  const session = { id: 'page-1', agentId: 'concierge', conversationId: 'c1', requestId: 'r1', task: 'Orders', expiresAt: new Date(Date.now() + 60_000).toISOString(), steps: 1, maxSteps: 80 };
  let state: BrowserStatus['state'] = 'running';
  const fronted: string[] = [];
  const status = (): BrowserStatus => ({ state, enabled: true, busy: false, hasScreenshot: !!driver.livePicture(), route: 'chrome', session: { ...session, route: 'chrome' } as never });
  // The host controller around one page in the owner's Chrome, with the driver's own hand.
  const browser: BrowserController = {
    enable: async () => {}, shutdown: async () => {}, status,
    screenshot: () => driver.livePicture(), execute: async () => ({}), secretFill: async () => ({}), secretType: async () => ({}),
    control: async (action) => { state = action === 'takeover' ? 'paused' : 'running'; return status(); },
    hand: () => (state === 'paused' ? { supported: true, hand: driver.hand } : { supported: true, message: 'Take over first, then you can drive.' }),
    front: async (sessionId) => { fronted.push(sessionId); return { ...status(), held: { by: 'owner', where: 'chrome' } }; },
  };
  const app = await startWebServer({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } as never,
    registry: new ToolRegistry(), catalog: {} as AgentCatalog, ctx: { ownerId: 'owner' } as CoreToolContext,
    timezone: 'UTC', now: () => new Date(), config: { enabled: true, host: '127.0.0.1', port: 0 },
    openAccess: true, token: TOKEN, env, extension, browser });
  servers.push(app);
  const origin = `http://127.0.0.1:${app.port}`;
  const res = await fetch(`${origin}/api/session`, { redirect: 'manual' });
  const pairs = res.headers.getSetCookie().map((line) => line.split(';')[0]!);
  const csrf = pairs.find((p) => p.startsWith(`${csrfCookieName(app.port)}=`))?.slice(`${csrfCookieName(app.port)}=`.length) ?? '';
  const headers = { Cookie: pairs.join('; '), 'X-Buddi-CSRF': csrf, Origin: origin, 'Content-Type': 'application/json' };
  return { app, dir, extension, driver, session, origin, csrf, headers, fronted, socketUrl: `ws://127.0.0.1:${app.port}/api/extension/socket`, handUrl: `ws://127.0.0.1:${app.port}/api/browser/hand` };
}

/** A fake live extension: pairs, answers every command, and paints frames as bytes. */
async function liveExtension(socketUrl: string, origin: string, headers: Record<string, string>, answers: Record<string, Record<string, unknown>> = {}) {
  const socket = new WebSocket(socketUrl, { headers: { Origin: ORIGIN } });
  sockets.push(socket);
  const seen: Array<Record<string, unknown>> = [];
  socket.on('message', (data) => {
    const frame = JSON.parse(String(data)) as Record<string, unknown>;
    seen.push(frame);
    if (frame.type === 'command') socket.send(JSON.stringify({ type: 'result', id: frame.id, ok: true, observation: null, screenshot: null, ...(answers[String(frame.name)] ?? {}) }));
  });
  await new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'hello', extension: '0.1.0.49', nonce: 'nonce-live', paired: false, features: ['live', 'made-up'] }));
  const pair = await until(() => seen.find((f) => f.type === 'pair'), 'the pairing code');
  await fetch(`${origin}/api/extension/pair`, { method: 'POST', headers, body: JSON.stringify({ code: String(pair.code) }) });
  const paired = await until(() => seen.find((f) => f.type === 'paired'), 'paired');
  const commands = () => seen.filter((f) => f.type === 'command') as Array<{ name: string; session: string; args: Record<string, unknown>; owner?: boolean }>;
  return { socket, seen, paired, commands, paint: (session: string, jpeg: string) => socket.send(packed(session, jpeg)) };
}

/** A dashboard tab's hand socket. */
function dashboard(url: string, headers: Record<string, string>) {
  const socket = new WebSocket(url, { headers: { Cookie: headers.Cookie!, Origin: headers.Origin! } });
  sockets.push(socket);
  const seen: Array<Record<string, unknown>> = [];
  const pictures: Array<{ metadata: Record<string, unknown>; jpeg: string }> = [];
  socket.on('message', (data, isBinary) => {
    if (isBinary) pictures.push(unpack(data as Buffer));
    else seen.push(JSON.parse(String(data)) as Record<string, unknown>);
  });
  const open = new Promise<void>((resolve, reject) => { socket.once('open', () => resolve()); socket.once('error', reject); });
  return { socket, seen, pictures, open, send: (frame: unknown) => socket.send(JSON.stringify(frame)) };
}

describe('your Chrome, live', () => {
  it('pairs a live extension: says its name and what it reads, believes only what it knows', async () => {
    const { socketUrl, origin, headers, extension, dir } = await setup();
    const fake = await liveExtension(socketUrl, origin, headers);
    expect(fake.paired).toMatchObject({ name: path.basename(dir), features: [...GATEWAY_FEATURES] });
    expect(instanceName({ BUDDI_DATA_DIR: dir })).toBe(path.basename(dir));
    expect(instanceName({ BUDDI_DATA_DIR: '/tmp/somewhere/else' })).toBe('buddi');
    expect(extension.supports('live')).toBe(true);
    expect(extension.supports('made-up')).toBe(false);
    const view = await (await fetch(`${origin}/api/extension`, { headers })).json() as Record<string, unknown>;
    expect(view).toMatchObject({ connected: true, live: true, name: path.basename(dir) });
  });

  it('carries the extension’s binary frames to the Canvas picture and to the owner’s hand, and the hand’s input and copy back', async () => {
    const { socketUrl, origin, headers, driver, session, csrf, handUrl } = await setup();
    const fake = await liveExtension(socketUrl, origin, headers, { copy: { observation: { copied: 'Order 4711' } } });

    // The agent opens the page: the extension is asked to paint it for the Canvas.
    await driver.perform({ action: 'navigate', url: 'https://shop.test/orders' } as never);
    expect(fake.commands().map((command) => command.name)).toEqual(['navigate', 'screencast.start']);
    expect(fake.commands()[1]!.args).toMatchObject({ watch: true, interval: 500 });

    fake.paint(driver.session, 'canvas-jpeg');
    fake.paint('someone-else', 'not-ours');
    await vi.waitFor(() => expect(driver.livePicture()?.toString()).toBe('canvas-jpeg'));

    // Take over: the hand is offered as for buddi's own browser.
    const taken = await (await fetch(`${origin}/api/browser/takeover`, { method: 'POST', headers, body: JSON.stringify({ sessionId: session.id }) })).json() as Record<string, unknown>;
    expect(taken).toMatchObject({ hand: true, state: 'paused' });
    const tab = dashboard(handUrl, headers);
    await tab.open;
    tab.send({ type: 'hello', csrf, sessionId: session.id });
    await until(() => tab.seen.find((f) => f.type === 'driving'), 'driving');
    // The hand's own screencast, ten a second, no watching flag.
    const handCast = await until(() => fake.commands().filter((c) => c.name === 'screencast.start').at(1), 'the hand screencast');
    expect(handCast.args).toMatchObject({ maxWidth: 960, maxHeight: 600, quality: 50, everyNthFrame: 1 });
    expect(handCast.args['watch']).toBeUndefined();

    // The first picture is the last one the Canvas had; then the extension's own, with its level and address.
    fake.paint(driver.session, 'hand-jpeg');
    await vi.waitFor(() => expect(tab.pictures.map((p) => p.jpeg)).toContain('hand-jpeg'));
    const picture = tab.pictures.find((p) => p.jpeg === 'hand-jpeg')!;
    expect(picture.metadata).toMatchObject({ deviceWidth: 1280, scrollOffsetY: 12, url: 'https://shop.test/orders', level: 'normal' });
    expect(tab.pictures.some((p) => p.jpeg === 'not-ours')).toBe(false);

    tab.send({ type: 'input', input: { kind: 'mouse', type: 'mousePressed', x: 30, y: 40, button: 'left', clickCount: 1, modifiers: 0 } });
    const input = await until(() => fake.commands().find((c) => c.name === 'input'), 'the input');
    expect(input).toMatchObject({ owner: true, args: { kind: 'mouse', type: 'mousePressed', x: 30, y: 40 } });
    tab.send({ type: 'input', input: { kind: 'copy' } });
    expect(await until(() => tab.seen.find((f) => f.type === 'clipboard'), 'the clipboard')).toEqual({ type: 'clipboard', text: 'Order 4711' });

    // Bring the tab to the front: the hand ends here, the page is held there.
    const before = fake.commands().length;
    const front = await fetch(`${origin}/api/browser/front`, { method: 'POST', headers, body: JSON.stringify({ sessionId: session.id }) });
    expect(front.status).toBe(200);
    expect(await front.json()).toMatchObject({ hand: false, held: { by: 'owner', where: 'chrome' } });
    await until(() => tab.seen.find((f) => f.type === 'ended'), 'the hand ending');
    // Given back to watching, so the Canvas keeps its picture.
    const after = await until(() => fake.commands().slice(before).find((c) => c.name === 'screencast.start'), 'watching again');
    expect(after.args).toMatchObject({ watch: true });
  });

  it('reads a binary frame strictly, and ignores one from a socket that is not paired', async () => {
    expect(readExtensionFrame(packed('s1', 'jpeg'))).toMatchObject({ session: 's1', frame: { metadata: { deviceWidth: 1280, url: 'https://shop.test/orders' } } });
    expect(readExtensionFrame(packed('s1', 'jpeg', { url: 'javascript:alert(1)' }))!.frame.metadata.url).toBeUndefined();
    expect(readExtensionFrame(Buffer.from([2, 0, 2, 0x7b, 0x7d, 0xff]))).toBeUndefined();
    expect(readExtensionFrame(packed('', 'jpeg'))).toBeUndefined();
    expect(readExtensionFrame(Buffer.concat([Buffer.from([1, 0, 4]), Buffer.from('nope'), Buffer.from('x')]))).toBeUndefined();

    const { socketUrl, extension } = await setup();
    const stranger = new WebSocket(socketUrl, { headers: { Origin: ORIGIN } });
    sockets.push(stranger);
    await new Promise<void>((resolve) => stranger.once('open', () => resolve()));
    const heard: string[] = [];
    extension.frames('s1', (frame) => heard.push(frame.jpeg.toString()));
    stranger.send(packed('s1', 'sneaky'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(heard).toEqual([]);
    // Bytes are not a reason to drop the socket; they are simply not believed.
    expect(stranger.readyState).toBe(WebSocket.OPEN);
  });
});
