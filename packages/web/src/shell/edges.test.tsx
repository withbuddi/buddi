/**
 * The shell's edges in place: the banner slot replaces the old separate
 * banners, the status line reads what the shell polls, and on a phone it folds
 * into the rail's dot.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { App, PHONE_QUERY } from '../App';
import { RECOVERY_BANNER } from '../views/Recovery';

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const ANSWERS: Record<string, unknown> = {
  '/api/overview': {
    now: '2026-10-01T09:00:00Z', timezone: 'UTC', paused: true, home: [], glances: [],
    approvals: { pending: 2, oldestPendingAt: null },
    jobs: { pending: 0, leased: 0, suspended: 0, failed: 1, succeeded: 3, cancelled: 0 },
    missions: { total: 0, enabled: 0, nextRun: null }, reminders: { pending: 0, nextDueAt: null },
    sentinels: { lastRunAt: null, openUrgent: 0, openInfo: 0, errors: [] }, mail: [], running: 1,
  },
  '/api/recovery': { active: true, restoredAt: null, archive: null, checklist: { secrets: [], plugins: [] } },
  '/api/version': { current: '0.1.0-pre.28', latest: '0.1.0-pre.29', updateAvailable: true, checkEnabled: true, history: [], supervised: true, checkout: false },
  '/api/session': { csrf: 'c', timezone: 'UTC', host: '127.0.0.1', port: 4327 },
  '/api/notifications/focus': { focus: null },
};

function stubServer(): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), 'http://127.0.0.1').pathname;
    return path in ANSWERS ? json(ANSWERS[path]) : new Response('', { status: 401 });
  }));
}

function phoneWidth(on: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: on && query === PHONE_QUERY, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
}

beforeEach(() => stubServer());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState(null, '', '#/'); });

describe("the shell's edges", () => {
  it('draws one banner, recovery first with a count of the rest, where the separate banners were', async () => {
    phoneWidth(false);
    await act(async () => { render(<App />); });
    const banner = await screen.findByText(RECOVERY_BANNER);
    const strip = banner.closest('.shell-banner')!;
    expect(strip).toHaveAttribute('data-banner', 'recovery');
    expect(within(strip as HTMLElement).getByText('+1 more')).toBeInTheDocument();
    expect(document.querySelectorAll('.shell-banner')).toHaveLength(1);
    // The old ones are gone: no recovery bar, no lost bar, no paused notice on Home.
    expect(document.querySelector('.recovery-banner, .lost-bar')).toBeNull();
    expect(screen.queryByText('The installation is paused.')).toBeNull();
  });

  it('reads the footer from what the shell polls, and on a phone folds it into the rail', async () => {
    phoneWidth(false);
    const { unmount } = render(<App />);
    const bar = await screen.findByRole('contentinfo', { name: 'Status' });
    await waitFor(() => expect(within(bar).getByRole('link', { name: 'Work: 1 agent working, Queue paused, 1 failed' })).toBeInTheDocument());
    expect(within(bar).getByRole('link', { name: '2 approvals waiting' })).toBeInTheDocument();
    expect(within(bar).getByRole('link', { name: 'buddi 0.1.0-pre.28, a newer buddi is ready: 0.1.0-pre.29' })).toBeInTheDocument();
    expect(within(bar).getByRole('link', { name: 'Connection: Local' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Status' })).toBeNull();
    unmount();

    phoneWidth(true);
    await act(async () => { render(<App />); });
    expect(screen.queryByRole('contentinfo', { name: 'Status' })).toBeNull();
    const places = screen.getByLabelText('Places');
    expect(within(places).getByRole('button', { name: 'Status' })).toBeInTheDocument();
    await waitFor(() => expect(within(places).getByTestId('rail-status-dot')).toHaveAttribute('data-tone', 'critical'));
  });
});
