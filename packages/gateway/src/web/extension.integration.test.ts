/*
 * "Your browser", end to end: a real Chrome, the real unpacked extension, the
 * real WebSocket endpoint and the real `ExtensionDriver`.
 *
 * Nothing is stubbed between the driver and the page. Chromium is launched
 * with `packages/extension/dist` loaded unpacked, its service worker connects
 * to this test's own gateway, the pairing code is read out of the extension's
 * own popup exactly as the owner reads it, and every assertion below is about
 * what happened in that browser.
 *
 * Two things keep this off the owner's machine rather than on it:
 *
 * - `--host-rules` maps the extension's built-in default address,
 *   `127.0.0.1:4317`, onto this test's port. The service worker dials that
 *   address the moment Chrome loads it, before any test can tell it otherwise,
 *   and on a developer's machine 4317 is the live installation. The mapping
 *   means the live buddi is never contacted, not even once.
 * - The same flag gives the fixture a real hostname, `fixture.test`. That is
 *   not a convenience: `ExtensionDriver.navigate` runs the web guard, which
 *   refuses loopback and every port that is not 80 or 443, so a test that
 *   reached its fixture at `127.0.0.1:<port>` would be a test that had turned
 *   the guard off.
 *
 * It lives here rather than beside the driver it exercises because it needs
 * both halves: the browser plugin does not depend on `@buddi/gateway`, and
 * making it do so, even for a test, would put a cycle in the workspace.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page, Worker } from 'playwright';
import { commandSchema, ExtensionDriver, type HandFrame, type Observation } from '@buddi/tool-browser';
import { ExtensionEndpoint } from './extension.js';

/** The buddi address the extension dials on its own, before anyone tells it otherwise. */
const EXTENSION_DEFAULT_PORT = 4317;
/** A name that is not loopback, so the driver's own URL guard stays switched on. */
const FIXTURE_HOST = 'fixture.test';
const FIXTURE_URL = `http://${FIXTURE_HOST}`;
const MINUTE = 60_000;

const extensionDist = path.resolve(fileURLToPath(import.meta.url), '../../../../extension/dist');

const PAGES: Record<string, string> = {
  '/owner': '<!doctype html><title>The owner was here</title><h1>The owner was here</h1><p>Nothing an agent does may touch this tab.</p>',
  '/': '<!doctype html><title>Booking fixture</title><h1>Book an appointment</h1>'
    + '<form method="GET" action="/booked">'
    + '<label for="name">Your name</label><input id="name" name="name">'
    + '<label for="time">Time</label><select id="time" name="time"><option>10:00</option><option>11:00</option></select>'
    + '<label for="secret">Password</label><input id="secret" name="secret" type="password">'
    + '<button type="submit">Book appointment</button>'
    + '</form><a href="/receipt">Open the receipt</a>',
  '/receipt': '<!doctype html><title>Receipt</title><h1>Receipt EXTENSION-001</h1>',
};

/** Playwright is a devDependency, and a checkout without browsers must still pass. */
async function chromium(): Promise<typeof import('playwright').chromium | undefined> {
  try { return (await import('playwright')).chromium; } catch { return undefined; }
}

describe('the owner\'s own Chrome, through the buddi extension', () => {
  let fixture: Server;
  let gateway: Server;
  let endpoint: ExtensionEndpoint;
  let context: BrowserContext | undefined;
  let worker: Worker;
  let ownerTab: Page;
  let dataHome: string;
  let profile: string;
  let skip = '';
  let booked = '';

  beforeAll(async () => {
    const launcher = await chromium();
    if (!launcher) { skip = 'playwright is not installed in this checkout'; return; }

    dataHome = await mkdtemp(path.join(tmpdir(), 'buddi-extension-data-'));
    profile = await mkdtemp(path.join(tmpdir(), 'buddi-extension-profile-'));

    fixture = createServer((req, res) => {
      const url = new URL(req.url ?? '/', FIXTURE_URL);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (url.pathname === '/booked') {
        booked = url.search;
        res.end(`<!doctype html><title>Booked</title><h1>Booked</h1><p>${url.searchParams.get('name')} at ${url.searchParams.get('time')}</p>`);
        return;
      }
      res.end(PAGES[url.pathname] ?? '<!doctype html><title>Not here</title><h1>Not here</h1>');
    });
    await new Promise<void>((resolve) => fixture.listen(0, '127.0.0.1', resolve));

    gateway = createServer((_req, res) => { res.writeHead(404); res.end(); });
    await new Promise<void>((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    endpoint = new ExtensionEndpoint({ env: { ...process.env, BUDDI_DATA_DIR: dataHome, BUDDI_EXTENSION_DIR: extensionDist } });
    endpoint.attach(gateway);

    const rules = [
      `MAP ${FIXTURE_HOST} 127.0.0.1:${(fixture.address() as AddressInfo).port}`,
      `MAP 127.0.0.1:${EXTENSION_DEFAULT_PORT} 127.0.0.1:${(gateway.address() as AddressInfo).port}`,
    ].join(', ');
    try {
      context = await launcher.launchPersistentContext(profile, {
        // The `chromium` channel is Chrome's new headless mode. The old one
        // loads no extensions at all, so this is not a preference.
        channel: 'chromium',
        headless: true,
        args: [`--disable-extensions-except=${extensionDist}`, `--load-extension=${extensionDist}`, `--host-rules=${rules}`],
      });
    } catch (error) {
      skip = `Chromium could not be launched: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }

    // The owner's own tab, opened before the agent exists, so that "untouched"
    // is a claim about a tab that was already there.
    ownerTab = context.pages()[0] ?? await context.newPage();
    await ownerTab.goto(`${FIXTURE_URL}/owner`);

    worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: MINUTE });

    // The popup is the owner's view of the pairing, so the code comes from it
    // rather than from the endpoint that minted it.
    const extensionId = new URL(worker.url()).host;
    await vi.waitFor(async () => expect((await endpoint.view()).pending).toBe(true), { timeout: MINUTE, interval: 200 });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);
    const code = await popup.locator('#code').textContent();
    await popup.close();
    expect(code).toMatch(/^\d{3} \d{3}$/);

    const paired = await endpoint.pair(code);
    expect(paired.status).toBe(200);
    // Connected is connected: the endpoint reports it only once the `paired`
    // frame is written, and the extension is authenticated by that frame
    // rather than by the storage write it starts (G2).
    await vi.waitFor(() => expect(endpoint.connected()).toBe(true), { timeout: MINUTE, interval: 100 });
  }, 3 * MINUTE);

  afterAll(async () => {
    await context?.close();
    endpoint?.shutdown();
    await new Promise<void>((resolve) => gateway?.close(() => resolve()));
    await new Promise<void>((resolve) => fixture?.close(() => resolve()));
    for (const dir of [dataHome, profile]) if (dir) await rm(dir, { recursive: true, force: true });
  }, MINUTE);

  it('drives the owner\'s Chrome through the whole command set and leaves their tab alone', async function () {
    if (skip) { console.log(`skipped: ${skip}`); return; }
    const driver = new ExtensionDriver(endpoint);
    const ownerUrl = ownerTab.url();
    const act = async (command: Record<string, unknown>) => driver.perform(commandSchema.parse(command));

    /*
     * Every observation below is a single `observe()`, never a retry loop.
     *
     * That is the assertion: a command that navigates must not answer until
     * the navigation it started has landed, because an agent's very next move
     * is to observe, and a retry in the test would hide exactly the bug that
     * gets an agent clicking on a page it has already left.
     */
    await driver.start();
    await act({ action: 'navigate', url: `${FIXTURE_URL}/` });

    // Observe: the same shape the Playwright driver answers with.
    let page: Observation = await driver.observe();
    expect(page.url).toBe(`${FIXTURE_URL}/`);
    expect(page.title).toBe('Booking fixture');
    expect(page.tree).toContain('Your name');
    expect(page.tree).toMatch(/Scroll: \d+, \d+$/);
    expect(page.tabs).toHaveLength(1);
    const targets = page.targets ?? [];
    expect(targets.map((target) => target.ref)).toContain('e1');
    expect(targets.every((target) => /^e\d+$/.test(target.ref))).toBe(true);
    const link = targets.find((target) => target.role === 'link')!;
    expect(link.name).toBe('Open the receipt');
    expect(link.href).toBe(`${FIXTURE_URL}/receipt`);
    expect(link.bounds!.width).toBeGreaterThan(0);

    /*
     * The owner is looking at the agent's tab.
     *
     * Reading it stays allowed; acting in it does not, because a click in the
     * tab under their eyes is a click they did not make. Put their own tab
     * back in front afterwards, which is the state the rest of this expects.
     */
    const ownerTabId = await worker.evaluate(async () => (await (globalThis as any).chrome.tabs.query({ active: true }))[0].id as number);
    const agentTabId = await worker.evaluate(async () => {
      const api = (globalThis as any).chrome;
      const [group] = await api.tabGroups.query({ title: 'buddi' });
      return (await api.tabs.query({ groupId: group.id }))[0].id as number;
    });
    const activate = (tabId: number) => worker.evaluate(async (id) => {
      const api = (globalThis as any).chrome;
      const tab = await api.tabs.get(id);
      await api.windows.update(tab.windowId, { focused: true });
      await api.tabs.update(id, { active: true });
    }, tabId);
    expect(agentTabId).not.toBe(ownerTabId);
    await activate(agentTabId);
    page = await driver.observe();
    await expect(act({ action: 'click', observation: page.id, target: { ref: page.targets!.find((target) => target.role === 'link')!.ref } }))
      .rejects.toThrow(/looking at this tab/);
    await activate(ownerTabId);

    // Click by ref, then the same link by role and name.
    page = await driver.observe();
    await act({ action: 'click', observation: page.id, target: { ref: page.targets!.find((target) => target.role === 'link')!.ref } });
    page = await driver.observe();
    expect(page.url).toBe(`${FIXTURE_URL}/receipt`);
    expect(page.title).toBe('Receipt');
    await act({ action: 'navigate', url: `${FIXTURE_URL}/` });
    page = await driver.observe();
    await act({ action: 'click', observation: page.id, target: { by: 'role', role: 'link', name: 'Open the receipt' } });
    page = await driver.observe();
    expect(page.url).toBe(`${FIXTURE_URL}/receipt`);
    expect(page.tree).toContain('EXTENSION-001');

    // Fill, select, and Enter, which submits the form the fields are in.
    await act({ action: 'navigate', url: `${FIXTURE_URL}/` });
    page = await driver.observe();
    const named = (name: string) => (page.targets ?? []).find((target) => target.name === name)!;
    await act({ action: 'fill', observation: page.id, target: { ref: named('Your name').ref }, value: 'Extension Owner' });
    page = await driver.observe();
    await act({ action: 'select', observation: page.id, target: { ref: named('Time').ref }, value: '11:00' });
    page = await driver.observe();

    // A password field is refused before anything is typed into it.
    await expect(act({ action: 'fill', observation: page.id, target: { ref: named('Password').ref }, value: 'not-a-real-password' }))
      .rejects.toThrow(/password/i);
    page = await driver.observe();

    await act({ action: 'press', observation: page.id, target: { ref: named('Your name').ref }, key: 'Enter' });
    page = await driver.observe();
    expect(page.url).toContain('/booked');
    expect(booked).toContain('name=Extension+Owner');
    expect(booked).toContain('time=11%3A00');
    expect(page.tree).toContain('Extension Owner at 11:00');

    // A screenshot is a real PNG, taken through the debugger on a background tab.
    const shot = await driver.screenshot();
    expect(shot).toBeInstanceOf(Buffer);
    expect(shot!.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

    // The tab this conversation owns is the one `tab` can switch to, and it is
    // in a group called "buddi" that the owner can see and recognise.
    expect(page.tabs).toHaveLength(1);
    await act({ action: 'tab', tabId: page.tabs[0]!.id });
    await expect(act({ action: 'tab', tabId: 'tab-not-ours' })).rejects.toThrow(/No such tab/);
    const groups = await worker.evaluate(async () => (await (globalThis as any).chrome.tabGroups.query({})).map((group: { title?: string }) => group.title));
    expect(groups).toEqual(['buddi']);

    // Whatever happened above, the owner's tab is where they left it.
    expect(ownerTab.isClosed()).toBe(false);
    expect(ownerTab.url()).toBe(ownerUrl);
    expect(await ownerTab.title()).toBe('The owner was here');

    // Close takes the group away with the tabs in it.
    await driver.close();
    await vi.waitFor(async () => {
      expect(await worker.evaluate(async () => (await (globalThis as any).chrome.tabGroups.query({})).length)).toBe(0);
    }, { timeout: 15_000, interval: 200 });
    expect(ownerTab.isClosed()).toBe(false);
    expect(ownerTab.url()).toBe(ownerUrl);
  }, 3 * MINUTE);

  /*
   * The other half: the owner's own hand on the screen the agent was driving.
   *
   * Everything below goes through the same path the dashboard's socket uses —
   * `takeover()`, then the driver's `hand` — so the frames are frames Chrome
   * really painted and the clicks are clicks Chrome really dispatched. No
   * `chrome.tabs.update` shortcut moves the page: only the pointer does.
   */
  it('hands the owner the wheel: a live picture out, their pointer and keyboard in', async function () {
    if (skip) { console.log(`skipped: ${skip}`); return; }
    const driver = new ExtensionDriver(endpoint);
    const act = async (command: Record<string, unknown>) => driver.perform(commandSchema.parse(command));
    await driver.start();
    await act({ action: 'navigate', url: `${FIXTURE_URL}/` });
    let page: Observation = await driver.observe();

    // The take-over itself: the agent's evidence is dropped, and the hand the
    // gateway would offer the dashboard is this driver's own.
    await driver.takeover!();
    expect(driver.supportsHand).toBe(true);
    const frames: HandFrame[] = [];
    await driver.hand!.start((frame) => { frames.push(frame); });
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), { timeout: 5_000, interval: 50 });

    // A frame is a JPEG, and it says where on the page it was cut from.
    const first = frames[0]!;
    expect(first.jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(first.metadata.deviceWidth).toBeGreaterThan(0);
    expect(first.metadata.deviceHeight).toBeGreaterThan(0);

    /*
     * The fixture never scrolls, so a target's document bounds are its
     * viewport bounds — which is what CDP dispatches into. The dashboard does
     * this arithmetic from the frame metadata; the test does it from the
     * layout it controls.
     */
    const centre = (target: NonNullable<Observation['targets']>[number]) =>
      ({ x: target.bounds!.x + target.bounds!.width / 2, y: target.bounds!.y + target.bounds!.height / 2 });
    const click = async ({ x, y }: { x: number; y: number }) => {
      await driver.hand!.input({ kind: 'mouse', type: 'mouseMoved', x, y, button: 'none', clickCount: 0, modifiers: 0 });
      await driver.hand!.input({ kind: 'mouse', type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers: 0 });
      await driver.hand!.input({ kind: 'mouse', type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers: 0 });
    };

    // A pointer on the link, and the page goes where the owner pointed.
    await click(centre(page.targets!.find((target) => target.role === 'link')!));
    await vi.waitFor(async () => {
      expect((await driver.observe()).url).toBe(`${FIXTURE_URL}/receipt`);
    }, { timeout: 15_000, interval: 200 });

    /*
     * The X5 rule, from the other side.
     *
     * An agent may not act in a tab the owner is watching (the test above
     * proves it is refused). The owner's own hand may: the watcher and the
     * typist are the same person, which is what `owner: true` says.
     */
    const agentTabId = await worker.evaluate(async () => {
      const api = (globalThis as any).chrome;
      const [group] = await api.tabGroups.query({ title: 'buddi' });
      return (await api.tabs.query({ groupId: group.id }))[0].id as number;
    });
    const ownerTabId = await worker.evaluate(async () => (await (globalThis as any).chrome.tabs.query({ active: true }))[0].id as number);
    const activate = (tabId: number) => worker.evaluate(async (id) => {
      const api = (globalThis as any).chrome;
      const tab = await api.tabs.get(id);
      await api.windows.update(tab.windowId, { focused: true });
      await api.tabs.update(id, { active: true });
    }, tabId);
    await activate(agentTabId);

    // One character, then Enter, into the field the owner clicked into — with
    // that tab active in a focused window, which is where a take-over always
    // leaves it once the owner has been looking.
    booked = '';
    await act({ action: 'navigate', url: `${FIXTURE_URL}/` });
    page = await driver.observe();
    await click(centre(page.targets!.find((target) => target.name === 'Your name')!));
    await driver.hand!.input({ kind: 'key', type: 'char', key: 'z', code: 'KeyZ', text: 'z', modifiers: 0 });
    await driver.hand!.input({ kind: 'key', type: 'keyDown', key: 'Enter', code: 'Enter', modifiers: 0 });
    await driver.hand!.input({ kind: 'key', type: 'keyUp', key: 'Enter', code: 'Enter', modifiers: 0 });
    await vi.waitFor(() => expect(booked).toContain('name=z'), { timeout: 15_000, interval: 200 });
    await activate(ownerTabId);

    // Give it back: the picture stops, and nothing painted afterwards arrives.
    await driver.hand!.stop();
    const painted = frames.length;
    await act({ action: 'navigate', url: `${FIXTURE_URL}/receipt` });
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(frames.length).toBe(painted);
    // And the hand is shut, not merely quiet: input with no screencast behind
    // it is what an agent reaching for coordinates would look like.
    await expect(driver.hand!.input({ kind: 'mouse', type: 'mouseMoved', x: 10, y: 10, button: 'none', clickCount: 0, modifiers: 0 }))
      .rejects.toThrow(/screencast/i);

    await driver.close();
  }, 3 * MINUTE);

});
