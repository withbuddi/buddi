/*
 * The worker's one way out, with a fake socket under it.
 *
 * The bug this pins down is a real one the owner hit: a reload left a socket in
 * CONNECTING while a pong, a `bye` and a screencast that outlived the last
 * socket all tried to go out, and `send` threw where nobody was catching. So
 * these tests drive `background.ts` itself — the module's own `send`, its own
 * reconnect — rather than a copy of the rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  /** Every socket the worker has opened, in order. */
  static live: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
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
  send(text: string): void {
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
  types(): string[] { return this.sent.map((text) => String((JSON.parse(text) as { type?: unknown }).type)); }
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
  tabs: {}, tabGroups: {}, windows: {}, scripting: {},
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

type Worker = typeof import('./background.js');

async function load(): Promise<Worker> {
  vi.resetModules();
  const worker = (await import('./background.js')) as Worker;
  await settle();
  return worker;
}

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
});

afterEach(() => {
  process.off('unhandledRejection', onRejection);
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as Record<string, unknown>)['chrome'];
  delete (globalThis as Record<string, unknown>)['WebSocket'];
});

describe('sending while the socket is still connecting', () => {
  it('queues the frames the gateway is waiting on and flushes them, in order, on open', async () => {
    const worker = await load();
    const socket = FakeSocket.live[0]!;
    expect(socket.readyState).toBe(FakeSocket.CONNECTING);

    expect(() => {
      worker.send({ type: 'result', id: 'r1', ok: true });
      worker.send({ type: 'auth', token: 'kept' });
    }).not.toThrow();
    // Nothing may reach a socket that has not finished connecting.
    expect(socket.sent).toEqual([]);

    socket.opened();
    await settle();
    // The queue goes out first and in order; the handshake's own hello follows.
    expect(socket.types()).toEqual(['result', 'auth', 'hello']);
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ id: 'r1', ok: true });
  });

  it('drops a pong and a screencast frame rather than holding a stale one', async () => {
    const worker = await load();
    const socket = FakeSocket.live[0]!;
    worker.send({ type: 'pong' });
    worker.send({ type: 'frame', session: 's1', data: 'jpeg', metadata: {}, sessionId: 1 });
    socket.opened();
    await settle();
    expect(socket.types()).toEqual(['hello']);
  });

  it('throws nothing when there is no socket at all', async () => {
    const worker = await load();
    FakeSocket.live[0]!.close();
    await settle();
    expect(() => worker.send({ type: 'result', id: 'r1', ok: true })).not.toThrow();
  });

  it('discards the queue when the socket errors before it opens', async () => {
    const worker = await load();
    const socket = FakeSocket.live[0]!;
    worker.send({ type: 'result', id: 'r1', ok: true });
    socket.failed();
    socket.opened();
    await settle();
    expect(socket.types()).toEqual(['hello']);
  });
});

describe('reconnecting', () => {
  it('drops a screencast frame that outlived the last socket instead of aiming it at the new one', async () => {
    const worker = await load();
    const first = FakeSocket.live[0]!;
    first.opened();
    await settle();
    first.sent.length = 0;

    first.close();
    await settle();
    await worker.connect();
    await settle();
    const second = FakeSocket.live[1]!;
    expect(second.readyState).toBe(FakeSocket.CONNECTING);

    // The screencast from the last socket paints one more frame.
    worker.send({ type: 'frame', session: 's1', data: 'jpeg', metadata: {}, sessionId: 2 });
    second.opened();
    await settle();

    expect(second.types()).toEqual(['hello']);
    expect(first.sent).toEqual([]);
  });
});

describe('promises in the worker', () => {
  it('logs one reason and leaves nothing uncaught when the handshake fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const worker = await load();
    const socket = FakeSocket.live[0]!;
    // The handshake reads the token, and the worker outlives a storage that
    // will not answer: the socket stays up and the worker says so once.
    getFails = true;
    socket.opened();
    await settle();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('buddi'));
    expect(rejections).toEqual([]);
    expect(typeof worker.connect).toBe('function');
  });

  it('survives a gateway address it cannot even read', async () => {
    getFails = true;
    const worker = await load();
    await worker.connect();
    await settle();
    expect(rejections).toEqual([]);
  });

  it('leaves nothing uncaught over a whole connect, drop and reconnect', async () => {
    const worker = await load();
    const first = FakeSocket.live[0]!;
    first.opened();
    await settle();
    first.close();
    await settle();
    await worker.connect();
    FakeSocket.live[1]!.opened();
    await settle();
    expect(rejections).toEqual([]);
  });
});
