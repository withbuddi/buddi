import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, createPluginHost, hostBindingOf, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import { BrowserService, BrowserManager, commandSchema, type BrowserController, type BrowserDriver } from '@buddi/tool-browser';
import { startWebServer, type WebServer } from './server.js';
import { mintTicket } from './token.js';
import { csrfCookieName, portOf } from './http.js';
import { hostFetch } from '../__fixtures__/host-fetch.js';

/** The context core hands the browser plugin: these facts, with its `ctx.buddi` built over them. */
const BROWSER_HOST = hostBindingOf({ name: 'browser', version: '0.1.0', schema: 'browser', migrationsDir: '', tools: [] });
const hosted = (facts: CoreToolContext): CoreToolContext => ({ ...facts, buddi: createPluginHost(BROWSER_HOST, facts) });

const TOKEN = 'fixture-browser-dashboard-token';
const instances: WebServer[] = [];
const services: BrowserController[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map((s) => s.close())); await Promise.all(services.splice(0).map((s) => s.shutdown())); });

async function setup(openAccess = true, supplied?: BrowserController, publicOrigin?: string) {
  const driver: BrowserDriver = { start: vi.fn(), perform: vi.fn(), observe: vi.fn(), screenshot: vi.fn(), close: vi.fn() };
  const browser: BrowserController = supplied ?? new BrowserService(driver); services.push(browser); await browser.enable();
  // `/api/session` asks the database whether this installation is in
  // recovery, so the fixture pool answers a query, as version.web.test.ts's does.
  const app = await startWebServer({ pool: { query: async () => ({ rows: [], rowCount: 0 }) } as never, registry: new ToolRegistry(), catalog: {} as AgentCatalog,
    ctx: { ownerId: 'owner' } as CoreToolContext, timezone: 'UTC', now: () => new Date(),
    config: { enabled: true, host: '127.0.0.1', port: 0, publicOrigin }, openAccess, token: TOKEN, browser });
  instances.push(app);
  const origin = `http://127.0.0.1:${app.port}`;
  return { app, origin, browser, driver };
}

async function session(origin: string, ticket?: string, cookiePort = portOf(new URL(origin))) {
  // A ticket is only ever exchanged on the page URL, never on an API call.
  const res = await fetch(ticket ? `${origin}/?t=${encodeURIComponent(ticket)}` : `${origin}/api/session`, { redirect: 'manual' });
  const pairs = res.headers.getSetCookie().map((line) => line.split(';')[0]!);
  const name = `${csrfCookieName(cookiePort)}=`;
  const csrf = pairs.find((p) => p.startsWith(name))?.slice(name.length) ?? '';
  return { Cookie: pairs.join('; '), 'X-Buddi-CSRF': csrf, Origin: origin, 'Content-Type': 'application/json' };
}

describe('browser dashboard endpoints', () => {
  it('requires a remote ticket behind an HTTPS proxy and preserves write protection', async () => {
    const external = 'https://host.example:9443';
    const { origin, browser } = await setup(true, undefined, external);
    // The proxied requests carry the Host the browser used, which `fetch` would overwrite.
    const fetch = hostFetch;
    const proxy = { Host: 'host.example:9443', 'X-Forwarded-For': '100.64.0.2' };
    expect((await fetch(`${origin}/api/session`, { headers: proxy })).status).toBe(401);
    expect((await fetch(`${origin}/api/session`, { headers: { ...proxy, Host: 'localhost:4317' } })).status).toBe(401);
    // Cookies carry the port the request arrived on: the bound one on loopback,
    // the public one through the proxy.
    const local = await session(origin);
    expect(local['X-Buddi-CSRF']).not.toBe('');
    expect((await fetch(`${origin}/api/session`, { headers: { ...local, ...proxy } })).status).toBe(401);
    const ticket = mintTicket(TOKEN, new Date());
    const response = await fetch(`${origin}/?t=${ticket}`, { headers: proxy, redirect: 'manual' });
    expect(response.status).toBe(302);
    const pairs = response.headers.getSetCookie();
    expect(pairs.every((cookie) => cookie.includes('Secure') && cookie.includes('Max-Age=43200'))).toBe(true);
    const csrfName = `${csrfCookieName(9443)}=`;
    const csrf = pairs.find((value) => value.startsWith(csrfName))!.split(';')[0]!.slice(csrfName.length);
    const headers = { ...proxy, Cookie: pairs.map((value) => value.split(';')[0]).join('; '), 'X-Buddi-CSRF': csrf, Origin: external, 'Content-Type': 'application/json' };
    expect(await (await fetch(`${origin}/api/session`, { headers })).json()).toMatchObject({ scope: 'remote' });
    // The same link opens again within its five minutes (a browser prerenders,
    // then navigates); an expired one does not.
    expect((await fetch(`${origin}/?t=${ticket}`, { headers: proxy, redirect: 'manual' })).status).toBe(302);
    const stale = mintTicket(TOKEN, new Date(Date.now() - 10 * 60_000));
    expect((await fetch(`${origin}/?t=${stale}`, { headers: proxy, redirect: 'manual' })).status).toBe(401);
    browser.checkPermissions = vi.fn(async () => browser.status());
    expect((await fetch(`${origin}/api/browser/permissions`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${origin}/api/browser/permissions`, { method: 'POST', headers: { ...headers, 'X-Buddi-CSRF': '' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${origin}/api/browser/permissions`, { method: 'POST', headers, body: '{}' })).status).toBe(200);
  });
  it('starts a browser install for the owner only, behind CSRF and origin', async () => {
    const { origin, browser } = await setup(); const headers = await session(origin);
    const installBrowser = vi.fn(() => ({ ...browser.status(), browser: { engine: 'none' as const, headless: false, install: { state: 'running' as const } } }));
    browser.installBrowser = installBrowser;
    expect((await fetch(`${origin}/api/browser/install`, { method: 'POST', headers: { ...headers, 'X-Buddi-CSRF': '' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${origin}/api/browser/install`, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${origin}/api/browser/install`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBeGreaterThanOrEqual(400);
    expect(installBrowser).not.toHaveBeenCalled();
    const started = await fetch(`${origin}/api/browser/install`, { method: 'POST', headers, body: '{}' });
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ browser: { install: { state: 'running' } } });
    expect(installBrowser).toHaveBeenCalledOnce();
  });
  it('checks that the browser launches, for the owner only, and relays the reason when it does not', async () => {
    const { origin, browser } = await setup(); const headers = await session(origin);
    const checkLaunch = vi.fn(async () => ({ ok: false as const, message: 'The browser is installed, but this machine lacks system libraries it needs. Run once, with sudo:', command: 'sudo npx playwright install-deps chromium', problem: 'missing-libraries' as const }));
    browser.checkLaunch = checkLaunch;
    expect((await fetch(`${origin}/api/browser/check`, { method: 'POST', headers: { ...headers, 'X-Buddi-CSRF': '' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${origin}/api/browser/check`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBeGreaterThanOrEqual(400);
    expect(checkLaunch).not.toHaveBeenCalled();
    const checked = await fetch(`${origin}/api/browser/check`, { method: 'POST', headers, body: '{}' });
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({ ok: false, command: 'sudo npx playwright install-deps chromium' });
    checkLaunch.mockResolvedValueOnce({ ok: true } as never);
    expect(await (await fetch(`${origin}/api/browser/check`, { method: 'POST', headers, body: '{}' })).json()).toEqual({ ok: true });
  });
  it('protects mode settings and permission prompts with owner authentication, CSRF and origin', async () => {
    const { origin, browser } = await setup(); const headers = await session(origin);
    const configure = vi.fn(async () => browser.status()); const checkPermissions = vi.fn(async () => browser.status());
    browser.configure = configure; browser.checkPermissions = checkPermissions;
    for (const route of ['settings', 'permissions']) {
      expect((await fetch(`${origin}/api/browser/${route}`, { method: 'POST', headers: { ...headers, 'X-Buddi-CSRF': '' }, body: '{}' })).status).toBe(403);
      expect((await fetch(`${origin}/api/browser/${route}`, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: '{}' })).status).toBe(403);
    }
    expect(configure).not.toHaveBeenCalled(); expect(checkPermissions).not.toHaveBeenCalled();
    const settings = { mode: 'computer', browserApp: 'com.apple.Safari', allowedApps: ['com.apple.Safari'] };
    expect((await fetch(`${origin}/api/browser/settings`, { method: 'POST', headers, body: JSON.stringify(settings) })).status).toBe(200);
    expect(configure).toHaveBeenCalledWith(settings);
    expect((await fetch(`${origin}/api/browser/permissions`, { method: 'POST', headers, body: JSON.stringify({ prompt: 'yes' }) })).status).toBe(400);
    expect(checkPermissions).not.toHaveBeenCalled();
    expect((await fetch(`${origin}/api/browser/permissions`, { method: 'POST', headers, body: JSON.stringify({ prompt: true }) })).status).toBe(200);
    expect(checkPermissions).toHaveBeenCalledWith(true);
  });
  it('serves only the requested conversation and releases it without affecting another', async () => {
    let count = 0;
    const manager = new BrowserManager(() => {
      const id = String(++count);
      return { start: async () => {}, perform: async () => {}, close: async () => {},
        screenshot: async () => Buffer.from(`picture-${id}`),
        observe: async () => ({ id, title: `Page ${id}`, url: 'https://example.com/', tree: 'Fixture', tabs: [], capturedAt: new Date().toISOString() }) };
    });
    const { origin } = await setup(true, manager); const headers = await session(origin);
    for (const id of ['a', 'b']) await manager.execute(commandSchema.parse({ action: 'navigate', url: 'https://example.com/' }), hosted({
      ownerId: 'owner', agentId: id, conversationId: id, ownerRequest: { id, text: 'Fixture', expiresAt: Date.now() + 60_000 },
    } as CoreToolContext));
    const a = await (await fetch(`${origin}/api/browser?agentId=a&conversationId=a`, { headers })).json() as { session: { id: string }; page: { id: string }; sessions?: unknown };
    expect(a.sessions).toBeUndefined(); expect(a.page.id).toBe('1');
    const image = await fetch(`${origin}/api/browser/screenshot?sessionId=${a.session.id}&v=1`, { headers });
    expect(await image.text()).toBe('picture-1');
    expect((await fetch(`${origin}/api/browser/screenshot?sessionId=${a.session.id}&v=2`, { headers })).status).toBe(404);
    expect((await fetch(`${origin}/api/browser/release`, { method: 'POST', headers, body: JSON.stringify({ sessionId: a.session.id }) })).status).toBe(200);
    expect((await fetch(`${origin}/api/browser/screenshot?sessionId=${a.session.id}&v=1`, { headers })).status).toBe(404);
    expect(manager.status().sessions).toHaveLength(1); expect(manager.status().session?.agentId).toBe('b');
  });
  /*
   * What the canvas needs to draw a session it did not start: whose
   * conversation is driving, what is on the screen, and how far in the run is.
   * All of it read from the service's own status — no tool result is trusted
   * to say any of it, and the plugin's tool contract is untouched.
   */
  it('names the driving conversation, the page on screen and the steps taken', async () => {
    const manager = new BrowserManager(() => ({
      start: async () => {}, perform: async () => {}, close: async () => {},
      screenshot: async () => Buffer.from('picture'),
      observe: async () => ({ id: 'o1', title: 'Statements', url: 'https://example.com/statements', tree: 'Fixture', tabs: [], capturedAt: new Date().toISOString() }),
    }));
    const { origin } = await setup(true, manager);
    const headers = await session(origin);
    await manager.execute(commandSchema.parse({ action: 'navigate', url: 'https://example.com/statements' }), hosted({
      ownerId: 'owner', agentId: 'keeper', conversationId: 'c1',
      ownerRequest: { id: 'r1', text: 'Fixture', expiresAt: Date.now() + 60_000 },
    } as CoreToolContext));
    const status = await (await fetch(`${origin}/api/browser?agentId=keeper&conversationId=c1`, { headers })).json() as {
      session: { agentId: string; conversationId: string; steps: number; maxSteps: number };
      page: { url: string; title: string; id: string };
      hasScreenshot: boolean;
    };
    expect(status.session.agentId).toBe('keeper');
    expect(status.session.conversationId).toBe('c1');
    expect(status.session.steps).toBe(1);
    expect(status.session.maxSteps).toBeGreaterThan(0);
    expect(status.page.url).toBe('https://example.com/statements');
    expect(status.page.title).toBe('Statements');
    expect(status.page.id).toBe('o1');
    expect(status.hasScreenshot).toBe(true);
    // A second action moves the count the canvas prints.
    await manager.execute(commandSchema.parse({ action: 'navigate', url: 'https://example.com/statements' }), hosted({
      ownerId: 'owner', agentId: 'keeper', conversationId: 'c1',
      ownerRequest: { id: 'r1', text: 'Fixture', expiresAt: Date.now() + 60_000 },
    } as CoreToolContext));
    const again = await (await fetch(`${origin}/api/browser?agentId=keeper&conversationId=c1`, { headers })).json() as { session: { steps: number } };
    expect(again.session.steps).toBe(2);
    // Another conversation asking gets nothing of this one's.
    const other = await (await fetch(`${origin}/api/browser?agentId=keeper&conversationId=c2`, { headers })).json() as { session?: unknown };
    expect(other.session).toBeUndefined();
  });
  it('binds canvas screenshots and controls to the session they display', async () => {
    const { origin, browser } = await setup();
    const headers = await session(origin);
    vi.spyOn(browser, 'screenshot').mockReturnValue(Buffer.from('fixture-jpeg'));
    vi.spyOn(browser, 'status').mockReturnValue({ state: 'running', enabled: true, busy: false, hasScreenshot: true,
      session: { id: 'current', agentId: 'keeper', conversationId: 'c1', requestId: 'r1', task: 'Fixture', expiresAt: new Date().toISOString(), steps: 1, maxSteps: 80 },
      page: { id: 'o1', url: 'https://example.com', title: 'Fixture', capturedAt: new Date().toISOString(), tabs: [] } });
    expect((await fetch(`${origin}/api/browser/screenshot?sessionId=current&v=o1`, { headers })).status).toBe(200);
    expect((await fetch(`${origin}/api/browser/screenshot?sessionId=old&v=o1`, { headers })).status).toBe(404);
    expect((await fetch(`${origin}/api/browser/screenshot?sessionId=current&v=old`, { headers })).status).toBe(404);
    const control = vi.spyOn(browser, 'control').mockRejectedValue(new Error('The browser session changed.'));
    expect((await fetch(`${origin}/api/browser/stop`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 'old' }) })).status).toBe(409);
    expect(control).toHaveBeenCalledWith('stop', 'old');
    expect((await fetch(`${origin}/api/browser/stop`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 42 }) })).status).toBe(400);
  });
  it('status is read-only and control needs CSRF plus same origin', async () => {
    const { origin, driver, browser } = await setup();
    const headers = await session(origin);
    const status = await fetch(`${origin}/api/browser`, { headers });
    expect(await status.json()).toMatchObject({ state: 'idle', enabled: true });
    expect(driver.start).not.toHaveBeenCalled();
    expect((await fetch(`${origin}/api/browser/stop`, { method: 'POST', body: '{}', headers: { ...headers, 'X-Buddi-CSRF': '' } })).status).toBe(403);
    expect((await fetch(`${origin}/api/browser/stop`, { method: 'POST', body: '{}', headers: { ...headers, Origin: 'https://untrusted.example' } })).status).toBe(403);
    expect(browser.status().state).toBe('idle');
    const stop = await fetch(`${origin}/api/browser/stop`, { method: 'POST', body: '{}', headers });
    expect(stop.status).toBe(200);
    expect(await stop.json()).toMatchObject({ state: 'stopped' });
    expect(driver.close).toHaveBeenCalledTimes(1);
  });
  it('requires a session for status, screenshots and controls when the gate is closed', async () => {
    const { origin } = await setup(false);
    for (const route of ['/api/browser', '/api/browser/screenshot']) expect((await fetch(origin + route)).status).toBe(401);
    expect((await fetch(`${origin}/api/browser/stop`, { method: 'POST' })).status).toBe(401);
    const headers = await session(origin, mintTicket(TOKEN, new Date()));
    expect((await fetch(`${origin}/api/browser`, { headers })).status).toBe(200);
    expect((await fetch(`${origin}/api/browser/screenshot`, { headers })).status).toBe(404);
  });
  /*
   * The canvas polls the screenshot with a cache-buster on the query. If that
   * parameter were read as a sign-in ticket, every poll would be a bad ticket:
   * a 401 and one more failure counted against the owner's own address.
   */
  it('does not read a query parameter on an API path as a sign-in ticket', async () => {
    const { origin } = await setup(false);
    const headers = await session(origin, mintTicket(TOKEN, new Date()));
    for (let i = 0; i < 12; i += 1) {
      const res = await fetch(`${origin}/api/browser/screenshot?t=${i}`, { headers, redirect: 'manual' });
      expect(res.status).toBe(404);
      expect(res.headers.getSetCookie()).toHaveLength(0);
    }
    // No failure was counted, so the page URL still exchanges a fresh ticket.
    expect((await fetch(`${origin}/?t=${encodeURIComponent(mintTicket(TOKEN, new Date()))}`, { redirect: 'manual' })).status).toBe(302);
  });
  it('cannot enable a controller that is not hosted here', async () => {
    const { origin, browser } = await setup();
    await browser.shutdown();
    const headers = await session(origin);
    expect((await fetch(`${origin}/api/browser/resume`, { method: 'POST', headers, body: '{}' })).status).toBe(409);
  });
});
