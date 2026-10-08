/*
 * The worker with several buddis: one socket per buddi switched on, the old
 * single pairing kept as the first, and the popup's messages doing what they
 * say. A fake socket and a fake storage; no Chrome, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static live: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  binaryType = 'blob';
  sent: string[] = [];
  #listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(readonly url: string) { FakeSocket.live.push(this); }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn]);
  }
  #emit(type: string, event: unknown = {}): void { for (const fn of this.#listeners.get(type) ?? []) fn(event); }
  send(text: string): void { if (this.readyState !== FakeSocket.OPEN) throw new Error('not open'); this.sent.push(text); }
  close(): void { if (this.readyState === FakeSocket.CLOSED) return; this.readyState = FakeSocket.CLOSED; this.#emit('close'); }
  opened(): void { this.readyState = FakeSocket.OPEN; this.#emit('open'); }
  hear(frame: unknown): void { this.#emit('message', { data: JSON.stringify(frame) }); }
}

const store = new Map<string, unknown>();
const noListener = { addListener: () => undefined };
let onMessage: ((message: unknown, sender: unknown, respond: (answer: unknown) => void) => boolean | void) | undefined;
let onExternal: ((message: unknown, sender: { origin?: string }, respond: (answer: unknown) => void) => boolean | void) | undefined;
const chrome = {
  storage: {
    local: {
      get: async (keys: string[]) => Object.fromEntries(keys.filter((key) => store.has(key)).map((key) => [key, structuredClone(store.get(key))])),
      set: async (items: Record<string, unknown>) => { for (const [key, value] of Object.entries(items)) store.set(key, structuredClone(value)); },
      remove: async (keys: string[]) => { for (const key of keys) store.delete(key); },
    },
  },
  tabs: { onRemoved: noListener, onUpdated: noListener, get: async () => { throw new Error('no tab'); } },
  tabGroups: { update: async () => ({}) }, windows: {}, scripting: {},
  debugger: { onEvent: noListener, onDetach: noListener },
  alarms: { create: () => undefined, onAlarm: noListener },
  runtime: {
    getManifest: () => ({ version: '0.1.0' }),
    onMessage: { addListener: (fn: typeof onMessage) => { onMessage = fn; } },
    onMessageExternal: { addListener: (fn: typeof onExternal) => { onExternal = fn; } },
    onInstalled: noListener, onStartup: noListener,
    sendMessage: async () => undefined,
  },
};

const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

async function load(): Promise<typeof import('./background.js')> {
  vi.resetModules();
  const worker = await import('./background.js');
  await settle();
  return worker;
}

/** What the popup would send, answered the way the worker answers it. */
async function popup<T>(message: unknown): Promise<T> {
  let answer: unknown;
  onMessage!(message, {}, (value) => { answer = value; });
  await vi.waitFor(() => expect(answer).toBeDefined());
  return answer as T;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.live = [];
  store.clear();
  (globalThis as Record<string, unknown>)['chrome'] = chrome;
  (globalThis as Record<string, unknown>)['WebSocket'] = FakeSocket;
  (globalThis as Record<string, unknown>)['fetch'] = vi.fn(async () => new Response('{}', { status: 200 }));
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>)['chrome'];
  delete (globalThis as Record<string, unknown>)['WebSocket'];
  delete (globalThis as Record<string, unknown>)['fetch'];
});

describe('one extension, several buddis', () => {
  it('keeps the pairing it had as the first buddi, switched on, and connects to it with its token', async () => {
    store.set('gateway', 'http://127.0.0.1:4327');
    store.set('token', 'kept');
    await load();
    expect(FakeSocket.live.map((socket) => socket.url)).toEqual(['ws://127.0.0.1:4327/api/extension/socket']);
    const pairings = store.get('pairings') as Array<Record<string, unknown>>;
    expect(pairings).toHaveLength(1);
    expect(pairings[0]).toMatchObject({ origin: 'http://127.0.0.1:4327', token: 'kept', enabled: true });
    expect(store.has('gateway')).toBe(false);
    expect(store.has('token')).toBe(false);
    FakeSocket.live[0]!.opened();
    await settle();
    expect(JSON.parse(FakeSocket.live[0]!.sent[0]!)).toMatchObject({ type: 'hello', paired: true, features: ['live'] });
  });

  it('opens one socket per buddi switched on, and closes the one switched off', async () => {
    await load();
    expect(FakeSocket.live).toHaveLength(1);
    const added = await popup<{ pairings: Array<{ id: string; origin: string; colour: string }> }>({ type: 'buddi-add', gateway: 'http://localhost:4327' });
    expect(added.pairings.map((entry) => entry.origin)).toEqual(['http://127.0.0.1:4317', 'http://localhost:4327']);
    // A second buddi gets a colour of its own.
    expect(new Set(added.pairings.map((entry) => entry.colour)).size).toBe(2);
    expect(FakeSocket.live.map((socket) => socket.url)).toContain('ws://localhost:4327/api/extension/socket');
    const dev = FakeSocket.live.find((socket) => socket.url.includes('4327'))!;
    const release = FakeSocket.live.find((socket) => socket.url.includes('4317'))!;

    await popup({ type: 'buddi-enable', id: added.pairings[1]!.id, enabled: false });
    expect(dev.readyState).toBe(FakeSocket.CLOSED);
    expect(release.readyState).not.toBe(FakeSocket.CLOSED);
    // Switched off stays off: the reconnect timer does not bring it back.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.live.filter((socket) => socket.url.includes('4327') && socket.readyState !== FakeSocket.CLOSED)).toHaveLength(0);

    // Adding the same buddi again, by another loopback name, is the same entry switched back on.
    const again = await popup<{ pairings: Array<{ enabled: boolean }> }>({ type: 'buddi-add', gateway: 'http://127.0.0.1:4327' });
    expect(again.pairings).toHaveLength(2);
    expect(again.pairings.every((entry) => entry.enabled)).toBe(true);
  });

  it('refuses an address that is not on this machine, and removes a buddi with its token', async () => {
    await load();
    expect(await popup({ type: 'buddi-add', gateway: 'https://example.com' })).toEqual({ error: 'A buddi address has to be on this machine.' });
    const list = await popup<{ pairings: Array<{ id: string }> }>({ type: 'buddi-get-state' });
    await popup({ type: 'buddi-remove', id: list.pairings[0]!.id });
    expect(store.get('pairings')).toEqual([]);
    expect(FakeSocket.live[0]!.readyState).toBe(FakeSocket.CLOSED);
  });

  it('names each buddi by what it said in its handshake, and answers each dashboard for itself', async () => {
    await load();
    await popup({ type: 'buddi-add', gateway: 'http://127.0.0.1:4327' });
    const dev = FakeSocket.live.find((socket) => socket.url.includes('4327'))!;
    dev.opened();
    await settle();
    dev.hear({ type: 'pair', code: '482 913' });
    await settle();
    dev.hear({ type: 'paired', token: 'granted', installation: '127.0.0.1:4327', name: 'buddi-dev', features: ['frames.binary'] });
    await vi.waitFor(async () => {
      const list = await popup<{ pairings: Array<{ name: string; state: { connection: string } }> }>({ type: 'buddi-get-state' });
      expect(list.pairings[1]).toMatchObject({ name: 'buddi-dev', state: { connection: 'paired' } });
    });
    let answer: Record<string, unknown> | undefined;
    onExternal!({ type: 'buddi.status' }, { origin: 'http://127.0.0.1:4327' }, (value) => { answer = value as Record<string, unknown>; });
    await vi.waitFor(() => expect(answer).toBeDefined());
    expect(answer).toMatchObject({ state: 'paired', gateway: 'http://127.0.0.1:4327' });
    expect((answer!['pairings'] as unknown[]).length).toBe(2);
    // A dashboard nobody added is offered in the popup's Add a buddi, never added by itself.
    onExternal!({ type: 'buddi.status' }, { origin: 'http://127.0.0.1:4391' }, () => undefined);
    await vi.waitFor(async () => expect((await popup<{ asked: string | null }>({ type: 'buddi-get-state' })).asked).toBe('http://127.0.0.1:4391'));
    expect((store.get('pairings') as unknown[]).length).toBe(2);
  });
});
