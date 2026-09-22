/**
 * `/preview/<plugin>/<name>/…`, over the wire.
 *
 * Everything here goes through a real gateway to a real http server on a
 * loopback port, because every property that matters is a property of the
 * bytes: which headers went up, which came back, what a browser would be
 * handed, and what somebody who is not signed in gets. A fake proxy would
 * assert the shape of a function call instead, which is the part that was
 * never in doubt.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ToolRegistry, type AgentCatalog, type PluginManifest, type ToolContext } from '@buddi/core';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { startWebServer, type WebServer } from './server.js';
import {
  forwardedRequestHeaders,
  parsePreviewPath,
  resetPreviewScan,
  scanForAbsoluteAssets,
  scopeCookiePath,
} from './preview.js';

const servers: WebServer[] = [];
const upstreams: Server[] = [];

beforeEach(() => resetPreviewScan());
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
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
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

/** A dashboard with that plugin installed. */
async function dashboard(
  manifest: PluginManifest | null,
  env: Record<string, string> = {},
): Promise<WebServer> {
  const registry = new ToolRegistry();
  if (manifest) registry.register(manifest);
  const app = await startWebServer({
    pool: { query: async () => ({ rows: [] }) } as never,
    registry,
    catalog: { list: () => [] } as unknown as AgentCatalog,
    ctx: { ownerId: 'owner' } as ToolContext,
    timezone: 'UTC',
    now: () => new Date('2026-09-22T09:00:00Z'),
    config: { enabled: true, host: '127.0.0.1', port: 0 },
    token: 'fixture',
    env,
    log: () => {},
  });
  servers.push(app);
  return app;
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
  // An app that says nothing about a path would otherwise get the dashboard's.
  expect(scopeCookiePath('sid=1', '/preview/developer/web')).toBe('sid=1; Path=/preview/developer/web');
});

it('keeps the owner`s credentials on this side of the proxy', () => {
  const headers = forwardedRequestHeaders(
    {
      cookie: 'buddi_session=secret',
      authorization: 'Bearer secret',
      'x-buddi-csrf': 'secret',
      connection: 'keep-alive',
      'accept-language': 'en',
      host: 'localhost:4317',
    },
    '/preview/developer/web',
    '127.0.0.1:5173',
  );
  expect(headers).toEqual({
    'accept-language': 'en',
    host: '127.0.0.1:5173',
    'x-forwarded-prefix': '/preview/developer/web',
  });
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
 * Through the gateway
 * ------------------------------------------------------------------ */

it('serves the app, and tells it where it is mounted', async () => {
  const app = await upstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>hello</body></html>');
  });
  const web = await dashboard(pluginWith(async (name) => (name === 'web' ? { port: app.port } : null)));
  const res = await fetch(`http://127.0.0.1:${web.port}/preview/developer/web/index.html?q=1`);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe('<html><body>hello</body></html>');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(app.seen[0]?.url).toBe('/index.html?q=1');
  expect(app.seen[0]?.headers['x-forwarded-prefix']).toBe('/preview/developer/web');
  // The session cookie the browser sent never reaches the dev server.
  expect(app.seen[0]?.headers.cookie).toBeUndefined();
});

it('forwards a write with its body, and scopes the cookie it sets', async () => {
  const app = await upstream((req, res) => {
    res.writeHead(201, { 'Content-Type': 'application/json', 'Set-Cookie': 'sid=1; Path=/' });
    res.end('{"saved":true}');
  });
  const web = await dashboard(pluginWith(async () => ({ port: app.port })));
  const origin = `http://127.0.0.1:${web.port}`;
  const res = await fetch(`${origin}/preview/developer/web/save`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: '{"n":1}',
  });
  expect(res.status).toBe(201);
  expect(await res.text()).toBe('{"saved":true}');
  expect(app.seen[0]).toMatchObject({ method: 'POST', url: '/save', body: '{"n":1}' });
  expect(res.headers.getSetCookie()).toEqual(['sid=1; Path=/preview/developer/web']);
});

it('refuses a write another site started, without asking the app', async () => {
  const app = await upstream((req, res) => res.end('ok'));
  const web = await dashboard(pluginWith(async () => ({ port: app.port })));
  const res = await fetch(`http://127.0.0.1:${web.port}/preview/developer/web/save`, {
    method: 'POST',
    headers: { Origin: 'https://evil.example' },
    body: 'x',
  });
  expect(res.status).toBe(403);
  expect(app.seen).toHaveLength(0);
});

it('answers 401, and not a redirect, when nobody is signed in', async () => {
  const app = await upstream((req, res) => res.end('ok'));
  const web = await dashboard(pluginWith(async () => ({ port: app.port })), {
    BUDDI_WEB_REQUIRE_AUTH: '1',
  });
  const res = await fetch(`http://127.0.0.1:${web.port}/preview/developer/web/`, { redirect: 'manual' });
  expect(res.status).toBe(401);
  expect(res.headers.get('location')).toBeNull();
  expect(await res.text()).toBe('');
  // And the app was never asked whether that name exists.
  expect(app.seen).toHaveLength(0);
});

it('is 404 for a name nobody serves, and for a plugin with no previews', async () => {
  const web = await dashboard(pluginWith(async (name) => (name === 'web' ? { port: 1 } : null)));
  expect((await fetch(`http://127.0.0.1:${web.port}/preview/developer/gone/`)).status).toBe(404);
  expect((await fetch(`http://127.0.0.1:${web.port}/preview/finance/web/`)).status).toBe(404);
  const plain = await dashboard(null);
  expect((await fetch(`http://127.0.0.1:${plain.port}/preview/developer/web/`)).status).toBe(404);
});

it('is 502, in one sentence, when the port refuses', async () => {
  // A port nothing is listening on: the upstream is started and stopped.
  const dead = await upstream((req, res) => res.end('ok'));
  await new Promise<void>((resolve) => dead.server.close(() => resolve()));
  const web = await dashboard(pluginWith(async () => ({ port: dead.port })));
  const res = await fetch(`http://127.0.0.1:${web.port}/preview/developer/web/`);
  expect(res.status).toBe(502);
  expect((await res.json()) as { error: string }).toEqual({
    error: 'That preview is not answering: the process behind it may have stopped.',
  });
});

it('tells the plugin when the app assumes it owns the root of a host', async () => {
  const app = await upstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html><head><script src="/main.js"></script></head><body>hi</body></html>');
  });
  const web = await dashboard(pluginWith(async () => ({ port: app.port })));
  const before = await fetch(`http://127.0.0.1:${web.port}/api/preview/developer/web/check`);
  expect(await before.json()).toEqual({ ok: true, absoluteAssets: false });

  const served = await fetch(`http://127.0.0.1:${web.port}/preview/developer/web/`);
  // Whatever the scan concluded, the browser gets the page unchanged.
  expect(await served.text()).toBe(
    '<html><head><script src="/main.js"></script></head><body>hi</body></html>',
  );
  const after = await fetch(`http://127.0.0.1:${web.port}/api/preview/developer/web/check`);
  expect(await after.json()).toEqual({ ok: true, absoluteAssets: true });
});

it('says an app is fine when its assets are relative to the prefix', async () => {
  const app = await upstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><script src="/preview/developer/web/main.js"></script></html>');
  });
  const web = await dashboard(pluginWith(async () => ({ port: app.port })));
  await fetch(`http://127.0.0.1:${web.port}/preview/developer/web/`);
  const check = await fetch(`http://127.0.0.1:${web.port}/api/preview/developer/web/check`);
  expect(await check.json()).toEqual({ ok: true, absoluteAssets: false });
});

it('proxies the websocket hot reload lives on', async () => {
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

  const client = new WebSocket(`ws://127.0.0.1:${web.port}/preview/developer/web/hmr`);
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

it('refuses a websocket to a preview nobody is signed in to', async () => {
  const web = await dashboard(pluginWith(async () => ({ port: 1 })), {
    BUDDI_WEB_REQUIRE_AUTH: '1',
  });
  const client = new WebSocket(`ws://127.0.0.1:${web.port}/preview/developer/web/hmr`);
  const failure = await new Promise<Error>((resolve) => client.on('error', resolve));
  expect(failure.message).toMatch(/401/);
});
