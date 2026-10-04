/**
 * A stale widget on the lock screen: the last good body still draws, and its
 * title says quietly when it was made ("from 9:12"), in the lock's time format.
 */
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LockFace, lockStaleFrom, type LockFaceData } from './LockScreen';

afterEach(cleanup);

const list = { kind: 'list' as const, rows: [{ title: 'Central banks hold rates' }] };

describe('a stale widget on the lock screen', () => {
  it('says when its body was made, in the lock\'s time format, and nothing for a fresh one', () => {
    const at = '2026-10-01T09:12:00Z';
    expect(lockStaleFrom({ state: 'stale', updatedAt: at }, 'UTC', { time: '24h', date: null, zone: null }, new Date('2026-10-01T15:00:00Z'))).toBe('from 09:12');
    expect(lockStaleFrom({ state: 'stale', updatedAt: at }, 'UTC', { time: '12h', date: null, zone: null }, new Date('2026-10-01T15:00:00Z'))).toMatch(/^from 9:12\s?AM$/);
    expect(lockStaleFrom({ state: 'ok', updatedAt: at }, 'UTC', undefined)).toBeNull();
    expect(lockStaleFrom({ state: 'stale' }, 'UTC', undefined)).toBeNull();
  });

  it('names the day when the body is not from today in the lock\'s time zone, across midnight', () => {
    const view = { time: '24h' as const, date: null, zone: null };
    // 23:50 in New York on Wed 30 Sep is 03:50 UTC on Thu 1 Oct.
    const late = { state: 'stale', updatedAt: '2026-10-01T03:50:00Z' };
    // Five minutes later in New York, still Wednesday: today.
    expect(lockStaleFrom(late, 'America/New_York', view, new Date('2026-10-01T03:55:00Z'))).toBe('from 23:50');
    // Twenty minutes later it is Thursday in New York: yesterday (in UTC both are the 1st).
    expect(lockStaleFrom(late, 'America/New_York', view, new Date('2026-10-01T04:10:00Z'))).toBe('from yesterday 23:50');
    expect(lockStaleFrom(late, 'UTC', view, new Date('2026-10-01T04:10:00Z'))).toBe('from 03:50');
    // Within the week: the weekday; before that, the date.
    expect(lockStaleFrom(late, 'America/New_York', view, new Date('2026-10-03T12:00:00Z'))).toBe('from Wed 23:50');
    expect(lockStaleFrom(late, 'America/New_York', view, new Date('2026-10-09T12:00:00Z'))).toMatch(/^from .*(30|Sep).* 23:50$/);
  });

  it('draws the body with "from …" after its title', () => {
    const data: LockFaceData = {
      timezone: 'UTC', background: 'field', image: null, focus: null, approvals: 0, needs: 0,
      clockView: { time: '24h', date: null, zone: null },
      widgets: [
        { key: 'a', id: 'news.top', title: 'Top stories', size: 'small', view: { state: 'stale', body: list, updatedAt: '2026-10-01T09:12:00Z' } },
        { key: 'b', id: 'demo.ok', title: 'Fresh', size: 'small', view: { state: 'ok', body: list } },
      ],
    };
    const { container } = render(<LockFace data={data} now={new Date('2026-10-01T15:00:00Z')} phone={false} />);
    const titles = [...container.querySelectorAll('.wg-compact-title')].map((t) => t.textContent);
    expect(titles).toEqual(['Top stories · from 09:12', 'Fresh']);
    expect(container.querySelector('[data-stale="true"]')?.getAttribute('aria-label')).toBe('Top stories');
    expect(container.textContent).toContain('Central banks hold rates');
  });
});
