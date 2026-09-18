import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type ToolContext } from '@buddi/core';
import { BrowserService } from './service.js';
import { createBrowserManifest } from './index.js';
import { BrowserPreconditionError, commandSchema, type BrowserDriver, type Observation } from './types.js';

const observation: Observation = { id: 'o1', url: 'https://example.com/', title: 'Fixture', tree: '- button "Book"', tabs: [], capturedAt: new Date().toISOString() };
const navigate = commandSchema.parse({ action: 'navigate', url: 'https://example.com/' });
const observe = commandSchema.parse({ action: 'observe' });
const contexts = (): ToolContext => ({ db: {} as never, ownerId: 'owner', now: () => new Date(), timezone: 'UTC',
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
      await expect(service.execute(observe, { ...ctx, ...other })).rejects.toThrow('Another agent');
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
    await expect(service.execute(navigate, ctx)).resolves.toMatchObject({ completed: true, message: expect.stringContaining('do not repeat') });
    expect(driver.perform).toHaveBeenCalledTimes(1);
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
