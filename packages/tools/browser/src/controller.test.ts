import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginHost, hostBindingOf, type CoreToolContext } from '@buddi/core/testing';

/** The context core hands the browser plugin: these facts, with its `ctx.buddi` built over them. */
const BROWSER_HOST = hostBindingOf({ name: 'browser', version: '0.1.0', schema: 'browser', migrationsDir: '', tools: [] });
const hosted = (facts: CoreToolContext): CoreToolContext => ({ ...facts, buddi: createPluginHost(BROWSER_HOST, facts) });
import { HostController } from './controller.js';
import { BrowserManager } from './manager.js';
import { commandSchema, type BrowserDriver } from './types.js';

const resources: Array<{ dir: string; controller: HostController }> = [];
const ctx = (id = 'a'): CoreToolContext => hosted({ ownerId: 'owner', db: {} as never, now: () => new Date(), timezone: 'UTC', agentId: id, conversationId: id,
  ownerRequest: { id: `request-${id}`, text: 'Open the app', expiresAt: Date.now() + 60_000 } });
const open = commandSchema.parse({ action: 'open', appId: 'com.apple.Safari' });
async function setup(platform: NodeJS.Platform = 'darwin', mode: 'computer' | 'playwright' = 'computer') {
  const dir = await mkdtemp(path.join(tmpdir(), 'buddi-computer-'));
  const driver: BrowserDriver = { start: vi.fn(async () => {}), perform: vi.fn(async () => {}), close: vi.fn(async () => {}), screenshot: async () => undefined,
    observe: async () => ({ id: 'o', url: 'app://fixture', title: 'Fixture', tree: '', tabs: [], capturedAt: new Date().toISOString() }) };
  const factory = vi.fn((settings) => new BrowserManager(() => driver, { controlFile: path.join(dir, 'control.json'), maxSessions: settings.mode === 'computer' ? 1 : 8, allowOpen: settings.mode === 'computer' }));
  const controller = new HostController(dir, { manager: factory, platform });
  resources.push({ dir, controller }); await controller.enable();
  if (mode === 'computer') await controller.configure({ ...controller.status().settings!, mode: 'computer' });
  return { dir, controller, driver, factory };
}
afterEach(async () => { for (const { dir, controller } of resources.splice(0)) { await controller.shutdown(); await rm(dir, { recursive: true, force: true }); } });
describe('owner-controlled driver selection', () => {
  it('defaults a new installation to the agents\' own browser', async () => {
    const { controller } = await setup('darwin', 'playwright');
    expect(controller.status().mode).toBe('playwright');
  });
  it('treats a stored computer choice as the agents\' own browser off macOS, and keeps the file', async () => {
    const { dir } = await setup('darwin', 'computer');
    const linux = new HostController(dir, { manager: () => new BrowserManager(() => ({} as BrowserDriver), { controlFile: path.join(dir, 'control.json') }), platform: 'linux' });
    resources.push({ dir: await mkdtemp(path.join(tmpdir(), 'buddi-computer-')), controller: linux });
    await linux.enable();
    expect(linux.status().mode).toBe('playwright');
    expect(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')).mode).toBe('computer');
    await expect(linux.configure({ ...linux.status().settings!, mode: 'computer' })).rejects.toThrow('macOS-only');
  });
  it('serializes conversations on the desktop in computer mode', async () => {
    const { controller } = await setup();
    expect(controller.status().mode).toBe('computer');
    await controller.execute(open, ctx());
    await expect(controller.execute(open, ctx('b'))).rejects.toThrow('one mouse and keyboard');
    await controller.control('release', controller.status().session!.id);
    await expect(controller.execute(open, ctx('b'))).resolves.toMatchObject({ completed: true });
  });
  it('requires release before switching and persists an explicit Playwright selection', async () => {
    const { controller, dir } = await setup();
    await controller.execute(open, ctx());
    const settings = { ...controller.status().settings!, mode: 'playwright' };
    await expect(controller.configure(settings)).rejects.toThrow('Release');
    await controller.control('release', controller.status().session!.id);
    expect((await controller.configure(settings)).mode).toBe('playwright');
    expect(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')).mode).toBe('playwright');
    await expect(controller.execute(open, ctx('b'))).rejects.toThrow('require Computer mode');
    await expect(controller.execute(commandSchema.parse({ action: 'navigate', url: 'https://example.com' }), ctx())).rejects.toThrow('new owner request');
  });
  it('keeps a global Stop revoked when switching modes', async () => {
    const { controller } = await setup(); await controller.control('stop');
    await controller.configure({ ...controller.status().settings!, mode: 'playwright' });
    expect(controller.status().state).toBe('stopped');
    await expect(controller.execute(commandSchema.parse({ action: 'navigate', url: 'https://example.com' }), ctx())).rejects.toThrow('stopped');
  });
  it('validates settings and does not let missing permissions switch the driver', async () => {
    const { controller, factory } = await setup();
    await expect(controller.configure({ mode: 'computer', allowedApps: [] })).rejects.toThrow();
    expect(controller.status().mode).toBe('computer');
    // The first two managers (constructor, enable) are the fresh-install default, from before the owner chose computer mode.
    expect(factory.mock.calls.slice(2).every(([settings]) => settings.mode === 'computer')).toBe(true);
  });
});
