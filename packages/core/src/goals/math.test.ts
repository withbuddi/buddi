/**
 * The arithmetic of a goal, as a table of cases in both directions.
 *
 * Every function here decides whether an agent is woken at seven on a Monday,
 * and the mistakes it can make are all sign mistakes: a `down` goal read as an
 * `up` one, a delta added where it should be subtracted, a projection drawn
 * backwards. So the cases come in pairs — the same shape of goal, mirrored —
 * and any function that only works one way round fails here rather than six
 * weeks into somebody's fitness plan.
 */
import { describe, expect, it } from 'vitest';
import {
  milestoneValue,
  milestonesCrossed,
  onTrack,
  paceNeeded,
  progress,
  projection,
  reached,
  targetValue,
} from './math.js';

const DAY = 24 * 60 * 60_000;
const WEEK = 7 * DAY;

const T0 = new Date('2026-09-22T09:00:00Z');
const at = (days: number): Date => new Date(T0.getTime() + days * DAY);

/** The §8 goal: cut 40k of debt in 26 weeks, starting from 87,400. */
const debt = {
  target: { kind: 'delta' as const, value: -40_000 },
  baseline: { value: 87_400, asOf: T0 },
  deadline: new Date(T0.getTime() + 26 * WEEK),
  milestones: [-10_000, -20_000, -30_000],
};

/** Its mirror: 40 sessions up from 0 over the same 26 weeks. */
const sessions = {
  target: { kind: 'absolute' as const, value: 40 },
  baseline: { value: 0, asOf: T0 },
  deadline: new Date(T0.getTime() + 26 * WEEK),
  milestones: [10, 20, 30],
};

describe('targetValue', () => {
  const cases: [string, Parameters<typeof targetValue>[0], number][] = [
    ['a delta is a move from the baseline', debt, 47_400],
    ['an absolute is itself', sessions, 40],
    [
      'a positive delta goes the other way',
      { target: { kind: 'delta', value: 40 }, baseline: { value: 2, asOf: T0 } },
      42,
    ],
    [
      'a zero delta is the baseline',
      { target: { kind: 'delta', value: 0 }, baseline: { value: 9, asOf: T0 } },
      9,
    ],
  ];
  for (const [name, goal, expected] of cases) {
    it(name, () => expect(targetValue(goal)).toBe(expected));
  }
});

describe('progress', () => {
  const cases: [string, Parameters<typeof progress>[0], number, number | null][] = [
    ['down: nothing done yet', debt, 87_400, 0],
    ['down: a quarter of the way', debt, 77_400, 0.25],
    ['down: all of it', debt, 47_400, 1],
    ['down: past the target', debt, 37_400, 1.25],
    ['down: the wrong way is negative', debt, 91_400, -0.1],
    ['up: nothing done yet', sessions, 0, 0],
    ['up: a quarter of the way', sessions, 10, 0.25],
    ['up: all of it', sessions, 40, 1],
    ['up: past the target', sessions, 50, 1.25],
    ['up: the wrong way is negative', sessions, -4, -0.1],
    [
      'a target that is already the baseline has no fraction',
      { target: { kind: 'delta', value: 0 }, baseline: { value: 5, asOf: T0 } },
      5,
      null,
    ],
  ];
  for (const [name, goal, value, expected] of cases) {
    it(name, () => {
      const result = progress(goal, value);
      if (expected === null) expect(result).toBeNull();
      else expect(result as number).toBeCloseTo(expected, 10);
    });
  }
});

describe('paceNeeded', () => {
  it('down: the §8 card says about 1,540 a week', () => {
    const pace = paceNeeded(debt, 87_400, T0);
    expect(pace).not.toBeNull();
    expect(Math.abs(pace as number)).toBeCloseTo(40_000 / 26, 6);
    expect(pace as number).toBeLessThan(0); // the balance has to come down
  });

  it('up: the same shape, the other sign', () => {
    const pace = paceNeeded(sessions, 0, T0);
    expect(pace as number).toBeCloseTo(40 / 26, 6);
  });

  it('gets steeper as the deadline comes and nothing moves', () => {
    const early = Math.abs(paceNeeded(debt, 87_400, T0) as number);
    const late = Math.abs(paceNeeded(debt, 87_400, new Date(T0.getTime() + 20 * WEEK)) as number);
    expect(late).toBeGreaterThan(early);
  });

  it('is null once the deadline has passed — there is no per-week left', () => {
    expect(paceNeeded(debt, 60_000, new Date(debt.deadline.getTime() + 1))).toBeNull();
    expect(paceNeeded(debt, 60_000, debt.deadline)).toBeNull();
  });
});

describe('projection', () => {
  it('needs two checks', () => {
    expect(projection(debt, [])).toBeNull();
    expect(projection(debt, [{ at: T0, value: 87_400 }])).toBeNull();
  });

  it('down: a straight line lands exactly on the target', () => {
    // 40,000 over 26 weeks, measured for four of them.
    const perWeek = 40_000 / 26;
    const points = [0, 1, 2, 3].map((w) => ({
      at: new Date(T0.getTime() + w * WEEK),
      value: 87_400 - w * perWeek,
    }));
    expect(projection(debt, points) as number).toBeCloseTo(47_400, 6);
  });

  it('up: the mirror lands on its target too', () => {
    const perWeek = 40 / 26;
    const points = [0, 1, 2, 3].map((w) => ({
      at: new Date(T0.getTime() + w * WEEK),
      value: w * perWeek,
    }));
    expect(projection(sessions, points) as number).toBeCloseTo(40, 6);
  });

  it('uses only the last four checks, so an old start does not hold it back', () => {
    // Six weeks: flat for two, then moving 2,000 a week. The last four say
    // 2,000 a week and the projection must say so too.
    const points = [
      { at: at(0), value: 87_400 },
      { at: at(7), value: 87_400 },
      { at: at(14), value: 85_400 },
      { at: at(21), value: 83_400 },
      { at: at(28), value: 81_400 },
      { at: at(35), value: 79_400 },
    ];
    const projected = projection({ deadline: at(42) }, points) as number;
    expect(projected).toBeCloseTo(77_400, 6);
  });

  it('takes the points in any order', () => {
    const points = [
      { at: at(14), value: 80_000 },
      { at: at(0), value: 90_000 },
      { at: at(7), value: 85_000 },
    ];
    expect(projection({ deadline: at(21) }, points) as number).toBeCloseTo(75_000, 6);
  });

  it('is null when every point is the same instant — one moment says nothing', () => {
    const points = [
      { at: T0, value: 10 },
      { at: T0, value: 12 },
    ];
    expect(projection(debt, points)).toBeNull();
  });
});

describe('onTrack', () => {
  const cases: [string, Parameters<typeof onTrack>[0], 'down' | 'up', number | null, boolean | null][] = [
    ['down: lands on the target', debt, 'down', 47_400, true],
    ['down: lands below it, which is better', debt, 'down', 40_000, true],
    ['down: lands short', debt, 'down', 52_000, false],
    ['up: lands on the target', sessions, 'up', 40, true],
    ['up: lands above it', sessions, 'up', 44, true],
    ['up: lands short', sessions, 'up', 31, false],
    ['no projection is not "off track"', debt, 'down', null, null],
  ];
  for (const [name, goal, direction, projected, expected] of cases) {
    it(name, () => expect(onTrack(goal, direction, projected)).toBe(expected));
  }
});

describe('reached', () => {
  const cases: [string, Parameters<typeof reached>[0], 'down' | 'up', number, boolean][] = [
    ['down: exactly on it counts', debt, 'down', 47_400, true],
    ['down: past it counts', debt, 'down', 40_000, true],
    ['down: one above does not', debt, 'down', 47_401, false],
    ['up: exactly on it counts', sessions, 'up', 40, true],
    ['up: past it counts', sessions, 'up', 41, true],
    ['up: one short does not', sessions, 'up', 39, false],
  ];
  for (const [name, goal, direction, value, expected] of cases) {
    it(name, () => expect(reached(goal, direction, value)).toBe(expected));
  }
});

describe('milestones', () => {
  it('a delta goal reads them as moves from the baseline', () => {
    expect(milestoneValue(debt, -10_000)).toBe(77_400);
    expect(milestoneValue(sessions, 10)).toBe(10);
  });

  const cases: [string, Parameters<typeof milestonesCrossed>[0], 'down' | 'up', number, number[]][] = [
    ['down: nothing yet', debt, 'down', 87_400, []],
    ['down: exactly the first', debt, 'down', 77_400, [-10_000]],
    ['down: past the second', debt, 'down', 66_000, [-10_000, -20_000]],
    ['down: all three', debt, 'down', 50_000, [-10_000, -20_000, -30_000]],
    ['up: nothing yet', sessions, 'up', 9, []],
    ['up: exactly the first', sessions, 'up', 10, [10]],
    ['up: past the second', sessions, 'up', 25, [10, 20]],
    ['up: all three', sessions, 'up', 31, [10, 20, 30]],
    ['a goal with no milestones crosses none', { ...debt, milestones: [] }, 'down', 0, []],
  ];
  for (const [name, goal, direction, value, expected] of cases) {
    it(name, () => expect(milestonesCrossed(goal, direction, value)).toEqual(expected));
  }
});
