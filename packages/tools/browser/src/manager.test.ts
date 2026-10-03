import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreToolContext } from '@buddi/core/testing';
import { createPluginHost, hostBindingOf } from '@buddi/core/testing';
import { BrowserManager, type BrowserManagerOptions } from './manager.js';
import { commandSchema, type BrowserDriver } from './types.js';

/** The context core hands the browser plugin: these facts, with its `ctx.buddi` built over them. */
const BROWSER_HOST = hostBindingOf({ name: 'browser', version: '0.1.0', schema: 'browser', migrationsDir: '', tools: [] });
const hosted = (facts: CoreToolContext): CoreToolContext => ({ ...facts, buddi: createPluginHost(BROWSER_HOST, facts) });

const managers: BrowserManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((manager) => manager.shutdown())); });
const navigate = (url = 'https://example.com/') => commandSchema.parse({ action: 'navigate', url });
const observe = commandSchema.parse({ action: 'observe' });
function context(agentId: string, conversationId = agentId): CoreToolContext {
  return hosted({ db: {} as never, ownerId: 'owner', agentId, conversationId, sessionTools: ['browser.act'], now: () => new Date(), timezone: 'UTC',
    ownerRequest: { id: `${agentId}:${conversationId}`, text: 'Use the fixture', expiresAt: Date.now() + 60_000 } });
}
async function setup(options: BrowserManagerOptions = {}, perform?: (command: { action: string; url?: string }, i: number) => Promise<void>) {
  const drivers: BrowserDriver[] = [];
  const manager = new BrowserManager(() => {
    const i = drivers.length;
    let url = `https://example.com/${i}`;
    const driver: BrowserDriver = {
      start: vi.fn(async () => {}),
      perform: vi.fn(async (command) => { if (command.action === 'navigate' && command.url) url = command.url; await perform?.(command, i); }),
      close: vi.fn(async () => {}), takeover: vi.fn(async () => {}), resume: vi.fn(), screenshot: vi.fn(async () => Buffer.from(`image-${i}`)),
      observe: vi.fn(async () => ({ id: `o${i}`, title: `Page ${i}`, url, tree: `Private tree ${i}`, tabs: [], capturedAt: new Date().toISOString() })),
    };
    drivers.push(driver); return driver;
  }, { sleep: async () => {}, ...options });
  managers.push(manager); await manager.enable(); return { manager, drivers };
}

describe('several agents look at once', () => {
  it('the own browser: one page per conversation, three at once by default; a fourth waits its turn without an error', async () => {
    const { manager, drivers } = await setup({ maxSessions: 3, idleEvictMs: 60 * 60_000 });
    for (const agent of ['a', 'b', 'c']) await manager.execute(navigate(), context(agent));
    expect(drivers).toHaveLength(3);
    let fourthDone = false;
    const fourth = manager.execute(navigate(), context('d')).then((result) => { fourthDone = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fourthDone).toBe(false);
    // One conversation finishes; the waiting one gets the page.
    await manager.execute(commandSchema.parse({ action: 'close' }), context('a'));
    await expect(fourth).resolves.toMatchObject({ completed: true });
    expect(drivers).toHaveLength(4);
  });
  it('a page nobody touched for a while is let go for a conversation that waits, and opens again where it was', async () => {
    let now = 0;
    const { manager, drivers } = await setup({ maxSessions: 1, idleEvictMs: 2 * 60_000, now: () => now });
    await manager.execute(navigate('https://example.com/kept'), context('a'));
    now += 3 * 60_000;
    await expect(manager.execute(navigate(), context('b'))).resolves.toMatchObject({ completed: true });
    expect(drivers[0]!.close).toHaveBeenCalled();
    now += 3 * 60_000;
    // Back to a: no page is open, so its next action opens the old address again.
    const back = await manager.execute(observe, context('a')) as { observation: { url: string }; message: string };
    expect(back.observation.url).toBe('https://example.com/kept');
    expect(back.message).toContain('opened example.com again');
  });
  it('the apps route: one conversation at a time, the next one queued', async () => {
    let release!: () => void;
    const { manager } = await setup({ maxSessions: 1, allowOpen: true, idleEvictMs: 60 * 60_000 });
    await manager.execute(commandSchema.parse({ action: 'open', appId: 'com.apple.Numbers' }), context('a'));
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const second = manager.execute(commandSchema.parse({ action: 'open', appId: 'com.apple.Preview' }), context('b'));
    let done = false; void second.then(() => { done = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    void gate;
    await manager.execute(commandSchema.parse({ action: 'close' }), context('a'));
    release();
    await expect(second).resolves.toMatchObject({ completed: true });
  });
  it('the owner\'s Chrome: two agents never act on the same origin at once; different sites run side by side', async () => {
    const order: string[] = [];
    const gates = new Map<number, () => void>();
    const { manager } = await setup({ siteLocks: true }, async (command, i) => {
      order.push(`start ${i} ${command.url ?? command.action}`);
      if (i === 0 && command.action === 'navigate') await new Promise<void>((resolve) => { gates.set(i, resolve); });
      order.push(`end ${i}`);
    });
    const first = manager.execute(navigate('https://shop.test/a'), context('a'));
    await vi.waitFor(() => expect(gates.has(0)).toBe(true));
    const sameSite = manager.execute(navigate('https://shop.test/b'), context('b'));
    const otherSite = manager.execute(navigate('https://news.test/'), context('c'));
    await otherSite;
    expect(order).toContain('end 2');
    expect(order).not.toContain('start 1 https://shop.test/b');
    gates.get(0)!();
    await first; await sameSite;
    expect(order.indexOf('start 1 https://shop.test/b')).toBeGreaterThan(order.indexOf('end 0'));
  });
});

describe('Stop wins over everything still waiting', () => {
  it('a conversation waiting for a page is turned away by Stop and opens nothing', async () => {
    const { manager, drivers } = await setup({ maxSessions: 1, idleEvictMs: 60 * 60_000 });
    await manager.execute(navigate(), context('a'));
    const waiting = manager.execute(navigate('https://example.com/later'), context('b'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await manager.control('stop');
    await expect(waiting).rejects.toThrow(/stopped agents' browsing/);
    expect(drivers).toHaveLength(1);
    expect(manager.pages()).toHaveLength(0);
  });
  it('a conversation waiting behind another on the same site does not act after Stop', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { manager, drivers } = await setup({ siteLocks: true }, async (command, i) => { if (i === 0 && command.action === 'navigate') await gate; });
    const first = manager.execute(navigate('https://shop.test/a'), context('a')).catch((error: unknown) => error);
    await vi.waitFor(() => expect(drivers).toHaveLength(1));
    const second = manager.execute(navigate('https://shop.test/b'), context('b'));
    await vi.waitFor(() => expect(drivers).toHaveLength(2));
    await manager.control('stop');
    release();
    await first;
    await expect(second).rejects.toThrow(/stopped agents' browsing/);
    expect(vi.mocked(drivers[1]!.perform)).not.toHaveBeenCalled();
  });
});

describe('pages parked on a card', () => {
  it('do not hold the route\'s pages: a new conversation gets one at once, and past twice the cap the oldest parked page is let go', async () => {
    const { manager, drivers } = await setup({ maxSessions: 1, idleEvictMs: 60 * 60_000, queueTimeoutMs: 50 });
    await manager.execute(navigate('https://example.com/a'), context('a'));
    manager.child({ agentId: 'a', conversationId: 'a' })!.park('sign-in');
    await expect(manager.execute(navigate(), context('b'))).resolves.toMatchObject({ completed: true });
    manager.child({ agentId: 'b', conversationId: 'b' })!.park('human');
    await expect(manager.execute(navigate(), context('c'))).resolves.toMatchObject({ completed: true });
    // a parked longest: let go, its address kept for next time; b still waits on its card.
    expect(drivers[0]!.close).toHaveBeenCalled();
    expect(manager.child({ agentId: 'a', conversationId: 'a' })).toBeUndefined();
    expect(manager.child({ agentId: 'b', conversationId: 'b' })?.card?.kind).toBe('human');
  });
});

describe('pages and their conversations', () => {
  it('continues a task into a new transcript without reusing evidence', async () => {
    const { manager, drivers } = await setup({ maxSessions: 1 });
    await manager.execute(navigate(), context('a', 'old'));
    const before = manager.status();
    expect(manager.rollover({ ownerId: 'owner', agentId: 'a', previousConversationId: 'old', conversationId: 'next' })).toBe(true);
    expect(manager.status()).toMatchObject({ state: 'running', hasScreenshot: false, session: { id: before.session!.id, conversationId: 'next' } });
    expect(manager.status().page).toBeUndefined();
    await expect(manager.execute(observe, context('a', 'next'))).resolves.toMatchObject({ completed: true });
    expect(drivers).toHaveLength(1);
  });
  it('never hands one conversation another\'s page', async () => {
    const { manager } = await setup();
    await manager.execute(navigate(), context('a'));
    await manager.execute(navigate(), context('b'));
    expect(manager.status({ agentId: 'a', conversationId: 'a' }).page?.title).toBe('Page 0');
    expect(manager.status({ agentId: 'b', conversationId: 'b' }).page?.title).toBe('Page 1');
    expect(manager.status({ agentId: 'a', conversationId: 'b' }).session).toBeUndefined();
  });
  it('an owner touch renews every page in that conversation and hands back the cards it cleared', async () => {
    const { manager } = await setup({ maxSteps: 1 });
    await manager.execute(navigate(), context('a'));
    await expect(manager.execute(observe, context('a'))).resolves.toMatchObject({ needsOwner: { kind: 'budget' } });
    const touched = manager.renew('a');
    expect(touched.map((entry) => entry.card?.kind)).toEqual(['budget']);
    await expect(manager.execute(observe, context('a'))).resolves.toMatchObject({ completed: true });
  });
  it('stop closes every page; take-over, resume and release act on the selected one only', async () => {
    const { manager, drivers } = await setup();
    await manager.execute(navigate(), context('a'));
    await manager.execute(navigate(), context('b'));
    const a = manager.status({ agentId: 'a', conversationId: 'a' }).session!.id;
    await manager.control('takeover', a);
    expect(manager.status({ agentId: 'a', conversationId: 'a' }).state).toBe('paused');
    expect(manager.status({ agentId: 'b', conversationId: 'b' }).state).toBe('running');
    await expect(manager.control('takeover')).rejects.toThrow('Select a page');
    await manager.control('stop');
    expect(drivers.every((driver) => vi.mocked(driver.close).mock.calls.length > 0)).toBe(true);
    expect(manager.pages()).toHaveLength(0);
  });
});
