/**
 * What "when" means.
 *
 * A model writes dates the way people do, so the tool takes an ISO date or an
 * ISO datetime and this module decides the instant. Two rules, both of them the
 * owner's, not UTC's:
 *
 *  - a datetime with no zone (`2026-10-02T18:30`) is **wall-clock time in the
 *    owner's timezone**, because that is what "half six" means to the person
 *    being reminded;
 *  - a date alone (`2026-10-02`) means **09:00 local** — an hour, not midnight,
 *    which is nobody's idea of a morning nudge.
 *
 * An explicit offset (`…Z`, `…+02:00`) is already an instant and is taken
 * literally; it is the one spelling where the writer said what they meant.
 */
import { wallClockToInstant } from '../scheduler/cron.js';

/** The hour a date-only reminder lands on, in the owner's zone. */
export const DEFAULT_REMINDER_HOUR = 9;

export type ParsedWhen =
  | { ok: true; at: Date; /** True when the hour was supplied rather than defaulted. */ hadTime: boolean }
  | { ok: false; message: string };

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const ZONED = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Resolve a `when` string to an instant in `timezone`.
 *
 * Never throws: an unparseable string is a refusal the model is told about, in
 * the same sentence that says what it should have written.
 */
export function parseReminderWhen(when: string, timezone: string): ParsedWhen {
  const raw = (when ?? '').trim();
  if (raw === '') {
    return { ok: false, message: 'when is empty; give an ISO date (2026-10-02) or datetime (2026-10-02T18:30)' };
  }

  const zoned = ZONED.exec(raw);
  if (zoned) {
    const at = new Date(raw.replace(' ', 'T'));
    if (Number.isNaN(at.getTime())) {
      return { ok: false, message: `"${when}" is not a valid datetime` };
    }
    return { ok: true, at, hadTime: true };
  }

  const local = LOCAL_DATETIME.exec(raw);
  const dateOnly = local ? null : DATE_ONLY.exec(raw);
  if (!local && !dateOnly) {
    return {
      ok: false,
      message:
        `"${when}" is not an ISO date or datetime; write 2026-10-02 for a day ` +
        `(it means ${String(DEFAULT_REMINDER_HOUR).padStart(2, '0')}:00 local) or 2026-10-02T18:30 for a time`,
    };
  }

  const m = (local ?? dateOnly) as RegExpExecArray;
  const wall = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: local ? Number(m[4]) : DEFAULT_REMINDER_HOUR,
    minute: local ? Number(m[5]) : 0,
    second: local && m[6] ? Number(m[6]) : 0,
  };
  if (wall.month < 1 || wall.month > 12 || wall.day < 1 || wall.day > 31) {
    return { ok: false, message: `"${when}" is not a real date` };
  }
  if (wall.hour > 23 || wall.minute > 59 || wall.second > 59) {
    return { ok: false, message: `"${when}" is not a real time of day` };
  }

  let at: Date | null;
  try {
    at = wallClockToInstant(wall, timezone);
  } catch {
    return { ok: false, message: `unknown timezone "${timezone}"` };
  }
  if (at === null) {
    // Spring-forward: that wall-clock time does not exist. An hour later does,
    // and a reminder is not the place to argue about it.
    const shifted = wallClockToInstant({ ...wall, hour: (wall.hour + 1) % 24 }, timezone);
    if (shifted === null) {
      return { ok: false, message: `"${when}" does not exist in ${timezone} (daylight-saving gap)` };
    }
    return { ok: true, at: shifted, hadTime: Boolean(local) };
  }
  return { ok: true, at, hadTime: Boolean(local) };
}
