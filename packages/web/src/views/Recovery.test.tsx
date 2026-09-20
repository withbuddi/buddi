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
import { RecoveryBanner, RecoveryChecklist } from './Recovery';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: { recovery: vi.fn(), leaveRecovery: vi.fn() },
}));

const view = (over: Partial<RecoveryView['checklist']> = {}): RecoveryView => ({
  active: true,
  restoredAt: '2026-09-20T10:00:00.000Z',
  archive: 'buddi-2026-09-19.tar.gz.age',
  checklist: {
    secrets: [{ name: 'Anthropic', kind: 'account', settingsRoute: '#/settings/accounts' }],
    plugins: [{ name: 'finance', version: '0.2.0', source: 'registry', installed: false }],
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

  it('says what is missing, each as a way to go and fix it', () => {
    render(<RecoveryChecklist view={view()} />);
    expect(screen.getByRole('link', { name: 'Anthropic' })).toHaveAttribute('href', '#/settings/accounts');
    expect(screen.getByText('finance')).toBeInTheDocument();
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
