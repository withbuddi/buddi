/**
 * A restore restarts buddi under the page: "Restoring buddi" goes up once the
 * restore is accepted, carries each step, and goes away again when the
 * restore fails while the gateway still answers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { api } from '../api';
import { Backup } from './Backup';
import { resetRestart, restartState } from '../shell/restart';

vi.mock('../api', async (load) => {
  const real = await load<typeof import('../api')>();
  const fns: Record<string, ReturnType<typeof vi.fn>> = {};
  // Every read this page makes that a test does not answer simply never answers.
  return { ...real, api: new Proxy(fns, { get: (target, key: string) => (target[key] ??= vi.fn(() => new Promise(() => {}))) }) };
});

const ARCHIVE = { name: 'buddi-backup-20260930-030000.tar.gz', createdAt: new Date().toISOString(), bytes: 1024, encrypted: false, envelopeOk: null };

beforeEach(() => {
  resetRestart();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  vi.mocked(api.backups).mockResolvedValue({ dir: '/data/backups', archives: [ARCHIVE], database: 'buddi', supervised: true });
  vi.mocked(api.service).mockResolvedValue({ supervised: true });
});
afterEach(() => {
  resetRestart();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function restore(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Restore…' }));
  const field = screen.getByLabelText('Type buddi to confirm');
  fireEvent.change(field, { target: { value: 'buddi' } });
  fireEvent.click(within(field.closest('td')!).getByRole('button', { name: 'Restore' }));
}

describe('restoring a backup', () => {
  it('puts up the restore screen once it is accepted, with each step', async () => {
    vi.mocked(api.restoreArchive).mockResolvedValue({ job: { id: 'r1', kind: 'restore', phase: 'queued', startedAt: new Date().toISOString() } });
    vi.mocked(api.backupJob).mockResolvedValue({ id: 'r1', kind: 'restore', phase: 'database', startedAt: new Date().toISOString() });
    render(<Backup />);
    await restore();
    await act(async () => {});
    expect(restartState()).toMatchObject({ kind: 'restore', step: 'Putting the database back.' });
  });

  it('takes it away again when the restore fails while buddi still answers', async () => {
    vi.mocked(api.restoreArchive).mockResolvedValue({ job: { id: 'r1', kind: 'restore', phase: 'queued', startedAt: new Date().toISOString() } });
    vi.mocked(api.backupJob).mockResolvedValue({
      id: 'r1', kind: 'restore', phase: 'rolled-back', error: 'the archive is damaged', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    });
    render(<Backup />);
    await restore();
    expect(await screen.findByText(/the archive is damaged/)).toBeInTheDocument();
    expect(restartState()).toBeNull();
  });
});

describe('the passphrase', () => {
  const PHRASE = 'able acid actor adult afraid agent';

  it('Reveal asks for the PIN when one is set, then shows the words', async () => {
    const { ApiError } = await import('../api');
    vi.mocked(api.revealBackupPassphrase)
      .mockRejectedValueOnce(new ApiError(403, 'Type your PIN to see it.'))
      .mockResolvedValueOnce({ passphrase: PHRASE });
    render(<Backup />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal' }));
    const pin = await screen.findByLabelText('Your PIN');
    expect(screen.queryByText(PHRASE)).not.toBeInTheDocument();
    fireEvent.change(pin, { target: { value: '2468' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(await screen.findByText(PHRASE)).toBeInTheDocument();
    expect(vi.mocked(api.revealBackupPassphrase).mock.calls).toEqual([[undefined], ['2468']]);
  });

  it('Reveal shows the words at once when there is no PIN', async () => {
    vi.mocked(api.revealBackupPassphrase).mockResolvedValueOnce({ passphrase: PHRASE });
    render(<Backup />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reveal' }));
    expect(await screen.findByText(PHRASE)).toBeInTheDocument();
  });

  it('the restore of a locked backup reads its .passphrase.txt', async () => {
    vi.mocked(api.backups).mockResolvedValue({ dir: '/data/backups', archives: [{ ...ARCHIVE, name: 'buddi-backup-20260930-030000.tar.gz.age', encrypted: true, envelopeOk: true }], database: 'buddi', supervised: true });
    render(<Backup />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restore…' }));
    const file = new File(['buddi backup passphrase\n\n' + PHRASE + '\n\nThese six words open it.\n'], 'buddi-backup-20260930-030000.tar.gz.age.passphrase.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText('The passphrase file'), { target: { files: [file] } });
    expect(await screen.findByText(/Read from buddi-backup-20260930-030000\.tar\.gz\.age\.passphrase\.txt/)).toBeInTheDocument();
    expect(screen.getByLabelText('The passphrase this one was locked with')).toHaveValue(PHRASE);
  });
});
