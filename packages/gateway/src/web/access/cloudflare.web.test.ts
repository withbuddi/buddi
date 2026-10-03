/**
 * Cloudflare Tunnel + Access through the server (specs/trusted-access.md §5,
 * §3.3, §7.5): the ingress listener, the session it mints, the rules that
 * session keeps, and the lockout kept apart from the machine's own.
 *
 * cloudflared is not here: a request to the ingress port with Access's
 * headers on it is exactly what cloudflared would forward. The team's keys
 * come from a fake JWKS (`__fixtures__/access-jwt.ts`).
 */
import { ToolRegistry, type AgentCatalog, type CoreToolContext } from '@buddi/core';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { startWebServer, type WebServer } from '../server.js';
import { csrfCookieName, sessionCookieName } from '../http.js';
import { mintTicket } from '../token.js';
import { EXTENSION_SOCKET_PATH } from '../extension.js';
import { hostFetch } from '../../__fixtures__/host-fetch.js';
import { AUD, OWNER_EMAIL, TEAM, fakeTeam, type FakeTeam } from '../../__fixtures__/access-jwt.js';
import { createJwks } from './cloudflare.js';

const fetch = hostFetch;
const servers: WebServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const PUBLIC = 'https://buddi.example.com';
const ON = { enabled: true, teamDomain: TEAM, aud: AUD, email: OWNER_EMAIL, publicOrigin: PUBLIC };

/** A pool holding web settings by key, as `core.web_settings` would. */
function pool(initial: Record<string, unknown>) {
  const rows = new Map<string, unknown>(Object.entries(initial));
  return {
    rows,
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes('from core.web_settings')) {
        const value = rows.get(String(params?.[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.includes('into core.web_settings')) {
        rows.set(String(params?.[0]), JSON.parse(String(params?.[1])));
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

interface App extends WebServer {
  team: FakeTeam;
  db: ReturnType<typeof pool>;
  /** The ingress listener's origin, as cloudflared would reach it. */
  edge: () => string;
  main: string;
}

async function dashboard(settings: Record<string, unknown> = { 'access.cloudflare': ON }, openAccess = true): Promise<App> {
  const now = () => new Date();
  const team = fakeTeam({ now });
  const db = pool(settings);
  const app = await startWebServer({
    pool: db as never,
    registry: new ToolRegistry(),
    catalog: {} as AgentCatalog,
    ctx: { ownerId: 'owner' } as CoreToolContext,
    timezone: 'UTC',
    now,
    config: { enabled: true, host: '127.0.0.1', port: 0 },
    token: 'fixture',
    env: {},
    openAccess,
    log: () => {},
    tailscale: { whois: async () => null, self: async () => ({ available: false, self: null }) },
    cloudflare: { jwks: createJwks({ transport: team.transport, now }) },
  });
  servers.push(app);
  return Object.assign(app, {
    team,
    db,
    edge: () => `http://127.0.0.1:${app.ingress.port()}`,
    main: `http://127.0.0.1:${app.port}`,
  });
}

/** What cloudflared forwards for a visit Access let through. */
function edgeHeaders(team: FakeTeam, extra: Record<string, string> = {}, claims: Record<string, unknown> = {}): Record<string, string> {
  return {
    Host: 'buddi.example.com',
    'X-Forwarded-Proto': 'https',
    'X-Forwarded-For': '203.0.113.9',
    'Cf-Connecting-Ip': '203.0.113.9',
    'Cf-Access-Jwt-Assertion': team.sign(claims),
    ...extra,
  };
}

const SESSION = sessionCookieName(443);
const CSRF = csrfCookieName(443);
const cookiesOf = (res: Response) => res.headers.getSetCookie();
const pairOf = (res: Response) => cookiesOf(res).map((c) => c.split(';')[0]!).join('; ');

describe('the ingress listener', () => {
  it('listens only while Cloudflare Access is on', async () => {
    const off = await dashboard({});
    expect(off.ingress.port()).toBeNull();
    const on = await dashboard();
    expect(on.ingress.port()).toEqual(expect.any(Number));
    expect(on.ingress.port()).not.toBe(on.port);
  });

  it('signs in a visit Access let through, as a remote session with secure cookies named for 443', async () => {
    const app = await dashboard();
    const res = await fetch(`${app.edge()}/api/session`, { headers: edgeHeaders(app.team) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ scope: 'remote', signedInThrough: 'cloudflare-access', provider: 'cloudflare-access', providerSubject: OWNER_EMAIL });
    const session = cookiesOf(res).find((c) => c.startsWith(`${SESSION}=`))!;
    expect(session).toMatch(/Secure/);
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/SameSite=Strict/);
    expect(session).toMatch(/Max-Age=43200/);
  });

  it('refuses plain headers without a valid JWT, and a JWT that does not verify', async () => {
    const app = await dashboard();
    const plain = { Host: 'buddi.example.com', 'X-Forwarded-Proto': 'https', 'Cf-Access-Authenticated-User-Email': OWNER_EMAIL, 'Cf-Connecting-Ip': '203.0.113.9' };
    expect((await fetch(`${app.edge()}/api/session`, { headers: plain })).status).toBe(401);
    expect((await fetch(`${app.edge()}/api/session`, { headers: edgeHeaders(app.team, {}, { aud: ['someone-elses-app-0000000000000'] }) })).status).toBe(401);
    expect((await fetch(`${app.edge()}/api/session`, { headers: edgeHeaders(app.team, {}, { email: 'intruder@example.com' }) })).status).toBe(401);
    // The page load says why, by case, and never names anyone.
    const page = await fetch(`${app.edge()}/`, { headers: { ...plain, 'Sec-Fetch-Mode': 'navigate' } });
    expect(page.status).toBe(401);
    expect(await page.text()).toContain('Cloudflare Access isn’t in front of this address');
    const wrong = await fetch(`${app.edge()}/`, { headers: edgeHeaders(app.team, { 'Sec-Fetch-Mode': 'navigate' }, { email: 'intruder@example.com' }) });
    const text = await wrong.text();
    expect(text).toContain('This Cloudflare login isn’t allowed here');
    expect(text).not.toContain('intruder');
  });

  it('is remote whatever the request says: no open loopback session, no local scope', async () => {
    const app = await dashboard();
    // Loopback socket, a loopback Host, no proxy headers: on the main listener that is the owner at the Mac.
    const bare = { Host: '127.0.0.1' };
    expect((await fetch(`${app.main}/api/session`, { headers: bare })).status).toBe(200);
    expect((await fetch(`${app.edge()}/api/session`, { headers: bare })).status).toBe(401);
  });

  it('a valid JWT replayed on the main listener earns nothing from it', async () => {
    const app = await dashboard({ 'access.cloudflare': ON }, false);
    const res = await fetch(`${app.main}/api/session`, { headers: edgeHeaders(app.team) });
    expect(res.status).toBe(401);
  });

  it('keeps the session through a stray request without the header, ends it when the email changes', async () => {
    const app = await dashboard();
    const first = await fetch(`${app.edge()}/api/session`, { headers: edgeHeaders(app.team) });
    const cookie = pairOf(first);
    // No header: this request is refused, the session is not ended.
    const stray = await fetch(`${app.edge()}/api/session`, { headers: { Host: 'buddi.example.com', Cookie: cookie } });
    expect(stray.status).toBe(401);
    expect(cookiesOf(stray)).toEqual([]);
    const again = await fetch(`${app.edge()}/api/session`, { headers: edgeHeaders(app.team, { Cookie: cookie }) });
    expect(again.status).toBe(200);
    expect(cookiesOf(again).some((c) => c.startsWith(`${SESSION}=`))).toBe(false);
    // Another email on the same cookie: the session goes.
    const other = await fetch(`${app.edge()}/api/session`, { headers: edgeHeaders(app.team, { Cookie: cookie }, { email: 'intruder@example.com' }) });
    expect(other.status).toBe(401);
    const back = await fetch(`${app.edge()}/api/session`, { headers: edgeHeaders(app.team, { Cookie: cookie }) });
    // The old cookie is gone; the owner's own assertion mints a fresh session.
    expect(back.status).toBe(200);
    expect(cookiesOf(back).some((c) => c.startsWith(`${SESSION}=`))).toBe(true);
  });

  it('checks CSRF and the exact Origin on writes, with the public address the panel stored', async () => {
    const app = await dashboard();
    const first = await fetch(`${app.edge()}/api/session`, { headers: edgeHeaders(app.team) });
    const cookie = pairOf(first);
    const csrf = cookiesOf(first).find((c) => c.startsWith(`${CSRF}=`))!.split(';')[0]!.slice(CSRF.length + 1);
    const write = (headers: Record<string, string>) => fetch(`${app.edge()}/api/version/check`, {
      method: 'PUT',
      headers: edgeHeaders(app.team, { Cookie: cookie, 'Content-Type': 'application/json', ...headers }),
      body: JSON.stringify({ enabled: false }),
    });
    expect((await write({ Origin: PUBLIC })).status).toBe(403); // no CSRF
    expect((await write({ Origin: 'https://evil.example', 'X-Buddi-CSRF': csrf })).status).toBe(403);
    expect((await write({ Origin: PUBLIC, 'X-Buddi-CSRF': csrf })).status).not.toBe(403);
  });

  it('a Cloudflare session cannot change how buddi is reached', async () => {
    const app = await dashboard();
    const first = await fetch(`${app.edge()}/api/session`, { headers: edgeHeaders(app.team) });
    const cookie = pairOf(first);
    const csrf = cookiesOf(first).find((c) => c.startsWith(`${CSRF}=`))!.split(';')[0]!.slice(CSRF.length + 1);
    const headers = edgeHeaders(app.team, { Cookie: cookie, Origin: PUBLIC, 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' });
    const view = (await (await fetch(`${app.edge()}/api/access`, { headers })).json()) as { proxied: boolean };
    expect(view.proxied).toBe(true);
    for (const path of ['/api/access/cloudflare-access', '/api/access/tailscale', '/api/tailscale']) {
      const put = await fetch(`${app.edge()}${path}`, { method: 'PUT', headers, body: JSON.stringify({ ...ON, email: 'intruder@example.com', login: 'intruder@example.com' }) });
      expect(put.status).toBe(403);
    }
    const test = await fetch(`${app.edge()}/api/access/cloudflare-access/test`, { method: 'POST', headers, body: JSON.stringify({ teamDomain: TEAM }) });
    expect(test.status).toBe(403);
  });

  it('refuses the extension pairing socket on the ingress listener, loopback socket or not', async () => {
    const app = await dashboard();
    const upgrade = (origin: string) => new Promise<number>((resolve) => {
      const url = new URL(`${origin}${EXTENSION_SOCKET_PATH}`);
      const req = request({
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', Origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' },
      });
      req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode ?? 101); });
      req.on('response', (res) => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', () => resolve(-1));
      req.end();
    });
    // The control: the same handshake on the main listener gets past the
    // loopback gate (this test wires no extension store, hence not a 101).
    expect(await upgrade(app.main)).not.toBe(403);
    expect(await upgrade(app.edge())).toBe(403);
  });
});

describe('the lockout, per arrival path', () => {
  it('a stranger behind the tunnel locks out only the unverified tunnel bucket, never this machine or the owner', async () => {
    const app = await dashboard({ 'access.cloudflare': ON }, false);
    const stranger = { Host: 'buddi.example.com', 'X-Forwarded-Proto': 'https', 'Cf-Connecting-Ip': '198.51.100.7' };
    let status = 0;
    for (let i = 0; i < 30 && status !== 429; i++) {
      status = (await fetch(`${app.edge()}/api/session`, { headers: { ...stranger, Cookie: `${SESSION}=bad${i}` } })).status;
    }
    expect(status).toBe(429);
    // The machine itself still gets an honest 401 for a bad ticket, not a 429.
    expect((await fetch(`${app.main}/?t=wrong`, { redirect: 'manual' })).status).toBe(401);
    // The owner, verified by Access, still signs in through the tunnel during the lockout.
    expect((await fetch(`${app.edge()}/api/session`, { headers: edgeHeaders(app.team) })).status).toBe(200);
  });

  it('counts a verified visitor’s bad cookies against their own address', async () => {
    const app = await dashboard({ 'access.cloudflare': ON }, false);
    let status = 0;
    for (let i = 0; i < 30 && status !== 429; i++) {
      status = (await fetch(`${app.edge()}/?t=wrong${i}`, { headers: edgeHeaders(app.team, { 'Cf-Connecting-Ip': '198.51.100.7' }), redirect: 'manual' })).status;
    }
    expect(status).toBe(429);
    // Another client of the same tunnel is not locked out with them.
    expect((await fetch(`${app.edge()}/?t=wrong`, { headers: edgeHeaders(app.team, { 'Cf-Connecting-Ip': '198.51.100.8' }), redirect: 'manual' })).status).toBe(401);
    expect((await fetch(`${app.main}/?t=wrong`, { redirect: 'manual' })).status).toBe(401);
  });
});

describe('the panel', () => {
  /** A browser session on this machine, with its CSRF pair. */
  async function local(app: App): Promise<Record<string, string>> {
    const exchange = await fetch(`${app.main}/?t=${encodeURIComponent(mintTicket('fixture'))}`, { redirect: 'manual' });
    const cookies = exchange.headers.getSetCookie().map((c) => c.split(';')[0]!);
    const name = csrfCookieName(app.port);
    const csrf = cookies.find((c) => c.startsWith(`${name}=`))!.slice(name.length + 1);
    return { Cookie: cookies.join('; '), Origin: app.main, 'X-Buddi-CSRF': csrf, 'Content-Type': 'application/json' };
  }

  it('lists both providers with their status, and saves, tests and turns Cloudflare off from this machine', async () => {
    const app = await dashboard({}, false);
    const headers = await local(app);
    const list = (await (await fetch(`${app.main}/api/access`, { headers })).json()) as { proxied: boolean; providers: Array<{ id: string; status: { state: string } }> };
    expect(list.proxied).toBe(false);
    expect(list.providers.map((p) => [p.id, p.status.state])).toEqual([['tailscale', 'off'], ['cloudflare-access', 'off']]);

    const bad = await fetch(`${app.main}/api/access/cloudflare-access`, { method: 'PUT', headers, body: JSON.stringify({ enabled: true, teamDomain: TEAM }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('To turn this on, fill in the AUD tag and your email.');

    const tested = (await (await fetch(`${app.main}/api/access/cloudflare-access/test`, { method: 'POST', headers, body: JSON.stringify({ teamDomain: 'buddi-test' }) })).json()) as Record<string, unknown>;
    expect(tested).toMatchObject({ ok: true, keys: 1, teamDomain: TEAM, sentence: `${TEAM} answered with 1 signing key.` });

    const saved = await fetch(`${app.main}/api/access/cloudflare-access`, { method: 'PUT', headers, body: JSON.stringify(ON) });
    expect(saved.status).toBe(200);
    const view = (await saved.json()) as Record<string, any>;
    expect(view).toMatchObject({ enabled: true, teamDomain: TEAM, email: OWNER_EMAIL, listening: true, test: { ok: true, keys: 1 }, status: { state: 'waiting' } });
    expect(app.ingress.port()).toBe(view.ingressPort);
    expect(view.setup.steps.map((s: { command?: string }) => s.command)).toContain(`http://127.0.0.1:${view.ingressPort}`);

    // A visit through the tunnel, then the owner turns it off: the session goes, the listener closes.
    const visit = await fetch(`${app.edge()}/api/session`, { headers: edgeHeaders(app.team) });
    expect(visit.status).toBe(200);
    const cookie = pairOf(visit);
    const ready = (await (await fetch(`${app.main}/api/access/cloudflare-access`, { headers })).json()) as { status: { state: string }; lastVisit: { email: string } };
    expect(ready.status.state).toBe('ready');
    expect(ready.lastVisit.email).toBe(OWNER_EMAIL);
    const edge = app.edge();
    const off = await fetch(`${app.main}/api/access/cloudflare-access`, { method: 'PUT', headers, body: JSON.stringify({ ...ON, enabled: false }) });
    expect(off.status).toBe(200);
    expect(app.ingress.port()).toBeNull();
    await expect(fetch(`${edge}/api/session`, { headers: edgeHeaders(app.team, { Cookie: cookie }) })).rejects.toThrow();
  });
});
