/**
 * Home says, once and quietly, when a newer buddi is ready, and where to
 * upgrade. A checkout never hears it: it upgrades with git.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { api, type NotificationRow, type VersionView } from '../api';
import { Home, homeNotifications } from './Home';

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
      notifications: vi.fn(async () => ({ notifications: [] })),
      notificationSeen: vi.fn(async () => ({ ok: true })),
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

function note(over: Partial<NotificationRow>): NotificationRow {
  return {
    id: 'n1', kind: 'watcher', urgency: 'now', title: 'A mail from the bank', text: null, link: '#/chat/finance',
    agentId: null, pluginId: null, actionId: null, state: 'shown', dueAt: null, channel: 'dashboard',
    createdAt: '2026-09-21T08:50:00Z', sentAt: null, seenAt: null, actedAt: null, error: null, ...over,
  };
}

describe('what buddi kept for you, under "Needs you"', () => {
  it('lists a watcher row and a held one, counts them in the greeting, and opening one marks it seen', async () => {
    vi.mocked(api.notifications).mockResolvedValue({
      notifications: [
        note({}),
        note({ id: 'n2', kind: 'recap', urgency: 'today', state: 'held', title: 'The weekly recap', seenAt: '2026-09-21T08:55:00Z', link: null }),
        note({ id: 'n3', kind: 'approval', title: 'Send the invoice?' }),
        note({ id: 'n4', title: 'Seen already', seenAt: '2026-09-21T08:55:00Z', state: 'sent', channel: 'telegram.chat' }),
      ],
    });
    const navigate = vi.fn();
    await home(null, navigate);
    expect(screen.getByText('2 messages for you.')).toBeInTheDocument();
    expect(screen.getByText('Needs you')).toBeInTheDocument();
    expect(screen.getByText('The weekly recap')).toBeInTheDocument();
    expect(screen.queryByText('Send the invoice?')).not.toBeInTheDocument();
    expect(screen.queryByText('Seen already')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: /A mail from the bank/ }));
    expect(api.notificationSeen).toHaveBeenCalledWith('n1');
    expect(navigate).toHaveBeenCalledWith('#/chat/finance');
  });

  it('leaves out a row about an approval Home already draws as a card', () => {
    const rows = [note({ id: 'a', actionId: 'act-1', kind: 'failure' }), note({ id: 'b', actionId: 'act-2' }), note({ id: 'c', actedAt: '2026-09-21T08:56:00Z' })];
    expect(homeNotifications(rows, [{ id: 'act-1' }]).map((row) => row.id)).toEqual(['b']);
  });
});
