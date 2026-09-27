import { describe, expect, it } from 'vitest';
import { withoutFence, fmtCached, fmtInOut, fmtShortRelative } from './format';

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
