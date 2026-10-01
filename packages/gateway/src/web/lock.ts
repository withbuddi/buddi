/**
 * The lock screen, on the server (docs/dashboard.md, "Lock screen").
 *
 * A privacy screen over a signed-in dashboard session: it locks after a delay
 * nobody used the session for, or when the owner locks it, and opens with a
 * PIN. Honest about what it is — not a second sign-in. Anyone who can run
 * buddi on this computer can open it without the PIN (`buddi dashboard
 * --unlock`, a ticket that mints an open session), and buddi's own
 * command-line clients are never covered.
 *
 * Enforced here, for every device, not by the page:
 *
 *  - **The gate.** A locked session's API calls are answered `423 Locked`,
 *    except the lock screen's own: the session check, the lock's state, the
 *    screen's data (the time, the widgets that are not sensitive, counts of
 *    what is waiting, the focus), its background, Lock now and Unlock. Open
 *    streams of a session that locks are closed, and its remote hand let go.
 *  - **Idle.** The page reports when the owner used it; polls and streams do
 *    not count. A session unused for the delay (plus a minute's grace for the
 *    page's own reporting) is locked by the server whatever the page says.
 *  - **New sessions start locked** while a PIN is set: a fresh browser, a
 *    cleared cookie, a Tailscale sign-in, a restart. Only a ticket — which
 *    takes the installation's token, so a shell on this computer — opens one.
 *  - **Tries.** Five wrong PINs in a row, then a wait of 30 seconds that
 *    doubles with every further wrong one, up to an hour; counted for the
 *    installation, not the session, so a new session does not reset them.
 *
 *   GET  /api/lock                 the state: PIN set, locked, why, the delay, the background, the wait
 *   GET  /api/lock/screen          the lock screen's data (also the state)
 *   GET  /api/lock/background      the owner's picture
 *   POST /api/lock                 Lock now { reason?: 'owner' | 'idle' }
 *   POST /api/lock/unlock          { pin }
 *   POST /api/lock/activity        the owner used this session
 *   PUT  /api/lock/pin             { pin, current? }: set or change
 *   POST /api/lock/pin/remove      { current }
 *   PUT  /api/lock/settings        { delayMinutes?, background?, clock? }
 *   POST /api/lock/background      a JPEG or PNG (multipart), DELETE to remove
 */
import {
  DEFAULT_LOCK_CLOCK,
  getOwnerProfile,
  hashPin,
  listOwnerPlaces,
  lockClockOf,
  isValidPin,
  listPendingActions,
  LOCK_BACKGROUNDS,
  LOCK_DELAYS,
  PIN_FREE_TRIES,
  pinWaitMs,
  readFocusState,
  readLockPin,
  readLockSettings,
  removeLockPin,
  verifyPin,
  writeLockPin,
  writeLockSettings,
  type LockBackground,
  type LockClock,
  type LockDelay,
  type LockPinRecord,
  type LockSettings,
  type Queryable,
} from '@buddi/core';
import type { LockImage } from './lock-image.js';
import type { LockReason, Session, SessionClient, SessionStore } from './sessions.js';
import { hourOf, LOCK_WIDGETS_MAX, type HourCycle, type WidgetsService } from './widgets.js';

/** What a session idle past its delay is given before the server locks it: the page reports at most twice a minute. */
export const LOCK_GRACE_MS = 60_000;
/** How long the PIN record and settings are trusted between reads. `--remove-pin` is noticed this fast. */
export const LOCK_CACHE_MS = 2_000;
export { LOCK_WIDGETS_MAX } from './widgets.js';

/** The one body every refused call gets: the page turns it into the lock screen. */
export const LOCKED_BODY = { error: 'This dashboard is locked. Unlock it with your PIN.', locked: true } as const;

/**
 * The calls a locked session may still make. Everything the lock screen
 * draws, and the two ways off it; nothing that reads the owner's data
 * beyond counts and the widgets they chose to show.
 */
export function allowedWhileLocked(method: string, path: string): boolean {
  const read = method === 'GET' || method === 'HEAD';
  if (read) return path === '/api/session' || path === '/api/lock' || path === '/api/lock/screen' || path === '/api/lock/background';
  return method === 'POST' && (path === '/api/lock' || path === '/api/lock/unlock');
}

/** Who a header says is asking: buddi's own command-line clients name themselves. */
export function clientOf(header: string | string[] | undefined): SessionClient {
  const value = Array.isArray(header) ? header[0] : header;
  return value === 'mcp' ? 'mcp' : 'browser';
}

/** The lock's state could not be read and none is known: the request is refused with a 503, never let in. */
export class LockUnavailable extends Error {
  constructor() {
    super('The lock screen’s state could not be read.');
    this.name = 'LockUnavailable';
  }
}

export interface LockStateView {
  pin: boolean;
  locked: boolean;
  lockedAt: string | null;
  reason: LockReason | null;
  delayMinutes: LockDelay;
  background: LockBackground;
  /** The owner's picture, versioned, when there is one. */
  image: string | null;
  /** No try is checked before this moment. */
  waitUntil: string | null;
  /** Wrong tries left before a wait; null while none have been wrong. */
  triesLeft: number | null;
  /** The lock screen's clock as the owner chose it (Settings → Lock screen → What it shows). */
  clock: LockClock;
}

export interface LockScreenView extends LockStateView {
  now: string;
  timezone: string;
  owner: string | null;
  approvals: number;
  unread: number;
  focus: unknown;
  widgets: Array<{ key: string; id: string; title: string; size: string; view: unknown }>;
  /** The clock with the Profile applied. */
  clockView: LockClockView;
}

export interface LockClockView {
  /** `12h`, `24h`, or null for Auto. */
  time: '12h' | '24h' | null;
  /** `short`, `long`, `iso`, `off` (no date), or null for Auto. */
  date: 'short' | 'long' | 'iso' | 'off' | null;
  zone: { label: string; timezone: string } | null;
}

export interface LockDeps {
  pool: Queryable;
  sessions: SessionStore;
  now: () => Date;
  timezone: string;
  widgets?: WidgetsService;
  log?: (line: string) => void;
}

interface Answer {
  status: number;
  body?: unknown;
}

type Listener = (session: Session) => void;

export function createLock(deps: LockDeps) {
  let cached: { at: number; pin: LockPinRecord | null; settings: LockSettings; image: string | null } | null = null;
  const listeners = new Set<Listener>();
  /** Every PIN check, one after another: two wrong tries at once are two tries. */
  let checking: Promise<unknown> = Promise.resolve();

  /** What was last read for certain: the fallback when a read fails. Never cleared by `invalidate`. */
  let known: { pin: LockPinRecord | null; settings: LockSettings } | null = null;

  async function current(fresh = false): Promise<NonNullable<typeof cached>> {
    const now = deps.now().getTime();
    if (!fresh && cached && now - cached.at < LOCK_CACHE_MS) return cached;
    /*
     * Fail closed. A PIN that cannot be read is not "no PIN": that would open
     * every locked session on a database hiccup. The last state read for
     * certain stands until a read answers; with none, the lock cannot say,
     * and the request is refused (LockUnavailable, a 503) rather than let in.
     */
    const [pinRead, settingsRead, image] = await Promise.all([
      readLockPin(deps.pool).then((pin) => ({ ok: true as const, pin }), () => ({ ok: false as const })),
      readLockSettings(deps.pool).then((settings) => ({ ok: true as const, settings }), () => ({ ok: false as const })),
      imageVersion(deps.pool),
    ]);
    if (!pinRead.ok && !known) throw new LockUnavailable();
    const pin = pinRead.ok ? pinRead.pin : known!.pin;
    const settings = settingsRead.ok
      ? settingsRead.settings
      : (known?.settings ?? { delayMinutes: 5, background: 'field', clock: { ...DEFAULT_LOCK_CLOCK } });
    const hadPin = known?.pin != null;
    if (pinRead.ok) known = { pin, settings };
    else if (settingsRead.ok && known) known = { ...known, settings };
    // A failed read is not cached: the next request asks again.
    if (!pinRead.ok) return { at: now, pin, settings, image };
    cached = { at: now, pin, settings, image };
    // The PIN went away underneath us (`buddi dashboard --remove-pin`): every session opens.
    if (hadPin && !pin) deps.sessions.unlockCached();
    return cached;
  }

  function invalidate(): void {
    cached = null;
  }

  function lockSession(session: Session, reason: LockReason, at: Date): void {
    if (session.lockedAt) return;
    deps.sessions.setLock(session, { at, reason });
    for (const listener of listeners) {
      try {
        listener(session);
      } catch {
        /* a listener's failure is its own */
      }
    }
  }

  /** The reason a session minted now starts locked, or undefined when it starts open. */
  async function startLocked(client: SessionClient): Promise<LockReason | undefined> {
    if (client !== 'browser') return undefined;
    return (await current()).pin ? 'start' : undefined;
  }

  /**
   * Is this session locked right now? Locks it first when it sat unused past
   * the delay. Opens it when the PIN is gone.
   */
  async function locked(session: Session): Promise<boolean> {
    if (session.client !== 'browser') return false;
    const state = await current();
    if (!state.pin) {
      if (session.lockedAt) deps.sessions.setLock(session, null);
      return false;
    }
    if (session.lockedAt) return true;
    const delay = state.settings.delayMinutes;
    if (delay === null) return false;
    const now = deps.now();
    const idleMs = now.getTime() - session.activeAt.getTime();
    if (idleMs > delay * 60_000 + LOCK_GRACE_MS) {
      lockSession(session, 'idle', new Date(session.activeAt.getTime() + delay * 60_000));
      return true;
    }
    return false;
  }

  function stateOf(session: Session, state: NonNullable<typeof cached>): LockStateView {
    const pin = state.pin;
    const waitUntil = pin?.waitUntil && Date.parse(pin.waitUntil) > deps.now().getTime() ? pin.waitUntil : null;
    return {
      pin: pin !== null,
      locked: pin !== null && !!session.lockedAt && session.client === 'browser',
      lockedAt: pin && session.lockedAt ? session.lockedAt.toISOString() : null,
      reason: pin && session.lockedAt ? (session.lockReason ?? 'owner') : null,
      delayMinutes: state.settings.delayMinutes,
      background: state.settings.background === 'image' && !state.image ? 'field' : state.settings.background,
      image: state.image ? `/api/lock/background?v=${state.image.slice(0, 16)}` : null,
      waitUntil,
      triesLeft: pin && pin.failures > 0 ? Math.max(0, PIN_FREE_TRIES - pin.failures) : null,
      clock: state.settings.clock,
    };
  }

  /**
   * Check `pin` against the stored one, counting the try. One at a time.
   * `ok: false` carries what the page says: how many tries are left, or
   * until when it must wait.
   */
  function check(pin: unknown): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }> {
    const run = checking.then(async () => {
      const record = await readLockPin(deps.pool);
      if (!record) return { ok: true as const };
      const now = deps.now();
      if (record.waitUntil && Date.parse(record.waitUntil) > now.getTime()) {
        return { ok: false as const, status: 429, body: { error: 'Too many tries. Wait a moment, then try again.', waitUntil: record.waitUntil, triesLeft: 0 } };
      }
      const right = typeof pin === 'string' && (await verifyPin(pin, record.hash));
      if (right) {
        if (record.failures > 0 || record.waitUntil) await writeLockPin(deps.pool, { ...record, failures: 0, waitUntil: null });
        invalidate();
        return { ok: true as const };
      }
      const failures = record.failures + 1;
      const wait = pinWaitMs(failures);
      const waitUntil = wait > 0 ? new Date(now.getTime() + wait).toISOString() : null;
      await writeLockPin(deps.pool, { ...record, failures, waitUntil });
      invalidate();
      return {
        ok: false as const,
        status: 403,
        body: {
          error: waitUntil ? 'That PIN isn’t right. Too many tries: wait a moment.' : 'That PIN isn’t right.',
          triesLeft: Math.max(0, PIN_FREE_TRIES - failures),
          waitUntil,
        },
      };
    });
    checking = run.catch(() => {});
    return run;
  }

  async function screen(session: Session, hour?: HourCycle): Promise<LockScreenView> {
    const state = await current();
    const now = deps.now();
    const [profile, pending, unread, focus, widgets] = await Promise.all([
      getOwnerProfile(deps.pool as never).catch(() => null),
      listPendingActions(deps.pool, { now }).catch(() => []),
      unreadCount(deps.pool),
      readFocusState(deps.pool, { now: deps.now, timezone: deps.timezone }).catch(() => null),
      lockWidgets(deps.widgets, hour),
    ]);
    const owner = profile?.preferredName?.trim() || profile?.displayName?.trim() || null;
    const clockView = await lockClockView(deps.pool, state.settings.clock, profile);
    return {
      ...stateOf(session, state),
      now: now.toISOString(),
      timezone: deps.timezone,
      owner,
      approvals: pending.length,
      unread,
      focus,
      widgets,
      clockView,
    };
  }

  async function route(req: {
    method: string;
    path: string;
    body: unknown;
    session: Session;
    query?: URLSearchParams;
    upload?: () => Promise<{ ok: true; image: LockImage } | { ok: false; status: number; error: string }>;
  }): Promise<Answer | { status: 200; image: { jpeg: Buffer; sha256: string } } | null> {
    const { method, path, session } = req;
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? (req.body as Record<string, unknown>) : {};
    const now = deps.now();

    if (path === '/api/lock') {
      if (method === 'GET' || method === 'HEAD') {
        await locked(session);
        return { status: 200, body: stateOf(session, await current()) };
      }
      if (method !== 'POST') return { status: 405, body: { error: 'GET or POST' } };
      const state = await current(true);
      if (!state.pin) return { status: 409, body: { error: 'Set a PIN first, in Settings → Lock screen.' } };
      if (session.client !== 'browser') return { status: 409, body: { error: 'This client is not covered by the lock screen.' } };
      lockSession(session, body.reason === 'idle' ? 'idle' : 'owner', now);
      return { status: 200, body: stateOf(session, state) };
    }

    if (path === '/api/lock/screen') {
      if (method !== 'GET' && method !== 'HEAD') return { status: 405, body: { error: 'GET only' } };
      await locked(session);
      return { status: 200, body: await screen(session, hourOf(req.query?.get('hour'))) };
    }

    if (path === '/api/lock/unlock') {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      if (!session.lockedAt) {
        // Already open (another tab unlocked it): nothing to check.
        return { status: 200, body: stateOf(session, await current()) };
      }
      if (!isValidPin(body.pin)) return { status: 400, body: { error: 'A PIN is four to eight digits.' } };
      const result = await check(body.pin);
      if (!result.ok) return { status: result.status, body: result.body };
      deps.sessions.setLock(session, null);
      deps.sessions.touch(session, now);
      return { status: 200, body: stateOf(session, await current(true)) };
    }

    if (path === '/api/lock/activity') {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      deps.sessions.touch(session, now);
      return { status: 204 };
    }

    if (path === '/api/lock/pin') {
      if (method !== 'PUT') return { status: 405, body: { error: 'PUT only' } };
      if (!isValidPin(body.pin)) return { status: 400, body: { error: 'A PIN is four to eight digits.' } };
      const existing = await readLockPin(deps.pool);
      if (existing) {
        if (!isValidPin(body.current)) return { status: 400, body: { error: 'Type your current PIN to change it.' } };
        const result = await check(body.current);
        if (!result.ok) return { status: result.status, body: { ...result.body, error: result.status === 403 ? 'That isn’t your current PIN.' : result.body.error } };
      }
      await writeLockPin(deps.pool, { hash: await hashPin(body.pin), setAt: now.toISOString(), failures: 0, waitUntil: null });
      invalidate();
      // The PIN starts the clock: this session is in use now, not since it began.
      deps.sessions.touch(session, now);
      return { status: 200, body: stateOf(session, await current(true)) };
    }

    if (path === '/api/lock/pin/remove') {
      if (method !== 'POST') return { status: 405, body: { error: 'POST only' } };
      const existing = await readLockPin(deps.pool);
      if (!existing) return { status: 200, body: stateOf(session, await current(true)) };
      if (!isValidPin(body.current)) return { status: 400, body: { error: 'Type your current PIN to remove it.' } };
      const result = await check(body.current);
      if (!result.ok) return { status: result.status, body: { ...result.body, error: result.status === 403 ? 'That isn’t your current PIN.' : result.body.error } };
      await removeLockPin(deps.pool);
      deps.sessions.unlockCached();
      invalidate();
      return { status: 200, body: stateOf(session, await current(true)) };
    }

    if (path === '/api/lock/settings') {
      if (method !== 'PUT') return { status: 405, body: { error: 'PUT only' } };
      const state = await current(true);
      const next: LockSettings = { ...state.settings };
      if ('delayMinutes' in body) {
        const d = body.delayMinutes;
        if (d !== null && !(LOCK_DELAYS as readonly unknown[]).includes(d)) return { status: 400, body: { error: '`delayMinutes` is 1, 5, 15, 60 or null for never.' } };
        next.delayMinutes = d as LockDelay;
      }
      if ('background' in body) {
        const b = body.background;
        if (!(LOCK_BACKGROUNDS as readonly unknown[]).includes(b)) return { status: 400, body: { error: `\`background\` is one of ${LOCK_BACKGROUNDS.join(', ')}.` } };
        if (b === 'image' && !state.image) return { status: 409, body: { error: 'Add a picture first.' } };
        next.background = b as LockBackground;
      }
      if ('clock' in body) {
        const clock = lockClockOf(body.clock);
        if (!clock) return { status: 400, body: { error: '`clock` is { time: profile|12h|24h, date: profile|short|long|iso|off, zone: null | { place } | { label, timezone } }.' } };
        next.clock = clock;
      }
      await writeLockSettings(deps.pool, next);
      invalidate();
      return { status: 200, body: stateOf(session, await current(true)) };
    }

    if (path === '/api/lock/background') {
      if (method === 'GET' || method === 'HEAD') {
        const row = await readImage(deps.pool);
        if (!row) return { status: 404, body: { error: 'There is no picture.' } };
        return { status: 200, image: row };
      }
      if (method === 'DELETE') {
        await deps.pool.query('delete from core.lock_background where id = 1');
        const state = await current(true);
        if (state.settings.background === 'image') await writeLockSettings(deps.pool, { ...state.settings, background: 'field' });
        invalidate();
        return { status: 200, body: stateOf(session, await current(true)) };
      }
      if (method === 'POST') {
        if (!req.upload) return { status: 400, body: { error: 'send the picture as multipart/form-data' } };
        const upload = await req.upload();
        if (!upload.ok) return { status: upload.status, body: { error: upload.error } };
        const { image } = upload;
        await deps.pool.query(
          `insert into core.lock_background (id, jpeg, sha256, width, height, updated_at)
           values (1, $1, $2, $3, $4, now())
           on conflict (id) do update set jpeg = excluded.jpeg, sha256 = excluded.sha256,
             width = excluded.width, height = excluded.height, updated_at = now()`,
          [image.jpeg, image.sha256, image.width, image.height],
        );
        const state = await current(true);
        await writeLockSettings(deps.pool, { ...state.settings, background: 'image' });
        invalidate();
        return { status: 200, body: stateOf(session, await current(true)) };
      }
      return { status: 405, body: { error: 'GET, POST or DELETE' } };
    }

    return null;
  }

  return {
    /** Is this session locked (locking it first when it sat idle)? */
    locked,
    /** Why a session minted now starts locked, if it does. */
    startLocked,
    /** The /api/lock* routes; null for a path that is not one. */
    route,
    /** Called with each session the moment it locks. Returns the unsubscribe. */
    onLocked(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    invalidate,
  };
}

export type LockService = ReturnType<typeof createLock>;

async function imageVersion(pool: Queryable): Promise<string | null> {
  try {
    const { rows } = await pool.query('select sha256 from core.lock_background where id = 1');
    return rows[0] ? String(rows[0].sha256) : null;
  } catch {
    return null;
  }
}

async function readImage(pool: Queryable): Promise<{ jpeg: Buffer; sha256: string } | null> {
  const { rows } = await pool.query('select jpeg, sha256 from core.lock_background where id = 1');
  return rows[0] ? { jpeg: rows[0].jpeg as Buffer, sha256: String(rows[0].sha256) } : null;
}

/** Notifications the owner has not seen, from the last week: a count, never what they say. */
async function unreadCount(pool: Queryable): Promise<number> {
  try {
    const { rows } = await pool.query(
      `select count(*)::int as n from core.owner_notifications
        where seen_at is null and created_at > now() - interval '7 days'`,
    );
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * The lock screen's own placements as it shows them: in their order, none
 * that is sensitive (the service never places one there), only those with
 * something to draw, at most four.
 */
async function lockWidgets(service: WidgetsService | undefined, hour?: HourCycle): Promise<LockScreenView['widgets']> {
  if (!service) return [];
  try {
    const answer = await service.answer({ surface: 'lock', ...(hour ? { hour } : {}) });
    const out: LockScreenView['widgets'] = [];
    for (const placement of answer.lock) {
      if (out.length >= LOCK_WIDGETS_MAX) break;
      const info = answer.available.find((w) => w.id === placement.widget);
      const view = answer.views[placement.key];
      if (!info || info.sensitive || !view || !view.body || (view.state !== 'ok' && view.state !== 'stale')) continue;
      out.push({ key: placement.key, id: info.id, title: placement.label, size: placement.size, view: { state: view.state, body: view.body } });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * The clock as the lock screen draws it: the time and date formats with the
 * owner's Profile applied (null: Auto, the browser's), and the second zone
 * with its label and zone — a place of theirs read now, so a move follows.
 */
export async function lockClockView(pool: Queryable, clock: LockClock, profile: { timeFormat?: string | null; dateFormat?: string | null } | null): Promise<LockClockView> {
  const time = clock.time === 'profile' ? (profile?.timeFormat === '12h' || profile?.timeFormat === '24h' ? profile.timeFormat : null) : clock.time;
  const profileDate = profile?.dateFormat === 'short' || profile?.dateFormat === 'long' || profile?.dateFormat === 'iso' ? profile.dateFormat : null;
  const date = clock.date === 'profile' ? profileDate : clock.date;
  let zone: LockClockView['zone'] = null;
  if (clock.zone && 'place' in clock.zone) {
    const id = clock.zone.place;
    const place = (await listOwnerPlaces(pool as never).catch(() => [])).find((p) => p.id === id);
    if (place?.timezone) zone = { label: place.label, timezone: place.timezone };
  } else if (clock.zone) {
    zone = { label: clock.zone.label, timezone: clock.zone.timezone };
  }
  return { time, date, zone };
}
