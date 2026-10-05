/**
 * Home says, once and quietly, when a newer buddi is ready, and where to
 * upgrade. A checkout never hears it: it upgrades with git.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { api, chatApi, type NotificationRow, type VersionView } from '../api';
import type { ChatAgent } from '../chat/types';
import { useSlashToComposer } from '../shell/slash';
import { DIGEST_FRESH_MS, Home, LearnedThisWeek, homeNotifications } from './Home';
import type { PluginPages } from '../pages/usePages';

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
      birthday: vi.fn(async () => ({ today: false, date: '2026-09-21', name: null, age: null, note: null, from: null, image: null })),
      version: vi.fn(),
      notifications: vi.fn(async () => ({ notifications: [] })),
      notificationsNeedingYou: vi.fn(async () => ({ notifications: [] })),
      notificationSeen: vi.fn(async () => ({ ok: true })),
      homeDismiss: vi.fn(async () => ({ dismissed: {} })),
      currentTip: vi.fn(async () => ({ tip: null, enabled: true })),
      tips: vi.fn(async () => ({ tips: [], enabled: true })),
      catalogue: vi.fn(async () => ({ agents: [], fromPlugins: [], delisted: [] })),
      plugins: vi.fn(async () => ({ installed: [], staged: [], trust: '', restartNeeded: false, checkout: false })),
      passphraseNotice: vi.fn(async () => ({ show: false })),
      acknowledgePassphrase: vi.fn(async () => ({ acknowledgedAt: '2026-09-21T09:00:00Z' })),
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
    expect(line.closest('.ui-notice')).not.toBeNull();
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

  it('closes with × until the next version, kept by the server', async () => {
    await home(NEWER);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Not now — tell me at the next version/ })); });
    expect(api.homeDismiss).toHaveBeenCalledWith('update', '0.1.1');
    expect(screen.queryByText(/A newer buddi is ready/)).not.toBeInTheDocument();
  });

  it('stays closed on reload for that version, and shows again for the next one', async () => {
    vi.mocked(api.overview).mockResolvedValue({ ...OVERVIEW, dismissed: { update: '0.1.1' } } as never);
    await home(NEWER);
    expect(screen.queryByText(/A newer buddi is ready/)).not.toBeInTheDocument();
    cleanup();
    await home({ ...NEWER, latest: '0.1.2' });
    expect(screen.getByText(/A newer buddi is ready/)).toBeInTheDocument();
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
    expect(line.closest('.ui-notice')).not.toBeNull();
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
    createdAt: '2026-09-21T08:50:00Z', sentAt: null, seenAt: null, actedAt: null, error: null,
    action: 'Check it', needsOwner: true, ...over,
  };
}

describe('what buddi kept for you, under "Needs you"', () => {
  it('lists a row that asks for something, counts it in the greeting, and opening it marks it seen', async () => {
    vi.mocked(api.notificationsNeedingYou).mockResolvedValue({
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
    expect(screen.getByRole('button', { name: '1 request' })).toBeInTheDocument();
    // Its ask is said under the title, after who sent it.
    expect(screen.getByRole('link', { name: /A mail from the bank/ })).toHaveTextContent('Check it');
    expect(screen.getByText('Needs you')).toBeInTheDocument();
    expect(screen.queryByText('The weekly recap')).not.toBeInTheDocument();
    expect(screen.queryByText('Send the invoice?')).not.toBeInTheDocument();
    expect(screen.queryByText('Seen already')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: /A mail from the bank/ }));
    expect(api.notificationSeen).toHaveBeenCalledWith('n1');
    expect(navigate).toHaveBeenCalledWith('#/chat/finance');
  });

  it('is actionable only: a mission report, a plain notify, a learned line or the recap is never here; a notify with an action is', () => {
    const rows = [
      note({ id: 'report', kind: 'recap', title: 'Morning brief: 3 meetings', action: null, needsOwner: false }),
      note({ id: 'info-1', kind: 'agent', agentId: 'concierge', title: '@concierge: The parcel was delivered', action: null, needsOwner: false }),
      note({ id: 'info-2', kind: 'agent', agentId: 'concierge', title: '@concierge: Rain after 4', action: null, needsOwner: false, link: '#/weather' }),
      note({ id: 'learned', kind: 'plugin', pluginId: 'email', urgency: 'today', state: 'held', title: 'buddi learned 1 rule', action: null, needsOwner: false }),
      note({ id: 'recap', kind: 'recap', urgency: 'digest', state: 'stored' }),
      note({ id: 'ask', kind: 'agent', agentId: 'concierge', title: '@concierge: Charged twice at Monoprix', action: 'Confirm with the bank?' }),
      note({ id: 'older-gateway' , needsOwner: undefined }),
    ];
    expect(homeNotifications(rows, []).map((row) => row.id)).toEqual(['ask']);
  });

  it('lists an agent holding a question, counts it, and opens its conversation', async () => {
    const navigate = vi.fn();
    const attention = new Map([['concierge', { agentId: 'concierge', approvals: 0, oldestApprovalAt: null, question: { at: '2026-09-21T08:58:00Z', conversationId: 'c9' } }]]);
    await act(async () => {
      render(<Home timezone="UTC" navigate={navigate} agents={[DESK]} attention={attention} />);
    });
    expect(screen.getByRole('button', { name: '1 question' })).toBeInTheDocument();
    const row = within(document.getElementById('home-needs')!).getByRole('link', { name: /Asked you a question/ });
    expect(row).toHaveTextContent('Concierge · waiting for your answer');
    fireEvent.click(row);
    expect(navigate).toHaveBeenCalledWith('#/chat/concierge/c9');
  });

  it("counts by the gateway's one rule when it answers: the rail's and the lock screen's numbers", async () => {
    vi.mocked(api.overview).mockResolvedValue({
      ...OVERVIEW,
      needsYou: { approvals: 1, questions: 1, urgent: 2, failed: 0, proposals: 0, asks: 1, agentsToSetUp: 0, signIns: 0, recovery: 0, total: 5 },
    } as never);
    await home(null);
    expect(screen.getByRole('button', { name: '1 approval' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 question' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '2 urgent alerts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1 request' })).toBeInTheDocument();
    expect(screen.queryByText(/message/)).not.toBeInTheDocument();
  });

  it('Done is kept by the server: once it says seen, the row does not come back on reload', async () => {
    const row = note({ id: 'n7', title: 'Your parcel is at the door' });
    vi.mocked(api.notificationsNeedingYou).mockResolvedValue({ notifications: [row] });
    await home(null);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(api.notificationSeen).toHaveBeenCalledWith('n7');
    cleanup();
    // The reload: the server now says it was seen. An update to a quiet line
    // keeps it seen (core), so nothing brings it back.
    vi.mocked(api.notificationsNeedingYou).mockResolvedValue({ notifications: [{ ...row, seenAt: '2026-09-21T09:01:00Z' }] });
    await home(null);
    expect(screen.queryByText('Your parcel is at the door')).not.toBeInTheDocument();
    expect(screen.queryByText('Needs you')).not.toBeInTheDocument();
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
const PASSPORT = note({ id: 'n2', kind: 'reminder', title: 'Your passport runs out in May', link: '#/activity', action: 'Book an appointment' });
const PLUGIN = note({ id: 'n3', kind: 'plugin', title: 'A plugin wants a key', link: null, pluginId: 'github' });

async function deck(rows: NotificationRow[], navigate = vi.fn()): Promise<void> {
  vi.mocked(api.notificationsNeedingYou).mockResolvedValue({ notifications: rows });
  await act(async () => {
    render(<Home timezone="UTC" navigate={navigate} agents={[DESK]} attention={new Map()} />);
  });
}

describe('"Needs you" as a deck', () => {
  it('shows the first message in full, with its sender and the counter, and moves with the arrows', async () => {
    await deck([BANK, PASSPORT, PLUGIN]);
    const region = screen.getByRole('region', { name: 'Needs you, one at a time' });
    expect(region).toHaveTextContent('Concierge');
    expect(region).toHaveTextContent('A mail from the bank');
    expect(region).toHaveTextContent(/Your card ending 4242 was charged twice\.\s*The second charge is pending\./);
    expect(region).toHaveTextContent('1 of 3');
    expect(region).toHaveAttribute('data-depth', '2');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(region).toHaveTextContent('Your passport runs out in May');
    expect(region).toHaveTextContent('2 of 3');
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(region).toHaveTextContent('1 of 3');
    fireEvent.keyDown(region, { key: 'ArrowLeft' });
    expect(region).toHaveTextContent('3 of 3');
    // A plugin is named as the owner knows it, never by its raw id.
    expect(region).toHaveTextContent('Github');
    expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
    fireEvent.keyDown(region, { key: 'ArrowRight' });
    expect(region).toHaveTextContent('1 of 3');
  });

  it('Done marks it seen as the row did and brings the next one; d does the same', async () => {
    const navigate = vi.fn();
    await deck([BANK, PASSPORT, PLUGIN], navigate);
    const region = screen.getByRole('region', { name: 'Needs you, one at a time' });
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(api.notificationSeen).toHaveBeenCalledWith('n1');
    expect(navigate).not.toHaveBeenCalled();
    expect(region).toHaveTextContent('Your passport runs out in May');
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
    await deck([BANK, PASSPORT], navigate);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(api.notificationSeen).toHaveBeenCalledWith('n1');
    expect(navigate).toHaveBeenCalledWith('#/chat/finance');
    const region = screen.getByRole('region', { name: 'Needs you, one at a time' });
    fireEvent.keyDown(region, { key: 'Enter' });
    expect(api.notificationSeen).toHaveBeenCalledWith('n2');
    expect(navigate).toHaveBeenCalledWith('#/activity');
  });

  it('an ask with no link opens its agent\'s conversation', async () => {
    const navigate = vi.fn();
    await deck([note({ id: 'n8', kind: 'agent', agentId: 'concierge', title: '@concierge: Charged twice', link: null, action: 'Confirm with the bank?' })], navigate);
    expect(screen.getByRole('region', { name: 'Needs you, one at a time' })).toHaveTextContent('Confirm with the bank?');
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(navigate).toHaveBeenCalledWith('#/chat/concierge');
  });

  it('names the other agents a folded row came from, on the deck and in the list', async () => {
    const MAIL = { ...DESK, id: 'mail', handle: 'mail', name: 'Mail Triage' } as ChatAgent;
    vi.mocked(api.notificationsNeedingYou).mockResolvedValue({ notifications: [{ ...BANK, alsoFrom: ['mail'] }] });
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
    await deck([BANK, PASSPORT]);
    expect(screen.getByRole('radio', { name: 'Deck' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('radio', { name: 'List' }));
    expect(screen.queryByRole('region', { name: 'Needs you, one at a time' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: /A mail from the bank/ })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Your passport runs out in May/ })).toBeInTheDocument();
    expect(window.localStorage.getItem('buddi.needsYouView')).toBe('list');
  });
});

describe('a plugin\'s card names the plugin by its page', () => {
  it('says "Mail" for the email plugin, from its rail page, not "email"', async () => {
    const LEARNED = note({ id: 'm1', kind: 'plugin', pluginId: 'email', title: 'A sender wants a reply', link: null });
    vi.mocked(api.notificationsNeedingYou).mockResolvedValue({ notifications: [LEARNED] });
    const pages = { all: [{ plugin: 'email', id: 'mail', title: 'Mail', place: 'rail', body: [] }], rail: [], settings: [], find: () => undefined } as unknown as PluginPages;
    await act(async () => {
      render(<Home timezone="UTC" navigate={vi.fn()} agents={[DESK]} attention={new Map()} pluginPages={pages} />);
    });
    const region = screen.getByRole('region', { name: 'Needs you, one at a time' });
    expect(region).toHaveTextContent('Mail');
    expect(region).not.toHaveTextContent('email');
  });
});

describe('what buddi learned this week', () => {
  const AT = '2026-09-20T00:00:00Z';
  const DIGEST = {
    at: AT, since: '2026-09-13T00:00:00Z',
    memory: { count: 18, names: ['Loose ends from the 2026-09-27 weekly consolidation, for Fr…'] },
    skills: { count: 2, names: ['Open a project', 'Start Cour des Comptes locally'] },
    rules: { count: 26, names: ['email: ignore', 'email: ignore', 'email: ignore'], actions: { ignore: 26 } },
    changes: { count: 0, names: [] }, open: 0,
    stopped: { total: 436, byPlugin: { email: 436 } }, delivered: true,
    summary: [
      { key: 'memory', text: 'Remembered 18 things', link: { label: 'See memory', route: '#/settings/memory' } },
      { key: 'rules', text: 'Quieted 26 senders', link: { label: 'See rules', route: '#/settings/proposals?plugin=email' } },
      { key: 'skills', text: 'Kept 2 skills: Open a project and Start Cour des Comptes locally' },
      { key: 'handled', text: 'Your rules handled 436 emails' },
    ],
  };

  async function withDigest(over: Record<string, unknown> = {}, now = '2026-09-21T09:00:00Z'): Promise<void> {
    vi.mocked(api.overview).mockResolvedValue({ ...OVERVIEW, now, ...over } as never);
    vi.mocked(api.proposals).mockResolvedValue({ open: [], closed: [], digest: { latest: DIGEST, schedule: null } } as never);
    await home(null);
  }

  it('says the week in human lines with one place to look each, no raw rule names, no empty sections', async () => {
    await withDigest();
    const card = screen.getByText('What buddi learned this week').closest('section') ?? document.body;
    expect(card).toHaveTextContent('Remembered 18 things · See memory');
    expect(card).toHaveTextContent('Quieted 26 senders · See rules');
    expect(card).toHaveTextContent('Kept 2 skills: Open a project and Start Cour des Comptes locally');
    expect(card).toHaveTextContent('Your rules handled 436 emails');
    expect(card).not.toHaveTextContent('email: ignore');
    expect(card).not.toHaveTextContent('…');
    expect(card).not.toHaveTextContent('Nothing was waiting');
    expect(card).not.toHaveTextContent('Proposes');
    expect(screen.getByRole('link', { name: 'See rules' })).toHaveAttribute('href', '#/settings/proposals?plugin=email');
  });

  it('× hides it until next week, kept by the server', async () => {
    await withDigest();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Hide until next week' })); });
    expect(api.homeDismiss).toHaveBeenCalledWith('digest', AT);
    expect(screen.queryByText('What buddi learned this week')).not.toBeInTheDocument();
  });

  it('stays hidden on reload for that week, and the next week\'s digest shows again', async () => {
    await withDigest({ dismissed: { digest: AT } });
    expect(screen.queryByText('What buddi learned this week')).not.toBeInTheDocument();
    cleanup();
    await withDigest({ dismissed: { digest: '2026-09-13T00:00:00Z' } });
    expect(screen.getByText('What buddi learned this week')).toBeInTheDocument();
  });

  it('leaves Home on its own once it is three days old', async () => {
    await withDigest({}, new Date(Date.parse(AT) + DIGEST_FRESH_MS + 60_000).toISOString());
    expect(screen.queryByText('What buddi learned this week')).not.toBeInTheDocument();
  });

  it('draws nothing when the week had nothing in it', () => {
    const { container } = render(<LearnedThisWeek digest={{ ...DIGEST, summary: [] } as never} go={() => () => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('notices with a way out', () => {
  it('a watcher error closes until its text changes', async () => {
    vi.mocked(api.overview).mockResolvedValue({ ...OVERVIEW, sentinels: { ...OVERVIEW.sentinels, errors: [{ sentinelId: 'mail-watch', error: 'IMAP timed out' }] } } as never);
    await home(null);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Hide until the error changes' })); });
    expect(api.homeDismiss).toHaveBeenCalledWith('watcher-error:mail-watch', 'IMAP timed out');
    expect(screen.queryByText(/IMAP timed out/)).not.toBeInTheDocument();
    cleanup();
    vi.mocked(api.overview).mockResolvedValue({
      ...OVERVIEW, dismissed: { 'watcher-error:mail-watch': 'IMAP timed out' },
      sentinels: { ...OVERVIEW.sentinels, errors: [{ sentinelId: 'mail-watch', error: 'Login refused' }] },
    } as never);
    await home(null);
    expect(screen.getByText(/Login refused/)).toBeInTheDocument();
  });

  it('a plugin\'s Home section hides with its ×', async () => {
    vi.mocked(api.overview).mockResolvedValue({ ...OVERVIEW, home: [{ id: 'finance.home', plugin: 'finance', title: 'Money', stats: [], rows: [] }] } as never);
    await home(null);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Hide Money from Home' })); });
    expect(api.homeDismiss).toHaveBeenCalledWith('block:finance.home', 'hidden');
    expect(screen.queryByText('Money')).not.toBeInTheDocument();
  });
});

describe('your team and the catalogue', () => {
  const entry = (name: string, title: string) => ({
    name, version: '1.0.0', handle: name, title, pitch: `${title} pitch.`, description: '', about: '', category: 'work', trust: 'by-buddi',
    author: { name: 'withbuddi' }, requires: {}, optional: {}, needs: [], tools: ['memory.*'], missions: [], fills: [], examples: [],
    skills: [], changes: '', replaces: [], avatar: null, page: null, state: 'ready', addable: true,
  });
  const FATHER = { ...DESK, id: 'father', handle: 'father', name: 'Agent Father', roles: ['maker'] } as ChatAgent;

  it('while the team is new: three suggestions from the catalogue and See all teammates', async () => {
    vi.mocked(api.catalogue).mockResolvedValue({
      agents: [entry('chief-of-staff', 'Chief of Staff'), entry('researcher', 'Researcher'), entry('tutor', 'Tutor'), entry('chef', 'Chef')],
      fromPlugins: [], delisted: [],
    } as never);
    const navigate = vi.fn();
    await act(async () => {
      render(<Home timezone="UTC" navigate={navigate} agents={[DESK, FATHER]} defaultAgentId="concierge" attention={new Map()} />);
    });
    const shelf = await screen.findByTestId('home-suggestions');
    expect(within(shelf).getAllByRole('button', { name: /^Add / }).map((b) => b.getAttribute('aria-label'))).toEqual(['Add Chief of Staff', 'Add Researcher', 'Add Tutor']);
    expect(screen.getByRole('link', { name: 'See all teammates' })).toHaveAttribute('href', '#/agents/catalogue');
    expect(screen.queryByTestId('team-add')).not.toBeInTheDocument();
  });

  it('after that: the faces and one dashed Add a teammate tile that opens the catalogue', async () => {
    const more = ['ledger', 'scout'].map((id) => ({ ...DESK, id, handle: id, name: id }) as ChatAgent);
    const navigate = vi.fn();
    await act(async () => {
      render(<Home timezone="UTC" navigate={navigate} agents={[DESK, FATHER, ...more]} defaultAgentId="concierge" attention={new Map()} />);
    });
    const tile = screen.getByTestId('team-add');
    expect(tile).toHaveTextContent('Add a teammate');
    fireEvent.click(tile);
    expect(navigate).toHaveBeenCalledWith('#/agents/catalogue');
    // Past a new team the catalogue is read only for a plugin nobody uses; here there is none.
    expect(screen.queryByTestId('home-suggestions')).not.toBeInTheDocument();
  });
});

describe("the owner's birthday", () => {
  const AGENTS = [
    { id: 'concierge', name: 'Buddi', handle: 'buddi', description: 'The front desk.', available: true, roles: ['front-desk'], provider: 'anthropic', model: 'claude-sonnet-5' },
    { id: 'postie', name: 'Postie', handle: 'postie', description: 'Mail.', available: true, roles: [], provider: 'anthropic', model: 'claude-sonnet-5' },
  ] as never;
  const birthday = (over: Record<string, unknown> = {}) => ({ today: true, date: '2026-10-02', name: 'Amen', age: 36, note: 'Happy birthday, Amen! Thirty-six looks good on you.', from: 'concierge', image: '33333333-3333-4333-8333-333333333333', ...over });

  it('says it in the greeting and puts the team’s note and picture under the glance', async () => {
    vi.mocked(api.birthday).mockResolvedValue(birthday());
    await act(async () => { render(<Home timezone="UTC" navigate={vi.fn()} agents={AGENTS} defaultAgentId="concierge" attention={new Map()} />); });
    expect(await screen.findByRole('heading', { name: 'Happy birthday, Amen.' })).toBeInTheDocument();
    const card = screen.getByRole('region', { name: 'Your birthday' });
    expect(card).toHaveTextContent('From your team');
    expect(card).toHaveTextContent('Happy birthday, Amen! Thirty-six looks good on you.');
    expect(card).toHaveTextContent('Buddi and Postie');
    expect(screen.getByRole('img', { name: 'A picture your team made for your birthday' })).toHaveAttribute('src', expect.stringContaining('33333333-3333-4333-8333-333333333333'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Put it away for today' })); });
    expect(api.homeDismiss).toHaveBeenCalledWith('birthday', '2026-10-02');
    expect(screen.queryByRole('region', { name: 'Your birthday' })).not.toBeInTheDocument();
  });

  it('draws the note alone without a picture, and no card before the greeting went out', async () => {
    vi.mocked(api.birthday).mockResolvedValue(birthday({ image: null }));
    await act(async () => { render(<Home timezone="UTC" navigate={vi.fn()} agents={AGENTS} attention={new Map()} />); });
    expect(await screen.findByRole('region', { name: 'Your birthday' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /picture/ })).not.toBeInTheDocument();
    cleanup();
    vi.mocked(api.birthday).mockResolvedValue(birthday({ note: null, image: null }));
    await act(async () => { render(<Home timezone="UTC" navigate={vi.fn()} agents={AGENTS} attention={new Map()} />); });
    expect(await screen.findByRole('heading', { name: 'Happy birthday, Amen.' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Your birthday' })).not.toBeInTheDocument();
  });
});
