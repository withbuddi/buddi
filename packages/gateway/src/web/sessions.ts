/**
 * Sessions, CSRF tokens, spent tickets and the auth rate limit.
 *
 * Sessions are kept in `core.dashboard_sessions` with a small cache in front,
 * so a restart or an upgrade no longer signs the owner out (docs/web.md,
 * "Sessions"). What is stored is a hash of the session id, never the id: a
 * copy of the table cannot be replayed as a cookie. The CSRF value is derived
 * from the id rather than stored at all. The rate limit stays in memory.
 * Nothing here is ever written to a log.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isAccessProviderId, type AccessProviderId } from './access/provider.js';

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

/**
 * The outer edge for a session any trusted access provider minted
 * (specs/trusted-access.md §3.1, `absoluteCapMs`): a provider may ask for less
 * (a Cloudflare JWT's own lifetime), never more.
 */
export const PROVIDER_SESSION_MAX_MS = TAILSCALE_SESSION_MAX_MS;

/** Where a session was established from. Decided from the socket, never a header. */
export type SessionScope = 'local' | 'remote';

/**
 * *How* a session was established, recorded when it is minted and never
 * re-decided.
 *
 * `local` is a request that arrived on loopback with no proxy metadata on it —
 * the open mint, or a ticket exchanged from this machine. `ticket` is a ticket
 * exchanged from anywhere else. `provider` is an identity a trusted access
 * provider verified (`provider` names which: Tailscale's daemon, Cloudflare
 * Access's JWT). `token` is an owner API token (`api-tokens.ts`); such a session is
 * never stored. This lives on the session rather than in a second map beside it,
 * so provenance cannot drift out of step with the session it describes, and so
 * a route that must refuse everything but "this machine" can simply say so.
 */
export type SessionVia = 'local' | 'ticket' | 'provider' | 'token';

/**
 * Who holds the session: a person's browser, or one of buddi's own
 * command-line clients (`buddi mcp`, `buddi connections`), which say so with
 * the `x-buddi-client: mcp` header on the ticket exchange that mints the
 * session (the header alone, on the open binding, earns nothing), or a program
 * holding an API token (`api`). The lock screen covers browsers only (docs/dashboard.md, "Lock screen").
 */
export type SessionClient = 'browser' | 'mcp' | 'api';

/** Why a session is locked: Lock now, nobody used it for the delay, or it began while a PIN was set. */
export type LockReason = 'owner' | 'idle' | 'start';

/** What established a session, as `create` is told it. */
export interface SessionProvenance {
  via: SessionVia;
  /** Who holds it; a browser unless buddi's own client said otherwise. */
  client?: SessionClient;
  /** Which provider verified it, when `via` is `provider`. */
  provider?: AccessProviderId;
  /** Who it verified: the login or email `confirm` checks again on every request. */
  providerSubject?: string;
  /** What else the provider keeps (a tailnet address, a display name). Shown, never trusted. */
  providerDetail?: Record<string, string>;
  /** The provider's cap on this session, when shorter than `PROVIDER_SESSION_MAX_MS`. */
  absoluteCapMs?: number;
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
  /** What established it, and — through a provider — whose identity did. */
  via: SessionVia;
  provider?: AccessProviderId;
  providerSubject?: string;
  providerDetail?: Record<string, string>;
  /** The idle lifetime this session runs on, in ms. `SESSION_TTL_MS[scope]`. */
  ttlMs: number;
  createdAt: Date;
  expiresAt: Date;
  /** The moment no amount of use extends past, where the session has one. */
  absoluteExpiresAt?: Date;
  /** When the browser was last handed this cookie. Drives the refresh rule. */
  cookieIssuedAt: Date;
  /** A browser, or buddi's own command-line client. */
  client: SessionClient;
  /** When the owner last used it, as the page reports. Polls and streams do not count. */
  activeAt: Date;
  /** When it locked; absent while it is open. */
  lockedAt?: Date;
  lockReason?: LockReason;
}

function id(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function equal(a: string, b: string): boolean {
  const ab = Buffer.from(a ?? '', 'utf8');
  const bb = Buffer.from(b ?? '', 'utf8');
  return ab.length > 0 && ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * What the table stores in place of a session id: sha256, hex.
 *
 * A plain hash is enough because the id is 256 random bits — there is nothing
 * to guess, so nothing a slow hash would slow down.
 */
export function sessionIdHash(sessionId: string): string {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex');
}

/**
 * The CSRF value for a session, derived from its id.
 *
 * Derived rather than random so it never has to be stored: after a restart the
 * request presents the session id, and the CSRF value it must also echo is
 * recomputed from it. HMAC keyed by the id is one-way — the page can read the
 * CSRF cookie, and that reveals nothing about the HttpOnly id — and another
 * site still cannot read either cookie, which is all double-submit asks of it.
 */
export function csrfFor(sessionId: string): string {
  return createHmac('sha256', sessionId).update('buddi-csrf-v1').digest('base64url').slice(0, 32);
}

/** Just enough of `pg.Pool` for the session table. */
export interface SessionDb {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

/**
 * A session as `forget` offers it: the stored fields, and the id only when this
 * process has seen the cookie (a row read back from the table has no id to give).
 */
export type SessionRecord = Omit<Session, 'id' | 'csrf'> & { id?: string };

export interface SessionStoreOptions {
  /** The database the sessions are kept in. Without one they live in memory only. */
  db?: SessionDb | undefined;
  log?: ((line: string) => void) | undefined;
}

/**
 * The longest the stored idle edge may lag the live one.
 *
 * Sliding the in-memory expiry is free and happens on every request; writing
 * it back is a database round trip, so it is done at most this often per
 * session (or a tenth of the idle lifetime, when that is shorter). A restart
 * can therefore cost a session at most this much of its idle lifetime, never
 * extend it.
 */
export const SESSION_WRITE_EVERY_MS = 5 * 60_000;

/** How often expired rows are swept from the table. */
export const SESSION_SWEEP_EVERY_MS = 10 * 60_000;

interface Row {
  id_hash: string;
  scope: SessionScope;
  via: SessionVia;
  provider_id: string | null;
  provider_subject: string | null;
  provider_detail: Record<string, unknown> | string | null;
  ttl_ms: string | number;
  created_at: Date | string;
  expires_at: Date | string;
  absolute_expires_at: Date | string | null;
  locked_at?: Date | string | null;
  lock_reason?: LockReason | null;
  active_at?: Date | string | null;
  client?: SessionClient | null;
}

const COLUMNS = `id_hash, scope, via, provider_id, provider_subject, provider_detail, ttl_ms,
  created_at, expires_at, absolute_expires_at, locked_at, lock_reason, active_at, client`;

/** A stored `provider_detail`, as strings only; anything else is dropped. */
function detailOf(value: Record<string, unknown> | string | null): Record<string, string> | undefined {
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return undefined; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** How often a session's `active_at` is written back, at most. */
export const ACTIVE_WRITE_EVERY_MS = 60_000;

/** Is this a row the table could have produced? Anything else is a miss. */
function isRow(value: unknown): value is Row {
  const row = value as Partial<Row> | null;
  return !!row && typeof row.id_hash === 'string'
    && (row.scope === 'local' || row.scope === 'remote')
    && (row.via === 'local' || row.via === 'ticket' || (row.via === 'provider' && isAccessProviderId(row.provider_id) && typeof row.provider_subject === 'string'))
    && row.created_at !== undefined && row.expires_at !== undefined && row.ttl_ms !== undefined;
}

export class SessionStore {
  /** Keyed by the id's hash, so the cache and the table speak the same key. */
  readonly #sessions = new Map<string, Session>();
  /** When each cached session's idle edge was last written back. */
  readonly #persistedAt = new Map<string, number>();
  /** When each cached session's `active_at` was last written back. */
  readonly #activeWrittenAt = new Map<string, number>();
  /** Destroyed while a read of the table may still be in flight. */
  readonly #revoked = new Set<string>();
  readonly #ttl: Record<SessionScope, number>;
  readonly #providerMaxMs: number;
  readonly #db: SessionDb | undefined;
  readonly #log: (line: string) => void;
  /** Every table operation, in order: a revoke can never be overtaken by a read. */
  #chain: Promise<void> = Promise.resolve();
  #sweptAt = Number.NEGATIVE_INFINITY;

  constructor(
    ttlMs: Partial<Record<SessionScope, number>> = {},
    providerMaxMs: number = PROVIDER_SESSION_MAX_MS,
    options: SessionStoreOptions = {},
  ) {
    this.#ttl = { ...SESSION_TTL_MS, ...ttlMs };
    this.#providerMaxMs = providerMaxMs;
    this.#db = options.db;
    this.#log = options.log ?? ((line: string) => console.error(line));
  }

  /** The idle lifetime a session established from `scope` gets. */
  ttlFor(scope: SessionScope): number {
    return this.#ttl[scope];
  }

  /**
   * A new session. Stored unless `persist` is false — which is how the open
   * loopback gate mints its silent sessions: one is minted again for free on
   * the next request, so there is nothing to keep across a restart, and a
   * cookie-less local poller must not add a row per request.
   */
  create(
    scope: SessionScope,
    now: Date = new Date(),
    provenance: SessionProvenance = { via: scope === 'local' ? 'local' : 'ticket' },
    options: { persist?: boolean; locked?: LockReason } = {},
  ): Session {
    this.#prune(now);
    const ttlMs = this.#ttl[scope];
    const sessionId = id();
    const session: Session = {
      id: sessionId,
      csrf: csrfFor(sessionId),
      scope,
      via: provenance.via,
      ...(provenance.provider !== undefined ? { provider: provenance.provider } : {}),
      ...(provenance.providerSubject !== undefined ? { providerSubject: provenance.providerSubject } : {}),
      ...(provenance.providerDetail !== undefined ? { providerDetail: { ...provenance.providerDetail } } : {}),
      ttlMs,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
      ...(provenance.via === 'provider'
        ? { absoluteExpiresAt: new Date(now.getTime() + Math.min(this.#providerMaxMs, provenance.absoluteCapMs ?? this.#providerMaxMs)) }
        : {}),
      cookieIssuedAt: now,
      client: provenance.client ?? 'browser',
      activeAt: now,
      ...(options.locked ? { lockedAt: now, lockReason: options.locked } : {}),
    };
    const key = sessionIdHash(sessionId);
    this.#sessions.set(key, session);
    if (options.persist !== false && this.#db) {
      this.#persistedAt.set(key, now.getTime());
      const db = this.#db;
      void this.#enqueue('storing a session', () => db.query(
        `insert into core.dashboard_sessions (${COLUMNS}, last_seen_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $8)
         on conflict (id_hash) do nothing`,
        [key, session.scope, session.via, session.provider ?? null, session.providerSubject ?? null,
          session.providerDetail ? JSON.stringify(session.providerDetail) : null, ttlMs, session.createdAt, session.expiresAt, session.absoluteExpiresAt ?? null,
          session.lockedAt ?? null, session.lockReason ?? null, session.activeAt, session.client],
      ));
      this.#maybeSweep(now);
    }
    return session;
  }

  /**
   * Forget every session matching this — in memory and in the table — and say
   * how many went.
   *
   * What the setting page uses to revoke the sessions an identity earned the
   * moment that identity stops being allowed one: turning the switch off, or
   * naming a different login, empties the tailnet's access immediately rather
   * than at the next request that happens to be made. Rows this process never
   * saw a cookie for are offered without an `id`.
   */
  async forget(matches: (session: SessionRecord) => boolean): Promise<number> {
    const gone = new Set<string>();
    for (const [key, session] of this.#sessions) {
      if (matches(session)) {
        this.#drop(key);
        gone.add(key);
      }
    }
    const db = this.#db;
    if (db) {
      await this.#enqueue('revoking sessions', async () => {
        const { rows } = await db.query(`select ${COLUMNS} from core.dashboard_sessions`);
        const drop: string[] = [...gone];
        for (const row of rows) {
          if (!isRow(row) || gone.has(row.id_hash)) continue;
          const { id: _id, csrf: _csrf, ...record } = this.#fromRow(row, undefined);
          if (matches(record)) { drop.push(row.id_hash); gone.add(row.id_hash); }
        }
        // A read queued before this one may have cached a row it is dropping.
        for (const key of drop) this.#drop(key);
        if (drop.length > 0) await db.query(`delete from core.dashboard_sessions where id_hash = any($1)`, [drop]);
      }, true);
    }
    return gone.size;
  }

  /**
   * The live session for this cookie, from memory only, sliding its expiry.
   *
   * `scope` is where *this request* came from, and it must match where the
   * session was established. A cookie minted on loopback is not honoured when
   * it arrives from the network: the long local lifetime is then a fact about
   * this machine rather than a credential that got a longer life by accident.
   * (A browser will not send it across hosts in the first place; this is the
   * belt to that suspenders.)
   *
   * The server asks `resolve`, which reads through to the table on a miss.
   */
  get(
    sessionId: string | undefined,
    scope: SessionScope,
    now: Date = new Date(),
  ): Session | undefined {
    if (!sessionId) return undefined;
    const key = sessionIdHash(sessionId);
    const session = this.#sessions.get(key);
    if (!session) return undefined;
    if (this.#dead(session, now)) {
      this.#drop(key);
      if (this.#db) void this.#deleteRows([key]);
      return undefined;
    }
    if (session.scope !== scope) return undefined;
    session.expiresAt = new Date(now.getTime() + session.ttlMs);
    this.#writeBack(key, session, now);
    return session;
  }

  /**
   * `get`, reading through to the table when this process has not seen the
   * cookie yet — after a restart, every session starts here.
   *
   * A row is honoured on exactly the terms a cached session is: past its idle
   * edge or its absolute one it is deleted and refused, and its scope must
   * match. A database that cannot be read is a miss, never an error page.
   */
  async resolve(
    sessionId: string | undefined,
    scope: SessionScope,
    now: Date = new Date(),
  ): Promise<Session | undefined> {
    if (!sessionId) return undefined;
    const key = sessionIdHash(sessionId);
    if (!this.#sessions.has(key) && this.#db && !this.#revoked.has(key)) {
      const db = this.#db;
      await this.#enqueue('reading a session', async () => {
        // Another request with the same cookie may have loaded it meanwhile.
        if (this.#sessions.has(key) || this.#revoked.has(key)) return;
        const { rows } = await db.query(`select ${COLUMNS} from core.dashboard_sessions where id_hash = $1`, [key]);
        const row = rows[0];
        if (!isRow(row) || row.id_hash !== key || this.#revoked.has(key)) return;
        this.#sessions.set(key, this.#fromRow(row, sessionId));
        this.#persistedAt.set(key, now.getTime());
      });
      this.#maybeSweep(now);
    }
    return this.get(sessionId, scope, now);
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

  /**
   * End this session, in memory at once and in the table before the returned
   * promise settles. Callers that revoke for a reason await it.
   */
  async destroy(sessionId: string | undefined): Promise<void> {
    if (!sessionId) return;
    const key = sessionIdHash(sessionId);
    this.#drop(key);
    if (this.#db) {
      this.#revoked.add(key);
      try {
        await this.#deleteRows([key], true);
      } finally {
        this.#revoked.delete(key);
      }
    }
  }

  /**
   * Lock this session (or open it, with `null`): in memory at once, and on
   * its row when it has one. The lock screen's own state, nothing more — the
   * gate in `lock.ts` is what answers a locked session 423.
   */
  setLock(session: Session, lock: { at: Date; reason: LockReason } | null): void {
    if (lock) {
      session.lockedAt = lock.at;
      session.lockReason = lock.reason;
    } else {
      delete session.lockedAt;
      delete session.lockReason;
    }
    const key = session.id ? sessionIdHash(session.id) : undefined;
    const db = this.#db;
    if (!db || !key || !this.#persistedAt.has(key)) return;
    void this.#enqueue(lock ? 'locking a session' : 'unlocking a session', () => db.query(
      `update core.dashboard_sessions set locked_at = $2, lock_reason = $3 where id_hash = $1`,
      [key, lock?.at ?? null, lock?.reason ?? null],
    ));
  }

  /**
   * The owner used this session now. Written back at most once a minute: a
   * restart can cost the lock at most that much of its delay, never add to it.
   */
  touch(session: Session, now: Date): void {
    const before = session.activeAt.getTime();
    session.activeAt = now;
    const key = session.id ? sessionIdHash(session.id) : undefined;
    const db = this.#db;
    if (!db || !key || !this.#persistedAt.has(key)) return;
    const written = this.#activeWrittenAt.get(key) ?? before;
    if (now.getTime() - written < ACTIVE_WRITE_EVERY_MS) return;
    this.#activeWrittenAt.set(key, now.getTime());
    void this.#enqueue('noting a session in use', () => db.query(
      `update core.dashboard_sessions set active_at = greatest(coalesce(active_at, $2), $2) where id_hash = $1`,
      [key, now],
    ));
  }

  /** Open every cached session: the PIN is gone. The table is cleared by whoever removed it. */
  unlockCached(): void {
    for (const session of this.#sessions.values()) {
      delete session.lockedAt;
      delete session.lockReason;
    }
  }

  /** Every table operation queued so far has settled. A test seam. */
  async flush(): Promise<void> {
    await this.#chain;
  }

  get size(): number {
    return this.#sessions.size;
  }

  #drop(key: string): void {
    this.#sessions.delete(key);
    this.#persistedAt.delete(key);
    this.#activeWrittenAt.delete(key);
  }

  #deleteRows(keys: string[], rethrow = false): Promise<void> {
    const db = this.#db;
    if (!db) return Promise.resolve();
    return this.#enqueue('revoking a session', () => db.query(
      `delete from core.dashboard_sessions where id_hash = any($1)`, [keys],
    ), rethrow);
  }

  /**
   * Write the sliding edge back, sparingly: at most once per
   * `SESSION_WRITE_EVERY_MS` (or a tenth of the idle lifetime) per session.
   */
  #writeBack(key: string, session: Session, now: Date): void {
    const db = this.#db;
    const last = this.#persistedAt.get(key);
    if (!db || last === undefined) return;
    const every = Math.min(SESSION_WRITE_EVERY_MS, session.ttlMs / 10);
    if (now.getTime() - last < every) return;
    this.#persistedAt.set(key, now.getTime());
    const expiresAt = session.expiresAt;
    void this.#enqueue('renewing a session', () => db.query(
      `update core.dashboard_sessions set expires_at = greatest(expires_at, $2), last_seen_at = $3 where id_hash = $1`,
      [key, expiresAt, now],
    ));
  }

  #maybeSweep(now: Date): void {
    const db = this.#db;
    if (!db || now.getTime() - this.#sweptAt < SESSION_SWEEP_EVERY_MS) return;
    this.#sweptAt = now.getTime();
    void this.#enqueue('sweeping expired sessions', () => db.query(
      `delete from core.dashboard_sessions where expires_at <= $1 or absolute_expires_at <= $1`, [now],
    ));
  }

  /** A stored row as a session. Its cookie is re-issued on the first response. */
  #fromRow(row: Row, sessionId: string | undefined): Session & { id: string } {
    const createdAt = new Date(row.created_at);
    return {
      id: sessionId ?? '',
      csrf: sessionId ? csrfFor(sessionId) : '',
      scope: row.scope,
      via: row.via,
      ...(row.via === 'provider' && isAccessProviderId(row.provider_id) ? { provider: row.provider_id } : {}),
      ...(row.provider_subject !== null ? { providerSubject: row.provider_subject } : {}),
      ...(detailOf(row.provider_detail) ? { providerDetail: detailOf(row.provider_detail) } : {}),
      ttlMs: Number(row.ttl_ms),
      createdAt,
      expiresAt: new Date(row.expires_at),
      ...(row.absolute_expires_at !== null ? { absoluteExpiresAt: new Date(row.absolute_expires_at) } : {}),
      // Unknown after a restart, so treated as old: the browser's copy is
      // refreshed on the first response rather than trusted to outlive it.
      cookieIssuedAt: createdAt,
      client: row.client === 'mcp' ? 'mcp' : 'browser',
      // A row from before the lock screen has no use on record: its last
      // renewal (the idle edge less the lifetime) is the best there is.
      activeAt: row.active_at ? new Date(row.active_at) : new Date(new Date(row.expires_at).getTime() - Number(row.ttl_ms)),
      ...(row.locked_at ? { lockedAt: new Date(row.locked_at), lockReason: row.lock_reason ?? 'owner' } : {}),
    };
  }

  /**
   * Run one table operation after every earlier one. A failure is logged by a
   * fixed sentence (never a value) and, unless `rethrow`, swallowed: the
   * dashboard keeps working from memory when the database hiccups.
   */
  #enqueue(what: string, op: () => Promise<unknown>, rethrow = false): Promise<void> {
    const run = this.#chain.then(async () => { await op(); });
    this.#chain = run.catch(() => {});
    return run.catch((err: unknown) => {
      this.#log(`web: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (rethrow) throw err;
    });
  }

  #prune(now: Date): void {
    for (const [key, session] of this.#sessions) {
      if (this.#dead(session, now)) this.#drop(key);
    }
  }

  /** Idle too long, or past the absolute edge no use extends. */
  #dead(session: Session, now: Date): boolean {
    if (session.expiresAt.getTime() <= now.getTime()) return true;
    return session.absoluteExpiresAt !== undefined && session.absoluteExpiresAt.getTime() <= now.getTime();
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

  /** How long until this address may try again, in ms; 0 when it is not blocked. */
  retryAfterMs(key: string, now: Date = new Date()): number {
    if (!this.blocked(key, now)) return 0;
    return Math.max(0, (this.#hits.get(key)?.resetAt ?? now.getTime()) - now.getTime());
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
    this.#seen.delete(key);
  }

  /** Stale credentials already counted, per address, until their window ends. */
  readonly #seen = new Map<string, { values: Set<string>; resetAt: number }>();

  /**
   * One failed attempt with a credential in it — a session cookie that is no
   * longer valid, a ticket that is wrong. Guessing means presenting new values,
   * so each distinct value counts once a window; the same stale cookie sent by
   * a tab or an extension that nobody is watching counts once, however often
   * it polls, and cannot hold the address locked out on its own.
   */
  failCredential(key: string, credential: string, now: Date = new Date()): void {
    const digest = createHash('sha256').update(credential).digest('base64url').slice(0, 22);
    let seen = this.#seen.get(key);
    if (!seen || seen.resetAt <= now.getTime()) {
      seen = { values: new Set(), resetAt: now.getTime() + this.#windowMs };
      this.#seen.set(key, seen);
    }
    if (seen.values.has(digest)) return;
    if (seen.values.size < 256) seen.values.add(digest);
    this.fail(key, now);
  }
}
