/**
 * Settings → System, the Version panel: nothing is upgraded without the
 * sentence that says what upgrading does, and a page that loses its gateway
 * waits for a new one rather than for ever.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError, api } from '../api';
import { Version } from './Settings';
import { UPGRADE_PATIENCE_MS, resetRestart, restartState } from '../shell/restart';

vi.mock('../api', async (load) => {
  const real = await load<typeof import('../api')>();
  return {
    ...real,
    api: {
      version: vi.fn(),
      checkVersion: vi.fn(),
      setVersionCheck: vi.fn(),
      startUpgrade: vi.fn(),
      upgradeJob: vi.fn(),
      session: vi.fn(),
    },
  };
});

const AVAILABLE = {
  current: '0.1.0',
  latest: '0.1.1',
  checkedAt: new Date().toISOString(),
  checkEnabled: true,
  updateAvailable: true,
  history: [],
  supervised: true,
  checkout: false,
};

beforeEach(() => { vi.clearAllMocks(); resetRestart(); vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); })); });
afterEach(() => { resetRestart(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('the version panel', () => {
  it('offers a checkout the command instead of a button', async () => {
    vi.mocked(api.version).mockResolvedValue({
      current: '0.1.0 (v0.1.0-3-gabc1234-dirty)',
      checkEnabled: false,
      updateAvailable: false,
      history: [],
      supervised: false,
      checkout: true,
    });
    render(<Version />);
    expect(await screen.findByText(/A checkout upgrades with git pull, then buddi upgrade in a terminal\./)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says what is newest, and asks the registry only when told to', async () => {
    vi.mocked(api.version).mockResolvedValue(AVAILABLE);
    vi.mocked(api.checkVersion).mockResolvedValue(AVAILABLE);
    vi.mocked(api.setVersionCheck).mockResolvedValue({ ...AVAILABLE, checkEnabled: false });
    render(<Version />);
    expect(await screen.findByText(/A newer buddi is available:/)).toBeInTheDocument();
    expect(screen.getByText('0.1.1')).toBeInTheDocument();
    // The outbound call is disclosed beside the switch that repeats it daily.
    expect(screen.getByText('The check asks the npm registry for the newest version and sends nothing else.')).toBeInTheDocument();
    expect(api.checkVersion).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(api.checkVersion).toHaveBeenCalled());

    fireEvent.click(screen.getByRole('checkbox', { name: 'Check once a day' }));
    await waitFor(() => expect(api.setVersionCheck).toHaveBeenCalledWith(false));
  });

  it('says npm is still processing a fresh version, and offers no Upgrade button meanwhile', async () => {
    vi.mocked(api.version).mockResolvedValue({
      ...AVAILABLE,
      latest: '0.1.0-pre.38',
      current: '0.1.0-pre.37',
      updateAvailable: false,
      latestNotes: '### Fixed\n\n- Something.',
      processing: { version: '0.1.0-pre.38', message: 'npm is still processing 0.1.0-pre.38; try again in a few minutes.' },
    });
    render(<Version />);
    expect(await screen.findByText('npm is still processing 0.1.0-pre.38; try again in a few minutes.')).toBeInTheDocument();
    expect(screen.queryByText(/A newer buddi is available/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Upgrade/ })).not.toBeInTheDocument();
    expect(screen.queryByText('What changes in 0.1.0-pre.38')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check now' })).toBeInTheDocument();
  });

  it('shows what changes in the newer version when its release carried notes, and nothing when not', async () => {
    vi.mocked(api.version).mockResolvedValue({ ...AVAILABLE, latestNotes: '### Fixed\n\n- The browser starts on Ubuntu.' });
    const { unmount } = render(<Version />);
    expect(await screen.findByText('What changes in 0.1.1')).toBeInTheDocument();
    expect(screen.getByRole('listitem')).toHaveTextContent('The browser starts on Ubuntu.');
    unmount();

    vi.mocked(api.version).mockResolvedValue(AVAILABLE);
    render(<Version />);
    await screen.findByRole('button', { name: 'Upgrade to 0.1.1' });
    expect(screen.queryByText(/What changes in/)).not.toBeInTheDocument();
  });

  it('warns what an upgrade does, and only then sends the version it offered', async () => {
    vi.mocked(api.version).mockResolvedValue(AVAILABLE);
    vi.mocked(api.startUpgrade).mockResolvedValue({ job: { id: 'job-1', phase: 'backup', startedAt: new Date().toISOString() } });
    vi.mocked(api.upgradeJob).mockResolvedValue({ id: 'job-1', phase: 'backup', startedAt: new Date().toISOString() });
    render(<Version />);
    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade to 0.1.1' }));
    expect(api.startUpgrade).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This takes a backup, installs the new version and restarts buddi. This page waits for it and comes back by itself.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to 0.1.1' }));
    await waitFor(() => expect(api.startUpgrade).toHaveBeenCalledWith('0.1.1'));
  });

  it('lets an upgrade be reconsidered before it starts', async () => {
    vi.mocked(api.version).mockResolvedValue(AVAILABLE);
    render(<Version />);
    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade to 0.1.1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(api.startUpgrade).not.toHaveBeenCalled();
  });

  it('puts up the upgrade screen at once, feeds it each step, and leaves the waiting to it', async () => {
    vi.useFakeTimers();
    vi.mocked(api.version).mockResolvedValue(AVAILABLE);
    vi.mocked(api.startUpgrade).mockResolvedValue({ job: { id: 'job-1', phase: 'backup', startedAt: new Date().toISOString() } });
    vi.mocked(api.upgradeJob)
      .mockResolvedValueOnce({ id: 'job-1', phase: 'installing', startedAt: new Date().toISOString() })
      // The gateway is stopped from under this page: that is the upgrade working.
      .mockRejectedValue(new ApiError(0, 'failed to fetch'));

    render(<Version />);
    const tick = async (ms: number): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
    await tick(0);
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to 0.1.1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to 0.1.1' }));
    expect(restartState()).toMatchObject({ kind: 'upgrade', line: 'Upgrading to 0.1.1…', patienceMs: UPGRADE_PATIENCE_MS });
    await tick(0);
    expect(api.startUpgrade).toHaveBeenCalled();
    expect(restartState()?.step).toBe('Installing the new version.');

    // Once nothing answers, the job is not asked again: the screen waits for the new process.
    await tick(2_000);
    const asked = vi.mocked(api.upgradeJob).mock.calls.length;
    await tick(10_000);
    expect(vi.mocked(api.upgradeJob).mock.calls.length).toBe(asked);
    expect(restartState()?.kind).toBe('upgrade');
  });

  it('takes the screen away and says so when the upgrade is refused', async () => {
    vi.mocked(api.version).mockResolvedValue(AVAILABLE);
    vi.mocked(api.startUpgrade).mockRejectedValue(new ApiError(409, 'An upgrade is already running.'));
    render(<Version />);
    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade to 0.1.1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to 0.1.1' }));
    expect(await screen.findByText('An upgrade is already running.')).toBeInTheDocument();
    expect(restartState()).toBeNull();
  });

  it('reads a failure after the hand-over off the record, on the page reloaded onto the old version', async () => {
    const failed = {
      from: '0.1.0', to: '0.1.1', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      outcome: 'failed' as const, step: 'migrating', error: 'relation "core.jobs" already exists',
      backup: 'buddi-backup-20260101-000000.tar.gz',
    };
    vi.mocked(api.version).mockResolvedValue({ ...AVAILABLE, history: [failed] });
    const { unmount } = render(<Version />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The upgrade to 0.1.1 failed at migrating: relation "core.jobs" already exists. ' +
      'The backup taken first is buddi-backup-20260101-000000.tar.gz. Run buddi doctor in a terminal; it prints the way back.',
    );
    unmount();
    // An old failure is history, not news.
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    vi.mocked(api.version).mockResolvedValue({ ...AVAILABLE, history: [{ ...failed, startedAt: old, finishedAt: old }] });
    render(<Version />);
    await screen.findByText('Upgrades so far');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('hands the button back when an upgrade fails before anything was replaced', async () => {
    vi.useFakeTimers();
    vi.mocked(api.version).mockResolvedValue(AVAILABLE);
    vi.mocked(api.startUpgrade).mockResolvedValue({ job: { id: 'job-1', phase: 'backup', startedAt: new Date().toISOString() } });
    vi.mocked(api.upgradeJob).mockResolvedValue({
      id: 'job-1', phase: 'failed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      error: 'npm install buddi@0.1.1 failed: 404 Not Found',
    });

    render(<Version />);
    const tick = async (ms: number): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
    await tick(0);
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to 0.1.1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to 0.1.1' }));
    await tick(0);
    expect(screen.getByRole('alert')).toHaveTextContent('buddi is still running on the version it had.');
    // The screen that went up with the click is gone again.
    expect(restartState()).toBeNull();
    // The job ended, so nothing is polled again and the button works.
    const asked = vi.mocked(api.upgradeJob).mock.calls.length;
    await tick(10_000);
    expect(vi.mocked(api.upgradeJob).mock.calls.length).toBe(asked);
    expect(screen.getByRole('button', { name: 'Upgrade to 0.1.1' })).toBeEnabled();
  });
});
