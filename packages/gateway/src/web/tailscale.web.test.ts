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
import { ToolRegistry, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { startWebServer, type WebServer } from './server.js';
import { SessionStore, TAILSCALE_SESSION_MAX_MS } from './sessions.js';
import { mintTicket } from './token.js';
import { csrfCookieName, portOf, sessionCookieName } from './http.js';
import { hostFetch } from '../__fixtures__/host-fetch.js';
import {
  TAILSCALED_SOCKET,
  daemonWhois,
  isIpAddress,
  isTailnetAddress,
  parseStatus,
  parseWhois,
  resolveTailscaleBinary,
  tailscaleSelf,
  whoisOnce,
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

/**
 * These requests say which Host they came in on, as Tailscale Serve's do, and
 * the platform `fetch` would overwrite it.
 */
const fetch = hostFetch;

/**
 * Every dashboard here is configured with a public origin. A request through
 * Serve arrives with its Host (`…ts.net:9443`), so its cookies carry 9443; a
 * loopback request carries the bound port.
 */
const PUBLIC_PORT = portOf(new URL('https://buddi.tail1234.ts.net:9443'));
const SESSION_NAME = sessionCookieName(PUBLIC_PORT);
const CSRF_NAME = csrfCookieName(PUBLIC_PORT);

async function dashboard(
  row: { enabled: boolean; login: string } | null,
  whoisLogin: string | null = OWNER,
  publicOrigin: string | undefined = 'https://buddi.tail1234.ts.net:9443',
): Promise<WebServer & { knobs: Knobs }> {
  const knobs: Knobs = { whois: whoisLogin, now: new Date('2026-03-01T00:00:00Z') };
  const app = await startWebServer({
    pool: pool(row) as never,
    registry: new ToolRegistry(),
    catalog: {} as AgentCatalog,
    ctx: { ownerId: 'owner' } as CoreToolContext,
    timezone: 'UTC',
    now: () => knobs.now,
    config: { enabled: true, host: '127.0.0.1', port: 0, publicOrigin },
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
  const csrf = cookies.find((c) => c.startsWith(`${CSRF_NAME}=`))!.slice(`${CSRF_NAME}=`.length);
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
  const name = csrfCookieName(app.port);
  const csrf = cookies.find((c) => c.startsWith(`${name}=`))!.slice(`${name}=`.length);
  return { origin, headers: { Cookie: cookies.join('; '), Origin: origin, 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' } };
}

/** The names of the cookies a response set, value dropped. */
const cookieNames = (res: Response): string[] => res.headers.getSetCookie().map((c) => c.split('=')[0]!);

it('names the cookies after the port each request arrived on, public origin or not', async () => {
  const app = await dashboard({ enabled: true, login: OWNER });
  // The loopback page: the bound port, not the public origin's.
  const local = await fetch(`http://127.0.0.1:${app.port}/api/session`);
  expect(cookieNames(local)).toEqual([sessionCookieName(app.port), csrfCookieName(app.port)]);
  // The tailnet page: the port in Serve's Host.
  const tailnet = await fetch(`http://127.0.0.1:${app.port}/api/session`, { headers: SERVE_HEADERS });
  expect(cookieNames(tailnet)).toEqual([SESSION_NAME, CSRF_NAME]);

  const bare = await dashboard(null, OWNER, undefined);
  expect(cookieNames(await fetch(`http://127.0.0.1:${bare.port}/api/session`))).toEqual([sessionCookieName(bare.port), csrfCookieName(bare.port)]);
  // Another spelling of loopback, on another port a local proxy forwards from.
  expect(cookieNames(await fetch(`http://127.0.0.1:${bare.port}/api/session`, { headers: { Host: 'localhost:4999' } }))).toEqual([sessionCookieName(4999), csrfCookieName(4999)]);
  // A Host that does not parse names the bound port rather than throwing. It
  // is also not a loopback Host, so only a ticket signs it in.
  const odd = await fetch(`http://127.0.0.1:${bare.port}/?t=${encodeURIComponent(mintTicket('fixture'))}`, { headers: { Host: 'bad host:x' } });
  expect(odd.status).toBe(302);
  expect(cookieNames(odd)).toEqual([sessionCookieName(bare.port), csrfCookieName(bare.port)]);
});

it('keeps a loopback session and a tailnet session apart, each working on its own host', async () => {
  const app = await dashboard({ enabled: true, login: OWNER });
  const local = await open(app);
  const tailnet = await tailnetSession(app);
  // Tailnet first: saving the setting from loopback ends tailnet sessions.
  for (const side of [tailnet, local]) {
    expect((await fetch(`${side.origin}/api/session`, { headers: side.headers })).status).toBe(200);
    const write = await fetch(`${side.origin}/api/tailscale`, { method: 'PUT', headers: side.headers, body: JSON.stringify({ enabled: true, login: OWNER }) });
    // The tailnet one is refused for what it is, not for its cookies.
    expect(write.status).toBe(side === local ? 200 : 403);
    if (side === tailnet) expect(((await write.json()) as { error: string }).error).toMatch(/from the computer buddi runs on/);
  }
});

it('refuses a write whose CSRF cookie is named after another port', async () => {
  const app = await dashboard(null);
  const { origin, headers } = await open(app);
  // The right session and header, but the CSRF cookie a page on 9443 would hold.
  const cookie = headers.Cookie!.replace(`${csrfCookieName(app.port)}=`, `${CSRF_NAME}=`);
  const res = await fetch(`${origin}/api/tailscale`, { method: 'PUT', headers: { ...headers, Cookie: cookie }, body: JSON.stringify({ enabled: false, login: OWNER }) });
  expect(res.status).toBe(403);
});

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
  const csrf = cookies.find((c) => c.startsWith(`${CSRF_NAME}=`))!.slice(`${CSRF_NAME}=`.length);
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
  expect(again.headers.getSetCookie().some((c) => c.startsWith(`${SESSION_NAME}=`))).toBe(true);
});

it('ends a tailnet session after seven days, however much it is used', async () => {
  const app = await dashboard({ enabled: true, login: OWNER });
  const tailnet = await tailnetSession(app);
  const minted = new RegExp(`${SESSION_NAME}=([^;]+)`).exec(tailnet.headers.Cookie ?? '')![1];
  const started = app.knobs.now.getTime();
  // Every six hours, well inside the twelve-hour idle lifetime: sliding it
  // keeps *this* session alive right up to the absolute edge. The cookie is
  // re-issued as it passes its half-life, always naming the same session.
  for (let at = 6; at < 7 * 24; at += 6) {
    app.knobs.now = new Date(started + at * 3_600_000);
    const res = await fetch(`${tailnet.origin}/api/session`, { headers: tailnet.headers });
    expect(res.status).toBe(200);
    for (const cookie of res.headers.getSetCookie()) {
      if (cookie.startsWith(`${SESSION_NAME}=`)) expect(cookie.split(';')[0]!.slice(`${SESSION_NAME}=`.length)).toBe(minted);
    }
  }
  // Past the edge the session is gone. The browser is still the person the
  // owner allowed, so Serve signs it in again — into a *different* session,
  // which is the whole point: no cookie outlives the week.
  app.knobs.now = new Date(started + 7 * 24 * 3_600_000 + 1_000);
  const res = await fetch(`${tailnet.origin}/api/session`, { headers: tailnet.headers });
  expect(res.status).toBe(200);
  const reminted = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_NAME}=`))!.split(';')[0]!.slice(`${SESSION_NAME}=`.length);
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

/* ------------------------------------------------------------------ *
 * Talking to the daemon through the `tailscale` CLI
 *
 * Nothing below spawns anything: the binary lookup, the runner and the socket
 * probe are all injected, and what is under test is the reading of the CLI's
 * own JSON, the order the binary is looked for in, that an address which is
 * not an address never reaches an argv, and that the unix socket still answers
 * when there is no binary to run.
 * ------------------------------------------------------------------ */

const WHOIS_JSON = JSON.stringify({
  Node: { Name: 'mac-mini.tail1234.ts.net.', ID: 'n123' },
  UserProfile: { ID: 4, LoginName: OWNER, DisplayName: 'The Owner', ProfilePicURL: '' },
});

const STATUS_JSON = JSON.stringify({
  BackendState: 'Running',
  Self: {
    ID: 'n123',
    HostName: 'mac-mini',
    DNSName: 'mac-mini.tail1234.ts.net.',
    TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
    UserProfile: { LoginName: OWNER, DisplayName: 'The Owner' },
  },
});

/** A runner that records what it was asked to run and answers from a script. */
function execSaying(answers: Record<string, { code?: number; stdout: string }>) {
  const calls: { binary: string; args: string[] }[] = [];
  const exec = async (binary: string, args: string[]) => {
    calls.push({ binary, args });
    const answer = answers[args[0] ?? ''] ?? { code: 1, stdout: '' };
    return { code: answer.code ?? 0, stdout: answer.stdout };
  };
  return { exec, calls };
}

it('reads the login, the display name and the node out of `tailscale whois --json`', async () => {
  expect(parseWhois(WHOIS_JSON)).toEqual({ login: OWNER, name: 'The Owner' });
  // No display name: the node's own name stands in, and then the login.
  expect(parseWhois(JSON.stringify({ Node: { Name: 'mac-mini.tail1234.ts.net.' }, UserProfile: { LoginName: OWNER } })))
    .toEqual({ login: OWNER, name: 'mac-mini.tail1234.ts.net.' });
  expect(parseWhois(JSON.stringify({ UserProfile: { LoginName: OWNER, DisplayName: '  ' } })))
    .toEqual({ login: OWNER, name: OWNER });
  // An address the daemon does not know, and output that is not an answer at
  // all, are both "cannot say" rather than a throw.
  expect(parseWhois(JSON.stringify({ Node: { Name: 'x' } }))).toBeNull();
  expect(parseWhois('')).toBeNull();
  expect(parseWhois('is not a tailscale ip')).toBeNull();
  expect(parseWhois(JSON.stringify({ UserProfile: { LoginName: 42 } }))).toBeNull();
});

it('reads who this machine is, and whether it is up, out of `tailscale status --json`', async () => {
  const status = parseStatus(STATUS_JSON);
  expect(status.running).toBe(true);
  expect(status.self).toEqual({ login: OWNER, name: 'The Owner' });
  expect(status.addresses).toEqual(['100.101.102.103', 'fd7a:115c:a1e0::1']);
  // Installed but not signed in, or stopped: a daemon that vouches for nobody.
  expect(parseStatus(JSON.stringify({ BackendState: 'NeedsLogin', Self: null }))).toEqual({ running: false, self: null, addresses: [] });
  expect(parseStatus(JSON.stringify({ BackendState: 'Stopped', Self: { UserProfile: { LoginName: OWNER } } })).running).toBe(false);
  // The shape the CLI actually emits: `Self` names a user id and the profile
  // lives in the top-level `User` map.
  const byId = parseStatus(JSON.stringify({
    BackendState: 'Running',
    Self: { UserID: 1202412987709414, DNSName: 'mac-mini.tail1234.ts.net.', TailscaleIPs: ['100.101.102.103'] },
    User: { '1202412987709414': { ID: 1202412987709414, LoginName: OWNER, DisplayName: 'The Owner' } },
  }));
  expect(byId).toEqual({ running: true, self: { login: OWNER, name: 'The Owner' }, addresses: ['100.101.102.103'] });
  // A id with no entry in the map is a machine that cannot name itself.
  expect(parseStatus(JSON.stringify({ BackendState: 'Running', Self: { UserID: 7 }, User: {} })).self).toBeNull();
  expect(parseStatus('')).toEqual({ running: false, self: null, addresses: [] });
  expect(parseStatus('Tailscale is stopped.')).toEqual({ running: false, self: null, addresses: [] });
});

it('asks the CLI, and uses its answer as the whois', async () => {
  const { exec, calls } = execSaying({ whois: { stdout: WHOIS_JSON } });
  const whois = daemonWhois({ binary: () => '/usr/local/bin/tailscale', exec });
  expect(await whois(TAILNET_IP)).toEqual({ login: OWNER, name: 'The Owner' });
  expect(calls).toEqual([{ binary: '/usr/local/bin/tailscale', args: ['whois', '--json', TAILNET_IP] }]);
  // A minute's memory: the second question does not reach the daemon.
  expect(await whois(TAILNET_IP)).toEqual({ login: OWNER, name: 'The Owner' });
  expect(calls).toHaveLength(1);
});

it('reads a non-zero exit as "the daemon does not know", not as a failure', async () => {
  const { exec } = execSaying({ whois: { code: 1, stdout: '' } });
  expect(await whoisOnce(TAILNET_IP, { binary: () => '/usr/local/bin/tailscale', exec })).toBeNull();
});

it('reports the machine itself through the CLI', async () => {
  const { exec, calls } = execSaying({ status: { stdout: STATUS_JSON } });
  expect(await tailscaleSelf({ binary: () => '/usr/local/bin/tailscale', exec }))
    .toEqual({ available: true, self: { login: OWNER, name: 'The Owner' } });
  expect(calls).toEqual([{ binary: '/usr/local/bin/tailscale', args: ['status', '--json'] }]);
  // `tailscale status` on a stopped daemon exits non-zero and says so.
  const stopped = execSaying({ status: { code: 1, stdout: JSON.stringify({ BackendState: 'Stopped' }) } });
  expect(await tailscaleSelf({ binary: () => '/usr/local/bin/tailscale', exec: stopped.exec }))
    .toEqual({ available: false, self: null });
});

it('looks for the binary on the PATH first, then where a Mac keeps one', () => {
  const present = (...paths: string[]) => (p: string) => paths.includes(p);
  // The PATH wins, and the first PATH entry that has one wins within it.
  expect(resolveTailscaleBinary({
    path: ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'].join(':'),
    canExec: present('/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'),
  })).toBe('/opt/homebrew/bin/tailscale');
  // Nothing on the PATH: `/usr/local/bin` before the app bundle.
  expect(resolveTailscaleBinary({
    path: '/usr/bin:/bin',
    canExec: present('/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'),
  })).toBe('/usr/local/bin/tailscale');
  // Only the App Store app is installed — the case this whole change is about.
  expect(resolveTailscaleBinary({
    path: '/usr/bin:/bin',
    canExec: present('/Applications/Tailscale.app/Contents/MacOS/Tailscale'),
  })).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  // No Tailscale at all.
  expect(resolveTailscaleBinary({ path: '/usr/bin:/bin', canExec: () => false })).toBeNull();
  // A relative PATH entry is not searched: it would mean whatever directory
  // the gateway happens to have been started in.
  expect(resolveTailscaleBinary({ path: '.:bin::/usr/bin', canExec: present('tailscale', 'bin/tailscale', './tailscale') })).toBeNull();
  expect(resolveTailscaleBinary({ path: '', canExec: () => false })).toBeNull();
});

it('spells nothing but an IP address into the argv', async () => {
  for (const good of ['100.101.102.103', '100.64.0.1', 'fd7a:115c:a1e0::1', '::1', '2001:db8::8a2e:370:7334']) {
    expect(isIpAddress(good)).toBe(true);
  }
  for (const bad of [
    '', '   ', '--help', '-v', '100.101.102.103 --socket=/tmp/x', '100.101.102.103;id', '$(id)',
    'mac-mini.tail1234.ts.net', '100.94.221.256', '100.94.221', '100.101.102.103/24',
    '100.101.102.103%en0', 'fd7a::115c::1', 'fd7a:115c:a1e0::1;rm', 'fd7a:115c:a1e0:0:0:0:0:0:0:1', 'g::1',
    '1.2.3.4'.padEnd(60, '0'),
  ]) {
    expect(isIpAddress(bad), bad).toBe(false);
  }
  // And a whois for something that is not an address never runs a thing.
  const { exec, calls } = execSaying({ whois: { stdout: WHOIS_JSON } });
  expect(await whoisOnce('--socket=/tmp/evil.sock', { binary: () => '/usr/local/bin/tailscale', exec })).toBeNull();
  expect(calls).toEqual([]);
});

it('falls back to the tailscaled socket when there is no binary but a socket', async () => {
  const asked: string[] = [];
  const api = async (route: string, socketPath: string) => {
    asked.push(`${socketPath} ${route}`);
    return route.startsWith('/localapi/v0/whois')
      ? { status: 200, body: JSON.parse(WHOIS_JSON) as unknown }
      : { status: 200, body: JSON.parse(STATUS_JSON) as unknown };
  };
  const deps = { binary: () => null, socketExists: (p: string) => p === TAILSCALED_SOCKET, api };
  expect(await whoisOnce(TAILNET_IP, deps)).toEqual({ login: OWNER, name: 'The Owner' });
  expect(await tailscaleSelf(deps)).toEqual({ available: true, self: { login: OWNER, name: 'The Owner' } });
  expect(asked).toEqual([
    `${TAILSCALED_SOCKET} /localapi/v0/whois?addr=${encodeURIComponent(TAILNET_IP)}`,
    `${TAILSCALED_SOCKET} /localapi/v0/status`,
  ]);

  // Neither a binary nor a socket: the panel says Tailscale is not running
  // here, and a whois is a failure rather than a quiet "does not know" — the
  // identity path reads that as `daemon-unreachable`.
  const nothing = { binary: () => null, socketExists: () => false, api };
  expect(await tailscaleSelf(nothing)).toEqual({ available: false, self: null });
  await expect(whoisOnce(TAILNET_IP, nothing)).rejects.toThrow();
  expect(await tailscaleIdentity(req(), { setting: setting(), whois: daemonWhois(nothing) })).toBeNull();
});
