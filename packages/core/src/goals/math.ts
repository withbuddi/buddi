/**
 * The arithmetic of a goal. Pure functions over numbers and dates: no pool, no
 * clock of its own, no metric.
 *
 * It lives apart from the store and the sentinel because it is the part that
 * has to be *right* and the part a reader has to be able to check. A
 * projection that quietly used the wrong sign for an `up` goal would send a
 * wake every Monday for six months, and the only defence against that is a
 * table of cases in both directions — `math.test.ts`.
 *
 * Every function answers `null` rather than guessing when it has not got what
 * it needs: fewer than two checks is no projection, a deadline already past is
 * no pace, a baseline that already equals the target is no progress.
 */
import type { Goal, GoalTarget } from './types.js';
import type { MetricDirection } from '../metrics.js';

const WEEK_MS = 7 * 24 * 60 * 60_000;

/** What the goal actually has to reach: a delta is a move from the baseline. */
export function targetValue(goal: Pick<Goal, 'target' | 'baseline'>): number {
  return goal.target.kind === 'absolute' ? goal.target.value : goal.baseline.value + goal.target.value;
}

/** A milestone on the target's own scale becomes a value to compare against. */
export function milestoneValue(goal: Pick<Goal, 'target' | 'baseline'>, milestone: number): number {
  return goal.target.kind === 'absolute' ? milestone : goal.baseline.value + milestone;
}

/**
 * How far along, as a fraction: 0 at the baseline, 1 at the target.
 *
 * §6 writes it as `(baseline − value) / (baseline − target)` for `down` and
 * "mirrored" for `up`. The two are the same expression — `(value − baseline) /
 * (target − baseline)` — and writing it once is the point: a mirrored copy is
 * a sign error waiting for the first `up` goal anyone sets.
 *
 * Not clamped. 1.2 means the owner has gone past what they set out to do, and
 * saying so is more useful than saying "100%".
 */
export function progress(goal: Pick<Goal, 'target' | 'baseline'>, value: number): number | null {
  const span = targetValue(goal) - goal.baseline.value;
  if (span === 0) return null;
  return (value - goal.baseline.value) / span;
}

/**
 * What has to happen per week, from now to the deadline, to land on target.
 *
 * Signed on the metric's own axis: negative for a debt coming down, positive
 * for a count going up. A caller rendering it for a human takes the magnitude
 * and lets the verb carry the direction ("$1,540 a week off the balance").
 *
 * `null` once the deadline has passed: there is no per-week left, and dividing
 * by a negative span would print a confident, backwards number.
 */
export function paceNeeded(
  goal: Pick<Goal, 'target' | 'baseline' | 'deadline'>,
  value: number,
  now: Date,
): number | null {
  const remainingMs = goal.deadline.getTime() - now.getTime();
  if (remainingMs <= 0) return null;
  return (targetValue(goal) - value) / (remainingMs / WEEK_MS);
}

/** One measurement, as the projection reads it. */
export interface Point {
  at: Date;
  value: number;
}

/**
 * Where the deadline lands at the pace of the last four checks.
 *
 * A least-squares line over the points, extrapolated to the deadline — "not a
 * forecast engine" (§9), and the wake prompt says so in as many words. Fewer
 * than two points is `null`, and so is a set of points all taken at the same
 * instant: a vertical line through one moment says nothing about a Tuesday in
 * March.
 *
 * `checks` may be in any order and may be longer than four; the last four by
 * time are what is used.
 */
export function projection(
  goal: Pick<Goal, 'deadline'>,
  checks: readonly Point[],
): number | null {
  const points = [...checks]
    .filter((p) => Number.isFinite(p.value))
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(-4);
  if (points.length < 2) return null;

  // Times in weeks from the first point, which keeps the numbers small enough
  // that the slope is readable in a debugger.
  const t0 = (points[0] as Point).at.getTime();
  const xs = points.map((p) => (p.at.getTime() - t0) / WEEK_MS);
  const ys = points.map((p) => p.value);
  const n = points.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] as number) - meanX;
    sxy += dx * ((ys[i] as number) - meanY);
    sxx += dx * dx;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const deadlineX = (goal.deadline.getTime() - t0) / WEEK_MS;
  return intercept + slope * deadlineX;
}

/**
 * Does that projection meet the target by the deadline?
 *
 * `null` when there is no projection — which is not the same as `false`, and
 * the difference is a wake nobody should get in a goal's first week.
 */
export function onTrack(
  goal: Pick<Goal, 'target' | 'baseline'>,
  direction: MetricDirection,
  projected: number | null,
): boolean | null {
  if (projected === null) return null;
  const target = targetValue(goal);
  return direction === 'down' ? projected <= target : projected >= target;
}

/** Has this value reached the target, on the metric's own axis? */
export function reached(
  goal: Pick<Goal, 'target' | 'baseline'>,
  direction: MetricDirection,
  value: number,
): boolean {
  const target = targetValue(goal);
  return direction === 'down' ? value <= target : value >= target;
}

/**
 * The milestones this value has crossed, in the goal's own numbers.
 *
 * "Crossed" is on the metric's axis, not the clock's: for a `down` metric a
 * milestone is crossed once the value is at or below it. Whether it has
 * already been *announced* is not a question about arithmetic — that is the
 * sentinel's finding key, which exists once per milestone and never fires
 * twice.
 */
export function milestonesCrossed(
  goal: Pick<Goal, 'target' | 'baseline' | 'milestones'>,
  direction: MetricDirection,
  value: number,
): number[] {
  return goal.milestones.filter((milestone) => {
    const at = milestoneValue(goal, milestone);
    return direction === 'down' ? value <= at : value >= at;
  });
}

/** A target, as the tools' input names it. Kept here so the shape has one home. */
export function targetOf(kind: 'absolute' | 'delta', value: number): GoalTarget {
  return { kind, value };
}
