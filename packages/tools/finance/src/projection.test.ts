import { describe, expect, it } from 'vitest';
import type { RecurringItem } from './projection.js';
import { addDays, occurrencesBetween, project } from './projection.js';

const item = (over: Partial<RecurringItem>): RecurringItem => ({
  name: 'x',
  kind: 'charge',
  amount: 10,
  cadence: 'monthly',
  anchorDate: '2026-01-01',
  ...over,
});

describe('date helpers', () => {
  it('adds days in UTC, across month and year ends', () => {
    expect(addDays('2026-09-13', 1)).toBe('2026-09-14');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('rejects malformed and impossible dates', () => {
    expect(() => addDays('13/09/2026', 1)).toThrow(/YYYY-MM-DD/);
    expect(() => addDays('2026-02-30', 1)).toThrow(/invalid calendar date/);
  });
});

describe('occurrencesBetween', () => {
  it('recurs monthly on the anchor day-of-month', () => {
    const got = occurrencesBetween(
      item({ cadence: 'monthly', anchorDate: '2026-01-15' }),
      '2026-01-01',
      '2026-04-30',
    );
    expect(got).toEqual(['2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15']);
  });

  it('clamps a day-31 monthly anchor to the end of shorter months', () => {
    const got = occurrencesBetween(
      item({ cadence: 'monthly', anchorDate: '2026-01-31' }),
      '2026-01-01',
      '2026-05-31',
    );
    expect(got).toEqual([
      '2026-01-31',
      '2026-02-28',
      '2026-03-31',
      '2026-04-30',
      '2026-05-31',
    ]);
    // 2028 is a leap year: February clamps to the 29th.
    expect(
      occurrencesBetween(
        item({ cadence: 'monthly', anchorDate: '2028-01-31' }),
        '2028-02-01',
        '2028-02-29',
      ),
    ).toEqual(['2028-02-29']);
  });

  it('never emits an occurrence before the anchor date', () => {
    expect(
      occurrencesBetween(
        item({ cadence: 'monthly', anchorDate: '2026-06-10' }),
        '2026-01-01',
        '2026-06-30',
      ),
    ).toEqual(['2026-06-10']);
  });

  it('steps weekly and biweekly from the anchor, including partial windows', () => {
    expect(
      occurrencesBetween(
        item({ cadence: 'weekly', anchorDate: '2026-09-01' }),
        '2026-09-10',
        '2026-09-30',
      ),
    ).toEqual(['2026-09-15', '2026-09-22', '2026-09-29']);
    expect(
      occurrencesBetween(
        item({ cadence: 'biweekly', anchorDate: '2026-09-01' }),
        '2026-09-01',
        '2026-10-15',
      ),
    ).toEqual(['2026-09-01', '2026-09-15', '2026-09-29', '2026-10-13']);
  });

  it('repeats yearly on the same month and day, clamping Feb 29', () => {
    expect(
      occurrencesBetween(
        item({ cadence: 'yearly', anchorDate: '2026-03-05' }),
        '2026-01-01',
        '2029-01-01',
      ),
    ).toEqual(['2026-03-05', '2027-03-05', '2028-03-05']);
    expect(
      occurrencesBetween(
        item({ cadence: 'yearly', anchorDate: '2028-02-29' }),
        '2029-01-01',
        '2029-12-31',
      ),
    ).toEqual(['2029-02-28']);
  });

  it("fires a 'once' item only on its date", () => {
    const once = item({ cadence: 'once', anchorDate: '2026-09-20' });
    expect(occurrencesBetween(once, '2026-09-01', '2026-12-31')).toEqual(['2026-09-20']);
    expect(occurrencesBetween(once, '2026-10-01', '2026-12-31')).toEqual([]);
  });
});

describe('project', () => {
  it('applies income and charges on their days and carries the balance', () => {
    const result = project({
      startDate: '2026-09-01',
      startBalance: 100,
      horizonDays: 5,
      safetyFloor: 0,
      items: [
        item({ name: 'pay', kind: 'income', amount: 50, cadence: 'once', anchorDate: '2026-09-02' }),
        item({ name: 'bill', kind: 'charge', amount: 30, cadence: 'once', anchorDate: '2026-09-04' }),
      ],
    });
    expect(result.days).toHaveLength(5);
    expect(result.days.map((d) => d.balance)).toEqual([100, 150, 150, 120, 120]);
    expect(result.endBalance).toBe(120);
    expect(result.minBalance).toBe(100);
    expect(result.minBalanceDate).toBe('2026-09-01');
    expect(result.breachesFloor).toBe(false);
    expect(result.firstBreachDate).toBeUndefined();
    expect(result.nextIncome).toEqual({ name: 'pay', amount: 50, date: '2026-09-02' });
  });

  it('detects a safety-floor breach and reports the first breach day', () => {
    const result = project({
      startDate: '2026-09-01',
      startBalance: 300,
      horizonDays: 10,
      safetyFloor: 200,
      items: [
        item({ name: 'rent', kind: 'charge', amount: 150, cadence: 'once', anchorDate: '2026-09-03' }),
        item({ name: 'sub', kind: 'charge', amount: 40, cadence: 'once', anchorDate: '2026-09-06' }),
      ],
    });
    expect(result.breachesFloor).toBe(true);
    expect(result.firstBreachDate).toBe('2026-09-03');
    expect(result.minBalance).toBe(110);
    expect(result.minBalanceDate).toBe('2026-09-06');
  });

  it('lets a hypothetical move the minimum balance', () => {
    const base = {
      startDate: '2026-09-13',
      startBalance: 900,
      horizonDays: 30,
      safetyFloor: 0,
      items: [
        item({ name: 'rent', kind: 'charge', amount: 500, cadence: 'monthly', anchorDate: '2026-10-01' }),
      ],
    };
    const without = project(base);
    const withIt = project({
      ...base,
      hypotheticals: [{ name: 'laptop', amount: -600, date: '2026-09-20' }],
    });
    expect(without.minBalance).toBe(400);
    expect(withIt.minBalance).toBe(-200);
    expect(withIt.minBalanceDate).toBe('2026-10-01');
    expect(withIt.breachesFloor).toBe(true);
    expect(without.breachesFloor).toBe(false);
  });

  it('ignores hypotheticals outside the horizon', () => {
    const result = project({
      startDate: '2026-09-13',
      startBalance: 100,
      horizonDays: 5,
      safetyFloor: 0,
      items: [],
      hypotheticals: [{ name: 'later', amount: -500, date: '2026-12-01' }],
    });
    expect(result.endBalance).toBe(100);
    expect(result.breachesFloor).toBe(false);
  });

  it('applies a daily burn silently: balances drop, events stay clean', () => {
    const base = {
      startDate: '2026-09-01',
      startBalance: 1000,
      horizonDays: 10,
      safetyFloor: 0,
      items: [
        item({ name: 'bill', kind: 'charge', amount: 100, cadence: 'once', anchorDate: '2026-09-05' }),
      ],
    };
    const plain = project(base);
    const burned = project({ ...base, dailyBurn: 20 });

    expect(burned.endBalance).toBe(plain.endBalance - 200);
    expect(burned.minBalance).toBe(700); // 1000 - 10*20 - 100
    expect(burned.minBalanceDate).toBe('2026-09-10');
    // The burn is never an event, so a long horizon stays readable.
    expect(burned.days.flatMap((d) => d.events)).toEqual(plain.days.flatMap((d) => d.events));
  });

  it('lets a daily burn push the balance through the safety floor', () => {
    const base = {
      startDate: '2026-09-01',
      startBalance: 500,
      horizonDays: 30,
      safetyFloor: 200,
      items: [],
    };
    expect(project(base).breachesFloor).toBe(false);
    const burned = project({ ...base, dailyBurn: 15 });
    expect(burned.breachesFloor).toBe(true);
    // Day 20 (09-20) ends at exactly 200, still at the floor; 09-21 breaks it.
    expect(burned.firstBreachDate).toBe('2026-09-21');
    expect(burned.endBalance).toBe(50);
  });

  it('treats a negative daily burn as money drifting in', () => {
    const result = project({
      startDate: '2026-09-01',
      startBalance: 100,
      horizonDays: 5,
      safetyFloor: 0,
      items: [],
      dailyBurn: -10,
    });
    expect(result.endBalance).toBe(150);
  });

  it('runs the end-to-end scenario: the 800 purchase is what breaks it', () => {
    const items: RecurringItem[] = [
      { name: 'Salary', kind: 'income', amount: 3200, cadence: 'monthly', anchorDate: '2026-09-28' },
      { name: 'Rent', kind: 'charge', amount: 1200, cadence: 'monthly', anchorDate: '2026-10-01' },
      { name: 'Streaming', kind: 'charge', amount: 40, cadence: 'monthly', anchorDate: '2026-09-15' },
    ];
    const base = {
      startDate: '2026-09-13',
      startBalance: 900,
      horizonDays: 60,
      // The owner wants to keep 200 in reserve at all times.
      safetyFloor: 200,
      items,
    };

    const without = project(base);
    expect(without.breachesFloor).toBe(false);
    expect(without.minBalance).toBe(860); // after the 40 subscription on the 15th
    expect(without.minBalanceDate).toBe('2026-09-15');
    expect(without.endBalance).toBe(4820); // 2 salaries, 2 rents, 2 subscriptions
    expect(without.nextIncome).toEqual({ name: 'Salary', amount: 3200, date: '2026-09-28' });

    const withPurchase = project({
      ...base,
      hypotheticals: [{ name: 'purchase', amount: -800, date: '2026-09-20' }],
    });
    expect(withPurchase.breachesFloor).toBe(true);
    expect(withPurchase.firstBreachDate).toBe('2026-09-20');
    expect(withPurchase.minBalance).toBe(60);
    expect(withPurchase.minBalanceDate).toBe('2026-09-20');
    // The dip is temporary — by the end of the horizon it costs exactly its price.
    expect(without.endBalance - withPurchase.endBalance).toBe(800);
  });
});
