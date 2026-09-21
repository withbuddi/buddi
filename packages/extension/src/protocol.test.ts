/** The handshake, the pairing dance and the error mapping, with no Chrome and no socket. */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ChromeLike } from './chrome.js';
import { Cancellation, CancelledError, PreconditionError, Protocol, proofFor, sentence, type Command, type CommandResult } from './protocol.js';

function fakeChrome(initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(initial));
  const chrome: Pick<ChromeLike, 'storage'> = {
    storage: {
      local: {
        async get(keys) { return Object.fromEntries(keys.filter((key) => store.has(key)).map((key) => [key, store.get(key)])); },
        async set(items) { for (const [key, value] of Object.entries(items)) store.set(key, value); },
        async remove(keys) { for (const key of keys) store.delete(key); },
      },
    },
  };
  return { chrome, store };
}

/** What a gateway holding that token would sign this socket's nonce with. */
async function proofOf(token: string, nonce: unknown): Promise<string> {
  return proofFor(createHash('sha256').update(token).digest('hex'), String(nonce));
}

function harness(options: { stored?: Record<string, unknown>; execute?: (command: Command, cancel: Cancellation) => Promise<CommandResult>; onReset?: () => void } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const { chrome, store } = fakeChrome(options.stored);
  const execute = vi.fn(options.execute ?? (async () => ({})));
  const disconnect = vi.fn();
  const protocol = new Protocol({
    chrome, version: '0.1.0', send: (frame) => { sent.push(frame as Record<string, unknown>); },
    execute, disconnect, ...(options.onReset ? { onReset: options.onReset } : {}),
  });
  return { protocol, sent, store, execute, disconnect };
}

/** A protocol that has already been through the handshake, for the command tests. */
async function paired(options: Parameters<typeof harness>[0] = {}) {
  const context = harness(options);
  await context.protocol.receive(JSON.stringify({ type: 'paired', token: 'granted', installation: 'buddi' }));
  context.sent.length = 0;
  return context;
}

describe('the handshake', () => {
  it('says hello with a nonce and never with the token', async () => {
    const { protocol, sent } = harness();
    await protocol.open();
    expect(sent[0]).toMatchObject({ type: 'hello', extension: '0.1.0', paired: false });
    expect(String(sent[0]!['nonce'])).toMatch(/^[\w-]{20,}$/);
    expect(JSON.stringify(sent)).not.toContain('token');
    expect(protocol.state().connection).toBe('connecting');
  });

  it('says it holds a token, but still does not send it', async () => {
    const { protocol, sent } = harness({ stored: { token: 'kept' } });
    await protocol.open();
    expect(sent[0]).toMatchObject({ paired: true });
    expect(sent[0]!['token']).toBeUndefined();
  });

  it('sends the token only after the gateway has signed the nonce with it', async () => {
    const { protocol, sent, execute } = harness({ stored: { token: 'kept' } });
    await protocol.open();
    const nonce = sent[0]!['nonce'];
    // A command before the handshake finishes is refused, not run.
    await protocol.receive(JSON.stringify({ type: 'command', id: 'early', name: 'observe', session: 's1', args: {} }));
    expect(execute).not.toHaveBeenCalled();
    expect(sent[1]).toMatchObject({ id: 'early', ok: false, precondition: true });
    expect(protocol.authenticated()).toBe(false);

    await protocol.receive(JSON.stringify({ type: 'challenge', proof: await proofOf('kept', nonce), installation: '127.0.0.1:4317' }));
    expect(sent[2]).toEqual({ type: 'auth', token: 'kept' });
    expect(protocol.authenticated()).toBe(false);
    await protocol.receive(JSON.stringify({ type: 'paired', installation: '127.0.0.1:4317' }));
    expect(protocol.authenticated()).toBe(true);
    await protocol.receive(JSON.stringify({ type: 'command', id: 'c1', name: 'observe', session: 's1', args: {} }));
    expect(execute).toHaveBeenCalled();
  });

  it('keeps the token to itself when the gateway cannot prove it holds it', async () => {
    const { protocol, sent, disconnect } = harness({ stored: { token: 'kept' } });
    await protocol.open();
    await protocol.receive(JSON.stringify({ type: 'challenge', proof: await proofOf('another buddi', sent[0]!['nonce']) }));
    expect(JSON.stringify(sent)).not.toContain('auth');
    expect(disconnect).toHaveBeenCalled();
    expect(protocol.authenticated()).toBe(false);
    expect(protocol.state().error).toMatch(/could not prove/);
  });

  it('starts the handshake over, with a new nonce, when the gateway says to', async () => {
    const { protocol, sent } = harness({ stored: { token: 'kept' } });
    await protocol.open();
    await protocol.receive(JSON.stringify({ type: 'rehello', reason: 'too many wrong codes' }));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ type: 'hello', paired: true });
    expect(sent[1]!['nonce']).not.toBe(sent[0]!['nonce']);
  });

  it('shows the pairing code the gateway asks for', async () => {
    const { protocol } = harness();
    await protocol.receive(JSON.stringify({ type: 'pair', code: '482 913' }));
    expect(protocol.state()).toMatchObject({ connection: 'pairing', code: '482 913' });
  });

  it('stores the token the gateway grants and reports the installation', async () => {
    const { protocol, store } = harness();
    await protocol.receive(JSON.stringify({ type: 'pair', code: '482 913' }));
    await protocol.receive(JSON.stringify({ type: 'paired', token: 'granted', installation: 'buddi on 4317' }));
    expect(store.get('token')).toBe('granted');
    expect(protocol.state()).toMatchObject({ connection: 'paired', code: null, installation: 'buddi on 4317' });
    // The owner typed the code on this socket: that is the proof, and commands run.
    expect(protocol.authenticated()).toBe(true);
  });

  it('keeps the stored token when a paired frame carries none', async () => {
    const { protocol, store } = harness({ stored: { token: 'kept' } });
    await protocol.receive(JSON.stringify({ type: 'paired', installation: 'buddi' }));
    expect(store.get('token')).toBe('kept');
  });

  it('forgets the token and drops the socket when the owner unpairs', async () => {
    const { protocol, store, disconnect } = harness({ stored: { token: 'kept' } });
    await protocol.forget();
    expect(store.has('token')).toBe(false);
    expect(disconnect).toHaveBeenCalled();
    expect(protocol.state().connection).toBe('offline');
  });

  it('runs the very first command, even while the token is still being written', async () => {
    // The owner types the code and the first action follows immediately. What
    // authenticates this socket is the frame, not the disk write it starts.
    const { chrome, store } = fakeChrome();
    let finishWrite = () => {};
    const written = new Promise<void>((resolve) => { finishWrite = resolve; });
    const slow = { ...chrome, storage: { local: { ...chrome.storage.local,
      set: async (items: Record<string, unknown>) => { await written; await chrome.storage.local.set(items); } } } };
    const sent: Array<Record<string, unknown>> = [];
    const execute = vi.fn(async () => ({}));
    const protocol = new Protocol({ chrome: slow, version: '0.1.0', send: (frame) => { sent.push(frame as Record<string, unknown>); }, execute });

    const pairing = protocol.receive(JSON.stringify({ type: 'paired', token: 'granted', installation: 'buddi' }));
    await protocol.receive(JSON.stringify({ type: 'command', id: 'first', name: 'observe', session: 's1', args: {} }));
    expect(execute).toHaveBeenCalled();
    expect(sent[0]).toMatchObject({ id: 'first', ok: true });
    finishWrite();
    await pairing;
    expect(store.get('token')).toBe('granted');
  });

  it('answers a ping with a pong', async () => {
    const { protocol, sent } = harness();
    await protocol.receive(JSON.stringify({ type: 'ping' }));
    expect(sent).toEqual([{ type: 'pong' }]);
  });

  it('ignores a frame that is not JSON, and one whose type it does not know', async () => {
    const { protocol, sent } = harness();
    await protocol.receive('not json at all');
    await protocol.receive(JSON.stringify({ type: 'whatever' }));
    expect(sent).toEqual([]);
  });
});

describe('commands', () => {
  it('answers with the observation the executor produced', async () => {
    const observation = { id: 'o1', url: 'https://example.test/', title: 'T', tree: '- link "Home" [ref=e1]', tabs: [], capturedAt: '2026-09-21T00:00:00.000Z' };
    const { protocol, sent, execute } = await paired({ execute: async () => ({ observation, screenshot: 'AAAA' }) });
    await protocol.receive(JSON.stringify({ type: 'command', id: 'c1', name: 'observe', session: 's1', args: {} }));
    expect(execute).toHaveBeenCalledWith({ id: 'c1', name: 'observe', session: 's1', args: {}, owner: false }, expect.any(Cancellation));
    expect(sent).toEqual([{ type: 'result', id: 'c1', ok: true, observation, screenshot: 'AAAA' }]);
  });

  it('answers a command that observes nothing with nulls, not with absences', async () => {
    const { protocol, sent } = await paired();
    await protocol.receive(JSON.stringify({ type: 'command', id: 'c2', name: 'click', session: 's1', args: { target: { ref: 'e1' } } }));
    expect(sent).toEqual([{ type: 'result', id: 'c2', ok: true, observation: null, screenshot: null }]);
  });

  it('hands a semantic target to the executor exactly as the gateway wrote it', async () => {
    const { protocol, execute } = await paired();
    const target = { by: 'role', role: 'link', name: 'Sign in', frame: 0 };
    await protocol.receive(JSON.stringify({ type: 'command', id: 'c7', name: 'click', session: 's1', args: { target } }));
    expect(execute).toHaveBeenCalledWith({ id: 'c7', name: 'click', session: 's1', args: { target }, owner: false }, expect.any(Cancellation));
  });

  it('knows the hand commands and carries the owner flag through to the executor', async () => {
    const { protocol, sent, execute } = await paired();
    for (const name of ['screencast.start', 'screencast.stop', 'input']) {
      await protocol.receive(JSON.stringify({ type: 'command', id: `h-${name}`, name, session: 's1', args: { kind: 'mouse' }, owner: true }));
      expect(execute).toHaveBeenCalledWith({ id: `h-${name}`, name, session: 's1', args: { kind: 'mouse' }, owner: true }, expect.any(Cancellation));
    }
    expect(sent.every((frame) => (frame as { ok?: boolean }).ok === true)).toBe(true);
  });

  it('marks a precondition refusal so the gateway can reconsider instead of retrying', async () => {
    const { protocol, sent } = await paired({ execute: async () => { throw new PreconditionError('The referenced element changed or disappeared.'); } });
    await protocol.receive(JSON.stringify({ type: 'command', id: 'c3', name: 'click', session: 's1', args: {} }));
    expect(sent[0]).toEqual({ type: 'result', id: 'c3', ok: false, error: 'The referenced element changed or disappeared.', precondition: true });
  });

  it('reports any other failure as a plain sentence, without a precondition', async () => {
    const { protocol, sent } = await paired({ execute: async () => { throw new Error('the tab crashed'); } });
    await protocol.receive(JSON.stringify({ type: 'command', id: 'c4', name: 'navigate', session: 's1', args: { url: 'https://example.test/' } }));
    expect(sent[0]).toEqual({ type: 'result', id: 'c4', ok: false, error: 'the tab crashed.', precondition: false });
  });

  it('refuses a command it does not know and one with no session, before dispatching anything', async () => {
    const { protocol, sent, execute } = await paired();
    await protocol.receive(JSON.stringify({ type: 'command', id: 'c5', name: 'open', session: 's1', args: {} }));
    await protocol.receive(JSON.stringify({ type: 'command', id: 'c6', name: 'observe', args: {} }));
    expect(execute).not.toHaveBeenCalled();
    expect(sent.map((frame) => frame['precondition'])).toEqual([true, true]);
  });

  it('has nothing to answer when a command arrives without an id', async () => {
    const { protocol, sent } = await paired();
    await protocol.receive(JSON.stringify({ type: 'command', name: 'observe', session: 's1' }));
    expect(sent).toEqual([]);
  });
});

describe('cancelling', () => {
  it('stops a running command and says nothing was dispatched', async () => {
    let seen: Cancellation | undefined;
    let release = () => {};
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const { protocol, sent } = await paired({ execute: async (_command, cancel) => {
      seen = cancel;
      await waiting;
      cancel.check();
      return {};
    } });
    const running = protocol.receive(JSON.stringify({ type: 'command', id: 'c8', name: 'click', session: 's1', args: {} }));
    await protocol.receive(JSON.stringify({ type: 'cancel', id: 'c8' }));
    expect(seen!.cancelled).toBe(true);
    release();
    await running;
    expect(sent).toEqual([{ type: 'result', id: 'c8', ok: false, error: 'cancelled', precondition: true }]);
  });

  it('says something may have happened when the executor had already dispatched', async () => {
    const { protocol, sent } = await paired({ execute: async (_command, cancel) => {
      cancel.dispatch();
      cancel.cancel();
      throw new CancelledError('cancelled');
    } });
    await protocol.receive(JSON.stringify({ type: 'command', id: 'c9', name: 'click', session: 's1', args: {} }));
    expect(sent).toEqual([{ type: 'result', id: 'c9', ok: false, error: 'cancelled', precondition: false }]);
  });

  it('cancels whatever was running when the socket closes, and forgets the sessions', async () => {
    const reset = vi.fn();
    let seen: Cancellation | undefined;
    let release = () => {};
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const { protocol, sent } = await paired({ execute: async (_command, cancel) => { seen = cancel; await waiting; cancel.check(); return {}; }, onReset: reset });
    const running = protocol.receive(JSON.stringify({ type: 'command', id: 'c10', name: 'click', session: 's1', args: {} }));
    protocol.closed('Not connected to buddi.');
    expect(reset).toHaveBeenCalled();
    expect(seen!.cancelled).toBe(true);
    release();
    await running;
    expect(sent[0]).toMatchObject({ id: 'c10', ok: false, error: 'cancelled' });
  });
});

describe('sentence', () => {
  it('ends a message the owner will read', () => {
    expect(sentence(new Error('nothing there'))).toBe('nothing there.');
    expect(sentence(new Error('Nothing there!'))).toBe('Nothing there!');
    expect(sentence(new Error('  '))).toBe('The browser extension could not run that command.');
  });
});
