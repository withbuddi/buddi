/**
 * "Add a teammate": on day one — nobody but the front desk and the maker — the
 * Agents page and Home show the starter team and the plugin agents; after
 * that the Agents page keeps them under the team and Home says nothing. Add
 * is the one accept every offer uses; a greyed card says why and where to fix
 * it; the × is the dismiss Home's offers use.
 */
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, chatApi, type TeammateRow } from '../api';
import type { ChatAgent } from '../chat/types';
import { Agents } from './Agents';
import { Home } from './Home';

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api')>();
  const empty = (value: unknown) => vi.fn(async () => value);
  return {
    ...original,
    api: {
      ...original.api,
      agents: empty({ agents: [], default: { defaultAgentId: 'concierge', choices: [], problem: null } }),
      overview: empty({
        now: '2026-09-21T09:00:00Z', timezone: 'UTC', paused: false, home: [],
        approvals: { pending: 0, oldestPendingAt: null },
        jobs: { pending: 0, leased: 0, suspended: 0, failed: 0, succeeded: 0, cancelled: 0 },
        missions: { total: 0, enabled: 0, nextRun: null },
        reminders: { pending: 0, nextDueAt: null },
        sentinels: { lastRunAt: null, openUrgent: 0, openInfo: 0, errors: [] },
        mail: [],
      }),
      approvals: empty({ pending: [], recent: [] }),
      missions: empty({ missions: [] }),
      reminders: empty({ reminders: [] }),
      conversations: empty({ conversations: [] }),
      offers: empty({ offers: [], closed: [] }),
      proposals: empty({ open: [] }),
      agentOffers: empty({ offers: [] }),
      owner: empty({}),
      notifications: empty({ notifications: [] }),
      teammates: vi.fn(),
      dismissAgentOffer: vi.fn(async () => ({ dismissed: true })),
      acceptPluginAgent: vi.fn(),
    },
    chatApi: { ...original.chatApi, conversations: vi.fn(async () => ({ conversations: [] })) },
  };
});

const face = (over: Partial<ChatAgent>): ChatAgent =>
  ({ description: '', available: true, roles: [], provider: 'anthropic', model: 'claude-test', ...over }) as ChatAgent;
const desk = face({ id: 'concierge', handle: 'buddi', name: 'Concierge', roles: ['front-desk'] });
const father = face({ id: 'agent-father', handle: 'father', name: 'Agent Father', roles: ['maker'] });
const ledger = face({ id: 'finance-advisor', handle: 'money', name: 'Finance Advisor' });

const TEAM: TeammateRow[] = [
  { plugin: 'buddi', agent: 'scout', handle: 'scout', name: 'Scout', text: 'Reads the web, gives a second opinion, watches pages you name.', needs: 'Needs a brain', state: 'available' },
  { plugin: 'buddi', agent: 'planner', handle: 'planner', name: 'Planner', text: 'Keeps your day: reminders, follow-ups it remembers, a brief every morning.', needs: 'Needs a brain', state: 'available' },
  { plugin: 'email', agent: 'mail-triage', handle: 'mail', name: 'Mail Triage', text: 'Reads your inbox and pulls out what needs you.', needs: 'Needs a mailbox', state: 'unavailable', reason: 'Needs a mailbox', fix: 'mailbox' },
  { plugin: 'finance', agent: 'ledger', handle: 'ledger', name: 'Ledger', text: 'Reads statements, tracks spending, a weekly recap.', needs: 'Needs the finance plugin', state: 'unavailable', reason: 'From the finance plugin', fix: 'plugins' },
];

let visited: string[] = [];

function AgentsHarness({ agents }: { agents: ChatAgent[] }): JSX.Element {
  const [hash, setHash] = useState('#/agents');
  const navigate = (next: string): void => { visited.push(next); setHash(next); };
  return <Agents hash={hash} timezone="UTC" navigate={navigate} agents={agents} attention={new Map()} defaultAgentId="concierge" />;
}

beforeEach(() => {
  visited = [];
  vi.clearAllMocks();
  vi.mocked(api.teammates).mockResolvedValue({ teammates: TEAM });
});

describe('Add a teammate on the Agents page', () => {
  it('shows the cards on day one, with the line, the needs, Add, and the greyed reason with its fix', async () => {
    render(<AgentsHarness agents={[desk, father]} />);
    expect(await screen.findByText('Add a teammate')).toBeInTheDocument();
    expect(screen.getByText(/Each one keeps its own memory and tools, and can work on a schedule\. Add the ones you want; Agent Father can make others\./)).toBeInTheDocument();
    const scout = screen.getByTestId('teammate-scout');
    expect(within(scout).getByText('Scout')).toBeInTheDocument();
    expect(within(scout).getByText('Reads the web, gives a second opinion, watches pages you name.')).toBeInTheDocument();
    expect(within(scout).getByText('Needs a brain')).toBeInTheDocument();
    expect(within(scout).getByRole('button', { name: 'Add Scout' })).toBeInTheDocument();

    const mail = screen.getByTestId('teammate-mail-triage');
    expect(mail).toHaveAttribute('data-state', 'unavailable');
    expect(within(mail).queryByRole('button', { name: /^Add/ })).toBeNull();
    expect(within(mail).getByRole('link', { name: 'Add a mailbox' })).toHaveAttribute('href', '#/settings/p.email.settings');
    const finance = screen.getByTestId('teammate-ledger');
    expect(within(finance).getByText('From the finance plugin')).toBeInTheDocument();
    fireEvent.click(within(finance).getByRole('link', { name: 'Plugins' }));
    expect(visited).toContain('#/settings/plugins');
  });

  it('adds through the one accept, then says Added and links to the agent', async () => {
    vi.mocked(api.acceptPluginAgent).mockResolvedValue({ approvalId: 'a1', agent: { id: 'planner', handle: 'planner', name: 'Planner' } });
    render(<AgentsHarness agents={[desk, father]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add Planner' }));
    await waitFor(() => expect(api.acceptPluginAgent).toHaveBeenCalledWith('buddi', 'planner'));
    const planner = screen.getByTestId('teammate-planner');
    const link = await within(planner).findByRole('link', { name: /Added/ });
    expect(link).toHaveAttribute('href', '#/agents/planner');
    expect(planner).toHaveAttribute('data-state', 'added');
  });

  it('dismisses one card through the offers dismiss route', async () => {
    render(<AgentsHarness agents={[desk, father]} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss Scout' }));
    await waitFor(() => expect(api.dismissAgentOffer).toHaveBeenCalledWith('buddi', 'scout'));
    expect(screen.queryByTestId('teammate-scout')).toBeNull();
  });

  it('shows under the team once there is a colleague, with no toggle in the header', async () => {
    render(<AgentsHarness agents={[desk, ledger, father]} />);
    expect(await screen.findByTestId('teammates')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a teammate' })).toBeNull();
    expect(screen.getByText(/Each one keeps its own memory and tools/)).toBeInTheDocument();
    // After the owner's agents: the roster card comes before the section.
    const roster = screen.getByRole('link', { name: 'Finance Advisor' });
    const section = screen.getByTestId('teammates');
    expect(roster.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('puts the cards to add first and the added ones last as chips', async () => {
    const [scout, planner, ...rest] = TEAM;
    vi.mocked(api.teammates).mockResolvedValue({ teammates: [{ ...scout!, state: 'added' }, planner!, ...rest] });
    render(<AgentsHarness agents={[desk, ledger, father]} />);
    const grid = await screen.findByTestId('teammates');
    expect(within(grid).queryByTestId('teammate-scout')).toBeNull();
    expect(within(grid).getByTestId('teammate-planner')).toBeInTheDocument();
    const chips = screen.getByTestId('teammates-added');
    const chip = within(chips).getByRole('link', { name: 'Added · open @scout' });
    expect(chip).toHaveAttribute('href', '#/agents/scout');
    expect(grid.compareDocumentPosition(chips) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says the starter team is complete when every card is added', async () => {
    vi.mocked(api.teammates).mockResolvedValue({ teammates: TEAM.map((row) => ({ ...row, state: 'added' as const })) });
    render(<AgentsHarness agents={[desk, ledger, father]} />);
    expect(await screen.findByText('Your starter team is complete. Agent Father can make others.')).toBeInTheDocument();
    expect(screen.queryByTestId('teammates')).toBeNull();
    expect(screen.queryByTestId('teammates-added')).toBeNull();
  });
});

describe('Add a teammate on Home', () => {
  const home = async (agents: ChatAgent[]): Promise<void> => {
    await act(async () => {
      render(<Home timezone="UTC" navigate={vi.fn()} agents={agents} defaultAgentId="concierge" attention={new Map()} />);
    });
  };

  it('shows the cards under Your team on day one', async () => {
    await home([desk, father]);
    expect(await screen.findByTestId('teammates')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Scout' })).toBeInTheDocument();
    expect(screen.getByText('Add a teammate')).toBeInTheDocument();
  });

  it('says nothing once the team has a colleague', async () => {
    await home([desk, ledger, father]);
    expect(screen.queryByTestId('teammates')).toBeNull();
    expect(api.teammates).not.toHaveBeenCalled();
  });
});
