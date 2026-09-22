/**
 * `/preview/<plugin>/<name>/…` — a plugin's own loopback process, served
 * behind the dashboard's sign-in.
 *
 * A developer agent starts a dev server; it listens on 127.0.0.1 and nobody
 * but that machine can reach it. This is the one door: the gateway asks the
 * plugin which port stands behind a name, and forwards. The gate is the
 * dashboard's own and nothing more — a signed-in session cookie or a Tailscale
 * identity — which is decided by the caller in `server.ts` before anything
 * here is reached. So a device that is signed in to the dashboard sees the
 * app, and anything else gets the dashboard's empty 401. Never a redirect:
 * a 302 to a sign-in page would tell an anonymous caller that this exact
 * preview exists, which is the one thing the 401 is careful not to say.
 *
 * What is forwarded, and what is not:
 *
 *  - **Up**: the method, the path below the prefix, the query, the body and
 *    every header except `cookie`, `authorization` and the hop-by-hop ones.
 *    The owner's session must not reach somebody's dev server — it is the
 *    credential for this whole installation, and the app behind the proxy is
 *    code that was written twenty seconds ago.
 *  - **Down**: the status, the body byte for byte, and the headers. Nothing in
 *    the body is rewritten: an HTML rewriter that is wrong is worse than an
 *    app that is plainly broken, and §12 of the developer spec says what is
 *    done instead — the app is *told* that it assumes the root of a host.
 *  - `x-forwarded-prefix: /preview/<plugin>/<name>` goes up, which is what a
 *    framework that can be told its base path reads.
 *  - `Set-Cookie` comes back with its `Path` scoped into the prefix, so two
 *    previews cannot overwrite each other's cookies, and neither can overwrite
 *    the dashboard's.
 *
 * Nothing is buffered but the first 64 KB of the first response, and that only
 * to look at: see `scanForAbsoluteAssets`.
 */
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { connect, type Socket } from 'node:net';
import type { PreviewProvider, ToolContext, ToolRegistry } from '@buddi/core';

/** The route's own prefix. Everything below is the app's. */
export const PREVIEW_PREFIX = '/preview';

/** Where the check route answers, for `developer.preview`'s warning. */
export const PREVIEW_CHECK_PREFIX = '/api/preview';

/**
 * How much of a first response is scanned for absolute asset references.
 *
 * The head of an HTML document is where `<script src="/…">` lives, and 64 KB
 * of it is a great deal of head. Beyond that the scan stops and the answer is
 * whatever it found: this is a warning for the owner, not a security check,
 * and it costs one pass over bytes that were being streamed anyway.
 */
export const SCAN_BYTES = 64 * 1024;

/** Headers that belong to one hop and must never be forwarded to the next. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/** Headers this proxy strips on the way *up*, beyond the hop-by-hop ones. */
const NEVER_FORWARDED = new Set(['cookie', 'authorization', 'host', 'x-buddi-csrf']);

/** `/preview/<plugin>/<name>/<rest>`, as the route reads it. */
export interface PreviewTarget {
  plugin: string;
  name: string;
  /** The path the app sees, always starting with `/`. */
  rest: string;
  /** `/preview/<plugin>/<name>` — what goes in `x-forwarded-prefix`. */
  prefix: string;
}

/** A plugin and a process name are both one path segment of plain characters. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * Read a preview route, or null when the path is not one.
 *
 * `/preview/<plugin>/<name>` with nothing after it is the app's root: it is
 * forwarded as `/`, not redirected. This proxy never issues a redirect of its
 * own — the app's own redirects come back untouched, and the one thing an
 * unauthenticated caller gets is the dashboard's empty 401.
 */
export function parsePreviewPath(pathname: string): PreviewTarget | null {
  if (pathname !== PREVIEW_PREFIX && !pathname.startsWith(`${PREVIEW_PREFIX}/`)) return null;
  const segments = pathname.slice(PREVIEW_PREFIX.length + 1).split('/');
  const [plugin, name] = segments;
  if (!plugin || !name || !SEGMENT.test(plugin) || !SEGMENT.test(name)) return null;
  const rest = segments.slice(2).join('/');
  return {
    plugin,
    name,
    rest: `/${rest}`,
    prefix: `${PREVIEW_PREFIX}/${plugin}/${name}`,
  };
}

/** The same shape, for `GET /api/preview/<plugin>/<name>/check`. */
export function parsePreviewCheckPath(pathname: string): { plugin: string; name: string } | null {
  const match = /^\/api\/preview\/([^/]+)\/([^/]+)\/check$/.exec(pathname);
  if (!match) return null;
  const [, plugin, name] = match;
  if (!plugin || !name || !SEGMENT.test(plugin) || !SEGMENT.test(name)) return null;
  return { plugin, name };
}

/**
 * What the first response of each preview told us about itself.
 *
 * One boolean per `<plugin>/<name>`, set by the scan and read by the check
 * route. It is deliberately not per session or per request: the question is
 * "does this app assume it owns the root of a host", which is a property of
 * the app, and the owner asks it once through `developer.preview`.
 */
const ABSOLUTE_ASSETS = new Map<string, boolean>();

/** `src="/…"` or `href="/…"` that does not start with this preview's prefix. */
export function scanForAbsoluteAssets(html: string, prefix: string): boolean {
  const pattern = /\b(?:src|href)\s*=\s*"(\/[^"]*)"|\b(?:src|href)\s*=\s*'(\/[^']*)'/g;
  for (const match of html.matchAll(pattern)) {
    const url = match[1] ?? match[2] ?? '';
    // `//host/…` is another origin's problem, not a base-path problem.
    if (url.startsWith('//')) continue;
    if (url === prefix || url.startsWith(`${prefix}/`)) continue;
    return true;
  }
  return false;
}

/**
 * What the check route answers. `absoluteAssets` is false until a first HTML
 * response has been scanned, which is the honest reading: nothing has been
 * seen to assume the root of a host.
 */
export function previewCheck(plugin: string, name: string): { ok: boolean; absoluteAssets: boolean } {
  return { ok: true, absoluteAssets: ABSOLUTE_ASSETS.get(`${plugin}/${name}`) === true };
}

/** Test seam: forget what the scan has learned. */
export function resetPreviewScan(): void {
  ABSOLUTE_ASSETS.clear();
}

export interface PreviewDeps {
  registry: Pick<ToolRegistry, 'previews'>;
  ctx: ToolContext;
  log: (line: string) => void;
}

/** The provider for this plugin, or undefined when it ships none. */
function providerFor(deps: PreviewDeps, plugin: string): PreviewProvider | undefined {
  return deps.registry.previews(plugin);
}

/**
 * Where a preview lives right now, or null.
 *
 * Asked on every request. A plugin's `resolve` that throws is a plugin whose
 * answer we do not have, which is a 404 and a line in the log — never a guess
 * at a port.
 */
async function resolvePort(
  deps: PreviewDeps,
  target: { plugin: string; name: string },
): Promise<{ port: number; host: string } | null> {
  const provider = providerFor(deps, target.plugin);
  if (!provider) return null;
  let resolved: { port: number; host?: string } | null;
  try {
    resolved = await provider.resolve(target.name, deps.ctx);
  } catch (err) {
    deps.log(`preview: ${target.plugin}/${target.name} could not be resolved: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!resolved || !Number.isInteger(resolved.port) || resolved.port < 1 || resolved.port > 65535) return null;
  // Loopback, whatever the plugin says. A preview is a process on this machine;
  // a port on some other host is a request this gateway is not going to make.
  return { port: resolved.port, host: '127.0.0.1' };
}

/** The headers that go up: everything but the owner's credentials and the hop. */
export function forwardedRequestHeaders(headers: IncomingHttpHeaders, prefix: string, host: string): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || NEVER_FORWARDED.has(lower)) continue;
    if (value !== undefined) out[lower] = value;
  }
  out.host = host;
  out['x-forwarded-prefix'] = prefix;
  return out;
}

/**
 * The response headers that come back: the app's, minus the hop-by-hop ones,
 * with every `Set-Cookie` path scoped into the preview's prefix.
 */
export function returnedResponseHeaders(headers: IncomingHttpHeaders, prefix: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower) || value === undefined) continue;
    if (lower === 'set-cookie') {
      const cookies = Array.isArray(value) ? value : [value];
      out['set-cookie'] = cookies.map((cookie) => scopeCookiePath(cookie, prefix));
      continue;
    }
    out[lower] = value;
  }
  // A preview is whatever the process is serving this second.
  out['cache-control'] = 'no-store';
  return out;
}

/**
 * Rewrite one `Set-Cookie`'s `Path` so it lives under the preview's prefix.
 *
 * An app that sets `Path=/` would otherwise set a cookie for the whole
 * dashboard, and the next preview would read it. The app's own path is kept
 * below the prefix, so `Path=/session` becomes `Path=/preview/x/y/session`.
 */
export function scopeCookiePath(cookie: string, prefix: string): string {
  const parts = cookie.split(';');
  let seen = false;
  const rewritten = parts.map((part) => {
    const match = /^(\s*)path\s*=\s*(.*)$/i.exec(part);
    if (!match) return part;
    seen = true;
    const value = (match[2] ?? '').trim();
    const suffix = value === '/' || value === '' ? '' : value.startsWith('/') ? value : `/${value}`;
    return `${match[1] ?? ''}Path=${prefix}${suffix}`;
  });
  if (!seen) rewritten.push(` Path=${prefix}`);
  return rewritten.join(';');
}

/** The one sentence a refused port gets. Never the error's own words. */
export const PREVIEW_UNREACHABLE = 'That preview is not answering: the process behind it may have stopped.';

/**
 * Proxy one request. The caller has already established the session.
 *
 * Returns nothing: every path here ends with the response ended.
 */
export async function proxyPreview(
  deps: PreviewDeps,
  target: PreviewTarget,
  req: IncomingMessage,
  res: ServerResponse,
  search: string,
): Promise<void> {
  const upstream = await resolvePort(deps, target);
  if (!upstream) return notFound(res);

  await new Promise<void>((resolve) => {
    const host = `127.0.0.1:${upstream.port}`;
    const proxied = httpRequest(
      {
        host: upstream.host,
        port: upstream.port,
        method: req.method ?? 'GET',
        path: `${target.rest}${search}`,
        headers: forwardedRequestHeaders(req.headers, target.prefix, host),
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, returnedResponseHeaders(upstreamRes.headers, target.prefix));
        const scan = shouldScan(target, upstreamRes.headers['content-type']);
        if (!scan) {
          upstreamRes.pipe(res);
          upstreamRes.on('end', () => resolve());
          upstreamRes.on('error', () => { res.end(); resolve(); });
          return;
        }
        /*
         * The scan. Bytes are written on as they arrive — nothing is held —
         * and a copy of the first 64 KB is kept only long enough to look for
         * `src="/…"`. What it finds is a warning the plugin can ask for; it
         * changes nothing about what the browser receives.
         */
        let scanned = 0;
        let head = '';
        let decided = false;
        upstreamRes.on('data', (chunk: Buffer) => {
          if (!decided && scanned < SCAN_BYTES) {
            head += chunk.subarray(0, SCAN_BYTES - scanned).toString('utf8');
            scanned += chunk.length;
            if (scanForAbsoluteAssets(head, target.prefix)) {
              ABSOLUTE_ASSETS.set(`${target.plugin}/${target.name}`, true);
              decided = true;
              head = '';
            }
          }
          res.write(chunk);
        });
        upstreamRes.on('end', () => {
          if (!decided) ABSOLUTE_ASSETS.set(`${target.plugin}/${target.name}`, false);
          res.end();
          resolve();
        });
        upstreamRes.on('error', () => { res.end(); resolve(); });
      },
    );
    proxied.on('error', (err) => {
      deps.log(`preview: ${target.prefix} could not be reached: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        const body = JSON.stringify({ error: PREVIEW_UNREACHABLE });
        res.writeHead(502, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        res.end(body);
      } else res.end();
      resolve();
    });
    req.pipe(proxied);
    req.on('error', () => proxied.destroy());
  });
}

/** Only the first HTML response of a preview is worth scanning. */
function shouldScan(target: PreviewTarget, contentType: string | string[] | undefined): boolean {
  if (ABSOLUTE_ASSETS.has(`${target.plugin}/${target.name}`)) return false;
  const type = Array.isArray(contentType) ? contentType[0] : contentType;
  return typeof type === 'string' && type.toLowerCase().includes('text/html');
}

function notFound(res: ServerResponse): void {
  const body = JSON.stringify({ error: 'no such preview' });
  res.writeHead(404, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/**
 * A websocket upgrade under `/preview/…`, tunnelled to the same port.
 *
 * Hot reload is the reason this exists: a dev server that cannot tell the page
 * a file changed is a dev server the owner will stop using. The gate is the
 * caller's — `authorize` returns false and the socket is answered 401 and
 * destroyed, exactly as an unauthenticated request would be.
 */
export async function upgradePreview(
  deps: PreviewDeps,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  authorize: (req: IncomingMessage) => Promise<boolean>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://buddi.invalid');
  const target = parsePreviewPath(url.pathname);
  if (!target) return refuse(socket, 404, 'Not Found');
  if (!(await authorize(req))) return refuse(socket, 401, 'Unauthorized');
  const upstream = await resolvePort(deps, target);
  if (!upstream) return refuse(socket, 404, 'Not Found');

  const host = `127.0.0.1:${upstream.port}`;
  const headers = forwardedRequestHeaders(req.headers, target.prefix, host);
  // The upgrade headers are the point of the request, so they survive the
  // hop-by-hop strip — this hop *is* the upgrade.
  headers.connection = req.headers.connection ?? 'Upgrade';
  headers.upgrade = req.headers.upgrade ?? 'websocket';
  const lines = Object.entries(headers)
    .flatMap(([key, value]) => (Array.isArray(value) ? value.map((v) => `${key}: ${v}`) : [`${key}: ${String(value)}`]))
    .join('\r\n');

  const up: Socket = connect(upstream.port, upstream.host, () => {
    up.write(`${req.method ?? 'GET'} ${target.rest}${url.search} HTTP/1.1\r\n${lines}\r\n\r\n`);
    if (head.length > 0) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', (err) => {
    deps.log(`preview: ${target.prefix} websocket failed: ${err instanceof Error ? err.message : String(err)}`);
    refuse(socket, 502, 'Bad Gateway');
  });
  socket.on('error', () => up.destroy());
}

function refuse(socket: Duplex, status: number, reason: string): void {
  if (socket.writable) socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
