/**
 * Sign in from elsewhere: the rows, the Cloudflare setup that opens in place,
 * what Save and Test my setup send and say, and the read-only block seen
 * through a provider.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, type AccessView, type CloudflareAccessView } from '../api';
import { AccessSettings, CloudflareAccess } from './Access';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: {
    access: vi.fn(),
    tailscale: vi.fn(),
    setTailscale: vi.fn(),
    cloudflareAccess: vi.fn(),
    setCloudflareAccess: vi.fn(),
    testCloudflareAccess: vi.fn(),
  },
}));

const ROWS: AccessView = {
  proxied: false,
  providers: [
    { id: 'tailscale', title: 'Tailscale', identity: 'login', proxy: 'this-machine', enabled: true, status: { state: 'ready', sentence: 'On for owner@example.com' } },
    { id: 'cloudflare-access', title: 'Cloudflare Access', identity: 'login', proxy: 'this-machine', enabled: false, status: { state: 'off', sentence: 'Off. Your own domain, with Cloudflare’s sign-in in front of it.' } },
  ],
};

const CF: CloudflareAccessView = {
  enabled: false,
  teamDomain: '',
  aud: '',
  email: '',
  publicOrigin: '',
  status: { state: 'off', sentence: 'Off.' },
  ingressPort: 4319,
  listening: false,
  lastVisit: null,
  proxied: false,
  setup: {
    steps: [
      { text: 'Install cloudflared on this computer.', command: 'brew install cloudflared' },
      { text: 'Create a tunnel.' },
      { text: 'Add a public hostname with this service.', command: 'http://127.0.0.1:4319' },
      { text: 'Add an Access application.' },
      { text: 'Copy the team domain and the AUD tag here.' },
    ],
    fields: [
      { key: 'teamDomain', label: 'Team domain', placeholder: 'yourteam.cloudflareaccess.com' },
      { key: 'aud', label: 'Application AUD tag' },
      { key: 'email', label: 'Your email', hint: 'The one your Access policy allows.' },
      { key: 'publicOrigin', label: 'Public address', hint: 'So cookies and the Origin check use it.' },
    ],
  },
};

beforeEach(() => { vi.clearAllMocks(); });

describe('Sign in from elsewhere', () => {
  it('lists a row per provider with its status, and opens one in place', async () => {
    vi.mocked(api.access).mockResolvedValue(ROWS);
    vi.mocked(api.cloudflareAccess).mockResolvedValue(CF);
    render(<AccessSettings />);
    expect(await screen.findByText('On for owner@example.com')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.getByText(/Off\. Your own domain/)).toBeInTheDocument();
    expect(screen.getByText(/works everywhere/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cloudflare Access'));
    // The steps, with the real ingress port to copy.
    expect(await screen.findByText('http://127.0.0.1:4319')).toBeInTheDocument();
    expect(screen.getByText('brew install cloudflared')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test my setup' })).toBeInTheDocument();
  });

  it('is read-only, with one notice, when the page came through a provider', async () => {
    vi.mocked(api.access).mockResolvedValue({ ...ROWS, proxied: true });
    vi.mocked(api.cloudflareAccess).mockResolvedValue({ ...CF, proxied: true, enabled: true, email: 'owner@example.com', teamDomain: 'team.cloudflareaccess.com' });
    render(<AccessSettings />);
    expect(await screen.findByText('Change this from the computer buddi runs on.')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cloudflare Access'));
    expect(await screen.findByText('On, for owner@example.com at team.cloudflareaccess.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('checkbox')).toBeDisabled();
  });
});

describe('the Cloudflare row', () => {
  it('saves the fields with the switch, and says what the keys answered', async () => {
    vi.mocked(api.cloudflareAccess).mockResolvedValue(CF);
    vi.mocked(api.setCloudflareAccess).mockResolvedValue({
      ...CF, enabled: true, teamDomain: 'team.cloudflareaccess.com', aud: 'a'.repeat(64), email: 'owner@example.com', publicOrigin: 'https://buddi.example.com',
      test: { ok: true, keys: 2 },
    });
    render(<CloudflareAccess />);
    fireEvent.change(await screen.findByLabelText('Team domain'), { target: { value: 'team.cloudflareaccess.com' } });
    fireEvent.change(screen.getByLabelText('Application AUD tag'), { target: { value: 'a'.repeat(64) } });
    fireEvent.change(screen.getByLabelText(/Your email/), { target: { value: 'owner@example.com' } });
    fireEvent.change(screen.getByLabelText(/Public address/), { target: { value: 'https://buddi.example.com' } });
    fireEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => expect(api.setCloudflareAccess).toHaveBeenCalledWith({
      enabled: true, teamDomain: 'team.cloudflareaccess.com', aud: 'a'.repeat(64), email: 'owner@example.com', publicOrigin: 'https://buddi.example.com',
    }));
    expect(await screen.findByText(/team\.cloudflareaccess\.com answered with 2 signing keys\. Open https:\/\/buddi\.example\.com from another device to finish\./)).toBeInTheDocument();
  });

  it('tests the setup without saving and shows a failure in words', async () => {
    vi.mocked(api.cloudflareAccess).mockResolvedValue({ ...CF, teamDomain: 'team.cloudflareaccess.com' });
    vi.mocked(api.testCloudflareAccess).mockResolvedValue({ ok: false, keys: 0, teamDomain: 'team.cloudflareaccess.com', sentence: 'team.cloudflareaccess.com didn’t answer with signing keys (404). Check the team domain.', listening: false, ingressPort: null });
    render(<CloudflareAccess />);
    fireEvent.click(await screen.findByRole('button', { name: 'Test my setup' }));
    await waitFor(() => expect(api.testCloudflareAccess).toHaveBeenCalledWith({ teamDomain: 'team.cloudflareaccess.com' }));
    const notice = await screen.findByText(/didn’t answer with signing keys \(404\)/);
    expect(notice).toBeInTheDocument();
    expect(api.setCloudflareAccess).not.toHaveBeenCalled();
    // Copy sits beside each command.
    const command = screen.getByText('http://127.0.0.1:4319');
    expect(within(command.closest('.tailscale-command') as HTMLElement).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('says the server’s sentence when a save is refused', async () => {
    const { ApiError } = await import('../api');
    vi.mocked(api.cloudflareAccess).mockResolvedValue(CF);
    vi.mocked(api.setCloudflareAccess).mockRejectedValue(new ApiError(400, 'To turn this on, fill in the AUD tag and your email.'));
    render(<CloudflareAccess />);
    fireEvent.click(await screen.findByRole('checkbox'));
    expect(await screen.findByText('To turn this on, fill in the AUD tag and your email.')).toBeInTheDocument();
  });
});
