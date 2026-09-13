/**
 * Deterministic day-by-day cashflow projection. Pure: no DB, no clock, no
 * timezone. "The model explains; it never computes" — this is the computation.
 *
 * All dates are date-only `YYYY-MM-DD` strings and all arithmetic is done in
 * UTC so a machine in any timezone produces the same projection.
 */

export type Cadence = 'monthly' | 'weekly' | 'biweekly' | 'yearly' | 'once';

export interface RecurringItem {
  name: string;
  kind: 'income' | 'charge';
  /** Always positive; `kind` carries the direction. */
  amount: number;
  cadence: Cadence;
  /** First (or only, for 'once') occurrence, `YYYY-MM-DD`. */
  anchorDate: string;
}

export interface Hypothetical {
  name: string;
  /** Signed: positive = money in, negative = money out. */
  amount: number;
  date: string;
}

export interface ProjectionInput {
  startDate: string;
  startBalance: number;
  horizonDays: number;
  items: RecurringItem[];
  hypotheticals?: Hypothetical[];
  safetyFloor: number;
  /**
   * Typical variable spending, applied every day of the horizon and folded
   * silently into the balances. It is deliberately NOT an event: a 60-day
   * horizon would otherwise carry 60 identical rows and drown the real ones.
   * Positive means money out; a negative value (net money in) is allowed.
   */
  dailyBurn?: number;
}

export interface ProjectionEvent {
  name: string;
  /** Signed effect on the balance. */
  amount: number;
}

export interface ProjectionDay {
  date: string;
  /** Balance at end of day, after that day's events. */
  balance: number;
  events: ProjectionEvent[];
}

export interface ProjectionResult {
  days: ProjectionDay[];
  endBalance: number;
  minBalance: number;
  minBalanceDate: string;
  breachesFloor: boolean;
  firstBreachDate?: string;
  nextIncome?: { name: string; amount: number; date: string };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** Parse a `YYYY-MM-DD` date-only string to a UTC-midnight epoch value. */
export function parseDate(date: string): number {
  if (!DATE_RE.test(date)) throw new Error(`invalid date (expected YYYY-MM-DD): ${date}`);
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const ms = Date.UTC(year, month - 1, day);
  const d = new Date(ms);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    throw new Error(`invalid calendar date: ${date}`);
  }
  return ms;
}

export function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return formatDate(parseDate(date) + days * DAY_MS);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((parseDate(to) - parseDate(from)) / DAY_MS);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** Build a date from y/m/day-of-month, clamping the day to the month's end. */
function clampedDate(year: number, monthIndex: number, dayOfMonth: number): string {
  const y = year + Math.floor(monthIndex / 12);
  const m = ((monthIndex % 12) + 12) % 12;
  const day = Math.min(dayOfMonth, daysInMonth(y, m));
  return formatDate(Date.UTC(y, m, day));
}

/** Cents-exact rounding; float sums of 2-decimal amounts drift otherwise. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Every occurrence of `item` in `[from, to]` (both inclusive). Occurrences
 * before the anchor date never exist. Monthly recurs on the anchor's
 * day-of-month clamped to the month end (31 → Feb 28/29); yearly on the same
 * month/day (Feb 29 → Feb 28 in common years); weekly/biweekly every 7/14 days.
 */
export function occurrencesBetween(item: RecurringItem, from: string, to: string): string[] {
  const fromMs = parseDate(from);
  const toMs = parseDate(to);
  const anchorMs = parseDate(item.anchorDate);
  if (toMs < fromMs) return [];

  const out: string[] = [];
  const push = (date: string): void => {
    const ms = parseDate(date);
    if (ms >= anchorMs && ms >= fromMs && ms <= toMs) out.push(date);
  };

  switch (item.cadence) {
    case 'once': {
      push(item.anchorDate);
      break;
    }
    case 'weekly':
    case 'biweekly': {
      const step = item.cadence === 'weekly' ? 7 : 14;
      const stepMs = step * DAY_MS;
      let ms = anchorMs;
      if (ms < fromMs) {
        ms += Math.ceil((fromMs - anchorMs) / stepMs) * stepMs;
      }
      for (; ms <= toMs; ms += stepMs) push(formatDate(ms));
      break;
    }
    case 'monthly': {
      const anchor = new Date(anchorMs);
      const dayOfMonth = anchor.getUTCDate();
      const start = new Date(Math.max(anchorMs, fromMs));
      // Start a month early: clamping can pull an occurrence back into range.
      let monthIndex =
        (start.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
        (start.getUTCMonth() - anchor.getUTCMonth()) -
        1;
      for (;;) {
        const date = clampedDate(
          anchor.getUTCFullYear(),
          anchor.getUTCMonth() + monthIndex,
          dayOfMonth,
        );
        if (parseDate(date) > toMs) break;
        push(date);
        monthIndex += 1;
      }
      break;
    }
    case 'yearly': {
      const anchor = new Date(anchorMs);
      const month = anchor.getUTCMonth();
      const dayOfMonth = anchor.getUTCDate();
      const startYear = new Date(Math.max(anchorMs, fromMs)).getUTCFullYear() - 1;
      for (let year = startYear; ; year += 1) {
        const date = clampedDate(year, month, dayOfMonth);
        if (parseDate(date) > toMs) break;
        push(date);
      }
      break;
    }
    default: {
      const never: never = item.cadence;
      throw new Error(`unknown cadence: ${String(never)}`);
    }
  }

  return out;
}

/**
 * Simulate `horizonDays` days starting at `startDate` (inclusive), applying
 * every recurring occurrence and hypothetical on its day.
 */
export function project(input: ProjectionInput): ProjectionResult {
  const { startDate, startBalance, safetyFloor } = input;
  const dailyBurn = round2(input.dailyBurn ?? 0);
  const horizonDays = Math.max(1, Math.floor(input.horizonDays));
  const endDate = addDays(startDate, horizonDays - 1);

  const byDate = new Map<string, ProjectionEvent[]>();
  const incomeDates: { name: string; amount: number; date: string }[] = [];

  const add = (date: string, event: ProjectionEvent): void => {
    const list = byDate.get(date);
    if (list) list.push(event);
    else byDate.set(date, [event]);
  };

  for (const item of input.items) {
    const signed = item.kind === 'income' ? Math.abs(item.amount) : -Math.abs(item.amount);
    for (const date of occurrencesBetween(item, startDate, endDate)) {
      add(date, { name: item.name, amount: round2(signed) });
      if (item.kind === 'income') {
        incomeDates.push({ name: item.name, amount: round2(Math.abs(item.amount)), date });
      }
    }
  }

  for (const h of input.hypotheticals ?? []) {
    const ms = parseDate(h.date);
    if (ms < parseDate(startDate) || ms > parseDate(endDate)) continue;
    add(h.date, { name: h.name, amount: round2(h.amount) });
    if (h.amount > 0) incomeDates.push({ name: h.name, amount: round2(h.amount), date: h.date });
  }

  const days: ProjectionDay[] = [];
  let balance = round2(startBalance);
  let minBalance = Number.POSITIVE_INFINITY;
  let minBalanceDate = startDate;
  let firstBreachDate: string | undefined;

  for (let i = 0; i < horizonDays; i += 1) {
    const date = addDays(startDate, i);
    const events = byDate.get(date) ?? [];
    if (dailyBurn !== 0) balance = round2(balance - dailyBurn);
    for (const e of events) balance = round2(balance + e.amount);
    days.push({ date, balance, events });
    if (balance < minBalance) {
      minBalance = balance;
      minBalanceDate = date;
    }
    if (firstBreachDate === undefined && balance < safetyFloor) firstBreachDate = date;
  }

  incomeDates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const result: ProjectionResult = {
    days,
    endBalance: balance,
    minBalance,
    minBalanceDate,
    breachesFloor: firstBreachDate !== undefined,
  };
  if (firstBreachDate !== undefined) result.firstBreachDate = firstBreachDate;
  const next = incomeDates[0];
  if (next) result.nextIncome = next;
  return result;
}
