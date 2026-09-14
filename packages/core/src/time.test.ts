import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEZONE, localDateString, timezoneFromEnv } from './time.js';

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
