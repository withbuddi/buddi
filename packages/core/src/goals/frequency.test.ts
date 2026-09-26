/**
 * Frequency windows, by hand: Monday weeks and calendar months in the owner's
 * zone, the partial first and last windows, streaks, and the verdict.
 */
import { describe, expect, it } from 'vitest';
import {
  frequencySettles,
  frequencyStandingOf,
  frequencyWords,
  nextWindowStart,
  windowStartOf,
} from './frequency.js';
import type { FrequencyTarget } from './types.js';

const TZ = 'America/New_York';
/** 09:00 New York on a local day. */
const at = (day: string, hour = 9): Date => new Date(`${day}T${String(hour + 4).padStart(2, '0')}:00:00Z`);

const goal = (target: FrequencyTarget, set = '2026-09-23', deadline = '2026-12-31') => ({
  target,
  baseline: { value: 0, asOf: at(set) },
  deadline: at(deadline),
});

describe('windows', () => {
  it('starts weeks on Monday and months on the first', () => {
    expect(windowStartOf('2026-09-23', 'week')).toBe('2026-09-21'); // a Wednesday
    expect(windowStartOf('2026-09-21', 'week')).toBe('2026-09-21');
    expect(windowStartOf('2026-09-27', 'week')).toBe('2026-09-21'); // Sunday closes the week
    expect(windowStartOf('2026-09-23', 'month')).toBe('2026-09-01');
    expect(nextWindowStart('2026-12-28', 'week')).toBe('2027-01-04');
    expect(nextWindowStart('2026-12-01', 'month')).toBe('2027-01-01');
  });

  it('counts a value in the window of the owner’s day, not UTC’s', () => {
    // 01:00 UTC on Monday the 28th is still Sunday the 27th in New York.
    const standing = frequencyStandingOf(
      goal({ kind: 'frequency', count: 1, per: 'week' }, '2026-09-21'),
      [{ asOf: new Date('2026-09-28T01:00:00Z') }],
      at('2026-09-28'),
      TZ,
    );
    expect(standing.windows.map((w) => [w.start, w.count, w.state])).toEqual([
      ['2026-09-21', 1, 'met'],
      ['2026-09-28', 0, 'open'],
    ]);
  });

  it('says it the way the card does', () => {
    expect(frequencyWords({ count: 3, per: 'week' })).toBe('3 times a week');
    expect(frequencyWords({ count: 1, per: 'month' })).toBe('once a month');
    expect(frequencyWords({ count: 2, per: 'week' })).toBe('twice a week');
  });
});

describe('a frequency goal over five weeks', () => {
  const target: FrequencyTarget = { kind: 'frequency', count: 3, per: 'week' };
  // Set on Wednesday 23 September. Week 1 is partial; then met, met, short, met.
  const runs = [
    '2026-09-24', // partial first week: 1
    '2026-09-28', '2026-09-30', '2026-10-02', // met
    '2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', // met (4)
    '2026-10-13', // short
    '2026-10-19', '2026-10-20', '2026-10-21', // met
    '2026-10-26', // current week so far
  ].map((day) => ({ asOf: at(day) }));

  it('marks the first week partial, not a gap, and counts the streak back from the newest', () => {
    const standing = frequencyStandingOf(goal(target), runs, at('2026-10-27'), TZ);
    expect(standing.windows.map((w) => w.state)).toEqual(['partial', 'met', 'met', 'short', 'met', 'open']);
    expect(standing.streak).toBe(1);
    expect(standing.lastClosed?.start).toBe('2026-10-19');
    expect(standing.current).toMatchObject({ start: '2026-10-26', count: 1 });
    expect(standing.toGo).toBe(2);
    expect([standing.met, standing.short]).toEqual([3, 1]);
  });

  it('ignores values before the goal was set, and settles by the windows at the deadline', () => {
    const early = [{ asOf: at('2026-09-21') }, ...runs];
    const standing = frequencyStandingOf(goal(target, '2026-09-23', '2026-10-21'), early, at('2026-10-22'), TZ);
    // The deadline cuts the week of the 19th short; it met anyway, so it counts.
    expect(standing.windows.map((w) => w.state)).toEqual(['partial', 'met', 'met', 'short', 'met']);
    expect(standing.current).toBeNull();
    expect(frequencySettles(standing)).toBe('met');
    const thin = frequencyStandingOf(goal(target, '2026-09-23', '2026-10-21'), runs.slice(0, 5), at('2026-10-22'), TZ);
    expect(frequencySettles(thin)).toBe('missed');
  });
});
