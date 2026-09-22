/**
 * The one verdict, in both directions and at its edges.
 *
 * `standingOf` is what stopped the chat and the Goals page disagreeing, so
 * what matters here is that the answer depends on the goal and its measured
 * checks and on nothing else — not on the order they arrive in, not on
 * unmeasured rows being mixed in, and not on how many the caller happened to
 * fetch beyond the four the projection needs.
 */
import { describe, expect, it } from 'vitest';
import { STANDING_CHECKS, standingOf } from './standing.js';
import type { Goal, GoalCheck } from './types.js';

const T0 = new Date('2026-09-22T09:00:00Z');
const WEEK = 7 * 24 * 60 * 60_000;

/** A debt coming down: 100 today, 40 by the deadline six weeks out. */
const debt = {
  target: { kind: 'absolute' as const, value: 40 },
  baseline: { value: 100, asOf: T0 },
  deadline: new Date(T0.getTime() + 6 * WEEK),
  milestones: [80, 60],
} satisfies Pick<Goal, 'target' | 'baseline' | 'deadline' | 'milestones'>;

let serial = 0;
function check(weeks: number, value: number | null, onTrack: boolean | null = null): GoalCheck {
  serial += 1;
  return {
    id: `c${serial}`,
    goalId: 'g',
    at: new Date(T0.getTime() + weeks * WEEK),
    asOf: null,
    value,
    currency: 'USD',
    note: null,
    onTrack,
    paceNeeded: null,
    projected: null,
  };
}

describe('standingOf', () => {
  it('says "not measured" when nothing has ever answered, and guesses nothing', () => {
    const standing = standingOf(debt, 'down', [], T0);
    expect(standing).toMatchObject({
      latest: null,
      progress: null,
      paceNeeded: null,
      projected: null,
      onTrack: null,
      verdict: 'not-measured',
      offTrackRuns: 0,
      milestonesCrossed: [],
    });
  });

  it('has no projection from one point, which is not the same as off track', () => {
    const standing = standingOf(debt, 'down', [check(0, 100)], T0);
    expect(standing.verdict).toBe('no-projection');
    expect(standing.onTrack).toBeNull();
    // It still knows where the goal *is*: progress and pace need one number.
    expect(standing.progress).toBeCloseTo(0, 6);
    expect(standing.paceNeeded).toBeCloseTo(-10, 6);
  });

  it('projects from the last four measured checks, whatever order they arrive in', () => {
    const rows = [check(0, 100), check(1, 90), check(2, 80), check(3, 70)];
    const forwards = standingOf(debt, 'down', rows, T0);
    const backwards = standingOf(debt, 'down', [...rows].reverse(), T0);
    expect(forwards.projected).toBeCloseTo(40, 6);
    expect(backwards.projected).toBe(forwards.projected);
    expect(forwards.verdict).toBe('on-track');
    expect(forwards.onTrack).toBe(true);
  });

  it('is off track when the pace of those four lands short', () => {
    const standing = standingOf(debt, 'down', [check(0, 100), check(1, 99), check(2, 98)], T0);
    expect(standing.projected).toBeCloseTo(94, 6);
    expect(standing.verdict).toBe('off-track');
  });

  it('ignores rows that carried no number, wherever they sit', () => {
    const measured = [check(0, 100), check(1, 90)];
    const withFailures = [check(5, null), check(4, null), ...measured, check(3, null)];
    expect(standingOf(debt, 'down', withFailures, T0).projected).toBe(
      standingOf(debt, 'down', measured, T0).projected,
    );
    // And the newest *number* is the goal's number, not the newest row.
    expect(standingOf(debt, 'down', withFailures, T0).latest?.value).toBe(90);
  });

  it('counts the misses in a row off what the sentinel stored, and stops at the first that is not', () => {
    const rows = [check(3, 97, false), check(2, 98, false), check(1, 99, true), check(0, 100, false)];
    expect(standingOf(debt, 'down', rows, T0).offTrackRuns).toBe(2);
    expect(standingOf(debt, 'down', [check(1, 99, true)], T0).offTrackRuns).toBe(0);
    // A row the sentinel could not judge breaks the run rather than extending it.
    expect(standingOf(debt, 'down', [check(2, 98, null), check(1, 99, false)], T0).offTrackRuns).toBe(0);
  });

  it('reads the crossings off the current number, so they stay crossed', () => {
    // Deep history: crossed $80 long ago, and the window only holds four.
    const rows = [check(1, 79), check(2, 75), check(3, 70), check(4, 65), check(5, 61)];
    const standing = standingOf(debt, 'down', rows.slice(-STANDING_CHECKS), T0);
    // $80 was crossed at week 1, which the four-row window no longer holds;
    // it is still crossed, because 61 is past it. $60 is not, because 61 is not.
    expect(standing.milestonesCrossed).toEqual([80]);
  });

  it('mirrors for a metric that should go up', () => {
    const up = {
      target: { kind: 'absolute' as const, value: 100 },
      baseline: { value: 0, asOf: T0 },
      deadline: new Date(T0.getTime() + 6 * WEEK),
      milestones: [50],
    };
    const standing = standingOf(up, 'up', [check(0, 0), check(1, 20)], T0);
    expect(standing.projected).toBeCloseTo(120, 6);
    expect(standing.verdict).toBe('on-track');
    expect(standing.milestonesCrossed).toEqual([]);
    expect(standingOf(up, 'up', [check(0, 0), check(1, 60)], T0).milestonesCrossed).toEqual([50]);
  });
});
