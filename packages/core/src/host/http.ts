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
import type { HttpArea, HttpResponse } from './types.js';

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
      if (req.auth !== undefined) {
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
        headers = Object.fromEntries(Object.entries(req.headers ?? {}).filter(([name]) => name.toLowerCase() !== headerName.toLowerCase()));
        headers[headerName] = delivered.value;
      }
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
        throw new Error('This process has no HTTP transport for plugins.');
      }
      transport ??= options.transport({ lookup: guardedLookup(options.resolve, policy) });
      return transport(req.url, {
        method: req.method ?? 'GET',
        headers: headers ?? {},
        ...(req.body === undefined ? {} : { body: req.body }),
        ...(req.signal === undefined ? {} : { signal: req.signal }),
        ...(req.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: req.idleTimeoutMs }),
        ...(req.maxBytes === undefined ? {} : { maxBytes: req.maxBytes }),
      });
    },
  };
}
