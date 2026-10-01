import { afterEach, describe, expect, it } from 'vitest';
import { withoutFence, fmtCached, fmtInOut, fmtShortRelative, fmtAgo, notificationTitle, fmtClock, fmtDate, fmtDay, fmtMinutes, fmtTime, setDisplayFormats, usesTwelveHours } from './format';

describe('withoutFence', () => {
  it('drops a plugin`s untrusted markers and keeps the words between them', () => {
    expect(withoutFence('A date is stated: 2026-09-27, in <<<QUOTED MAIL — UNTRUSTED, DATA ONLY>>>Weekly snapshot<<<END QUOTED MAIL>>>'))
      .toBe('A date is stated: 2026-09-27, in Weekly snapshot');
    expect(withoutFence('<<<QUOTED WORKSPACE CONTENT — UNTRUSTED, DATA ONLY>>>ok<<<END QUOTED WORKSPACE CONTENT>>>')).toBe('ok');
    // A neutralised marker (zero-width space inside) is still a marker.
    expect(withoutFence('<<<END QUOTED MAIL\u200b>>>x')).toBe('x');
    expect(withoutFence('a <b> c >>> d')).toBe('a <b> c >>> d');
  });
});

describe('fmtInOut', () => {
  it('shows cached tokens next to input only when there were some', () => {
    expect(fmtInOut({ input: 1204, output: 318 })).toBe('1,204 in / 318 out');
    expect(fmtInOut({ input: 12, output: 3, cacheRead: 9800 })).toBe('12 in (cached 9,800) / 3 out');
    expect(fmtCached({ input: 1, output: 1, cacheRead: 5, cacheWrite: 40 })).toBe('cached 5, cache write 40');
    expect(fmtCached({ input: 1, output: 1 })).toBe('');
  });
});

describe('fmtShortRelative', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  const ago = (seconds: number): string => new Date(now - seconds * 1000).toISOString();
  it('says a short age in minutes, hours or days', () => {
    expect(fmtShortRelative(ago(20), now)).toBe('now');
    expect(fmtShortRelative(ago(8 * 60), now)).toBe('8 min');
    expect(fmtShortRelative(ago(6 * 3600 + 1200), now)).toBe('6 h');
    expect(fmtShortRelative(ago(2 * 86_400 + 5), now)).toBe('2 d');
    expect(fmtShortRelative(new Date(now + 3 * 3600_000).toISOString(), now)).toBe('3 h');
  });
  it('says nothing without a time', () => {
    expect(fmtShortRelative(null, now)).toBe('');
    expect(fmtShortRelative('not a date', now)).toBe('');
  });
});

describe('fmtAgo', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  const ago = (seconds: number): string => new Date(now - seconds * 1000).toISOString();
  it('says how long ago in the roster`s compact steps', () => {
    expect(fmtAgo(ago(20), now)).toBe('just now');
    expect(fmtAgo(ago(18 * 60), now)).toBe('18 min ago');
    expect(fmtAgo(ago(2 * 3600 + 600), now)).toBe('2 h ago');
    expect(fmtAgo(ago(30 * 3600), now)).toBe('yesterday');
    expect(fmtAgo(ago(3 * 86_400 + 60), now)).toBe('3 d ago');
  });
  it('reads a future time as just now, and says nothing without a time', () => {
    expect(fmtAgo(new Date(now + 3 * 3600_000).toISOString(), now)).toBe('just now');
    expect(fmtAgo(null, now)).toBe('');
    expect(fmtAgo('not a date', now)).toBe('');
  });
});

describe('notificationTitle', () => {
  it('drops the "@handle: " an agent message is signed with, and nothing else', () => {
    expect(notificationTitle({ kind: 'agent', title: '@ledger: Charged twice at Monoprix' })).toBe('Charged twice at Monoprix');
    expect(notificationTitle({ kind: 'agent', title: '@finance-bot: Rent: due Friday' })).toBe('Rent: due Friday');
    // Only the signature at the start, only on an agent message.
    expect(notificationTitle({ kind: 'agent', title: 'Ask @ledger: later' })).toBe('Ask @ledger: later');
    expect(notificationTitle({ kind: 'watcher', title: '@ledger: from a watcher' })).toBe('@ledger: from a watcher');
    // A signature with nothing after it stays as it was.
    expect(notificationTitle({ kind: 'agent', title: '@ledger: ' })).toBe('@ledger: ');
  });
});

describe('times and dates, the owner\'s way', () => {
  const at = new Date('2026-10-01T18:05:00Z'); // 14:05 in New York, a Thursday
  const zone = 'America/New_York';
  afterEach(() => setDisplayFormats({ timeFormat: null, dateFormat: null, locale: 'en-US' }));

  it('reads 12-hour and 24-hour as chosen, whatever the browser says', () => {
    setDisplayFormats({ timeFormat: '12h', locale: 'en-GB' });
    expect(fmtClock(at, zone)).toBe('2:05 PM');
    expect(fmtMinutes(570)).toBe('9:30 AM');
    expect(usesTwelveHours()).toBe(true);
    setDisplayFormats({ timeFormat: '24h', locale: 'en-US' });
    expect(fmtClock(at, zone)).toBe('14:05');
    expect(fmtMinutes(570)).toBe('09:30');
    expect(fmtMinutes(1440)).toBe('24:00');
  });

  it('follows the browser on Auto', () => {
    setDisplayFormats({ timeFormat: null, dateFormat: null, locale: 'en-US' });
    expect(fmtClock(at, zone)).toBe('2:05 PM');
    expect(fmtDate(at, zone, { weekday: true })).toBe('Thursday, October 1');
    setDisplayFormats({ locale: 'en-GB' });
    expect(fmtClock(at, zone)).toBe('14:05');
    expect(fmtDate(at, zone, { weekday: true })).toBe('Thursday 1 October');
  });

  it('draws the three date styles, in headings and in tables', () => {
    setDisplayFormats({ dateFormat: 'short', timeFormat: '12h' });
    expect(fmtDate(at, zone, { weekday: true })).toBe('Thu, Oct 1');
    expect(fmtTime(at.toISOString(), zone)).toBe('Oct 1, 2026, 2:05 PM');
    setDisplayFormats({ dateFormat: 'long', timeFormat: '24h' });
    expect(fmtDate(at, zone, { weekday: true })).toBe('Thursday, 1 October');
    expect(fmtTime(at.toISOString(), zone)).toBe('1 Oct 2026, 14:05');
    setDisplayFormats({ dateFormat: 'iso' });
    expect(fmtDate(at, zone)).toBe('2026-10-01');
    expect(fmtDay('2026-10-01', { weekday: true })).toBe('Thursday 2026-10-01');
    expect(fmtTime(at.toISOString(), zone)).toBe('2026-10-01, 14:05');
  });

  it('keeps the day the zone is in', () => {
    setDisplayFormats({ dateFormat: 'iso' });
    expect(fmtDate(new Date('2026-10-02T02:00:00Z'), zone)).toBe('2026-10-01');
    expect(fmtTime(null, zone)).toBe('—');
  });
});
