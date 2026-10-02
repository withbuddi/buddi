/** Sunrise and sunset from a place's coordinates: ordinary days, the edges, polar day and night. */
import { describe, expect, it } from 'vitest';
import { solarElevation, sunIsUp } from './sun';

const PARIS = [48.8566, 2.3522] as const;
const TROMSO = [69.6492, 18.9553] as const;
const QUITO = [-0.1807, -78.4678] as const;

describe('sunIsUp', () => {
  it('is up from sunrise to sunset, not from 6 to 18', () => {
    // Paris, 2 October 2026: sunrise about 07:53 CEST (05:53Z), sunset about 19:36 CEST (17:36Z).
    expect(sunIsUp(new Date('2026-10-02T05:00:00Z'), ...PARIS)).toBe(false); // 07:00 local, still dark
    expect(sunIsUp(new Date('2026-10-02T06:15:00Z'), ...PARIS)).toBe(true);
    expect(sunIsUp(new Date('2026-10-02T17:00:00Z'), ...PARIS)).toBe(true); // 19:00 local, still light
    expect(sunIsUp(new Date('2026-10-02T18:00:00Z'), ...PARIS)).toBe(false);
  });

  it('finds sunrise within a few minutes', () => {
    // NOAA: Paris sunrise on 2 October 2026 is 07:53 local (05:53Z).
    expect(sunIsUp(new Date('2026-10-02T05:47:00Z'), ...PARIS)).toBe(false);
    expect(sunIsUp(new Date('2026-10-02T05:59:00Z'), ...PARIS)).toBe(true);
  });

  it('keeps the midnight sun and the polar night', () => {
    expect(sunIsUp(new Date('2026-06-21T22:30:00Z'), ...TROMSO)).toBe(true); // half past midnight local, midsummer
    expect(sunIsUp(new Date('2026-12-21T11:00:00Z'), ...TROMSO)).toBe(false); // noon local, midwinter
  });

  it('puts the sun high at noon on the equator', () => {
    expect(solarElevation(new Date('2026-03-20T17:14:00Z'), ...QUITO)).toBeGreaterThan(85);
  });
});
