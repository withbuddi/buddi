/**
 * Frequency goals: "run three times a week" (docs/goals.md, "Frequency goals").
 *
 * The same series as a level goal, read another way: not where the number is,
 * but how many values landed in each window. A value is one occurrence ("ran
 * today" records 1), whatever number it carries.
 *
 * Windows are calendar weeks (Monday to Sunday) or calendar months, in the
 * owner's timezone, from the one the goal was set in to the one holding the
 * deadline. A value belongs to the window its `asOf` falls in on the owner's
 * clock. Pure: dates, values and a zone — no pool, no clock of its own.
 *
 * Two windows are not whole: the one the goal was set in (it began before the
 * goal did) and the one the deadline cuts short. Either may still be met; one
 * that closes short is `partial`, never a gap — a goal set on a Friday is not
 * a week missed.
 */
import { localDateString } from '../time.js';
import type { FrequencyPer, FrequencyTarget, Goal } from './types.js';

/** A window's standing. `open` is the current one, not yet at its count. */
export type WindowState = 'met' | 'short' | 'partial' | 'open';

export interface FrequencyWindow {
  /** The owner's first day of the window, `YYYY-MM-DD`. */
  start: string;
  /** The first day after it, `YYYY-MM-DD`. */
  end: string;
  count: number;
  /** Closed: its last day is behind the owner's today (or the deadline passed). */
  closed: boolean;
  state: WindowState;
}

export interface FrequencyStanding {
  /** Oldest first. */
  windows: FrequencyWindow[];
  /** The window holding today, or null once the deadline has passed. */
  current: FrequencyWindow | null;
  /** The newest closed window, or null in the goal's first window. */
  lastClosed: FrequencyWindow | null;
  /** Closed windows met in a row, counted back from the newest; partial ones are skipped. */
  streak: number;
  /** How many closed windows met the count, and how many fell short. */
  met: number;
  short: number;
  /** Occurrences still needed in the current window; null with no current window. */
  toGo: number | null;
}

type YMD = [number, number, number];

function ymd(date: string): YMD {
  return date.split('-').map(Number) as YMD;
}

function fmt(y: number, m: number, d: number): string {
  const at = new Date(Date.UTC(y, m - 1, d));
  return `${String(at.getUTCFullYear()).padStart(4, '0')}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(
    at.getUTCDate(),
  ).padStart(2, '0')}`;
}

/** The day `days` after a local date, as a local date. */
export function addDays(date: string, days: number): string {
  const [y, m, d] = ymd(date);
  return fmt(y, m, d + days);
}

/** The first day of the window a local date falls in. Weeks start on Monday. */
export function windowStartOf(date: string, per: FrequencyPer): string {
  const [y, m, d] = ymd(date);
  if (per === 'month') return fmt(y, m, 1);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 is Sunday
  return fmt(y, m, d - ((weekday + 6) % 7));
}

/** The first day of the window after the one starting at `start`. */
export function nextWindowStart(start: string, per: FrequencyPer): string {
  const [y, m, d] = ymd(start);
  return per === 'month' ? fmt(y, m + 1, 1) : fmt(y, m, d + 7);
}

/** "3 times a week", "once a month", "twice a week". */
export function frequencyWords(target: Pick<FrequencyTarget, 'count' | 'per'>): string {
  const times = target.count === 1 ? 'once' : target.count === 2 ? 'twice' : `${target.count} times`;
  return `${times} a ${target.per}`;
}

/**
 * Every window of a frequency goal up to now, with its count and its state.
 *
 * `values` may be in any order and may reach outside the goal's life; only
 * the ones from the day it was set to the deadline's day count.
 */
export function frequencyStandingOf(
  goal: Pick<Goal, 'target' | 'baseline' | 'deadline'>,
  values: ReadonlyArray<{ asOf: Date }>,
  now: Date,
  timezone: string,
): FrequencyStanding {
  if (goal.target.kind !== 'frequency') throw new Error('frequencyStandingOf: not a frequency goal');
  const { count: target, per } = goal.target;
  const setDay = localDateString(goal.baseline.asOf, timezone);
  const deadlineDay = localDateString(goal.deadline, timezone);
  const today = localDateString(now, timezone);
  const pastDeadline = now.getTime() >= goal.deadline.getTime();
  const lastDay = pastDeadline || deadlineDay < today ? deadlineDay : today;

  // How many values fell on each local day, inside the goal's life.
  const perDay = new Map<string, number>();
  for (const value of values) {
    const day = localDateString(value.asOf, timezone);
    if (day < setDay || day > deadlineDay) continue;
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }

  const windows: FrequencyWindow[] = [];
  for (let start = windowStartOf(setDay, per); start <= lastDay; start = nextWindowStart(start, per)) {
    const end = nextWindowStart(start, per);
    let count = 0;
    for (const [day, n] of perDay) if (day >= start && day < end) count += n;
    // Closed once its last day is behind today, or the deadline has passed.
    const closed = pastDeadline || end <= today;
    const whole = start >= setDay && addDays(end, -1) <= deadlineDay;
    const state: WindowState =
      count >= target ? 'met' : !closed ? 'open' : whole ? 'short' : 'partial';
    windows.push({ start, end, count, closed, state });
  }

  const closedOnes = windows.filter((w) => w.closed);
  let streak = 0;
  for (let i = closedOnes.length - 1; i >= 0; i -= 1) {
    const w = closedOnes[i] as FrequencyWindow;
    if (w.state === 'partial') continue;
    if (w.state !== 'met') break;
    streak += 1;
  }
  const current = windows.find((w) => !w.closed) ?? null;
  return {
    windows,
    current,
    lastClosed: closedOnes[closedOnes.length - 1] ?? null,
    streak,
    met: closedOnes.filter((w) => w.state === 'met').length,
    short: closedOnes.filter((w) => w.state === 'short').length,
    toGo: current === null ? null : Math.max(0, target - current.count),
  };
}

/**
 * The verdict at the deadline: `met` when more closed windows met the count
 * than fell short, `missed` otherwise. Partial windows count only when met.
 */
export function frequencySettles(standing: FrequencyStanding): 'met' | 'missed' {
  return standing.met > standing.short ? 'met' : 'missed';
}
