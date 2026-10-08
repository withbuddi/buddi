/**
 * Who may ask this extension anything, and what it says back.
 *
 * The manifest names loopback origins, but a manifest is Chrome's business; the
 * rule is asserted here, against the handler itself, so that a mistake in
 * either place is a failing test rather than a browser that talks to a website.
 */
import { describe, expect, it, vi } from 'vitest';
import { describe as report, describeFor, handleExternal, isLoopbackOrigin, type KnownBuddi } from './external.js';
import type { ClientState } from './protocol.js';

const state = (over: Partial<ClientState> = {}): ClientState =>
  ({ connection: 'offline', code: null, installation: null, error: null, ...over });

const ask = async (origin: string | undefined, message: unknown, current = state(), others: KnownBuddi[] = []) => {
  const respond = vi.fn();
  const unknown = vi.fn();
  const known = [{ origin: 'http://127.0.0.1:4317', name: 'buddi', state: current, enabled: true }, ...others];
  const handled = handleExternal(message, { origin, known: async () => known, version: '0.1.0', unknown }, respond);
  await vi.waitFor(() => expect(handled ? respond.mock.calls.length : 0).toBe(handled ? 1 : 0));
  const answer = respond.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  // The list rides along since several buddis; these tests are about the asking buddi's own answer.
  if (answer) delete answer['pairings'];
  return { handled, answer, unknown };
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
    for (const [origin, message] of [['https://example.com', { type: 'buddi.status' }], [undefined, { type: 'buddi.status' }], ['http://127.0.0.1:4317', { type: 'buddi-forget' }], ['http://127.0.0.1:4317', null]] as const) {
      const { handled, answer } = await ask(origin, message);
      expect({ handled, answer }).toEqual({ handled: false, answer: undefined });
    }
  });

  it('never carries the token, whatever the state', () => {
    const answer = report(state({ connection: 'paired', code: '482 913', installation: 'buddi' }), 'http://127.0.0.1:4317', '0.1.0');
    expect(Object.keys(answer).sort()).toEqual(['gateway', 'installed', 'state', 'version']);
  });
});

describe('one extension, several buddis', () => {
  const dev = (connection: ClientState['connection'], code: string | null = null): KnownBuddi =>
    ({ origin: 'http://127.0.0.1:4327', name: 'buddi-dev', state: state({ connection, code }), enabled: true });

  it('answers each dashboard with its own pairing, and lists them all', () => {
    const known: KnownBuddi[] = [{ origin: 'http://127.0.0.1:4317', name: 'buddi', state: state({ connection: 'paired' }), enabled: true }, dev('pairing', '482 913')];
    const release = describeFor('http://localhost:4317', known, '0.1.0');
    expect(release).toMatchObject({ state: 'paired', gateway: 'http://127.0.0.1:4317' });
    // Another buddi's code is never handed to this one's dashboard.
    expect(release.code).toBeUndefined();
    expect(release.pairings).toEqual([
      { origin: 'http://127.0.0.1:4317', name: 'buddi', state: 'paired', enabled: true },
      { origin: 'http://127.0.0.1:4327', name: 'buddi-dev', state: 'pairing', enabled: true },
    ]);
    expect(describeFor('http://127.0.0.1:4327', known, '0.1.0')).toMatchObject({ state: 'pairing', code: '482 913', gateway: 'http://127.0.0.1:4327' });
  });

  it('tells a dashboard it does not know that it is not paired, and remembers it asked, so the popup can offer it', async () => {
    const { answer, unknown } = await ask('http://127.0.0.1:4391', { type: 'buddi.status' }, state({ connection: 'paired' }));
    expect(answer).toMatchObject({ state: 'disconnected', gateway: 'http://127.0.0.1:4317' });
    expect(unknown).toHaveBeenCalledWith('http://127.0.0.1:4391');
    const { unknown: quiet } = await ask('http://127.0.0.1:4317', { type: 'buddi.status' });
    expect(quiet).not.toHaveBeenCalled();
  });
});
