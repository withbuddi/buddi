/**
 * Home says, once and quietly, when a newer buddi is ready, and where to
 * upgrade. A checkout never hears it: it upgrades with git.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { api, type VersionView } from '../api';
import { Home } from './Home';

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api')>();
  const empty = (value: unknown) => vi.fn(async () => value);
  return {
    ...original,
    api: {
      ...original.api,
      overview: vi.fn(),
      approvals: empty({ pending: [], recent: [] }),
      missions: empty({ missions: [] }),
      reminders: empty({ reminders: [] }),
      conversations: empty({ conversations: [] }),
      offers: empty({ offers: [], closed: [] }),
      proposals: empty({ open: [] }),
      agentOffers: empty({ offers: [] }),
      owner: empty({}),
      version: vi.fn(),
    },
  };
});

const OVERVIEW = {
  now: '2026-09-21T09:00:00Z', timezone: 'UTC', paused: false, home: [],
  approvals: { pending: 0, oldestPendingAt: null },
  jobs: { pending: 0, leased: 0, suspended: 0, failed: 0, succeeded: 0, cancelled: 0 },
  missions: { total: 0, enabled: 0, nextRun: null },
  reminders: { pending: 0, nextDueAt: null },
  sentinels: { lastRunAt: null, openUrgent: 0, openInfo: 0, errors: [] },
  mail: [],
};

const NEWER: VersionView = {
  current: '0.1.0', latest: '0.1.1', checkEnabled: true, updateAvailable: true, history: [], supervised: true, checkout: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.overview).mockResolvedValue(OVERVIEW as never);
});

async function home(update?: VersionView | null, navigate = vi.fn()): Promise<void> {
  await act(async () => {
    render(<Home timezone="UTC" navigate={navigate} agents={[]} attention={new Map()} update={update} />);
  });
}

describe('the upgrade notice', () => {
  it('names the newer version and links to the Version panel, under an unchanged greeting', async () => {
    const navigate = vi.fn();
    await home(NEWER, navigate);
    expect(screen.getByText('Nothing needs you. Your agents are on it.')).toBeInTheDocument();
    expect(screen.getByText(/A newer buddi is ready:/)).toHaveTextContent('A newer buddi is ready: 0.1.1. Upgrade from Settings → Version.');
    const link = screen.getByRole('link', { name: 'Upgrade from Settings → Version.' });
    expect(link).toHaveAttribute('href', '#/settings/system');
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith('#/settings/system');
    // The shell read the version; Home does not ask again.
    expect(api.version).not.toHaveBeenCalled();
  });

  it('says nothing when there is no newer version', async () => {
    await home({ ...NEWER, latest: '0.1.0', updateAvailable: false });
    expect(screen.queryByText(/A newer buddi is ready/)).not.toBeInTheDocument();
  });

  it('says nothing to a checkout, whatever the view says', async () => {
    await home({ ...NEWER, checkout: true, supervised: false });
    expect(screen.queryByText(/A newer buddi is ready/)).not.toBeInTheDocument();
  });

  it('says nothing before the version is known', async () => {
    await home(undefined);
    expect(screen.queryByText(/A newer buddi is ready/)).not.toBeInTheDocument();
  });
});
