/**
 * The dashboard's secret, and the one-time tickets minted from it.
 *
 * Two different things, on purpose:
 *
 *  - **The token** is long, random, generated once and kept in the vault under
 *    `BUDDI_WEB_TOKEN` (or, where there is no usable vault, in a `0600` file
 *    under the data dir). It never appears in a URL, a log line or an error.
 *  - **A ticket** is what `buddi dashboard` puts in `?t=…`. It is an HMAC over
 *    a nonce and an expiry, keyed by the token — so the CLI can mint one with
 *    no shared state with the running server, the server can verify it with no
 *    round trip, and the *nonce* is what makes it single-use: the server
 *    remembers the nonces it has spent and refuses a second presentation.
 *
 * A URL that leaks (shell history, a screenshot) is therefore worth nothing a
 * few minutes later, and worth nothing at all if it has already been opened.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createVault, type Vault } from '@buddi/core';
import { dataDir } from './config.js';

/** The vault entry, and the environment name that overrides it. */
export const WEB_TOKEN_SECRET = 'BUDDI_WEB_TOKEN';

/** 32 random bytes, base64url. Long enough that guessing is not a threat model. */
export const TOKEN_BYTES = 32;

/** How long a `?t=` ticket stands. It is opened seconds after it is printed. */
export const TICKET_TTL_MS = 5 * 60_000;

export type TokenSource = 'env' | 'vault' | 'file';

export interface WebToken {
  token: string;
  source: TokenSource;
  /** Set when the token was created by this call rather than found. */
  created: boolean;
}

export function webTokenFile(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = (env.BUDDI_WEB_TOKEN_FILE ?? '').trim();
  return explicit !== '' ? explicit : path.join(dataDir(env), 'web-token');
}

export interface EnsureTokenOptions {
  env?: NodeJS.ProcessEnv;
  /** Injected in tests. Absent means "ask this machine" (`BUDDI_VAULT`). */
  vault?: Vault | undefined;
  /** Look only; never create. Used by `buddi doctor`. */
  readOnly?: boolean;
}

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

function readFileToken(file: string): string | null {
  try {
    const raw = readFileSync(file, 'utf8').trim();
    return raw === '' ? null : raw;
  } catch {
    return null;
  }
}

function writeFileToken(file: string, token: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  // `writeFileSync`'s mode is only applied on creation; an existing file keeps
  // whatever it had, so the permission is asserted rather than hoped for.
  chmodSync(file, 0o600);
}

/**
 * The token this installation uses, creating one the first time.
 *
 * Order: the environment (an owner who pins it explicitly), then the vault,
 * then the file. A vault that is locked or missing is not fatal — the file is
 * the documented fallback, and it is the same fallback the CLI and the server
 * both reach, so `buddi dashboard` and `buddi serve` always agree.
 */
export async function ensureWebToken(opts: EnsureTokenOptions = {}): Promise<WebToken> {
  const env = opts.env ?? process.env;
  const fromEnv = (env[WEB_TOKEN_SECRET] ?? '').trim();
  if (fromEnv !== '' && fromEnv !== '<vault>' && fromEnv !== '"<vault>"') {
    return { token: fromEnv, source: 'env', created: false };
  }

  const vault = opts.vault === undefined ? createVault({ env }) : opts.vault;
  if (vault) {
    try {
      const value = await vault.get(WEB_TOKEN_SECRET);
      if (value !== null && value.trim() !== '') {
        return { token: value.trim(), source: 'vault', created: false };
      }
    } catch {
      // Locked or unavailable: the file below is the answer, not a crash.
    }
  }

  const file = webTokenFile(env);
  const existing = readFileToken(file);
  if (existing) return { token: existing, source: 'file', created: false };

  if (opts.readOnly) {
    throw new WebTokenMissingError('no dashboard token has been created yet');
  }

  const token = newToken();
  if (vault) {
    try {
      await vault.set(WEB_TOKEN_SECRET, token);
      return { token, source: 'vault', created: true };
    } catch {
      // Fall through to the file.
    }
  }
  writeFileToken(file, token);
  return { token, source: 'file', created: true };
}

export class WebTokenMissingError extends Error {
  override readonly name = 'WebTokenMissingError';
  readonly code = 'web-token-missing';
}

/** Does a token exist yet? For `buddi doctor`, which must never create one. */
export async function webTokenExists(opts: EnsureTokenOptions = {}): Promise<TokenSource | null> {
  try {
    const found = await ensureWebToken({ ...opts, readOnly: true });
    return found.source;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Tickets
 * ------------------------------------------------------------------ */

function sign(token: string, payload: string): string {
  return createHmac('sha256', token).update(payload, 'utf8').digest('base64url');
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** `<nonce>.<expiryMs>.<hmac>` — opaque to everything but this file. */
export function mintTicket(token: string, now: Date = new Date(), ttlMs = TICKET_TTL_MS): string {
  const nonce = randomBytes(12).toString('base64url');
  const exp = now.getTime() + ttlMs;
  const payload = `${nonce}.${exp}`;
  return `${payload}.${sign(token, payload)}`;
}

export type TicketCheck =
  | { ok: true; nonce: string; expiresAt: Date }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' };

export function verifyTicket(token: string, ticket: string, now: Date = new Date()): TicketCheck {
  const parts = (ticket ?? '').split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [nonce, expRaw, sig] = parts as [string, string, string];
  const exp = Number(expRaw);
  if (nonce === '' || !Number.isFinite(exp)) return { ok: false, reason: 'malformed' };
  if (!constantTimeEqual(sign(token, `${nonce}.${expRaw}`), sig)) {
    return { ok: false, reason: 'bad-signature' };
  }
  if (exp <= now.getTime()) return { ok: false, reason: 'expired' };
  return { ok: true, nonce, expiresAt: new Date(exp) };
}
