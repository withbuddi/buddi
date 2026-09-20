/**
 * The Service section: only where there is a supervisor, and never a stop or a
 * restart the owner did not confirm after being told it closes the page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../api';
import { Service } from './Settings';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: { service: vi.fn(), serviceAction: vi.fn() },
}));

const STATUS = {
  phase: 'ready', supervisorPid: 11, installRoot: '/install', nodePath: '/node',
  database: 'running', databasePid: 22, gateway: 'running', gatewayPid: 33,
};

beforeEach(() => { vi.clearAllMocks(); });

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

  it('warns that a restart closes the dashboard, and only then restarts', async () => {
    vi.mocked(api.service).mockResolvedValue({ supervised: true, status: STATUS });
    vi.mocked(api.serviceAction).mockResolvedValue({ supervised: true, status: STATUS });
    render(<Service />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart gateway' }));
    expect(api.serviceAction).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/closes this dashboard/);
    expect(screen.getByRole('alert')).toHaveTextContent(/run buddi in a terminal/);
    fireEvent.click(screen.getByRole('button', { name: 'Restart it' }));
    await waitFor(() => expect(api.serviceAction).toHaveBeenCalledWith('restart'));
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
