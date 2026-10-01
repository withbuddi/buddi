/**
 * Settings → Connections on the page: the rows and their states, a row's
 * sheet and its actions, the catalog without what is connected, each way to
 * add your own, Disconnect naming the agents it touches, and the four screens — address,
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
      connectionToken: vi.fn(), connectionDevice: vi.fn(),
      connectionReview: vi.fn(), saveConnectionReview: vi.fn(), grantConnection: vi.fn(), disconnect: vi.fn(),
      connectionTools: vi.fn(), setRememberedApproval: vi.fn(), addProgram: vi.fn(), updateProgram: vi.fn(),
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
      {
        id: 'github', name: 'GitHub', blurb: 'Repositories.', url: 'https://api.githubcopilot.com/mcp/', verified: false, clientIdRequired: true,
        auth: { recommended: 'token', tokenPage: 'https://github.com/settings/personal-access-tokens/new', tokenHint: 'A fine-grained token.' },
      },
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
  mocked.connectionTools.mockResolvedValue({ connection: 'github', tools: [] });
});

describe('the list', () => {
  it('shows each connection as a row with its state and tools, and leaves connected services out of the catalog', async () => {
    mocked.connections.mockResolvedValue(view([
      connection(),
      connection({ id: '22222222-2222-4222-8222-222222222222', name: 'Linear', slug: 'linear', url: 'https://mcp.linear.app/mcp', host: 'mcp.linear.app', state: 'needs-reconnect', agents: [], grant: 'mcp.linear.*', toolCount: 1 }),
    ]));
    render(<Connections embedded />);
    // GitHub is connected, so only its row: no catalog tile for it.
    expect(await screen.findAllByText('GitHub')).toHaveLength(1);
    expect(screen.getByLabelText('GitHub: details')).toHaveTextContent('api.githubcopilot.com · 12 tools');
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Sign in again')).toBeInTheDocument();
    expect(screen.getByLabelText('Linear: details')).toHaveTextContent('1 tool');
    // Notion is not connected: offered, with its own Connect.
    expect(screen.getByText('Notion')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Notion' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect GitHub' })).toBeNull();
    // No tool-name jargon on the page itself.
    expect(screen.queryByText(/mcp\.[a-z]+\.\*/)).toBeNull();
    // The way to plugins, told apart.
    expect(screen.getByRole('link', { name: 'Plugins' })).toHaveAttribute('href', '#/settings/plugins');
  });

  it('says so when nothing is connected, and still offers every service', async () => {
    mocked.connections.mockResolvedValue(view([]));
    render(<Connections embedded />);
    expect(await screen.findByText('Nothing connected yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect GitHub' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Notion' })).toBeInTheDocument();
  });

  it('opens a row into its sheet: address, sign-in, tools, holders and the actions', async () => {
    mocked.connections.mockResolvedValue(view());
    mocked.connectionReview.mockReturnValue(new Promise(() => {}));
    render(<Connections embedded />);
    fireEvent.click(await screen.findByLabelText('GitHub: details'));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('https://api.githubcopilot.com/mcp/')).toBeInTheDocument();
    expect(within(sheet).getByText(/Its own sign-in page/)).toBeInTheDocument();
    expect(within(sheet).getByText(/12 tools · reviewed/)).toBeInTheDocument();
    expect(within(sheet).getByText('Buddi')).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Change' })).toBeNull();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Review again' }));
    expect(await screen.findByRole('dialog', { name: 'What GitHub brings' })).toBeInTheDocument();
    expect(mocked.connectionReview).toHaveBeenCalledWith(connection().id);
  });

  it('opens the connection a link names straight into its sheet', async () => {
    mocked.connections.mockResolvedValue(view());
    render(<Connections embedded connection={connection().id} />);
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('names the agents Disconnect takes the tools from, then disconnects', async () => {
    mocked.connections.mockResolvedValue(view());
    mocked.disconnect.mockResolvedValue({ id: 'x', name: 'GitHub', touched: ['concierge'] });
    render(<Connections embedded />);
    fireEvent.click(await screen.findByLabelText('GitHub: details'));
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect…' }));
    const alert = await screen.findByRole('alertdialog', { name: 'Disconnect GitHub?' });
    expect(within(alert).getByText(/Buddi loses them/)).toBeInTheDocument();
    fireEvent.click(within(alert).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(mocked.disconnect).toHaveBeenCalledWith(connection().id));
  });

  it('opens each way to add your own on its own screen', async () => {
    mocked.connections.mockResolvedValue(view());
    render(<Connections embedded />);
    const add = async (way: string, button: string): Promise<void> => {
      fireEvent.click(await screen.findByRole('radio', { name: way }));
      fireEvent.click(screen.getByRole('button', { name: button }));
    };
    await add('An address', 'Give its address');
    expect(await screen.findByLabelText('Address')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await add('A program', 'Describe it');
    expect(await screen.findByLabelText('Command')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await add('A config', 'Paste it');
    expect(await screen.findByLabelText('Config')).toBeInTheDocument();
  });

  it('offers another account of a catalog service from its sheet, through the same flow', async () => {
    mocked.connections.mockResolvedValue(view());
    render(<Connections embedded />);
    fireEvent.click(await screen.findByLabelText('GitHub: details'));
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText(/Another GitHub account or workspace/)).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Add another account' }));
    expect(await screen.findByLabelText('Address')).toHaveValue('https://api.githubcopilot.com/mcp/');
  });

  it('tells two accounts of one service apart by their names in buddi', async () => {
    mocked.connections.mockResolvedValue(view([connection(), connection({ id: '22222222-2222-4222-8222-222222222222', slug: 'github_work', grant: 'mcp.github_work.*' })]));
    render(<Connections embedded />);
    expect(await screen.findByLabelText('GitHub (github): details')).toBeInTheDocument();
    expect(screen.getByLabelText('GitHub (github_work): details')).toBeInTheDocument();
  });

  it('changes who holds a connection from its sheet: tick to give, untick to take away', async () => {
    mocked.connections.mockResolvedValue(view());
    mocked.grantConnection.mockResolvedValue({ granted: ['ledger'], failed: [], connection: connection({ agents: ['ledger'] }) });
    render(<Connections embedded />);
    fireEvent.click(await screen.findByLabelText('GitHub: details'));
    const sheet = await screen.findByRole('dialog');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Change who holds it' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Who holds GitHub' });
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Buddi (front desk)' }));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'Ledger' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocked.grantConnection).toHaveBeenCalledWith(connection().id, ['ledger'], true));
  });

  it('a catalog tile opens the address screen with its address', async () => {
    mocked.connections.mockResolvedValue(view());
    render(<Connections embedded />);
    fireEvent.click(await screen.findByRole('button', { name: 'Connect Notion' }));
    expect(await screen.findByLabelText('Address')).toHaveValue('https://mcp.notion.com/mcp');
  });
});

describe('the four screens', () => {
  it('address → sign in: the consent page is fetched first, and the click opens a tab onto it, never an empty one', async () => {
    const pending = connection({ name: 'Notion', slug: null, state: 'pending-review', signedIn: false, grant: null, agents: [] });
    mocked.addConnection.mockResolvedValue({ connection: pending, signIn: 'dynamic' });
    mocked.connectionConsent.mockResolvedValue({ authorizeUrl: 'https://notion.example/authorize?x=1', redirectUri: 'http://localhost/connections/callback' });
    mocked.connection.mockResolvedValue(pending);
    const tab = { opener: {} as unknown, location: { href: '' }, close: vi.fn() };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    render(<ConnectFlow start={{ step: 'address', card: view().catalog[1] }} agents={AGENTS} onClose={() => {}} pollMs={10} />);
    expect(screen.getByLabelText('Address')).toHaveValue('https://mcp.notion.com/mcp');
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(mocked.addConnection).toHaveBeenCalledWith('https://mcp.notion.com/mcp', 'Notion'));
    // Sign in and Token; Sign in first for a service that lets buddi register.
    expect(await screen.findByRole('radio', { name: 'Sign in' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Token' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Client id' })).toBeNull();
    const signIn = await screen.findByRole('button', { name: 'Sign in to Notion' });
    await waitFor(() => expect(signIn).toBeEnabled());
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(signIn);
    expect(open).toHaveBeenCalledWith('https://notion.example/authorize?x=1', '_blank');
    expect(tab.opener).toBeNull();
    expect(await screen.findByText(/Waiting for you to say yes/)).toBeInTheDocument();
    open.mockRestore();
  });

  it('asks for a client id before any tab when the service offers no registration', async () => {
    const pending = connection({ slug: null, state: 'pending-review', signedIn: false });
    mocked.connectionConsent.mockRejectedValueOnce(new ApiError(409, 'This service does not let buddi register itself.', { error: 'x', code: 'client-id' }));
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<ConnectFlow start={{ step: 'consent', connection: pending }} agents={AGENTS} onClose={() => {}} />);
    expect(await screen.findByText('This service does not let buddi register itself.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Client id' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Token' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Sign in' })).toBeNull();
    expect(screen.getByText(/connections\/callback/)).toBeInTheDocument();
    mocked.connectionConsent.mockResolvedValueOnce({ authorizeUrl: 'https://x.test/authorize', redirectUri: 'r' });
    fireEvent.change(screen.getByLabelText('Client id'), { target: { value: 'my-app' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(mocked.connectionConsent).toHaveBeenLastCalledWith(pending.id, 'my-app'));
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Open GitHub’s sign-in page' }));
    expect(open).toHaveBeenCalledWith('https://x.test/authorize', '_blank');
    // No tab could be opened: a link does it instead.
    expect(await screen.findByRole('link', { name: 'Open GitHub’s sign-in page' })).toHaveAttribute('href', 'https://x.test/authorize');
    open.mockRestore();
  });

  it('GitHub opens on Token: the page to make one, tried before it is kept, and no tab at all', async () => {
    const pending = connection({ slug: null, state: 'pending-review', signedIn: false, grant: null, agents: [] });
    mocked.addConnection.mockResolvedValue({ connection: pending, signIn: 'manual' });
    mocked.connectionReview.mockResolvedValue(REVIEW);
    const open = vi.spyOn(window, 'open');
    render(<ConnectFlow start={{ step: 'address', card: view().catalog[0] }} agents={AGENTS} onClose={() => {}} />);
    expect(screen.getByText(/signs in with a token you make on its site/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('radio', { name: 'Token' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Client id' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Make a token on GitHub' })).toHaveAttribute('href', 'https://github.com/settings/personal-access-tokens/new');
    expect(screen.getByText('A fine-grained token.')).toBeInTheDocument();
    expect(mocked.connectionConsent).not.toHaveBeenCalled();
    const field = screen.getByLabelText('Token');
    expect(field).toHaveAttribute('type', 'password');

    mocked.connectionToken.mockRejectedValueOnce(new ApiError(400, 'GitHub did not accept that token.', { error: 'x', code: 'token-refused' }));
    fireEvent.change(field, { target: { value: 'wrong-one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Try it and keep it' }));
    expect(await screen.findByText('GitHub did not accept that token.')).toBeInTheDocument();

    mocked.connectionToken.mockResolvedValueOnce({ id: pending.id, reconnected: false, name: 'GitHub', connection: { ...pending, authKind: 'token', signedIn: true } });
    fireEvent.change(field, { target: { value: 'right-one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Try it and keep it' }));
    await waitFor(() => expect(mocked.connectionToken).toHaveBeenLastCalledWith(pending.id, { token: 'right-one', header: 'Authorization', prefix: 'Bearer ' }));
    expect(await screen.findByText('mcp.github.search_issues')).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('GitHub opens on Device: the code large with Copy, the site opened in the click, then review by itself', async () => {
    const pending = connection({ slug: null, state: 'pending-review', signedIn: false, grant: null, agents: [] });
    const card = { ...view().catalog[0]!, auth: { recommended: 'device' as const, device: { clientId: 'Ov23', deviceEndpoint: 'https://github.com/login/device/code', scopes: ['repo'] }, tokenPage: 'https://github.com/settings/tokens' } };
    const device = { state: 'waiting' as const, userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: '2026-09-29T10:15:00Z' };
    mocked.addConnection.mockResolvedValue({ connection: pending, signIn: 'manual' });
    mocked.connectionDevice.mockResolvedValue({ userCode: 'WDJB-MJHT', verificationUri: 'https://github.com/login/device', expiresAt: device.expiresAt, interval: 5, connection: pending });
    mocked.connection.mockResolvedValueOnce({ ...pending, device })
      .mockResolvedValue({ ...pending, authKind: 'token', signedIn: true, device: { ...device, state: 'done' } });
    mocked.connectionReview.mockResolvedValue(REVIEW);
    const tab = { opener: {} as unknown };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    render(<ConnectFlow start={{ step: 'address', card }} agents={AGENTS} onClose={() => {}} pollMs={10} />);
    expect(screen.getByText(/signs in with a code you type on its site/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // Device first, Token still there, Client id last.
    expect(await screen.findByRole('radio', { name: 'Device' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['Device', 'Token', 'Client id']);
    expect(await screen.findByDisplayValue('WDJB-MJHT')).toHaveAttribute('data-code', 'large');
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByText('Waiting for you to approve on GitHub…')).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open github.com/login/device' }));
    expect(open).toHaveBeenCalledWith('https://github.com/login/device', '_blank');
    expect(tab.opener).toBeNull();
    expect(await screen.findByText('mcp.github.search_issues')).toBeInTheDocument();
    expect(mocked.connectionDevice).toHaveBeenCalledTimes(1);
    open.mockRestore();
  });

  it('a declined or expired code is one sentence and Start again', async () => {
    const pending = connection({ slug: null, state: 'pending-review', signedIn: false, grant: null, agents: [] });
    const card = { ...view().catalog[0]!, auth: { recommended: 'device' as const, device: { clientId: 'Ov23', deviceEndpoint: 'https://github.com/login/device/code', scopes: [] } } };
    mocked.connectionDevice.mockResolvedValue({ userCode: 'AAAA-BBBB', verificationUri: 'https://github.com/login/device', expiresAt: '2026-09-29T10:15:00Z', interval: 5, connection: pending });
    mocked.connection.mockResolvedValue({ ...pending, device: { state: 'failed', userCode: 'AAAA-BBBB', verificationUri: 'https://github.com/login/device', expiresAt: '2026-09-29T10:15:00Z', reason: 'The sign-in was declined on GitHub. Start again.' } });
    render(<ConnectFlow start={{ step: 'consent', connection: pending, card }} agents={AGENTS} onClose={() => {}} pollMs={10} />);
    expect(await screen.findByText('The sign-in was declined on GitHub. Start again.')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('AAAA-BBBB')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }));
    await waitFor(() => expect(mocked.connectionDevice).toHaveBeenCalledTimes(2));
  });

  it('reads a pasted config: address and name filled, the header waiting on the token screen, the box cleared', async () => {
    const pending = connection({ slug: null, state: 'pending-review', signedIn: false, grant: null, agents: [] });
    mocked.addConnection.mockResolvedValue({ connection: pending, signIn: 'manual' });
    mocked.connectionToken.mockResolvedValue({ id: pending.id, reconnected: false, name: 'GitHub', connection: { ...pending, authKind: 'token', signedIn: true } });
    mocked.connectionReview.mockResolvedValue(REVIEW);
    render(<ConnectFlow start={{ step: 'paste' }} catalog={view().catalog} agents={AGENTS} onClose={() => {}} />);
    const box = screen.getByLabelText('Config');
    fireEvent.change(box, { target: { value: 'not json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Read it' }));
    expect(await screen.findByText('That is not JSON. Paste the whole block, braces included.')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: '{ "mcpServers": { "gh": { "type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": { "Authorization": "Bearer pasted-value" } } } }' } });
    fireEvent.click(screen.getByRole('button', { name: 'Read it' }));
    expect(await screen.findByLabelText('Address')).toHaveValue('https://api.githubcopilot.com/mcp/');
    expect(screen.queryByText(/pasted-value/)).toBeNull();
    expect(screen.getByText(/The Authorization header from your config waits/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    // The card it matches gives the name.
    await waitFor(() => expect(mocked.addConnection).toHaveBeenCalledWith('https://api.githubcopilot.com/mcp/', 'GitHub'));
    expect(await screen.findByRole('radio', { name: 'Token' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('Before the token')).toHaveValue('Bearer ');
    fireEvent.click(screen.getByRole('button', { name: 'Try it and keep it' }));
    await waitFor(() => expect(mocked.connectionToken).toHaveBeenCalledWith(pending.id, { token: 'pasted-value', header: 'Authorization', prefix: 'Bearer ' }));
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

describe('review again, the states, remembered approval', () => {
  it('asks for another review when the tools changed, and says since when an unreachable one is retried', async () => {
    mocked.connections.mockResolvedValue(view([
      connection({ state: 'needs-review', heldTools: 1, toolCount: 11 }),
      connection({ id: '22222222-2222-4222-8222-222222222222', name: 'Linear', slug: 'linear', url: 'https://mcp.linear.app/mcp', host: 'mcp.linear.app', state: 'unreachable', unreachableSince: '2026-09-28T09:05:00Z', grant: 'mcp.linear.*' }),
    ]));
    render(<Connections embedded timezone="UTC" />);
    expect(await screen.findByText('Needs review')).toBeInTheDocument();
    expect(screen.getByText('Unreachable')).toBeInTheDocument();
    // The row's own shortcut to the review.
    expect(within(screen.getByLabelText('GitHub: details')).getByRole('button', { name: 'Review' })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('GitHub: details'));
    let sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText(/The new and changed ones wait until you review it again \(1 of the ones you kept waits\)/)).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Review again' })).toHaveAttribute('data-variant', 'accent');
    fireEvent.click(within(sheet).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(screen.getByLabelText('Linear: details'));
    sheet = await screen.findByRole('dialog');
    expect(within(sheet).getByText('Unreachable since 28 Sept 2026, 09:05, retrying.'.replace('Sept', new Intl.DateTimeFormat('en-GB', { month: 'short' }).format(new Date('2026-09-28'))))).toBeInTheDocument();
  });

  it('shows what changed since the last review, tool by tool', async () => {
    mocked.connectionReview.mockResolvedValue({
      ...REVIEW, slugEditable: false, connection: connection({ state: 'needs-review' }),
      changes: { added: ['close_issue'], changed: ['create_issue'], removed: ['old_tool'] },
      tools: REVIEW.tools.map((t) => ({ ...t, change: t.name === 'create_issue' ? 'changed' as const : null })),
    });
    render(<ConnectFlow start={{ step: 'review', connection: connection({ state: 'needs-review' }), keepGrants: true }} agents={AGENTS} onClose={() => {}} />);
    expect(await screen.findByText('GitHub changed its tools since your last review.')).toBeInTheDocument();
    const changes = screen.getByRole('list', { name: 'What changed' });
    expect(within(changes).getByText('close_issue')).toBeInTheDocument();
    expect(within(changes).getByText('old_tool')).toBeInTheDocument();
    expect(screen.getByText('Changed')).toBeInTheDocument();
    // Why a destructive tool is never remembered, on the review itself.
    expect(screen.getByText(/never remembered/)).toBeInTheDocument();
  });

  it('remembers approval for the agents given the tools, never for a destructive one', async () => {
    const kept = connection({ slug: 'gh', grant: 'mcp.gh.*', agents: [] });
    mocked.connectionTools.mockResolvedValue({ connection: 'gh', tools: [
      { tool: 'mcp.gh.search_issues', tier: 'auto', rememberable: false, why: null },
      { tool: 'mcp.gh.create_issue', tier: 'gated', rememberable: true, why: null },
      { tool: 'mcp.gh.delete_repo', tier: 'gated', rememberable: false, why: 'It can delete or destroy something, so it asks you every time and is never remembered.' },
    ] });
    mocked.grantConnection.mockResolvedValue({ granted: ['concierge'], failed: [], connection: kept });
    mocked.setRememberedApproval.mockResolvedValue({ agent: 'concierge', tool: 'mcp.gh.create_issue', remembered: true });
    const onClose = vi.fn();
    render(<ConnectFlow start={{ step: 'grant', connection: kept }} agents={AGENTS} onClose={onClose} />);
    const group = await screen.findByRole('group', { name: 'Remembered approval' });
    expect(within(group).getByRole('checkbox', { name: 'mcp.gh.delete_repo' })).toBeDisabled();
    expect(within(group).getByText(/never remembered/)).toBeInTheDocument();
    expect(within(group).queryByText('mcp.gh.search_issues')).toBeNull();
    fireEvent.click(within(group).getByRole('checkbox', { name: 'mcp.gh.create_issue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Give them' }));
    await waitFor(() => expect(mocked.setRememberedApproval).toHaveBeenCalledWith('concierge', 'mcp.gh.create_issue', true));
    expect(mocked.setRememberedApproval).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
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

  describe('a program on this computer', () => {
    const program = (over: Partial<ConnectionView> = {}): ConnectionView => connection({
      id: '22222222-2222-4222-8222-222222222222', slug: null, name: 'Trokky', url: 'npx -y @trokky/mcp@3', host: 'this computer',
      state: 'pending-review', authKind: 'none', grant: null, agents: [], transport: 'stdio',
      program: {
        command: 'npx', args: ['-y', '@trokky/mcp@3'], line: 'npx -y @trokky/mcp@3', changedSinceReview: false,
        env: [{ name: 'TROKKY_URL', secret: false, value: 'https://t.example' }, { name: 'TROKKY_TOKEN', secret: true }],
      },
      ...over,
    });

    it('fills the form, shows the whole command line, switches Secret on for a token, and records it only on Continue', async () => {
      const added = program();
      mocked.addProgram.mockResolvedValue({ connection: added, signIn: 'none' });
      mocked.connectionReview.mockResolvedValue({
        ...REVIEW, connection: added, slug: 'trokky', host: 'this computer', program: added.program,
        tools: [{ name: 'list', fullName: 'mcp.trokky.list', description: 'Lists.', tier: 'auto', destructive: false, annotated: true, problem: null }],
      });
      render(<ConnectFlow start={{ step: 'program' }} agents={AGENTS} onClose={() => {}} />);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Trokky' } });
      fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npx' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add an argument' }));
      fireEvent.change(screen.getByLabelText('Argument 1'), { target: { value: '-y' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add an argument' }));
      fireEvent.change(screen.getByLabelText('Argument 2'), { target: { value: '@trokky/mcp@3' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add a variable' }));
      fireEvent.change(screen.getByLabelText('Variable 1 name'), { target: { value: 'TROKKY_TOKEN' } });
      expect(screen.getByRole('checkbox', { name: 'Secret' })).toBeChecked();
      expect(screen.getByLabelText('Variable 1 value')).toHaveAttribute('type', 'password');
      // A secret with no value cannot be kept.
      expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
      fireEvent.change(screen.getByLabelText('Variable 1 value'), { target: { value: 'tok-1' } });
      expect(screen.getByLabelText('The command line')).toHaveTextContent('npx -y @trokky/mcp@3');
      expect(screen.getByText(/needs a screen/)).toBeInTheDocument();
      expect(mocked.addProgram).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      await waitFor(() => expect(mocked.addProgram).toHaveBeenCalledWith({
        name: 'Trokky', command: 'npx', args: ['-y', '@trokky/mcp@3'], env: [{ name: 'TROKKY_TOKEN', value: 'tok-1', secret: true }],
      }));
      // The review: the command in full above the tools, and the trust words.
      expect(await screen.findByText('This runs on this computer as you')).toBeInTheDocument();
      expect(screen.getByLabelText('The command')).toHaveTextContent('npx -y @trokky/mcp@3');
      expect(screen.getByText('mcp.trokky.list')).toBeInTheDocument();
    });

    it('splits a whole line typed into Command into the command and its arguments', async () => {
      mocked.addProgram.mockResolvedValue({ connection: program(), signIn: 'none' });
      mocked.connectionReview.mockResolvedValue({ ...REVIEW, connection: program(), slug: 'trokky', host: 'this computer', program: program().program, tools: [] });
      render(<ConnectFlow start={{ step: 'program' }} agents={AGENTS} onClose={() => {}} />);
      fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Trokky' } });
      fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npx -y @trokky/mcp@3' } });
      expect(screen.getByLabelText('The command line')).toHaveTextContent('npx -y @trokky/mcp@3');
      expect(screen.getByLabelText('The command line')).not.toHaveTextContent("'");
      fireEvent.blur(screen.getByLabelText('Command'));
      expect(screen.getByLabelText('Command')).toHaveValue('npx');
      expect(screen.getByLabelText('Argument 1')).toHaveValue('-y');
      expect(screen.getByLabelText('Argument 2')).toHaveValue('@trokky/mcp@3');
      fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'npx -y @trokky/mcp@3' } });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      await waitFor(() => expect(mocked.addProgram).toHaveBeenCalledWith(expect.objectContaining({ command: 'npx', args: ['-y', '@trokky/mcp@3', '-y', '@trokky/mcp@3'] })));
    });

    it('reads a pasted claude mcp add line into the form, nothing recorded until Continue', async () => {
      render(<ConnectFlow start={{ step: 'paste' }} agents={AGENTS} onClose={() => {}} />);
      fireEvent.change(screen.getByLabelText('Config'), {
        target: { value: 'claude mcp add trokky --env TROKKY_URL=https://t.example --env TROKKY_TOKEN=${TOKEN} -- npx -y @trokky/mcp@3' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Read it' }));
      expect(await screen.findByLabelText('Name')).toHaveValue('trokky');
      expect(screen.getByLabelText('Command')).toHaveValue('npx');
      expect(screen.getByLabelText('Argument 2')).toHaveValue('@trokky/mcp@3');
      expect(screen.getByLabelText('Variable 1 value')).toHaveValue('https://t.example');
      const secrets = screen.getAllByRole('checkbox', { name: 'Secret' });
      expect(secrets[0]).not.toBeChecked();
      expect(secrets[1]).toBeChecked();
      expect(screen.getByText(/placeholder for TROKKY_TOKEN/)).toBeInTheDocument();
      expect(mocked.addProgram).not.toHaveBeenCalled();
    });

    it('shows the program as a row, and its sheet: the command, as you, the last stderr lines, and Change', async () => {
      mocked.connections.mockResolvedValue(view([program({ slug: 'trokky', state: 'unreachable', unreachableSince: '2026-09-29T10:00:00Z', stderr: ['boom: cannot reach'] })]));
      render(<Connections timezone="UTC" />);
      expect(await screen.findByText('npx -y @trokky/mcp@3 · 12 tools')).toBeInTheDocument();
      expect(screen.getByText('Failed')).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText('Trokky: details'));
      const sheet = await screen.findByRole('dialog');
      expect(within(sheet).getByText('npx -y @trokky/mcp@3')).toBeInTheDocument();
      expect(within(sheet).getByText(/On this computer as you/)).toBeInTheDocument();
      expect(within(sheet).getByText(/It stopped answering at/)).toBeInTheDocument();
      expect(within(sheet).getByText('boom: cannot reach')).toBeInTheDocument();
      expect(within(sheet).queryByRole('button', { name: 'Reconnect' })).toBeNull();
      fireEvent.click(within(sheet).getByRole('button', { name: 'Change' }));
      expect(await screen.findByRole('dialog', { name: 'Change Trokky' })).toBeInTheDocument();
      expect(screen.getByLabelText('Command')).toHaveValue('npx');
    });

    it('keeps a secret on a change unless a new value is typed', async () => {
      const kept = program({ slug: 'trokky', state: 'connected' });
      mocked.updateProgram.mockResolvedValue(kept);
      const onClose = vi.fn();
      render(<ConnectFlow start={{ step: 'program', connection: kept, keepGrants: true }} agents={AGENTS} onClose={onClose} />);
      expect(screen.getByLabelText('Variable 2 value')).toHaveAttribute('placeholder', 'Kept. Type to replace it.');
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(mocked.updateProgram).toHaveBeenCalledWith(kept.id, {
        name: 'Trokky', command: 'npx', args: ['-y', '@trokky/mcp@3'],
        env: [{ name: 'TROKKY_URL', value: 'https://t.example', secret: false }, { name: 'TROKKY_TOKEN', value: '', secret: true }],
      }));
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });
  });
});
