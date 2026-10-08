/*
 * One buddi's link: its one way out, with a fake socket under it.
 *
 * The bug this pins down is a real one the owner hit: a reload left a socket in
 * CONNECTING while a pong, a `bye` and a screencast that outlived the last
 * socket all tried to go out, and `send` threw where nobody was catching. So
 * these tests drive `link.ts` itself — its own `send`, its own reconnect —
 * rather than a copy of the rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerChrome } from './chrome.js';
import { unpackFrame } from './frames.js';
import { KEEPALIVE_MS, Link } from './link.js';
import { GroupRegistry, PairingStore } from './pairings.js';

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  /** Every socket the worker has opened, in order. */
  static live: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: Array<string | Uint8Array> = [];
  binaryType = 'blob';
  #listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(readonly url: string) { FakeSocket.live.push(this); }

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.#listeners.get(type) ?? [];
    list.push(fn);
    this.#listeners.set(type, list);
  }

  #emit(type: string, event: unknown = {}): void {
    for (const fn of this.#listeners.get(type) ?? []) fn(event);
  }

  /** Exactly what Chrome does: a send before the handshake is an InvalidStateError. */
  send(text: string | Uint8Array): void {
    if (this.readyState !== FakeSocket.OPEN) throw new Error("Failed to execute 'send' on 'WebSocket': Still in CONNECTING state");
    this.sent.push(text);
  }

  close(): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.#emit('close');
  }

  /* ---- the test's hand on the wire ---- */
  opened(): void { this.readyState = FakeSocket.OPEN; this.#emit('open'); }
  failed(): void { this.#emit('error'); }
  types(): string[] { return this.sent.map((text) => typeof text === 'string' ? String((JSON.parse(text) as { type?: unknown }).type) : 'binary'); }
  /** What the gateway says, as the socket would deliver it. */
  hear(frame: unknown): void { this.#emit('message', { data: JSON.stringify(frame) }); }
}

const store = new Map<string, unknown>();
let getFails = false;

const noListener = { addListener: () => undefined };
const chrome = {
  storage: {
    local: {
      get: async (keys: string[]) => {
        if (getFails) throw new Error('storage is gone');
        return Object.fromEntries(keys.filter((key) => store.has(key)).map((key) => [key, store.get(key)]));
      },
      set: async (items: Record<string, unknown>) => { for (const [key, value] of Object.entries(items)) store.set(key, value); },
      remove: async (keys: string[]) => { for (const key of keys) store.delete(key); },
    },
  },
  tabs: { onRemoved: noListener, onUpdated: noListener }, tabGroups: {}, windows: {}, scripting: {},
  debugger: { onEvent: noListener, onDetach: noListener },
  alarms: { create: () => undefined, onAlarm: noListener },
  runtime: {
    getManifest: () => ({ version: '0.1.0' }),
    onMessage: noListener, onMessageExternal: noListener, onInstalled: noListener, onStartup: noListener,
    sendMessage: async () => undefined,
  },
};

/** Let the worker's promises settle; nothing here waits on a timer. */
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

/** A link to the buddi at 4317, the way the worker makes one, connecting at once. */
async function load(): Promise<Link> {
  const pairings = new PairingStore(chrome.storage.local, { id: () => 'first' });
  const [entry] = await pairings.list();
  const link = new Link({ chrome: chrome as unknown as WorkerChrome, id: entry!.id, origin: entry!.origin, store: pairings, groups: new GroupRegistry(),
    version: '0.1.0', title: () => 'buddi', colour: () => 'blue', WebSocket: FakeSocket as unknown as typeof WebSocket });
  void link.connect();
  await settle();
  return link;
}

let knockAnswers = true;
const rejections: unknown[] = [];
const onRejection = (reason: unknown): void => { rejections.push(reason); };

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.live = [];
  store.clear();
  getFails = false;
  rejections.length = 0;
  process.on('unhandledRejection', onRejection);
  (globalThis as Record<string, unknown>)['chrome'] = chrome;
  (globalThis as Record<string, unknown>)['WebSocket'] = FakeSocket;
  // The reconnect knock. Never the real fetch: that would reach a real gateway.
  knockAnswers = true;
  (globalThis as Record<string, unknown>)['fetch'] = vi.fn(async () => {
    if (!knockAnswers) throw new TypeError('Failed to fetch');
    return new Response('{}', { status: 200 });
  });
});

afterEach(() => {
  process.off('unhandledRejection', onRejection);
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>)['chrome'];
  delete (globalThis as Record<string, unknown>)['WebSocket'];
  delete (globalThis as Record<string, unknown>)['fetch'];
});

describe('sending while the socket is still connecting', () => {
  it('queues the frames the gateway is waiting on and flushes them, in order, on open', async () => {
    const link = await load();
    const socket = FakeSocket.live[0]!;
    expect(socket.readyState).toBe(FakeSocket.CONNECTING);

    expect(() => {
      link.send({ type: 'result', id: 'r1', ok: true });
      link.send({ type: 'auth', token: 'kept' });
    }).not.toThrow();
    // Nothing may reach a socket that has not finished connecting.
    expect(socket.sent).toEqual([]);

    socket.opened();
    await settle();
    // The queue goes out first and in order; the handshake's own hello follows.
    expect(socket.types()).toEqual(['result', 'auth', 'hello']);
    expect(JSON.parse(socket.sent[0] as string)).toMatchObject({ id: 'r1', ok: true });
  });

  it('drops a pong and a screencast frame rather than holding a stale one', async () => {
    const link = await load();
    const socket = FakeSocket.live[0]!;
    link.send({ type: 'pong' });
    link.send({ type: 'frame', session: 's1', data: 'jpeg', metadata: {}, sessionId: 1 });
    socket.opened();
    await settle();
    expect(socket.types()).toEqual(['hello']);
  });

  it('throws nothing when there is no socket at all', async () => {
    const link = await load();
    FakeSocket.live[0]!.close();
    await settle();
    expect(() => link.send({ type: 'result', id: 'r1', ok: true })).not.toThrow();
  });

  it('discards the queue when the socket errors before it opens', async () => {
    const link = await load();
    const socket = FakeSocket.live[0]!;
    link.send({ type: 'result', id: 'r1', ok: true });
    socket.failed();
    socket.opened();
    await settle();
    expect(socket.types()).toEqual(['hello']);
  });
});

describe('reconnecting', () => {
  it('drops a screencast frame that outlived the last socket instead of aiming it at the new one', async () => {
    const link = await load();
    const first = FakeSocket.live[0]!;
    first.opened();
    await settle();
    first.sent.length = 0;

    first.close();
    await settle();
    await link.connect();
    await settle();
    const second = FakeSocket.live[1]!;
    expect(second.readyState).toBe(FakeSocket.CONNECTING);

    // The screencast from the last socket paints one more frame.
    link.send({ type: 'frame', session: 's1', data: 'jpeg', metadata: {}, sessionId: 2 });
    second.opened();
    await settle();

    expect(second.types()).toEqual(['hello']);
    expect(first.sent).toEqual([]);
  });
});

describe('promises in the worker', () => {
  it('logs one reason and leaves nothing uncaught when the handshake fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const link = await load();
    const socket = FakeSocket.live[0]!;
    // The handshake reads the token, and the worker outlives a storage that
    // will not answer: the socket stays up and the worker says so once.
    getFails = true;
    socket.opened();
    await settle();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('buddi'));
    expect(rejections).toEqual([]);
    expect(typeof link.connect).toBe('function');
  });


  it('knocks on the HTTP side before reconnecting, and opens no socket while nobody answers', async () => {
    const link = await load();
    const first = FakeSocket.live[0]!;
    first.opened();
    await settle();
    knockAnswers = false;
    first.close();
    await settle();
    await link.connect();
    await settle();
    // The knock said no: one socket ever, no refused WebSocket for Chrome to log.
    expect(FakeSocket.live).toHaveLength(1);
    expect((globalThis as unknown as { fetch: ReturnType<typeof vi.fn> }).fetch).toHaveBeenCalled();
    knockAnswers = true;
    await link.connect();
    await settle();
    expect(FakeSocket.live).toHaveLength(2);
    expect(rejections).toEqual([]);
  });

  it('leaves nothing uncaught over a whole connect, drop and reconnect', async () => {
    const link = await load();
    const first = FakeSocket.live[0]!;
    first.opened();
    await settle();
    first.close();
    await settle();
    await link.connect();
    FakeSocket.live[1]!.opened();
    await settle();
    expect(rejections).toEqual([]);
  });
});

describe('a fresh install waiting for its code', () => {
  /*
   * The bug the owner hit on a fresh pair: the popup showed "Pairing" and a
   * code, and buddi said no browser was waiting. A socket waiting for its code
   * heard nothing from the gateway, so Chrome stopped the idle worker after
   * thirty seconds and the socket went with it. The worker now speaks every
   * twenty seconds, which is what keeps it alive.
   */
  it('says hello with no token and keeps the socket busy while it waits', async () => {
    const link = await load();
    const socket = FakeSocket.live[0]!;
    expect(socket.url).toBe('ws://127.0.0.1:4317/api/extension/socket');
    socket.opened();
    await settle();
    expect(socket.types()).toEqual(['hello']);
    expect(JSON.parse(socket.sent[0] as string)).toMatchObject({ type: 'hello', paired: false });
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    expect(socket.types()).toEqual(['hello', 'keepalive']);
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS * 2);
    expect(socket.types().filter((type) => type === 'keepalive')).toHaveLength(3);
    // Gone: the interval goes with it, and nothing is sent at a dead socket.
    socket.close();
    await vi.advanceTimersByTimeAsync(KEEPALIVE_MS);
    expect(socket.types().filter((type) => type === 'keepalive')).toHaveLength(3);
    expect(rejections).toEqual([]);
  });
});

describe('screencast frames on the wire', () => {
  const frame = { type: 'frame' as const, session: 's1', data: btoa('jpeg-bytes'), metadata: { deviceWidth: 800, deviceHeight: 600 }, sessionId: 1, url: 'https://example.test/' };

  it('goes as one binary message to a gateway that reads them, as JSON to one that does not', async () => {
    const link = await load();
    const socket = FakeSocket.live[0]!;
    socket.opened();
    await settle();
    // Paired by a gateway that says nothing about frames: the old JSON frame.
    socket.hear({ type: 'paired', token: 't', installation: '127.0.0.1:4317' });
    await settle();
    socket.sent.length = 0;
    link.sendFrame(frame);
    expect(socket.types()).toEqual(['frame']);
    // A gateway that announced binary frames gets the bytes, in the layout the dashboard reads.
    socket.hear({ type: 'rehello' });
    await settle();
    socket.hear({ type: 'paired', installation: '127.0.0.1:4317', name: 'buddi', features: ['frames.binary'] });
    await settle();
    socket.sent.length = 0;
    link.sendFrame(frame);
    expect(socket.types()).toEqual(['binary']);
    const read = unpackFrame(socket.sent[0] as Uint8Array)!;
    expect(read.header).toEqual({ session: 's1', deviceWidth: 800, deviceHeight: 600, url: 'https://example.test/' });
    expect(new TextDecoder().decode(read.jpeg)).toBe('jpeg-bytes');
    expect(link.state().name).toBe('buddi');
  });
});
