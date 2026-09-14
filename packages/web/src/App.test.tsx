/**
 * Two smoke tests: the shell renders its nav with no server behind it, and the
 * Overview renders the numbers it is given — including the "needs attention"
 * block, which is the whole point of the landing page.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, NAV } from './App';
import { fmtMoney, truncate } from './format';
import { Overview } from './views/Overview';

afterEach(cleanup);

describe('the shell', () => {
  it('renders every section even when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    // Awaited so the first (failing) loads settle inside the act boundary.
    await act(async () => {
      render(<App />);
    });
    for (const item of NAV) {
      expect(screen.getByText(item.label)).toBeDefined();
    }
    vi.unstubAllGlobals();
  });
});

describe('overview', () => {
  const data = {
    now: '2026-09-14T09:00:00Z',
    timezone: 'UTC',
    paused: false,
    finance: {
      available: true,
      currency: 'USD',
      cashTotal: 4210,
      netWorth: 19_050,
      totalDebt: 3300,
      upcoming: [{ date: '2026-09-20', balance: 3910, events: [{ name: 'Rent', amount: -300 }] }],
      minBalance: 120,
      minBalanceDate: '2026-09-26',
      breachesFloor: true,
    },
    approvals: { pending: 2, oldestPendingAt: '2026-09-14T07:00:00Z' },
    jobs: { pending: 1, leased: 0, suspended: 0, failed: 3, succeeded: 9, cancelled: 0 },
    missions: { total: 2, enabled: 1, nextRun: '2026-09-19T13:00:00Z' },
    reminders: { pending: 0, nextDueAt: null },
    sentinels: { lastRunAt: '2026-09-14T08:59:00Z', openUrgent: 1, openInfo: 0, errors: [] },
    mail: [{ sourceId: 'email.inbox-poll', lastRunAt: '2026-09-14T08:58:00Z', lastError: null }],
  };

  it('puts what needs a human above the numbers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(data), { status: 200 })),
    );
    await act(async () => {
      render(<Overview timezone="UTC" onNavigate={() => {}} />);
    });

    await waitFor(() => expect(screen.getByText('Needs attention')).toBeDefined());
    expect(screen.getByText(/2 approvals waiting for you/)).toBeDefined();
    expect(screen.getByText(/3 failed jobs/)).toBeDefined();
    expect(screen.getByText(/1 open urgent finding/)).toBeDefined();
    expect(screen.getByText('$4,210')).toBeDefined();
    expect(screen.getByText('Rent')).toBeDefined();
    vi.unstubAllGlobals();
  });
});

describe('formatting', () => {
  it('renders money in the reported currency and falls back rather than throwing', () => {
    expect(fmtMoney(1234.5, 'USD')).toBe('$1,235');
    expect(fmtMoney(null, 'USD')).toBe('—');
    expect(fmtMoney(10, 'NOT-A-CURRENCY')).toBe('10.00');
  });

  it('truncates with an ellipsis, never mid-promise', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello world', 6)).toBe('hello…');
  });
});
