/**
 * Signing in through Tailscale, against a fake daemon.
 *
 * Nothing here needs `tailscaled`: the whois and the status are injected, so
 * what is under test is the rule — headers alone are never enough, the socket
 * has to be loopback, the forwarded address has to be a tailnet one, and the
 * daemon has to agree with the login the owner allowed.
 */
import { ToolRegistry, type AgentCatalog, type ToolContext } from '@buddi/core';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { startWebServer, type WebServer } from './server.js';
import {
  isTailnetAddress,
  plausibleLogin,
  resetTailscaleLog,
  tailscaleIdentity,
  toTailscaleSetting,
} from './tailscale.js';

const servers: WebServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
beforeEach(() => resetTailscaleLog());

const OWNER = 'owner@example.com';
const TAILNET_IP = '100.101.102.103';

/** A request, as far as `tailscaleIdentity` can tell. */
function req(opts: { headers?: Record<string, string>; remote?: string } = {}): never {
  return {
    headers: {
      'tailscale-user-login': OWNER,
      'tailscale-user-name': 'The Owner',
      'x-forwarded-for': TAILNET_IP,
      ...opts.headers,
    },
    socket: { remoteAddress: opts.remote ?? '127.0.0.1' },
  } as never;
}

const setting = (over: Partial<{ enabled: boolean; login: string }> = {}) => async () => ({ enabled: true, login: OWNER, ...over });
const whoisSaying = (login: string | null) => async () => (login === null ? null : { login, name: 'The Owner' });

it('accepts an identity the local daemon confirms', async () => {
  const identity = await tailscaleIdentity(req(), { setting: setting(), whois: whoisSaying(OWNER), log: () => {} });
  expect(identity).toEqual({ login: OWNER, name: 'The Owner', address: TAILNET_IP });
});

it('refuses headers that did not arrive from this machine', async () => {
  const lines: string[] = [];
  const identity = await tailscaleIdentity(req({ remote: '203.0.113.7' }), { setting: setting(), whois: whoisSaying(OWNER), log: (l) => lines.push(l) });
  expect(identity).toBeNull();
  expect(lines.join('\n')).toMatch(/not this machine/);
});

it('refuses a forwarded address that is not on the tailnet', async () => {
  const identity = await tailscaleIdentity(req({ headers: { 'x-forwarded-for': '192.168.1.20' } }), { setting: setting(), whois: whoisSaying(OWNER), log: () => {} });
  expect(identity).toBeNull();
});

it('refuses a login that is not the one allowed', async () => {
  const identity = await tailscaleIdentity(req({ headers: { 'tailscale-user-login': 'someone@else.example' } }), { setting: setting(), whois: whoisSaying(OWNER), log: () => {} });
  expect(identity).toBeNull();
});

it('refuses when the daemon names a different person than the header does', async () => {
  const identity = await tailscaleIdentity(req(), { setting: setting(), whois: whoisSaying('intruder@example.com'), log: () => {} });
  expect(identity).toBeNull();
});

it('refuses when the whois fails, and says so once a minute at most', async () => {
  const lines: string[] = [];
  const whois = async (): Promise<never> => { throw new Error('no such socket'); };
  const at = new Date('2026-01-01T00:00:00Z');
  const deps = { setting: setting(), whois, log: (l: string) => lines.push(l), now: () => at };
  expect(await tailscaleIdentity(req(), deps)).toBeNull();
  expect(await tailscaleIdentity(req(), deps)).toBeNull();
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/could not be asked/);
  const later = new Date(at.getTime() + 61_000);
  expect(await tailscaleIdentity(req(), { ...deps, now: () => later })).toBeNull();
  expect(lines).toHaveLength(2);
});

it('ignores the headers entirely while the setting is off', async () => {
  const identity = await tailscaleIdentity(req(), { setting: async () => ({ enabled: false, login: OWNER }), whois: whoisSaying(OWNER), log: () => {} });
  expect(identity).toBeNull();
});

it('matches a login whatever its case, and knows a tailnet address from a LAN one', () => {
  expect(isTailnetAddress('100.64.0.1')).toBe(true);
  expect(isTailnetAddress('100.128.0.1')).toBe(false);
  expect(isTailnetAddress('fd7a:115c:a1e0::1234')).toBe(true);
  expect(isTailnetAddress('10.0.0.4')).toBe(false);
  expect(plausibleLogin('someone@example.com')).toBe(true);
  expect(plausibleLogin('someone else')).toBe(false);
  expect(toTailscaleSetting({ enabled: true, login: '   ' })).toEqual({ enabled: false, login: '' });
});

/* ------------------------------------------------------------------ *
 * Through the server
 * ------------------------------------------------------------------ */

/** A pool that holds the one settings row these tests care about. */
function pool(initial: { enabled: boolean; login: string } | null): { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> } {
  let value = initial;
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('from core.web_settings')) return { rows: value ? [{ value }] : [] };
      if (sql.includes('into core.web_settings')) {
        value = JSON.parse(String(params?.[1])) as { enabled: boolean; login: string };
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

async function dashboard(row: { enabled: boolean; login: string } | null, whoisLogin: string | null = OWNER): Promise<WebServer> {
  const app = await startWebServer({
    pool: pool(row) as never,
    registry: new ToolRegistry(),
    catalog: {} as AgentCatalog,
    ctx: { ownerId: 'owner' } as ToolContext,
    timezone: 'UTC',
    now: () => new Date(),
    config: { enabled: true, host: '127.0.0.1', port: 0, publicOrigin: 'https://buddi.tail1234.ts.net:9443' },
    token: 'fixture',
    env: {},
    log: () => {},
    tailscale: {
      whois: async () => (whoisLogin === null ? null : { login: whoisLogin, name: 'The Owner' }),
      self: async () => ({ available: true, self: { login: OWNER, name: 'The Owner' } }),
    },
  });
  servers.push(app);
  return app;
}

/** The headers Tailscale Serve puts on a forwarded request. */
const SERVE_HEADERS = {
  'Tailscale-User-Login': OWNER,
  'Tailscale-User-Name': 'The Owner',
  'X-Forwarded-For': TAILNET_IP,
  Host: 'buddi.tail1234.ts.net:9443',
};

it('signs a forwarded request in and says how it got in', async () => {
  const app = await dashboard({ enabled: true, login: OWNER });
  const res = await fetch(`http://127.0.0.1:${app.port}/api/session`, { headers: SERVE_HEADERS });
  expect(res.status).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.signedInThrough).toBe('tailscale');
  expect(body.tailscaleName).toBe('The Owner');
  expect(body.scope).toBe('remote');
  // The public origin is HTTPS, so the cookies this session gets are Secure.
  expect(res.headers.getSetCookie().every((c) => c.includes('Secure'))).toBe(true);
});

it('answers a forwarded request 401 when the daemon disagrees', async () => {
  const app = await dashboard({ enabled: true, login: OWNER }, 'intruder@example.com');
  const res = await fetch(`http://127.0.0.1:${app.port}/api/session`, { headers: SERVE_HEADERS });
  expect(res.status).toBe(401);
});

it('says local for an ordinary loopback session', async () => {
  const app = await dashboard(null);
  const res = await fetch(`http://127.0.0.1:${app.port}/api/session`);
  expect(((await res.json()) as Record<string, unknown>).signedInThrough).toBe('local');
});

/** A local session, with the headers every write needs. */
async function open(app: WebServer): Promise<{ origin: string; headers: Record<string, string> }> {
  const origin = `http://127.0.0.1:${app.port}`;
  const res = await fetch(`${origin}/api/session`);
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]!);
  const csrf = cookies.find((c) => c.startsWith('buddi_csrf='))!.slice('buddi_csrf='.length);
  return { origin, headers: { Cookie: cookies.join('; '), Origin: origin, 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' } };
}

it('tells the page what it needs to draw the panel, and saves a change', async () => {
  const app = await dashboard(null);
  const { origin, headers } = await open(app);
  const view = (await (await fetch(`${origin}/api/tailscale`, { headers })).json()) as Record<string, unknown>;
  expect(view).toMatchObject({ enabled: false, login: '', available: true, proxied: false });
  expect(view.self).toEqual({ login: OWNER, name: 'The Owner' });
  expect(view.serveCommand).toBe(`tailscale serve --bg --https=9443 http://127.0.0.1:${app.port}`);

  const saved = await fetch(`${origin}/api/tailscale`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, login: OWNER }) });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ enabled: true, login: OWNER });

  const refused = await fetch(`${origin}/api/tailscale`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, login: 'not a login' }) });
  expect(refused.status).toBe(400);
});

it('refuses to change the setting from a Tailscale session', async () => {
  const app = await dashboard({ enabled: true, login: OWNER });
  const origin = `http://127.0.0.1:${app.port}`;
  const res = await fetch(`${origin}/api/session`, { headers: SERVE_HEADERS });
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]!);
  const csrf = cookies.find((c) => c.startsWith('buddi_csrf='))!.slice('buddi_csrf='.length);
  const headers = { ...SERVE_HEADERS, Cookie: cookies.join('; '), Origin: 'https://buddi.tail1234.ts.net:9443', 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' };
  const view = (await (await fetch(`${origin}/api/tailscale`, { headers })).json()) as Record<string, unknown>;
  expect(view.proxied).toBe(true);
  const put = await fetch(`${origin}/api/tailscale`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, login: 'someone@else.example' }) });
  expect(put.status).toBe(403);
  expect(((await put.json()) as { error: string }).error).toMatch(/from the computer buddi runs on/);
});
