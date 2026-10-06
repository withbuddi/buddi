import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPluginHost, hostBindingOf, type CoreToolContext } from '@buddi/core/testing';

/** The context core hands the browser plugin: these facts, with its `ctx.buddi` built over them. */
const BROWSER_HOST = hostBindingOf({ name: 'browser', version: '0.1.0', schema: 'browser', migrationsDir: '', tools: [] });
const hosted = (facts: CoreToolContext): CoreToolContext => ({ ...facts, buddi: createPluginHost(BROWSER_HOST, facts) });
import { HostController } from './controller.js';
import { DOWNLOAD_WINDOW_MS, ExtensionDriver, NOT_CONNECTED, type ExtensionBridge, type ExtensionCommand, type ExtensionDownload } from './extension.js';
import { BrowserOpenedError, BrowserPreconditionError, commandSchema } from './types.js';

/** A bridge that records what was asked of it and answers from a script. */
function bridge(answers: Partial<Record<string, unknown>> = {}, connected = true) {
  const sent: ExtensionCommand[] = [];
  const fake: ExtensionBridge = {
    connected: () => connected,
    send: async (command) => {
      sent.push(command);
      const answer = answers[command.name];
      if (answer instanceof Error) throw answer;
      return (answer as { observation?: unknown; screenshot?: string | null } | undefined) ?? {};
    },
    close: () => {},
  };
  return { fake, sent };
}

const page = { observation: { url: 'https://example.com/', title: 'Example', tree: 'Frame 0\n  link "Next"', targets: [{ ref: 'e1', frame: 0, role: 'link', name: 'Next', href: 'https://example.com/next' }], tabs: [{ id: 'tab-1', url: 'https://example.com/', title: 'Example' }] } };
const shot = { screenshot: Buffer.from('png').toString('base64') };
const command = (input: Record<string, unknown>) => commandSchema.parse(input);
const ctx = (id = 'a'): CoreToolContext => hosted({ ownerId: 'owner', db: {} as never, now: () => new Date(), timezone: 'UTC', agentId: id, conversationId: id,
  ownerRequest: { id: `request-${id}`, text: 'Open the website', expiresAt: Date.now() + 60_000 } });

const dirs: string[] = [];
const controllers: HostController[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.shutdown()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('the extension driver', () => {
  it('refuses to start, and to act, while no browser is connected', async () => {
    const { fake } = bridge({}, false);
    const driver = new ExtensionDriver(fake);
    await expect(driver.start()).rejects.toThrow(NOT_CONNECTED);
    await expect(driver.observe()).rejects.toThrow(NOT_CONNECTED);
    // Closing an absent browser is a no-op, never an error on release.
    await expect(driver.close()).resolves.toBeUndefined();
  });

  it('maps every command to a frame, scoped to this conversation session', async () => {
    const { fake, sent } = bridge({ observe: page, screenshot: shot });
    const driver = new ExtensionDriver(fake);
    await driver.start();
    await driver.perform(command({ action: 'navigate', url: 'https://example.com/' }));
    const observation = await driver.observe();
    expect(observation.targets?.[0]).toMatchObject({ ref: 'e1', role: 'link', name: 'Next' });
    expect(observation.tabs).toEqual([{ id: 'tab-1', url: 'https://example.com/', title: 'Example' }]);
    expect(await driver.screenshot()).toEqual(Buffer.from('png'));

    await driver.perform(command({ action: 'click', observation: observation.id, target: { ref: 'e1' } }));
    const fresh = await driver.observe();
    await driver.perform(command({ action: 'fill', observation: fresh.id, target: { ref: 'e1' }, value: 'hello' }));
    await driver.observe();
    await driver.perform(command({ action: 'tab', tabId: 'tab-1' }));
    await driver.perform(command({ action: 'close' }));
    expect(sent.map((c) => c.name)).toEqual(['navigate', 'observe', 'screenshot', 'click', 'observe', 'fill', 'observe', 'tab', 'close']);
    expect(new Set(sent.map((c) => c.session)).size).toBe(1);
    expect(sent[0]).toMatchObject({ args: { url: 'https://example.com/' } });
    expect(sent[5]).toMatchObject({ args: { target: { ref: 'e1' }, value: 'hello' } });
  });

  it('refuses native apps, coordinates, stale evidence and hosts outside the allow list', async () => {
    const { fake, sent } = bridge({ observe: page, screenshot: shot });
    const driver = new ExtensionDriver(fake, ['example.com']);
    await expect(driver.perform(command({ action: 'open', appId: 'com.apple.Safari' }))).rejects.toThrow(BrowserPreconditionError);
    await expect(driver.perform(command({ action: 'click', observation: 'o1', target: { x: 10, y: 10 } }))).rejects.toThrow(BrowserPreconditionError);
    await expect(driver.perform(command({ action: 'navigate', url: 'https://elsewhere.example/' }))).rejects.toThrow('outside the configured browser hosts');
    await expect(driver.perform(command({ action: 'click', observation: 'o1', target: { ref: 'e1' } }))).rejects.toThrow('Stale page observation');
    // A dispatched action spends its evidence: the same id cannot act twice.
    const observation = await driver.observe();
    await driver.perform(command({ action: 'click', observation: observation.id, target: { ref: 'e1' } }));
    await expect(driver.perform(command({ action: 'click', observation: observation.id, target: { ref: 'e1' } }))).rejects.toThrow('Stale page observation');
    expect(sent.map((c) => c.name)).toEqual(['observe', 'click']);
  });
});

describe('the owner\'s Chrome as a route', () => {
  it('is used for a site that needs the owner\'s sign-in only once Your Chrome is allowed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-extension-route-'));
    dirs.push(dir);
    const { fake, sent } = bridge({ observe: page, screenshot: shot });
    const controller = new HostController(dir, { extensionBridge: () => fake, platform: 'linux', drivers: { own: () => ({ start: async () => {}, perform: async () => {}, observe: async () => ({ id: 'own', url: 'https://example.com/', title: 'Own', tree: '', tabs: [], capturedAt: '' }), screenshot: async () => undefined, close: async () => {} }) } });
    controllers.push(controller);
    await controller.enable();
    await controller.configure({ signInSites: ['example.com'] });
    // Not allowed yet: the own browser serves, and the owner's Chrome is never touched.
    await expect(controller.execute(command({ action: 'navigate', url: 'https://example.com/' }), ctx())).resolves.toMatchObject({ completed: true, route: 'own' });
    expect(sent).toEqual([]);

    expect((await controller.configure({ yourChrome: true })).settings).toMatchObject({ yourChrome: true });
    expect(JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8'))).toMatchObject({ version: 2, yourChrome: true });
    await expect(controller.execute(command({ action: 'navigate', url: 'https://example.com/' }), ctx('b'))).resolves.toMatchObject({ completed: true, route: 'chrome', routeNote: 'I used your Chrome because Example needs your sign-in.' });
    expect(sent.map((c) => c.name)).toEqual(['navigate', 'observe', 'screenshot']);
  });
});

describe('when your Chrome opens the page and then something fails', () => {
  async function chromeRoute(answers: Partial<Record<string, unknown>>) {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-extension-opened-'));
    dirs.push(dir);
    const { fake, sent } = bridge(answers);
    const controller = new HostController(dir, { extensionBridge: () => fake, platform: 'linux' });
    controllers.push(controller);
    await controller.enable();
    await controller.configure({ yourChrome: true, signInSites: ['example.com'] });
    return { controller, sent };
  }

  it('hands back the page that opened, not just the error', async () => {
    const { controller } = await chromeRoute({
      navigate: new BrowserOpenedError('The tab closed while it was loading.', { tabId: 'tab-1', url: 'https://example.com/', title: 'Example' }),
      observe: page, screenshot: shot,
    });
    const result = await controller.execute(command({ action: 'navigate', url: 'https://example.com/' }), ctx('o'));
    expect(result).toMatchObject({ completed: false, dispatched: true, route: 'chrome', observation: { url: 'https://example.com/' } });
    expect((result as { message: string }).message).toContain('Opened example.com, then this failed: The tab closed while it was loading. Carry on from this page');
  });

  it('says in one line that the page opened in a new window', async () => {
    const note = "Your Chrome couldn't open a tab in that window; opened a new window instead.";
    const { controller } = await chromeRoute({ navigate: { observation: { note } }, observe: page, screenshot: shot });
    const result = await controller.execute(command({ action: 'navigate', url: 'https://example.com/' }), ctx('n'));
    expect(result).toMatchObject({ completed: true, route: 'chrome' });
    expect((result as { message: string }).message).toContain(note);
  });

  it('does not let the same failure be tried a third time: the second says so plainly', async () => {
    const { controller, sent } = await chromeRoute({ navigate: new Error('Grouping is not supported by tabs in this window.') });
    await expect(controller.execute(command({ action: 'navigate', url: 'https://example.com/' }), ctx('r'))).rejects.toThrow('Grouping is not supported');
    const second = await controller.execute(command({ action: 'navigate', url: 'https://example.com/' }), ctx('r'));
    expect(second).toEqual({ completed: false, dispatched: false,
      message: "Your Chrome failed the same way twice: Grouping is not supported by tabs in this window. Don't try it again; tell the owner that in one sentence." });
    expect(sent.filter((c) => c.name === 'navigate')).toHaveLength(2);
  });
});

describe('what the driver does with a browser that went quiet', () => {
  it('refuses an observation that came back from a host outside the allow list', async () => {
    // The owner asked for example.com; a redirect landed on somewhere else.
    const redirected = { observation: { ...page.observation, url: 'https://elsewhere.example/landing' } };
    const { fake } = bridge({ observe: redirected });
    const driver = new ExtensionDriver(fake, ['example.com']);
    await expect(driver.observe()).rejects.toThrow('outside the configured browser hosts');
    // And one whose address is not an address at all.
    const nonsense = { observation: { ...page.observation, url: 'chrome://settings' } };
    const other = new ExtensionDriver(bridge({ observe: nonsense }).fake, ['example.com']);
    await expect(other.observe()).rejects.toThrow(BrowserPreconditionError);
  });

  it('holds the session until the timed-out command has been cancelled', async () => {
    const sent: ExtensionCommand[] = [];
    let settle = () => {};
    const cancelled = new Promise<void>((resolve) => { settle = resolve; });
    let idleAsked = 0;
    const fake: ExtensionBridge = {
      connected: () => true,
      send: async (command) => {
        sent.push(command);
        if (command.name === 'observe' && sent.length === 1) throw new Error('Your browser did not answer within a minute.');
        return page;
      },
      close: () => {},
      idle: () => { idleAsked += 1; return cancelled; },
    };
    const driver = new ExtensionDriver(fake);
    await expect(driver.observe()).rejects.toThrow(/did not answer/);
    expect(idleAsked).toBe(1);

    let done = false;
    const next = driver.observe().then((observation) => { done = true; return observation; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    expect(sent).toHaveLength(1); // Nothing was dispatched onto a page nobody has seen.
    settle();
    await expect(next).resolves.toMatchObject({ url: 'https://example.com/' });
    expect(sent.map((command) => command.name)).toEqual(['observe', 'observe']);
  });
});

/*
 * The owner's secret pair on the extension wire: the facts ride inside the
 * observation the gateway relays untouched, and the fill carries the value once,
 * to the browser, and nothing else.
 */
describe('the secret pair on the extension wire', () => {
  const VALUE = 'correct-horse-battery-staple';
  const fieldInfo = { observation: { field: { origin: 'https://example.com', password: false, name: 'Card number' } } };

  it('reads the field facts out of the passthrough and refuses a stale observation first', async () => {
    const { fake, sent } = bridge({ fieldInfo });
    const driver = new ExtensionDriver(fake);
    await expect(driver.secretFieldInfo('o1', 'e3')).rejects.toThrow('Stale page observation');
    await driver.observe();
    await expect(driver.secretFieldInfo((await driver.observe()).id, 'e3')).resolves.toEqual({ origin: 'https://example.com', password: false, name: 'Card number' });
    expect(sent.at(-1)).toMatchObject({ name: 'fieldInfo', args: { ref: 'e3' } });
  });

  it('refuses an unbindable origin, and answers a password field as one', async () => {
    const opaque = new ExtensionDriver(bridge({ fieldInfo: { observation: { field: { origin: 'null', password: false, name: 'x' } } } }).fake);
    await opaque.observe();
    await expect(opaque.secretFieldInfo((await opaque.observe()).id, 'e3')).rejects.toThrow(/no web origin/);
    const password = new ExtensionDriver(bridge({ fieldInfo: { observation: { field: { origin: 'https://example.com', password: true, name: 'Password' } } } }).fake);
    await password.observe();
    await expect(password.secretFieldInfo((await password.observe()).id, 'e3')).resolves.toMatchObject({ password: true });
  });

  it('sends the fill with the approved origin, spends its evidence, and never answers the value', async () => {
    const { fake, sent } = bridge({ observe: page });
    const driver = new ExtensionDriver(fake);
    await driver.observe();
    const id = (await driver.observe()).id;
    await expect(driver.secretFillField(id, 'e3', VALUE, 'https://example.com')).resolves.toBeUndefined();
    expect(sent.at(-1)).toMatchObject({ name: 'secretFill', args: { ref: 'e3', expectedOrigin: 'https://example.com' } });
    // The evidence is spent: the same observation cannot fill twice.
    await expect(driver.secretFillField(id, 'e3', VALUE, 'https://example.com')).rejects.toThrow('Stale page observation');
  });
});

describe('taking over a page in your Chrome', () => {
  async function held(answers: Partial<Record<string, unknown>> = { observe: page, screenshot: shot }) {
    const dir = await mkdtemp(path.join(tmpdir(), 'buddi-extension-held-'));
    dirs.push(dir);
    const { fake, sent } = bridge(answers);
    const listeners = new Map<string, (event: 'takeover' | 'giveback') => void>();
    fake.events = (session, listener) => { listeners.set(session, listener); return () => { listeners.delete(session); }; };
    fake.frames = () => { throw new Error('no screencast for a page in your Chrome'); };
    const controller = new HostController(dir, { extensionBridge: () => fake, platform: 'linux' });
    controllers.push(controller);
    await controller.enable();
    await controller.configure({ yourChrome: true, signInSites: ['example.com'] });
    await controller.execute(command({ action: 'navigate', url: 'https://example.com/' }), ctx('h'));
    const sessionId = controller.status({ conversationId: 'h', agentId: 'h' }).session!.id;
    return { controller, sent, sessionId, emit: (event: 'takeover' | 'giveback') => { for (const listener of listeners.values()) listener(event); } };
  }

  it('brings the tab forward in Chrome: the status says it is held there, and no screencast starts', async () => {
    const { controller, sent, sessionId } = await held();
    const status = await controller.control('takeover', sessionId);
    expect(status).toMatchObject({ state: 'paused', route: 'chrome', held: { by: 'owner', where: 'chrome' } });
    expect(sent.map((c) => c.name)).toEqual(['navigate', 'observe', 'screenshot', 'hold']);
    expect(sent.at(-1)).toMatchObject({ owner: true });
    expect(controller.hand({ sessionId })).toMatchObject({ supported: false });
    expect(controller.hand({ sessionId }).hand).toBeUndefined();
    // Give it back from the Canvas: the waiting bar goes, and the field with it.
    const back = await controller.control('resume', sessionId);
    expect(back.held).toBeUndefined();
    expect(back.state).toBe('running');
    expect(sent.at(-1)).toMatchObject({ name: 'unhold' });
    expect(sent.some((c) => c.name.startsWith('screencast'))).toBe(false);
  });

  it('Give it back from the bar in the tab resumes the page, and the waiting run hears it', async () => {
    const { controller, sessionId, emit } = await held();
    const heard: string[] = [];
    controller.onGiveBack((info) => heard.push(info.sessionId));
    emit('takeover');
    await vi.waitFor(() => expect(controller.status({ sessionId }).held).toBeDefined());
    emit('giveback');
    await vi.waitFor(() => expect(heard).toEqual([sessionId]));
    expect(controller.status({ sessionId })).toMatchObject({ state: 'running' });
  });

  it('an extension that cannot bring the tab forward leaves the page paused and says where it is', async () => {
    const { controller, sessionId } = await held({ observe: page, screenshot: shot, hold: new BrowserPreconditionError('This browser cannot run hold.') });
    const status = await controller.control('takeover', sessionId);
    expect(status.state).toBe('paused');
    expect(status.held).toBeUndefined();
    expect(status.message).toContain("Your Chrome couldn't bring the page forward");
  });
});

describe('downloads in the owner’s Chrome', () => {
  it('takes a finished download only for its session and only soon after one of its actions', async () => {
    let listener: ((file: ExtensionDownload) => void) | undefined;
    const { fake } = bridge({ navigate: page, observe: page });
    fake.downloads = (_session, fn) => { listener = fn; return () => { listener = undefined; }; };
    let now = 1_000_000;
    const driver = new ExtensionDriver(fake, undefined, { now: () => now });
    await driver.start();
    const file: ExtensionDownload = { path: '/Users/owner/Downloads/transactions.csv', filename: 'transactions.csv', url: 'https://bank.example/export', mime: 'text/csv', size: 35_000 };
    listener!(file); // before any action: the owner’s
    expect(driver.takeDownloads()).toEqual([]);
    await driver.perform(command({ action: 'navigate', url: 'https://example.com/' }));
    now += DOWNLOAD_WINDOW_MS - 1;
    listener!(file);
    expect(driver.takeDownloads()).toEqual([{ filename: 'transactions.csv', url: 'https://bank.example/export', read: { path: file.path }, mime: 'text/csv', size: 35_000 }]);
    expect(driver.takeDownloads()).toEqual([]);
    now += 2;
    listener!(file);
    expect(driver.takeDownloads()).toEqual([]);
    await driver.close();
    expect(listener).toBeUndefined();
  });
});
