/**
 * The names and the words a goal's surfaces share.
 *
 * Split out of `goals.ts` so the Goals page, the Home block and the tools can
 * all use these without the page module and the tool module importing each
 * other. Pure: numbers, dates, a timezone and two identifiers — no pool, no
 * registry, no clock of its own.
 */
import {
  localDateString,
  progress,
  targetValue,
  type Goal,
  type GoalCheck,
  isOwnerMetric,
  ownerMetricSource,
  type MetricDirection,
  type MetricSource,
  type MetricUnit,
  type OwnerMetricSource,
} from '@buddi/core';

/**
 * The metric source every goal surface reads, with the owner's metrics in it.
 *
 * A source that already answers them (one `createGoalManifest` built) is used
 * as it is, so the tools, the watcher and the page share one cache.
 */
export function asOwnerSource(source: MetricSource): OwnerMetricSource {
  return typeof (source as Partial<OwnerMetricSource>).refresh === 'function'
    ? (source as OwnerMetricSource)
    : ownerMetricSource(source);
}

/**
 * The watcher's id. Core's own, like the goals it reads.
 *
 * Here rather than in `goals.ts` because both the watcher that *writes* a
 * finding and the page that *reads* one back need it, and a page that filtered
 * on a second copy of the string would go on showing another plugin's findings
 * the day somebody renamed this one.
 */
export const GOALS_SENTINEL_ID = 'core.goals';

/** `goal.<id>.<event>` — one fact, one key, so each resolves on its own. */
export function goalKey(goalId: string, event: string): string {
  return `goal.${goalId}.${event}`;
}

/** Every finding key under one goal, as a `like` pattern. The page's read. */
export function goalKeyPrefix(goalId: string): string {
  return `goal.${goalId}.%`;
}

/**
 * A metric's unit, as the words for its numbers need it: the enum every
 * surface formats, and — for a metric the owner reports — the free word after
 * the number ("lb", "kg"). A plain `MetricUnit` is the same thing with no word.
 */
export type ValueUnit = MetricUnit | { unit: MetricUnit; label: string | null };

/** A metric's unit as its numbers are printed, or `number` for a metric nobody installed. */
export function valueUnitOf(source: MetricSource, metric: string): ValueUnit {
  const found = source.metric(metric);
  if (found === undefined) return 'number';
  return isOwnerMetric(found) && found.unitLabel ? { unit: found.unit, label: found.unitLabel } : found.unit;
}

/** The enum, whichever shape the unit came in. */
export function baseUnit(unit: ValueUnit): MetricUnit {
  return typeof unit === 'string' ? unit : unit.unit;
}

/** The owner's word for the unit, or null. */
export function unitLabelOf(unit: ValueUnit): string | null {
  return typeof unit === 'string' ? null : unit.label;
}

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
  valueUnit: ValueUnit,
  currency?: string | null,
): string {
  if (value === null || !Number.isFinite(value)) return 'not measured';
  const label = unitLabelOf(valueUnit);
  const bare = formatBare(value, baseUnit(valueUnit), currency);
  return label === null ? bare : `${bare} ${label}`;
}

function formatBare(value: number, unit: MetricUnit, currency?: string | null): string {
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
  unit: ValueUnit,
  direction: MetricDirection,
  currency?: string | null,
): string {
  if (pace === null) return 'no time left';
  return `${formatValue(Math.abs(pace), unit, currency)} a week ${direction}`;
}

/** One goal, on one line: what `goal.list` prints and what a wake carries. */
export function goalLine(
  goal: Goal,
  unit: ValueUnit,
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
  unit: ValueUnit,
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

