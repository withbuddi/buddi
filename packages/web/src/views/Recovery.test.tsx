/**
 * Leaving recovery mode: what the one primary action actually sends.
 *
 * The checklist is a set of decisions about things that were true on another
 * machine, and the payload is the whole point of it. Its defaults are the safe
 * ones — work that was queued days ago is dropped, and a standing permission
 * an agent had is dropped unless the owner ticks it — so a test that only
 * clicked the button would prove the opposite of what matters.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, type RecoveryView } from '../api';
import { RecoveryBanner, RecoveryChecklist, useRecovery } from './Recovery';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: { recovery: vi.fn(), leaveRecovery: vi.fn() },
}));

const view = (over: Partial<RecoveryView['checklist']> = {}): RecoveryView => ({
  active: true,
  restoredAt: '2026-09-20T10:00:00.000Z',
  archive: 'buddi-2026-09-19.tar.gz.age',
  checklist: {
    secrets: [
      { name: 'PROVIDER_ACCOUNT_1', kind: 'account', label: 'Gemini — API key', accountId: 'acc-1', settingsRoute: '#/settings/accounts' },
      { name: 'TELEGRAM_BOT_TOKEN', kind: 'telegram', label: 'Telegram — bot token', settingsRoute: '#/settings/telegram' },
      { name: 'TAVILY_API_KEY', kind: 'plugin', label: 'Tavily — search key', settingsRoute: '#/settings/secrets' },
    ],
    plugins: [
      { name: 'finance', version: '0.2.0', source: 'npm @withbuddi/plugin-finance@0.2.0', installed: false, install: '@withbuddi/plugin-finance@0.2.0' },
      { name: 'ledger', version: '1.0.0', source: 'directory /plugins/ledger', installed: false },
    ],
    pending: { jobs: 3, missions: 1, approvals: 2, telegramChats: 1 },
    grants: [
      { id: 'g1', agent: 'ada', tool: 'shell', scope: 'always', description: 'run anything' },
      { id: 'g2', agent: 'ada', tool: 'browser', scope: 'conversation', description: '' },
      { id: 'g3', agent: 'sam', tool: 'files', scope: 'always', description: '' },
    ],
    ...over,
  },
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.leaveRecovery).mockResolvedValue({ accepted: true });
});

describe('the checklist', () => {
  it('drops the pending work and every permission unless the owner says otherwise', async () => {
    render(<RecoveryChecklist view={view()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Leave recovery mode' }));
    await waitFor(() =>
      expect(api.leaveRecovery).toHaveBeenCalledWith({ dropPending: true, keepGrants: [] }),
    );
  });

  it('keeps the permissions that were ticked, in the order they were ticked', async () => {
    render(<RecoveryChecklist view={view()} />);
    fireEvent.click(screen.getByLabelText('Keep shell for ada'));
    fireEvent.click(screen.getByLabelText('Keep files for sam'));
    fireEvent.click(screen.getByRole('button', { name: 'Leave recovery mode' }));
    await waitFor(() =>
      expect(api.leaveRecovery).toHaveBeenCalledWith({ dropPending: true, keepGrants: ['g1', 'g3'] }),
    );
  });

  it('unticks a permission again, and keeps the pending work when asked to', async () => {
    render(<RecoveryChecklist view={view()} />);
    const grant = screen.getByLabelText('Keep browser for ada');
    fireEvent.click(grant);
    fireEvent.click(grant);
    fireEvent.click(screen.getByLabelText(/Drop it/));
    fireEvent.click(screen.getByRole('button', { name: 'Leave recovery mode' }));
    await waitFor(() =>
      expect(api.leaveRecovery).toHaveBeenCalledWith({ dropPending: false, keepGrants: [] }),
    );
  });

  it('says what is missing in words, each with a Fix that goes to exactly where it is fixed', () => {
    render(<RecoveryChecklist view={view()} />);
    expect(screen.getByText('Gemini — API key')).toBeInTheDocument();
    expect(screen.getByText('PROVIDER_ACCOUNT_1')).toHaveClass('mono');
    expect(screen.getByRole('link', { name: 'Fix Gemini — API key' })).toHaveAttribute('href', '#/settings/accounts?account=acc-1');
    expect(screen.getByRole('link', { name: 'Fix Telegram — bot token' })).toHaveAttribute('href', '#/settings/telegram');
    expect(screen.getByRole('link', { name: 'Fix Tavily — search key' })).toHaveAttribute('href', '#/settings/secrets');
    expect(screen.getByRole('link', { name: 'Install finance again' })).toHaveAttribute(
      'href',
      '#/settings/plugins?install=%40withbuddi%2Fplugin-finance%400.2.0',
    );
    expect(screen.getByRole('link', { name: 'Install ledger again' })).toHaveAttribute('href', '#/settings/plugins?tab=browse');
  });

  it('says a missing plugin\'s data is kept and loads when it is installed, and names a table left staged', () => {
    render(
      <RecoveryChecklist
        view={view({
          plugins: [
            {
              name: 'finance', version: '0.2.0', source: 'npm @withbuddi/plugin-finance@0.2.0', installed: false,
              install: '@withbuddi/plugin-finance@0.2.0',
              waiting: { rows: 1544, note: '1,544 rows waiting, loaded when you install it' },
            },
            { name: 'weather', version: '0.1.0', source: 'npm', installed: true },
          ],
          keptTables: [{ schema: 'developer', table: 'developer.workspaces', rows: 3, sentence: 'developer.workspaces already had rows here.' }],
        })}
      />,
    );
    expect(screen.getByText('finance — 1,544 rows waiting, loaded when you install it')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Install finance again' })).toBeInTheDocument();
    expect(screen.queryByText('weather')).not.toBeInTheDocument();
    expect(screen.getByText('developer.workspaces already had rows here.')).toBeInTheDocument();
  });

  it('a mailbox goes where the gateway says; a connection opens its sheet; an OAuth one says Sign in again', () => {
    render(
      <RecoveryChecklist
        view={view({
          secrets: [
            { name: 'EMAIL_YOU_1a2b', kind: 'email', label: 'Gmail — app password for you@gmail.com', mailboxId: 'mb-1', settingsRoute: '#/settings/p.email.settings?account=mb-1&set=password' },
            { name: 'MCP_TOKEN_cgh', kind: 'connection', label: 'GitHub — sign-in', connectionId: 'c-gh', settingsRoute: '#/settings/connections?connection=c-gh' },
            { name: 'MCP_CONNECTION_clin', kind: 'connection', label: 'Linear — sign-in', connectionId: 'c-lin', signIn: true, settingsRoute: '#/settings/connections?connection=c-lin' },
            { name: 'MCP_ENV_ctr_TROKKY_TOKEN', kind: 'connection', label: 'Trokky — TROKKY_TOKEN', connectionId: 'c-tr', settingsRoute: '#/settings/connections?connection=c-tr' },
          ],
        })}
      />,
    );
    expect(screen.getByRole('link', { name: 'Fix Gmail — app password for you@gmail.com' })).toHaveAttribute('href', '#/settings/p.email.settings?account=mb-1&set=password');
    expect(screen.getByRole('link', { name: 'Fix GitHub — sign-in' })).toHaveAttribute('href', '#/settings/connections?connection=c-gh');
    const again = screen.getByRole('link', { name: 'Sign in again: Linear — sign-in' });
    expect(again).toHaveTextContent('Sign in again');
    expect(again).toHaveAttribute('href', '#/settings/connections?connection=c-lin');
    expect(screen.getByRole('link', { name: 'Fix Trokky — TROKKY_TOKEN' })).toHaveAttribute('href', '#/settings/connections?connection=c-tr');
  });

  it('a plugin installed since the last start reads "loads at the next restart" and offers Restart', () => {
    render(
      <RecoveryChecklist
        view={view({
          plugins: [
            {
              name: 'finance', version: '0.2.0', source: 'npm @withbuddi/plugin-finance@0.2.0', installed: true,
              loadsAtRestart: true, install: '@withbuddi/plugin-finance@0.2.0',
            },
          ],
        })}
      />,
    );
    expect(screen.getByText('installed — loads at the next restart')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Install finance again' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Restart to load finance' })).toHaveAttribute('href', '#/settings/system');
  });

  it('asks nothing when the backup left nothing behind', async () => {
    render(
      <RecoveryChecklist
        view={view({ secrets: [], plugins: [], grants: [], pending: { jobs: 0, missions: 0, approvals: 0, telegramChats: 0 } })}
      />,
    );
    expect(screen.queryByLabelText(/Drop it/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Leave recovery mode' }));
    await waitFor(() =>
      expect(api.leaveRecovery).toHaveBeenCalledWith({ dropPending: true, keepGrants: [] }),
    );
  });
});

describe('coming back to it', () => {
  function Probe(): JSX.Element {
    const { data } = useRecovery();
    return <span data-testid="count">{data ? data.checklist.secrets.length : '-'}</span>;
  }

  it('reads the checklist again when the tab regains focus, so a fixed key is gone', async () => {
    vi.mocked(api.recovery)
      .mockResolvedValueOnce(view())
      .mockResolvedValueOnce(view({ secrets: [] }));
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('3'));
    fireEvent.focus(window);
    await waitFor(() => expect(screen.getByTestId('count')).toHaveTextContent('0'));
    expect(api.recovery).toHaveBeenCalledTimes(2);
  });
});

describe('the banner', () => {
  it('is absent until this buddi was restored, and then points at the checklist', () => {
    const { container, rerender } = render(<RecoveryBanner active={false} onNavigate={() => {}} />);
    expect(container).toBeEmptyDOMElement();
    const go = vi.fn();
    rerender(<RecoveryBanner active onNavigate={go} />);
    expect(screen.getByRole('status')).toHaveTextContent(/restored from a backup/);
    fireEvent.click(screen.getByRole('link', { name: 'Finish the checklist' }));
    expect(go).toHaveBeenCalledWith('#/settings/backup');
  });
});
