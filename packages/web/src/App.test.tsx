/**
 * The shell, and the page it opens on.
 *
 * Home is the landing route: with no server behind it the page still renders
 * a greeting and the rail, rather than an error screen. Chat keeps its
 * conversation column, composer and canvas at `#/chat`. The old monitoring
 * hashes redirect to the place that now holds their content.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { App, NARROW_QUERY, PLACES, useMediaQuery } from './App';
import { fmtMoney, truncate } from './format';
import { api } from './api';
import { legacyRedirect, placeOf, pluginSettingsRoute } from './routes';
import { Home, greeting, needsSentence } from './views/Home';

afterEach(() => { cleanup(); window.history.replaceState(null, '', '#/'); });

describe('the shell', () => {
  it('opens on home, and survives a server that is not there', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await act(async () => {
      render(<App />);
    });
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/Good|Still up/);
    expect(screen.getByLabelText('Places')).toBeDefined();
    vi.unstubAllGlobals();
  });

  it('keeps the workbench at #/chat', async () => {
    window.history.replaceState(null, '', '#/chat');
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

  it('has six places on the rail, and sends every old hash to one of them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));
    await act(async () => {
      render(<App />);
    });
    expect(PLACES).toHaveLength(6);
    for (const place of PLACES) expect(screen.getByRole('link', { name: new RegExp(`^${place.label}`) })).toBeDefined();
    expect(screen.getByLabelText(/theme/i)).toBeDefined();
    for (const old of ['#/overview', '#/events', '#/jobs', '#/conversations', '#/missions', '#/approvals', '#/offers', '#/reminders', '#/providers', '#/browser', '#/sentinels']) {
      const target = legacyRedirect(old);
      expect(target, old).not.toBeNull();
      expect(PLACES.map((p) => p.route)).toContain(placeOf(target!));
    }
    expect(legacyRedirect('#/conversations/abc')).toBe('#/activity/conversations/abc');
    /*
     * Mail is a plugin's page now (docs/specs/plugin-pages.md §7 step 2), and
     * these two hashes are in bookmarks, in the owner's history and in every
     * "open in buddi" link Telegram has sent. A conversation keeps its id.
     */
    expect(legacyRedirect('#/email')).toBe('#/p/email/mail');
    expect(legacyRedirect('#/email/abc')).toBe('#/p/email/mail/abc');
    expect(legacyRedirect('#/settings/email')).toBe(pluginSettingsRoute('email', 'settings'));
    expect(legacyRedirect('#/chat/x')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('turns the canvas into a sheet on a phone-width screen', () => {
    // The breakpoint is a stated number, not a guess made in three places.
    expect(NARROW_QUERY).toBe('(max-width: 900px)');
    expect(typeof useMediaQuery).toBe('function');
  });
});

describe('home', () => {
  it('says what needs a human, in one sentence', () => {
    expect(needsSentence(0, 0, 0, 0, false)).toBe('Nothing needs you. Your agents are on it.');
    expect(needsSentence(2, 2, 0, 0, false)).toBe('2 approvals waiting.');
    expect(needsSentence(3, 1, 3, 1, false)).toBe('1 approval waiting, 3 failed jobs and 1 urgent finding.');
    expect(needsSentence(1, 0, 0, 0, true)).toBe('The installation is paused.');
  });

  it('greets by the hour in the owner\'s time zone', () => {
    expect(greeting('2026-09-14T09:00:00Z', 'UTC')).toBe('Good morning.');
    expect(greeting('2026-09-14T15:00:00Z', 'UTC')).toBe('Good afternoon.');
    expect(greeting('2026-09-14T21:00:00Z', 'UTC')).toBe('Good evening.');
    expect(greeting('2026-09-14T03:00:00Z', 'UTC')).toBe('Still up?');
  });

  it('puts what needs a human above the team', async () => {
    vi.spyOn(api, 'overview').mockResolvedValue({
      now: '2026-09-14T09:00:00Z', timezone: 'UTC', paused: false,
      home: [{ id: 'finance.money', title: 'Money', stats: [{ label: 'Cash', value: '$4,210', note: 'spendable accounts' }], rows: [{ title: 'Rent', sub: '2026-09-20', side: '-$300', tone: 'critical' }], rowsTitle: 'Next 14 days', sensitive: true }],
      approvals: { pending: 1, oldestPendingAt: '2026-09-14T07:00:00Z' },
      jobs: { pending: 1, leased: 0, suspended: 0, failed: 3, succeeded: 9, cancelled: 0 },
      missions: { total: 2, enabled: 1, nextRun: '2026-09-19T13:00:00Z' },
      reminders: { pending: 0, nextDueAt: null },
      sentinels: { lastRunAt: '2026-09-14T08:59:00Z', openUrgent: 1, openInfo: 0, errors: [] },
      mail: [],
    } as never);
    vi.spyOn(api, 'approvals').mockResolvedValue({ pending: [{ id: 'a1', tool: 'email.send', toolVersion: '1', agentId: 'ledger', preview: 'Send the invoice', expiresAt: '2026-09-14T10:00:00Z', policyVersion: 1, argsHash: 'abcdef123456', envelope: {}, canonicalArgs: {} }], recent: [] } as never);
    vi.spyOn(api, 'missions').mockResolvedValue({ missions: [] });
    vi.spyOn(api, 'reminders').mockResolvedValue({ reminders: [] });
    vi.spyOn(api, 'conversations').mockResolvedValue({ conversations: [] });
    vi.spyOn(api, 'offers').mockResolvedValue({ offers: [], closed: [] });
    const agents = [{ id: 'ledger', handle: 'ledger', name: 'Ledger', description: 'Keeps the books', available: true, roles: [], provider: 'x', model: 'y' }];
    await act(async () => {
      render(<Home timezone="UTC" navigate={() => {}} agents={agents} attention={new Map()} />);
    });
    await waitFor(() => expect(screen.getByText('Needs you')).toBeDefined());
    expect(screen.getByText(/1 approval waiting, 3 failed jobs and 1 urgent finding/)).toBeDefined();
    expect(screen.getByText('Send the invoice')).toBeDefined();
    // Sensitive: masked until asked, then shown.
    expect(screen.queryByText('$4,210')).toBeNull();
    expect(screen.getByText(/1 item hidden/)).toBeDefined();
    screen.getByRole('button', { name: 'Show' }).click();
    await waitFor(() => expect(screen.getByText('$4,210')).toBeDefined());
    expect(screen.getByText('Rent')).toBeDefined();
    expect(screen.getByText('Ledger')).toBeDefined();
    vi.restoreAllMocks();
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
