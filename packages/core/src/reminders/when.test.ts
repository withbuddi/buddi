import { describe, expect, it } from 'vitest';
import { DEFAULT_REMINDER_HOUR, parseReminderWhen } from './when.js';

const NY = 'America/New_York';

describe('parseReminderWhen', () => {
  it('reads a date alone as 09:00 in the owner\'s timezone, not UTC midnight', () => {
    const parsed = parseReminderWhen('2026-10-02', NY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // 09:00 EDT is 13:00 UTC. Midnight UTC would be 20:00 the evening before,
    // which is the bug this rule exists to prevent.
    expect(parsed.at.toISOString()).toBe('2026-10-02T13:00:00.000Z');
    expect(parsed.hadTime).toBe(false);
    expect(DEFAULT_REMINDER_HOUR).toBe(9);
  });

  it('reads the same date differently in a different zone', () => {
    const ny = parseReminderWhen('2026-10-02', NY);
    const paris = parseReminderWhen('2026-10-02', 'Europe/Paris');
    expect(ny.ok && paris.ok).toBe(true);
    if (!ny.ok || !paris.ok) return;
    expect(paris.at.toISOString()).toBe('2026-10-02T07:00:00.000Z');
    expect(paris.at.getTime()).toBeLessThan(ny.at.getTime());
  });

  it('reads a bare datetime as wall-clock time in the owner\'s zone', () => {
    const parsed = parseReminderWhen('2026-10-02T18:30', NY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.at.toISOString()).toBe('2026-10-02T22:30:00.000Z');
    expect(parsed.hadTime).toBe(true);
  });

  it('respects winter time on the same wall clock', () => {
    const parsed = parseReminderWhen('2026-12-02T18:30', NY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // EST, not EDT: an hour further from UTC than the October reading.
    expect(parsed.at.toISOString()).toBe('2026-12-02T23:30:00.000Z');
  });

  it('takes an explicit offset literally', () => {
    const parsed = parseReminderWhen('2026-10-02T18:30:00Z', NY);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.at.toISOString()).toBe('2026-10-02T18:30:00.000Z');
  });

  it('refuses a phrase rather than guessing a date', () => {
    const parsed = parseReminderWhen('next Friday', NY);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain('ISO date');
  });

  it('refuses an empty string and an impossible time of day', () => {
    expect(parseReminderWhen('   ', NY).ok).toBe(false);
    expect(parseReminderWhen('2026-10-02T25:00', NY).ok).toBe(false);
  });
});
