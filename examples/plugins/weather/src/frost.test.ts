/**
 * The rule, tested with three numbers and no database.
 *
 * Every plugin should be testable like this first: the judgement in a pure
 * function, the SQL and the network in a thin shell around it.
 */
import { describe, expect, it } from 'vitest';
import { frostFinding } from './frost.js';
import type { DailyForecast } from './ports.js';

const day = (lowC: number): DailyForecast => ({
  date: '2026-11-14',
  lowC,
  highC: 7,
  summary: 'clear',
});

describe('frostFinding', () => {
  it('says nothing when the low is above freezing', () => {
    expect(frostFinding(day(0.4), 'Paris')).toBeNull();
  });

  it('reports a freezing night as urgent', () => {
    const finding = frostFinding(day(-2), 'Paris');
    expect(finding).toMatchObject({ severity: 'urgent', key: 'weather.frost:2026-11-14' });
    expect(finding?.title).toContain('Paris');
  });

  it('keys on the forecast date, so the same night is one fact all day', () => {
    expect(frostFinding(day(-2), 'Paris')?.key).toBe(frostFinding(day(-4), 'Paris')?.key);
  });
});
