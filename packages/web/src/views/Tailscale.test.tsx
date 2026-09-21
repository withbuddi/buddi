/**
 * The Tailscale panel: what it says about the daemon, what it prefills, and
 * the one state where it refuses to be edited — a browser that got here
 * through the tailnet cannot widen the setting that let it in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../api';
import { Tailscale } from './Settings';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: { tailscale: vi.fn(), setTailscale: vi.fn() },
}));

const VIEW = {
  enabled: false,
  login: '',
  available: true,
  self: { login: 'owner@example.com', name: 'The Owner' },
  proxied: false,
  serveCommand: 'tailscale serve --bg --https=9443 http://127.0.0.1:4317',
};

beforeEach(() => { vi.clearAllMocks(); });

describe('the Tailscale panel', () => {
  it('says who this machine is signed in as and prefills that login', async () => {
    vi.mocked(api.tailscale).mockResolvedValue(VIEW);
    render(<Tailscale />);
    expect(await screen.findByText('Tailscale is running on this machine as owner@example.com.')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('owner@example.com');
    expect(screen.getByText(/Anyone signed in to Tailscale as this login/)).toBeInTheDocument();
    expect(screen.getByText(VIEW.serveCommand)).toBeInTheDocument();
  });

  it('says so when there is no daemon here', async () => {
    vi.mocked(api.tailscale).mockResolvedValue({ ...VIEW, available: false, self: null });
    render(<Tailscale />);
    expect(await screen.findByText('Tailscale is not running here.')).toBeInTheDocument();
  });

  it('saves the switch and the login together', async () => {
    vi.mocked(api.tailscale).mockResolvedValue(VIEW);
    vi.mocked(api.setTailscale).mockResolvedValue({ ...VIEW, enabled: true, login: 'someone@example.com' });
    render(<Tailscale />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'someone@example.com' } });
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(api.setTailscale).toHaveBeenCalledWith({ enabled: true, login: 'someone@example.com' }));
  });

  it('is read-only when the page itself came through Tailscale', async () => {
    vi.mocked(api.tailscale).mockResolvedValue({ ...VIEW, enabled: true, login: 'owner@example.com', proxied: true });
    render(<Tailscale />);
    expect(await screen.findByText('Change this from the computer buddi runs on.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
