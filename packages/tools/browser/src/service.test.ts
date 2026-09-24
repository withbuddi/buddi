import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TELEGRAM_SURFACE, ToolRegistry, WEB_SURFACE, createPluginHost, hostBindingOf, type ToolContext } from '@buddi/core';
import { browserStoppedMessage, BrowserService } from './service.js';
import { createBrowserManifest } from './index.js';
import { BrowserPreconditionError, commandSchema, type BrowserDriver, type Observation } from './types.js';

/** The context core hands the browser plugin: these facts, with its `ctx.buddi` built over them. */
const BROWSER_HOST = hostBindingOf({ name: 'browser', version: '0.1.0', schema: 'browser', migrationsDir: '', tools: [] });
const hosted = (facts: ToolContext): ToolContext => ({ ...facts, buddi: createPluginHost(BROWSER_HOST, facts) });

const observation: Observation = { id: 'o1', url: 'https://example.com/', title: 'Fixture', tree: '- button "Book"', tabs: [], capturedAt: new Date().toISOString() };
const navigate = commandSchema.parse({ action: 'navigate', url: 'https://example.com/' });
const observe = commandSchema.parse({ action: 'observe' });
const contexts = (): ToolContext => hosted({ db: {} as never, ownerId: 'owner', now: () => new Date(), timezone: 'UTC',
  agentId: 'concierge', conversationId: 'c1', sessionTools: ['browser.act'],
  ownerRequest: { id: 'request1', text: 'Book the appointment', expiresAt: Date.now() + 60_000 } });
function fake(): BrowserDriver {
  return { start: vi.fn(async () => {}), perform: vi.fn(async () => {}), observe: vi.fn(async () => observation),
    screenshot: vi.fn(async () => Buffer.from('image')), close: vi.fn(async () => {}) };
}
const services: BrowserService[] = [];
async function setup(options: ConstructorParameters<typeof BrowserService>[1] = {}) {
  const driver = fake();
  const service = new BrowserService(driver, options);
  services.push(service);
  await service.enable();
  return { driver, service, ctx: contexts() };
}
afterEach(async () => { await Promise.all(services.splice(0).map((s) => s.shutdown())); });

describe('host browser authority and lifecycle', () => {
  it('normalizes the observed by:link mistake without guessing a target or dropping observation checks', () => {
    const command = commandSchema.parse({ action: 'click', observation: 'o1', target: { by: 'link', name: 'Article' } });
    expect(command.target).toMatchObject({ by: 'role', role: 'link', name: 'Article' });
    expect(commandSchema.safeParse({ action: 'click', target: { ref: 'e1' } }).success).toBe(false);
    expect(commandSchema.safeParse({ action: 'click', observation: 'o1', target: { by: 'link', role: 'button', name: 'Article' } }).success).toBe(false);
  });
  it('returns fresh recovery evidence for safe failures and clears it on release', async () => {
    const { service, driver, ctx } = await setup();
    await service.execute(navigate, ctx);
    vi.mocked(driver.perform).mockRejectedValue(new BrowserPreconditionError('Target is ambiguous'));
    vi.mocked(driver.observe).mockResolvedValue({ ...observation, id: 'fresh', targets: [{ ref: 'e1', role: 'link', name: 'Repeated', frame: 0 }] });
    const click = commandSchema.parse({ action: 'click', observation: 'old', target: { ref: 'e1' } });
    await expect(service.execute(click, ctx)).rejects.toThrow('"dispatched":false');
    expect(service.status().page?.id).toBe('fresh');
    expect(driver.perform).toHaveBeenCalledTimes(2); // No automatic replay.
    await service.control('release');
    expect(service.status()).toMatchObject({ state: 'idle', hasScreenshot: false });
    expect(service.status().message).toBeUndefined(); expect(service.status().lastAction).toBeUndefined();
  });
  it('bounds repeated targeting failures and permits close without stale evidence', async () => {
    const { service, driver, ctx } = await setup(); await service.execute(navigate, ctx);
    vi.mocked(driver.perform).mockRejectedValue(new BrowserPreconditionError('Stale page observation'));
    const click = commandSchema.parse({ action: 'click', observation: 'old', target: { ref: 'e1' } });
    for (let i = 0; i < 3; i++) await expect(service.execute(click, ctx)).rejects.toThrow('dispatched');
    expect(service.status().state).toBe('paused');
    await expect(service.execute(click, ctx)).rejects.toThrow('human control');
    await service.execute(commandSchema.parse({ action: 'close' }), ctx);
    expect(service.status().message).toBeUndefined();
  });
  it('refuses stale canvas controls, including controls queued behind a release', async () => {
    const { service, driver, ctx } = await setup();
    await service.execute(navigate, ctx);
    const id = service.status().session!.id;
    await expect(service.control('stop', 'another-session')).rejects.toThrow('session changed');
    expect(driver.close).not.toHaveBeenCalled();
    const release = service.control('release', id);
    const staleStop = service.control('stop', id);
    await release;
    await expect(staleStop).rejects.toThrow('session changed');
    expect(service.status().state).toBe('idle');
  });
  it('status never launches a browser, and a separate process defaults to unavailable', async () => {
    const driver = fake();
    const service = new BrowserService(driver);
    expect(service.status()).toMatchObject({ state: 'unavailable', enabled: false });
    await expect(service.execute(navigate, contexts())).rejects.toThrow('buddi serve');
    expect(driver.start).not.toHaveBeenCalled();
  });
  it.each(['absent', 'expired', 'delegate', 'no-conversation'] as const)('refuses %s authority before launch', async (kind) => {
    const { driver, service, ctx } = await setup();
    if (kind === 'absent') delete ctx.ownerRequest;
    if (kind === 'expired') ctx.ownerRequest!.expiresAt = 0;
    if (kind === 'delegate') ctx.delegationDepth = 1;
    if (kind === 'no-conversation') delete ctx.conversationId;
    await expect(service.execute(navigate, ctx)).rejects.toThrow('authenticated');
    expect(driver.start).not.toHaveBeenCalled();
  });
  it('executes a granted session tool without per-action approval', async () => {
    const { service, ctx } = await setup();
    const registry = new ToolRegistry(); registry.register(createBrowserManifest(service));
    expect(registry.list().find((t) => t.name === 'browser.act')?.inputSchema.type).toBe('object');
    await expect(registry.invoke('browser.act', navigate, ctx)).resolves.toMatchObject({ ok: true });
    expect(service.status()).toMatchObject({ state: 'running', session: { agentId: 'concierge', steps: 1 } });
    await expect(registry.invoke('browser.act', navigate, { ...ctx, sessionTools: [] })).resolves.toMatchObject({ reason: 'session-not-authorized' });
  });
  it('refuses a second agent or conversation without touching the driver', async () => {
    const { service, driver, ctx } = await setup();
    await service.execute(navigate, ctx);
    for (const other of [{ agentId: 'other' }, { conversationId: 'other' }, { ownerId: 'other' }]) {
      await expect(service.execute(observe, hosted({ ...ctx, ...other }))).rejects.toThrow('Another agent');
    }
    expect(driver.perform).toHaveBeenCalledTimes(1);
  });
  it('refuses concurrent commands and interrupts an in-flight action on Stop', async () => {
    const { service, driver, ctx } = await setup();
    let finish!: () => void;
    vi.mocked(driver.perform).mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = service.execute(navigate, ctx);
    await vi.waitFor(() => expect(driver.perform).toHaveBeenCalled());
    await expect(service.execute(observe, ctx)).rejects.toThrow('busy');
    await service.control('stop');
    finish();
    await expect(first).rejects.toThrow('stopped');
    expect(driver.close).toHaveBeenCalled();
    expect(service.status()).toMatchObject({ state: 'stopped', hasScreenshot: false });
    expect(service.status().session).toBeUndefined();
    await expect(service.execute(navigate, { ...ctx, ownerRequest: { ...ctx.ownerRequest!, id: 'new' } })).rejects.toThrow('owner stopped');
  });
  it('cancels on run abort; model arguments cannot restart access', async () => {
    const { service, driver, ctx } = await setup();
    const controller = new AbortController();
    vi.mocked(driver.perform).mockImplementation(async () => { controller.abort(new Error('cancelled')); });
    await expect(service.execute(navigate, { ...ctx, signal: controller.signal })).rejects.toThrow('cancelled');
    expect(service.status().state).toBe('stopped');
    expect(driver.close).toHaveBeenCalled();
    expect(commandSchema.safeParse({ action: 'resume' }).success).toBe(false);
  });
  it('preserves the idle browser during takeover and requires owner resume', async () => {
    const { service, driver, ctx } = await setup();
    await service.execute(navigate, ctx);
    await service.control('takeover');
    expect(driver.close).not.toHaveBeenCalled();
    await expect(service.execute(observe, ctx)).rejects.toThrow('human control');
    await service.control('resume');
    await service.execute(observe, ctx);
  });
  it('keeps the page when the owner takes over mid-action, and offers a hand on it', async () => {
    const driver = fake();
    let release = () => {};
    // An agent part-way through a navigation, as it is when the owner gives up
    // waiting and presses Take over.
    driver.perform = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    driver.interrupt = vi.fn(async () => {});
    driver.handReady = () => true;
    driver.hand = { start: async () => {}, input: async () => {}, stop: async () => {} };
    const service = new BrowserService(driver);
    services.push(service);
    await service.enable();
    const ctx = contexts();
    const working = service.execute(navigate, ctx).catch((error: Error) => error);
    await vi.waitFor(() => expect(service.status().busy).toBe(true));

    await service.control('takeover');
    // The action was abandoned; the tab it was in was not.
    expect(driver.interrupt).toHaveBeenCalled();
    expect(driver.close).not.toHaveBeenCalled();
    expect(service.status().state).toBe('paused');
    expect(service.hand().hand).toBe(driver.hand);
    expect(service.status().message).toContain('still open');

    // And the interrupted command cannot drag the state back out of paused.
    release();
    await working;
    expect(service.status().state).toBe('paused');
  });

  it('closes the screen, and says so, when the interrupted driver has none left', async () => {
    const driver = fake();
    let release = () => {};
    driver.perform = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    driver.interrupt = vi.fn(async () => { throw new Error('The browser tab is closed.'); });
    driver.hand = { start: async () => {}, input: async () => {}, stop: async () => {} };
    const service = new BrowserService(driver);
    services.push(service);
    await service.enable();
    const ctx = contexts();
    const working = service.execute(navigate, ctx).catch((error: Error) => error);
    await vi.waitFor(() => expect(service.status().busy).toBe(true));

    await service.control('takeover');
    expect(driver.close).toHaveBeenCalled();
    // No hand over nothing: the owner is told what to do instead of watching a
    // live view that never draws.
    expect(service.hand().hand).toBeUndefined();
    expect(service.hand().message).toContain('window closed');
    release();
    await working;
  });

  it('enforces a request budget even when the agent tries close/reopen', async () => {
    const { service, ctx } = await setup({ maxSteps: 1 });
    await service.execute(navigate, ctx);
    await expect(service.execute(observe, ctx)).rejects.toThrow('limit');
    await expect(service.execute(navigate, ctx)).rejects.toThrow('ended');
    await service.execute(navigate, { ...ctx, ownerRequest: { ...ctx.ownerRequest!, id: 'new-owner-message' } });
    expect(service.status().session?.steps).toBe(1);
  });
  it('treats observation loss after a successful action as completed, not retryable', async () => {
    const { service, driver, ctx } = await setup();
    vi.mocked(driver.observe).mockRejectedValue(new Error('page vanished'));
    await expect(service.execute(navigate, ctx)).resolves.toMatchObject({ completed: true, observed: false, message: expect.stringContaining('Do not repeat') });
    expect(driver.perform).toHaveBeenCalledTimes(1);
    expect(service.status()).toMatchObject({ state: 'paused', hasScreenshot: false, message: expect.stringContaining('page vanished') });
    await expect(service.execute(navigate, ctx)).rejects.toThrow('human control');
    expect(driver.perform).toHaveBeenCalledTimes(1);
  });
  it.each(['observe', 'screenshot'] as const)('surfaces %s failure as a failed observation, clears evidence and stops blind retries', async (method) => {
    const { service, driver, ctx } = await setup();
    await service.execute(navigate, ctx);
    vi.mocked(driver[method]).mockRejectedValue(new BrowserPreconditionError('The selected app is no longer in front'));
    const registry = new ToolRegistry(); registry.register(createBrowserManifest(service));
    const failed = await registry.invoke('browser.act', observe, ctx);
    expect(failed).toMatchObject({ ok: false, reason: 'tool-error', message: expect.stringContaining('no longer in front') });
    if (!failed.ok) expect(JSON.parse(failed.message)).toMatchObject({ completed: false, observed: false, state: 'paused' });
    expect(service.status()).toMatchObject({ state: 'paused', hasScreenshot: false });
    expect(service.status().page).toBeUndefined();
    expect(service.screenshot()).toBeUndefined();
    expect(driver.observe).toHaveBeenCalledTimes(2); // No hidden recovery retry.
    await expect(service.execute(observe, ctx)).rejects.toThrow('human control');
    expect(driver.perform).toHaveBeenCalledTimes(2);

    vi.mocked(driver.observe).mockResolvedValue({ ...observation, id: 'fresh' });
    vi.mocked(driver.screenshot).mockResolvedValue(Buffer.from('new screenshot'));
    await service.control('resume');
    const click = commandSchema.parse({ action: 'click', observation: 'o1', target: { ref: 'e1' } });
    await expect(service.execute(click, ctx)).rejects.toThrow('fresh observation');
    await expect(service.execute(observe, ctx)).resolves.toMatchObject({ completed: true, observation: { id: 'fresh' } });
    expect(service.status()).toMatchObject({ state: 'running', hasScreenshot: true });
    expect(service.status().message).toBeUndefined();
  });
  it('keeps release available after observation fails', async () => {
    const { service, driver, ctx } = await setup();
    await service.execute(navigate, ctx);
    vi.mocked(driver.observe).mockRejectedValue(new Error('capture unavailable'));
    await expect(service.execute(observe, ctx)).rejects.toThrow('capture unavailable');
    await expect(service.execute(commandSchema.parse({ action: 'close' }), ctx)).resolves.toMatchObject({ closed: true });
    expect(service.status()).toMatchObject({ state: 'idle', hasScreenshot: false });
  });
  it('does not claim fresh evidence when precondition recovery also fails', async () => {
    const { service, driver, ctx } = await setup();
    await service.execute(navigate, ctx);
    vi.mocked(driver.perform).mockRejectedValue(new BrowserPreconditionError('Focus changed'));
    vi.mocked(driver.observe).mockRejectedValue(new Error('Cannot uniquely identify the focused native window'));
    const click = commandSchema.parse({ action: 'click', observation: 'o1', target: { ref: 'e1' } });
    await expect(service.execute(click, ctx)).rejects.toThrow('Cannot uniquely identify');
    expect(service.status()).toMatchObject({ state: 'paused', hasScreenshot: false });
    expect(service.status().page).toBeUndefined();
  });
  it('pauses after an uncertain submission and does not retry it', async () => {
    const { service, driver, ctx } = await setup();
    await service.execute(navigate, ctx);
    vi.mocked(driver.perform).mockRejectedValue(new Error('timeout after click'));
    const click = commandSchema.parse({ action: 'click', target: { role: 'button', name: 'Book' }, observation: 'o1' });
    await expect(service.execute(click, ctx)).rejects.toThrow('timeout');
    expect(service.status().state).toBe('paused');
    await expect(service.execute(click, ctx)).rejects.toThrow('human control');
    expect(driver.perform).toHaveBeenCalledTimes(2);
  });
  it('enforces wall-clock expiry', async () => {
    let now = Date.now();
    const { service, ctx } = await setup({ now: () => now, lifetimeMs: 100 });
    await service.execute(navigate, ctx);
    now += 200;
    await expect(service.execute(observe, ctx)).rejects.toThrow('limit');
    expect(service.status().state).toBe('expired');
  });
  it('keeps owner Stop across a host service restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-browser-stop-'));
    try {
      const { service } = await setup({ controlFile: path.join(dir, 'control.json') });
      await service.control('stop');
      await service.shutdown();
      const { service: restarted, ctx } = await setup({ controlFile: path.join(dir, 'control.json') });
      expect(restarted.status().state).toBe('stopped');
      await restarted.control('release');
      expect(restarted.status().state).toBe('stopped');
      await restarted.control('resume');
      await restarted.execute(navigate, ctx);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('the stopped refusal says where the owner can undo it', () => {
  it('names /browser resume on Telegram and the Settings page elsewhere', async () => {
    const { service, ctx } = await setup();
    await service.control('stop');
    await expect(service.execute(navigate, { ...ctx, surface: TELEGRAM_SURFACE }))
      .rejects.toThrow('send /browser resume here');
    await expect(service.execute(navigate, { ...ctx, surface: WEB_SURFACE }))
      .rejects.toThrow('in the dashboard, on the Settings page');
    // No surface declared is the dashboard's wording, not Telegram's: a
    // command nobody can type is worse than a page anybody can open.
    await expect(service.execute(navigate, ctx)).rejects.toThrow('Settings page');
    expect(browserStoppedMessage(TELEGRAM_SURFACE)).toContain('/browser resume');
  });
});
