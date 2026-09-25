/**
 * Sessions, CSRF tokens, spent tickets and the auth rate limit.
 *
 * All four are in-process and deliberately so: a dashboard session is not a
 * durable fact about the installation, and a restart logging the owner out is
 * the correct behaviour for a page that can approve an effect. Nothing here
 * reaches the database, and nothing here is ever written to a log.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * How long a session is honoured **without any activity**, by where it was
 * established. Both are idle lifetimes, not absolute ones: a session in use
 * never expires underneath the person using it (see `get`), and a session
 * nobody has touched for this long is gone.
 *
 * The two numbers differ because the two threats differ. On loopback the only
 * party a session keeps out is another human with a login on this machine —
 * the browser-borne attack is already answered by `SameSite=Strict`, the
 * Origin check and the absence of CORS, and a hostile process running as the
 * owner can read `.env` and the keychain whatever this number says. Weeks is
 * therefore the honest local answer, and re-typing a terminal command twice a
 * day was never buying anything. A session established from anywhere else is a
 * session reachable from a network, where a stolen laptop-shaped assumption no
 * longer holds, so it keeps what the dashboard has always had.
 */
export const LOCAL_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
export const REMOTE_SESSION_TTL_MS = 12 * 60 * 60_000;

/**
 * How long a session established through Tailscale may live *however much* it
 * is used.
 *
 * The idle lifetime above is a sliding one, so a browser polling the dashboard
 * keeps its session forever. That is the right answer for a session whose
 * credential is the machine itself, and the wrong one for a session whose
 * credential is a tailnet identity that can be revoked, transferred or stolen
 * with a device. Seven days is the outer edge: past it the browser signs in
 * through Tailscale again, which costs the owner nothing and costs a walked-off
 * device everything.
 */
export const TAILSCALE_SESSION_MAX_MS = 7 * 24 * 60 * 60_000;

/** Where a session was established from. Decided from the socket, never a header. */
export type SessionScope = 'local' | 'remote';

/**
 * *How* a session was established, recorded when it is minted and never
 * re-decided.
 *
 * `local` is a request that arrived on loopback with no proxy metadata on it —
 * the open mint, or a ticket exchanged from this machine. `ticket` is a ticket
 * exchanged from anywhere else. `tailscale` is an identity the local daemon
 * confirmed. This lives on the session rather than in a second map beside it,
 * so provenance cannot drift out of step with the session it describes, and so
 * a route that must refuse everything but "this machine" can simply say so.
 */
export type SessionVia = 'local' | 'ticket' | 'tailscale';

/** What established a session, as `create` is told it. */
export interface SessionProvenance {
  via: SessionVia;
  /** The daemon-confirmed login, when `via` is `tailscale`. */
  tailscaleLogin?: string;
  /** The tailnet address it was confirmed at. */
  tailscaleAddress?: string;
  /** The display name, kept only so the page can greet the person by it. */
  tailscaleName?: string;
}

export const SESSION_TTL_MS: Readonly<Record<SessionScope, number>> = {
  local: LOCAL_SESSION_TTL_MS,
  remote: REMOTE_SESSION_TTL_MS,
};

/**
 * How far through its life the browser's copy of a cookie is allowed to get
 * before it is re-issued.
 *
 * Sliding the *server's* expiry is free — it is a field on a map entry. Sliding
 * the *browser's* costs a `Set-Cookie` on the response, and doing that on every
 * request would put two of them on every poll, every stream event and every
 * static asset for no gain. Re-issuing once the copy is halfway through its
 * life gives the same guarantee for a tiny fraction of the headers: a browser
 * that is being used always holds a cookie with at least half the lifetime
 * left, so it can never be the cookie that expires first.
 */
export const COOKIE_REFRESH_AFTER = 0.5;

/** Failed authentications one address may make before it is answered 429. */
export const AUTH_MAX_ATTEMPTS = 10;
export const AUTH_WINDOW_MS = 60_000;

export interface Session {
  id: string;
  /** The double-submit value. Readable by the page, required on every write. */
  csrf: string;
  /** Loopback or not, fixed at the ticket exchange and never re-decided. */
  scope: SessionScope;
  /** What established it, and — through Tailscale — whose identity did. */
  via: SessionVia;
  tailscaleLogin?: string;
  tailscaleAddress?: string;
  tailscaleName?: string;
  /** The idle lifetime this session runs on, in ms. `SESSION_TTL_MS[scope]`. */
  ttlMs: number;
  createdAt: Date;
  expiresAt: Date;
  /** The moment no amount of use extends past, where the session has one. */
  absoluteExpiresAt?: Date;
  /** When the browser was last handed this cookie. Drives the refresh rule. */
  cookieIssuedAt: Date;
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
  readonly #ttl: Record<SessionScope, number>;
  readonly #tailscaleMaxMs: number;

  constructor(ttlMs: Partial<Record<SessionScope, number>> = {}, tailscaleMaxMs: number = TAILSCALE_SESSION_MAX_MS) {
    this.#ttl = { ...SESSION_TTL_MS, ...ttlMs };
    this.#tailscaleMaxMs = tailscaleMaxMs;
  }

  /** The idle lifetime a session established from `scope` gets. */
  ttlFor(scope: SessionScope): number {
    return this.#ttl[scope];
  }

  create(
    scope: SessionScope,
    now: Date = new Date(),
    provenance: SessionProvenance = { via: scope === 'local' ? 'local' : 'ticket' },
  ): Session {
    this.#prune(now);
    const ttlMs = this.#ttl[scope];
    const session: Session = {
      id: id(),
      csrf: id(24),
      scope,
      via: provenance.via,
      ...(provenance.tailscaleLogin !== undefined ? { tailscaleLogin: provenance.tailscaleLogin } : {}),
      ...(provenance.tailscaleAddress !== undefined ? { tailscaleAddress: provenance.tailscaleAddress } : {}),
      ...(provenance.tailscaleName !== undefined ? { tailscaleName: provenance.tailscaleName } : {}),
      ttlMs,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
      ...(provenance.via === 'tailscale' ? { absoluteExpiresAt: new Date(now.getTime() + this.#tailscaleMaxMs) } : {}),
      cookieIssuedAt: now,
    };
    this.#sessions.set(session.id, session);
    return session;
  }

  /**
   * Forget every session matching this, and say how many went.
   *
   * What the setting page uses to revoke the sessions an identity earned the
   * moment that identity stops being allowed one: turning the switch off, or
   * naming a different login, empties the tailnet's access immediately rather
   * than at the next request that happens to be made.
   */
  forget(matches: (session: Session) => boolean): number {
    let gone = 0;
    for (const [key, session] of this.#sessions) {
      if (matches(session)) {
        this.#sessions.delete(key);
        gone += 1;
      }
    }
    return gone;
  }

  /**
   * The live session for this cookie, sliding its expiry.
   *
   * `scope` is where *this request* came from, and it must match where the
   * session was established. A cookie minted on loopback is not honoured when
   * it arrives from the network: the long local lifetime is then a fact about
   * this machine rather than a credential that got a longer life by accident.
   * (A browser will not send it across hosts in the first place; this is the
   * belt to that suspenders.)
   */
  get(
    sessionId: string | undefined,
    scope: SessionScope,
    now: Date = new Date(),
  ): Session | undefined {
    if (!sessionId) return undefined;
    const session = this.#sessions.get(sessionId);
    if (!session) return undefined;
    if (this.#dead(session, now)) {
      this.#sessions.delete(sessionId);
      return undefined;
    }
    if (session.scope !== scope) return undefined;
    session.expiresAt = new Date(now.getTime() + session.ttlMs);
    return session;
  }

  /**
   * Should this response carry a fresh cookie? Mutating: a `true` answer marks
   * the cookie as issued now, so the caller must actually send it.
   */
  renewCookie(session: Session, now: Date = new Date()): boolean {
    const age = now.getTime() - session.cookieIssuedAt.getTime();
    if (age < session.ttlMs * COOKIE_REFRESH_AFTER) return false;
    session.cookieIssuedAt = now;
    return true;
  }

  /** `Max-Age` for this session's cookies, in whole seconds. */
  static maxAgeSeconds(session: Session): number {
    return Math.floor(session.ttlMs / 1000);
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
      if (this.#dead(session, now)) this.#sessions.delete(key);
    }
  }

  /** Idle too long, or past the absolute edge no use extends. */
  #dead(session: Session, now: Date): boolean {
    if (session.expiresAt.getTime() <= now.getTime()) return true;
    return session.absoluteExpiresAt !== undefined && session.absoluteExpiresAt.getTime() <= now.getTime();
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
/**
 * How long after its first use a ticket still opens. A browser opens a pasted
 * link more than once — the omnibox prerenders it, then the navigation fetches
 * it again — and the second fetch used to be the one the owner saw, as a blank
 * 401. Within this window the same nonce is honoured again; after it, never.
 * The link was a bearer for five minutes before its first use, so a few
 * seconds after it changes nothing about who could have had it.
 */
export const TICKET_REUSE_GRACE_MS = 10_000;

export class SpentTickets {
  readonly #spent = new Map<string, { until: number; spentAt: number }>();

  /** True the first time a nonce is seen and within the grace after it, false on every later presentation. */
  spend(nonce: string, expiresAt: Date, now: Date = new Date()): boolean {
    this.#prune(now);
    const seen = this.#spent.get(nonce);
    if (seen !== undefined) return now.getTime() - seen.spentAt < TICKET_REUSE_GRACE_MS;
    this.#spent.set(nonce, { until: expiresAt.getTime(), spentAt: now.getTime() });
    return true;
  }

  #prune(now: Date): void {
    for (const [nonce, { until }] of this.#spent) {
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
