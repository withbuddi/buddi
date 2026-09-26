/**
 * A wildcard origin a browser binding may name (docs/owner-secrets.md §3):
 * `https://*.wikimedia.org`. The scheme is exact, the port is exact when there
 * is one, and `*.` stands for one or more labels to the left of a fixed
 * suffix, which may not be a public suffix. Nothing else is a pattern.
 *
 * Pure, and imports only the suffix list: the dashboard reads this file too.
 */
import { isPublicSuffix } from './public-suffixes.js';

/** A parsed pattern: its canonical text, and what an origin must have to match it. */
export interface OriginPattern {
  /** `https://*.wikimedia.org`, host lower-cased, port only when not the default. */
  pattern: string;
  protocol: string;
  suffix: string;
  port: string;
}

/** Why a text is not a pattern: `*` somewhere else, a public suffix, or not an origin at all. */
export type OriginPatternParse =
  | { ok: true; value: OriginPattern }
  | { ok: false; reason: 'placement' | 'public-suffix' | 'invalid' };

/** Whether a text is meant as a pattern: it holds a `*`. */
export function isOriginPattern(text: unknown): text is string {
  return typeof text === 'string' && text.includes('*');
}

/**
 * Read `scheme://*.suffix[:port]`, cut to its origin the way a typed
 * address is. Credentials, an IP address or a `*` anywhere but the first
 * label are refused.
 */
export function parseOriginPattern(text: string): OriginPatternParse {
  const match = /^(https?):\/\/([^/?#@\s]+)(?:[/?#]\S*)?$/i.exec(text.trim());
  if (match === null) return { ok: false, reason: 'invalid' };
  const [, scheme, hostPort] = match as unknown as [string, string, string];
  if (!hostPort.startsWith('*.') || hostPort.slice(2).includes('*')) return { ok: false, reason: 'placement' };
  let url: URL;
  try { url = new URL(`${scheme.toLowerCase()}://${hostPort.slice(2)}`); } catch { return { ok: false, reason: 'invalid' }; }
  const suffix = url.hostname;
  if (suffix === '' || suffix.startsWith('[') || /^[\d.]+$/.test(suffix) || suffix.startsWith('.') || suffix.includes('..')) return { ok: false, reason: 'invalid' };
  if (isPublicSuffix(suffix)) return { ok: false, reason: 'public-suffix' };
  return { ok: true, value: { pattern: `${url.protocol}//*.${url.host}`, protocol: url.protocol, suffix, port: url.port } };
}

/**
 * Whether a real origin sits under a pattern: same scheme, same port, and a
 * host with at least one label before the fixed suffix. The suffix itself
 * does not match — `*.wikimedia.org` is not `wikimedia.org`.
 */
export function originMatchesPattern(origin: string, pattern: string): boolean {
  if (origin.includes('*')) return false;
  const parsed = parseOriginPattern(pattern);
  if (!parsed.ok) return false;
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  const { protocol, suffix, port } = parsed.value;
  return url.protocol === protocol && url.port === port && url.hostname.length > suffix.length + 1 && url.hostname.endsWith(`.${suffix}`);
}
