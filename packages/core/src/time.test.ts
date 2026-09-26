import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMEZONE,
  localDateString,
  localDateTimeString,
  localMinutesOfDay,
  minutesOfLocalTime,
  nextLocalTime,
  timezoneFromEnv,
} from './time.js';

describe('localDateString', () => {
  it('renders the owner day, not the UTC day, after 8 PM in New York', () => {
    // 00:30 UTC on the 14th is 20:30 on the 13th in New York: the owner is
    // still having Sunday evening, and "today" must say so.
    const instant = new Date('2026-09-14T00:30:00Z');
    expect(localDateString(instant, 'America/New_York')).toBe('2026-09-13');
    expect(localDateString(instant, 'UTC')).toBe('2026-09-14');
  });

  it('renders the owner day ahead of UTC where the zone is ahead', () => {
    const instant = new Date('2026-09-13T23:30:00Z');
    expect(localDateString(instant, 'Europe/Paris')).toBe('2026-09-14');
    expect(localDateString(instant, 'Asia/Tokyo')).toBe('2026-09-14');
    expect(localDateString(instant, 'UTC')).toBe('2026-09-13');
  });

  it('crosses the month and year boundary in the owner zone', () => {
    expect(localDateString(new Date('2027-01-01T02:00:00Z'), 'America/New_York')).toBe(
      '2026-12-31',
    );
  });

  it('always pads to YYYY-MM-DD', () => {
    expect(localDateString(new Date('2026-01-02T12:00:00Z'), 'UTC')).toBe('2026-01-02');
  });

  it('refuses an unknown zone rather than falling back to UTC', () => {
    expect(() => localDateString(new Date(), 'Mars/Olympus')).toThrow(/unknown timezone/);
  });

  it('refuses an invalid date', () => {
    expect(() => localDateString(new Date('nope'), 'UTC')).toThrow(/invalid date/);
  });
});

describe('timezoneFromEnv', () => {
  it('takes BUDDI_TZ, else New York', () => {
    expect(timezoneFromEnv({} as NodeJS.ProcessEnv)).toBe(DEFAULT_TIMEZONE);
    expect(timezoneFromEnv({ BUDDI_TZ: '   ' } as NodeJS.ProcessEnv)).toBe(DEFAULT_TIMEZONE);
    expect(timezoneFromEnv({ BUDDI_TZ: 'Europe/Paris' } as NodeJS.ProcessEnv)).toBe(
      'Europe/Paris',
    );
  });
});

describe('localDateTimeString', () => {
  it('renders the owner wall clock, to the minute, with the zone named', () => {
    const instant = new Date('2026-09-13T21:35:00Z');
    expect(localDateTimeString(instant, 'America/New_York')).toBe('2026-09-13 17:35 EDT');
    expect(localDateTimeString(instant, 'UTC')).toBe('2026-09-13 21:35 UTC');
  });

  it('names the standard zone in winter, not the summer one', () => {
    expect(localDateTimeString(new Date('2026-01-13T22:35:00Z'), 'America/New_York')).toBe(
      '2026-01-13 17:35 EST',
    );
  });

  it('renders midnight as 00:00, never 24:00, on the right day', () => {
    // 04:00 UTC is midnight in New York, and the day has just turned.
    expect(localDateTimeString(new Date('2026-09-14T04:00:00Z'), 'America/New_York')).toBe(
      '2026-09-14 00:00 EDT',
    );
  });

  it('refuses an unknown zone and an invalid date', () => {
    expect(() => localDateTimeString(new Date(), 'Mars/Olympus')).toThrow(/unknown timezone/);
    expect(() => localDateTimeString(new Date('nope'), 'UTC')).toThrow(/invalid date/);
  });
});

describe('nextLocalTime', () => {
  it('is today while the time is still ahead, in the owner zone', () => {
    // 14:00 UTC is 10:00 in New York (EDT): 18:00 local is 22:00 UTC the same day.
    const at = nextLocalTime(new Date('2026-09-14T14:00:00Z'), 'America/New_York', '18:00');
    expect(at.toISOString()).toBe('2026-09-14T22:00:00.000Z');
  });

  it('is tomorrow once the time has passed', () => {
    const at = nextLocalTime(new Date('2026-09-14T22:00:00Z'), 'America/New_York', '18:00');
    expect(at.toISOString()).toBe('2026-09-15T22:00:00.000Z');
  });

  it('follows the clock across a change of offset', () => {
    // New York leaves daylight time on 2026-11-01: 07:00 local is 11:00 UTC before, 12:00 after.
    const at = nextLocalTime(new Date('2026-10-31T20:00:00Z'), 'America/New_York', '07:00');
    expect(at.toISOString()).toBe('2026-11-01T12:00:00.000Z');
  });

  it('reads minutes of the local day', () => {
    expect(localMinutesOfDay(new Date('2026-09-14T14:05:00Z'), 'America/New_York')).toBe(10 * 60 + 5);
    expect(() => minutesOfLocalTime('25:00')).toThrow();
  });
});
