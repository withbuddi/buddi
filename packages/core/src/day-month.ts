/**
 * Yearly dates: a birthday, an anniversary (docs/agents.md, "Owner context";
 * docs/memory.md, "People"). Day and month, the year optional.
 *
 * Pure and zone-free: "today" is always passed in as the owner's local
 * `YYYY-MM-DD` (`localDateString(now, zone)`), so nothing here reads a clock.
 * A 29 February date falls on 28 February in a year without one.
 */

/** A yearly date: day and month, the year optional. */
export interface DayMonth {
  day: number;
  month: number;
  year: number | null;
}

/** Days in each month, February counted as 29: a birthday on 29 February is a real one. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const isLeap = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

/**
 * A day and month that exist (29 February does), the year kept only when it is
 * a plausible one and makes the day real (29 February 1990 does not exist).
 * Null for anything else.
 */
export function validDayMonth(given: { day?: unknown; month?: unknown; year?: unknown } | null | undefined): DayMonth | null {
  if (!given || typeof given !== 'object') return null;
  const day = Number(given.day);
  const month = Number(given.month);
  if (!Number.isInteger(day) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  if (day < 1 || day > MONTH_DAYS[month - 1]!) return null;
  const rawYear = given.year === null || given.year === undefined || given.year === '' ? null : Number(given.year);
  let year: number | null = rawYear !== null && Number.isInteger(rawYear) && rawYear >= 1900 && rawYear <= 2100 ? rawYear : null;
  if (year !== null && month === 2 && day === 29 && !isLeap(year)) year = null;
  return { day, month, year };
}

function parseDay(today: string): { y: number; m: number; d: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  if (!match) throw new Error(`day-month: "${today}" is not YYYY-MM-DD`);
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
}

/** The date's day in `year`: 29 February is 28 February in a year without one. */
export function occurrenceIn(date: Pick<DayMonth, 'day' | 'month'>, year: number): { month: number; day: number } {
  if (date.month === 2 && date.day === 29 && !isLeap(year)) return { month: 2, day: 28 };
  return { month: date.month, day: date.day };
}

const utc = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d);

/** Whole days from `today` to the date's next occurrence: 0 on the day, at most 365. */
export function daysUntil(date: Pick<DayMonth, 'day' | 'month'>, today: string): number {
  const t = parseDay(today);
  for (const year of [t.y, t.y + 1]) {
    const o = occurrenceIn(date, year);
    const diff = Math.round((utc(year, o.month, o.day) - utc(t.y, t.m, t.d)) / 86_400_000);
    if (diff >= 0) return diff;
  }
  return 365;
}

/** Is it the day? */
export function isOnDay(date: Pick<DayMonth, 'day' | 'month'>, today: string): boolean {
  return daysUntil(date, today) === 0;
}

/** The age the date turns on its next occurrence, when the year is known. */
export function turning(date: DayMonth, today: string): number | null {
  if (date.year === null) return null;
  const t = parseDay(today);
  const o = occurrenceIn(date, t.y);
  const passed = utc(t.y, o.month, o.day) < utc(t.y, t.m, t.d);
  return (passed ? t.y + 1 : t.y) - date.year;
}

/** "2 October", "2 October 1988". */
export function dayMonthText(date: DayMonth, withYear = true): string {
  return `${date.day} ${MONTH_NAMES[date.month - 1]}${withYear && date.year ? ` ${date.year}` : ''}`;
}

/**
 * A cron that fires at `hour:minute` on every day in `days` — a superset: the
 * listed days of month in the listed months. A run that finds it is not one of
 * the days stays silent (the mission's `prepare` checks), so a superset is
 * enough and each year still has only a handful of occurrences. 29 February
 * adds 28 February, its day in other years.
 */
export function yearlyCron(days: ReadonlyArray<Pick<DayMonth, 'day' | 'month'>>, hour: number, minute = 0): string | null {
  if (days.length === 0) return null;
  const doms = new Set<number>();
  const months = new Set<number>();
  for (const d of days) {
    doms.add(d.day);
    months.add(d.month);
    if (d.month === 2 && d.day === 29) doms.add(28);
  }
  const list = (set: Set<number>): string => [...set].sort((a, b) => a - b).join(',');
  return `${minute} ${hour} ${list(doms)} ${list(months)} *`;
}

/** The day `n` days before the date, in the year it next falls in (for "a week before"). */
export function daysBefore(date: Pick<DayMonth, 'day' | 'month'>, n: number, year: number): { month: number; day: number } {
  const o = occurrenceIn(date, year);
  const at = new Date(utc(year, o.month, o.day) - n * 86_400_000);
  return { month: at.getUTCMonth() + 1, day: at.getUTCDate() };
}
