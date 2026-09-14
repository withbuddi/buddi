/**
 * `buddi telegram devices` — the pure parts. No database, no Telegram.
 */
import { describe, expect, it } from 'vitest';
import { relativeTime } from './telegram-cmd.js';

const NOW = new Date('2026-09-13T17:35:00-04:00');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('relativeTime', () => {
  it('says "never" for a device that has never spoken', () => {
    expect(relativeTime(null, NOW)).toBe('never');
    expect(relativeTime(undefined, NOW)).toBe('never');
  });

  it('rounds down to minutes, hours, days and years, one unit at a time', () => {
    expect(relativeTime(ago(3 * MINUTE), NOW)).toBe('3 min ago');
    expect(relativeTime(ago(59 * MINUTE + 59_000), NOW)).toBe('59 min ago');
    expect(relativeTime(ago(HOUR + 4 * MINUTE), NOW)).toBe('1 hour ago');
    expect(relativeTime(ago(5 * HOUR), NOW)).toBe('5 hours ago');
    expect(relativeTime(ago(DAY), NOW)).toBe('1 day ago');
    expect(relativeTime(ago(3 * DAY + 7 * HOUR), NOW)).toBe('3 days ago');
    expect(relativeTime(ago(400 * DAY), NOW)).toBe('1 year ago');
  });

  it('calls anything under a minute "just now"', () => {
    expect(relativeTime(ago(0), NOW)).toBe('just now');
    expect(relativeTime(ago(59_000), NOW)).toBe('just now');
    expect(relativeTime(ago(MINUTE), NOW)).toBe('1 min ago');
  });

  it('never reports a negative age when the clocks disagree', () => {
    expect(relativeTime(new Date(NOW.getTime() + 10 * MINUTE), NOW)).toBe('just now');
  });

  it('treats an unreadable date as never, rather than throwing at the owner', () => {
    expect(relativeTime(new Date('nope'), NOW)).toBe('never');
  });
});
