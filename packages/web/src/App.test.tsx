/**
 * The shell, and the page it opens on.
 *
 * Chat is the landing route now: with no server behind it the page still
 * renders a conversation column, a composer and a canvas, rather than an error
 * screen. The monitoring pages moved behind the rail, so the assertion about
 * them is that they are *reachable*, not that they are on screen.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, NARROW_QUERY, SECTIONS, useMediaQuery } from './App';
import { fmtMoney, truncate } from './format';
import { Overview } from './views/Overview';

afterEach(cleanup);

describe('the shell', () => {
  it('opens on the workbench, and survives a server that is not there', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    // Awaited so the first (failing) loads settle inside the act boundary.
    await act(async () => {
      render(<App />);
    });

    // Chat on the left, canvas on the right — both present with no data.
    expect(screen.getByTestId('chat-column')).toBeDefined();
    expect(screen.getByTestId('composer')).toBeDefined();
    expect(screen.getByTestId('canvas')).toBeDefined();
    expect(screen.getByLabelText('Resize the conversation column')).toBeDefined();
    vi.unstubAllGlobals();
  });

  it('keeps every monitoring section reachable from the rail', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await act(async () => {
      render(<App />);
    });
    // Ten pages now — Offers joined them — and every one of them is still
    // behind the menu rather than a sidebar. The count is asserted so that
    // adding a page is a deliberate act rather than a drift.
    expect(SECTIONS).toHaveLength(11);
    expect(SECTIONS.map((s) => s.route)).toContain('#/browser');
    expect(SECTIONS.map((s) => s.route)).toContain('#/offers');
    expect(screen.getByLabelText('Monitoring sections')).toBeDefined();
    expect(screen.getByLabelText(/theme/i)).toBeDefined();
    vi.unstubAllGlobals();
  });

  it('turns the canvas into a sheet on a phone-width screen', () => {
    // The breakpoint is a stated number, not a guess made in three places.
    expect(NARROW_QUERY).toBe('(max-width: 900px)');
    expect(typeof useMediaQuery).toBe('function');
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
    mail: [{ sourceId: 'demo.inbox-poll', lastRunAt: '2026-09-14T08:58:00Z', lastError: null }],
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
