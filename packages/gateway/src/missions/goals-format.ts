/**
 * How a goal's numbers read: the words for them, in one place.
 *
 * Split out of `goals.ts` so the Goals page, the Home block and the tools can
 * all use these without the page module and the tool module importing each
 * other. Pure functions over numbers, dates and a timezone — no pool, no
 * registry, no clock of their own.
 */
import {
  localDateString,
  progress,
  targetValue,
  type Goal,
  type GoalCheck,
  type MetricDirection,
  type MetricUnit,
} from '@buddi/core';

/**
 * A metric's number, in its own unit. Already formatted, like a Home stat.
 *
 * A `currency` metric that answered no currency prints the bare number. The
 * alternative — defaulting to dollars — puts a `$` in front of a euro balance
 * on a card the owner is about to approve, which is a worse answer than no
 * symbol at all: a missing symbol is visibly missing, a wrong one is not.
 */
export function formatValue(
  value: number | null,
  unit: MetricUnit,
  currency?: string | null,
): string {
  if (value === null || !Number.isFinite(value)) return 'not measured';
  if (unit === 'currency') {
    if (!currency) return new Intl.NumberFormat('en-US').format(round(value, 2));
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency,
        maximumFractionDigits: 0,
      }).format(value);
    } catch {
      return `${new Intl.NumberFormat('en-US').format(round(value, 2))} ${currency}`;
    }
  }
  if (unit === 'percent') return `${new Intl.NumberFormat('en-US').format(round(value, 1))}%`;
  if (unit === 'minutes') return `${new Intl.NumberFormat('en-US').format(Math.round(value))} min`;
  return new Intl.NumberFormat('en-US').format(round(value, 2));
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * A pace, in the owner's words: the size of the weekly move, and which way.
 *
 * The direction has to be in the sentence. "$1,540 a week" reads identically
 * for a debt coming down and a debt going up, and the sign of the number is
 * not something anybody reads off a card at seven in the morning — so the
 * magnitude carries the size and the word carries the direction.
 */
export function formatPace(
  pace: number | null,
  unit: MetricUnit,
  direction: MetricDirection,
  currency?: string | null,
): string {
  if (pace === null) return 'no time left';
  return `${formatValue(Math.abs(pace), unit, currency)} a week ${direction}`;
}

/** One goal, on one line: what `goal.list` prints and what a wake carries. */
export function goalLine(
  goal: Goal,
  unit: MetricUnit,
  last: GoalCheck | null,
  timezone: string,
): string {
  // The goal's own currency, not the last check's: an unmeasured check carries
  // none, and a line that loses its currency the week the bank is down is a
  // line that prints a different number than the week before.
  const currency = goal.currency ?? last?.currency ?? null;
  const at = last?.value ?? null;
  const pct = at === null ? null : progress(goal, at);
  return (
    `${goal.title} — ${goal.metric} ${formatValue(at, unit, currency)} ` +
    `toward ${formatValue(targetValue(goal), unit, currency)} by ${localDateString(goal.deadline, timezone)}` +
    `${pct === null ? '' : ` (${Math.round(pct * 100)}%)`}, ` +
    `checked ${goal.cadence}, held by @${goal.agentId}`
  );
}

/** The last four checks, oldest first, one line each. Evidence, not prose. */
export function checkLines(
  checks: readonly GoalCheck[],
  unit: MetricUnit,
  timezone: string,
  currency: string | null = null,
): string[] {
  return [...checks]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .map((check) => {
      const money = currency ?? check.currency;
      const parts = [`${localDateString(check.at, timezone)}: ${formatValue(check.value, unit, money)}`];
      // What the number was true *of*, when that is not the day buddi looked.
      if (check.asOf !== null && localDateString(check.asOf, timezone) !== localDateString(check.at, timezone)) {
        parts.push(`reading as of ${localDateString(check.asOf, timezone)}`);
      }
      if (check.onTrack !== null) parts.push(check.onTrack ? 'on track' : 'off track');
      if (check.projected !== null) {
        parts.push(`projected ${formatValue(check.projected, unit, money)}`);
      }
      if (check.note) parts.push(check.note);
      return `  ${parts.join(' · ')}`;
    });
}

