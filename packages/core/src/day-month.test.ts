import { describe, expect, it } from 'vitest';
import { daysBefore, daysUntil, dayMonthText, isOnDay, turning, validDayMonth, yearlyCron } from './day-month.js';

describe('yearly dates', () => {
  it('keeps real days, drops impossible ones, and a year only when it makes the day real', () => {
    expect(validDayMonth({ day: 2, month: 10 })).toEqual({ day: 2, month: 10, year: null });
    expect(validDayMonth({ day: 2, month: 10, year: 1988 })).toEqual({ day: 2, month: 10, year: 1988 });
    expect(validDayMonth({ day: 31, month: 4 })).toBeNull();
    expect(validDayMonth({ day: 0, month: 1 })).toBeNull();
    expect(validDayMonth({ day: 29, month: 2 })).toEqual({ day: 29, month: 2, year: null });
    expect(validDayMonth({ day: 29, month: 2, year: 1990 })).toEqual({ day: 29, month: 2, year: null });
    expect(validDayMonth({ day: 29, month: 2, year: 1992 })).toEqual({ day: 29, month: 2, year: 1992 });
    expect(validDayMonth({ day: 3, month: 3, year: 1800 })).toEqual({ day: 3, month: 3, year: null });
    expect(validDayMonth(null)).toBeNull();
  });

  it('counts days to the next occurrence, across the new year', () => {
    expect(daysUntil({ day: 2, month: 10 }, '2026-10-02')).toBe(0);
    expect(daysUntil({ day: 9, month: 10 }, '2026-10-02')).toBe(7);
    expect(daysUntil({ day: 1, month: 10 }, '2026-10-02')).toBe(364);
    expect(daysUntil({ day: 3, month: 1 }, '2026-12-27')).toBe(7);
    expect(isOnDay({ day: 2, month: 10 }, '2026-10-02')).toBe(true);
  });

  it('puts 29 February on the 28th in a year without one', () => {
    expect(isOnDay({ day: 29, month: 2 }, '2027-02-28')).toBe(true);
    expect(isOnDay({ day: 29, month: 2 }, '2028-02-28')).toBe(false);
    expect(isOnDay({ day: 29, month: 2 }, '2028-02-29')).toBe(true);
  });

  it('says the age it turns only with a year', () => {
    expect(turning({ day: 9, month: 10, year: 1991 }, '2026-10-02')).toBe(35);
    expect(turning({ day: 1, month: 10, year: 1991 }, '2026-10-02')).toBe(36);
    expect(turning({ day: 9, month: 10, year: null }, '2026-10-02')).toBeNull();
    expect(dayMonthText({ day: 2, month: 10, year: 1988 })).toBe('2 October 1988');
  });

  it('builds a superset cron for the days, and the day a week before', () => {
    expect(yearlyCron([{ day: 2, month: 10 }], 8)).toBe('0 8 2 10 *');
    expect(yearlyCron([{ day: 3, month: 3 }, daysBefore({ day: 3, month: 3 }, 7, 2026)], 9)).toBe('0 9 3,24 2,3 *');
    expect(yearlyCron([{ day: 29, month: 2 }], 8)).toBe('0 8 28,29 2 *');
    expect(yearlyCron([], 8)).toBeNull();
    expect(daysBefore({ day: 3, month: 1 }, 7, 2027)).toEqual({ month: 12, day: 27 });
  });
});
