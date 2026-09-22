/**
 * Plain `node:http` plumbing. No framework: the dashboard is nine read routes
 * and seven writes, and a router that fits on a screen is easier to audit than
 * a dependency.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionScope } from './sessions.js';

export const SESSION_COOKIE = 'buddi_session';
export const CSRF_COOKIE = 'buddi_csrf';
export const CSRF_HEADER = 'x-buddi-csrf';

/** The largest body any write accepts. Every one of them is a small object. */
export const MAX_BODY_BYTES = 64 * 1024;

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === '') continue;
    const value = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export interface CookieOptions {
  httpOnly?: boolean;
  maxAgeSeconds?: number;
  secure?: boolean;
  /** `Strict` by default, and nothing here has yet needed anything else. */
  sameSite?: 'Strict' | 'Lax';
  /** `/` by default. A preview scopes its cookie to its own subtree. */
  path?: string;
}

/**
 * `SameSite=Strict` on both cookies: the session must not ride along on a
 * request another site started, which is the first half of the CSRF answer
 * (the double-submit header is the second). Explicit HTTPS reverse-proxy
 * sessions add Secure; direct loopback HTTP sessions do not.
 */
export function cookieHeader(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path ?? '/'}`,
    `SameSite=${opts.sameSite ?? 'Strict'}`,
  ];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(opts.maxAgeSeconds))}`);
  return parts.join('; ');
}

/** Security headers every response carries. No CORS header is ever emitted. */
export function baseHeaders(): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cache-Control': 'no-store',
  };
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {},
): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    ...baseHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/**
 * The answer to anything that is not authenticated: a status and nothing else.
 *
 * No body, no `WWW-Authenticate`, no wording that distinguishes "wrong token"
 * from "expired session" from "there is no such route". A caller who is not the
 * owner learns exactly one bit.
 */
export function sendEmpty(
  res: ServerResponse,
  status: number,
  headers: Record<string, string | string[]> = {},
): void {
  res.writeHead(status, { ...baseHeaders(), 'Content-Length': '0', ...headers });
  res.end();
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    ...baseHeaders(),
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

export class BodyTooLargeError extends Error {
  override readonly name = 'BodyTooLargeError';
}

/** Read a JSON body, bounded. An empty body is `{}`, not an error. */
export async function readJsonBody(
  req: IncomingMessage,
  maxBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > maxBytes) throw new BodyTooLargeError('request body is too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SyntaxError('request body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** The address a rate limit is counted against. */
export function remoteKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * Is this address this machine?
 *
 * `127.0.0.0/8` and `::1`, plus the IPv4-mapped spelling node reports when the
 * socket is IPv6 (`::ffff:127.0.0.1`). Nothing else: a tailnet address
 * (`100.64.0.0/10`) is *not* local — it is a machine somewhere else that can
 * currently reach this one, which is exactly the case the shorter remote
 * lifetime exists for.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  const v4 = a.startsWith('::ffff:') ? a.slice('::ffff:'.length) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * Where a request came from, for the session lifetime it earns.
 *
 * The socket can prove a request is remote, never a forwarded header. Proxy
 * metadata or a non-loopback Host can only DOWNGRADE a local socket to remote;
 * they cannot authenticate anyone or elevate remote access. This prevents a
 * loopback reverse proxy (e.g. Tailscale Serve) inheriting local auto-login.
 */
export function requestScope(req: IncomingMessage): SessionScope {
  if (!isLoopbackAddress(req.socket.remoteAddress)) return 'remote';
  if (Object.keys(req.headers).some((key) => key === 'forwarded' || key === 'x-real-ip' || key.startsWith('x-forwarded-') || key.startsWith('tailscale-'))) return 'remote';
  if (req.headers.host) {
    try {
      const host = new URL(`http://${req.headers.host}`).hostname;
      if (host !== 'localhost' && !isLoopbackAddress(host)) return 'remote';
    } catch { return 'remote'; }
  }
  return 'local';
}

/** `Origin`, or the origin of `Referer`, or undefined. Never guessed. */
export function requestOrigin(req: IncomingMessage): string | undefined {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') return origin;
  const referer = req.headers.referer;
  if (typeof referer === 'string' && referer !== '') {
    try {
      return new URL(referer).origin;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** The request path and query, with a hostless URL tolerated. */
export function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://buddi.invalid');
}

export function first(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}
