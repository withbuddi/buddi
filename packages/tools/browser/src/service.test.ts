import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TELEGRAM_SURFACE, ToolRegistry, WEB_SURFACE, createPluginHost, hostBindingOf, type CoreToolContext } from '@buddi/core/testing';
import { browserPausedMessage, browserStoppedMessage, BrowserService, OWNER_WATCHING_MESSAGE } from './service.js';
import { createBrowserManifest } from './index.js';
import { BrowserPreconditionError, commandSchema, OBSERVE_AGAIN, UNTRUSTED, type BrowserDriver, type Observation } from './types.js';

/** The context core hands the browser plugin: these facts, with its `ctx.buddi` built over them. */
const BROWSER_HOST = hostBindingOf({ name: 'browser', version: '0.1.0', schema: 'browser', migrationsDir: '', tools: [] });
const hosted = (facts: CoreToolContext): CoreToolContext => ({ ...facts, buddi: createPluginHost(BROWSER_HOST, facts) });

const observation: Observation = { id: 'o1', url: 'https://example.com/', title: 'Fixture', tree: '- button "Book"', tabs: [], capturedAt: new Date().toISOString() };
const navigate = commandSchema.parse({ action: 'navigate', url: 'https://example.com/' });
const observe = commandSchema.parse({ action: 'observe' });
const contexts = (): CoreToolContext => hosted({ db: {} as never, ownerId: 'owner', now: () => new Date(), timezone: 'UTC',
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
  it('tells the model to ask the owner once when they are looking at the tab, without pausing or inviting a retry', async () => {
    const { service, driver, ctx } = await setup(); await service.execute(navigate, ctx);
    const watched = 'You are looking at this tab. buddi only acts in background tabs; observe again to continue in a new one.';
    vi.mocked(driver.perform).mockRejectedValueOnce(new BrowserPreconditionError(watched));
    vi.mocked(driver.observe).mockClear();
    const click = commandSchema.parse({ action: 'click', observation: 'o1', target: { ref: 'e1' } });
    const error = await service.execute(click, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrowserPreconditionError);
    const result = JSON.parse((error as Error).message);
    expect(result).toMatchObject({ error: OWNER_WATCHING_MESSAGE, dispatched: false });
    expect(result.error).toBe('The owner is looking at that tab. Ask them to switch to another tab or window, then try once more.');
    expect((error as Error).message).not.toContain('observe again');
    expect(driver.observe).not.toHaveBeenCalled();
    expect(service.status().state).toBe('running');
    // The model cannot retry by itself: the next action must be a fresh look.
    await expect(service.execute(click, ctx)).rejects.toThrow('fresh observation is required');
    await service.execute(observe, ctx);
    await expect(service.execute(click, ctx)).resolves.toMatchObject({ completed: true });
  });
  it('stamps every observation with when it was taken, and says so, so old evidence reads as old', async () => {
    let now = Date.parse('2026-09-26T12:04:35.250Z');
    const { service, driver, ctx } = await setup({ now: () => now });
    const first = await service.execute(navigate, ctx) as { observation: Observation; message: string; notice: string };
    expect(first.observation.observedAt).toBe('2026-09-26T12:04:35.250Z');
    expect(first.message).toBe('Observed 12:04:35 UTC.');
    expect(first.notice).toBe(UNTRUSTED);
    expect(UNTRUSTED).toContain('After a click that submits or navigates, observe once more before concluding; judge from the newest observation only.');
    expect(service.status().page?.observedAt).toBe('2026-09-26T12:04:35.250Z');

    // A recovery observation carries its own, newer stamp.
    now += 7_000;
    vi.mocked(driver.perform).mockRejectedValueOnce(new BrowserPreconditionError('Target is ambiguous'));
    vi.mocked(driver.observe).mockResolvedValue({ ...observation, id: 'fresh' });
    const error = await service.execute(commandSchema.parse({ action: 'click', observation: 'o1', target: { ref: 'e1' } }), ctx).catch((e: unknown) => e);
    const recovery = JSON.parse((error as Error).message);
    expect(recovery).toMatchObject({ dispatched: false, message: 'Observed 12:04:42 UTC.', observation: { id: 'fresh', observedAt: '2026-09-26T12:04:42.250Z' } });
  });
  it('tells the model in browser.act to observe once more before concluding', () => {
    const act = createBrowserManifest().tools.find((tool) => tool.name === 'browser.act')!;
    expect(act.description).toContain(OBSERVE_AGAIN);
    expect(act.description).toContain('Each result says when it was observed');
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
    await expect(service.execute(navigate, ctx)).resolves.toMatchObject({ completed: true, observed: false, state: 'running',
      recovery: 'The page has not answered yet. Wait a few seconds and observe again.', message: expect.stringContaining('Do not repeat') });
    expect(driver.perform).toHaveBeenCalledTimes(1);
    expect(service.status()).toMatchObject({ state: 'running', hasScreenshot: false, message: expect.stringContaining('page vanished') });
    await expect(service.execute(navigate, ctx)).rejects.toThrow('fresh observation');
    expect(driver.perform).toHaveBeenCalledTimes(1);
  });
  it('keeps control after a click whose observation failed, and says not to repeat the click', async () => {
    const { service, driver, ctx } = await setup();
    await service.execute(navigate, ctx);
    vi.mocked(driver.observe).mockRejectedValue(new BrowserPreconditionError('The page has not answered after three tries. Wait a few seconds and observe again.'));
    const click = commandSchema.parse({ action: 'click', observation: 'o1', target: { ref: 'e1' } });
    const result = await service.execute(click, ctx);
    expect(result).toMatchObject({ completed: true, observed: false, state: 'running' });
    expect((result as { message: string }).message).toBe('Action completed, but observation failed: The page has not answered after three tries. Wait a few seconds and observe again. Do not repeat the action; its effect may already have happened.');
    expect(service.status().state).toBe('running');
    await expect(service.execute(click, ctx)).rejects.toThrow('fresh observation');
    expect(driver.perform).toHaveBeenCalledTimes(2);
  });
  it.each(['The tab closed while it was loading.', 'Target page, context or browser has been closed'])('pauses when the screen is gone: %s', async (cause) => {
    const { service, driver, ctx } = await setup();
    await service.execute(navigate, ctx);
    vi.mocked(driver.observe).mockRejectedValue(new Error(cause));
    const registry = new ToolRegistry(); registry.register(createBrowserManifest(service));
    const failed = await registry.invoke('browser.act', observe, ctx);
    if (!failed.ok) expect(JSON.parse(failed.message)).toMatchObject({ state: 'paused', recovery: browserPausedMessage(undefined) });
    expect(service.status().state).toBe('paused');
    await expect(service.execute(observe, ctx)).rejects.toThrow('human control');
  });
  it.each(['observe', 'screenshot'] as const)('surfaces %s failure as a failed observation, clears evidence and stops blind retries', async (method) => {
    const { service, driver, ctx } = await setup();
    await service.execute(navigate, ctx);
    vi.mocked(driver[method]).mockRejectedValue(new BrowserPreconditionError('The selected app is no longer in front'));
    const registry = new ToolRegistry(); registry.register(createBrowserManifest(service));
    const failed = await registry.invoke('browser.act', observe, ctx);
    expect(failed).toMatchObject({ ok: false, reason: 'tool-error', message: expect.stringContaining('no longer in front') });
    // Once is a page to wait for: control stays, and the next step is a fresh look.
    if (!failed.ok) expect(JSON.parse(failed.message)).toMatchObject({ completed: false, observed: false, state: 'running',
      recovery: 'The page has not answered yet. Wait a few seconds and observe again.' });
    expect(service.status()).toMatchObject({ state: 'running', hasScreenshot: false });
    expect(service.status().page).toBeUndefined();
    expect(service.screenshot()).toBeUndefined();
    expect(driver.observe).toHaveBeenCalledTimes(2); // No hidden recovery retry.
    await expect(service.execute(commandSchema.parse({ action: 'click', observation: 'o1', target: { ref: 'e1' } }), ctx)).rejects.toThrow('fresh observation');
    // Three in a row is not a slow page any more.
    await expect(service.execute(observe, ctx)).rejects.toThrow('no longer in front');
    expect(service.status().state).toBe('running');
    const third = await registry.invoke('browser.act', observe, ctx);
    if (!third.ok) expect(JSON.parse(third.message)).toMatchObject({ state: 'paused', recovery: browserPausedMessage(undefined) });
    expect(service.status()).toMatchObject({ state: 'paused', hasScreenshot: false });
    await expect(service.execute(observe, ctx)).rejects.toThrow('human control');
    expect(driver.perform).toHaveBeenCalledTimes(4);

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
    expect(service.status()).toMatchObject({ state: 'running', hasScreenshot: false });
    expect(service.status().page).toBeUndefined();
    await expect(service.execute(click, ctx)).rejects.toThrow('fresh observation');
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
    expect(browserPausedMessage(TELEGRAM_SURFACE)).toContain('/browser resume');
    expect(browserPausedMessage(undefined)).toContain('Resume access');
  });
});
