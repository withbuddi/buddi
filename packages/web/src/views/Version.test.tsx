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

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.useRealTimers(); });

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

  it('warns what an upgrade does, and only then sends the version it offered', async () => {
    vi.mocked(api.version).mockResolvedValue(AVAILABLE);
    vi.mocked(api.startUpgrade).mockResolvedValue({ job: { id: 'job-1', phase: 'backup', startedAt: new Date().toISOString() } });
    vi.mocked(api.upgradeJob).mockResolvedValue({ id: 'job-1', phase: 'backup', startedAt: new Date().toISOString() });
    render(<Version />);
    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade to 0.1.1' }));
    expect(api.startUpgrade).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'This takes a backup, installs the new version and restarts buddi. This page closes and comes back on its own.',
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

  it('waits for the gateway to come back on a different version, then reloads once', async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    vi.mocked(api.version).mockResolvedValue(AVAILABLE);
    vi.mocked(api.startUpgrade).mockResolvedValue({ job: { id: 'job-1', phase: 'backup', startedAt: new Date().toISOString() } });
    vi.mocked(api.upgradeJob)
      .mockResolvedValueOnce({ id: 'job-1', phase: 'installing', startedAt: new Date().toISOString() })
      // The gateway is stopped from under this page: that is the upgrade working.
      .mockRejectedValue(new ApiError(0, 'failed to fetch'));
    vi.mocked(api.session)
      .mockResolvedValueOnce({ csrf: 'c', timezone: 'UTC', host: '127.0.0.1', port: 8787, version: '0.1.0' })
      .mockResolvedValue({ csrf: 'c', timezone: 'UTC', host: '127.0.0.1', port: 8787, version: '0.1.1' });

    render(<Version reload={reload} />);
    const tick = async (ms: number): Promise<void> => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
    await tick(0);
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to 0.1.1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade to 0.1.1' }));
    await tick(0);
    expect(api.startUpgrade).toHaveBeenCalled();

    // Once it is being followed: a phase, then silence, then the old version
    // still answering, then the new one.
    expect(screen.getByRole('status')).toHaveTextContent('Installing the new version.');
    await tick(2_000);
    expect(screen.getByRole('status')).toHaveTextContent('buddi is restarting.');
    await tick(2_000);
    expect(reload).not.toHaveBeenCalled();
    await tick(2_000);
    expect(reload).toHaveBeenCalledTimes(1);

    // And it stops: the loop does not keep reloading a page it already reloaded.
    await tick(10_000);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
