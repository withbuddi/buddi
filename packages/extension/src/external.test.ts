/**
 * Who may ask this extension anything, and what it says back.
 *
 * The manifest names loopback origins, but a manifest is Chrome's business; the
 * rule is asserted here, against the handler itself, so that a mistake in
 * either place is a failing test rather than a browser that talks to a website.
 */
import { describe, expect, it, vi } from 'vitest';
import { describe as report, handleExternal, isLoopbackOrigin } from './external.js';
import type { ClientState } from './protocol.js';

const state = (over: Partial<ClientState> = {}): ClientState =>
  ({ connection: 'offline', code: null, installation: null, error: null, ...over });

const ask = async (origin: string | undefined, message: unknown, current = state()) => {
  const respond = vi.fn();
  const handled = handleExternal(message, { origin, state: () => current, gateway: async () => 'http://127.0.0.1:4317', version: '0.1.0' }, respond);
  await vi.waitFor(() => expect(handled ? respond.mock.calls.length : 0).toBe(handled ? 1 : 0));
  return { handled, answer: respond.mock.calls[0]?.[0] };
};

describe('the loopback origin check', () => {
  it('admits the dashboard on any loopback name and port, and nothing else', () => {
    for (const origin of ['http://127.0.0.1:4317', 'http://localhost:5173', 'http://[::1]:4317', 'https://localhost'])
      expect(isLoopbackOrigin(origin), origin).toBe(true);
    for (const origin of ['https://example.com', 'http://127.0.0.1.example.com', 'chrome-extension://abc', 'file://', '', undefined])
      expect(isLoopbackOrigin(origin), String(origin)).toBe(false);
  });
});

describe('the status a loopback page may ask for', () => {
  it('answers a dashboard on this machine', async () => {
    const { handled, answer } = await ask('http://127.0.0.1:4317', { type: 'buddi.status' });
    expect(handled).toBe(true);
    expect(answer).toEqual({ installed: true, version: '0.1.0', state: 'disconnected', gateway: 'http://127.0.0.1:4317' });
  });

  it('hands over the six digits only while they are the thing to type', async () => {
    expect((await ask('http://localhost:4317', { type: 'buddi.status' }, state({ connection: 'pairing', code: '482 913' }))).answer)
      .toMatchObject({ state: 'pairing', code: '482 913' });
    // Connecting is not pairing: there is nothing on screen to fill in yet.
    expect((await ask('http://localhost:4317', { type: 'buddi.status' }, state({ connection: 'connecting' }))).answer)
      .toEqual({ installed: true, version: '0.1.0', state: 'disconnected', gateway: 'http://127.0.0.1:4317' });
    expect((await ask('http://localhost:4317', { type: 'buddi.status' }, state({ connection: 'paired', installation: 'buddi' }))).answer)
      .toEqual({ installed: true, version: '0.1.0', state: 'paired', gateway: 'http://127.0.0.1:4317' });
  });

  it('says nothing at all to a website, or to anything it was not asked', async () => {
    expect(await ask('https://example.com', { type: 'buddi.status' })).toEqual({ handled: false, answer: undefined });
    expect(await ask(undefined, { type: 'buddi.status' })).toEqual({ handled: false, answer: undefined });
    expect(await ask('http://127.0.0.1:4317', { type: 'buddi-forget' })).toEqual({ handled: false, answer: undefined });
    expect(await ask('http://127.0.0.1:4317', null)).toEqual({ handled: false, answer: undefined });
  });

  it('never carries the token, whatever the state', () => {
    const answer = report(state({ connection: 'paired', code: '482 913', installation: 'buddi' }), 'http://127.0.0.1:4317', '0.1.0');
    expect(Object.keys(answer).sort()).toEqual(['gateway', 'installed', 'state', 'version']);
  });
});
