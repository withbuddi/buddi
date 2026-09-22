/**
 * The Watchers page: what is installed, when it last ran, and the switch.
 *
 * What is pinned here is the switch and the words around it. A watcher that is
 * off must read as off rather than as "never ran" — the two look identical on a
 * page that only shows the ledger, and the difference is whether the owner is
 * waiting for news that will never come.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError, api, type SentinelsView } from '../api';
import { Watchers, everyText } from './Watchers';

vi.mock('../api', async (load) => {
  const real = await load<typeof import('../api')>();
  return {
    ...real,
    api: { sentinels: vi.fn(), setSentinelEnabled: vi.fn() },
  };
});

const WAITING = {
  id: 'email.waiting-on-me',
  description: 'Reports conversations waiting on you for longer than your setting.',
  every: 12 * 60 * 60,
  enabled: true,
};

const DATES = {
  id: 'email.date-stated',
  description: 'Reports a date stated in a message that falls in the next 14 days.',
  every: 60 * 60,
  enabled: true,
};

function view(over: Partial<SentinelsView> = {}): SentinelsView {
  return {
    installed: [WAITING, DATES],
    runs: [
      { sentinelId: 'email.waiting-on-me', lastRunAt: '2026-09-21T09:00:00Z', lastError: null },
    ],
    open: [],
    resolved: [],
    digest: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.sentinels).mockResolvedValue(view());
  vi.mocked(api.setSentinelEnabled).mockResolvedValue({ sentinelId: 'email.date-stated', enabled: false });
});

describe('the watcher rows', () => {
  it('lists both mail watchers with their period and their last run', async () => {
    render(<Watchers timezone="UTC" />);
    expect(await screen.findByText(WAITING.description)).toBeInTheDocument();
    expect(screen.getByText(DATES.description)).toBeInTheDocument();
    expect(screen.getByText('email.waiting-on-me, every 12 hours')).toBeInTheDocument();
    expect(screen.getByText('email.date-stated, every hour')).toBeInTheDocument();
    // One has run and one has not, and the row says which.
    expect(screen.getAllByText('ok')).toHaveLength(1);
    expect(screen.getAllByText('never ran').length).toBeGreaterThan(0);
  });

  it('says a failed run in the row, and once above the list', async () => {
    vi.mocked(api.sentinels).mockResolvedValue(
      view({
        runs: [
          {
            sentinelId: 'email.date-stated',
            lastRunAt: '2026-09-21T09:00:00Z',
            lastError: 'relation "email.dates" does not exist',
          },
        ],
      }),
    );
    render(<Watchers timezone="UTC" />);
    expect(await screen.findByText('One watcher failed on its last run.')).toBeInTheDocument();
    expect(
      screen.getByText(/relation "email\.dates" does not exist/),
    ).toBeInTheDocument();
  });
});

describe('the switch', () => {
  it('turns a watcher off and reads the list again', async () => {
    render(<Watchers timezone="UTC" />);
    const rows = await screen.findAllByRole('button', { name: 'Turn off' });
    expect(rows).toHaveLength(2);
    fireEvent.click(rows[1]!);
    await waitFor(() =>
      expect(api.setSentinelEnabled).toHaveBeenCalledWith('email.date-stated', false),
    );
    await waitFor(() => expect(api.sentinels).toHaveBeenCalledTimes(2));
  });

  it('shows a watcher that is off as off, and offers to turn it on', async () => {
    vi.mocked(api.sentinels).mockResolvedValue(
      view({ installed: [WAITING, { ...DATES, enabled: false }] }),
    );
    render(<Watchers timezone="UTC" />);
    expect(await screen.findByText('off')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn on' })).toBeInTheDocument();
    expect(
      screen.getByText(/One watcher is off\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/what it already found stays as it was/)).toBeInTheDocument();
  });

  it("says what the server refused, in the server's words", async () => {
    vi.mocked(api.setSentinelEnabled).mockRejectedValue(new ApiError(400, '`enabled` must be true or false'));
    render(<Watchers timezone="UTC" />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Turn off' }))[0]!);
    expect(await screen.findByText('`enabled` must be true or false')).toBeInTheDocument();
  });

  it('says so when nothing is installed', async () => {
    vi.mocked(api.sentinels).mockResolvedValue(view({ installed: [], runs: [] }));
    render(<Watchers timezone="UTC" />);
    expect(await screen.findByText(/No watchers are installed/)).toBeInTheDocument();
  });
});

describe('everyText', () => {
  it('says a period the way a person would', () => {
    expect(everyText(3_600)).toBe('hour');
    expect(everyText(12 * 3_600)).toBe('12 hours');
    expect(everyText(86_400)).toBe('day');
    expect(everyText(2 * 86_400)).toBe('2 days');
    expect(everyText(300)).toBe('5 minutes');
  });
});
