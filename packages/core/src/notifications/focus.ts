/**
 * Focus modes: what is sent and what waits (docs/notifications.md, "Focus").
 *
 * Pure: which focus is on at an instant (a manual one wins over a schedule
 * while it lasts), which kinds it holds, when a duration ends, and the
 * checks for what the owner sends. Holding, releasing and the one message at
 * the end live in `notify.ts`.
 */
import { LOCAL_TIME, localDateString, localMinutesOfDay, minutesOfLocalTime, nextLocalTime } from '../time.js';
import {
  ALWAYS_REACH,
  FOCUS_MODES,
  NOTIFICATION_KINDS,
  WEEKDAYS,
  type FocusMode,
  type FocusSchedule,
  type FocusSetting,
  type FocusState,
  type NotificationKind,
  type NotificationSettings,
  type NotificationUrgency,
  type Weekday,
} from './types.js';

/** How the owner reads a mode. */
export const FOCUS_LABELS: Record<FocusMode, string> = {
  normal: 'Normal',
  'urgent-only': 'Urgent only',
  'do-not-disturb': 'Do not disturb',
};

/** The `now` kinds Urgent only still lets through, beside approvals and questions. */
export const URGENT_KINDS: ReadonlySet<NotificationKind> = new Set(['watcher', 'failure']);

/** "Until tomorrow morning": the next time the owner's clock reads this. */
export const FOCUS_MORNING = '08:00';

/** Does this mode hold a message of this kind and urgency for the end of the focus? */
export function focusHolds(mode: FocusMode, kind: NotificationKind, urgency: NotificationUrgency): boolean {
  if (mode === 'normal' || urgency !== 'now' || ALWAYS_REACH.has(kind)) return false;
  if (mode === 'urgent-only') return !URGENT_KINDS.has(kind);
  return true;
}

/** Every kind this mode holds when it is `now`. */
export function heldKinds(mode: FocusMode): NotificationKind[] {
  return NOTIFICATION_KINDS.filter((kind) => focusHolds(mode, kind, 'now'));
}

const STRENGTH: Record<FocusMode, number> = { normal: 0, 'urgent-only': 1, 'do-not-disturb': 2 };

/** The owner's weekday at `at`, `days` back. */
export function localWeekday(at: Date, timezone: string, daysBack = 0): Weekday {
  const [y, m, d] = localDateString(at, timezone).split('-').map(Number) as [number, number, number];
  const js = new Date(Date.UTC(y, m - 1, d - daysBack)).getUTCDay();
  return WEEKDAYS[(js + 6) % 7] as Weekday;
}

/** The schedule on at `now`, the strongest when two are, with the instant it ends. */
export function scheduledFocus(schedules: readonly FocusSchedule[], now: Date, timezone: string): FocusState | null {
  const at = localMinutesOfDay(now, timezone);
  const today = localWeekday(now, timezone);
  const yesterday = localWeekday(now, timezone, 1);
  let best: { mode: FocusSchedule['mode']; until: Date } | null = null;
  for (const s of schedules) {
    const from = minutesOfLocalTime(s.from);
    const to = minutesOfLocalTime(s.to);
    const on = from < to
      ? s.days.includes(today) && at >= from && at < to
      : (s.days.includes(today) && at >= from) || (s.days.includes(yesterday) && at < to);
    if (!on) continue;
    const until = nextLocalTime(now, timezone, s.to);
    if (!best || STRENGTH[s.mode] > STRENGTH[best.mode] || (s.mode === best.mode && until > best.until)) {
      best = { mode: s.mode, until };
    }
  }
  return best ? { mode: best.mode, until: best.until.toISOString(), startedAt: null, by: 'schedule' } : null;
}

/** Is the manual focus still in force at `now`? */
export function manualFocusLasts(focus: FocusSetting | null, now: Date): focus is FocusSetting {
  return focus !== null && (focus.until === null || Date.parse(focus.until) > now.getTime());
}

/**
 * The focus in force at `now`: the manual one while it lasts (a manual
 * `normal` is "turned off" over a schedule, until that schedule ends), else
 * the strongest schedule on, else none.
 */
export function activeFocus(
  settings: Pick<NotificationSettings, 'focus' | 'schedules'>,
  now: Date,
  timezone: string,
): FocusState | null {
  if (manualFocusLasts(settings.focus, now)) {
    const f = settings.focus;
    if (f.mode === 'normal') return null;
    return { mode: f.mode, until: f.until, startedAt: f.startedAt, by: f.by };
  }
  return scheduledFocus(settings.schedules, now, timezone);
}

/** A duration the owner picks: `1h`, `3h` (any 1 to 24 hours), `tomorrow`, or `indefinite`. */
export type FocusDuration = string;

/** When a focus picked at `now` for `duration` ends; null for "until I turn it off"; undefined when it is not a duration. */
export function focusEnd(duration: FocusDuration, now: Date, timezone: string): Date | null | undefined {
  const d = duration.trim().toLowerCase();
  if (d === 'indefinite' || d === 'off' || d === '') return null;
  if (d === 'tomorrow') return nextLocalTime(now, timezone, FOCUS_MORNING);
  const hours = /^(\d{1,2})h$/.exec(d);
  if (hours) {
    const n = Number(hours[1]);
    if (n >= 1 && n <= 24) return new Date(now.getTime() + n * 3_600_000);
  }
  return undefined;
}

/** Quiet hours, as the first schedule: Do not disturb on every day. */
export function schedulesFromQuietHours(start: string | null | undefined, end: string | null | undefined): FocusSchedule[] {
  if (!start || !end || start === end) return [];
  return [{ mode: 'do-not-disturb', days: [...WEEKDAYS], from: start, to: end }];
}

/** Check the schedules the page sent; the list to store, or the sentence that says what is wrong. */
export function parseFocusSchedules(input: unknown): { ok: true; schedules: FocusSchedule[] } | { ok: false; message: string } {
  if (input === undefined || input === null) return { ok: true, schedules: [] };
  if (!Array.isArray(input)) return { ok: false, message: 'schedules must be a list.' };
  const out: FocusSchedule[] = [];
  for (const [i, raw] of input.entries()) {
    const n = i + 1;
    if (!raw || typeof raw !== 'object') return { ok: false, message: `Schedule ${n} must be an object.` };
    const o = raw as Record<string, unknown>;
    if (o.mode !== 'urgent-only' && o.mode !== 'do-not-disturb') {
      return { ok: false, message: `Schedule ${n} must be Do not disturb or Urgent only.` };
    }
    if (!Array.isArray(o.days) || o.days.length === 0 || !o.days.every((d) => (WEEKDAYS as readonly unknown[]).includes(d))) {
      return { ok: false, message: `Schedule ${n} needs at least one day.` };
    }
    const from = typeof o.from === 'string' ? o.from.trim() : '';
    const to = typeof o.to === 'string' ? o.to.trim() : '';
    if (!LOCAL_TIME.test(from) || !LOCAL_TIME.test(to)) return { ok: false, message: `Schedule ${n} needs times like 22:00.` };
    if (from === to) return { ok: false, message: `Schedule ${n} cannot start and end at the same time.` };
    const days = WEEKDAYS.filter((d) => (o.days as unknown[]).includes(d));
    out.push({ mode: o.mode, days, from, to });
  }
  return { ok: true, schedules: out };
}

/** A stored focus value, or null when it is not one. */
export function toFocusSetting(value: unknown): FocusSetting | null {
  if (!value || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  if (!(FOCUS_MODES as readonly unknown[]).includes(o.mode)) return null;
  if (o.until !== null && typeof o.until !== 'string') return null;
  if (typeof o.startedAt !== 'string') return null;
  const by = o.by === 'telegram' || o.by === 'schedule' ? o.by : 'dashboard';
  return { mode: o.mode as FocusMode, until: (o.until as string | null) ?? null, startedAt: o.startedAt, by };
}

/** Stored schedules, or null when the column was never written. */
export function toFocusSchedules(value: unknown): FocusSchedule[] | null {
  if (value === null || value === undefined) return null;
  const parsed = parseFocusSchedules(value);
  return parsed.ok ? parsed.schedules : [];
}
