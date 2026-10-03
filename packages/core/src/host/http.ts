/**
 * What a plugin is allowed to dial through `ctx.buddi.http`, and — more
 * importantly — what it is not.
 *
 * ## The thing this file exists to prevent
 *
 * An agent with `web.read` takes a URL from somewhere (and any plugin that
 * declares `http` may be handed one the same way). Sometimes the owner
 * typed it. Sometimes it came out of a search result, which is to say out of a
 * page a stranger controls, which is to say the stranger chose it. If a URL can
 * name an address inside this machine, then a stranger who can get a URL in
 * front of an agent can read:
 *
 *   - `http://127.0.0.1:4317` — the dashboard, which is the owner's whole
 *     assistant and holds a session token;
 *   - `http://127.0.0.1:55433` — Postgres, which holds his bank data and his
 *     mail;
 *   - `http://169.254.169.254/...` — the cloud metadata endpoint, which on a
 *     hosted box hands out credentials to anyone who asks over plain HTTP with
 *     no authentication whatsoever;
 *   - anything else on the LAN this machine sits on: a router's admin page, a
 *     NAS, a printer.
 *
 * None of that is hypothetical, and none of it needs a bug elsewhere to work.
 * It only needs a fetch that believes the URL.
 *
 * ## Why checking the URL string is not enough
 *
 * Three ways a string check loses, all of which this file covers:
 *
 *  1. **A name resolves wherever its owner says.** `evil.example.com` is a
 *     public hostname, and its A record can be `127.0.0.1`. Nothing about the
 *     URL is suspicious. So the *address* is what must be judged, after DNS.
 *  2. **The answer can change between the check and the connection.** Resolve,
 *     approve, then `connect(hostname)` and the name is resolved a second time
 *     — by the socket, and possibly to a different address. That is DNS
 *     rebinding, and it defeats a resolve-then-check. The fix is not to resolve
 *     twice: `guardedLookup` is handed to the socket as its *own* resolver, so
 *     the address this file approved is the address dialled. There is no second
 *     resolution to poison.
 *  3. **A redirect is a second URL nobody checked.** `http://public.example/x`
 *     answering `302 -> http://127.0.0.1:4317` is a public URL that reaches the
 *     dashboard. So redirects are followed by hand, one hop at a time, and
 *     every hop goes through the whole of this file again (the web plugin's
 *     `http.ts` follows them; `ctx.buddi.http` never does).
 *
 * ## The rule
 *
 * Deny by default on the address, allow by exception on the scheme and the
 * port. Every refusal is a typed `BlockedError` naming what was refused and
 * why, because an agent that gets a vague failure will try something else, and
 * an owner reading the audit log deserves the actual reason.
 */
import dns from 'node:dns';
import type { LookupFunction } from 'node:net';
import { BlockedError, DEFAULT_POLICY, checkUrl, type AddressPolicy } from '../plugin/url.js';
import { registerSecretDestination } from '../secrets/destinations.js';
import type { HttpArea, HttpRequest, HttpResponse } from './types.js';

/* ------------------------------------------------------------------ *
 * The resolver the socket itself uses
 * ------------------------------------------------------------------ */

/** The slice of `node:dns` this needs, so a test can answer without a network. */
export type LookupAll = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

const realLookup: LookupAll = (hostname) =>
  dns.promises.lookup(hostname, { all: true, verbatim: true });

/**
 * A `lookup` for the socket that refuses to resolve anything private.
 *
 * Handed to the transport, which hands it to `net.connect`, which uses its
 * answer *as* the address. That is the whole point: there is no second
 * resolution for an attacker's second answer to win.
 *
 * **Every** address the name returns must be public. Not "the first one", not
 * "one of them": a name that answers `[1.2.3.4, 127.0.0.1]` is a name trying
 * something, and which of the two a given Node version picks is not a security
 * property anybody should be relying on.
 */
export function guardedLookup(
  resolve: LookupAll = realLookup,
  policy: AddressPolicy = DEFAULT_POLICY,
): LookupFunction {
  return function lookup(hostname, options, callback): void {
    // Node calls this with (hostname, options, cb); the options object says
    // whether the caller wants one address or all of them.
    const opts = (typeof options === 'object' && options !== null ? options : {}) as {
      all?: boolean;
      family?: number;
    };
    const done = callback as (
      err: NodeJS.ErrnoException | null,
      address?: any,
      family?: number,
    ) => void;

    if (policy.blockedHostname(hostname)) {
      done(new BlockedError('hostname', `refusing to resolve "${hostname}" — it names this machine or its local network`));
      return;
    }

    resolve(hostname).then(
      (answers) => {
        if (answers.length === 0) {
          done(new BlockedError('unresolvable', `"${hostname}" resolves to no address`));
          return;
        }
        for (const answer of answers) {
          const why = policy.blocked(answer.address);
          if (why !== null) {
            done(
              new BlockedError(
                'private-address',
                `refusing "${hostname}": it resolves to ${answer.address}, which is ${why}. ` +
                  'A public-looking name pointing inside this machine or its network is exactly what this check is for.',
              ),
            );
            return;
          }
        }
        const wanted =
          opts.family === 4 || opts.family === 6
            ? answers.filter((a) => a.family === opts.family)
            : answers;
        const usable = wanted.length > 0 ? wanted : answers;
        if (opts.all === true) {
          done(null, usable.map((a) => ({ address: a.address, family: a.family })));
          return;
        }
        const first = usable[0] as { address: string; family: number };
        done(null, first.address, first.family);
      },
      (err: unknown) => {
        done(
          new BlockedError(
            'unresolvable',
            `could not resolve "${hostname}": ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      },
    );
  } as LookupFunction;
}

/* ------------------------------------------------------------------ *
 * The `http.header` destination
 * ------------------------------------------------------------------ */

/** Core's own header destination (docs/owner-secrets.md §3). */
export const HTTP_HEADER_KIND = 'http.header';
/** The name the destination is registered under: core's `http` area. */
export const HTTP_HEADER_PLUGIN = 'http';

/** A header target: the exact host (lower-cased, no brackets) and header name. */
export interface HttpHeaderTarget {
  host: string;
  header: string;
}

/** What a target or binding is, or `undefined` when it is not one. */
function asHeaderTarget(target: unknown): HttpHeaderTarget | undefined {
  if (typeof target !== 'object' || target === null) return undefined;
  const { host, header } = target as Record<string, unknown>;
  if (typeof host !== 'string' || typeof header !== 'string') return undefined;
  if (!/^[a-z0-9.-]+(\.[a-z0-9.-]+)*$/i.test(host) || host.length === 0 || header.trim() === '') return undefined;
  return { host: host.toLowerCase(), header: header.trim() };
}

/**
 * Register `http.header` under core's own name. One per process, at
 * `configurePluginHost`; the Settings page reads it as one of the kinds a
 * binding may name, and `useOwnerSecret` refuses a plugin that names it — the
 * area asks for the value itself, through its own delivery.
 */
export function registerHttpHeaderDestination(): void {
  registerSecretDestination(HTTP_HEADER_PLUGIN, {
    kind: HTTP_HEADER_KIND,
    maxRule: 'pre-approved',
    checkTarget(target, bound) {
      const asked = asHeaderTarget(target);
      const boundHeader = asHeaderTarget(bound);
      if (asked === undefined || boundHeader === undefined) return false;
      return asked.host === boundHeader.host && asked.header.toLowerCase() === boundHeader.header.toLowerCase();
    },
    describe(target) {
      const asked = asHeaderTarget(target);
      return asked === undefined
        ? 'an HTTP request header'
        : `the ${asked.header} header of requests to ${asked.host}`;
    },
    deliver() {
      // Unreachable through the host area — a plugin cannot name `http.header`
      // (`use` refuses another plugin's kind) — and a defect if it ever ran:
      // the value would go nowhere. Fail loudly rather than silently drop it.
      throw new Error('http.header delivers through the http area itself, never through a destination');
    },
  });
}

/* ------------------------------------------------------------------ *
 * The `http.url` destination (since host API 1.9)
 * ------------------------------------------------------------------ */

/**
 * Core's own URL destination (docs/owner-secrets.md §3): a secret whose value
 * is a whole address — a calendar's private ICS link, where the credential is
 * in the path and no header can carry it.
 */
export const HTTP_URL_KIND = 'http.url';

/**
 * A URL target: the plugin that may fetch it and the exact host the stored
 * address names. The plugin is in the target, and the area fills it in from
 * its own binding, never from the caller: a link the calendar plugin stored is
 * fetched by the calendar plugin, and by no other plugin that declares `http`.
 */
export interface HttpUrlTarget {
  plugin: string;
  host: string;
}

function asUrlTarget(target: unknown): HttpUrlTarget | undefined {
  if (typeof target !== 'object' || target === null) return undefined;
  const { plugin, host } = target as Record<string, unknown>;
  if (typeof plugin !== 'string' || typeof host !== 'string') return undefined;
  if (plugin.trim() === '' || !/^[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(host)) return undefined;
  return { plugin: plugin.trim(), host: host.toLowerCase() };
}

/** Register `http.url` under core's own name, beside `http.header`. */
export function registerHttpUrlDestination(): void {
  registerSecretDestination(HTTP_HEADER_PLUGIN, {
    kind: HTTP_URL_KIND,
    maxRule: 'pre-approved',
    checkTarget(target, bound) {
      const asked = asUrlTarget(target);
      const boundUrl = asUrlTarget(bound);
      if (asked === undefined || boundUrl === undefined) return false;
      return asked.plugin === boundUrl.plugin && asked.host === boundUrl.host;
    },
    describe(target) {
      const asked = asUrlTarget(target);
      return asked === undefined
        ? 'the address of a web request'
        : `the address of requests ${asked.plugin} makes to ${asked.host}`;
    },
    deliver() {
      throw new Error('http.url delivers through the http area itself, never through a destination');
    },
  });
}

/** Whether a binding names `http.url` for this plugin: the one core kind a plugin may bind (`secrets.put`). */
export function isOwnUrlBinding(binding: { kind: string; target: unknown }, plugin: string): boolean {
  return binding.kind === HTTP_URL_KIND && asUrlTarget(binding.target)?.plugin === plugin;
}

/* ------------------------------------------------------------------ *
 * The `http.basic` destination (since host API 1.26)
 * ------------------------------------------------------------------ */

/**
 * Core's own Basic-auth destination (docs/owner-secrets.md §3): a secret that
 * is a password, sent as `Authorization: Basic base64(username:password)` to
 * the hosts its binding names — a CalDAV account's app-specific password. The
 * plugin names the user (it is not the secret); core reads the password,
 * builds the header after the address checks and inserts it, so the plugin
 * never holds the password.
 */
export const HTTP_BASIC_KIND = 'http.basic';

/** The methods a Basic-auth request may use: reads and the WebDAV verbs a calendar or contacts server needs. */
export const HTTP_BASIC_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS', 'PROPFIND', 'REPORT', 'PUT', 'DELETE']);
/** The largest body a Basic-auth request may carry: an event, not an upload. */
export const HTTP_BASIC_MAX_BODY = 256 * 1024;
/** The largest answer it may read, whatever the caller asks for. */
export const HTTP_BASIC_MAX_RESPONSE = 10 * 1024 * 1024;
/** How many Basic-auth requests one plugin may make with one secret in a minute. */
export const HTTP_BASIC_PER_MINUTE = 120;

/**
 * A Basic target: the plugin that may use it and the host it is sent to —
 * exact, or `*.` and a domain of at least two labels (`*.icloud.com`) for a
 * service whose account lives on a numbered host found at discovery.
 */
export interface HttpBasicTarget {
  plugin: string;
  host: string;
}

function asBasicTarget(target: unknown): HttpBasicTarget | undefined {
  if (typeof target !== 'object' || target === null) return undefined;
  const { plugin, host } = target as Record<string, unknown>;
  if (typeof plugin !== 'string' || typeof host !== 'string' || plugin.trim() === '') return undefined;
  const h = host.toLowerCase();
  if (h.startsWith('*.')) {
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h.slice(2))) return undefined;
  } else if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(h)) return undefined;
  return { plugin: plugin.trim(), host: h };
}

/** Whether a request host is one a bound host names: the same, or under its `*.` domain. */
export function basicHostCovers(bound: string, host: string): boolean {
  if (bound.startsWith('*.')) return host.endsWith(bound.slice(1)) && host.length > bound.length - 1;
  return bound === host;
}

/** Register `http.basic` under core's own name, beside `http.header` and `http.url`. */
export function registerHttpBasicDestination(): void {
  registerSecretDestination(HTTP_HEADER_PLUGIN, {
    kind: HTTP_BASIC_KIND,
    maxRule: 'pre-approved',
    checkTarget(target, bound) {
      const asked = asBasicTarget(target);
      const boundBasic = asBasicTarget(bound);
      if (asked === undefined || boundBasic === undefined || asked.host.startsWith('*.')) return false;
      return asked.plugin === boundBasic.plugin && basicHostCovers(boundBasic.host, asked.host);
    },
    describe(target) {
      const asked = asBasicTarget(target);
      return asked === undefined
        ? 'the password of a web sign-in'
        : `the password ${asked.plugin} signs in with at ${asked.host}`;
    },
    deliver() {
      throw new Error('http.basic delivers through the http area itself, never through a destination');
    },
  });
}

/** Whether a binding names `http.basic` for this plugin (`secrets.put`, since 1.26). */
export function isOwnBasicBinding(binding: { kind: string; target: unknown }, plugin: string): boolean {
  return binding.kind === HTTP_BASIC_KIND && asBasicTarget(binding.target)?.plugin === plugin;
}

/* ------------------------------------------------------------------ *
 * The `http.bearer` destination (since host API 1.28)
 * ------------------------------------------------------------------ */

/**
 * Core's own OAuth destination (docs/owner-secrets.md §3): a secret that is
 * an OAuth sign-in core made for a plugin (`secrets.signIn`) — the token
 * envelope — sent as `Authorization: Bearer <access token>` to the host its
 * binding names, refreshed by core at the provider that issued it. The plugin
 * never holds a token.
 */
export const HTTP_BEARER_KIND = 'http.bearer';

/** The methods a bearer request may use: an API's reads and writes. */
export const HTTP_BEARER_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
/** How many bearer requests one plugin may make with one sign-in in a minute. */
export const HTTP_BEARER_PER_MINUTE = 300;

/** Register `http.bearer` under core's own name, beside the other `http.*` kinds. Its target is `http.basic`'s shape. */
export function registerHttpBearerDestination(): void {
  registerSecretDestination(HTTP_HEADER_PLUGIN, {
    kind: HTTP_BEARER_KIND,
    maxRule: 'pre-approved',
    checkTarget(target, bound) {
      const asked = asBasicTarget(target);
      const boundBearer = asBasicTarget(bound);
      if (asked === undefined || boundBearer === undefined || asked.host.startsWith('*.')) return false;
      return asked.plugin === boundBearer.plugin && basicHostCovers(boundBearer.host, asked.host);
    },
    describe(target) {
      const asked = asBasicTarget(target);
      return asked === undefined
        ? 'the sign-in of a web service'
        : `the sign-in ${asked.plugin} uses at ${asked.host}`;
    },
    deliver() {
      throw new Error('http.bearer delivers through the http area itself, never through a destination');
    },
  });
}

/** Whether a binding names `http.bearer` for this plugin (written by `secrets.signIn`, since 1.28). */
export function isOwnBearerBinding(binding: { kind: string; target: unknown }, plugin: string): boolean {
  return binding.kind === HTTP_BEARER_KIND && asBasicTarget(binding.target)?.plugin === plugin;
}

/**
 * How the area asks for a secret's value for one header. Built by the host
 * over `useOwnerSecret` with `deliverInto`, so the value crosses only this
 * boundary and is recorded as an ordinary use. Never a plugin's surface.
 */
export interface HttpSecretDelivery {
  deliverFor(
    name: string,
    host: string,
    header: string,
  ): Promise<{ ok: true; value: string } | { pending: string } | { refused: string }>;
  /** The same for a whole address (`http.url`, since 1.9): the plugin is the area's own. */
  deliverUrlFor?(
    name: string,
    host: string,
  ): Promise<{ ok: true; value: string } | { pending: string } | { refused: string }>;
  /** The same for a sign-in's password (`http.basic`, since 1.26): the plugin is the area's own. */
  deliverBasicFor?(
    name: string,
    host: string,
  ): Promise<{ ok: true; value: string } | { pending: string } | { refused: string }>;
  /**
   * The access token of an OAuth sign-in (`http.bearer`, since 1.28), fresh:
   * refreshed first when it is about to expire, or when `rejected` is the
   * token a 401 just answered. Throws `SignInExpiredError` when the provider
   * refuses the refresh.
   */
  deliverBearerFor?(
    name: string,
    host: string,
    rejected?: string,
  ): Promise<{ ok: true; value: string } | { pending: string } | { refused: string }>;
}

/** A use that waits on the owner: the plugin is told, and may say so onward. */
export class SecretPendingError extends Error {
  override readonly name = 'SecretPendingError';
  constructor(readonly actionId: string) {
    super(`the owner has not approved this secret yet (action ${actionId}); ask again once it is decided`);
  }
}

/* ------------------------------------------------------------------ *
 * The area
 * ------------------------------------------------------------------ */

/** What `@buddi/runtime`'s `HttpTransport` is, structurally. */
export type PluginHostTransport = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string | Buffer | undefined;
    signal?: AbortSignal | undefined;
    idleTimeoutMs?: number | undefined;
    maxBytes?: number | undefined;
  },
) => Promise<HttpResponse>;

/**
 * How a transport is made: `@buddi/runtime`'s `createHttpTransport`, handed in
 * by the composition root because core may not import the runtime. The area
 * makes one, with `guardedLookup` as the socket's resolver.
 */
export type HttpTransportFactory = (options: { lookup: LookupFunction }) => PluginHostTransport;

export interface HttpAreaOptions {
  plugin: string;
  /** The hosts the manifest declares under `network`. */
  network: readonly string[];
  log(line: string): void;
  /** Absent in a process that was never given one: a request then says so. */
  transport: HttpTransportFactory | undefined;
  /**
   * How a secret reaches one header (owner-secrets §3, `http.header`). Absent
   * in a process that never configured secrets: a request carrying `auth`
   * then says so.
   */
  secrets?: HttpSecretDelivery;
  /** `DEFAULT_POLICY` in anything that ships; a test loosens it for its fixture server. */
  policy?: AddressPolicy;
  /** How names are resolved. A test answers here instead of asking a resolver. */
  resolve?: LookupAll;
  /** The clock the Basic-auth budget counts by. A test moves it. */
  now?: () => number;
  /** The Basic-auth budget; the process-wide one unless a test hands its own. */
  basicBudget?: BasicBudget;
  /** The bearer budget (1.28); likewise. */
  bearerBudget?: BasicBudget;
}

/**
 * The Basic-auth budget, shared by every area in the process: keyed by plugin
 * and secret, so a plugin's separate runs, page queries and exports draw on
 * one minute's allowance instead of each getting their own. Old stamps are
 * dropped as they are counted, and a key whose stamps have all aged out is
 * removed, so the map holds only what sent in the last minute.
 */
export interface BasicBudget {
  /** Count one request at `at`; false (and nothing counted) when the minute is full. */
  take(plugin: string, secret: string, at: number): boolean;
  /** Give back the stamp `take` counted at `at`: the password was never delivered, so nothing was sent. */
  refund(plugin: string, secret: string, at: number): void;
}

export function createBasicBudget(perMinute = HTTP_BASIC_PER_MINUTE): BasicBudget {
  const sent = new Map<string, number[]>();
  return {
    take(plugin, secret, at) {
      // Bounded cleanup: whenever the map grows past a handful of keys, drop the stale ones.
      if (sent.size > 64) {
        for (const [key, stamps] of sent) if (stamps.every((t) => at - t >= 60_000)) sent.delete(key);
      }
      const key = `${plugin}\u0000${secret}`;
      const recent = (sent.get(key) ?? []).filter((t) => at - t < 60_000);
      if (recent.length >= perMinute) {
        sent.set(key, recent);
        return false;
      }
      recent.push(at);
      sent.set(key, recent);
      return true;
    },
    refund(plugin, secret, at) {
      const key = `${plugin}\u0000${secret}`;
      const stamps = sent.get(key);
      const i = stamps?.indexOf(at) ?? -1;
      if (stamps !== undefined && i >= 0) stamps.splice(i, 1);
      if (stamps !== undefined && stamps.length === 0) sent.delete(key);
    },
  };
}

const sharedBasicBudget = createBasicBudget();
const sharedBearerBudget = createBasicBudget(HTTP_BEARER_PER_MINUTE);

/**
 * Headers a caller may not set on a request that carries a secret: anything
 * that names which server or virtual host the request is for (`Host` decides
 * TLS SNI and a CDN's routing; the forwarding headers decide it behind some
 * proxies) or that carries a proxy credential. The URL's own host is the only
 * identity a secret is bound to. `Cookie` stays the caller's: it is the
 * plugin's own state, never the owner's secret.
 */
const IDENTITY_HEADERS: ReadonlySet<string> = new Set([
  'host',
  'x-forwarded-host',
  'x-forwarded-server',
  'x-host',
  'x-original-host',
  'forwarded',
  'proxy-authorization',
]);

/** The caller's headers without the identity headers and without `drop` (case-insensitive). */
function withoutIdentity(headers: Record<string, string> | undefined, drop: string): Record<string, string> {
  const lower = drop.toLowerCase();
  return Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => {
      const n = name.toLowerCase();
      return n !== lower && !IDENTITY_HEADERS.has(n);
    }),
  );
}

/** A response cap that is a finite, non-negative whole number, or undefined. */
function validCap(maxBytes: unknown): number | undefined {
  return typeof maxBytes === 'number' && Number.isSafeInteger(maxBytes) && maxBytes >= 0 ? maxBytes : undefined;
}

/** Hosts already said to be undeclared, per plugin, so a loop logs once. */
const undeclaredSeen = new Set<string>();

function hostMatches(declared: string, host: string): boolean {
  const pattern = declared.trim().toLowerCase();
  if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1)) && host.length > pattern.length - 1;
  return pattern === host;
}

/**
 * `ctx.buddi.http`: one request on the shared transport, with the address
 * rules above in front of it and inside it. The URL is checked (scheme, port,
 * credentials, a literal address, a name that means here) before anything is
 * sent, and the socket resolves through `guardedLookup`, so a name that answers
 * with a private address is refused where it is dialled. A refusal is a
 * `BlockedError`, thrown or as the transport error's `cause`. Redirects are not
 * followed: a caller that follows one sends the next hop through here again.
 */
export function createHttpArea(options: HttpAreaOptions): HttpArea {
  const policy = options.policy ?? DEFAULT_POLICY;
  let transport: PluginHostTransport | undefined;
  const basicBudget = options.basicBudget ?? sharedBasicBudget;
  const bearerBudget = options.bearerBudget ?? sharedBearerBudget;
  const now = options.now ?? (() => Date.now());
  /** Send one checked request on the transport; `capped`: a sign-in's answer, at most 10 MB. */
  const dispatch = (req: HttpRequest, url: string, headers: Record<string, string>, capped: boolean): Promise<HttpResponse> => {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    /*
     * Logged, not refused, in 1.0: the hosts a manifest lists were
     * documentation until now, and refusing an undeclared one before every
     * plugin has written its down would break plugins that did nothing
     * wrong (§4.2).
     */
    if (!options.network.some((declared) => hostMatches(declared, host))) {
      const key = `${options.plugin}\u0000${host}`;
      if (!undeclaredSeen.has(key)) {
        undeclaredSeen.add(key);
        options.log(`a request to ${host}, which its manifest does not declare under network`);
      }
    }
    if (options.transport === undefined) {
      return Promise.reject(new Error('This process has no HTTP transport for plugins.'));
    }
    transport ??= options.transport({ lookup: guardedLookup(options.resolve, policy) });
    // A cap that is not a whole number of bytes (NaN, Infinity, -1) is no cap at all to the transport: it counts as unset, so the default applies.
    const cap = validCap(req.maxBytes);
    return transport(url, {
      method: req.method ?? 'GET',
      headers,
      ...(req.body === undefined ? {} : { body: req.body }),
      ...(req.signal === undefined ? {} : { signal: req.signal }),
      ...(req.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: req.idleTimeoutMs }),
      ...(capped
        ? { maxBytes: Math.min(cap ?? HTTP_BASIC_MAX_RESPONSE, HTTP_BASIC_MAX_RESPONSE) }
        : cap === undefined ? {} : { maxBytes: cap }),
    });
  };
  return {
    async request(req) {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(req.url);
      } catch {
        throw new Error(`that is not a URL: ${JSON.stringify(String(req.url).slice(0, 120))}`);
      }
      let host: string = parsedUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      checkUrl(req.url, policy);
      /*
       * A secret goes into one header, after the address checks (owner-secrets
       * §3): the host is the one the URL itself names — never the caller's
       * claim — and the rule the binding carries has been applied before the
       * value is handed over. HTTPS only: a credential over plain HTTP is a
       * credential handed to everyone on the network.
       */
      let headers: Record<string, string> | undefined = req.headers;
      /*
       * A secret that is the whole address (`as: 'url'`, since 1.9): the
       * caller names only the host it expects (`https://calendar.google.com/`)
       * and core fetches the stored address instead, after checking that it is
       * HTTPS, names that same host and passes every address rule. GET only,
       * with no body: the link is read, never written to. The value never
       * reaches the caller, and an error that quotes it says the secret's
       * name instead.
       */
      let url = req.url;
      let secretUrl: { name: string; value: string } | undefined;
      let basicCap = false;
      if (req.auth !== undefined && req.auth.as === 'url') {
        if (parsedUrl.protocol !== 'https:') throw new Error('a secret goes only into an HTTPS request');
        if ((req.method ?? 'GET').toUpperCase() !== 'GET' || req.body !== undefined) {
          throw new Error('a secret address is only read: GET, with no body');
        }
        if (req.auth.header !== undefined) throw new Error('a secret is either the address or a header, not both');
        if (options.secrets?.deliverUrlFor === undefined) {
          throw new Error('This process cannot deliver a secret into a request.');
        }
        const delivered = await options.secrets.deliverUrlFor(req.auth.secret, host);
        if ('pending' in delivered) throw new SecretPendingError(delivered.pending);
        if ('refused' in delivered) throw new Error(delivered.refused);
        const name = req.auth.secret;
        let stored: URL;
        try {
          stored = new URL(delivered.value.trim());
        } catch {
          throw new Error(`"${name}" is not a web address.`);
        }
        const storedHost = stored.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (stored.protocol !== 'https:') throw new Error(`"${name}" is not an HTTPS address, so it is not sent.`);
        if (storedHost !== host) throw new Error(`"${name}" points at ${storedHost}, not ${host}.`);
        checkUrl(stored.toString(), policy);
        url = stored.toString();
        secretUrl = { name, value: url };
        // The address is the credential: no caller header may point it at another virtual host.
        headers = withoutIdentity(req.headers, 'host');
      } else if (req.auth !== undefined && req.auth.as === 'bearer') {
        /*
         * An OAuth sign-in (`as: 'bearer'`, since 1.28): core reads the token
         * envelope the binding allows for this plugin and this host, refreshes
         * it at its provider when it is about to expire, and inserts the
         * access token itself. A 401 is answered once: refreshed (unless
         * another request already did) and sent again. The same fences as a
         * Basic sign-in, with an API's verbs.
         */
        if (parsedUrl.protocol !== 'https:') throw new Error('a secret goes only into an HTTPS request');
        const method = (req.method ?? 'GET').toUpperCase();
        if (!HTTP_BEARER_METHODS.has(method)) {
          throw new Error(`a sign-in is sent only with ${[...HTTP_BEARER_METHODS].join(', ')}, not ${method}`);
        }
        if (req.auth.header !== undefined || req.auth.username !== undefined) throw new Error('a bearer sign-in always goes into Authorization, with no user name');
        const size = req.body === undefined ? 0 : typeof req.body === 'string' ? Buffer.byteLength(req.body) : req.body.length;
        if (size > HTTP_BASIC_MAX_BODY) throw new Error(`a request with a sign-in carries at most ${HTTP_BASIC_MAX_BODY / 1024} KiB`);
        const deliverBearer = options.secrets?.deliverBearerFor;
        if (deliverBearer === undefined) throw new Error('This process cannot deliver a secret into a request.');
        const secretName = req.auth.secret;
        const token = async (rejected?: string): Promise<string> => {
          const at = now();
          if (!bearerBudget.take(options.plugin, secretName, at)) {
            throw new Error(`too many requests with "${secretName}" this minute (at most ${HTTP_BEARER_PER_MINUTE}); try again shortly`);
          }
          let delivered: Awaited<ReturnType<NonNullable<HttpSecretDelivery['deliverBearerFor']>>>;
          try {
            delivered = await deliverBearer(secretName, host, rejected);
          } catch (err) {
            bearerBudget.refund(options.plugin, secretName, at);
            throw err;
          }
          if (!('ok' in delivered)) bearerBudget.refund(options.plugin, secretName, at);
          if ('pending' in delivered) throw new SecretPendingError(delivered.pending);
          if ('refused' in delivered) throw new Error(delivered.refused);
          return delivered.value;
        };
        const base = withoutIdentity(req.headers, 'authorization');
        const first = await token();
        const send = (access: string): Promise<HttpResponse> =>
          dispatch(req, url, { ...base, Authorization: `Bearer ${access}` }, true);
        const answer = await send(first);
        if (answer.status !== 401) return answer;
        // Read and drop the 401's body so its connection is free, then once more with a fresh token.
        await answer.arrayBuffer().catch(() => undefined);
        return send(await token(first));
      } else if (req.auth !== undefined && req.auth.as === 'basic') {
        /*
         * A sign-in's password (`as: 'basic'`, since 1.26): the caller names
         * the user, core reads the password the binding allows for this
         * plugin and this host, and builds the Authorization header itself.
         * HTTPS only, the WebDAV verbs and no others, a small body, a capped
         * answer and a per-minute budget, so a plugin holding a sign-in
         * cannot turn it into an upload channel or a flood.
         */
        if (parsedUrl.protocol !== 'https:') throw new Error('a secret goes only into an HTTPS request');
        const method = (req.method ?? 'GET').toUpperCase();
        if (!HTTP_BASIC_METHODS.has(method)) {
          throw new Error(`a sign-in is sent only with ${[...HTTP_BASIC_METHODS].join(', ')}, not ${method}`);
        }
        if (req.auth.header !== undefined) throw new Error('a sign-in always goes into Authorization');
        const username = req.auth.username;
        if (typeof username !== 'string' || username.length === 0 || username.length > 256 || /[:\r\n\u0000]/.test(username)) {
          throw new Error('a sign-in needs a user name without a colon or a line break');
        }
        const size = req.body === undefined ? 0 : typeof req.body === 'string' ? Buffer.byteLength(req.body) : req.body.length;
        if (size > HTTP_BASIC_MAX_BODY) throw new Error(`a request with a sign-in carries at most ${HTTP_BASIC_MAX_BODY / 1024} KiB`);
        if (options.secrets?.deliverBasicFor === undefined) {
          throw new Error('This process cannot deliver a secret into a request.');
        }
        // Counted before the delivery, so concurrent requests cannot all slip
        // under the line; given back when no password is delivered.
        const at = now();
        if (!basicBudget.take(options.plugin, req.auth.secret, at)) {
          throw new Error(`too many requests with "${req.auth.secret}" this minute (at most ${HTTP_BASIC_PER_MINUTE}); try again shortly`);
        }
        let delivered: Awaited<ReturnType<NonNullable<HttpSecretDelivery['deliverBasicFor']>>>;
        try {
          delivered = await options.secrets.deliverBasicFor(req.auth.secret, host);
        } catch (err) {
          basicBudget.refund(options.plugin, req.auth.secret, at);
          throw err;
        }
        if (!('ok' in delivered)) basicBudget.refund(options.plugin, req.auth.secret, at);
        if ('pending' in delivered) throw new SecretPendingError(delivered.pending);
        if ('refused' in delivered) throw new Error(delivered.refused);
        headers = withoutIdentity(req.headers, 'authorization');
        headers.Authorization = `Basic ${Buffer.from(`${username}:${delivered.value}`, 'utf8').toString('base64')}`;
        basicCap = true;
      } else if (req.auth !== undefined) {
        if (parsedUrl.protocol !== 'https:') {
          throw new Error('a secret goes only into an HTTPS request');
        }
        const headerName = req.auth.header ?? 'Authorization';
        if (options.secrets === undefined) {
          throw new Error('This process cannot deliver a secret into a request.');
        }
        const delivered = await options.secrets.deliverFor(
          req.auth.secret,
          parsedUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase(),
          headerName,
        );
        if ('pending' in delivered) throw new SecretPendingError(delivered.pending);
        if ('refused' in delivered) throw new Error(delivered.refused);
        // The caller's own spelling of the same header goes, whatever its case: one header, the bound value.
        if (IDENTITY_HEADERS.has(headerName.toLowerCase())) throw new Error(`a secret cannot go into ${headerName}`);
        headers = withoutIdentity(req.headers, headerName);
        headers[headerName] = delivered.value;
      }
      const sent = dispatch(req, url, headers ?? {}, basicCap);
      if (secretUrl === undefined) return sent;
      const { name, value } = secretUrl;
      return sent.catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        const hidden = message.split(value).join(`‹secret:${name}›`);
        if (hidden === message) throw err;
        throw new Error(hidden, { cause: err instanceof Error && err.cause !== undefined ? err.cause : undefined });
      });
    },
  };
}
