import { describe, expect, it } from 'vitest';
import { instantsBetween, nextAfter, parseCron, toWallClock, wallClockToInstant } from './cron.js';

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

describe('parseCron', () => {
  it('parses wildcards', () => {
    const spec = parseCron('* * * * *');
    expect(spec.minutes.size).toBe(60);
    expect(spec.hours.size).toBe(24);
    expect(spec.domRestricted).toBe(false);
    expect(spec.dowRestricted).toBe(false);
  });

  it('parses lists, ranges and steps', () => {
    const spec = parseCron('0,30 9-17/4 1,15 * *');
    expect([...spec.minutes]).toEqual([0, 30]);
    expect([...spec.hours].sort((a, b) => a - b)).toEqual([9, 13, 17]);
    expect([...spec.daysOfMonth].sort((a, b) => a - b)).toEqual([1, 15]);
  });

  it('parses */n and a/n steps', () => {
    expect([...parseCron('*/15 * * * *').minutes].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);
    expect([...parseCron('5/20 * * * *').minutes].sort((a, b) => a - b)).toEqual([5, 25, 45]);
  });

  it('accepts month and day names, and treats 7 as Sunday', () => {
    expect([...parseCron('0 0 1 JAN,dec *').months].sort((a, b) => a - b)).toEqual([1, 12]);
    expect([...parseCron('0 8 * * FRI').daysOfWeek]).toEqual([5]);
    expect([...parseCron('0 8 * * 7').daysOfWeek]).toEqual([0]);
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCron('')).toThrow();
    expect(() => parseCron('* * * *')).toThrow(/expected 5 fields/);
    expect(() => parseCron('60 * * * *')).toThrow(/out of range/);
    expect(() => parseCron('0 24 * * *')).toThrow(/out of range/);
    expect(() => parseCron('0 0 * * bogus')).toThrow();
    expect(() => parseCron('*/0 * * * *')).toThrow(/invalid step/);
    expect(() => parseCron('30-10 * * * *')).toThrow(/inverted/);
  });
});

describe('nextAfter', () => {
  it('is strictly after `from`', () => {
    const at = new Date('2026-09-13T10:00:00Z');
    expect(iso(nextAfter('0 * * * *', at, 'UTC'))).toBe('2026-09-13T11:00:00.000Z');
  });

  it('ignores sub-minute precision on `from`', () => {
    const at = new Date('2026-09-13T10:00:30.500Z');
    expect(iso(nextAfter('* * * * *', at, 'UTC'))).toBe('2026-09-13T10:01:00.000Z');
  });

  it('rolls over days, months and years', () => {
    expect(iso(nextAfter('0 0 1 * *', new Date('2026-12-05T00:00:00Z'), 'UTC'))).toBe(
      '2027-01-01T00:00:00.000Z',
    );
  });

  it('unions day-of-month and day-of-week when both are restricted', () => {
    // 1st of the month OR any Friday, in September 2026 (1st is a Tuesday).
    const got: string[] = [];
    let cursor = new Date('2026-08-31T12:00:00Z');
    for (let i = 0; i < 4; i += 1) {
      const next = nextAfter('0 0 1 * FRI', cursor, 'UTC');
      if (!next) break;
      got.push(next.toISOString().slice(0, 10));
      cursor = next;
    }
    expect(got).toEqual(['2026-09-01', '2026-09-04', '2026-09-11', '2026-09-18']);
  });

  it('returns null when the expression can never match', () => {
    expect(nextAfter('0 0 30 2 *', new Date('2026-01-01T00:00:00Z'), 'UTC')).toBeNull();
  });

  it('rejects an unknown timezone', () => {
    expect(() => nextAfter('* * * * *', new Date(), 'Mars/Olympus')).toThrow(/unknown timezone/);
  });
});

describe('timezones', () => {
  it('resolves a wall clock in a non-UTC zone', () => {
    // 08:00 Paris on 2026-09-11 is 06:00Z (CEST, UTC+2).
    expect(iso(nextAfter('0 8 * * *', new Date('2026-09-11T00:00:00Z'), 'Europe/Paris'))).toBe(
      '2026-09-11T06:00:00.000Z',
    );
  });

  it('holds the wall clock fixed across a DST change (America/New_York)', () => {
    // 2026: DST starts Sun 8 Mar, ends Sun 1 Nov.
    const beforeSpring = nextAfter('0 9 * * *', new Date('2026-03-06T20:00:00Z'), 'America/New_York');
    expect(iso(beforeSpring)).toBe('2026-03-07T14:00:00.000Z'); // EST, UTC-5
    const afterSpring = nextAfter('0 9 * * *', new Date('2026-03-08T00:00:00Z'), 'America/New_York');
    expect(iso(afterSpring)).toBe('2026-03-08T13:00:00.000Z'); // EDT, UTC-4
  });

  it('skips a wall-clock time that does not exist in the spring-forward gap', () => {
    // 2026-03-08 02:30 America/New_York never happens: 02:00 EST jumps to 03:00 EDT.
    expect(
      wallClockToInstant(
        { year: 2026, month: 3, day: 8, hour: 2, minute: 30, second: 0 },
        'America/New_York',
      ),
    ).toBeNull();

    const next = nextAfter('30 2 * * *', new Date('2026-03-07T12:00:00Z'), 'America/New_York');
    // Not 8 March — the daily 02:30 run is skipped that day, next is 9 March.
    expect(iso(next)).toBe('2026-03-09T06:30:00.000Z');
    expect(toWallClock(next as Date, 'America/New_York')).toMatchObject({
      day: 9,
      hour: 2,
      minute: 30,
    });
  });

  it('fires once, on the first instant, in the fall-back repeated hour', () => {
    // 2026-11-01: 01:30 America/New_York happens twice (05:30Z EDT, 06:30Z EST).
    const first = nextAfter('30 1 * * *', new Date('2026-10-31T12:00:00Z'), 'America/New_York');
    expect(iso(first)).toBe('2026-11-01T05:30:00.000Z');
    // The second 01:30 must not produce a second occurrence.
    const second = nextAfter('30 1 * * *', first as Date, 'America/New_York');
    expect(iso(second)).toBe('2026-11-02T06:30:00.000Z');
  });

  it('produces 23 hourly instants on the spring-forward day and 24 on fall-back', () => {
    const spring = instantsBetween(
      '0 * * * *',
      new Date('2026-03-08T04:59:00Z'), // 2026-03-07 23:59 EST
      new Date('2026-03-09T03:59:00Z'), // 2026-03-08 23:59 EDT — one local day
      'America/New_York',
    );
    expect(spring).toHaveLength(23);

    const fall = instantsBetween(
      '0 * * * *',
      new Date('2026-11-01T03:59:00Z'),
      new Date('2026-11-02T04:59:00Z'),
      'America/New_York',
    );
    // 24, not 25: the repeated 01:00 fires once, on its first instant — the same
    // rule that keeps a fall-back night from materializing a duplicate occurrence.
    expect(fall).toHaveLength(24);
  });
});

describe('instantsBetween', () => {
  it('is half-open on the left and closed on the right', () => {
    const got = instantsBetween(
      '0 * * * *',
      new Date('2026-09-13T10:00:00Z'),
      new Date('2026-09-13T13:00:00Z'),
      'UTC',
    );
    expect(got.map(iso)).toEqual([
      '2026-09-13T11:00:00.000Z',
      '2026-09-13T12:00:00.000Z',
      '2026-09-13T13:00:00.000Z',
    ]);
  });

  it('enumerates a week of Friday 08:00 recaps in New York', () => {
    const got = instantsBetween(
      '0 8 * * FRI',
      new Date('2026-09-01T00:00:00Z'),
      new Date('2026-09-30T00:00:00Z'),
      'America/New_York',
    );
    expect(got.map(iso)).toEqual([
      '2026-09-04T12:00:00.000Z',
      '2026-09-11T12:00:00.000Z',
      '2026-09-18T12:00:00.000Z',
      '2026-09-25T12:00:00.000Z',
    ]);
  });

  it('respects the limit', () => {
    const got = instantsBetween(
      '* * * * *',
      new Date('2026-09-13T00:00:00Z'),
      new Date('2026-09-20T00:00:00Z'),
      'UTC',
      5,
    );
    expect(got).toHaveLength(5);
  });
});
