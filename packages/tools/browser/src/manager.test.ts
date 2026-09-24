import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolContext } from '@buddi/core/testing';
import { ToolRegistry, createPluginHost, hostBindingOf } from '@buddi/core/testing';

/** The context core hands the browser plugin: these facts, with its `ctx.buddi` built over them. */
const BROWSER_HOST = hostBindingOf({ name: 'browser', version: '0.1.0', schema: 'browser', migrationsDir: '', tools: [] });
const hosted = (facts: ToolContext): ToolContext => ({ ...facts, buddi: createPluginHost(BROWSER_HOST, facts) });
import { BrowserManager } from './manager.js';
import { createBrowserManifest } from './index.js';
import { commandSchema, type BrowserDriver } from './types.js';

const managers: BrowserManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((manager) => manager.shutdown())); });
const navigate = commandSchema.parse({ action: 'navigate', url: 'https://example.com/' });
const observe = commandSchema.parse({ action: 'observe' });
function context(agentId: string, conversationId = agentId): ToolContext {
  return hosted({ db: {} as never, ownerId: 'owner', agentId, conversationId, sessionTools: ['browser.act'], now: () => new Date(), timezone: 'UTC',
    ownerRequest: { id: `${agentId}:${conversationId}`, text: 'Use the fixture', expiresAt: Date.now() + 60_000 } });
}
async function setup(options: ConstructorParameters<typeof BrowserManager>[1] = {}) {
  const drivers: BrowserDriver[] = [];
  const manager = new BrowserManager(() => {
    const i = drivers.length;
    const driver: BrowserDriver = { start: vi.fn(async () => {}), perform: vi.fn(async () => {}), close: vi.fn(async () => {}),
      takeover: vi.fn(async () => {}), resume: vi.fn(), screenshot: vi.fn(async () => Buffer.from(`image-${i}`)),
      observe: vi.fn(async () => ({ id: `o${i}`, title: `Page ${i}`, url: `https://example.com/${i}`, tree: `Private tree ${i}`, tabs: [{ id: `t${i}`, url: `https://example.com/${i}`, title: `Page ${i}` }], capturedAt: new Date().toISOString() })) };
    drivers.push(driver); return driver;
  }, options);
  managers.push(manager); await manager.enable(); return { manager, drivers };
}
describe('multiple browser conversations', () => {
  it('continues a task into a new transcript without opening another app or reusing evidence', async () => {
    const { manager, drivers } = await setup({ allowOpen: true, maxSessions: 1 });
    await manager.execute(navigate, context('a', 'old'));
    const before = manager.status();
    expect(manager.rollover({ ownerId: 'owner', agentId: 'a', previousConversationId: 'old', conversationId: 'next' })).toBe(true);
    expect(manager.status()).toMatchObject({ state: 'running', hasScreenshot: false, session: { id: before.session!.id, conversationId: 'next', expiresAt: before.session!.expiresAt } });
    expect(manager.status().page).toBeUndefined();
    expect(drivers[0]!.close).not.toHaveBeenCalled();
    expect(drivers[0]!.perform).toHaveBeenCalledTimes(1);
    const click = { action: 'click', observation: 'o0', target: { ref: 'ax1', frame: 0, by: 'text' } } as const;
    await expect(manager.execute(click, context('a', 'next'))).rejects.toThrow('observe the current page');
    await expect(manager.execute(navigate, context('a', 'old'))).rejects.toThrow('ended');
    await manager.execute(observe, context('a', 'next'));
    await manager.execute(click, context('a', 'next'));
    expect(drivers).toHaveLength(1);
    await manager.execute({ action: 'close' }, context('a', 'next'));
    await manager.execute(navigate, context('a', 'fresh'));
  });
  it('never steals another owner/agent session or resumes a paused task during rollover', async () => {
    const { manager } = await setup({ allowOpen: true, maxSessions: 1 });
    await manager.execute(navigate, context('a', 'old'));
    const input = { ownerId: 'owner', agentId: 'a', previousConversationId: 'old', conversationId: 'next' };
    expect(manager.rollover({ ...input, ownerId: 'stranger' })).toBe(false);
    expect(manager.rollover({ ...input, agentId: 'b' })).toBe(false);
    await manager.control('takeover', manager.status().session!.id);
    expect(manager.rollover(input)).toBe(true);
    expect(manager.status().state).toBe('paused');
    await expect(manager.execute(observe, context('a', 'next'))).rejects.toThrow('human control');
    await manager.control('resume', manager.status().session!.id);
    await expect(manager.execute(navigate, context('a', 'next'))).rejects.toThrow('observe the current page');
    await manager.execute(observe, context('a', 'next'));
    await manager.control('stop');
    expect(manager.rollover({ ...input, previousConversationId: 'next', conversationId: 'later' })).toBe(false);
  });
  it('refuses transfer while an action is running', async () => {
    const { manager, drivers } = await setup();
    await manager.execute(navigate, context('a', 'old'));
    let finish!: () => void;
    vi.mocked(drivers[0]!.perform).mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const pending = manager.execute(observe, context('a', 'old'));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(() => manager.rollover({ ownerId: 'owner', agentId: 'a', previousConversationId: 'old', conversationId: 'next' })).toThrow('settle');
    expect(manager.status().session?.conversationId).toBe('old');
    finish(); await pending;
  });
  it('a cancelled agent closes only its own tabs and cannot reopen with that request', async () => {
    const { manager, drivers } = await setup(); const controller = new AbortController();
    await manager.execute(navigate, context('a')); await manager.execute(navigate, context('b'));
    vi.mocked(drivers[0]!.perform).mockImplementation(async () => { controller.abort(new Error('cancelled')); });
    await expect(manager.execute(observe, { ...context('a'), signal: controller.signal })).rejects.toThrow('cancelled');
    expect(manager.status().sessions).toHaveLength(1);
    expect(drivers[1]!.close).not.toHaveBeenCalled();
    await expect(manager.execute(navigate, context('a'))).rejects.toThrow('ended');
    await manager.execute(observe, context('b'));
  });
  it('global Stop fences delayed launch completions', async () => {
    const { manager, drivers } = await setup();
    await manager.execute(navigate, context('a'));
    let finish!: () => void;
    vi.mocked(drivers[0]!.start).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const pending = manager.execute(observe, context('a'));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await manager.control('stop'); finish();
    await expect(pending).rejects.toThrow('stopped');
    expect(manager.status()).toMatchObject({ state: 'stopped', sessions: [], hasScreenshot: false });
  });
  it('starts simultaneous conversations without dropping opening controllers', async () => {
    const { manager, drivers } = await setup();
    await Promise.all([manager.execute(navigate, context('a')), manager.execute(navigate, context('b'))]);
    expect(manager.status().sessions).toHaveLength(2);
    expect(drivers).toHaveLength(2);
    const a = manager.status({ agentId: 'a', conversationId: 'a' });
    const b = manager.status({ agentId: 'b', conversationId: 'b' });
    expect(a.page?.title).toBe('Page 0'); expect(b.page?.title).toBe('Page 1');
    expect(a.sessions).toBeUndefined(); expect(a.session?.id).not.toBe(b.session?.id);
    expect(manager.screenshot(a.session!.id)?.toString()).toBe('image-0');
    expect(manager.screenshot('not-owned')).toBeUndefined();
    expect(manager.status({ agentId: 'a', conversationId: 'b' }).session).toBeUndefined();
  });
  it('one agent can have separate dashboard and Telegram conversations', async () => {
    const { manager } = await setup();
    await manager.execute(navigate, context('a', 'dashboard'));
    await manager.execute(navigate, context('a', 'telegram'));
    expect(manager.status().sessions).toHaveLength(2);
  });
  it('pauses/releases only the selected conversation and clears errors', async () => {
    const { manager, drivers } = await setup();
    await manager.execute(navigate, context('a')); await manager.execute(navigate, context('b'));
    const id = manager.status({ agentId: 'a', conversationId: 'a' }).session!.id;
    await manager.control('takeover', id);
    await expect(manager.execute(observe, context('a'))).rejects.toThrow('human control');
    await manager.execute(observe, context('b'));
    expect(drivers[0]!.takeover).toHaveBeenCalledOnce();
    expect(drivers[1]!.takeover).not.toHaveBeenCalled();
    await manager.control('resume', id); await manager.execute(observe, context('a'));
    await manager.control('release', id);
    expect(drivers[0]!.close).toHaveBeenCalled(); expect(drivers[1]!.close).not.toHaveBeenCalled();
    expect(manager.status({ agentId: 'a', conversationId: 'a' })).toMatchObject({ state: 'idle', hasScreenshot: false });
    expect(manager.status({ agentId: 'a', conversationId: 'a' }).message).toBeUndefined();
    await expect(manager.execute(navigate, context('a'))).rejects.toThrow('ended');
    await expect(manager.control('release', id)).rejects.toThrow('session changed');
  });
  it('never exposes another conversation to status/image tool hooks', async () => {
    const { manager } = await setup();
    await manager.execute(navigate, context('a')); const result = await manager.execute(navigate, context('b'));
    const registry = new ToolRegistry(); registry.register(createBrowserManifest(manager));
    const status = await registry.invoke('browser.status', {}, context('a'));
    expect(JSON.stringify(status)).not.toContain('Page 1');
    expect(await registry.image('browser.act', result, context('a'))).toBeUndefined();
    expect(await registry.image('browser.act', result, context('b'))).toMatchObject({ mime: 'image/jpeg' });
  });
  it('keeps session identity across a fresh owner message and disallows old request replay', async () => {
    const { manager } = await setup(); const ctx = context('a');
    await manager.execute(navigate, ctx); const id = manager.status().session!.id;
    await manager.execute(observe, { ...ctx, ownerRequest: { ...ctx.ownerRequest!, id: 'fresh' } });
    expect(manager.status().session!.id).toBe(id);
    await expect(manager.execute(observe, ctx)).rejects.toThrow('ended');
  });
  it('global Stop interrupts all sessions, persists, and requires owner resume', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-browser-manager-'));
    try {
      const options = { controlFile: path.join(dir, 'control.json') };
      const { manager, drivers } = await setup(options);
      await manager.execute(navigate, context('a')); await manager.execute(navigate, context('b'));
      await manager.control('stop');
      expect(manager.status()).toMatchObject({ state: 'stopped', sessions: [] });
      expect(drivers.every((driver) => vi.mocked(driver.close).mock.calls.length > 0)).toBe(true);
      await expect(manager.execute(navigate, context('c'))).rejects.toThrow('owner stopped');
      const { manager: restarted } = await setup(options);
      expect(restarted.status().state).toBe('stopped');
      await restarted.control('resume'); await restarted.execute(navigate, context('c'));
      expect(restarted.status().session?.agentId).toBe('c');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('refuses guessed ownership, unauthenticated calls and excess sessions before launch', async () => {
    const { manager, drivers } = await setup({ maxSessions: 1 });
    await expect(manager.execute(navigate, { ...context('a'), ownerRequest: undefined })).rejects.toThrow('authenticated');
    expect(drivers).toHaveLength(0);
    await manager.execute(navigate, context('a'));
    await expect(manager.execute(navigate, context('b'))).rejects.toThrow('slots');
    await expect(manager.control('takeover')).rejects.toThrow('Select');
  });
});
