/**
 * Where a goal stands, decided once for every surface that asks.
 *
 * `math.ts` has the pieces — progress, pace, projection, on-track, crossings —
 * and before this module each caller put them together for itself, over
 * whatever rows it happened to have fetched. That is two bugs, not one style
 * problem: the chat said "on track" off four rows while the page said "off
 * track" off twenty-four, and a milestone crossed in week two read "not yet"
 * by week twenty-seven because it had fallen out of somebody's window.
 *
 * So the verdict is a pure function of the goal and its **measured** checks,
 * and every surface calls it with the same window (`STANDING_CHECKS`). Three
 * rules make the answer the same everywhere:
 *
 *  1. **Measured checks only.** A look that failed is evidence about the
 *     plugin, not about the goal. Letting a null row answer "is this off
 *     track?" makes a timed-out metric look like a recovery.
 *  2. **The window is fixed, and it is the window the arithmetic needs.** The
 *     projection is drawn over the last four points (§6) and "off track twice
 *     running" needs two, so four newest measured checks is the whole input.
 *     A caller that fetched twenty-four rows for a table still passes four
 *     here, or its verdict would be a different verdict.
 *  3. **Nothing here is a window question.** `latest` is the newest measured
 *     check, so `milestonesCrossed` is read off the goal's current value and
 *     is true for as long as the value is past the milestone — never "true
 *     until it scrolls off the end".
 */
import {
  milestonesCrossed,
  onTrack,
  paceNeeded,
  progress,
  projection,
} from './math.js';
import type { Goal, GoalCheck } from './types.js';
import type { MetricDirection } from '../metrics.js';

/**
 * How many measured checks a standing is decided over.
 *
 * Four, because that is what §6's projection is drawn over. Every surface
 * reads exactly this many, so the numbers are identical on Home, on the Goals
 * page and in `goal.status` — a surface that passed more would get a
 * different slope the moment a look failed, which is the disagreement this
 * exists to end.
 */
export const STANDING_CHECKS = 4;

/** What a goal's surfaces say about it, in one word. */
export type GoalVerdict = 'on-track' | 'off-track' | 'no-projection' | 'not-measured';

export interface GoalStanding {
  /** The newest measured check, or null when nothing has ever answered. */
  latest: GoalCheck | null;
  /** 0 at the baseline, 1 at the target. Null with no number, or no span. */
  progress: number | null;
  /** Signed, on the metric's own axis. Null once the deadline has passed. */
  paceNeeded: number | null;
  /** Where the last four measured checks land at the deadline. */
  projected: number | null;
  /** Does that projection meet the target? Null when there is no projection. */
  onTrack: boolean | null;
  verdict: GoalVerdict;
  /**
   * How many of the newest measured checks in a row were recorded off track.
   *
   * Read off the `on_track` the sentinel stored on each row, because "twice
   * running" is a claim about two *checks*, not about one projection read
   * twice. Two is the threshold everything interrupts at; the count is capped
   * by the window it was given.
   */
  offTrackRuns: number;
  /** The milestones the newest measured value is past, on the goal's scale. */
  milestonesCrossed: number[];
}

/**
 * The whole verdict, from the goal and its newest measured checks.
 *
 * `measured` may arrive in any order and may contain unmeasured rows; both are
 * tolerated rather than assumed, because the callers read it out of three
 * different queries. `direction` is the metric's, and is a parameter rather
 * than a lookup because this module knows no registry: a goal whose plugin was
 * uninstalled still has a direction its caller can supply.
 */
export function standingOf(
  goal: Pick<Goal, 'target' | 'baseline' | 'deadline' | 'milestones'>,
  direction: MetricDirection,
  measured: readonly GoalCheck[],
  now: Date,
): GoalStanding {
  // Newest first, and nothing without a number.
  const checks = measured
    .filter((check) => check.value !== null)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const latest = checks[0] ?? null;
  if (latest === null) {
    return {
      latest: null,
      progress: null,
      paceNeeded: null,
      projected: null,
      onTrack: null,
      verdict: 'not-measured',
      offTrackRuns: 0,
      milestonesCrossed: [],
    };
  }

  const value = latest.value as number;
  const projected = projection(
    goal,
    checks.map((check) => ({ at: check.at, value: check.value as number })),
  );
  const track = onTrack(goal, direction, projected);
  let offTrackRuns = 0;
  for (const check of checks) {
    if (check.onTrack !== false) break;
    offTrackRuns += 1;
  }
  return {
    latest,
    progress: progress(goal, value),
    paceNeeded: paceNeeded(goal, value, now),
    projected,
    onTrack: track,
    verdict: track === null ? 'no-projection' : track ? 'on-track' : 'off-track',
    offTrackRuns,
    milestonesCrossed: milestonesCrossed(goal, direction, value),
  };
}
