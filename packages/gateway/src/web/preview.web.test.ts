/**
 * Previews, over the wire, on the origin of their own.
 *
 * Everything here goes through a real gateway — both listeners — to a real
 * http server on a loopback port, because every property that matters is a
 * property of the bytes: which origin answered, which cookie was accepted,
 * which headers went up, which came back. A fake proxy would assert the shape
 * of a function call instead, which is the part that was never in doubt.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ToolRegistry, type AgentCatalog, type PluginManifest, type ToolContext } from '@buddi/core';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { afterEach, expect, it } from 'vitest';
import { PREVIEW_PORT_ATTEMPTS, startWebServer, type WebServer } from './server.js';
import {
  MAX_LIVE_COOKIES,
  MAX_LIVE_TICKETS,
  PREVIEW_COOKIE,
  PREVIEW_TICKET_TTL_MS,
  PreviewTickets,
  forwardableCookies,
  forwardedRequestHeaders,
  parsePreviewPath,
  returnedResponseHeaders,
  scanForAbsoluteAssets,
  scopeCookiePath,
} from './preview.js';

const servers: WebServer[] = [];
const upstreams: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  for (const server of upstreams.splice(0)) {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** What the upstream saw, so a test can assert what crossed the proxy. */
interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A dev server on a loopback port, answering whatever the test tells it to. */
async function upstream(
  answer: (req: IncomingMessage, res: ServerResponse, seen: Seen) => void,
  host = '127.0.0.1',
): Promise<{ port: number; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const record: Seen = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      seen.push(record);
      answer(req, res, record);
    });
  });
  upstreams.push(server);
  await new Promise<void>((resolve) => server.listen(0, host, () => resolve()));
  return { port: (server.address() as AddressInfo).port, seen, server };
}

/** A plugin with one preview, resolving to whatever port the test made. */
function pluginWith(resolve: (name: string) => Promise<{ port: number } | null>): PluginManifest {
  return {
    name: 'developer',
    version: '0.0.1',
    schema: 'developer',
    migrationsDir: '',
    tools: [
      {
        name: 'developer.preview',
        description: 'The link to a running process.',
        tier: 'auto',
        input: z.object({}),
        execute: async () => ({}),
      },
    ],
    previews: { resolve: (name) => resolve(name) },
  };
}

/** The clock, movable from inside a test so a ticket can be made to expire. */
interface Knobs {
  now: Date;
}

/** A dashboard with that plugin installed, and its preview listener. */
async function dashboard(
  manifest: PluginManifest | null,
  env: Record<string, string> = {},
  port = 0,
): Promise<WebServer & { knobs: Knobs; origin: string; previewOrigin: string }> {
  const registry = new ToolRegistry();
  if (manifest) registry.register(manifest);
  const knobs: Knobs = { now: new Date('2026-09-22T09:00:00Z') };
  const app = await startWebServer({
    pool: { query: async () => ({ rows: [] }) } as never,
    registry,
    catalog: { list: () => [] } as unknown as AgentCatalog,
    ctx: { ownerId: 'owner' } as ToolContext,
    timezone: 'UTC',
    now: () => knobs.now,
    config: { enabled: true, host: '127.0.0.1', port },
    token: 'fixture',
    env,
    log: () => {},
  });
  servers.push(app);
  return Object.assign(app, {
    knobs,
    origin: `http://127.0.0.1:${app.port}`,
    previewOrigin: `http://127.0.0.1:${app.previewPort}`,
  });
}

/** Ask the dashboard for a link, then spend it: what a browser would do. */
async function signIn(
  web: WebServer & { origin: string },
  plugin = 'developer',
  name = 'web',
): Promise<{ url: string; cookie: string }> {
  const answer = await fetch(`${web.origin}/api/preview/${plugin}/${name}/link`);
  expect(answer.status).toBe(200);
  const { url } = (await answer.json()) as { url: string };
  const exchanged = await fetch(url, { redirect: 'manual' });
  expect(exchanged.status).toBe(302);
  const cookie = exchanged.headers.getSetCookie()[0]?.split(';')[0] ?? '';
  expect(cookie.startsWith(`${PREVIEW_COOKIE}=`)).toBe(true);
  return { url, cookie };
}

/* ------------------------------------------------------------------ *
 * The pieces, on their own
 * ------------------------------------------------------------------ */

it('reads a preview route, and refuses anything that is not one', () => {
  expect(parsePreviewPath('/preview/developer/web/assets/app.js')).toEqual({
    plugin: 'developer',
    name: 'web',
    rest: '/assets/app.js',
    prefix: '/preview/developer/web',
  });
  // The app's root is forwarded as `/`, never redirected.
  expect(parsePreviewPath('/preview/developer/web')?.rest).toBe('/');
  expect(parsePreviewPath('/preview/developer/web/')?.rest).toBe('/');
  for (const bad of ['/preview', '/preview/developer', '/previews/a/b', '/api/preview/a/b/check']) {
    expect(parsePreviewPath(bad), bad).toBeNull();
  }
  // A segment is a plain name: nothing that could climb out of the prefix.
  expect(parsePreviewPath('/preview/../etc/passwd')).toBeNull();
});

it('scopes a cookie into the prefix, whatever path the app asked for', () => {
  expect(scopeCookiePath('sid=1; Path=/; HttpOnly', '/preview/developer/web')).toBe(
    'sid=1; Path=/preview/developer/web; HttpOnly',
  );
  expect(scopeCookiePath('sid=1; Path=/session', '/preview/developer/web')).toBe(
    'sid=1; Path=/preview/developer/web/session',
  );
  // An app that says nothing about a path would otherwise get the whole origin.
  expect(scopeCookiePath('sid=1', '/preview/developer/web')).toBe('sid=1; Path=/preview/developer/web');
});

it('keeps buddi`s own cookies on this side of the proxy, and passes the app`s', () => {
  expect(forwardableCookies('buddi_session=a; sid=b; buddi_csrf=c; buddi_preview=d')).toBe('sid=b');
  expect(forwardableCookies('buddi_session=a')).toBeUndefined();
  const headers = forwardedRequestHeaders(
    {
      cookie: 'buddi_session=secret; theirs=1',
      authorization: 'Bearer secret',
      'x-buddi-csrf': 'secret',
      // A `Connection` header nominates its own hop-by-hop fields; they go no
      // further than this hop either (RFC 9110 §7.6.1).
      connection: 'keep-alive, X-Private',
      'x-private': 'do not forward',
      'accept-language': 'en',
      host: 'localhost:4317',
    },
    '/preview/developer/web',
    '127.0.0.1:5173',
  );
  expect(headers).toEqual({
    'accept-language': 'en',
    cookie: 'theirs=1',
    host: '127.0.0.1:5173',
    'x-forwarded-prefix': '/preview/developer/web',
  });
});

it('drops an upstream cookie that is named after one of buddi`s', () => {
  const headers = returnedResponseHeaders(
    { 'set-cookie': ['buddi_session=junk; Path=/', 'theirs=1; Path=/'] },
    '/preview/developer/web',
    'http://127.0.0.1:4317',
  );
  expect(headers['set-cookie']).toEqual(['theirs=1; Path=/preview/developer/web']);
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['content-security-policy']).toBe('frame-ancestors http://127.0.0.1:4317');
  // An app that has an opinion about its own framing keeps it.
  expect(
    returnedResponseHeaders(
      { 'content-security-policy': "default-src 'self'" },
      '/preview/developer/web',
      'http://127.0.0.1:4317',
    )['content-security-policy'],
  ).toBe("default-src 'self'");
});

it('knows an app that assumes it owns the root of a host', () => {
  const prefix = '/preview/developer/web';
  expect(scanForAbsoluteAssets('<script src="/main.js"></script>', prefix)).toBe(true);
  expect(scanForAbsoluteAssets("<link href='/app.css'>", prefix)).toBe(true);
  expect(scanForAbsoluteAssets('<script src="/preview/developer/web/main.js">', prefix)).toBe(false);
  expect(scanForAbsoluteAssets('<script src="./main.js">', prefix)).toBe(false);
  // Another origin's asset is another problem, not a base-path one.
  expect(scanForAbsoluteAssets('<script src="//cdn.example/x.js">', prefix)).toBe(false);
});

/* ------------------------------------------------------------------ *
 * The two origins
 * ------------------------------------------------------------------ */

it('serves previews on a second port, and nothing else there', async () => {
  const app = await upstream((req, res) => res.end('hello'));
  const web = await dashboard(pluginWith(async () => ({ port: app.port })));
  expect(web.previewPort).toEqual(expect.any(Number));
  expect(web.previewPort).not.toBe(web.port);
  // No dashboard, no API, no assets: this origin has one job.
  for (const path of ['/api/session', '/', '/api/approvals', '/index.html']) {
    expect((await fetch(`${web.previewOrigin}${path}`)).status, path).toBe(404);
  }
});

it('mints no link for anyone the dashboard has not signed in', async () => {
  const web = await dashboard(pluginWith(async () => ({ port: 1024 })), { BUDDI_WEB_REQUIRE_AUTH: '1' });
  const res = await fetch(`${web.origin}/api/preview/developer/web/link`, { redirect: 'manual' });
  expect(res.status).toBe(401);
  expect(res.headers.get('location')).toBeNull();
  expect(await res.text()).toBe('');
});

it('takes the preview port from the environment when it is told one', async () => {
  // A port that was free a moment ago: opened, read, and closed again.
  const scratch = await upstream((req, res) => res.end());
  await new Promise<void>((resolve) => scratch.server.close(() => resolve()));
  const web = await dashboard(pluginWith(async () => ({ port: 1024 })), {
    BUDDI_PREVIEW_PORT: String(scratch.port),
  });
  expect(web.previewPort).toBe(scratch.port);
});

it('puts previews next door to the dashboard, and steps over a taken port', async () => {
  // A fixed dashboard port, so "plus one" means something. The port is taken
  // from the ephemeral range and released a moment before it is used, so the
  // assertions are on the *window* the policy searches rather than on one
  // number: another process on this machine may hold the next door, and
  // taking the one after it is the behaviour under test, not a failure.
  const scratch = await upstream((req, res) => res.end());
  const base = scratch.port;
  await new Promise<void>((resolve) => scratch.server.close(() => resolve()));

  const first = await dashboard(pluginWith(async () => ({ port: 1024 })), {}, base);
  expect(first.port).toBe(base);
  expect(first.previewPort).toBeGreaterThanOrEqual(base + 1);
  expect(first.previewPort).toBeLessThanOrEqual(base + PREVIEW_PORT_ATTEMPTS);

  // Now the door next to the next dashboard is occupied for certain.
  const blocker = createServer();
  upstreams.push(blocker);
  await new Promise<void>((resolve) => blocker.listen(base + 21, '127.0.0.1', () => resolve()));
  const second = await dashboard(pluginWith(async () => ({ port: 1024 })), {}, base + 20);
  expect(second.previewPort).not.toBe(base + 21);
  expect(second.previewPort).toBeGreaterThan(base + 21);
  expect(second.previewPort).toBeLessThanOrEqual(base + 20 + PREVIEW_PORT_ATTEMPTS);

  // And closing the dashboard gives the preview port back — `close` waits for
  // that listener too, or the next gateway up finds its own port taken.
  const taken = first.previewPort as number;
  await first.close();
  servers.splice(servers.indexOf(first), 1);
  const reclaim = createServer();
  upstreams.push(reclaim);
  await expect(
    new Promise<void>((resolve, reject) => {
      reclaim.once('error', reject);
      reclaim.listen(taken, '127.0.0.1', () => resolve());
    }),
  ).resolves.toBeUndefined();
});

it('publishes the port it bound, so a plugin does not have to guess it', async () => {
  const env: Record<string, string> = {};
  const web = await dashboard(pluginWith(async () => ({ port: 1024 })), env);
  // The developer plugin builds a `tailscale serve` target out of this. It
  // used to guess "the dashboard plus one", which is wrong whenever that port
  // was taken — and a fallback that nobody is told about is a route to
  // nothing.
  expect(env.BUDDI_PREVIEW_PORT).toBe(String(web.previewPort));

  // And this process's own publication is not read back as the owner asking
  // for that port: the next gateway binds its own.
  const second = await dashboard(pluginWith(async () => ({ port: 1024 })), env);
  expect(second.previewPort).not.toBe(web.previewPort);
  expect(env.BUDDI_PREVIEW_PORT).toBe(String(second.previewPort));
});

it('bounds what it is holding, and sweeps on every call', () => {
  let now = new Date('2026-09-22T09:00:00Z');
  const tickets = new PreviewTickets(() => now);
  const minted: string[] = [];
  for (let i = 0; i < MAX_LIVE_TICKETS + 10; i += 1) minted.push(tickets.mintTicket('developer', 'web'));
  expect(tickets.counts().tickets).toBe(MAX_LIVE_TICKETS);
  // The oldest went; the newest are all still good.
  expect(tickets.spendTicket(minted[0] as string, 'developer', 'web')).toBe(false);
  expect(tickets.spendTicket(minted[minted.length - 1] as string, 'developer', 'web')).toBe(true);

  const cookies: string[] = [];
  for (let i = 0; i < MAX_LIVE_COOKIES + 5; i += 1) cookies.push(tickets.mintCookie('developer', 'web'));
  expect(tickets.counts().cookies).toBe(MAX_LIVE_COOKIES);
  expect(tickets.holds(cookies[0] as string, 'developer', 'web')).toBe(false);
  expect(tickets.holds(cookies[cookies.length - 1] as string, 'developer', 'web')).toBe(true);

  // And time alone empties it, with nothing minted to trigger the sweep.
  now = new Date(now.getTime() + PREVIEW_TICKET_TTL_MS + 1000);
  expect(tickets.counts().tickets).toBe(0);
});

it('holds one session to ten preview links a minute', async () => {
  const web = await dashboard(pluginWith(async () => ({ port: 1024 })));
  const session = await fetch(`${web.origin}/api/session`);
  const cookie = session.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const ask = (): Promise<number> =>
    fetch(`${web.origin}/api/preview/developer/web/link`, { headers: { Cookie: cookie } }).then((r) => r.status);
  for (let i = 0; i < 10; i += 1) expect(await ask()).toBe(200);
  expect(await ask()).toBe(429);
  // The window passes and the owner is not locked out of their own dashboard.
  web.knobs.now = new Date(web.knobs.now.getTime() + 61_000);
  expect(await ask()).toBe(200);
});

it('lets the dashboard mint a link, and the link buy a cookie', async () => {
  const app = await upstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>hello</body></html>');
  });
  const web = await dashboard(pluginWith(async (name) => (name === 'web' ? { port: app.port } : null)));

  const answer = await fetch(`${web.origin}/api/preview/developer/web/link`);
  const { url } = (await answer.json()) as { url: string };
  expect(url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${web.previewPort}/preview/developer/web/\\?ticket=[0-9a-f]{64}$`));

  // Spending it sets the cookie and sends the browser to the clean path.
  const exchanged = await fetch(url, { redirect: 'manual' });
  expect(exchanged.status).toBe(302);
  expect(exchanged.headers.get('location')).toBe('/preview/developer/web/');
  const set = exchanged.headers.getSetCookie()[0] ?? '';
  expect(set).toMatch(/^buddi_preview=[0-9a-f]{64}/);
  expect(set).toContain('HttpOnly');
  // Strict, like every cookie buddi sets. The dashboard-to-preview navigation
  // is same-site — `SameSite` ignores the port — so it still travels.
  expect(set).toContain('SameSite=Strict');
  expect(set).toContain('Path=/preview/developer/web');

  const cookie = set.split(';')[0] as string;
  const served = await fetch(`${web.previewOrigin}/preview/developer/web/`, { headers: { Cookie: cookie } });
  expect(served.status).toBe(200);
  expect(await served.text()).toBe('<html><body>hello</body></html>');
});

it('serves a link whose ticket is spent, to a browser that already has the cookie', async () => {
  // This is "Open in a tab" from a frame that has been sitting there for an
  // hour, and a bookmark, and a restored tab: the URL's ticket went the
  // moment the frame first loaded it, and the cookie is what answers now.
  const app = await upstream((req, res) => res.end('ok'));
  const web = await dashboard(pluginWith(async () => ({ port: app.port })));
  const { url, cookie } = await signIn(web);

  const again = await fetch(url, { redirect: 'manual', headers: { Cookie: cookie } });
  expect(again.status).toBe(302);
  expect(again.headers.get('location')).toBe('/preview/developer/web/');
  // Nothing new was minted: the cookie it is already holding is the answer.
  expect(again.headers.getSetCookie()).toEqual([]);

  // And the same spent ticket without the cookie is still one bit of nothing.
  expect((await fetch(url, { redirect: 'manual' })).status).toBe(401);
});

it('refuses a ticket that is used twice, expired, or for another preview', async () => {
  const app = await upstream((req, res) => res.end('ok'));
  const web = await dashboard(pluginWith(async () => ({ port: app.port })));

  const { url } = await signIn(web);
  // Single use: the second attempt is the same bit as a made-up one.
  expect((await fetch(url, { redirect: 'manual' })).status).toBe(401);

  const second = (await (await fetch(`${web.origin}/api/preview/developer/web/link`)).json()) as { url: string };
  web.knobs.now = new Date(web.knobs.now.getTime() + PREVIEW_TICKET_TTL_MS + 1000);
  expect((await fetch(second.url, { redirect: 'manual' })).status).toBe(401);

  web.knobs.now = new Date('2026-09-22T09:00:00Z');
  const third = (await (await fetch(`${web.origin}/api/preview/developer/other/link`)).json()) as { url: string };
  const ticket = new URL(third.url).searchParams.get('ticket');
  // A ticket names the preview it was minted for; it is not a key to another.
  const elsewhere = await fetch(`${web.previewOrigin}/preview/developer/web/?ticket=${ticket}`, { redirect: 'manual' });
  expect(elsewhere.status).toBe(401);
});

it('needs its own cookie, and never accepts the dashboard`s', async () => {
  const app = await upstream((req, res) => res.end('ok'));
  const web = await dashboard(pluginWith(async () => ({ port: app.port })));

  // Nothing at all — which is also what a request from another site looks
  // like, because the cookie is `SameSite=Strict` and a browser would not
  // have attached it to one.
  const bare = await fetch(`${web.previewOrigin}/preview/developer/web/`, { redirect: 'manual' });
  expect(bare.status).toBe(401);
  expect(bare.headers.get('location')).toBeNull();
  expect(app.seen).toHaveLength(0);

  // The dashboard's session cookie, which a browser really does send to this
  // port — cookies do not distinguish them. It buys nothing here.
  const session = await fetch(`${web.origin}/api/session`);
  const dashboardCookies = session.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  expect(dashboardCookies).toContain('buddi_session=');
  expect(
    (await fetch(`${web.previewOrigin}/preview/developer/web/`, { headers: { Cookie: dashboardCookies } })).status,
  ).toBe(401);
  expect(app.seen).toHaveLength(0);

  // A cookie for another preview is not a cookie for this one.
  const { cookie } = await signIn(web, 'developer', 'other');
  expect(
    (await fetch(`${web.previewOrigin}/preview/developer/web/`, { headers: { Cookie: cookie } })).status,
  ).toBe(401);
});

it('never lets the preview origin write to the dashboard', async () => {
  const web = await dashboard(pluginWith(async () => ({ port: 1 })));
  // The framed app's origin is not an origin this dashboard accepts a write
  // from. This is the assertion that the two really are separate.
  const res = await fetch(`${web.origin}/api/chat/x/messages`, {
    method: 'POST',
    headers: { Origin: web.previewOrigin, 'Content-Type': 'application/json' },
    body: '{"text":"hi"}',
  });
  expect(res.status).toBe(403);
});

it('forwards a write with its body, and scopes the cookie it sets', async () => {
  const app = await upstream((req, res) => {
    res.writeHead(201, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=1; Path=/' });
    res.end('{"saved":true}');
  });
  const web = await dashboard(pluginWith(async () => ({ port: app.port })));
  const { cookie } = await signIn(web);
  const res = await fetch(`${web.previewOrigin}/preview/developer/web/save?q=1`, {
    method: 'POST',
    headers: { Cookie: `${cookie}; theirs=2`, 'Content-Type': 'application/json' },
    body: '{"n":1}',
  });
  expect(res.status).toBe(201);
  expect(await res.text()).toBe('{"saved":true}');
  expect(app.seen[0]).toMatchObject({ method: 'POST', url: '/save?q=1', body: '{"n":1}' });
  // The app's own cookie crossed; the preview's credential did not.
  expect(app.seen[0]?.headers.cookie).toBe('theirs=2');
  expect(app.seen[0]?.headers['x-forwarded-prefix']).toBe('/preview/developer/web');
  expect(res.headers.getSetCookie()).toEqual(['sid=1; Path=/preview/developer/web']);
  expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  expect(res.headers.get('content-security-policy')).toContain('frame-ancestors');
  expect(res.headers.get('cache-control')).toBe('no-store');
});

it('serves a root-relative asset to the preview the cookie names, and to nobody else', async () => {
  const app = await upstream((req, res) => {
    if (req.url === '/assets/app.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return res.end('console.log(1)');
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><script src="/assets/app.js"></script></head><body>hi</body></html>');
  });
  const web = await dashboard(pluginWith(async () => ({ port: app.port })));
  const { cookie } = await signIn(web);
  // The page, under its prefix, as the frame loads it.
  expect((await fetch(`${web.previewOrigin}/preview/developer/web/`, { headers: { Cookie: cookie } })).status).toBe(200);
  // What the browser then asks for, by the root, with the same cookie.
  const asset = await fetch(`${web.previewOrigin}/assets/app.js`, { headers: { Cookie: cookie } });
  expect(asset.status).toBe(200);
  expect(await asset.text()).toBe('console.log(1)');
  expect(app.seen.at(-1)?.url).toBe('/assets/app.js');
  // No cookie, no preview to route to: the origin is as empty as before.
  expect((await fetch(`${web.previewOrigin}/assets/app.js`)).status).toBe(404);
  expect((await fetch(`${web.previewOrigin}/`)).status).toBe(404);
});

it('is 404 for a name nobody serves, and for a plugin with no previews', async () => {
  const web = await dashboard(pluginWith(async (name) => (name === 'web' ? { port: 1 } : null)));
  const { cookie } = await signIn(web, 'developer', 'gone');
  expect((await fetch(`${web.previewOrigin}/preview/developer/gone/`, { headers: { Cookie: cookie } })).status).toBe(404);
  // A plugin this installation does not have has no link to mint at all.
  expect((await fetch(`${web.origin}/api/preview/finance/web/link`)).status).toBe(404);
  const plain = await dashboard(null);
  expect((await fetch(`${plain.origin}/api/preview/developer/web/link`)).status).toBe(404);
});

it('refuses a port that is this gateway`s own, so a preview cannot loop', async () => {
  const web = await dashboard(pluginWith(async () => ({ port: 0 })));
  // Resolve to the preview listener itself: proxying it would recurse until
  // the process ran out of sockets.
  const looping = await dashboard(pluginWith(async () => ({ port: web.previewPort as number })));
  const { cookie } = await signIn(looping);
  // Also refused: a privileged port, and Postgres.
  for (const port of [80, 5432]) {
    const other = await dashboard(pluginWith(async () => ({ port })));
    const signed = await signIn(other);
    expect(
      (await fetch(`${other.previewOrigin}/preview/developer/web/`, { headers: { Cookie: signed.cookie } })).status,
      String(port),
    ).toBe(404);
  }
  expect(
    (await fetch(`${looping.previewOrigin}/preview/developer/web/`, { headers: { Cookie: cookie } })).status,
  ).toBe(404);
});

it('is 502, in one sentence, when the port refuses', async () => {
  // A port nothing is listening on: the upstream is started and stopped.
  const dead = await upstream((req, res) => res.end('ok'));
  await new Promise<void>((resolve) => dead.server.close(() => resolve()));
  const web = await dashboard(pluginWith(async () => ({ port: dead.port })));
  const { cookie } = await signIn(web);
  const res = await fetch(`${web.previewOrigin}/preview/developer/web/`, { headers: { Cookie: cookie } });
  expect(res.status).toBe(502);
  expect((await res.json()) as { error: string }).toEqual({
    error: 'That preview is not answering: the process behind it may have stopped.',
  });
});

it('reaches an app that bound the IPv6 loopback alone, as Vite does for `localhost`', async () => {
  const app = await upstream((_req, res) => res.end('six'), '::1');
  const web = await dashboard(pluginWith(async () => ({ port: app.port })));
  const link = await fetch(`${web.origin}/api/preview/developer/web/link`);
  const exchanged = await fetch(((await link.json()) as { url: string }).url, { redirect: 'manual' });
  const cookie = exchanged.headers.getSetCookie()[0]?.split(';')[0] ?? '';
  const res = await fetch(`${web.previewOrigin}/preview/developer/web/`, { headers: { Cookie: cookie } });
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('six');
});

it('tells the plugin when the app assumes it owns the root of a host', async () => {
  const app = await upstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><script src="/main.js"></script></head><body>hi</body></html>');
  });
  const web = await dashboard(pluginWith(async () => ({ port: app.port })));
  const before = await fetch(`${web.origin}/api/preview/developer/web/check`);
  expect(await before.json()).toEqual({ ok: true, absoluteAssets: false });

  const { cookie } = await signIn(web);
  const served = await fetch(`${web.previewOrigin}/preview/developer/web/`, { headers: { Cookie: cookie } });
  // Whatever the scan concluded, the browser gets the page unchanged.
  expect(await served.text()).toBe(
    '<html><head><script src="/main.js"></script></head><body>hi</body></html>',
  );
  const after = await fetch(`${web.origin}/api/preview/developer/web/check`);
  expect(await after.json()).toEqual({ ok: true, absoluteAssets: true });
});

it('says an app is fine when its assets are relative to the prefix, and says nothing about one that is not there', async () => {
  const app = await upstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><script src="/preview/developer/web/main.js"></script></html>');
  });
  const web = await dashboard(pluginWith(async (name) => (name === 'web' ? { port: app.port } : null)));
  const { cookie } = await signIn(web);
  await fetch(`${web.previewOrigin}/preview/developer/web/`, { headers: { Cookie: cookie } });
  expect(await (await fetch(`${web.origin}/api/preview/developer/web/check`)).json()).toEqual({
    ok: true,
    absoluteAssets: false,
  });
  // `ok` is a real question: nobody is serving this one.
  expect(await (await fetch(`${web.origin}/api/preview/developer/gone/check`)).json()).toEqual({
    ok: false,
    absoluteAssets: false,
  });
});

it('proxies the websocket hot reload lives on, and refuses one with no cookie', async () => {
  const server = createServer();
  upstreams.push(server);
  const wss = new WebSocketServer({ server });
  let sawPrefix: string | undefined;
  wss.on('connection', (socket, req) => {
    sawPrefix = req.headers['x-forwarded-prefix'] as string | undefined;
    socket.on('message', (data) => socket.send(`echo:${String(data)}`));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  const web = await dashboard(pluginWith(async () => ({ port })));

  const refused = new WebSocket(`ws://127.0.0.1:${web.previewPort}/preview/developer/web/hmr`);
  expect((await new Promise<Error>((resolve) => refused.on('error', resolve))).message).toMatch(/401/);

  const { cookie } = await signIn(web);
  const client = new WebSocket(`ws://127.0.0.1:${web.previewPort}/preview/developer/web/hmr`, {
    headers: { Cookie: cookie },
  });
  const echoed = await new Promise<string>((resolve, reject) => {
    client.on('open', () => client.send('reload'));
    client.on('message', (data) => resolve(String(data)));
    client.on('error', reject);
  });
  expect(echoed).toBe('echo:reload');
  expect(sawPrefix).toBe('/preview/developer/web');
  client.close();
  wss.close();
});
