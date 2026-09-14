/**
 * Sessions, CSRF tokens, spent tickets and the auth rate limit.
 *
 * All four are in-process and deliberately so: a dashboard session is not a
 * durable fact about the installation, and a restart logging the owner out is
 * the correct behaviour for a page that can approve an effect. Nothing here
 * reaches the database, and nothing here is ever written to a log.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

/** How long a session cookie is honoured without any activity. */
export const SESSION_TTL_MS = 12 * 60 * 60_000;

/** Failed authentications one address may make before it is answered 429. */
export const AUTH_MAX_ATTEMPTS = 10;
export const AUTH_WINDOW_MS = 60_000;

export interface Session {
  id: string;
  /** The double-submit value. Readable by the page, required on every write. */
  csrf: string;
  createdAt: Date;
  expiresAt: Date;
}

function id(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function equal(a: string, b: string): boolean {
  const ab = Buffer.from(a ?? '', 'utf8');
  const bb = Buffer.from(b ?? '', 'utf8');
  return ab.length > 0 && ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly #ttlMs: number;

  constructor(ttlMs: number = SESSION_TTL_MS) {
    this.#ttlMs = ttlMs;
  }

  create(now: Date = new Date()): Session {
    this.#prune(now);
    const session: Session = {
      id: id(),
      csrf: id(24),
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.#ttlMs),
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  /** The live session for this cookie, sliding its expiry. */
  get(sessionId: string | undefined, now: Date = new Date()): Session | undefined {
    if (!sessionId) return undefined;
    const session = this.#sessions.get(sessionId);
    if (!session) return undefined;
    if (session.expiresAt.getTime() <= now.getTime()) {
      this.#sessions.delete(sessionId);
      return undefined;
    }
    session.expiresAt = new Date(now.getTime() + this.#ttlMs);
    return session;
  }

  /** Constant-time double-submit check. */
  static csrfMatches(session: Session, presented: string | undefined): boolean {
    return presented !== undefined && equal(session.csrf, presented);
  }

  destroy(sessionId: string | undefined): void {
    if (sessionId) this.#sessions.delete(sessionId);
  }

  get size(): number {
    return this.#sessions.size;
  }

  #prune(now: Date): void {
    for (const [key, session] of this.#sessions) {
      if (session.expiresAt.getTime() <= now.getTime()) this.#sessions.delete(key);
    }
  }
}

/**
 * The nonces of tickets already exchanged.
 *
 * This is what "one-time" means in code: the signature says the ticket is
 * genuine and unexpired, and this says it has not been used. Entries are kept
 * until the ticket they belong to would have expired anyway — a nonce cannot
 * come back after that, because its own signature no longer verifies.
 */
export class SpentTickets {
  readonly #spent = new Map<string, number>();

  /** True the first time a nonce is seen, false on every later presentation. */
  spend(nonce: string, expiresAt: Date, now: Date = new Date()): boolean {
    this.#prune(now);
    if (this.#spent.has(nonce)) return false;
    this.#spent.set(nonce, expiresAt.getTime());
    return true;
  }

  #prune(now: Date): void {
    for (const [nonce, until] of this.#spent) {
      if (until <= now.getTime()) this.#spent.delete(nonce);
    }
  }

  get size(): number {
    return this.#spent.size;
  }
}

/**
 * A fixed window per remote address. Crude and sufficient: the dashboard is
 * bound to loopback, so this exists to make a local brute force pointless, not
 * to survive a botnet.
 */
export class RateLimiter {
  readonly #hits = new Map<string, { count: number; resetAt: number }>();
  readonly #max: number;
  readonly #windowMs: number;

  constructor(max: number = AUTH_MAX_ATTEMPTS, windowMs: number = AUTH_WINDOW_MS) {
    this.#max = max;
    this.#windowMs = windowMs;
  }

  /** True when this address is over its budget and should be answered 429. */
  blocked(key: string, now: Date = new Date()): boolean {
    const entry = this.#hits.get(key);
    if (!entry || entry.resetAt <= now.getTime()) return false;
    return entry.count >= this.#max;
  }

  /** Record one failed attempt. Successes never count against the budget. */
  fail(key: string, now: Date = new Date()): void {
    const entry = this.#hits.get(key);
    if (!entry || entry.resetAt <= now.getTime()) {
      this.#hits.set(key, { count: 1, resetAt: now.getTime() + this.#windowMs });
      return;
    }
    entry.count += 1;
  }

  reset(key: string): void {
    this.#hits.delete(key);
  }
}
