import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginHost, hostBindingOf, type CoreToolContext } from '@buddi/core/testing';
import type { RouteProvider } from '@buddi/core/plugin';

/** The context core hands the browser plugin: these facts, with its `ctx.buddi` built over them. */
const BROWSER_HOST = hostBindingOf({ name: 'browser', version: '0.1.0', schema: 'browser', migrationsDir: '', tools: [] });
const hosted = (facts: CoreToolContext): CoreToolContext => ({ ...facts, buddi: createPluginHost(BROWSER_HOST, facts) });
import { APPS_NOT_INSTALLED, APPS_UNAVAILABLE, HostController, UNATTENDED_APPS, UNATTENDED_CHROME } from './controller.js';
import { NOT_CONNECTED, type ExtensionBridge } from './extension.js';
import { migrateSettings } from './settings.js';
import { commandSchema, type BrowserDriver, type Observation } from './types.js';

const resources: Array<{ dir: string; controller: HostController }> = [];
type Asked = { question: string; options: Array<{ label: string }> };
const ctx = (id = 'a', asked: Asked[] = []): CoreToolContext => ({ ...hosted({ ownerId: 'owner', db: {} as never, now: () => new Date(), timezone: 'UTC', agentId: id, conversationId: id,
  ownerRequest: { id: `request-${id}`, text: 'Look at the site', expiresAt: Date.now() + 60_000 } }), ask: (question) => { asked.push(question); } });
const open = commandSchema.parse({ action: 'open', appId: 'com.apple.Safari' });
const navigate = (url: string, extra: Record<string, unknown> = {}) => commandSchema.parse({ action: 'navigate', url, ...extra });
const observe = commandSchema.parse({ action: 'observe' });
afterEach(async () => { for (const { dir, controller } of resources.splice(0)) { await controller.shutdown(); await rm(dir, { recursive: true, force: true }); } });

/** A page driver for one route, recording where it went; `page` decides what each address looks like. */
function routeDriver(name: string, log: string[], page: (url: string) => Partial<Observation> = () => ({})): () => BrowserDriver {
  return () => {
    let url = '';
    return {
      start: vi.fn(async () => {}), close: vi.fn(async () => {}), screenshot: async () => undefined,
      perform: vi.fn(async (command) => { if (command.action === 'navigate' && command.url) { url = command.url; log.push(`${name} ${url}`); } else log.push(`${name} ${command.action}`); }),
      observe: async () => ({ id: `${name}-${log.length}`, url, title: 'Page', tree: '', tabs: [], capturedAt: new Date().toISOString(), ...page(url) }),
    };
  };
}
function chromeBridge(connected: { value: boolean }, paired = true): ExtensionBridge {
  return { connected: () => connected.value, paired: () => paired, send: async () => { throw new Error(NOT_CONNECTED); }, close: () => {} };
}
async function routes(options: { settings?: Record<string, unknown>; connected?: boolean; page?: (url: string) => Partial<Observation>; now?: () => number; platform?: NodeJS.Platform; agentPin?: (id: string) => 'own' | 'chrome' | undefined } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'buddi-routes-'));
  const log: string[] = [];
  const connected = { value: options.connected ?? true };
  const controller = new HostController(dir, {
    platform: options.platform ?? 'darwin', env: {},
    detect: () => ({ engine: 'chromium', executable: '/x/chrome' }),
    extensionBridge: () => chromeBridge(connected),
    drivers: { own: routeDriver('own', log, options.page), chrome: routeDriver('chrome', log, options.page), apps: routeDriver('apps', log) },
    service: { sleep: async () => {}, ...(options.now ? { now: options.now } : {}) },
    ...(options.agentPin ? { agentPin: options.agentPin } : {}),
  });
  resources.push({ dir, controller });
  await controller.enable();
  if (options.settings) await controller.configure(options.settings);
  return { dir, controller, log, connected };
}
const LOGIN = (url: string): Partial<Observation> => url.includes('/ap/signin')
  ? { title: 'Amazon Sign-In', tree: '- textbox "Email or mobile phone number"', targets: [{ ref: 'e1', frame: 0, role: 'textbox', name: 'Email or mobile phone number' }] }
  : url.includes('captcha') ? { title: 'Robot check', tree: '- heading "Type the characters you see: CAPTCHA"' } : {};

describe('settings become permissions, migrated from the old mode', () => {
  it.each([
    ['extension', false, { yourChrome: true, yourApps: 'off' }],
    ['computer', true, { yourChrome: true, yourApps: 'on' }],
    ['computer', false, { yourChrome: false, yourApps: 'on' }],
    ['playwright', true, { yourChrome: true, yourApps: 'off' }],
    ['playwright', false, { yourChrome: false, yourApps: 'off' }],
  ] as const)('%s (paired %s)', (mode, paired, expected) => {
    const { settings, migrated } = migrateSettings({ mode, browserApp: 'com.google.Chrome', allowedApps: ['com.google.Chrome', 'com.apple.Numbers'] }, { paired });
    expect(migrated).toBe(true);
    expect(settings).toMatchObject({ version: 2, ...expected });
    // The apps list is the Computer plugin's now.
    expect(settings).not.toHaveProperty('allowedApps');
  });
  it('drops the apps list from a v2 file, once, keeping the file beside it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-routes-'));
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ version: 2, yourChrome: false, yourApps: 'on', browserApp: 'com.google.Chrome', allowedApps: ['com.google.Chrome'] }));
    const controller = new HostController(dir, { platform: 'darwin', env: {} });
    resources.push({ dir, controller }); await controller.enable();
    const stored = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'));
    expect(stored).toMatchObject({ version: 2, yourApps: 'on' });
    expect(stored).not.toHaveProperty('allowedApps');
    expect(JSON.parse(await readFile(path.join(dir, 'settings.apps.json'), 'utf8'))).toMatchObject({ allowedApps: ['com.google.Chrome'] });
    // Wanted, but nobody provides it: not allowed, and the row says what to install.
    expect(controller.status().routes!.find((route) => route.kind === 'apps')).toMatchObject({ installed: false, allowed: false, available: false, mode: 'on', repair: 'install' });
  });
  it('rewrites settings.json once, keeping the old file beside it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-routes-'));
    await writeFile(path.join(dir, 'settings.json'), JSON.stringify({ mode: 'extension', browserApp: 'com.google.Chrome', allowedApps: ['com.google.Chrome'] }));
    const controller = new HostController(dir, { platform: 'linux', env: {} });
    resources.push({ dir, controller }); await controller.enable();
    expect(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'))).toMatchObject({ version: 2, yourChrome: true, yourApps: 'off' });
    expect(JSON.parse(await readFile(path.join(dir, 'settings.v1.json'), 'utf8'))).toMatchObject({ mode: 'extension' });
    expect(controller.status().routes!.map((route) => [route.kind, route.allowed])).toEqual([['own', true], ['chrome', true], ['apps', false]]);
  });
  it('changes with a page open: no mode lock, and turning a route off closes its pages', async () => {
    const { controller, log } = await routes({ settings: { yourChrome: true } });
    await controller.execute(navigate('https://shop.test/', { prefer: 'yours' }), ctx());
    expect(log).toEqual(['chrome https://shop.test/']);
    await controller.configure({ yourChrome: false });
    expect(controller.status().sessions).toHaveLength(0);
    await expect(controller.execute(navigate('https://shop.test/', { prefer: 'yours' }), ctx())).resolves.toMatchObject({ route: 'own' });
  });
  it('validates a change, and turns apps on only where a plugin provides them', async () => {
    const { controller } = await routes({ platform: 'linux' });
    await expect(controller.configure({ maxOwnPages: 0 })).rejects.toThrow();
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-routes-'));
    const bare = new HostController(dir, { platform: 'darwin', env: {} });
    resources.push({ dir, controller: bare }); await bare.enable();
    await expect(bare.configure({ yourApps: 'on' })).rejects.toThrow('Computer plugin');
    await expect(bare.execute(open, ctx())).rejects.toThrow(APPS_NOT_INSTALLED);
  });
});

describe('the route, chosen per task', () => {
  it('is buddi\'s own browser by default, with no chat line', async () => {
    const { controller, log } = await routes({ settings: { yourChrome: true } });
    const result = await controller.execute(navigate('https://news.test/'), ctx()) as { route: string; routeNote?: string };
    expect(result.route).toBe('own');
    expect(result.routeNote).toBeUndefined();
    expect(log).toEqual(['own https://news.test/']);
  });
  it('is the owner\'s Chrome for a site on his sign-in list, said once in the chat', async () => {
    const { controller } = await routes({ settings: { yourChrome: true, signInSites: ['amazon.com'] } });
    await expect(controller.execute(navigate('https://www.amazon.com/cart'), ctx())).resolves.toMatchObject({ route: 'chrome', routeNote: 'I used your Chrome because Amazon needs your sign-in.' });
    const again = await controller.execute(observe, ctx()) as { route: string; routeNote?: string };
    expect(again).toMatchObject({ route: 'chrome' });
    expect(again.routeNote).toBeUndefined();
  });
  it('follows the agent\'s ask (prefer: yours) and the pins: conversation over agent over global', async () => {
    const { controller } = await routes({ settings: { yourChrome: true }, agentPin: (id) => id === 'pinned' ? 'chrome' : undefined });
    await expect(controller.execute(navigate('https://shop.test/', { prefer: 'yours' }), ctx('a'))).resolves.toMatchObject({ route: 'chrome' });
    await expect(controller.execute(navigate('https://shop.test/'), ctx('pinned'))).resolves.toMatchObject({ route: 'chrome', routeNote: 'I used your Chrome for shop.test, as you set it.' });
    await controller.pin('pinned', 'own');
    await expect(controller.execute(navigate('https://shop.test/'), ctx('pinned'))).resolves.toMatchObject({ route: 'own' });
    expect(controller.status({ conversationId: 'pinned' }).pin).toBe('own');
    await controller.configure({ defaultRoute: 'chrome' });
    await expect(controller.execute(navigate('https://shop.test/'), ctx('c'))).resolves.toMatchObject({ route: 'chrome' });
    await controller.pin('pinned', 'auto');
    await expect(controller.pin('pinned', 'stealth')).rejects.toThrow('A pin is one of');
  });
  it('a task already in the owner\'s Chrome stays there for its next page (a checkout on another domain)', async () => {
    const { controller, log } = await routes({ settings: { yourChrome: true } });
    await controller.execute(navigate('https://shop.test/cart', { prefer: 'yours' }), ctx());
    await expect(controller.execute(navigate('https://pay.test/checkout'), ctx())).resolves.toMatchObject({ route: 'chrome' });
    expect(log).toEqual(['chrome https://shop.test/cart', 'chrome https://pay.test/checkout']);
  });
  it('a pin never allows what the switches forbid: Chrome off falls back to the own browser, silently but said', async () => {
    const { controller } = await routes({ settings: { yourChrome: false } });
    await controller.pin('a', 'chrome');
    await expect(controller.execute(navigate('https://shop.test/'), ctx())).resolves.toMatchObject({ route: 'own', routeNote: "Your Chrome isn't connected, so I used my own browser for shop.test." });
  });
  it('apps only for app jobs; an app job with apps off says the one fix', async () => {
    const off = await routes();
    await expect(off.controller.execute(open, ctx())).rejects.toThrow(APPS_UNAVAILABLE);
    const on = await routes({ settings: { yourApps: 'on' } });
    await expect(on.controller.execute(open, ctx())).resolves.toMatchObject({ route: 'apps', routeNote: 'I opened com.apple.Safari because the task needs it.' });
    expect(on.log).toEqual(['apps open']);
    // A web page still goes to the own browser, and the conversation moves with it.
    await expect(on.controller.execute(navigate('https://news.test/'), ctx())).resolves.toMatchObject({ route: 'own' });
  });
  it('an unattended task (a mission) looks only in the own browser, never the owner\'s Chrome', async () => {
    const { controller } = await routes({ settings: { yourChrome: true, signInSites: ['shop.test'] } });
    const mission = { ...ctx(), ownerRequest: undefined } as CoreToolContext;
    await expect(controller.execute(navigate('https://shop.test/'), mission)).resolves.toMatchObject({ route: 'own' });
  });
  it('a mission asking for the owner\'s Chrome or an app is refused with the reason, and no pin changes that', async () => {
    const { controller, log } = await routes({ settings: { yourChrome: true, yourApps: 'on', defaultRoute: 'chrome' } });
    const mission = { ...ctx('m'), ownerRequest: undefined } as CoreToolContext;
    await controller.pin('m', 'chrome');
    await expect(controller.execute(navigate('https://shop.test/', { prefer: 'yours' }), mission)).rejects.toThrow(UNATTENDED_CHROME);
    await expect(controller.tierFor(open, mission)).rejects.toThrow(UNATTENDED_APPS);
    await expect(controller.execute(open, mission)).rejects.toThrow(UNATTENDED_APPS);
    // The pins (conversation and global say Chrome) are passed over: the own browser.
    await expect(controller.execute(navigate('https://shop.test/'), mission)).resolves.toMatchObject({ route: 'own' });
    expect(log).toEqual(['own https://shop.test/']);
  });
  it("a mission's telemetry rows are marked; the owner's are not", async () => {
    const { controller } = await routes({ settings: { yourChrome: true } });
    await controller.execute(navigate('https://shop.test/'), { ...ctx('m'), ownerRequest: undefined } as CoreToolContext);
    await controller.execute(navigate('https://shop.test/'), ctx('o'));
    const routed = controller.telemetry.events.filter((event) => event.type === 'browser.route');
    expect(routed.map((event) => [event.agent, event.mission ?? false])).toEqual([['m', true], ['o', false]]);
  });
  it('a sign-in wall in a mission is a Sign in card (no Chrome option), asked through ctx.ask', async () => {
    const asked: Asked[] = [];
    const { controller } = await routes({ settings: { yourChrome: true }, page: LOGIN });
    const mission = { ...ctx('m', asked), ownerRequest: undefined } as CoreToolContext;
    const result = await controller.execute(navigate('https://www.amazon.com/ap/signin'), mission) as { route: string; needsOwner?: { kind: string; options: Array<{ label: string }> } };
    expect(result.route).toBe('own');
    expect(result.needsOwner?.kind).toBe('sign-in');
    expect(result.needsOwner?.options.map((o) => o.label)).not.toContain('Use my Chrome');
    expect(asked).toHaveLength(1);
  });
});

describe('fallback without a stop', () => {
  it('not-connected: Chrome asked for but offline means the own browser, and the chat line says so', async () => {
    const { controller, log } = await routes({ settings: { yourChrome: true, signInSites: ['shop.test'] }, connected: false });
    await expect(controller.execute(navigate('https://shop.test/'), ctx())).resolves.toMatchObject({ route: 'own', routeNote: "Your Chrome isn't connected, so I used my own browser for shop.test." });
    expect(log).toEqual(['own https://shop.test/']);
    expect(controller.telemetry.events.map((event) => event.type === 'browser.stop' ? event.cause : event.type)).toContain('route-unavailable');
  });
  it('not-connected mid-task: Chrome going away re-opens the same page in the own browser', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-routes-'));
    const log: string[] = [];
    let calls = 0;
    const flaky: () => BrowserDriver = () => {
      const base = routeDriver('chrome', log)();
      return { ...base, perform: vi.fn(async (command) => { if (++calls > 1) throw new Error(NOT_CONNECTED); await base.perform(command); }) };
    };
    const controller = new HostController(dir, { platform: 'linux', env: {}, detect: () => ({ engine: 'chromium', executable: '/x' }), extensionBridge: () => chromeBridge({ value: true }),
      drivers: { own: routeDriver('own', log), chrome: flaky }, service: { sleep: async () => {} } });
    resources.push({ dir, controller }); await controller.enable(); await controller.configure({ yourChrome: true });
    await controller.execute(navigate('https://shop.test/a', { prefer: 'yours' }), ctx());
    await expect(controller.execute(observe, ctx())).resolves.toMatchObject({ route: 'own', completed: true });
    expect(log).toEqual(['chrome https://shop.test/a', 'own https://shop.test/a']);
  });
  it('a sign-in wall in the own browser moves to the owner\'s Chrome, and the site is remembered', async () => {
    const { controller, log, dir } = await routes({ settings: { yourChrome: true }, page: LOGIN });
    await expect(controller.execute(navigate('https://www.amazon.com/ap/signin'), ctx())).resolves.toMatchObject({ route: 'chrome', routeNote: 'I used your Chrome because Amazon needs your sign-in.' });
    expect(log.slice(0, 2)).toEqual(['own https://www.amazon.com/ap/signin', 'chrome https://www.amazon.com/ap/signin']);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(path.join(dir, 'sign-in-sites.json'), 'utf8'))).toEqual(['amazon.com']));
    // Next time it goes to Chrome first.
    await expect(controller.execute(navigate('https://www.amazon.com/orders'), ctx('b'))).resolves.toMatchObject({ route: 'chrome' });
  });
});

describe('the owner cards, through the existing question card', () => {
  it('sign-in: no Chrome and no stored login is exactly one Sign in card, handed to the surface once', async () => {
    const asked: Asked[] = [];
    const { controller } = await routes({ page: LOGIN });
    const result = await controller.execute(navigate('https://www.amazon.com/ap/signin'), ctx('a', asked)) as { needsOwner: { kind: string } };
    expect(result.needsOwner.kind).toBe('sign-in');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.question).toBe('Amazon needs your sign-in\nSign in on the page and give it back, and I carry on.');
    expect(asked[0]!.options.map((option) => option.label)).toEqual(['Take over', 'Save a login for next time']);
    await controller.execute(observe, ctx('a', asked));
    expect(asked).toHaveLength(1);
  });
  it('sign-in: with Chrome allowed but closed, the card offers to use it once it is open', async () => {
    const asked: Asked[] = [];
    const { controller } = await routes({ settings: { yourChrome: true }, connected: false, page: LOGIN });
    await controller.execute(navigate('https://www.amazon.com/ap/signin'), ctx('a', asked));
    expect(asked[0]!.options.map((option) => option.label)).toEqual(['Take over', 'Use Chrome when it\u2019s open', 'Save a login for next time']);
  });
  it('sign-in: a stored login for the site is pointed at instead of a card', async () => {
    const asked: Asked[] = [];
    const { controller } = await routes({ page: LOGIN });
    const base = ctx('a', asked);
    const withLogin = { ...base, buddi: { ...base.buddi!, secrets: { list: async () => [{ name: 'Amazon', totp: false, bindings: [{ kind: 'browser.field', target: 'https://www.amazon.com' }], lastUse: null }] } } } as unknown as CoreToolContext;
    const result = await controller.execute(navigate('https://www.amazon.com/ap/signin'), withLogin) as { needsOwner?: unknown; message: string };
    expect(result.needsOwner).toBeUndefined();
    expect(result.message).toContain('secret.fill');
    expect(asked).toHaveLength(0);
  });
  it('human-check: a captcha is one Human check card', async () => {
    const asked: Asked[] = [];
    const { controller } = await routes({ page: LOGIN });
    await expect(controller.execute(navigate('https://shop.test/captcha'), ctx('a', asked))).resolves.toMatchObject({ needsOwner: { kind: 'human' } });
    expect(asked.map((card) => card.question.split('\n')[0])).toEqual(['This page asks for a human']);
  });
  it('answering Look takes the page over; Use my Chrome pins the conversation; Keep going renews the budget', async () => {
    const { controller } = await routes({ settings: { yourChrome: true }, connected: true, page: LOGIN });
    // Look: the sign-in card in Chrome.
    await controller.execute(navigate('https://www.amazon.com/ap/signin'), ctx());
    expect(controller.status({ agentId: 'a', conversationId: 'a' }).needsOwner?.kind).toBe('sign-in');
    await expect(controller.touch({ conversationId: 'a', text: 'Take over' })).resolves.toEqual({ answered: 'takeover' });
    expect(controller.status({ agentId: 'a', conversationId: 'a' }).state).toBe('paused');
    // Use my Chrome, from the own browser.
    const other = await routes({ connected: true, page: LOGIN });
    await other.controller.execute(navigate('https://www.amazon.com/ap/signin'), ctx('b'));
    await other.controller.configure({ yourChrome: true });
    await expect(other.controller.touch({ conversationId: 'b', text: 'Use my Chrome' })).resolves.toEqual({ answered: 'chrome' });
    expect(other.controller.status({ conversationId: 'b' }).pin).toBe('chrome');
  });
  it('take-over: one page in the owner\'s hands at a time', async () => {
    const { controller } = await routes();
    await controller.execute(navigate('https://a.test/'), ctx('a'));
    await controller.execute(navigate('https://b.test/'), ctx('b'));
    await controller.control('takeover', controller.status({ agentId: 'a', conversationId: 'a' }).session!.id);
    await expect(controller.control('takeover', controller.status({ agentId: 'b', conversationId: 'b' }).session!.id)).rejects.toThrow('already have a page in your hands');
  });
});

describe('Stop agents\' browsing', () => {
  it('expires after an hour by default; while it holds an agent gets one Resume card, and Resume lifts it', async () => {
    let now = Date.parse('2026-10-03T10:00:00Z');
    const asked: Asked[] = [];
    const { controller, dir } = await routes({ now: () => now });
    await controller.control('stop');
    expect(JSON.parse(await readFile(path.join(dir, 'control.json'), 'utf8'))).toMatchObject({ stopped: true, at: now, until: now + 60 * 60_000 });
    now += 2 * 60_000;
    const result = await controller.execute(navigate('https://news.test/'), ctx('a', asked)) as { needsOwner: { kind: string; question: string } };
    expect(result.needsOwner).toMatchObject({ kind: 'stopped', title: 'Browsing is paused since 10:00', line: 'You paused agents\u2019 browsing from the Canvas, until 11:00. I need one page: news.test.' });
    expect(asked[0]!.options.map((option) => option.label)).toEqual(['Resume', 'Keep paused']);
    await expect(controller.touch({ conversationId: 'a', text: 'Resume' })).resolves.toEqual({ answered: 'resume' });
    await expect(controller.execute(navigate('https://news.test/'), ctx())).resolves.toMatchObject({ completed: true });
    // And by itself, an hour later.
    await controller.control('stop');
    now += 61 * 60_000;
    await expect(controller.execute(navigate('https://news.test/'), ctx())).resolves.toMatchObject({ completed: true });
    expect(controller.status().stop).toBeUndefined();
  });
  it('"until I say" holds, and the expiry is a setting', async () => {
    let now = 0;
    const { controller } = await routes({ now: () => now, settings: { stopExpiryMinutes: 5 } });
    await controller.control('stop');
    expect(controller.status().stop).toMatchObject({ until: new Date(5 * 60_000).toISOString() });
    await controller.control('resume');
    await controller.control('stop', undefined, { forever: true });
    now += 7 * 24 * 60 * 60_000;
    await expect(controller.execute(navigate('https://news.test/'), ctx())).resolves.toMatchObject({ needsOwner: { kind: 'stopped' } });
  });
  it('a Stop kept from before expiries counts an hour from when it was written', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-routes-'));
    const file = path.join(dir, 'control.json');
    await writeFile(file, JSON.stringify({ stopped: true }));
    const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    await utimes(file, old, old);
    const controller = new HostController(dir, { platform: 'linux', env: {}, drivers: { own: routeDriver('own', []) } });
    resources.push({ dir, controller }); await controller.enable();
    expect(controller.status().stop).toBeUndefined();
    await expect(controller.execute(navigate('https://news.test/'), ctx())).resolves.toMatchObject({ completed: true });
  });
});

describe('budgets renewed by the owner', () => {
  it('any owner touch in the conversation renews the page\'s 200 steps and hour', async () => {
    const { controller } = await routes();
    await controller.execute(navigate('https://news.test/'), ctx());
    for (let i = 0; i < 5; i++) await controller.execute(observe, ctx());
    expect(controller.status({ agentId: 'a', conversationId: 'a' }).session).toMatchObject({ steps: 6, maxSteps: 200 });
    await controller.touch({ conversationId: 'a', text: 'thanks, now the next one' });
    expect(controller.status({ agentId: 'a', conversationId: 'a' }).session!.steps).toBe(0);
  });
});

describe('a route a plugin provides', () => {
  it('drives the apps route through its look and do, and names it in the health', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-routes-'));
    const done: string[] = [];
    const provider: RouteProvider = {
      kind: 'apps', label: 'your apps', health: () => ({ ok: true }),
      do: async (_session, command) => { done.push(command.action); },
      look: async () => ({ id: 'p1', url: 'app://numbers', title: 'Numbers', tree: '', tabs: [], capturedAt: new Date().toISOString(), screenshot: new Uint8Array([1, 2]) }),
    };
    const controller = new HostController(dir, { platform: 'linux', env: {} });
    controller.useRouteProviders(() => [{ ...provider, plugin: 'computer' }]);
    resources.push({ dir, controller }); await controller.enable();
    await controller.configure({ yourApps: 'on' });
    expect(controller.status().routes!.find((route) => route.kind === 'apps')).toMatchObject({ provider: 'computer', allowed: true, available: true });
    await expect(controller.execute(commandSchema.parse({ action: 'open', appId: 'com.apple.Numbers' }), ctx())).resolves.toMatchObject({ route: 'apps', observation: { title: 'Numbers' } });
    expect(done).toEqual(['open']);
  });
  it('is left out where its platforms say it does not run', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-routes-'));
    const controller = new HostController(dir, { platform: 'linux', env: {} });
    controller.useRouteProviders(() => [{ kind: 'apps', label: 'your apps', platforms: ['darwin'], health: () => ({ ok: true }), do: async () => {}, look: async () => { throw new Error('never'); }, plugin: 'computer' }]);
    resources.push({ dir, controller }); await controller.enable();
    expect(controller.status().routes!.find((route) => route.kind === 'apps')).toMatchObject({ installed: false });
  });
  it('has no remote hand: take-over pauses it and the Canvas gets its sentence; native typing passes through', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-routes-'));
    const calls: string[] = [];
    const provider: RouteProvider = {
      kind: 'apps', label: 'your apps', health: () => ({ ok: true }), handMessage: 'Take over at the Mac.',
      do: async (_s, command) => { calls.push(command.action); },
      look: async () => ({ id: 'p1', url: 'app://com.apple.Numbers', appId: 'com.apple.Numbers', title: 'Numbers', tree: '', tabs: [], capturedAt: new Date().toISOString() }),
      takeover: async () => { calls.push('takeover'); }, resume: () => { calls.push('resume'); },
      focused: async () => 'com.apple.Numbers', typeSecret: async () => { calls.push('typed'); },
    };
    const controller = new HostController(dir, { platform: 'darwin', env: {} });
    controller.useRouteProviders(() => [{ ...provider, plugin: 'computer' }]);
    resources.push({ dir, controller }); await controller.enable();
    await controller.configure({ yourApps: 'on' });
    await controller.execute(commandSchema.parse({ action: 'open', appId: 'com.apple.Numbers' }), ctx());
    const scope = { agentId: 'a', conversationId: 'a' };
    expect(controller.status(scope).session?.allowedApps).toEqual(['com.apple.Numbers']);
    expect(controller.hand(scope)).toEqual({ supported: false, message: 'Take over at the Mac.' });
    const session = controller.status(scope).session!.id;
    await controller.control('takeover', session);
    await controller.control('resume', session);
    expect(calls).toEqual(['open', 'takeover', 'resume']);
  });
});

describe('telemetry', () => {
  it('counts stops by cause for buddi doctor browser', async () => {
    const { controller } = await routes({ settings: { yourChrome: true, signInSites: ['shop.test'] }, connected: false });
    await controller.execute(navigate('https://shop.test/'), ctx());
    const summary = controller.telemetrySummary();
    expect(summary.byCause).toEqual(expect.arrayContaining([expect.objectContaining({ cause: 'route-unavailable', count: 1, outcome: 'removed' })]));
    expect(summary.routes).toMatchObject({ own: 1 });
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

describe('background by default', () => {
  it('the own browser runs headless, and shows a window only when the owner asks', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-computer-'));
    const launches: Array<{ headless: boolean }> = [];
    const controller = new HostController(dir, { platform: 'darwin', env: {}, detect: () => ({ engine: 'chromium', executable: '/x/chrome' }), launch: async (options) => { launches.push(options); } });
    resources.push({ dir, controller }); await controller.enable();
    await controller.checkLaunch();
    await controller.configure({ showWindow: true });
    await controller.checkLaunch();
    expect(launches.map((launch) => launch.headless)).toEqual([true, false]);
    const headed = new HostController(await mkdtemp(path.join(tmpdir(), 'buddi-computer-')), { platform: 'darwin', env: { BUDDI_BROWSER_HEADED: '1' }, detect: () => ({ engine: 'chromium', executable: '/x/chrome' }), launch: async (options) => { launches.push(options); } });
    resources.push({ dir: headed.dir, controller: headed }); await headed.enable();
    await headed.checkLaunch();
    expect(launches.at(-1)!.headless).toBe(false);
  });
});

describe('an app the owner has not allowed', () => {
  const conversation = '11111111-1111-4111-8111-111111111111';
  const voicito = { id: 'com.example.voicito', name: 'Voicito' };
  type Card = { envelope: unknown; state: string; choices?: Record<string, string> };
  function asking(cards: Card[] = []) {
    const base = ctx(conversation);
    return { ...base, buddi: { ...base.buddi!, approvals: { ...base.buddi!.approvals, decisionsInConversation: async () => cards } } } as CoreToolContext;
  }
  const precondition = (message: string) => Object.assign(new Error(message), { precondition: true });
  /** The Computer plugin, faked: its list, what it does with an app not on it, and Spotlight as a table. */
  async function computer(options: { apps?: Array<typeof voicito>; listed?: string[]; unlisted?: 'ask' | 'refuse'; full?: boolean } = {}) {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-computer-'));
    const performed: unknown[] = [];
    const apps = options.apps ?? [voicito, { id: 'com.apple.Safari', name: 'Safari' }];
    const listed = [...(options.listed ?? ['com.apple.Safari'])];
    const provider: RouteProvider = {
      kind: 'apps', label: 'your apps', exclusive: true, health: () => ({ ok: true }),
      do: async (_s, command) => { performed.push(command); },
      look: async () => ({ id: 'o', url: 'app://com.example.voicito', appId: 'com.example.voicito', title: 'Voicito', tree: '', tabs: [], capturedAt: new Date().toISOString() }),
      reach: {
        resolve: async (query) => {
          const found = apps.filter((app) => 'name' in query ? app.name.toLowerCase() === query.name.toLowerCase() : app.id === query.id);
          if (found.length !== 1) throw precondition('name' in query ? `No installed app is called ${query.name}.` : `No installed app has the bundle id ${query.id}.`);
          return found[0]!;
        },
        listed: (id) => listed.includes(id),
        unlisted: () => options.unlisted ?? 'ask',
        remember: async (target) => { if (options.full) return false; listed.push(target.id); return true; },
      },
    };
    const controller = new HostController(dir, { platform: 'darwin', env: {} });
    controller.useRouteProviders(() => [{ ...provider, plugin: 'computer' }]);
    resources.push({ dir, controller }); await controller.enable();
    await controller.configure({ yourApps: 'on' });
    return { dir, controller, performed, listed };
  }
  const byName = commandSchema.parse({ action: 'open', app: 'voicito' });

  it('asks the plugin who a name stands for, and refuses with its words', async () => {
    const { controller } = await computer();
    await expect(controller.tierFor(commandSchema.parse({ action: 'open', app: 'Nope' }), asking())).rejects.toThrow('No installed app is called Nope.');
    await expect(controller.tierFor(commandSchema.parse({ action: 'open', appId: 'com.nope' }), asking())).rejects.toThrow('No installed app has the bundle id com.nope.');
    await expect(controller.execute(commandSchema.parse({ action: 'open', app: 'Nope' }), asking())).rejects.toThrow('No installed app is called Nope.');
  });
  it('asks with a card naming the resolved app, Once or Always', async () => {
    const { controller } = await computer();
    await expect(controller.tierFor(byName, asking())).resolves.toEqual({ tier: 'gated' });
    const card = await controller.describe(byName, asking());
    expect(card.envelope).toEqual({ tool: 'browser.act', allowApp: 'com.example.voicito', name: 'Voicito' });
    expect(card.preview).toBe(`Use Voicito on your computer?\n${conversation} wants to open Voicito (com.example.voicito). While it works, buddi sees that window's screen and sends it to the model, as with the apps you allowed already.`);
    expect(card.choices).toEqual([{ key: 'remember', label: 'Allow', options: ['Once', 'Always'], default: 'Once' }]);
    // An app on the plugin's list, and every other action, is the session grant as before.
    await expect(controller.tierFor(open, asking())).resolves.toEqual({ tier: 'session' });
    await expect(controller.tierFor(commandSchema.parse({ action: 'navigate', url: 'https://example.com' }), asking())).resolves.toEqual({ tier: 'session' });
  });
  it('refuses without a card when the plugin says not to open others', async () => {
    const { controller } = await computer({ unlisted: 'refuse' });
    await expect(controller.tierFor(byName, asking())).rejects.toThrow("Voicito is not on the owner's list of apps");
    await expect(controller.tierFor(open, asking())).resolves.toEqual({ tier: 'session' });
  });
  it('Once allows it for this conversation only, and the screen guard sees it', async () => {
    const { controller, performed, listed } = await computer();
    await expect(controller.execute(byName, asking())).rejects.toThrow('not allowed yet');
    const granted = await controller.execute(byName, { ...asking(), actionId: 'action-1', choices: { remember: 'Once' } });
    expect(granted).toMatchObject({ allowed: { appId: 'com.example.voicito', remember: 'Once' } });
    expect(performed).toEqual([]);
    await expect(controller.tierFor(byName, asking())).resolves.toEqual({ tier: 'session' });
    await controller.execute(byName, asking());
    expect(performed).toEqual([expect.objectContaining({ action: 'open', appId: 'com.example.voicito' })]);
    expect(controller.status({ agentId: conversation, conversationId: conversation }).session?.allowedOnce).toEqual(['com.example.voicito']);
    expect(listed).not.toContain('com.example.voicito');
    await expect(controller.tierFor(byName, { ...asking(), conversationId: '22222222-2222-4222-8222-222222222222' })).resolves.toEqual({ tier: 'gated' });
  });
  it('Always puts it on the plugin\'s list; a full list makes it Once', async () => {
    const { controller, listed } = await computer();
    await controller.execute(open, asking());
    await expect(controller.execute(byName, { ...asking(), actionId: 'action-1', choices: { remember: 'Always' } })).resolves.toMatchObject({ allowed: { remember: 'Always' } });
    expect(listed).toContain('com.example.voicito');
    await expect(controller.tierFor(byName, asking())).resolves.toEqual({ tier: 'session' });
    const full = await computer({ full: true });
    await expect(full.controller.execute(byName, { ...asking(), actionId: 'action-2', choices: { remember: 'Always' } })).resolves.toMatchObject({ allowed: { remember: 'Once' } });
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
  it('raises no card with apps off, and the app job says the one fix', async () => {
    const { controller } = await computer();
    await controller.configure({ yourApps: 'off' });
    await expect(controller.tierFor(byName, asking())).resolves.toEqual({ tier: 'session' });
    await expect(controller.execute(byName, asking())).rejects.toThrow(APPS_UNAVAILABLE);
  });
  it('"ask each app" asks even for an app on the list, and offers Once only', async () => {
    const { controller } = await computer({ listed: ['com.apple.Safari', 'com.example.voicito'] });
    await controller.configure({ yourApps: 'ask' });
    await expect(controller.tierFor(byName, asking())).resolves.toEqual({ tier: 'gated' });
    expect((await controller.describe(byName, asking())).choices).toEqual([{ key: 'remember', label: 'Allow', options: ['Once'], default: 'Once' }]);
    await controller.configure({ yourApps: 'on' });
    await expect(controller.tierFor(byName, asking())).resolves.toEqual({ tier: 'session' });
  });
});
