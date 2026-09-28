/**
 * The `fetch` the MCP SDK's Streamable HTTP transport is handed
 * (docs/connections.md, "What leaves your machine").
 *
 * The SDK speaks the protocol; this decides what may go on the wire:
 *
 *  - **Exact host.** Only the connection's own origin, `https:` only. A
 *    request anywhere else is refused before it is made.
 *  - **The token from the vault, in the header, here.** The SDK never holds
 *    it: its `authProvider` is not used, and each request asks the vault
 *    through `token()` (which refreshes under the shared discipline) and
 *    puts `Authorization: Bearer …` on it. Whatever `Authorization` the
 *    caller wrote is dropped first.
 *  - **No redirects.** The shared transport follows none; a 3xx reaches the
 *    SDK as the answer it is, and the SDK fails on it.
 *  - **One transport.** Every byte goes through `@buddi/runtime`'s shared
 *    HTTP transport (one connection per request), never the global `fetch`.
 *  - **No standing stream.** The SDK opens a GET for server-initiated
 *    messages after `initialize`; buddi needs none, so it is answered 405
 *    here, which the protocol defines as "this server offers no stream".
 */
import type { HttpTransport } from './ports.js';

/** The SDK's `FetchLike`. */
export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface ConnectionFetchOptions {
  /** The connection's address. Its origin is the only one reachable. */
  url: string;
  transport: HttpTransport;
  /** The access token, or undefined for a server that wants none. */
  token?: () => Promise<string | undefined>;
  /** A 401, with the server's `WWW-Authenticate`. */
  onUnauthorized?: (wwwAuthenticate: string | null) => void;
  /** `http:` to a loopback address (tests, a local development server). */
  allowLoopbackHttp?: boolean;
  /** The most a response may be. 8 MB. */
  maxBytes?: number;
}

const PASSED_HEADERS = ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'www-authenticate', 'retry-after'];
const NULL_BODY = new Set([101, 204, 205, 304]);

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\./.test(h);
}

/** The address a connection may use, or a sentence saying why not. */
export function checkServerUrl(text: string, allowLoopbackHttp = false): URL {
  const trimmed = text.trim();
  if (/^(npx|uvx|node|python3?|docker|bunx|stdio:)\b/i.test(trimmed) || /^[./~]/.test(trimmed)) {
    throw new Error(STDIO_REFUSAL);
  }
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new Error('That is not a web address. A connection is an https:// address.'); }
  if (url.username || url.password) throw new Error('Leave the name and password out of the address; the service asks for them itself.');
  if (url.protocol === 'https:') {
    if (isLoopbackHost(url.hostname) && !allowLoopbackHttp) throw new Error(STDIO_REFUSAL);
  } else if (!(url.protocol === 'http:' && allowLoopbackHttp && isLoopbackHost(url.hostname))) {
    throw new Error('buddi connects only to https:// addresses.');
  }
  url.hash = '';
  return url;
}

/** Spec §1: local servers stay out until there is a story for them. */
export const STDIO_REFUSAL =
  'buddi connects only to remote servers over https for now. A server that runs as a program on this computer (npx, uvx, a local address) is not supported yet.';

function headersOf(init: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!init) return out;
  const entries: Iterable<[string, string]> = init instanceof Headers
    ? init.entries()
    : Array.isArray(init) ? init as [string, string][] : Object.entries(init as Record<string, string>);
  for (const [k, v] of entries) out[k.toLowerCase()] = String(v);
  return out;
}

export function connectionFetch(opts: ConnectionFetchOptions): FetchLike {
  const home = checkServerUrl(opts.url, opts.allowLoopbackHttp);
  return async (input, init = {}) => {
    const target = new URL(typeof input === 'string' ? input : input.toString());
    if (target.origin !== home.origin || target.username || target.password) {
      throw new Error(`refusing a request to ${target.host}: this connection talks only to ${home.host}`);
    }
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'GET') return new Response(null, { status: 405, statusText: 'Method Not Allowed' });
    const headers = headersOf(init.headers);
    delete headers.authorization;
    delete headers.cookie;
    const token = await opts.token?.();
    if (token) headers.authorization = `Bearer ${token}`;
    let body: string | Buffer | undefined;
    if (typeof init.body === 'string') body = init.body;
    else if (init.body instanceof Uint8Array) body = Buffer.from(init.body);
    else if (init.body != null) throw new Error('unsupported request body');
    const res = await opts.transport(target.toString(), {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
      maxBytes: opts.maxBytes ?? 8 * 1024 * 1024,
      idleTimeoutMs: 120_000,
    });
    if (res.status === 401) opts.onUnauthorized?.(res.headers.get('www-authenticate'));
    const out = new Headers();
    for (const name of PASSED_HEADERS) {
      const value = res.headers.get(name);
      if (value !== null) out.set(name, value);
    }
    const bytes = NULL_BODY.has(res.status) ? null : await res.arrayBuffer();
    return new Response(bytes, { status: res.status, statusText: res.statusText, headers: out });
  };
}
