/** The handshake, the pairing dance and the error mapping, with no Chrome and no socket. */
import { describe, expect, it, vi } from 'vitest';
import type { ChromeLike } from './chrome.js';
import { PreconditionError, Protocol, sentence, type Command, type CommandResult } from './protocol.js';

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

function harness(options: { stored?: Record<string, unknown>; execute?: (command: Command) => Promise<CommandResult> } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const { chrome, store } = fakeChrome(options.stored);
  const execute = vi.fn(options.execute ?? (async () => ({})));
  const disconnect = vi.fn();
  const protocol = new Protocol({
    chrome, version: '0.1.0', send: (frame) => { sent.push(frame as Record<string, unknown>); },
    execute, disconnect,
  });
  return { protocol, sent, store, execute, disconnect };
}

describe('the handshake', () => {
  it('says hello with no token when this browser has never been paired', async () => {
    const { protocol, sent } = harness();
    await protocol.open();
    expect(sent).toEqual([{ type: 'hello', extension: '0.1.0', token: null }]);
    expect(protocol.state().connection).toBe('connecting');
  });

  it('says hello with the stored token afterwards', async () => {
    const { protocol, sent } = harness({ stored: { token: 'kept' } });
    await protocol.open();
    expect(sent[0]).toMatchObject({ token: 'kept' });
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
    const { protocol, sent, execute } = harness({ execute: async () => ({ observation, screenshot: 'AAAA' }) });
    await protocol.receive(JSON.stringify({ type: 'command', id: 'c1', name: 'observe', session: 's1', args: {} }));
    expect(execute).toHaveBeenCalledWith({ id: 'c1', name: 'observe', session: 's1', args: {} });
    expect(sent).toEqual([{ type: 'result', id: 'c1', ok: true, observation, screenshot: 'AAAA' }]);
  });

  it('answers a command that observes nothing with nulls, not with absences', async () => {
    const { protocol, sent } = harness();
    await protocol.receive(JSON.stringify({ type: 'command', id: 'c2', name: 'click', session: 's1', args: { target: { ref: 'e1' } } }));
    expect(sent).toEqual([{ type: 'result', id: 'c2', ok: true, observation: null, screenshot: null }]);
  });

  it('hands a semantic target to the executor exactly as the gateway wrote it', async () => {
    const { protocol, execute } = harness();
    const target = { by: 'role', role: 'link', name: 'Sign in', frame: 0 };
    await protocol.receive(JSON.stringify({ type: 'command', id: 'c7', name: 'click', session: 's1', args: { target } }));
    expect(execute).toHaveBeenCalledWith({ id: 'c7', name: 'click', session: 's1', args: { target } });
  });

  it('marks a precondition refusal so the gateway can reconsider instead of retrying', async () => {
    const { protocol, sent } = harness({ execute: async () => { throw new PreconditionError('The referenced element changed or disappeared.'); } });
    await protocol.receive(JSON.stringify({ type: 'command', id: 'c3', name: 'click', session: 's1', args: {} }));
    expect(sent[0]).toEqual({ type: 'result', id: 'c3', ok: false, error: 'The referenced element changed or disappeared.', precondition: true });
  });

  it('reports any other failure as a plain sentence, without a precondition', async () => {
    const { protocol, sent } = harness({ execute: async () => { throw new Error('the tab crashed'); } });
    await protocol.receive(JSON.stringify({ type: 'command', id: 'c4', name: 'navigate', session: 's1', args: { url: 'https://example.test/' } }));
    expect(sent[0]).toEqual({ type: 'result', id: 'c4', ok: false, error: 'the tab crashed.', precondition: false });
  });

  it('refuses a command it does not know and one with no session, before dispatching anything', async () => {
    const { protocol, sent, execute } = harness();
    await protocol.receive(JSON.stringify({ type: 'command', id: 'c5', name: 'open', session: 's1', args: {} }));
    await protocol.receive(JSON.stringify({ type: 'command', id: 'c6', name: 'observe', args: {} }));
    expect(execute).not.toHaveBeenCalled();
    expect(sent.map((frame) => frame['precondition'])).toEqual([true, true]);
  });

  it('has nothing to answer when a command arrives without an id', async () => {
    const { protocol, sent } = harness();
    await protocol.receive(JSON.stringify({ type: 'command', name: 'observe', session: 's1' }));
    expect(sent).toEqual([]);
  });
});

describe('sentence', () => {
  it('ends a message the owner will read', () => {
    expect(sentence(new Error('nothing there'))).toBe('nothing there.');
    expect(sentence(new Error('Nothing there!'))).toBe('Nothing there!');
    expect(sentence(new Error('  '))).toBe('The browser extension could not run that command.');
  });
});
