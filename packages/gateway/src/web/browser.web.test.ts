import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry, type AgentCatalog, type ToolContext } from '@buddi/core';
import { BrowserService, BrowserManager, commandSchema, type BrowserController, type BrowserDriver } from '@buddi/tool-browser';
import { startWebServer, type WebServer } from './server.js';
import { mintTicket } from './token.js';

const TOKEN = 'fixture-browser-dashboard-token';
const instances: WebServer[] = [];
const services: BrowserController[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map((s) => s.close())); await Promise.all(services.splice(0).map((s) => s.shutdown())); });

async function setup(openAccess = true, supplied?: BrowserController, publicOrigin?: string) {
  const driver: BrowserDriver = { start: vi.fn(), perform: vi.fn(), observe: vi.fn(), screenshot: vi.fn(), close: vi.fn() };
  const browser: BrowserController = supplied ?? new BrowserService(driver); services.push(browser); await browser.enable();
  const app = await startWebServer({ pool: {} as never, registry: new ToolRegistry(), catalog: {} as AgentCatalog,
    ctx: { ownerId: 'owner' } as ToolContext, timezone: 'UTC', now: () => new Date(),
    config: { enabled: true, host: '127.0.0.1', port: 0, publicOrigin }, openAccess, token: TOKEN, browser });
  instances.push(app);
  const origin = `http://127.0.0.1:${app.port}`;
  return { app, origin, browser, driver };
}

async function session(origin: string, ticket?: string) {
  const res = await fetch(`${origin}/api/session${ticket ? `?t=${encodeURIComponent(ticket)}` : ''}`, { redirect: 'manual' });
  const pairs = res.headers.getSetCookie().map((line) => line.split(';')[0]!);
  const csrf = pairs.find((p) => p.startsWith('buddi_csrf='))?.slice('buddi_csrf='.length) ?? '';
  return { Cookie: pairs.join('; '), 'X-Buddi-CSRF': csrf, Origin: origin, 'Content-Type': 'application/json' };
}

describe('browser dashboard endpoints', () => {
  it('requires a remote ticket behind an HTTPS proxy and preserves write protection', async () => {
    const external = 'https://host.example:9443';
    const { origin, browser } = await setup(true, undefined, external);
    const proxy = { Host: 'host.example:9443', 'X-Forwarded-For': '100.64.0.2' };
    expect((await fetch(`${origin}/api/session`, { headers: proxy })).status).toBe(401);
    expect((await fetch(`${origin}/api/session`, { headers: { ...proxy, Host: 'localhost:4317' } })).status).toBe(401);
    const local = await session(origin);
    expect((await fetch(`${origin}/api/session`, { headers: { ...local, ...proxy } })).status).toBe(401);
    const ticket = mintTicket(TOKEN, new Date());
    const response = await fetch(`${origin}/?t=${ticket}`, { headers: proxy, redirect: 'manual' });
    expect(response.status).toBe(302);
    const pairs = response.headers.getSetCookie();
    expect(pairs.every((cookie) => cookie.includes('Secure') && cookie.includes('Max-Age=43200'))).toBe(true);
    const csrf = pairs.find((value) => value.startsWith('buddi_csrf='))!.split(';')[0]!.slice('buddi_csrf='.length);
    const headers = { ...proxy, Cookie: pairs.map((value) => value.split(';')[0]).join('; '), 'X-Buddi-CSRF': csrf, Origin: external, 'Content-Type': 'application/json' };
    expect(await (await fetch(`${origin}/api/session`, { headers })).json()).toMatchObject({ scope: 'remote' });
    expect((await fetch(`${origin}/?t=${ticket}`, { headers: proxy, redirect: 'manual' })).status).toBe(401);
    browser.checkPermissions = vi.fn(async () => browser.status());
    expect((await fetch(`${origin}/api/browser/permissions`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${origin}/api/browser/permissions`, { method: 'POST', headers: { ...headers, 'X-Buddi-CSRF': '' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${origin}/api/browser/permissions`, { method: 'POST', headers, body: '{}' })).status).toBe(200);
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
    for (const id of ['a', 'b']) await manager.execute(commandSchema.parse({ action: 'navigate', url: 'https://example.com/' }), {
      ownerId: 'owner', agentId: id, conversationId: id, ownerRequest: { id, text: 'Fixture', expiresAt: Date.now() + 60_000 },
    } as ToolContext);
    const a = await (await fetch(`${origin}/api/browser?agentId=a&conversationId=a`, { headers })).json() as { session: { id: string }; page: { id: string }; sessions?: unknown };
    expect(a.sessions).toBeUndefined(); expect(a.page.id).toBe('1');
    const image = await fetch(`${origin}/api/browser/screenshot?sessionId=${a.session.id}&v=1`, { headers });
    expect(await image.text()).toBe('picture-1');
    expect((await fetch(`${origin}/api/browser/screenshot?sessionId=${a.session.id}&v=2`, { headers })).status).toBe(404);
    expect((await fetch(`${origin}/api/browser/release`, { method: 'POST', headers, body: JSON.stringify({ sessionId: a.session.id }) })).status).toBe(200);
    expect((await fetch(`${origin}/api/browser/screenshot?sessionId=${a.session.id}&v=1`, { headers })).status).toBe(404);
    expect(manager.status().sessions).toHaveLength(1); expect(manager.status().session?.agentId).toBe('b');
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
  it('cannot enable a controller that is not hosted here', async () => {
    const { origin, browser } = await setup();
    await browser.shutdown();
    const headers = await session(origin);
    expect((await fetch(`${origin}/api/browser/resume`, { method: 'POST', headers, body: '{}' })).status).toBe(409);
  });
});
