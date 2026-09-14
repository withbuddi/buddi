/**
 * Plain `node:http` plumbing. No framework: the dashboard is nine read routes
 * and seven writes, and a router that fits on a screen is easier to audit than
 * a dependency.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

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
}

/**
 * `SameSite=Strict` on both cookies: the session must not ride along on a
 * request another site started, which is the first half of the CSRF answer
 * (the double-submit header is the second). `Secure` is deliberately absent —
 * the binding is plain-HTTP loopback, and a `Secure` cookie there is a cookie
 * the browser drops.
 */
export function cookieHeader(name: string, value: string, opts: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Strict'];
  if (opts.httpOnly !== false) parts.push('HttpOnly');
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
