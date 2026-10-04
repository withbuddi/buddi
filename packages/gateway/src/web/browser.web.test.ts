import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, createPluginHost, hostBindingOf, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import { BrowserService, BrowserManager, commandSchema, type BrowserController, type BrowserDriver } from '@buddi/tool-browser';
import { startWebServer, type WebServer } from './server.js';
import { mintTicket } from './token.js';
import { csrfCookieName, portOf, sessionCookieName } from './http.js';
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

describe('the sign-in lockout behind the proxy', () => {
  it('counts only presented credentials, each once: a poller without a cookie or with one stale cookie never locks the owner out', async () => {
    const { origin } = await setup(true, undefined, 'https://host.example:9443');
    const fetch = hostFetch;
    const proxy = { Host: 'host.example:9443', 'X-Forwarded-For': '100.64.0.2' };
    const cookie = (value: string) => ({ ...proxy, Cookie: `${sessionCookieName(9443)}=${value}` });
    const statuses = async (headers: Record<string, string>, n: number) => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push((await fetch(`${origin}/api/version`, { headers })).status);
      return out;
    };
    // A reconnect check with no credential at all: never an attempt.
    expect(new Set(await statuses(proxy, 25))).toEqual(new Set([401]));
    // An old tab repeating one stale session: counted once.
    expect(new Set(await statuses(cookie('stale-from-last-week'), 25))).toEqual(new Set([401]));
    // Guessing — a new value each time — still locks the address.
    const guesses: number[] = [];
    for (let i = 0; i < 15; i++) guesses.push((await fetch(`${origin}/api/version`, { headers: cookie(`guess-${i}`) })).status);
    expect(guesses).toContain(429);
    // A valid ticket still gets in; the owner is never locked out by a poller.
    const ticket = mintTicket(TOKEN, new Date());
    expect((await fetch(`${origin}/?t=${ticket}`, { headers: proxy, redirect: 'manual' })).status).toBe(302);
  });
});

describe('the signed-out page', () => {
  const NAVIGATE = { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };

  it('answers a page load with a 401 page that says what to do, and holds nothing secret', async () => {
    const { origin } = await setup(false);
    const res = await hostFetch(`${origin}/settings?tab=general`, { headers: NAVIGATE });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.getSetCookie()).toEqual([]);
    const html = await res.text();
    expect(html).toContain('You’re signed out of this buddi');
    // On this computer: the command, with a Copy button, and Try again on the right.
    expect(html).toContain('Run this in Terminal on this computer');
    expect(html).toContain('<code class="cmd-text">buddi dashboard</code>');
    expect(html).toContain('data-copy="buddi dashboard"');
    expect(html).toContain('href="/settings?tab=general">Try again</a>');
    expect(html).not.toContain('Sign in with Tailscale');
    // Nothing loadable, nothing secret: one inline script, allowed by its hash
    // and nothing else; no token, no CSRF material, no path on this machine.
    expect(html).not.toMatch(/src=|@import|url\(/i);
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(res.headers.get('content-security-policy')).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+';/);
    expect(html).not.toContain(TOKEN);
    expect(html.toLowerCase()).not.toContain('csrf');
    expect(html).not.toContain('Application Support');
    expect(html).not.toContain(process.env.HOME ?? '/Users/');
  });

  it('from the Chrome extension, leads with Open buddi.app and holds the Terminal line back until it did not answer', async () => {
    const { origin } = await setup(false);
    const res = await hostFetch(`${origin}/?from=extension&code=482913`, { headers: NAVIGATE });
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain('<a class="button accent" href="buddi://settings/browser?code=482913" data-app-link>Open buddi.app</a>');
    // Above the Terminal line, which the script hides until the link did not answer.
    expect(html.indexOf('Open buddi.app')).toBeLessThan(html.indexOf('Run this in Terminal'));
    expect(html).toContain('<div data-app-wait><p>buddi.app didn’t open. Run this in Terminal on this computer');
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(res.headers.get('content-security-policy')).toMatch(/script-src 'sha256-[A-Za-z0-9+/=]+' 'sha256-[A-Za-z0-9+/=]+';/);
    // A code that is not six digits is left off; anything else in the query never reaches the link.
    const odd = await (await hostFetch(`${origin}/?from=extension&code=%22%3E%3Cb%3E`, { headers: NAVIGATE })).text();
    expect(odd).toContain('href="buddi://settings/browser" data-app-link');
    expect(odd).not.toContain('<b>');
    // Not from the extension: the page as it was, one script.
    const plain = await (await hostFetch(`${origin}/?code=482913`, { headers: NAVIGATE })).text();
    expect(plain).not.toContain('Open buddi.app');
    expect(plain.match(/<script/g)).toHaveLength(1);
  });

  it('keeps the empty 401 for API calls, scripts and fetches', async () => {
    const { origin } = await setup(false);
    for (const [path, headers] of [
      ['/api/overview', NAVIGATE],
      ['/api/version', { Accept: 'text/html' }],
      ['/', { 'Sec-Fetch-Mode': 'cors', Accept: 'text/html' }],
      ['/assets/app.js', { 'Sec-Fetch-Mode': 'no-cors' }],
      ['/', {}],
    ] as const) {
      const res = await hostFetch(`${origin}${path}`, { headers });
      expect(res.status).toBe(401);
      expect(await res.text()).toBe('');
    }
    // A browser with no fetch metadata is taken at its Accept.
    const old = await hostFetch(`${origin}/`, { headers: { Accept: 'text/html' } });
    expect(old.status).toBe(401);
    expect(await old.text()).toContain('buddi dashboard');
    // Not a GET: never the page.
    const post = await hostFetch(`${origin}/`, { method: 'POST', headers: NAVIGATE });
    expect(await post.text()).toBe('');
  });

  it('expires a stale session cookie on the refusal, so a forgotten tab stops presenting it', async () => {
    const { origin, app } = await setup(false);
    const stale = { ...NAVIGATE, Cookie: `${sessionCookieName(app.port)}=gone-after-an-upgrade` };
    for (const path of ['/', '/api/overview']) {
      const res = await hostFetch(`${origin}${path}`, { headers: stale });
      expect(res.status).toBe(401);
      const expired = res.headers.getSetCookie();
      expect(expired).toHaveLength(2);
      expect(expired.every((c) => c.includes('Max-Age=0'))).toBe(true);
    }
  });

  it('points "Try again" at this origin only, escaped', async () => {
    const { origin } = await setup(false);
    const res = await hostFetch(`${origin}//evil.example/%22%3E%3Cb%3E?q=%22%3Cx%3E`, { headers: NAVIGATE });
    const html = await res.text();
    expect(html).not.toContain('href="//');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('<x>');
  });

  it('does not change the lockout: a page load without a credential never counts, a stale one counts once', async () => {
    const { origin } = await setup(true, undefined, 'https://host.example:9443');
    const fetch = hostFetch;
    const proxy = { Host: 'host.example:9443', 'X-Forwarded-For': '100.64.0.2', ...NAVIGATE };
    const cookie = (value: string) => ({ ...proxy, Cookie: `${sessionCookieName(9443)}=${value}` });
    const statuses = async (headers: Record<string, string>, n: number) => {
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push((await fetch(`${origin}/`, { headers })).status);
      return out;
    };
    expect(new Set(await statuses(proxy, 25))).toEqual(new Set([401]));
    expect(new Set(await statuses(cookie('stale-from-last-week'), 25))).toEqual(new Set([401]));
    const guesses: number[] = [];
    for (let i = 0; i < 15; i++) guesses.push((await fetch(`${origin}/`, { headers: cookie(`guess-${i}`) })).status);
    expect(guesses).toContain(429);
    // A person opening a page while locked out is told so, and for how long.
    const locked = await fetch(`${origin}/`, { headers: cookie('guess-again') });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await locked.text()).toContain('Too many tries — wait 1 min');
    // A script still learns one bit.
    const api = await fetch(`${origin}/api/overview`, { headers: cookie('guess-api') });
    expect(api.status).toBe(429);
    expect(await api.text()).toBe('');
    const ticket = mintTicket(TOKEN, new Date());
    expect((await fetch(`${origin}/?t=${ticket}`, { headers: proxy, redirect: 'manual' })).status).toBe(302);
  });
});

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
    browser.configure = vi.fn(async () => browser.status());
    expect((await fetch(`${origin}/api/browser/settings`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${origin}/api/browser/settings`, { method: 'POST', headers: { ...headers, 'X-Buddi-CSRF': '' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${origin}/api/browser/settings`, { method: 'POST', headers, body: '{}' })).status).toBe(200);
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
  it('protects where-agents-may-look settings with owner authentication, CSRF and origin; the permissions route is the Computer plugin\'s now', async () => {
    const { origin, browser } = await setup(); const headers = await session(origin);
    const configure = vi.fn(async () => browser.status());
    browser.configure = configure;
    expect((await fetch(`${origin}/api/browser/settings`, { method: 'POST', headers: { ...headers, 'X-Buddi-CSRF': '' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${origin}/api/browser/settings`, { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' }, body: '{}' })).status).toBe(403);
    expect(configure).not.toHaveBeenCalled();
    const settings = { yourApps: 'on' };
    expect((await fetch(`${origin}/api/browser/settings`, { method: 'POST', headers, body: JSON.stringify(settings) })).status).toBe(200);
    expect(configure).toHaveBeenCalledWith(settings);
    expect((await fetch(`${origin}/api/browser/permissions`, { method: 'POST', headers, body: JSON.stringify({ prompt: true }) })).status).toBe(404);
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
    expect(control).toHaveBeenCalledWith('stop', 'old', undefined);
    expect((await fetch(`${origin}/api/browser/stop`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 42 }) })).status).toBe(400);
  });
  it('pins a conversation, answers a card without a message, stops until I say, and reports stops by cause', async () => {
    const pin = vi.fn(async () => ({ state: 'idle', enabled: true, busy: false, hasScreenshot: false, pin: 'chrome' }));
    const touch = vi.fn(async () => ({ answered: 'resume' }));
    const control = vi.fn(async () => ({ state: 'stopped', enabled: true, busy: false, hasScreenshot: false }));
    const fake = { enable: async () => {}, shutdown: async () => {}, status: () => ({ state: 'idle', enabled: true, busy: false, hasScreenshot: false }), screenshot: () => undefined,
      execute: async () => ({}), secretFill: async () => ({}), secretType: async () => ({}), control, pin, touch,
      telemetrySummary: () => ({ days: 7, tasks: 3, stops: 1, cards: 1, byCause: [{ cause: 'sign-in', count: 1, outcome: 'card' }], routes: { own: 3 }, stopsPerTask: 0.33 }) } as unknown as BrowserController;
    const { origin } = await setup(true, fake);
    const headers = await session(origin);
    const pinned = await fetch(`${origin}/api/browser/pin`, { method: 'POST', headers, body: JSON.stringify({ conversationId: 'c1', route: 'chrome' }) });
    expect(pinned.status).toBe(200);
    expect(pin).toHaveBeenCalledWith('c1', 'chrome');
    expect((await fetch(`${origin}/api/browser/pin`, { method: 'POST', headers, body: JSON.stringify({ conversationId: 'c1' }) })).status).toBe(400);
    const card = await fetch(`${origin}/api/browser/card`, { method: 'POST', headers, body: JSON.stringify({ conversationId: 'c1', answer: 'Resume' }) });
    expect(await card.json()).toMatchObject({ answered: 'resume' });
    expect(touch).toHaveBeenCalledWith({ conversationId: 'c1', text: 'Resume' });
    await fetch(`${origin}/api/browser/stop`, { method: 'POST', headers, body: JSON.stringify({ forever: true }) });
    expect(control).toHaveBeenLastCalledWith('stop', undefined, { forever: true });
    const telemetry = await fetch(`${origin}/api/browser/telemetry`, { headers });
    expect(await telemetry.json()).toMatchObject({ tasks: 3, byCause: [{ cause: 'sign-in', count: 1 }] });
  });
  it('take over of a page in your Chrome passes the held status through, with no hand offered', async () => {
    const held = { state: 'paused', enabled: true, busy: false, hasScreenshot: false, route: 'chrome', mode: 'extension', chrome: 'connected',
      session: { id: 's1', agentId: 'a', conversationId: 'c1', requestId: 'r', task: 't', expiresAt: '', steps: 0, maxSteps: 200 },
      held: { by: 'owner', where: 'chrome' }, message: 'The page is in front of you in your Chrome. Give it back when you are done.' };
    const control = vi.fn(async () => held);
    const hand = vi.fn(() => ({ supported: true, hand: {} }));
    const fake = { enable: async () => {}, shutdown: async () => {}, status: () => held, screenshot: () => undefined,
      execute: async () => ({}), secretFill: async () => ({}), secretType: async () => ({}), control, hand } as unknown as BrowserController;
    const { origin } = await setup(true, fake);
    const headers = await session(origin);
    const taken = await fetch(`${origin}/api/browser/takeover`, { method: 'POST', headers, body: JSON.stringify({ sessionId: 's1' }) });
    expect(taken.status).toBe(200);
    const body = await taken.json() as Record<string, unknown>;
    expect(body).toMatchObject({ state: 'paused', held: { by: 'owner', where: 'chrome' }, hand: false, chrome: 'connected' });
    expect(body).not.toHaveProperty('handMessage');
    expect(control).toHaveBeenCalledWith('takeover', 's1', undefined);
    expect(hand).not.toHaveBeenCalled();
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
