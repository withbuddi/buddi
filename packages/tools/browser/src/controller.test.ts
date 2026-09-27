import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginHost, hostBindingOf, type CoreToolContext } from '@buddi/core/testing';

/** The context core hands the browser plugin: these facts, with its `ctx.buddi` built over them. */
const BROWSER_HOST = hostBindingOf({ name: 'browser', version: '0.1.0', schema: 'browser', migrationsDir: '', tools: [] });
const hosted = (facts: CoreToolContext): CoreToolContext => ({ ...facts, buddi: createPluginHost(BROWSER_HOST, facts) });
import { HostController } from './controller.js';
import type { AppQuery } from './computer.js';
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
describe('the agents\' own browser on this machine', () => {
  it('says when no browser is installed, and follows an install to its end', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-computer-'));
    let installed = false;
    let finish!: () => void;
    const controller = new HostController(dir, {
      platform: 'linux', env: {},
      detect: () => (installed ? { engine: 'chromium', executable: '/x/chrome' } : { engine: 'none' }),
      installer: async (onLine) => {
        onLine('Downloading Chrome for Testing 140.0.7339.16 (playwright chromium v1187) from https://cdn.playwright.dev/builds/cft/140.0.7339.16/linux64/chrome-linux64.zip');
        onLine('|■■■■■■■■                                                                        |  10% of 170.4 MiB');
        await new Promise<void>((resolve) => { finish = resolve; }); installed = true; return { ok: true, detail: 'done', missingLibraries: false };
      },
    });
    resources.push({ dir, controller }); await controller.enable();
    expect(controller.status().browser).toMatchObject({ engine: 'none', headless: true, message: expect.stringContaining('No browser installed for the agents yet') });
    // Numbers for a progress bar, and none of the installer's own text.
    expect(controller.installBrowser().browser?.install).toEqual({
      state: 'running',
      progress: { phase: 'downloading', percent: 10, what: 'Chromium', download: 1 },
    });
    finish(); await new Promise((resolve) => setTimeout(resolve, 0));
    const after = controller.status().browser!;
    expect(after).toMatchObject({ engine: 'chromium', headless: true, install: { state: 'done', line: 'Chromium is installed.', progress: { phase: 'done', percent: 100 } } });
    expect(after.message).toContain('headless');
  });

  it('checks that the browser launches, headless as the machine dictates, and says why not', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-computer-'));
    const launches: Array<{ headless: boolean }> = [];
    let failWith: string | null = null;
    const controller = new HostController(dir, {
      platform: 'linux', env: {},
      detect: () => ({ engine: 'chromium', executable: '/x/chrome' }),
      launch: async (options) => { launches.push(options); if (failWith) throw new Error(failWith); },
    });
    resources.push({ dir, controller }); await controller.enable();

    expect(await controller.checkLaunch()).toEqual({ ok: true });
    expect(launches).toEqual([{ headless: true, chromiumSandbox: true }]);

    failWith = 'browserType.launch: Host system is missing dependencies to run browsers.\n  sudo npx playwright install-deps';
    const missing = await controller.checkLaunch();
    expect(missing).toMatchObject({ ok: false, problem: 'missing-libraries', message: expect.stringContaining('lacks system libraries') });
    expect(missing.ok ? '' : missing.command).toContain('install-deps chromium');
    // Remembered, as a failed launch from a session would be.
    expect(controller.status().browser?.problem).toBe('missing-libraries');

    failWith = 'Target page, context or browser has been closed\n[err] No usable sandbox! See apparmor-userns-restrictions.md';
    expect(await controller.checkLaunch()).toMatchObject({ ok: false, problem: 'no-sandbox', command: 'sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0' });
    expect(controller.status().browser).toMatchObject({ problem: 'no-sandbox', message: expect.stringContaining('does not let it start its sandbox') });

    failWith = 'Target page, context or browser has been closed\nmore detail';
    expect(await controller.checkLaunch()).toEqual({
      ok: false,
      message: 'The browser is installed but would not start: Target page, context or browser has been closed',
    });
  });
});

describe('an app the owner has not allowed', () => {
  const conversation = '11111111-1111-4111-8111-111111111111';
  const voicito = { bundleId: 'com.example.voicito', name: 'Voicito' };
  type Card = { envelope: unknown; state: string; choices?: Record<string, string> };
  function asking(cards: Card[] = []) {
    const base = ctx(conversation);
    return { ...base, buddi: { ...base.buddi!, approvals: { ...base.buddi!.approvals, decisionsInConversation: async () => cards } } } as CoreToolContext;
  }
  async function computer(apps: Array<typeof voicito> = [voicito]) {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-computer-'));
    const performed: unknown[] = [];
    const driver: BrowserDriver = { start: vi.fn(async () => {}), perform: vi.fn(async (command) => { performed.push(command); }), close: vi.fn(async () => {}), screenshot: async () => undefined,
      observe: async () => ({ id: 'o', url: 'app://com.example.voicito', appId: 'com.example.voicito', title: 'Voicito', tree: '', tabs: [], capturedAt: new Date().toISOString() }) };
    const resolveApp = vi.fn(async (query: AppQuery) => apps.filter((app) => 'near' in query ? true : 'name' in query ? app.name.toLowerCase() === query.name.toLowerCase() : app.bundleId === query.bundleId));
    const controller = new HostController(dir, { platform: 'darwin', resolveApp,
      manager: (settings) => new BrowserManager(() => driver, { controlFile: path.join(dir, 'control.json'), maxSessions: settings.mode === 'computer' ? 1 : 8, allowOpen: settings.mode === 'computer' }) });
    resources.push({ dir, controller }); await controller.enable();
    await controller.configure({ ...controller.status().settings!, mode: 'computer' });
    return { dir, controller, performed, resolveApp };
  }
  const byName = commandSchema.parse({ action: 'open', app: 'voicito' });

  it('resolves a name to one installed app and refuses none or several', async () => {
    const { controller } = await computer([voicito, { bundleId: 'org.other.voicito', name: 'Voicito' }]);
    await expect(controller.tierFor(byName, asking())).rejects.toThrow('Several apps are called voicito: Voicito (com.example.voicito), Voicito (org.other.voicito). Say which bundle id.');
    await expect(controller.tierFor(commandSchema.parse({ action: 'open', app: 'Nope' }), asking())).rejects.toThrow('No installed app is called Nope.');
    await expect(controller.tierFor(commandSchema.parse({ action: 'open', appId: 'com.nope' }), asking())).rejects.toThrow('No installed app has the bundle id com.nope.');
  });
  it('asks with a card naming the resolved app, Once or Always', async () => {
    const { controller } = await computer();
    await expect(controller.tierFor(byName, asking())).resolves.toEqual({ tier: 'gated' });
    const card = await controller.describe(byName, asking());
    expect(card.envelope).toEqual({ tool: 'browser.act', allowApp: 'com.example.voicito', name: 'Voicito' });
    expect(card.preview).toBe(`Use Voicito on your computer?\n${conversation} wants to open Voicito (com.example.voicito). While it works, buddi sees that window's screen and sends it to the model, as with the apps you allowed already.`);
    expect(card.choices).toEqual([{ key: 'remember', label: 'Allow', options: ['Once', 'Always'], default: 'Once' }]);
    // An allowed app, and every other action, is the session grant as before.
    await expect(controller.tierFor(commandSchema.parse({ action: 'open', app: 'Safari' }), asking())).rejects.toThrow('No installed app');
    await expect(controller.tierFor(open, asking())).resolves.toEqual({ tier: 'session' });
    await expect(controller.tierFor(commandSchema.parse({ action: 'navigate', url: 'https://example.com' }), asking())).resolves.toEqual({ tier: 'session' });
  });
  it('Once allows it for this conversation only, and the screen guard sees it', async () => {
    const { controller, performed } = await computer();
    await expect(controller.execute(byName, asking())).rejects.toThrow('not allowed yet');
    const granted = await controller.execute(byName, { ...asking(), actionId: 'action-1', choices: { remember: 'Once' } });
    expect(granted).toMatchObject({ allowed: { appId: 'com.example.voicito', remember: 'Once' } });
    expect(performed).toEqual([]);
    await expect(controller.tierFor(byName, asking())).resolves.toEqual({ tier: 'session' });
    await controller.execute(byName, asking());
    expect(performed).toEqual([expect.objectContaining({ action: 'open', appId: 'com.example.voicito' })]);
    expect(controller.status({ agentId: conversation, conversationId: conversation }).session?.allowedOnce).toEqual(['com.example.voicito']);
    expect(controller.status().settings!.allowedApps).not.toContain('com.example.voicito');
    await expect(controller.tierFor(byName, { ...asking(), conversationId: '22222222-2222-4222-8222-222222222222' })).resolves.toEqual({ tier: 'gated' });
  });
  it('Always adds it to the list in Settings, with a session running', async () => {
    const { controller, dir } = await computer();
    await controller.execute(open, asking());
    await controller.execute(byName, { ...asking(), actionId: 'action-1', choices: { remember: 'Always' } });
    expect(controller.status().settings!.allowedApps).toContain('com.example.voicito');
    expect(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')).allowedApps).toContain('com.example.voicito');
    await expect(controller.tierFor(byName, asking())).resolves.toEqual({ tier: 'session' });
  });
  it('No is refused without a second card; a waiting card is not doubled; a Once survives a restart through the ledger', async () => {
    const { controller } = await computer();
    const envelope = { tool: 'browser.act', allowApp: 'com.example.voicito', name: 'Voicito' };
    await expect(controller.tierFor(byName, asking([{ envelope, state: 'rejected' }]))).rejects.toThrow('The owner said no to Voicito this time.');
    await expect(controller.tierFor(byName, asking([{ envelope, state: 'pending' }]))).rejects.toThrow('has not answered');
    await expect(controller.tierFor(byName, asking([{ envelope, state: 'expired' }]))).resolves.toEqual({ tier: 'gated' });
    await expect(controller.tierFor(byName, asking([{ envelope: { ...envelope, allowApp: 'com.other' }, state: 'rejected' }]))).resolves.toEqual({ tier: 'gated' });
    await expect(controller.tierFor(byName, asking([{ envelope, state: 'succeeded', choices: { remember: 'Once' } }]))).resolves.toEqual({ tier: 'session' });
  });
  it('answers a typo with the close names and picks none of them', async () => {
    const { controller, performed } = await computer([{ bundleId: 'co.applex.vocito', name: 'Vocito' }]);
    await expect(controller.tierFor(byName, asking())).rejects.toThrow('No app called voicito. Did you mean Vocito (co.applex.vocito)? Ask again with that name.');
    await expect(controller.execute(byName, asking())).rejects.toThrow('Did you mean Vocito');
    expect(performed).toEqual([]);
  });
  it('opens the conversation\'s own app again without a card, to bring it forward', async () => {
    const { controller, performed } = await computer();
    await controller.execute(byName, { ...asking(), actionId: 'action-1', choices: { remember: 'Once' } });
    await controller.execute(byName, asking());
    await expect(controller.tierFor(byName, asking())).resolves.toEqual({ tier: 'session' });
    await controller.execute(commandSchema.parse({ action: 'open', appId: 'com.example.voicito' }), asking());
    expect(performed).toEqual([expect.objectContaining({ action: 'open', appId: 'com.example.voicito' }), expect.objectContaining({ action: 'open', appId: 'com.example.voicito' })]);
  });
  it('raises no card outside computer mode', async () => {
    const { controller } = await computer();
    await controller.configure({ ...controller.status().settings!, mode: 'playwright' });
    await expect(controller.tierFor(byName, asking())).resolves.toEqual({ tier: 'session' });
    await expect(controller.execute(byName, asking())).rejects.toThrow('require Computer mode');
  });
});
