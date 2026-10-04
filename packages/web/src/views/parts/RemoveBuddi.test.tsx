/**
 * Remove buddi from this Mac: what goes, then the last backup and its six
 * words, and nothing removed until "I wrote it down" is ticked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../../api';
import { RemoveBuddi, removalLines } from './RemoveBuddi';

vi.mock('../../api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../api')>();
  return { ...original, api: { ...original.api, uninstallPlan: vi.fn(), uninstallBackup: vi.fn(), uninstallJob: vi.fn(), uninstall: vi.fn() } };
});

const PLAN = {
  available: true as const,
  data: '/Users/me/Library/Application Support/buddi',
  keychain: 'buddi.install.abc',
  service: undefined,
  app: '/Applications/buddi.app',
  backups: '/Users/me/buddi-backups',
  appFinishes: true,
  token: 'tok',
};
const PHRASE = 'able acid actor adult afraid agent';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.uninstallPlan).mockResolvedValue(PLAN);
  vi.mocked(api.uninstallBackup).mockResolvedValue({ job: { id: 'j1', kind: 'uninstall-backup', phase: 'starting', startedAt: 'now' } });
  vi.mocked(api.uninstallJob).mockResolvedValue({
    id: 'j1', kind: 'uninstall-backup', phase: 'done', startedAt: 'now', finishedAt: 'now',
    report: { archive: '/Users/me/buddi-backups/buddi-backup-1.tar.gz.age', passphraseFile: '/Users/me/buddi-backups/buddi-backup-1.tar.gz.age.passphrase.txt', passphrase: PHRASE },
  });
  vi.mocked(api.uninstall).mockResolvedValue({ accepted: true });
});
afterEach(() => cleanup());

describe('RemoveBuddi', { timeout: 180_000 }, () => {
  it('lists what goes; keeping the data keeps the data and the keychain', () => {
    expect(removalLines(PLAN, false).join('\n')).toMatch(/Your data: .*Application Support\/buddi[\s\S]*keychain \(buddi\.install\.abc\)[\s\S]*buddi\.app, moved to the Trash/);
    const kept = removalLines(PLAN, true).join('\n');
    expect(kept).not.toMatch(/Your data|keychain/);
    expect(kept).toMatch(/buddi\.app/);
  });

  it('takes the backup, shows the words, and removes only after "I wrote it down"', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<RemoveBuddi />);
    await user.click(screen.getByRole('button', { name: 'Remove buddi from this Mac…' }));
    expect(await screen.findByText(/moved to the Trash/)).toBeInTheDocument();
    await user.click(screen.getByLabelText('Keep my data for a reinstall'));
    await user.click(screen.getByRole('button', { name: 'Take the last backup' }));
    expect(await screen.findByText(PHRASE)).toBeInTheDocument();
    expect(api.uninstallBackup).toHaveBeenCalledWith('tok');
    const remove = screen.getByRole('button', { name: 'Remove buddi' });
    expect(remove).toBeDisabled();
    expect(api.uninstall).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('I wrote it down'));
    expect(remove).toBeEnabled();
    await user.click(remove);
    expect(api.uninstall).toHaveBeenCalledWith({ token: 'tok', wroteItDown: true, keepData: true });
    expect(await screen.findByText(/The app quits when it is done/)).toBeInTheDocument();
  });

  it('removes nothing when the backup fails', async () => {
    vi.mocked(api.uninstallJob).mockResolvedValue({ id: 'j1', kind: 'uninstall-backup', phase: 'failed', error: 'disk full', startedAt: 'now', finishedAt: 'now' });
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<RemoveBuddi />);
    await user.click(screen.getByRole('button', { name: 'Remove buddi from this Mac…' }));
    await user.click(await screen.findByRole('button', { name: 'Take the last backup' }));
    expect(await screen.findByText(/disk full\. Nothing was removed\./)).toBeInTheDocument();
    expect(api.uninstall).not.toHaveBeenCalled();
  });

  it('a checkout says to use the terminal', async () => {
    vi.mocked(api.uninstallPlan).mockResolvedValue({ available: false, reason: 'A source checkout removes buddi with buddi uninstall in a terminal.' });
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(<RemoveBuddi />);
    await user.click(screen.getByRole('button', { name: 'Remove buddi from this Mac…' }));
    expect(await screen.findByText(/buddi uninstall in a terminal/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove buddi from this Mac…' })).toBeDisabled();
  });
});
