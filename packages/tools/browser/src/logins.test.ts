/**
 * Saving a sign-in the owner made on a page they hold (docs/browser.md,
 * "Saving a sign-in"): the own browser's driver watches over its hand's CDP
 * session, the page reports through a binding only its isolated world sees,
 * the service passes it on only while the owner holds the page, and the keeper
 * asks with the site and the user name — never the password — then hands the
 * pair to the owner-secret store on Save, or remembers the site on Never.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginHost, hostBindingOf, type CoreToolContext } from '@buddi/core/testing';
import { PlaywrightDriver } from './driver.js';
import { ExtensionDriver, type ExtensionBridge, type ExtensionLogin } from './extension.js';
import { BrowserService } from './service.js';
import { LOGIN_BINDING, LOGIN_WORLD, LoginKeeper, loginName, loginWatchSource, readLoginPayload, shortUsername, type LoginPrompt, type LoginStoreInput } from './logins.js';
import { commandSchema, LOGIN_GONE, type BrowserDriver, type Observation, type SeenLoginReport } from './types.js';

const PASSWORD = 'fixture-pass-7Qz!';
const BROWSER_HOST = hostBindingOf({ name: 'browser', version: '0.1.0', schema: 'browser', migrationsDir: '', tools: [] });
const ctx = (): CoreToolContext => {
  const facts = { db: {} as never, ownerId: 'owner', now: () => new Date(), timezone: 'UTC', agentId: 'concierge', conversationId: 'c1', sessionTools: ['browser.act'],
    ownerRequest: { id: 'r1', text: 'Check my orders', expiresAt: Date.now() + 60_000 } } as CoreToolContext;
  return { ...facts, buddi: createPluginHost(BROWSER_HOST, facts) };
};

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function keeperIn(): Promise<{ keeper: LoginKeeper; file: string; stored: LoginStoreInput[] }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'buddi-logins-'));
  dirs.push(dir);
  const file = path.join(dir, 'logins.json');
  const keeper = new LoginKeeper(file, { now: () => Date.parse('2026-10-03T09:00:00Z') });
  const stored: LoginStoreInput[] = [];
  keeper.useStore(async (input) => { stored.push(input); });
  return { keeper, file, stored };
}

/** Just enough Playwright for the hand: a page, and a CDP session whose events the test fires. */
function fakePage(url = 'https://www.amazon.com/ap/signin') {
  const cdp = {
    sent: [] as Array<{ method: string; params?: Record<string, unknown> }>,
    listeners: new Map<string, (event: unknown) => void>(),
    on(event: string, handler: (event: unknown) => void) { this.listeners.set(event, handler); },
    send(method: string, params?: Record<string, unknown>) {
      this.sent.push({ method, ...(params ? { params } : {}) });
      if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'main' } } });
      if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 7 });
      return Promise.resolve({});
    },
    detach: vi.fn(async () => {}),
  };
  const page = {
    here: url, closed: false,
    mainFrame: () => ({ url: () => page.here }),
    url: () => page.here, isClosed: () => page.closed,
    context: () => ({ newCDPSession: async () => cdp }),
    on() {}, off() {}, once() {},
  };
  const host = { open: async () => page, check: () => {}, foreground: async () => {}, resume: () => {}, release: async () => {} } as never;
  return { page, cdp, host };
}

describe('the own browser watches the page the owner drives', () => {
  it('installs the watch in an isolated world and reports a submitted sign-in to its listener', async () => {
    const { cdp, host } = fakePage();
    const driver = new PlaywrightDriver({ profileDir: '/tmp/never-opened' } as never, host);
    const seen: SeenLoginReport[] = [];
    driver.onLoginSeen((login) => seen.push(login));
    await driver.start();
    await driver.hand.start(() => {});
    // The binding is the isolated world's alone: the page's scripts never see it.
    expect(cdp.sent).toContainEqual({ method: 'Runtime.addBinding', params: { name: LOGIN_BINDING, executionContextName: LOGIN_WORLD } });
    expect(cdp.sent.find((call) => call.method === 'Page.addScriptToEvaluateOnNewDocument')?.params).toMatchObject({ worldName: LOGIN_WORLD });
    expect(cdp.sent).toContainEqual({ method: 'Page.createIsolatedWorld', params: { frameId: 'main', worldName: LOGIN_WORLD } });
    expect(cdp.sent.find((call) => call.method === 'Runtime.evaluate')?.params).toMatchObject({ contextId: 7 });

    const bindingCalled = cdp.listeners.get('Runtime.bindingCalled')!;
    bindingCalled({ name: 'somethingElse', payload: JSON.stringify({ origin: 'https://www.amazon.com', username: 'x', password: 'y' }) });
    bindingCalled({ name: LOGIN_BINDING, payload: 'not json' });
    expect(seen).toEqual([]);
    bindingCalled({ name: LOGIN_BINDING, payload: JSON.stringify({ origin: 'https://www.amazon.com', username: 'sam@example.com', password: PASSWORD }) });
    expect(seen).toEqual([{ origin: 'https://www.amazon.com', username: 'sam@example.com', password: PASSWORD }]);

    // After the hand, nothing more is heard.
    await driver.hand.stop();
    bindingCalled({ name: LOGIN_BINDING, payload: JSON.stringify({ origin: 'https://www.amazon.com', username: 'sam@example.com', password: 'later' }) });
    expect(seen).toHaveLength(1);
  });

  it('a driver nobody listens on installs nothing', async () => {
    const { cdp, host } = fakePage();
    const driver = new PlaywrightDriver({ profileDir: '/tmp/never-opened' } as never, host);
    await driver.start();
    await driver.hand.start(() => {});
    expect(cdp.sent.some((call) => call.method === 'Runtime.addBinding')).toBe(false);
  });

  it('the page script reports through the binding with the frame origin', () => {
    const source = loginWatchSource();
    expect(source).toContain(LOGIN_BINDING);
    expect(source).toContain('location.origin');
    expect(readLoginPayload(JSON.stringify({ origin: 'https://a.test', username: 'u', password: 'p' }))).toEqual({ origin: 'https://a.test', username: 'u', password: 'p' });
    expect(readLoginPayload(JSON.stringify({ origin: 'https://a.test', username: 'u' }))).toBeUndefined();
    expect(readLoginPayload('x'.repeat(5000))).toBeUndefined();
  });
});

describe('the service passes a sign-in on only while the owner holds the page', () => {
  it('drops one the agent’s own page made, and passes the owner’s on', async () => {
    let listener: ((login: SeenLoginReport) => void) | undefined;
    const observation: Observation = { id: 'o1', url: 'https://www.amazon.com/ap/signin', title: 'Sign in', tree: '', tabs: [], capturedAt: new Date().toISOString() };
    const driver: BrowserDriver = { start: vi.fn(async () => {}), perform: vi.fn(async () => {}), observe: vi.fn(async () => observation), screenshot: vi.fn(async () => undefined), close: vi.fn(async () => {}),
      takeover: vi.fn(async () => {}), resume: vi.fn(), onLoginSeen: (fn) => { listener = fn; } };
    const passed: Array<[string, SeenLoginReport]> = [];
    const service = new BrowserService(driver, { loginSeen: (sessionId, login) => { passed.push([sessionId, login]); }, sleep: async () => {} });
    await service.enable();
    await service.execute(commandSchema.parse({ action: 'navigate', url: 'https://www.amazon.com/ap/signin' }), ctx());
    listener!({ origin: 'https://www.amazon.com', username: 'agent', password: PASSWORD });
    expect(passed).toEqual([]);
    await service.control('takeover');
    listener!({ origin: 'https://www.amazon.com', username: 'sam@example.com', password: PASSWORD });
    expect(passed).toHaveLength(1);
    expect(passed[0]![0]).toBe(service.status().session!.id);
    await service.shutdown();
  });

  it('a Save from the owner’s Chrome a beat after Give it back still counts, within the grace; later it is gone, and says so', async () => {
    let now = Date.parse('2026-10-03T09:00:00Z');
    let listener: ((login: SeenLoginReport) => Promise<unknown> | void) | undefined;
    const observation: Observation = { id: 'o1', url: 'https://www.amazon.com/ap/signin', title: 'Sign in', tree: '', tabs: [], capturedAt: new Date().toISOString() };
    const driver: BrowserDriver = { start: vi.fn(async () => {}), perform: vi.fn(async () => {}), observe: vi.fn(async () => observation), screenshot: vi.fn(async () => undefined), close: vi.fn(async () => {}),
      takeover: vi.fn(async () => {}), resume: vi.fn(), onLoginSeen: (fn) => { listener = fn; } };
    (driver as { holdsInPlace?: 'chrome' }).holdsInPlace = 'chrome';
    const passed: string[] = [];
    const service = new BrowserService(driver, { now: () => now, sleep: async () => {},
      loginSeen: async (sessionId) => { passed.push(sessionId); return { saved: true }; } });
    await service.enable();
    await service.execute(commandSchema.parse({ action: 'navigate', url: 'https://www.amazon.com/ap/signin' }), ctx());
    const held = service.status().session!.id;
    await service.control('takeover');
    await service.control('resume');
    now += 30_000;
    await expect(listener!({ origin: 'https://www.amazon.com', username: 'sam', password: PASSWORD, decision: 'save' })).resolves.toEqual({ saved: true });
    expect(passed).toEqual([held]);
    // A report with no answer in it is never taken after the hold.
    expect(listener!({ origin: 'https://www.amazon.com', username: 'sam', password: PASSWORD })).toBeUndefined();
    now += 2 * 60_000;
    await expect(listener!({ origin: 'https://www.amazon.com', username: 'sam', password: PASSWORD, decision: 'save' })).resolves.toEqual({ saved: false, reason: LOGIN_GONE });
    expect(passed).toHaveLength(1);
    await service.shutdown();
  });
});

describe('the keeper asks the owner, and keeps what they say', () => {
  it('asks with the site and the user name, never the password', async () => {
    const { keeper } = await keeperIn();
    const heard: LoginPrompt[] = [];
    keeper.onSeen((prompt) => heard.push(prompt));
    const prompt = await keeper.seen('s1', { origin: 'https://www.amazon.com', username: 'sam@example.com', password: PASSWORD });
    expect(prompt).toMatchObject({ sessionId: 's1', site: 'amazon.com', username: 'sam@example.com' });
    expect(heard).toHaveLength(1);
    expect(JSON.stringify(heard)).not.toContain(PASSWORD);
    expect(JSON.stringify(keeper.pending())).not.toContain(PASSWORD);
    // The same sign-in again is the same question.
    const again = await keeper.seen('s1', { origin: 'https://www.amazon.com', username: 'sam@example.com', password: PASSWORD });
    expect(again?.id).toBe(prompt!.id);
    expect(heard).toHaveLength(1);
  });

  it('Save hands the pair to the store, bound to the origin, and keeps the label on disk without the password', async () => {
    const { keeper, file, stored } = await keeperIn();
    const prompt = await keeper.seen('s1', { origin: 'https://www.amazon.com', username: 'sam@example.com', password: PASSWORD });
    const answer = await keeper.decide(prompt!.id, 'save');
    expect(answer.outcome).toBe('saved');
    expect(stored).toEqual([{ name: 'login · amazon.com', value: PASSWORD, bindings: [{ kind: 'browser.field', target: 'https://www.amazon.com', rule: 'first-time' }] }]);
    expect(keeper.saved()).toEqual([{ name: 'login · amazon.com', site: 'amazon.com', origin: 'https://www.amazon.com', username: 'sam@example.com', savedAt: '2026-10-03T09:00:00.000Z' }]);
    const disk = await readFile(file, 'utf8');
    expect(disk).toContain('sam@example.com');
    expect(disk).not.toContain(PASSWORD);
    // Answered once: the password is gone from the keeper.
    expect(await keeper.decide(prompt!.id, 'save')).toEqual({ outcome: 'gone' });
    expect(keeper.pending()).toEqual([]);
    // Kept with that user name: the next sign-in there is not asked about.
    expect(await keeper.seen('s1', { origin: 'https://www.amazon.com', username: 'sam@example.com', password: PASSWORD })).toBeUndefined();
  });

  it('Never remembers the site: no further prompts there, across a restart', async () => {
    const { keeper, file, stored } = await keeperIn();
    const prompt = await keeper.seen('s1', { origin: 'https://smile.amazon.com', username: 'sam', password: PASSWORD });
    expect(await keeper.decide(prompt!.id, 'never')).toEqual({ outcome: 'never' });
    expect(stored).toEqual([]);
    expect(await keeper.seen('s1', { origin: 'https://smile.amazon.com', username: 'other', password: 'x' })).toBeUndefined();
    const reopened = new LoginKeeper(file);
    expect(reopened.never()).toEqual([]);
    expect(await reopened.seen('s2', { origin: 'https://smile.amazon.com', username: 'sam', password: PASSWORD })).toBeUndefined();
    expect(reopened.never()).toEqual(['smile.amazon.com']);
  });

  it('Not now drops the password and stores nothing; two minutes drop it too', async () => {
    vi.useFakeTimers();
    try {
      const { keeper, stored } = await keeperIn();
      const first = await keeper.seen('s1', { origin: 'https://example.org', username: 'u', password: PASSWORD });
      expect(await keeper.decide(first!.id, 'later')).toEqual({ outcome: 'dismissed' });
      const second = await keeper.seen('s1', { origin: 'https://example.org', username: 'u', password: PASSWORD });
      vi.advanceTimersByTime(2 * 60_000 + 1);
      expect(keeper.pending()).toEqual([]);
      expect(await keeper.decide(second!.id, 'save')).toEqual({ outcome: 'gone' });
      expect(stored).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('asks nothing about a page with no web origin or no password', async () => {
    const { keeper } = await keeperIn();
    expect(await keeper.seen('s1', { origin: 'about:blank', username: 'u', password: PASSWORD })).toBeUndefined();
    expect(await keeper.seen('s1', { origin: 'https://example.org', username: 'u', password: '' })).toBeUndefined();
  });

  it('a second account on the same site gets its own name; a store that refuses keeps nothing', async () => {
    const { keeper } = await keeperIn();
    const one = await keeper.seen('s1', { origin: 'https://example.org', username: 'a', password: 'p1' });
    await keeper.decide(one!.id, 'save');
    expect(loginName('example.org', 'b', keeper.saved())).toBe('login · example.org · b');
    keeper.useStore(async () => { throw new Error('refused'); });
    const two = await keeper.seen('s1', { origin: 'https://example.org', username: 'b', password: 'p2' });
    await expect(keeper.decide(two!.id, 'save')).rejects.toThrow('refused');
    expect(keeper.saved().map((login) => login.username)).toEqual(['a']);
  });

  it('an answer from the owner’s Chrome is applied at once: Save stores, Never remembers', async () => {
    const { keeper, stored } = await keeperIn();
    await keeper.decided({ origin: 'https://accounts.example.com', username: 'sam', password: PASSWORD }, 'save');
    expect(stored[0]).toMatchObject({ name: 'login · accounts.example.com', value: PASSWORD });
    await keeper.decided({ origin: 'https://bank.test', username: 'sam' }, 'never');
    expect(keeper.never()).toEqual(['bank.test']);
  });

  it('two accounts saved at once on one site get two secrets, and a name the store already holds is never taken', async () => {
    const { keeper } = await keeperIn();
    // A store slow enough that both saves would pick their names before either finished.
    const store = new Map<string, string>();
    keeper.useStore(async ({ name, value }) => { await new Promise((resolve) => setTimeout(resolve, 5)); store.set(name, value); }, async () => [...store.keys()]);
    const [alice, bob] = await Promise.all([
      keeper.decided({ origin: 'https://example.org', username: 'alice', password: 'pa' }, 'save'),
      keeper.decided({ origin: 'https://example.org', username: 'bob', password: 'pb' }, 'save'),
    ]);
    expect(alice.saved!.name).not.toBe(bob.saved!.name);
    expect(store.size).toBe(2);
    expect(store.get(alice.saved!.name)).toBe('pa');
    expect(store.get(bob.saved!.name)).toBe('pb');
    // The owner's own secret called "login · example.net" is not one of buddi's: a captured login goes beside it.
    store.set('login · example.net', 'the owner’s');
    const carol = await keeper.decided({ origin: 'https://example.net', username: 'carol', password: 'pc' }, 'save');
    expect(carol.saved!.name).toBe('login · example.net · carol');
    expect(store.get('login · example.net')).toBe('the owner’s');
  });

  it('the same sign-in again restarts the two minutes', async () => {
    vi.useFakeTimers();
    try {
      const { keeper } = await keeperIn();
      const first = await keeper.seen('s1', { origin: 'https://example.org', username: 'u', password: 'one' });
      vi.advanceTimersByTime(90_000);
      await keeper.seen('s1', { origin: 'https://example.org', username: 'u', password: 'two' });
      vi.advanceTimersByTime(90_000);
      expect(keeper.pending().map((prompt) => prompt.id)).toEqual([first!.id]);
      vi.advanceTimersByTime(30_001);
      expect(keeper.pending()).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it('a kept login signed into with a new password is offered as an update, and Save replaces its value', async () => {
    const { keeper, stored } = await keeperIn();
    const first = await keeper.seen('s1', { origin: 'https://www.amazon.com', username: 'sam', password: 'old-one' });
    expect(first?.update).toBeUndefined();
    await keeper.decide(first!.id, 'save');
    // The same password: nothing to ask.
    expect(await keeper.seen('s1', { origin: 'https://www.amazon.com', username: 'sam', password: 'old-one' })).toBeUndefined();
    const changed = await keeper.seen('s1', { origin: 'https://www.amazon.com', username: 'sam', password: 'new-one' });
    expect(changed).toMatchObject({ site: 'amazon.com', username: 'sam', update: true });
    expect(await keeper.decide(changed!.id, 'save')).toMatchObject({ outcome: 'saved', saved: { name: 'login · amazon.com' } });
    expect(stored.map((input) => [input.name, input.value])).toEqual([['login · amazon.com', 'old-one'], ['login · amazon.com', 'new-one']]);
    expect(keeper.saved()).toHaveLength(1);
    // After a restart buddi cannot tell, so a kept login is asked about as an update rather than never.
    const reopened = new LoginKeeper(keeper.file);
    expect(await reopened.seen('s2', { origin: 'https://www.amazon.com', username: 'sam', password: 'new-one' })).toMatchObject({ update: true });
  });

  it('a Save the store refuses stays open for another try', async () => {
    const { keeper } = await keeperIn();
    let refuse = true;
    const stored: string[] = [];
    keeper.useStore(async ({ name }) => { if (refuse) throw new Error('vault locked'); stored.push(name); });
    const prompt = await keeper.seen('s1', { origin: 'https://example.org', username: 'u', password: PASSWORD });
    await expect(keeper.decide(prompt!.id, 'save')).rejects.toThrow();
    refuse = false;
    expect(await keeper.decide(prompt!.id, 'save')).toMatchObject({ outcome: 'saved' });
    expect(stored).toEqual(['login · example.org']);
  });

  it('a renamed secret keeps its label under the new name', async () => {
    const { keeper } = await keeperIn();
    await keeper.decided({ origin: 'https://example.org', username: 'u', password: PASSWORD }, 'save');
    expect(await keeper.rename('login · example.org', 'Work login')).toBe(true);
    expect(keeper.saved()).toMatchObject([{ name: 'Work login', site: 'example.org', username: 'u' }]);
    expect(await keeper.rename('nothing', 'else')).toBe(false);
  });

  it('says a user name the way Settings does', () => {
    expect(shortUsername('sam.smith@example.com')).toBe('sam.smith@…');
    expect(shortUsername('sam')).toBe('sam');
  });
});

describe('the owner’s Chrome passes on an answer only from a tab the owner holds', () => {
  function bridge() {
    let listener: ((login: ExtensionLogin) => void) | undefined;
    const sent: Array<{ name: string; args: Record<string, unknown> }> = [];
    const fake: ExtensionBridge = {
      connected: () => true, close: () => {},
      send: async (command) => { sent.push({ name: command.name, args: command.args }); return {}; },
      logins: (_session, fn) => { listener = fn; return () => { listener = undefined; }; },
    };
    return { fake, sent, push: (login: ExtensionLogin) => listener?.(login) };
  }

  it('answers a Save with what became of it: the keeper’s word while held, gone otherwise', async () => {
    let listener: ((login: ExtensionLogin) => Promise<unknown> | void) | undefined;
    const fake: ExtensionBridge = { connected: () => true, close: () => {}, send: async () => ({}), logins: (_session, fn) => { listener = fn; return () => {}; } };
    const driver = new ExtensionDriver(fake, undefined, { now: () => 0 });
    driver.onLoginSeen(async () => ({ saved: false, reason: 'buddi could not keep that login.' }));
    await expect(listener!({ decision: 'save', origin: 'https://example.org', username: 'u', password: PASSWORD })).resolves.toEqual({ saved: false, reason: LOGIN_GONE });
    await driver.takeover();
    await expect(listener!({ decision: 'save', origin: 'https://example.org', username: 'u', password: PASSWORD })).resolves.toEqual({ saved: false, reason: 'buddi could not keep that login.' });
  });

  it('tells the tab what not to ask about, and relays Save only while held or just after', async () => {
    let now = 0;
    const { fake, sent, push } = bridge();
    const driver = new ExtensionDriver(fake, undefined, { logins: () => ({ never: ['bank.test'], saved: [{ site: 'amazon.com', username: 'sam' }] }), now: () => now });
    const seen: SeenLoginReport[] = [];
    driver.onLoginSeen((login) => { seen.push(login); });
    push({ decision: 'save', origin: 'https://example.org', username: 'u', password: PASSWORD });
    expect(seen).toEqual([]);
    await driver.takeover();
    expect(sent.find((command) => command.name === 'hold')?.args).toEqual({ logins: { never: ['bank.test'], saved: [{ site: 'amazon.com', username: 'sam' }] } });
    push({ decision: 'save', origin: 'https://example.org', username: 'u', password: PASSWORD });
    push({ decision: 'save', origin: 'https://example.org', username: 'u' });
    expect(seen).toEqual([{ decision: 'save', origin: 'https://example.org', username: 'u', password: PASSWORD }]);
    driver.resume();
    now += 60_000;
    push({ decision: 'never', origin: 'https://example.org', username: 'u' });
    expect(seen).toHaveLength(2);
    now += 2 * 60_000;
    push({ decision: 'never', origin: 'https://example.org', username: 'u' });
    expect(seen).toHaveLength(2);
  });
});
