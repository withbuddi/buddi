/**
 * Settings → Connections on the page: the list and its states, the cards,
 * Disconnect naming the agents it touches, and the four screens — address,
 * consent (the tab opened inside the click, the client-id escape hatch),
 * review (names, tiers, the sentence for a server that annotates nothing),
 * grant (the front desk preselected) — and the callback tab.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ApiError, api, type ConnectionReview, type ConnectionView, type ConnectionsView } from '../api';
import { ConnectFlow, Connections } from './Connections';
import { ConnectionCallback } from './ConnectionCallback';

vi.mock('../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../api')>();
  return {
    ...original,
    api: {
      ...original.api,
      connections: vi.fn(), connection: vi.fn(), addConnection: vi.fn(), connectionConsent: vi.fn(), connectionCallback: vi.fn(),
      connectionReview: vi.fn(), saveConnectionReview: vi.fn(), grantConnection: vi.fn(), disconnect: vi.fn(),
    },
  };
});

const mocked = vi.mocked(api);

function connection(over: Partial<ConnectionView> = {}): ConnectionView {
  return {
    id: '11111111-1111-4111-8111-111111111111', slug: 'github', name: 'GitHub', url: 'https://api.githubcopilot.com/mcp/',
    host: 'api.githubcopilot.com', state: 'connected', authKind: 'oauth', signedIn: true, toolCount: 12, grant: 'mcp.github.*',
    serverName: 'github', serverVersion: '1.0', reviewedAt: '2026-09-27T10:00:00Z', agents: ['concierge'], ...over,
  };
}

const AGENTS: ConnectionsView['agents'] = [
  { id: 'concierge', name: 'Buddi', handle: 'buddi', frontDesk: true },
  { id: 'ledger', name: 'Ledger', handle: 'ledger', frontDesk: false },
];

function view(connections: ConnectionView[] = [connection()]): ConnectionsView {
  return {
    connections, agents: AGENTS, vault: true, callbackPath: '/connections/callback',
    catalog: [
      { id: 'github', name: 'GitHub', blurb: 'Repositories.', url: 'https://api.githubcopilot.com/mcp/', verified: false },
      { id: 'notion', name: 'Notion', blurb: 'Pages.', url: 'https://mcp.notion.com/mcp', verified: false },
    ],
  };
}

const REVIEW: ConnectionReview = {
  connection: connection({ slug: null, state: 'pending-review', grant: null, agents: [] }),
  slug: 'github', slugEditable: true, host: 'api.githubcopilot.com', hash: 'h1', annotatedNothing: false,
  tools: [
    { name: 'search_issues', fullName: 'mcp.github.search_issues', description: 'Search issues.', tier: 'auto', destructive: false, annotated: true, problem: null },
    { name: 'create_issue', fullName: 'mcp.github.create_issue', description: 'Create an issue.', tier: 'gated', destructive: false, annotated: true, problem: null },
    { name: 'delete_repo', fullName: 'mcp.github.delete_repo', description: '', tier: 'gated', destructive: true, annotated: true, problem: null },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the list', () => {
  it('shows each connection, its state, tools and holders, and the cards', async () => {
    mocked.connections.mockResolvedValue(view([
      connection(),
      connection({ id: '22222222-2222-4222-8222-222222222222', name: 'Linear', slug: 'linear', state: 'needs-reconnect', agents: [], grant: 'mcp.linear.*', toolCount: 1 }),
    ]));
    render(<Connections embedded />);
    // The row and the card.
    expect(await screen.findAllByText('GitHub')).toHaveLength(2);
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Needs reconnect')).toBeInTheDocument();
    expect(screen.getByText('Held by Buddi.')).toBeInTheDocument();
    expect(screen.getByText(/12 tools/)).toBeInTheDocument();
    expect(screen.getByText(/each of its tools answers with one sentence/)).toBeInTheDocument();
    expect(screen.getByText('Another server')).toBeInTheDocument();
    expect(screen.getByText('Notion')).toBeInTheDocument();
  });

  it('names the agents Disconnect takes the tools from, then disconnects', async () => {
    mocked.connections.mockResolvedValue(view());
    mocked.disconnect.mockResolvedValue({ id: 'x', name: 'GitHub', touched: ['concierge'] });
    render(<Connections embedded />);
    await screen.findByText('Held by Buddi.');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/mcp\.github\.\* comes out of Buddi/)).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(mocked.disconnect).toHaveBeenCalledWith(connection().id));
  });
});

describe('the four screens', () => {
  it('address → consent: the tab is opened inside the click and pointed at the consent page', async () => {
    const pending = connection({ slug: null, state: 'pending-review', signedIn: false, grant: null, agents: [] });
    mocked.addConnection.mockResolvedValue({ connection: pending, signIn: 'dynamic' });
    mocked.connectionConsent.mockResolvedValue({ authorizeUrl: 'https://github.com/login/oauth/authorize?x=1', redirectUri: 'http://localhost/connections/callback' });
    mocked.connection.mockResolvedValue(pending);
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    render(<ConnectFlow start={{ step: 'address', card: view().catalog[0] }} agents={AGENTS} onClose={() => {}} pollMs={10} />);
    expect(screen.getByLabelText('Address')).toHaveValue('https://api.githubcopilot.com/mcp/');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(mocked.addConnection).toHaveBeenCalledWith('https://api.githubcopilot.com/mcp/', 'GitHub'));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to GitHub' }));
    expect(open).toHaveBeenCalledWith('', '_blank');
    await waitFor(() => expect(tab.location.href).toBe('https://github.com/login/oauth/authorize?x=1'));
    expect(tab.opener).toBeNull();
    expect(await screen.findByText(/Waiting for you to say yes/)).toBeInTheDocument();
    open.mockRestore();
  });

  it('asks for a client id when the service offers no registration', async () => {
    const pending = connection({ slug: null, state: 'pending-review', signedIn: false });
    mocked.connectionConsent.mockRejectedValueOnce(new ApiError(409, 'This service does not let buddi register itself.', { error: 'x', code: 'client-id' }));
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<ConnectFlow start={{ step: 'consent', connection: pending }} agents={AGENTS} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub' }));
    expect(await screen.findByText('This service does not let buddi register itself.')).toBeInTheDocument();
    expect(screen.getByLabelText('Client id')).toBeInTheDocument();
    expect(screen.getByText(/connections\/callback/)).toBeInTheDocument();
    mocked.connectionConsent.mockResolvedValueOnce({ authorizeUrl: 'https://x.test/authorize', redirectUri: 'r' });
    fireEvent.change(screen.getByLabelText('Client id'), { target: { value: 'my-app' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in to GitHub' }));
    await waitFor(() => expect(mocked.connectionConsent).toHaveBeenLastCalledWith(pending.id, 'my-app'));
    // No tab could be opened: a link does it instead.
    expect(await screen.findByRole('link', { name: 'Open GitHub’s sign-in page' })).toHaveAttribute('href', 'https://x.test/authorize');
    open.mockRestore();
  });

  it('review → grant: names, tiers, the editable name, and the front desk preselected', async () => {
    mocked.connectionReview.mockResolvedValue(REVIEW);
    const kept = connection({ slug: 'gh', grant: 'mcp.gh.*', agents: [] });
    mocked.saveConnectionReview.mockResolvedValue(kept);
    mocked.grantConnection.mockResolvedValue({ granted: ['concierge'], failed: [], connection: kept });
    const onClose = vi.fn();
    render(<ConnectFlow start={{ step: 'review', connection: REVIEW.connection }} agents={AGENTS} onClose={onClose} />);
    expect(await screen.findByText('mcp.github.search_issues')).toBeInTheDocument();
    expect(screen.getByText('Runs on its own')).toBeInTheDocument();
    expect(screen.getByText('Asks you first')).toBeInTheDocument();
    expect(screen.getByText('Asks you every time')).toBeInTheDocument();
    expect(screen.getByText('api.githubcopilot.com')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Its name in buddi'), { target: { value: 'gh' } });
    expect(screen.getByText('mcp.gh.create_issue')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep these 3 tools' }));
    await waitFor(() => expect(mocked.saveConnectionReview).toHaveBeenCalledWith(REVIEW.connection.id, { hash: 'h1', slug: 'gh' }));
    expect(await screen.findByText(/Give these tools to Buddi\?/)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Buddi (front desk)' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Ledger' })).not.toBeChecked();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Ledger' }));
    fireEvent.click(screen.getByRole('button', { name: 'Give them' }));
    await waitFor(() => expect(mocked.grantConnection).toHaveBeenCalledWith(kept.id, ['concierge', 'ledger']));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('says so when a server annotates nothing', async () => {
    mocked.connectionReview.mockResolvedValue({
      ...REVIEW, annotatedNothing: true,
      tools: [{ name: 'do', fullName: 'mcp.github.do', description: '', tier: 'gated', destructive: false, annotated: false, problem: null }],
    });
    render(<ConnectFlow start={{ step: 'review', connection: REVIEW.connection }} agents={AGENTS} onClose={() => {}} />);
    expect(await screen.findByText(/says nothing about what its tools do/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep this tool' })).toBeInTheDocument();
  });
});

describe('the callback tab', () => {
  it('hands the code and state to the gateway and says it is done', async () => {
    mocked.connectionCallback.mockResolvedValue({ id: 'c1', reconnected: false, name: 'GitHub' });
    render(<ConnectionCallback search="?code=abc&state=st" />);
    await waitFor(() => expect(mocked.connectionCallback).toHaveBeenCalledWith({ state: 'st', code: 'abc' }));
    expect(await screen.findByText('Signed in to GitHub')).toBeInTheDocument();
  });

  it('shows the refusal when the state is not this session\'s', async () => {
    mocked.connectionCallback.mockRejectedValue(new Error('This sign-in was started from another dashboard session. Start it again here.'));
    render(<ConnectionCallback search="?code=abc&state=st" />);
    expect(await screen.findByText('Nothing was connected')).toBeInTheDocument();
    expect(screen.getByText(/another dashboard session/)).toBeInTheDocument();
  });
});
