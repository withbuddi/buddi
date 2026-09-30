/**
 * Home says, once and quietly, when a newer buddi is ready, and where to
 * upgrade. A checkout never hears it: it upgrades with git.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { api, chatApi, type NotificationRow, type VersionView } from '../api';
import type { ChatAgent } from '../chat/types';
import { useSlashToComposer } from '../shell/slash';
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
      currentTip: vi.fn(async () => ({ tip: null, enabled: true })),
      tips: vi.fn(async () => ({ tips: [], enabled: true })),
    },
    chatApi: {
      ...original.chatApi,
      conversations: vi.fn(async () => ({ conversations: [] })),
      startConversation: vi.fn(),
      send: vi.fn(),
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
  window.localStorage.clear();
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
    // One line: the sentence, the version and the link share one paragraph,
    // not three stacked rows of the notice.
    const line = screen.getByText(/A newer buddi is ready:/);
    expect(line.tagName).toBe('P');
    expect(line.parentElement).toHaveClass('ui-notice');
    expect(line.parentElement?.children).toHaveLength(1);
    expect(line.querySelector('.mono')).toHaveTextContent('0.1.1');
    const link = screen.getByRole('link', { name: 'Upgrade from Settings → Version.' });
    expect(line).toContainElement(link);
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

describe('the tip', () => {
  it('puts the Tips lightbulb on the date line of the glance', async () => {
    await home(undefined);
    const bulb = screen.getByRole('button', { name: 'Tips' });
    expect(bulb.closest('.home-top')).not.toBeNull();
    expect(bulb.parentElement).toHaveClass('home-date');
  });

  it('sits under the greeting, above the notices', async () => {
    vi.mocked(api.currentTip).mockResolvedValueOnce({ tip: { id: 'make-group', text: 'Put them in a group.', action: { label: 'Make a group', route: '#/chat?group=new' } }, enabled: true });
    await home(NEWER);
    const tip = screen.getByText('Put them in a group.');
    const upgrade = screen.getByText(/A newer buddi is ready:/);
    expect(tip.compareDocumentPosition(upgrade) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opens the Tips section under the greeting and hides the tip card while it is open', async () => {
    vi.mocked(api.currentTip).mockResolvedValueOnce({ tip: { id: 'make-group', text: 'Put them in a group.', action: { label: 'Make a group', route: '#/chat?group=new' } }, enabled: true });
    await home(undefined);
    expect(screen.getByText('Put them in a group.')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Tips' })); });
    expect(screen.getByTestId('tips-section').closest('.home')).not.toBeNull();
    expect(screen.queryByText('Put them in a group.')).not.toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Tips' })); });
    expect(screen.getByText('Put them in a group.')).toBeInTheDocument();
  });
});

describe('connections that need the owner', () => {
  it('says so in one line each, linking to Settings → Connections', async () => {
    const navigate = vi.fn();
    await act(async () => {
      render(
        <Home
          timezone="UTC" navigate={navigate} agents={[]} attention={new Map()}
          connectionSignals={[
            { id: 'a', name: 'GitHub', state: 'needs-reconnect', sentence: 'GitHub needs you to sign in again.' },
            { id: 'b', name: 'Notion', state: 'needs-review', sentence: 'Notion changed its tools; review them.' },
          ]}
        />,
      );
    });
    const line = screen.getByText(/GitHub needs you to sign in again\./);
    expect(line.tagName).toBe('P');
    expect(line.parentElement).toHaveClass('ui-notice');
    expect(screen.getByText(/Notion changed its tools; review them\./)).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Settings → Connections.' });
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveAttribute('href', '#/settings/connections');
    fireEvent.click(links[0]!);
    expect(navigate).toHaveBeenCalledWith('#/settings/connections');
  });

  it('says nothing when every connection is fine', async () => {
    await home(undefined);
    expect(screen.queryByText(/Settings → Connections/)).not.toBeInTheDocument();
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
    window.localStorage.setItem('buddi.needsYouView', 'list');
    await home(null, navigate);
    expect(screen.getByRole('button', { name: '2 messages' })).toBeInTheDocument();
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

const DESK: ChatAgent = {
  id: 'concierge', handle: 'concierge', name: 'Concierge', description: 'The front desk.', available: true,
  roles: [], provider: 'anthropic', model: 'claude-sonnet-5',
} as ChatAgent;

async function frontDesk(navigate = vi.fn()): Promise<void> {
  function Shell(): JSX.Element {
    useSlashToComposer(navigate);
    return <Home timezone="UTC" navigate={navigate} agents={[DESK]} defaultAgentId="concierge" attention={new Map()} />;
  }
  await act(async () => { render(<Shell />); });
}

describe("Home's composer", () => {
  it('asks the default agent by name, focused on a wide screen', async () => {
    await frontDesk();
    const box = screen.getByPlaceholderText('Message Concierge…');
    expect(box).toHaveFocus();
  });

  it('opens a conversation, sends to it and goes there', async () => {
    vi.mocked(chatApi.startConversation).mockResolvedValue({ conversationId: 'c-new' });
    vi.mocked(chatApi.send).mockResolvedValue({ conversationId: 'c-new', runId: 'r1' });
    const navigate = vi.fn();
    await frontDesk(navigate);
    const box = screen.getByPlaceholderText('Message Concierge…');
    fireEvent.change(box, { target: { value: 'Book a table for two' } });
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    expect(chatApi.startConversation).toHaveBeenCalledWith('concierge');
    expect(chatApi.send).toHaveBeenCalledWith('concierge', { conversationId: 'c-new', text: 'Book a table for two' });
    expect(navigate).toHaveBeenCalledWith('#/chat/concierge/c-new');
  });

  it('keeps the words and says why when the conversation cannot be opened', async () => {
    vi.mocked(chatApi.startConversation).mockRejectedValue(new Error('The gateway is down.'));
    const navigate = vi.fn();
    await frontDesk(navigate);
    const box = screen.getByPlaceholderText('Message Concierge…');
    fireEvent.change(box, { target: { value: 'Still there?' } });
    await act(async () => { fireEvent.keyDown(box, { key: 'Enter' }); });
    expect(screen.getByText(/The gateway is down\./)).toBeInTheDocument();
    expect(box).toHaveValue('Still there?');
    expect(chatApi.send).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('`/` outside a field focuses it; inside a field it is typed', async () => {
    await frontDesk();
    const box = screen.getByPlaceholderText('Message Concierge…');
    act(() => { box.blur(); });
    expect(box).not.toHaveFocus();
    act(() => { fireEvent.keyDown(document.body, { key: '/' }); });
    expect(box).toHaveFocus();
    const other = document.createElement('input');
    document.body.appendChild(other);
    act(() => { other.focus(); });
    act(() => { fireEvent.keyDown(other, { key: '/' }); });
    expect(other).toHaveFocus();
    other.remove();
  });

  it('`/` on a page without a composer goes home', () => {
    const navigate = vi.fn();
    function Page(): JSX.Element { useSlashToComposer(navigate); return <p>Settings</p>; }
    render(<Page />);
    fireEvent.keyDown(document.body, { key: '/' });
    expect(navigate).toHaveBeenCalledWith('#/');
  });

  it("puts the front desk's last three conversations under the box as chips, each a click back", async () => {
    vi.mocked(chatApi.conversations).mockResolvedValue({
      conversations: [
        { id: 'c1', opening: 'Flights to Lisbon', lastMessageAt: new Date(Date.now() - 2 * 3600_000).toISOString(), messageCount: 4 },
        { id: 'c2', opening: 'The dentist, and whether Thursday afternoon still works for everyone', lastMessageAt: new Date(Date.now() - 8 * 60_000).toISOString(), messageCount: 2 },
        { id: 'c3', preview: 'Groceries', lastMessageAt: null, createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(), messageCount: 1 },
      ],
    });
    const navigate = vi.fn();
    await frontDesk(navigate);
    expect(chatApi.conversations).toHaveBeenCalledWith('concierge', 3);
    expect(screen.getByText('Continue')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Flights to Lisbon 2 h' });
    expect(link).toHaveAttribute('href', '#/chat/concierge/c1');
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith('#/chat/concierge/c1');
    expect(screen.getByRole('link', { name: 'The dentist, and whether Thursday after… 8 min' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Groceries 2 d' })).toBeInTheDocument();
  });
});

const BANK = note({ id: 'n1', title: 'A mail from the bank', text: 'Your card ending 4242 was charged twice.\nThe second charge is pending.', agentId: 'concierge' });
const RECAP = note({ id: 'n2', kind: 'recap', title: 'The weekly recap', link: '#/activity' });
const PLUGIN = note({ id: 'n3', kind: 'plugin', title: 'A plugin wants a key', link: null, pluginId: 'github' });

async function deck(rows: NotificationRow[], navigate = vi.fn()): Promise<void> {
  vi.mocked(api.notifications).mockResolvedValue({ notifications: rows });
  await act(async () => {
    render(<Home timezone="UTC" navigate={navigate} agents={[DESK]} attention={new Map()} />);
  });
}

describe('"Needs you" as a deck', () => {
  it('shows the first message in full, with its sender and the counter, and moves with the arrows', async () => {
    await deck([BANK, RECAP, PLUGIN]);
    const region = screen.getByRole('region', { name: 'Needs you, one at a time' });
    expect(region).toHaveTextContent('Concierge');
    expect(region).toHaveTextContent('A mail from the bank');
    expect(region).toHaveTextContent(/Your card ending 4242 was charged twice\.\s*The second charge is pending\./);
    expect(region).toHaveTextContent('1 of 3');
    expect(region).toHaveAttribute('data-depth', '2');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(region).toHaveTextContent('The weekly recap');
    expect(region).toHaveTextContent('2 of 3');
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(region).toHaveTextContent('1 of 3');
    fireEvent.keyDown(region, { key: 'ArrowLeft' });
    expect(region).toHaveTextContent('3 of 3');
    expect(region).toHaveTextContent('github');
    expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
    fireEvent.keyDown(region, { key: 'ArrowRight' });
    expect(region).toHaveTextContent('1 of 3');
  });

  it('Done marks it seen as the row did and brings the next one; d does the same', async () => {
    const navigate = vi.fn();
    await deck([BANK, RECAP, PLUGIN], navigate);
    const region = screen.getByRole('region', { name: 'Needs you, one at a time' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(api.notificationSeen).toHaveBeenCalledWith('n1');
    expect(navigate).not.toHaveBeenCalled();
    expect(region).toHaveTextContent('The weekly recap');
    expect(region).toHaveTextContent('1 of 2');
    expect(region).toHaveAttribute('data-depth', '1');
    fireEvent.keyDown(region, { key: 'd' });
    expect(api.notificationSeen).toHaveBeenCalledWith('n2');
    expect(region).toHaveTextContent('1 of 1');
    expect(region).toHaveAttribute('data-depth', '0');
    fireEvent.keyDown(region, { key: 'Delete' });
    expect(api.notificationSeen).toHaveBeenCalledWith('n3');
    expect(screen.queryByRole('region', { name: 'Needs you, one at a time' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Nothing needs you. Your agents are on it.').length).toBeGreaterThan(0);
  });

  it('Open and Enter go where the row went, and mark it seen', async () => {
    const navigate = vi.fn();
    await deck([BANK, RECAP], navigate);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(api.notificationSeen).toHaveBeenCalledWith('n1');
    expect(navigate).toHaveBeenCalledWith('#/chat/finance');
    const region = screen.getByRole('region', { name: 'Needs you, one at a time' });
    fireEvent.keyDown(region, { key: 'Enter' });
    expect(api.notificationSeen).toHaveBeenCalledWith('n2');
    expect(navigate).toHaveBeenCalledWith('#/activity');
  });

  it('names the other agents a folded row came from, on the deck and in the list', async () => {
    const MAIL = { ...DESK, id: 'mail', handle: 'mail', name: 'Mail Triage' } as ChatAgent;
    vi.mocked(api.notifications).mockResolvedValue({ notifications: [{ ...BANK, alsoFrom: ['mail'] }] });
    await act(async () => {
      render(<Home timezone="UTC" navigate={vi.fn()} agents={[DESK, MAIL]} attention={new Map()} />);
    });
    const region = screen.getByRole('region', { name: 'Needs you, one at a time' });
    expect(region).toHaveTextContent('Concierge · also Mail Triage');
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    expect(screen.getByRole('link', { name: /A mail from the bank/ })).toHaveTextContent('Concierge · also Mail Triage');
  });

  it("drops the \"@handle: \" signature of an agent's own message, which the card and the row already name", async () => {
    const SIGNED = note({ id: 'n9', kind: 'agent', title: '@concierge: Your parcel is at the door', agentId: 'concierge' });
    await deck([SIGNED]);
    const region = screen.getByRole('region', { name: 'Needs you, one at a time' });
    expect(region).toHaveTextContent('Concierge');
    expect(region).toHaveTextContent('Your parcel is at the door');
    expect(region).not.toHaveTextContent('@concierge:');
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    const line = screen.getByRole('link', { name: /Your parcel is at the door/ });
    expect(line).not.toHaveTextContent('@concierge:');
  });

  it('switches to the list and remembers it', async () => {
    await deck([BANK, RECAP]);
    expect(screen.getByRole('radio', { name: 'Deck' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    expect(screen.queryByRole('region', { name: 'Needs you, one at a time' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /A mail from the bank/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /The weekly recap/ })).toBeInTheDocument();
    expect(window.localStorage.getItem('buddi.needsYouView')).toBe('list');
  });
});
