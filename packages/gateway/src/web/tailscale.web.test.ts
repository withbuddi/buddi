/**
 * Signing in through Tailscale, against a fake daemon.
 *
 * Nothing here needs `tailscaled`: the whois and the status are injected, so
 * what is under test is the rule — headers alone are never enough, the socket
 * has to be loopback, the request has to have been forwarded exactly once over
 * HTTPS from a tailnet address, and the daemon has to name the login the owner
 * allowed. And then, because a session is not a bearer token: that the daemon
 * keeps saying so for as long as the session is used.
 */
import { ToolRegistry, type AgentCatalog, type ToolContext } from '@buddi/core';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { startWebServer, type WebServer } from './server.js';
import { SessionStore, TAILSCALE_SESSION_MAX_MS } from './sessions.js';
import { mintTicket } from './token.js';
import {
  isTailnetAddress,
  plausibleLogin,
  resetTailscaleLog,
  tailscaleIdentity,
  tailscaleLogSize,
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
function req(opts: { headers?: Record<string, string | string[]>; remote?: string } = {}): never {
  return {
    headers: {
      'tailscale-user-login': OWNER,
      'tailscale-user-name': 'The Owner',
      'x-forwarded-for': TAILNET_IP,
      'x-forwarded-proto': 'https',
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

it('refuses a request that two proxies forwarded, however tailnet the first hop looks', async () => {
  const lines: string[] = [];
  const deps = { setting: setting(), whois: whoisSaying(OWNER), log: (l: string) => lines.push(l) };
  // One line with two addresses in it: a proxy in front of Serve appends.
  expect(await tailscaleIdentity(req({ headers: { 'x-forwarded-for': `${TAILNET_IP}, 203.0.113.9` } }), deps)).toBeNull();
  // And the same thing spelled as two header lines.
  expect(await tailscaleIdentity(req({ headers: { 'x-forwarded-for': [TAILNET_IP, '203.0.113.9'] } }), deps)).toBeNull();
  expect(lines.join('\n')).toMatch(/forwarded more than once/);
});

it('refuses a request that was not forwarded over HTTPS', async () => {
  const lines: string[] = [];
  const identity = await tailscaleIdentity(req({ headers: { 'x-forwarded-proto': 'http' } }), { setting: setting(), whois: whoisSaying(OWNER), log: (l) => lines.push(l) });
  expect(identity).toBeNull();
  expect(lines.join('\n')).toMatch(/not forwarded over HTTPS/);
});

it('refuses a login that is not the one allowed', async () => {
  const identity = await tailscaleIdentity(req({ headers: { 'tailscale-user-login': 'someone@else.example' } }), { setting: setting(), whois: whoisSaying(OWNER), log: () => {} });
  expect(identity).toBeNull();
});

it('refuses when the header claims a login the daemon does not name for that address', async () => {
  // The daemon names the allowed login, but the header claims somebody else:
  // the two have to agree with the setting and with each other.
  const identity = await tailscaleIdentity(
    req({ headers: { 'tailscale-user-login': 'other@example.com' } }),
    { setting: setting(), whois: whoisSaying(OWNER), log: () => {} },
  );
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

it('does not ask the daemon at all while the caller is over its sign-in budget', async () => {
  let asked = 0;
  const lines: string[] = [];
  const identity = await tailscaleIdentity(req(), {
    setting: setting(),
    whois: async () => { asked += 1; return { login: OWNER, name: 'The Owner' }; },
    mayAskDaemon: () => false,
    log: (l) => lines.push(l),
  });
  expect(identity).toBeNull();
  expect(asked).toBe(0);
  expect(lines.join('\n')).toMatch(/too many failed sign-ins/);
});

it('logs by reason, so a caller varying its headers can neither grow the map nor choose what it says', async () => {
  const lines: string[] = [];
  let at = new Date('2026-01-01T00:00:00Z');
  let asked = 0;
  for (let i = 0; i < 500; i += 1) {
    at = new Date(at.getTime() + 120_000); // past the throttle every time
    await tailscaleIdentity(
      req({ headers: { 'tailscale-user-login': `caller${i}@example.com`, 'x-forwarded-for': `100.64.${i % 255}.${(i * 7) % 255}` } }),
      { setting: setting(), whois: async () => { asked += 1; return null; }, log: (l) => lines.push(l), now: () => at },
    );
  }
  // One entry per reason, whatever the traffic — and the reasons are a fixed list.
  expect(tailscaleLogSize()).toBeLessThanOrEqual(10);
  expect(asked).toBe(0); // the login never matched, so the daemon was never asked
  expect(lines.join('\n')).not.toMatch(/caller\d+@example\.com/);
  expect(lines.join('\n')).not.toMatch(/100\.64\./);
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

/** The clock and the daemon's opinion, both movable from inside a test. */
interface Knobs {
  whois: string | null;
  now: Date;
}

async function dashboard(
  row: { enabled: boolean; login: string } | null,
  whoisLogin: string | null = OWNER,
): Promise<WebServer & { knobs: Knobs }> {
  const knobs: Knobs = { whois: whoisLogin, now: new Date('2026-03-01T00:00:00Z') };
  const app = await startWebServer({
    pool: pool(row) as never,
    registry: new ToolRegistry(),
    catalog: {} as AgentCatalog,
    ctx: { ownerId: 'owner' } as ToolContext,
    timezone: 'UTC',
    now: () => knobs.now,
    config: { enabled: true, host: '127.0.0.1', port: 0, publicOrigin: 'https://buddi.tail1234.ts.net:9443' },
    token: 'fixture',
    env: {},
    log: () => {},
    tailscale: {
      whois: async () => (knobs.whois === null ? null : { login: knobs.whois, name: 'The Owner' }),
      self: async () => ({ available: true, self: { login: OWNER, name: 'The Owner' } }),
    },
  });
  servers.push(app);
  return Object.assign(app, { knobs });
}

/** The headers Tailscale Serve puts on a forwarded request. */
const SERVE_HEADERS = {
  'Tailscale-User-Login': OWNER,
  'Tailscale-User-Name': 'The Owner',
  'X-Forwarded-For': TAILNET_IP,
  'X-Forwarded-Proto': 'https',
  Host: 'buddi.tail1234.ts.net:9443',
};

/** Sign in through Serve and keep what the browser would keep. */
async function tailnetSession(app: WebServer): Promise<{ origin: string; headers: Record<string, string> }> {
  const origin = `http://127.0.0.1:${app.port}`;
  const res = await fetch(`${origin}/api/session`, { headers: SERVE_HEADERS });
  expect(res.status).toBe(200);
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0]!);
  const csrf = cookies.find((c) => c.startsWith('buddi_csrf='))!.slice('buddi_csrf='.length);
  return {
    origin,
    headers: { ...SERVE_HEADERS, Cookie: cookies.join('; '), Origin: 'https://buddi.tail1234.ts.net:9443', 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' },
  };
}

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

it('refuses a request two proxies forwarded, even with the right login on it', async () => {
  const app = await dashboard({ enabled: true, login: OWNER });
  const res = await fetch(`http://127.0.0.1:${app.port}/api/session`, {
    headers: { ...SERVE_HEADERS, 'X-Forwarded-For': `${TAILNET_IP}, 203.0.113.9` },
  });
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
  const { origin, headers } = await tailnetSession(app);
  const view = (await (await fetch(`${origin}/api/tailscale`, { headers })).json()) as Record<string, unknown>;
  expect(view.proxied).toBe(true);
  const put = await fetch(`${origin}/api/tailscale`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, login: 'someone@else.example' }) });
  expect(put.status).toBe(403);
  expect(((await put.json()) as { error: string }).error).toMatch(/from the computer buddi runs on/);
});

it('refuses to change the setting from a ticket session established off this machine', async () => {
  const app = await dashboard(null);
  const origin = `http://127.0.0.1:${app.port}`;
  // A ticket exchanged through some other local proxy: loopback socket, but
  // forwarding metadata on it, so the session it mints is a remote one.
  const proxy = { 'X-Forwarded-For': '203.0.113.4', Host: 'buddi.tail1234.ts.net:9443' };
  const exchange = await fetch(`${origin}/?t=${encodeURIComponent(mintTicket('fixture'))}`, { headers: proxy, redirect: 'manual' });
  expect(exchange.status).toBe(302);
  const cookies = exchange.headers.getSetCookie().map((c) => c.split(';')[0]!);
  const csrf = cookies.find((c) => c.startsWith('buddi_csrf='))!.slice('buddi_csrf='.length);
  const headers = { ...proxy, Cookie: cookies.join('; '), Origin: 'https://buddi.tail1234.ts.net:9443', 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' };
  expect(((await (await fetch(`${origin}/api/session`, { headers })).json()) as Record<string, unknown>).signedInThrough).toBe('ticket');

  const put = await fetch(`${origin}/api/tailscale`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, login: 'someone@else.example' }) });
  expect(put.status).toBe(403);
  expect(((await put.json()) as { error: string }).error).toMatch(/from the computer buddi runs on/);
});

it('ends every tailnet session the moment the setting is turned off', async () => {
  const app = await dashboard({ enabled: true, login: OWNER });
  const tailnet = await tailnetSession(app);
  expect((await fetch(`${tailnet.origin}/api/session`, { headers: tailnet.headers })).status).toBe(200);

  const local = await open(app);
  const off = await fetch(`${local.origin}/api/tailscale`, { method: 'PUT', headers: local.headers, body: JSON.stringify({ enabled: false, login: OWNER }) });
  expect(off.status).toBe(200);

  expect((await fetch(`${tailnet.origin}/api/session`, { headers: tailnet.headers })).status).toBe(401);
});

it('ends a tailnet session when the allowed login is changed to somebody else', async () => {
  const app = await dashboard({ enabled: true, login: OWNER });
  const tailnet = await tailnetSession(app);
  const local = await open(app);
  const changed = await fetch(`${local.origin}/api/tailscale`, { method: 'PUT', headers: local.headers, body: JSON.stringify({ enabled: true, login: 'someone@else.example' }) });
  expect(changed.status).toBe(200);

  expect((await fetch(`${tailnet.origin}/api/session`, { headers: tailnet.headers })).status).toBe(401);
});

it('ends a tailnet session when the daemon starts naming a different login for that address', async () => {
  const app = await dashboard({ enabled: true, login: OWNER });
  const tailnet = await tailnetSession(app);
  expect((await fetch(`${tailnet.origin}/api/session`, { headers: tailnet.headers })).status).toBe(200);
  // The device changed hands, or the address was reassigned.
  app.knobs.whois = 'intruder@example.com';
  expect((await fetch(`${tailnet.origin}/api/session`, { headers: tailnet.headers })).status).toBe(401);
  // And it is gone, not merely refused: putting the daemon back does not
  // resurrect it — a fresh sign-in is what mints a session again.
  app.knobs.whois = OWNER;
  const again = await fetch(`${tailnet.origin}/api/session`, { headers: tailnet.headers });
  expect(again.status).toBe(200);
  expect(again.headers.getSetCookie().some((c) => c.startsWith('buddi_session='))).toBe(true);
});

it('ends a tailnet session after seven days, however much it is used', async () => {
  const app = await dashboard({ enabled: true, login: OWNER });
  const tailnet = await tailnetSession(app);
  const minted = /buddi_session=([^;]+)/.exec(tailnet.headers.Cookie ?? '')![1];
  const started = app.knobs.now.getTime();
  // Every six hours, well inside the twelve-hour idle lifetime: sliding it
  // keeps *this* session alive right up to the absolute edge. The cookie is
  // re-issued as it passes its half-life, always naming the same session.
  for (let at = 6; at < 7 * 24; at += 6) {
    app.knobs.now = new Date(started + at * 3_600_000);
    const res = await fetch(`${tailnet.origin}/api/session`, { headers: tailnet.headers });
    expect(res.status).toBe(200);
    for (const cookie of res.headers.getSetCookie()) {
      if (cookie.startsWith('buddi_session=')) expect(cookie.split(';')[0]!.slice('buddi_session='.length)).toBe(minted);
    }
  }
  // Past the edge the session is gone. The browser is still the person the
  // owner allowed, so Serve signs it in again — into a *different* session,
  // which is the whole point: no cookie outlives the week.
  app.knobs.now = new Date(started + 7 * 24 * 3_600_000 + 1_000);
  const res = await fetch(`${tailnet.origin}/api/session`, { headers: tailnet.headers });
  expect(res.status).toBe(200);
  const reminted = res.headers.getSetCookie().find((c) => c.startsWith('buddi_session='))!.split(';')[0]!.slice('buddi_session='.length);
  expect(reminted).not.toBe(minted);

  // And the expired one is not honoured on its own: presented by a browser the
  // daemon no longer vouches for, it is a 401 rather than a session.
  app.knobs.whois = 'intruder@example.com';
  expect((await fetch(`${tailnet.origin}/api/session`, { headers: tailnet.headers })).status).toBe(401);
});

it('holds a Tailscale session to an absolute lifetime the sliding one cannot extend', () => {
  const store = new SessionStore();
  const start = new Date('2026-03-01T00:00:00Z');
  const session = store.create('remote', start, { via: 'tailscale', tailscaleLogin: OWNER, tailscaleAddress: TAILNET_IP });
  expect(session.absoluteExpiresAt?.getTime()).toBe(start.getTime() + TAILSCALE_SESSION_MAX_MS);
  // Used every six hours for a week: alive, because the idle clock keeps being
  // pushed out — and then not, because the other one was never touched.
  for (let at = 6; at < 7 * 24; at += 6) {
    expect(store.get(session.id, 'remote', new Date(start.getTime() + at * 3_600_000))).toBeDefined();
  }
  expect(store.get(session.id, 'remote', new Date(start.getTime() + TAILSCALE_SESSION_MAX_MS))).toBeUndefined();
  // A ticket or local session has no such edge.
  const ticket = store.create('remote', start, { via: 'ticket' });
  expect(ticket.absoluteExpiresAt).toBeUndefined();
});
