/**
 * The Service section: only where there is a supervisor, and never a stop or a
 * restart the owner did not confirm after being told what it does to the page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../api';
import { Service } from './Settings';
import { resetRestart, restartState } from '../shell/restart';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: { service: vi.fn(), serviceAction: vi.fn() },
}));

const STATUS = {
  phase: 'ready', supervisorPid: 11, installRoot: '/install', nodePath: '/node',
  database: 'running', databasePid: 22, gateway: 'running', gatewayPid: 33,
};

beforeEach(() => {
  vi.clearAllMocks();
  resetRestart();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
});

describe('the service section', () => {
  it('is absent when nothing supervises this gateway', async () => {
    vi.mocked(api.service).mockResolvedValue({ supervised: false });
    const { container } = render(<Service />);
    await waitFor(() => expect(api.service).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('shows both processes with their pids', async () => {
    vi.mocked(api.service).mockResolvedValue({ supervised: true, status: STATUS });
    render(<Service />);
    expect(await screen.findByText('pid 22')).toBeInTheDocument();
    expect(screen.getByText('pid 33')).toBeInTheDocument();
    expect(screen.getByText('pid 11')).toBeInTheDocument();
    expect(screen.getAllByText('running')).toHaveLength(2);
  });

  it('says what a restart does, and only then restarts, under the restart screen', async () => {
    vi.mocked(api.service).mockResolvedValue({ supervised: true, status: STATUS });
    vi.mocked(api.serviceAction).mockResolvedValue({ supervised: true, pending: 'restart' });
    render(<Service />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart gateway' }));
    expect(api.serviceAction).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Restarting the gateway takes a few seconds. This page waits for it and comes back by itself.');
    expect(restartState()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restart it' }));
    expect(restartState()?.kind).toBe('restart');
    await waitFor(() => expect(api.serviceAction).toHaveBeenCalledWith('restart'));
  });

  it('draws a stop as stopped, not as a restart', async () => {
    vi.mocked(api.service).mockResolvedValue({ supervised: true, status: STATUS });
    vi.mocked(api.serviceAction).mockResolvedValue({ supervised: true, pending: 'stop' });
    render(<Service />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop gateway' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stop it' }));
    expect(restartState()?.kind).toBe('stop');
    await waitFor(() => expect(api.serviceAction).toHaveBeenCalledWith('stop'));
  });

  it('lets a stop be reconsidered before it happens', async () => {
    vi.mocked(api.service).mockResolvedValue({ supervised: true, status: STATUS });
    render(<Service />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop gateway' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/The database keeps running/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: 'Stop gateway' })).toBeInTheDocument();
    expect(api.serviceAction).not.toHaveBeenCalled();
  });
});

describe('a settings section', () => {
  it('keeps its title on the ground above its panel, never inside it', async () => {
    vi.mocked(api.service).mockResolvedValue({ supervised: true, status: STATUS });
    render(<Service />);
    const heading = await screen.findByRole('heading', { name: 'Service' });
    const section = heading.closest('section') as HTMLElement;
    const panel = section.querySelector(':scope > .ui-panel') as HTMLElement;
    expect(panel).not.toBeNull();
    expect(panel).not.toContainElement(heading);
    expect(heading.closest('.ui-panel')).toBeNull();
    expect(panel).toContainElement(screen.getByText('pid 22'));
  });
});
