/**
 * Previews: a plugin's own loopback process, served on an origin of its own.
 *
 * A developer agent starts a dev server. It listens on 127.0.0.1 and nobody
 * but this machine can reach it, and the owner would like to look at it from
 * the dashboard. The tempting shape — proxy it under the dashboard's own
 * origin — is the wrong one, and it is worth writing down why, because the
 * code is arranged entirely around it:
 *
 *   **The framed app is untrusted code.** It is what an agent wrote ninety
 *   seconds ago, most likely from input somebody else chose. Served on the
 *   dashboard's origin it can read the CSRF token out of the page, call
 *   `/api/*` as the owner, approve its own pending actions, and read the
 *   library — and "Open in a tab" would be stored XSS on the dashboard by
 *   construction, with no iframe involved. `sandbox="…"` on the frame does
 *   not help: with `allow-same-origin` it keeps the origin, and without it
 *   most dev servers stop working.
 *
 * So previews get **a second listener on a second port**, which is a second
 * origin as far as every browser is concerned. Nothing of the dashboard lives
 * there: no `/api`, no assets, no session. It serves `/preview/<plugin>/<name>/…`
 * and answers 404 to everything else.
 *
 * Authentication is its own, too, because the dashboard's session cookie is
 * host-only and browsers ignore ports when they decide what to send — the
 * session cookie *does* arrive here, and this listener never looks at it. The
 * owner gets in by exchange:
 *
 *   1. `GET /api/preview/<plugin>/<name>/link` on the **dashboard**, behind
 *      the dashboard's own gate, mints a single-use ticket good for five
 *      minutes and answers `{ url }` pointing at this listener.
 *   2. Opening that URL spends the ticket, sets `buddi_preview` (HttpOnly,
 *      SameSite=Strict, scoped by path to that one preview, 24 hours) and
 *      redirects to the clean path. A request that already holds a good
 *      cookie needs no ticket, so the link keeps working after its own
 *      ticket has been spent.
 *   3. Every later request and every websocket upgrade needs that cookie.
 *
 * What crosses the proxy, once past the gate:
 *
 *  - **Up**: the method, the path below the prefix, the query, the body and
 *    every header except the hop-by-hop ones, `authorization`, the
 *    dashboard's CSRF header, and — from `cookie` — the three cookies that
 *    belong to buddi. The app's own cookies go through, because it has an
 *    origin now and they are its own.
 *  - **Down**: the status and the body byte for byte, the headers minus the
 *    hop-by-hop ones, `Set-Cookie` path-scoped into the prefix with any
 *    buddi-named cookie dropped, `X-Content-Type-Options: nosniff`, and —
 *    unless the app sent its own — a `Content-Security-Policy` that lets only
 *    the dashboard frame it.
 *
 * Nothing in the body is ever rewritten. An app that assumes it owns the root
 * of a host breaks under a path prefix, and an HTML rewriter that is wrong is
 * worse than an app that is plainly broken — so the first HTML response is
 * *scanned* instead, and `GET /api/preview/<plugin>/<name>/check` says what it
 * found.
 */
import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import type { Duplex } from 'node:stream';
import { connect, type Socket } from 'node:net';
import type { PreviewProvider, ToolContext, ToolRegistry } from '@buddi/core';
import { CSRF_COOKIE, SESSION_COOKIE, cookieHeader, parseCookies, parseUrl } from './http.js';

/** The route's own prefix. Everything below it is the app's. */
export const PREVIEW_PREFIX = '/preview';

/** The cookie this origin authenticates with. Never the dashboard's. */
export const PREVIEW_COOKIE = 'buddi_preview';

/** The query parameter the link route puts the ticket in. */
export const PREVIEW_TICKET_PARAM = 'ticket';

/** How long a minted link is good for before it has been opened. */
export const PREVIEW_TICKET_TTL_MS = 5 * 60_000;

/** How long the cookie that ticket buys lasts. */
export const PREVIEW_COOKIE_TTL_MS = 24 * 60 * 60 * 1000;

/** How long the upstream has to answer at all, and to keep answering. */
export const PREVIEW_FIRST_BYTE_MS = 30_000;
export const PREVIEW_IDLE_MS = 120_000;

/**
 * How much of a first response is scanned for absolute asset references.
 *
 * The head of an HTML document is where `<script src="/…">` lives, and 64 KB
 * of it is a great deal of head. It is a warning for the owner, not a security
 * check, and it costs one pass over bytes that were being streamed anyway.
 */
export const SCAN_BYTES = 64 * 1024;

/** Enough carry-over that a tag split across two chunks is still seen whole. */
const SCAN_CARRY = 1024;

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
const NEVER_FORWARDED = new Set(['authorization', 'host', 'x-buddi-csrf']);

/** Cookies that are buddi's and stop at this boundary, both directions. */
const BUDDI_COOKIES = new Set([SESSION_COOKIE, CSRF_COOKIE, PREVIEW_COOKIE]);

/** A header name, as RFC 9110 defines a token. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Visible ASCII: what may be written into a request line by hand. */
const VISIBLE_ASCII = /^[\x21-\x7e]*$/;

/** Ports nothing may ever be proxied to, whatever a plugin says. */
const POSTGRES_PORT = 5432;

/** `/preview/<plugin>/<name>/<rest>`, as the route reads it. */
export interface PreviewTarget {
  plugin: string;
  name: string;
  /** The path the app sees, always starting with `/`. */
  rest: string;
  /** `/preview/<plugin>/<name>` — the cookie's path, and the forwarded prefix. */
  prefix: string;
}

/** A plugin and a process name are both one path segment of plain characters. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * Read a preview route, or null when the path is not one.
 *
 * `/preview/<plugin>/<name>` with nothing after it is the app's root: it is
 * forwarded as `/`, not redirected. The pathname handed in has already been
 * normalised by `new URL`, so dot segments are resolved before the match.
 */
export function parsePreviewPath(pathname: string): PreviewTarget | null {
  if (pathname !== PREVIEW_PREFIX && !pathname.startsWith(`${PREVIEW_PREFIX}/`)) return null;
  const segments = pathname.slice(PREVIEW_PREFIX.length + 1).split('/');
  const [plugin, name] = segments;
  if (!plugin || !name || !SEGMENT.test(plugin) || !SEGMENT.test(name)) return null;
  return {
    plugin,
    name,
    rest: `/${segments.slice(2).join('/')}`,
    prefix: `${PREVIEW_PREFIX}/${plugin}/${name}`,
  };
}

/** `/api/preview/<plugin>/<name>/link` and `…/check`, on the dashboard. */
export function parsePreviewApiPath(pathname: string): { plugin: string; name: string; what: 'link' | 'check' } | null {
  const match = /^\/api\/preview\/([^/]+)\/([^/]+)\/(link|check)$/.exec(pathname);
  if (!match) return null;
  const [, plugin, name, what] = match;
  if (!plugin || !name || !SEGMENT.test(plugin) || !SEGMENT.test(name)) return null;
  return { plugin, name, what: what as 'link' | 'check' };
}

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

/* ------------------------------------------------------------------ *
 * Tickets and cookies
 * ------------------------------------------------------------------ */

interface Ticket {
  plugin: string;
  name: string;
  expiresAt: number;
}

/** At most this many unspent tickets, and this many live cookies, at once. */
export const MAX_LIVE_TICKETS = 64;
export const MAX_LIVE_COOKIES = 256;

/**
 * The preview origin's own credentials, in memory.
 *
 * In memory on purpose: a preview is a process that is running *now*, and
 * nothing here should outlive the gateway that minted it. A ticket is
 * single-use and short; the cookie it buys names the one preview it was
 * minted for, so a cookie for one process is not a key to another.
 *
 * Both maps are **bounded**, and swept on every call rather than only when
 * something is minted. An owner who leaves a dashboard tab open for a month
 * mints a ticket per panel render, and a reader that only ever grows is a slow
 * leak with a public trigger. Over the bound, the oldest goes: a ticket lives
 * five minutes and a cookie a day, so the oldest is the one nearest to being
 * worthless anyway, and the cost of being wrong is one sign-in.
 */
export class PreviewTickets {
  readonly #tickets = new Map<string, Ticket>();
  readonly #cookies = new Map<string, Ticket>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** A single-use ticket for one preview, good for five minutes. */
  mintTicket(plugin: string, name: string): string {
    this.#sweep();
    const id = randomBytes(32).toString('hex');
    this.#tickets.set(id, { plugin, name, expiresAt: this.now().getTime() + PREVIEW_TICKET_TTL_MS });
    evictOldest(this.#tickets, MAX_LIVE_TICKETS);
    return id;
  }

  /** Spend one, or refuse. Wrong, expired and already-used are one answer. */
  spendTicket(id: string | null, plugin: string, name: string): boolean {
    this.#sweep();
    if (!id) return false;
    const ticket = this.#tickets.get(id);
    if (!ticket) return false;
    this.#tickets.delete(id);
    if (ticket.expiresAt <= this.now().getTime()) return false;
    return ticket.plugin === plugin && ticket.name === name;
  }

  /** The cookie a spent ticket buys. */
  mintCookie(plugin: string, name: string): string {
    this.#sweep();
    const id = randomBytes(32).toString('hex');
    this.#cookies.set(id, { plugin, name, expiresAt: this.now().getTime() + PREVIEW_COOKIE_TTL_MS });
    evictOldest(this.#cookies, MAX_LIVE_COOKIES);
    return id;
  }

  /** Which preview a live cookie names, or nothing. */
  previewFor(id: string | undefined): { plugin: string; name: string } | undefined {
    this.#sweep();
    if (!id) return undefined;
    const held = this.#cookies.get(id);
    if (!held) return undefined;
    if (held.expiresAt <= this.now().getTime()) {
      this.#cookies.delete(id);
      return undefined;
    }
    return { plugin: held.plugin, name: held.name };
  }

  /** Is this cookie a live one, for this preview? */
  holds(id: string | undefined, plugin: string, name: string): boolean {
    this.#sweep();
    if (!id) return false;
    const held = this.#cookies.get(id);
    if (!held) return false;
    if (held.expiresAt <= this.now().getTime()) {
      this.#cookies.delete(id);
      return false;
    }
    return held.plugin === plugin && held.name === name;
  }

  /** What is live right now. For a test, and for nothing else. */
  counts(): { tickets: number; cookies: number } {
    this.#sweep();
    return { tickets: this.#tickets.size, cookies: this.#cookies.size };
  }

  #sweep(): void {
    const at = this.now().getTime();
    for (const [id, ticket] of this.#tickets) if (ticket.expiresAt <= at) this.#tickets.delete(id);
    for (const [id, held] of this.#cookies) if (held.expiresAt <= at) this.#cookies.delete(id);
  }
}

/** A `Map` keeps insertion order, so the oldest key is the first one. */
function evictOldest(map: Map<string, Ticket>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

/* ------------------------------------------------------------------ *
 * Headers
 * ------------------------------------------------------------------ */

/** The hop-by-hop set for one message, including what `Connection` nominates. */
function hopByHop(headers: IncomingHttpHeaders): Set<string> {
  const set = new Set(HOP_BY_HOP);
  const connection = headers.connection;
  const listed = Array.isArray(connection) ? connection.join(',') : connection ?? '';
  for (const token of listed.split(',')) {
    const name = token.trim().toLowerCase();
    if (name !== '') set.add(name);
  }
  return set;
}

/** The app's own cookies, with buddi's removed. */
export function forwardableCookies(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const name = part.slice(0, part.indexOf('=') < 0 ? part.length : part.indexOf('=')).trim();
      return part !== '' && !BUDDI_COOKIES.has(name);
    });
  return kept.length > 0 ? kept.join('; ') : undefined;
}

/** The headers that go up: everything but buddi's own and the hop's. */
export function forwardedRequestHeaders(headers: IncomingHttpHeaders, prefix: string, host: string): IncomingHttpHeaders {
  const hop = hopByHop(headers);
  const out: IncomingHttpHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (hop.has(lower) || NEVER_FORWARDED.has(lower) || lower === 'cookie') continue;
    if (value !== undefined) out[lower] = value;
  }
  const cookies = forwardableCookies(Array.isArray(headers.cookie) ? headers.cookie.join('; ') : headers.cookie);
  if (cookies) out.cookie = cookies;
  out.host = host;
  out['x-forwarded-prefix'] = prefix;
  return out;
}

/**
 * The response headers that come back.
 *
 * The app's own, minus the hop-by-hop ones; every `Set-Cookie` path-scoped
 * into the prefix, and dropped outright when it is named after one of
 * buddi's own cookies — an app that sets `buddi_session=junk` would otherwise
 * leave the browser holding two cookies of that name and no rule saying which
 * one is sent. Then the two headers this origin insists on.
 */
export function returnedResponseHeaders(
  headers: IncomingHttpHeaders,
  prefix: string,
  frameAncestors: string,
): Record<string, string | string[]> {
  const hop = hopByHop(headers);
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (hop.has(lower) || value === undefined) continue;
    if (lower === 'set-cookie') {
      const cookies = (Array.isArray(value) ? value : [value]).filter(
        (cookie) => !BUDDI_COOKIES.has(cookie.slice(0, Math.max(0, cookie.indexOf('='))).trim()),
      );
      if (cookies.length > 0) out['set-cookie'] = cookies.map((cookie) => scopeCookiePath(cookie, prefix));
      continue;
    }
    out[lower] = value;
  }
  // A preview is whatever the process is serving this second.
  out['cache-control'] = 'no-store';
  out['x-content-type-options'] = 'nosniff';
  // Who may frame this. The app's own policy wins if it has one — it knows
  // more about itself than we do — but an app that says nothing is framed by
  // the dashboard and by nobody else.
  if (!('content-security-policy' in out)) {
    out['content-security-policy'] = `frame-ancestors ${frameAncestors}`;
  }
  return out;
}

/**
 * Rewrite one `Set-Cookie`'s `Path` so it lives under the preview's prefix.
 *
 * An app that sets `Path=/` would otherwise set a cookie for every preview on
 * this origin. Its own path is kept below the prefix, so `Path=/session`
 * becomes `Path=/preview/x/y/session`.
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

/* ------------------------------------------------------------------ *
 * The listener
 * ------------------------------------------------------------------ */

/** The one sentence a refused port gets. Never the error's own words. */
export const PREVIEW_UNREACHABLE = 'That preview is not answering: the process behind it may have stopped.';

/**
 * Which loopback address the process is actually on.
 *
 * "Loopback" is two addresses. Vite, and anything else that binds
 * `localhost`, lands on `::1` alone on a Mac, where the name resolves to the
 * IPv6 address first — and a proxy that only ever dials 127.0.0.1 then reports
 * a running server as stopped. So the port is knocked on at 127.0.0.1 and, if
 * that refuses, at ::1; both are this machine and nothing else, so the SSRF
 * boundary above is unchanged. A port that answers on neither is dialled at
 * 127.0.0.1 and fails the way it always did, in one sentence.
 */
export async function loopbackHost(port: number): Promise<string> {
  for (const host of ['127.0.0.1', '::1']) {
    const open = await new Promise<boolean>((resolve) => {
      const probe = connect({ port, host });
      const finish = (value: boolean): void => {
        probe.destroy();
        resolve(value);
      };
      probe.setTimeout(250, () => finish(false));
      probe.once('connect', () => finish(true));
      probe.once('error', () => finish(false));
    });
    if (open) return host;
  }
  return '127.0.0.1';
}

export interface PreviewDeps {
  registry: Pick<ToolRegistry, 'previews'>;
  ctx: ToolContext;
  log: (line: string) => void;
  tickets: PreviewTickets;
  /** The origins allowed to frame a preview: the dashboard's, and no others. */
  frameAncestors: () => string[];
  /**
   * Ports this gateway is itself listening on. A preview may not point at
   * one: `/preview/x/y` proxied to this very listener recurses until the
   * process runs out of sockets.
   */
  ownPorts: () => number[];
}

/** What `/check` answers, and what the scan has learned about each preview. */
interface Scanned {
  port: number;
  absoluteAssets: boolean;
}

/**
 * The preview listener, and the small amount of state that belongs to it.
 *
 * An object rather than module state because the scan results are keyed per
 * gateway: two `createWebApp`s in one test process are two installations, and
 * one must not answer for the other.
 */
export class PreviewApp {
  readonly server: Server;
  readonly #scanned = new Map<string, Scanned>();

  constructor(private readonly deps: PreviewDeps) {
    this.server = createServer((req, res) => {
      this.#handle(req, res).catch((err) => {
        deps.log(`preview: ${req.method} ${req.url} failed: ${err instanceof Error ? err.stack : String(err)}`);
        if (!res.headersSent) previewEmpty(res, 500);
        else res.end();
      });
    });
    this.server.on('upgrade', (req, socket, head) => {
      void this.#upgrade(req, socket as Duplex, head);
    });
  }

  /** The port this listener is on, or null before it is listening. */
  port(): number | null {
    const address = this.server.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  /**
   * What `GET /api/preview/<plugin>/<name>/check` answers.
   *
   * `ok` is a real question: it is false when this installation has no plugin
   * of that name, or the plugin has no previews, or it does not know that
   * process. `absoluteAssets` is false until a first HTML response has been
   * scanned, which is the honest reading — nothing has been seen to assume
   * the root of a host.
   */
  async check(plugin: string, name: string): Promise<{ ok: boolean; absoluteAssets: boolean }> {
    const upstream = await this.#resolve({ plugin, name });
    if (!upstream) return { ok: false, absoluteAssets: false };
    const seen = this.#scanned.get(`${plugin}/${name}`);
    return { ok: true, absoluteAssets: seen?.port === upstream.port && seen.absoluteAssets };
  }

  /** Does this installation serve previews for that plugin at all? */
  serves(plugin: string): boolean {
    return this.deps.registry.previews(plugin) !== undefined;
  }

  /**
   * Where a preview lives right now, or null.
   *
   * Asked on every request: a port that has stopped being this name's port
   * stops being served the moment it does. A `resolve` that throws is a
   * plugin whose answer we do not have, which is a 404 and a line in the log
   * — never a guess at a port.
   */
  async #resolve(target: { plugin: string; name: string }): Promise<{ port: number; host: string } | null> {
    const provider: PreviewProvider | undefined = this.deps.registry.previews(target.plugin);
    if (!provider) return null;
    let resolved: { port: number; host?: string } | null;
    try {
      resolved = await provider.resolve(target.name, this.deps.ctx);
    } catch (err) {
      this.deps.log(`preview: ${target.plugin}/${target.name} could not be resolved: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
    if (!resolved || !Number.isInteger(resolved.port)) return null;
    const port = resolved.port;
    /*
     * What a port may be. A plugin's record of "which port is this process
     * on" is a record an agent influences, so this is the SSRF boundary:
     *
     *  - loopback always, whatever the plugin returns for `host`;
     *  - a user port, never one of the privileged thousand;
     *  - never a port this gateway is itself listening on — a preview
     *    pointed at the preview listener is an infinite proxy loop;
     *  - never Postgres, which is the one loopback service every
     *    installation is guaranteed to have and the one worth naming.
     */
    if (port < 1024 || port > 65535) return null;
    if (port === POSTGRES_PORT || this.deps.ownPorts().includes(port)) {
      this.deps.log(`preview: ${target.plugin}/${target.name} resolved to port ${port}, which is not a preview`);
      return null;
    }
    return { port, host: await loopbackHost(port) };
  }

  /**
   * A path that is not under `/preview/…`, on this origin.
   *
   * A built app asks for `/assets/index.js` by its root, and under a prefix
   * the browser sends that to this origin's root, where nothing lived and
   * the page stayed blank. The cookie the browser sends with it names the
   * one preview it was minted for, so the request is that preview's, at that
   * path: nothing is rewritten, and a request with no live cookie is still
   * the 404 it was. One cookie per browser means the most recently opened
   * preview answers for the root, which is the one the owner is looking at.
   */
  #rootRelative(pathname: string, req: IncomingMessage): PreviewTarget | null {
    const held = this.deps.tickets.previewFor(parseCookies(req.headers.cookie)[PREVIEW_COOKIE]);
    if (!held) return null;
    return {
      plugin: held.plugin,
      name: held.name,
      rest: pathname,
      prefix: `${PREVIEW_PREFIX}/${held.plugin}/${held.name}`,
    };
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = parseUrl(req);
    const target = parsePreviewPath(url.pathname) ?? this.#rootRelative(url.pathname, req);
    // Nothing but previews answers here. Not the dashboard, not `/api`, not a
    // static asset of buddi's own: this origin has one job.
    if (!target) return previewEmpty(res, 404);

    const method = (req.method ?? 'GET').toUpperCase();
    const held = this.deps.tickets.holds(
      parseCookies(req.headers.cookie)[PREVIEW_COOKIE],
      target.plugin,
      target.name,
    );
    const ticket = url.searchParams.get(PREVIEW_TICKET_PARAM);
    if (ticket !== null && (method === 'GET' || method === 'HEAD')) {
      /*
       * The cookie is asked first, and that is what makes a *link* work.
       *
       * The URL in the frame carries a ticket that was spent the moment the
       * frame loaded it. Opening that same URL again — a bookmark, a reload,
       * the browser restoring the tab — must not be a 401 for somebody who is
       * already holding a good cookie for this preview. So a live cookie
       * answers for the request and the stale ticket is simply dropped from
       * the URL; only a request with no cookie has to spend one.
       */
      if (!held && !this.deps.tickets.spendTicket(ticket, target.plugin, target.name)) {
        // Wrong, expired and already spent are one answer and one bit.
        return previewEmpty(res, 401);
      }
      const clean = new URL(url.toString());
      clean.searchParams.delete(PREVIEW_TICKET_PARAM);
      return previewEmpty(res, 302, {
        Location: `${clean.pathname}${clean.search}`,
        ...(held
          ? {}
          : {
              'Set-Cookie': cookieHeader(PREVIEW_COOKIE, this.deps.tickets.mintCookie(target.plugin, target.name), {
                httpOnly: true,
                maxAgeSeconds: Math.floor(PREVIEW_COOKIE_TTL_MS / 1000),
                /*
                 * `Strict`, like every other cookie buddi sets.
                 *
                 * The navigation that matters — the dashboard's link, the
                 * frame, the tab it opens — is *same-site*: `SameSite` is
                 * decided by registrable domain and ignores the port, so
                 * 127.0.0.1:4317 and 127.0.0.1:4318 are one site and the
                 * cookie travels. What `Strict` refuses is a request that
                 * started on somebody else's site, which is exactly the
                 * request that has no business reaching a preview.
                 */
                sameSite: 'Strict',
                // Behind `tailscale serve` the listener is reached over
                // HTTPS, and Serve says so; a cookie set there is marked
                // Secure like the dashboard's own remote cookies.
                secure: req.headers['x-forwarded-proto'] === 'https',
                /*
                 * The origin's root, not the prefix. A built app asks for
                 * `/assets/app.js` by its root, and a cookie scoped under
                 * `/preview/x/y` would not travel with that request, which
                 * is how a framed page stayed blank while the app was fine on
                 * its own port. The cookie names one preview whatever path
                 * it is sent to, and `holds` checks that name on every
                 * request, so the wider path buys no wider access.
                 */
                path: '/',
              }),
            }),
      });
    }

    if (!held) return previewEmpty(res, 401);
    return this.#proxy(target, req, res, url.search);
  }

  async #proxy(target: PreviewTarget, req: IncomingMessage, res: ServerResponse, search: string): Promise<void> {
    const upstream = await this.#resolve(target);
    if (!upstream) return notFound(res);
    if (!VISIBLE_ASCII.test(target.rest) || !VISIBLE_ASCII.test(search)) return notFound(res);

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const proxied = httpRequest(
        {
          host: upstream.host,
          port: upstream.port,
          method: req.method ?? 'GET',
          path: `${target.rest}${search}`,
          headers: forwardedRequestHeaders(req.headers, target.prefix, `127.0.0.1:${upstream.port}`),
        },
        (upstreamRes) => {
          // Answering is not the same as finishing: a dev server that streams
          // for an hour is fine, one that stalls mid-body is not.
          proxied.setTimeout(PREVIEW_IDLE_MS, () => proxied.destroy());
          res.writeHead(
            upstreamRes.statusCode ?? 502,
            returnedResponseHeaders(upstreamRes.headers, target.prefix, this.deps.frameAncestors().join(' ')),
          );
          /*
           * The scan rides along beside the pipe rather than replacing it.
           *
           * `pipe` is what makes a slow browser slow the dev server down
           * instead of filling this process's memory; doing the copy by hand
           * in a `data` handler drops that. So the observer only *looks*, at
           * the first 64 KB, decoding with a `StringDecoder` so a multi-byte
           * character split across two chunks is not turned into rubbish, and
           * carrying a kilobyte over so a tag split across two chunks is
           * still seen whole.
           */
          if (this.#shouldScan(target, upstream.port, upstreamRes.headers['content-type'])) {
            const key = `${target.plugin}/${target.name}`;
            const decoder = new StringDecoder('utf8');
            let scanned = 0;
            let carry = '';
            let decided = false;
            upstreamRes.on('data', (chunk: Buffer) => {
              if (decided || scanned >= SCAN_BYTES) return;
              const take = chunk.subarray(0, SCAN_BYTES - scanned);
              scanned += chunk.length;
              const text = carry + decoder.write(take);
              if (scanForAbsoluteAssets(text, target.prefix)) {
                this.#scanned.set(key, { port: upstream.port, absoluteAssets: true });
                decided = true;
                carry = '';
                return;
              }
              carry = text.slice(-SCAN_CARRY);
            });
            upstreamRes.on('end', () => {
              if (!decided) this.#scanned.set(key, { port: upstream.port, absoluteAssets: false });
            });
          }
          upstreamRes.pipe(res);
          upstreamRes.on('end', done);
          upstreamRes.on('error', () => { res.end(); done(); });
        },
      );
      // No answer at all, and a client that walked away: both leave a socket
      // and an upstream request behind unless somebody says so.
      proxied.setTimeout(PREVIEW_FIRST_BYTE_MS, () => proxied.destroy());
      res.on('close', () => proxied.destroy());
      proxied.on('error', (err) => {
        this.deps.log(`preview: ${target.prefix} could not be reached: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) sendJsonRaw(res, 502, { error: PREVIEW_UNREACHABLE });
        else res.end();
        done();
      });
      req.pipe(proxied);
      req.on('error', () => proxied.destroy());
    });
  }

  /** Only the first HTML response of a preview, on this port, is worth a scan. */
  #shouldScan(target: PreviewTarget, port: number, contentType: string | string[] | undefined): boolean {
    const seen = this.#scanned.get(`${target.plugin}/${target.name}`);
    // A process that restarted on another port is another app: what the last
    // one did with its assets says nothing about this one.
    if (seen && seen.port === port) return false;
    const type = Array.isArray(contentType) ? contentType[0] : contentType;
    return typeof type === 'string' && type.toLowerCase().includes('text/html');
  }

  /**
   * A websocket upgrade, tunnelled to the same port.
   *
   * Hot reload is why this exists: a dev server that cannot tell the page a
   * file changed is a dev server the owner stops using. The gate is the same
   * cookie, checked before a single byte is forwarded.
   */
  async #upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = parseUrl(req);
    const target = parsePreviewPath(url.pathname) ?? this.#rootRelative(url.pathname, req);
    if (!target) return refuse(socket, 404, 'Not Found');
    if (!this.deps.tickets.holds(parseCookies(req.headers.cookie)[PREVIEW_COOKIE], target.plugin, target.name)) {
      return refuse(socket, 401, 'Unauthorized');
    }
    const upstream = await this.#resolve(target);
    if (!upstream) return refuse(socket, 404, 'Not Found');

    const headers = forwardedRequestHeaders(req.headers, target.prefix, `127.0.0.1:${upstream.port}`);
    // The upgrade headers are the point of the request, so they survive the
    // hop-by-hop strip — this hop *is* the upgrade.
    headers.connection = 'Upgrade';
    headers.upgrade = typeof req.headers.upgrade === 'string' ? req.headers.upgrade : 'websocket';

    /*
     * This is the one place in the proxy where a request is assembled as
     * text, so it is the one place where a newline in the wrong field would
     * be a smuggled request. Node's parser would reject it and `new URL`
     * strips it from the path — but "an upstream parser is strict" is not a
     * local guarantee, so every byte written here is checked first.
     */
    if (!VISIBLE_ASCII.test(target.rest) || !VISIBLE_ASCII.test(url.search)) {
      return refuse(socket, 400, 'Bad Request');
    }
    const lines: string[] = [];
    for (const [key, value] of Object.entries(headers)) {
      if (!TOKEN.test(key)) continue;
      for (const one of Array.isArray(value) ? value : [String(value)]) {
        if (!VISIBLE_ASCII.test(one.replace(/[ \t]/g, ''))) continue;
        lines.push(`${key}: ${one}`);
      }
    }

    const up: Socket = connect(upstream.port, upstream.host, () => {
      up.write(`GET ${target.rest}${url.search} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    // Either end going away takes the other with it; a half-open tunnel is a
    // socket nobody is ever going to close.
    const tearDown = (): void => { up.destroy(); socket.destroy(); };
    up.on('error', (err) => {
      this.deps.log(`preview: ${target.prefix} websocket failed: ${err instanceof Error ? err.message : String(err)}`);
      refuse(socket, 502, 'Bad Gateway');
      up.destroy();
    });
    up.on('close', tearDown);
    socket.on('close', tearDown);
    socket.on('error', tearDown);
  }
}

/**
 * A status and nothing else, from this origin.
 *
 * Deliberately not `sendEmpty`: the dashboard's `baseHeaders` carry
 * `X-Frame-Options: DENY`, and a preview that cannot be framed is the whole
 * point missed — including its 401, which the owner would otherwise meet as a
 * blank frame with no explanation anywhere.
 */
function previewEmpty(res: ServerResponse, status: number, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, {
    'Content-Length': '0',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end();
}

function notFound(res: ServerResponse): void {
  sendJsonRaw(res, 404, { error: 'no such preview' });
}

/**
 * JSON from this origin, without the dashboard's `baseHeaders`.
 *
 * `X-Frame-Options: DENY` is in those headers, and a preview that cannot be
 * framed is the whole point missed — so this origin's own two headers are
 * written explicitly instead.
 */
function sendJsonRaw(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function refuse(socket: Duplex, status: number, reason: string): void {
  if (socket.writable) socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
