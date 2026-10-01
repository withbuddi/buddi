/**
 * The dashboard's lock screen: the PIN, its tries, and the owner's choices
 * (docs/dashboard.md, "Lock screen").
 *
 * The lock is a privacy screen over a signed-in dashboard session, not a
 * second sign-in. What this module keeps is the installation's half of it:
 *
 *  - `lock.pin` in `core.web_settings`: the PIN's scrypt hash (never the PIN),
 *    how many wrong tries in a row, and until when the next try must wait.
 *  - `lock` in `core.web_settings`: how long a session may sit unused before
 *    it locks, and the background the lock screen is drawn on.
 *
 * The per-session half (which session is locked, when it was last used) is on
 * the session rows the gateway keeps. `removeLockPin` clears both, which is
 * what `buddi dashboard --remove-pin` runs when the PIN is forgotten.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import type { Queryable } from './owner.js';
import { readWebSetting, writeWebSetting } from './web-settings.js';

/** The `core.web_settings` key the PIN record is kept under. */
export const LOCK_PIN_KEY = 'lock.pin';
/** The `core.web_settings` key the delay and background are kept under. */
export const LOCK_SETTINGS_KEY = 'lock';

/** A PIN is four to eight digits. */
export const PIN_PATTERN = /^\d{4,8}$/;

/** Wrong tries in a row before the first wait. */
export const PIN_FREE_TRIES = 5;
/** The first wait, after the fifth wrong try. Each further wrong try doubles it. */
export const PIN_FIRST_WAIT_MS = 30_000;
/** The longest a wait grows. */
export const PIN_MAX_WAIT_MS = 60 * 60_000;

/** The delays the owner can pick, in minutes; null is "never". */
export const LOCK_DELAYS = [1, 5, 15, 60] as const;
export type LockDelay = (typeof LOCK_DELAYS)[number] | null;
/** What a PIN starts with until the owner picks another. */
export const DEFAULT_LOCK_DELAY: LockDelay = 5;

/** The built-in fields the lock screen can be drawn on; `image` is the owner's picture. */
export const LOCK_BACKGROUNDS = ['field', 'dawn', 'sea', 'moss', 'dusk', 'image'] as const;
export type LockBackground = (typeof LOCK_BACKGROUNDS)[number];

/** The lock screen's clock: the time and the date the owner's way unless picked here, and a second zone. */
export const LOCK_CLOCK_TIMES = ['profile', '12h', '24h'] as const;
export const LOCK_CLOCK_DATES = ['profile', 'short', 'long', 'iso', 'off'] as const;
export type LockClockTime = (typeof LOCK_CLOCK_TIMES)[number];
export type LockClockDate = (typeof LOCK_CLOCK_DATES)[number];
/** A second clock: one of the owner's places by id (it follows a move), or a town found by name. */
export type LockClockZone = { place: string } | { label: string; timezone: string };

export interface LockClock {
  time: LockClockTime;
  date: LockClockDate;
  zone: LockClockZone | null;
}

export const DEFAULT_LOCK_CLOCK: LockClock = { time: 'profile', date: 'profile', zone: null };

export interface LockSettings {
  delayMinutes: LockDelay;
  background: LockBackground;
  clock: LockClock;
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** A clock as stored or sent, made sound; undefined when it is not one. */
export function lockClockOf(raw: unknown): LockClock | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const time = c.time === undefined ? 'profile' : c.time;
  const date = c.date === undefined ? 'profile' : c.date;
  if (!(LOCK_CLOCK_TIMES as readonly unknown[]).includes(time) || !(LOCK_CLOCK_DATES as readonly unknown[]).includes(date)) return undefined;
  let zone: LockClockZone | null = null;
  if (c.zone !== undefined && c.zone !== null) {
    const z = c.zone as Record<string, unknown>;
    if (typeof z.place === 'string' && /^[a-z0-9-]{1,64}$/.test(z.place)) zone = { place: z.place };
    else if (typeof z.label === 'string' && z.label.trim() !== '' && z.label.trim().length <= 40 && typeof z.timezone === 'string' && validZone(z.timezone)) {
      zone = { label: z.label.trim(), timezone: z.timezone };
    } else return undefined;
  }
  return { time: time as LockClockTime, date: date as LockClockDate, zone };
}

export interface LockPinRecord {
  /** `scrypt$<log2 N>$<r>$<p>$<salt>$<hash>`, base64url. */
  hash: string;
  setAt: string;
  /** Wrong tries in a row since the last right one. */
  failures: number;
  /** No try is checked before this moment. */
  waitUntil: string | null;
}

/*
 * scrypt with N = 2^15, r = 8, p = 1: 32 MB and roughly a tenth of a second
 * per check. A four-digit PIN has ten thousand values, so the hash is not what
 * keeps it safe — the tries are, and they are counted here, not in the page.
 * The hash is what keeps a copy of the table (a backup, say) from handing the
 * PIN back in one step.
 */
const SCRYPT_LOG_N = 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

function scrypt(pin: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
  const N = 2 ** logN;
  return new Promise((resolve, reject) => {
    scryptCb(pin, salt, KEY_LEN, { N, r, p, maxmem: 128 * N * r * 2 }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** Is this a PIN buddi accepts? */
export function isValidPin(pin: unknown): pin is string {
  return typeof pin === 'string' && PIN_PATTERN.test(pin);
}

/** The stored form of a PIN. Throws for anything that is not four to eight digits. */
export async function hashPin(pin: string): Promise<string> {
  if (!isValidPin(pin)) throw new Error('A PIN is four to eight digits.');
  const salt = randomBytes(16);
  const key = await scrypt(pin, salt, SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P);
  return ['scrypt', SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** Does `pin` match `stored`? Constant-time; false for anything malformed. */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  if (typeof pin !== 'string' || pin.length === 0 || pin.length > 64) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [logN, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![logN, r, p].every((n) => Number.isInteger(n) && n > 0) || logN > 20 || r > 32 || p > 4) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const want = Buffer.from(parts[5]!, 'base64url');
  if (salt.length < 8 || want.length !== KEY_LEN) return false;
  const got = await scrypt(pin, salt, logN, r, p);
  return timingSafeEqual(got, want);
}

/** How long the wait is after `failures` wrong tries in a row; 0 before the fifth. */
export function pinWaitMs(failures: number): number {
  if (failures < PIN_FREE_TRIES) return 0;
  return Math.min(PIN_MAX_WAIT_MS, PIN_FIRST_WAIT_MS * 2 ** (failures - PIN_FREE_TRIES));
}

function isRecord(value: unknown): value is LockPinRecord {
  const v = value as Partial<LockPinRecord> | null;
  return !!v && typeof v === 'object' && typeof v.hash === 'string' && v.hash.startsWith('scrypt$');
}

/** The PIN record, or null when no PIN is set. */
export async function readLockPin(db: Queryable): Promise<LockPinRecord | null> {
  const value = await readWebSetting<unknown>(db, LOCK_PIN_KEY);
  if (!isRecord(value)) return null;
  return {
    hash: value.hash,
    setAt: typeof value.setAt === 'string' ? value.setAt : new Date(0).toISOString(),
    failures: Number.isInteger(value.failures) && value.failures > 0 ? value.failures : 0,
    waitUntil: typeof value.waitUntil === 'string' ? value.waitUntil : null,
  };
}

export async function writeLockPin(db: Queryable, record: LockPinRecord): Promise<void> {
  await writeWebSetting(db, LOCK_PIN_KEY, record);
}

/**
 * Forget the PIN and open every locked session. What `buddi dashboard
 * --remove-pin` runs; the gateway notices within a couple of seconds. True
 * when there was a PIN to remove.
 */
export async function removeLockPin(db: Queryable): Promise<boolean> {
  const { rows } = await db.query('delete from core.web_settings where key = $1 returning key', [LOCK_PIN_KEY]);
  await db.query('update core.dashboard_sessions set locked_at = null, lock_reason = null where locked_at is not null');
  return rows.length > 0;
}

/** The owner's choices, with the defaults filled in. */
export async function readLockSettings(db: Queryable): Promise<LockSettings> {
  const value = (await readWebSetting<Partial<Record<string, unknown>>>(db, LOCK_SETTINGS_KEY)) ?? {};
  const delay = value.delayMinutes;
  const background = value.background;
  return {
    delayMinutes: delay === null ? null : (LOCK_DELAYS as readonly unknown[]).includes(delay) ? (delay as LockDelay) : DEFAULT_LOCK_DELAY,
    background: (LOCK_BACKGROUNDS as readonly unknown[]).includes(background) ? (background as LockBackground) : 'field',
    clock: lockClockOf(value.clock) ?? { ...DEFAULT_LOCK_CLOCK },
  };
}

export async function writeLockSettings(db: Queryable, settings: LockSettings): Promise<void> {
  await writeWebSetting(db, LOCK_SETTINGS_KEY, settings);
}
