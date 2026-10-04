/**
 * Sign in from elsewhere: the rows, the Cloudflare setup that opens in place,
 * what Save and Test my setup send and say, and the read-only block seen
 * through a provider.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, type AccessView, type CloudflareAccessView, type CloudflareSetupProgress, type CloudflareSetupView } from '../api';
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
    cloudflareSetup: vi.fn(),
    cloudflareZones: vi.fn(),
    startCloudflareSetup: vi.fn(),
    stopCloudflareSetup: vi.fn(),
    removeCloudflareSetup: vi.fn(),
    forgetCloudflareToken: vi.fn(),
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

const IDS = ['token', 'tunnel', 'route', 'dns', 'access', 'save', 'connector', 'healthy', 'test'] as const;
function progress(state: CloudflareSetupProgress['state'], doneUpTo: number, extra: Partial<CloudflareSetupProgress> = {}): CloudflareSetupProgress {
  return {
    state, host: 'buddi.example.com', email: 'owner@example.com',
    steps: IDS.map((id, i) => ({ id, state: i < doneUpTo ? 'done' : i === doneUpTo ? 'now' : 'next', text: `step ${id}` })),
    install: null, error: null, url: null, removed: [], uninstall: null, ...extra,
  };
}
const SETUP: CloudflareSetupView = {
  progress: progress('idle', -1),
  tokenStored: false,
  record: null,
  permissions: ['Account · Cloudflare Tunnel · Edit', 'Zone · DNS · Edit — on the zone of your hostname'],
  ingressPort: 4319,
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
    vi.mocked(api.cloudflareSetup).mockResolvedValue(SETUP);
    fireEvent.click(screen.getByText('Cloudflare Access'));
    // Not set up yet: "Set it up for me" first, the five steps one click away.
    expect(await screen.findByRole('button', { name: 'Set it up for me' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /do it myself/ }));
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

  it('says what is missing in a neutral line, and as the error only once the switch is tried', async () => {
    vi.mocked(api.cloudflareAccess).mockResolvedValue(CF);
    render(<CloudflareAccess />);
    const line = await screen.findByText('To turn this on, fill in the team domain, the AUD tag and your email.');
    expect(line.closest('[role="alert"]')).toBeNull();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(await screen.findByRole('alert')).toHaveTextContent('To turn this on, fill in the team domain, the AUD tag and your email.');
    expect(api.setCloudflareAccess).not.toHaveBeenCalled();
  });

  it('says the server’s sentence when a save is refused', async () => {
    const { ApiError } = await import('../api');
    vi.mocked(api.cloudflareAccess).mockResolvedValue({ ...CF, teamDomain: 'team.cloudflareaccess.com', aud: 'a'.repeat(64), email: 'owner@example.com' });
    vi.mocked(api.setCloudflareAccess).mockRejectedValue(new ApiError(400, 'The public address must be an https:// address.'));
    render(<CloudflareAccess />);
    fireEvent.click(await screen.findByRole('checkbox'));
    expect(await screen.findByText('The public address must be an https:// address.')).toBeInTheDocument();
  });
});

describe('Set it up for me', () => {
  it('checks the token, and with no domain listed takes the full hostname, then shows the run with the one command to copy', async () => {
    vi.mocked(api.access).mockResolvedValue(ROWS);
    vi.mocked(api.cloudflareSetup).mockResolvedValue(SETUP);
    vi.mocked(api.cloudflareZones).mockResolvedValue({ zones: [] });
    const waiting = progress('waiting', 6, { install: { command: 'sudo cloudflared service install eyJtoken', note: 'If sudo can’t find it, use /opt/homebrew/bin/cloudflared.' } });
    vi.mocked(api.startCloudflareSetup).mockResolvedValue({ ...SETUP, tokenStored: true, progress: waiting });
    render(<AccessSettings />);
    fireEvent.click(await screen.findByText('Cloudflare Access'));
    fireEvent.click(await screen.findByRole('button', { name: 'Set it up for me' }));
    expect(screen.getByText('Account · Cloudflare Tunnel · Edit')).toBeInTheDocument();
    const start = screen.getByRole('button', { name: 'Set it up' });
    expect(start).toBeDisabled();
    const token = screen.getByLabelText(/API token/);
    fireEvent.change(token, { target: { value: 'cf-token-0123456789abcdef' } });
    fireEvent.blur(token);
    await waitFor(() => expect(api.cloudflareZones).toHaveBeenCalledWith({ token: 'cf-token-0123456789abcdef' }));
    expect(await screen.findByText('The token lists no domain; type the full name.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Hostname/), { target: { value: 'buddi.example.com' } });
    fireEvent.change(screen.getByLabelText(/Your email/), { target: { value: 'owner@example.com' } });
    fireEvent.click(start);
    await waitFor(() => expect(api.startCloudflareSetup).toHaveBeenCalledWith({ token: 'cf-token-0123456789abcdef', host: 'buddi.example.com', email: 'owner@example.com' }));
    expect(api.cloudflareZones).toHaveBeenCalledTimes(1);
    const command = await screen.findByText('sudo cloudflared service install eyJtoken');
    expect(within(command.closest('.tailscale-command') as HTMLElement).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
    expect(screen.getByText(/never runs sudo itself/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop waiting' })).toBeInTheDocument();
  });

  it('after the check, composes the hostname from the name and the domain picked', async () => {
    vi.mocked(api.access).mockResolvedValue(ROWS);
    vi.mocked(api.cloudflareSetup).mockResolvedValue(SETUP);
    vi.mocked(api.cloudflareZones).mockResolvedValue({ zones: [{ id: 'z1', name: 'example.com' }, { id: 'z2', name: 'sam.dev' }] });
    vi.mocked(api.startCloudflareSetup).mockResolvedValue({ ...SETUP, tokenStored: true, progress: progress('running', 1) });
    render(<AccessSettings />);
    fireEvent.click(await screen.findByText('Cloudflare Access'));
    fireEvent.click(await screen.findByRole('button', { name: 'Set it up for me' }));
    fireEvent.change(screen.getByLabelText(/API token/), { target: { value: 'cf-token-0123456789abcdef' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check the token' }));
    const domain = await screen.findByLabelText(/Domain/);
    expect(screen.queryByLabelText(/Hostname/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Name/)).toHaveValue('buddi');
    fireEvent.change(domain, { target: { value: 'sam.dev' } });
    expect(screen.getByText('Makes buddi.sam.dev.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Name/), { target: { value: 'home' } });
    fireEvent.change(screen.getByLabelText(/Your email/), { target: { value: 'owner@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set it up' }));
    await waitFor(() => expect(api.startCloudflareSetup).toHaveBeenCalledWith({ token: 'cf-token-0123456789abcdef', host: 'home.sam.dev', email: 'owner@example.com', zone: 'sam.dev' }));
  });

  it('checks a kept token at once and splits the recorded hostname into name and domain', async () => {
    vi.mocked(api.access).mockResolvedValue(ROWS);
    const record = { host: 'home.example.com', email: 'owner@example.com', zone: 'example.com', teamDomain: 'team.cloudflareaccess.com' };
    vi.mocked(api.cloudflareSetup).mockResolvedValue({ ...SETUP, tokenStored: true, record: record as never, progress: progress('removed', 0, { steps: [] }) });
    vi.mocked(api.cloudflareZones).mockResolvedValue({ zones: [{ id: 'z1', name: 'example.com' }] });
    render(<AccessSettings />);
    fireEvent.click(await screen.findByText('Cloudflare Access'));
    fireEvent.click(await screen.findByRole('button', { name: 'Set it up again' }));
    expect(await screen.findByLabelText(/Domain/)).toHaveValue('example.com');
    expect(api.cloudflareZones).toHaveBeenCalledWith({});
    expect(screen.getByLabelText(/Name/)).toHaveValue('home');
  });

  it('says to give Cloudflare a minute when it is done', async () => {
    vi.mocked(api.access).mockResolvedValue(ROWS);
    vi.mocked(api.cloudflareSetup).mockResolvedValue({ ...SETUP, progress: progress('done', 9, { url: 'https://buddi.example.com' }) });
    render(<AccessSettings />);
    fireEvent.click(await screen.findByText('Cloudflare Access'));
    expect(await screen.findByText(/sign in as owner@example\.com\. Cloudflare needs a minute or two before the first sign-in works; if its page says it can’t find the application, reload\./)).toBeInTheDocument();
  });

  it('shows a failure in its step, with Remove what buddi made and Try again', async () => {
    vi.mocked(api.access).mockResolvedValue(ROWS);
    const failed = progress('failed', 4, { error: 'The token can’t list Access policies.' });
    failed.steps[4] = { id: 'access', state: 'failed', text: 'Creating the Access application', why: 'The token can’t list Access policies. Add Account · Access: Apps and Policies · Edit to it.' };
    vi.mocked(api.cloudflareSetup).mockResolvedValue({ ...SETUP, progress: failed });
    vi.mocked(api.removeCloudflareSetup).mockResolvedValue({ ...SETUP, progress: { ...progress('removed', 0), steps: [], removed: ['the DNS record', 'the tunnel'], uninstall: 'sudo cloudflared service uninstall' } });
    render(<AccessSettings />);
    fireEvent.click(await screen.findByText('Cloudflare Access'));
    expect(await screen.findByText(/Add Account · Access: Apps and Policies · Edit/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove what buddi made' }));
    expect(await screen.findByText('Removed the DNS record and the tunnel. Signing in through Cloudflare is off.')).toBeInTheDocument();
    expect(screen.getByText('sudo cloudflared service uninstall')).toBeInTheDocument();
  });

  it('after Remove, says the API token is still kept and valid, and forgets it on asking', async () => {
    vi.mocked(api.access).mockResolvedValue(ROWS);
    const removed = { ...progress('removed', 0), steps: [], removed: ['the DNS record', 'the tunnel'], uninstall: 'sudo cloudflared service uninstall' };
    vi.mocked(api.cloudflareSetup).mockResolvedValue({ ...SETUP, tokenStored: true, progress: progress('done', 9) });
    vi.mocked(api.removeCloudflareSetup).mockResolvedValue({ ...SETUP, tokenStored: true, progress: removed });
    vi.mocked(api.forgetCloudflareToken).mockResolvedValue({ ...SETUP, tokenStored: false, progress: removed });
    render(<AccessSettings />);
    fireEvent.click(await screen.findByText('Cloudflare Access'));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove what buddi made' }));
    expect(await screen.findByText('Your Cloudflare API token is still kept here, and still valid in Cloudflare.')).toBeInTheDocument();
    expect(screen.getByText('To revoke it in Cloudflare: My Profile → API Tokens.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Forget the token' }));
    await waitFor(() => expect(api.forgetCloudflareToken).toHaveBeenCalled());
    expect(await screen.findByText(/Forgotten here\./)).toBeInTheDocument();
    expect(screen.queryByText('Your Cloudflare API token is still kept here, and still valid in Cloudflare.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Forget the token' })).not.toBeInTheDocument();
  });

  it('offers no Forget the token when nothing is kept, or the removal left something behind', async () => {
    vi.mocked(api.access).mockResolvedValue(ROWS);
    const partial = { ...progress('removed', 0), steps: [], removed: ['the DNS record'], uninstall: null, error: 'The tunnel could not be deleted.' };
    vi.mocked(api.cloudflareSetup).mockResolvedValue({ ...SETUP, tokenStored: true, progress: partial });
    render(<AccessSettings />);
    fireEvent.click(await screen.findByText('Cloudflare Access'));
    expect(await screen.findByText('The tunnel could not be deleted.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Forget the token' })).not.toBeInTheDocument();
  });

  it('offers Use it anyway when it stopped at something buddi didn’t make, and runs again with adopt', async () => {
    vi.mocked(api.access).mockResolvedValue(ROWS);
    const failed = progress('failed', 1, { error: 'There is already a tunnel named buddi-buddi.example.com in this Cloudflare account, and buddi didn’t make it.', adoptable: true });
    vi.mocked(api.cloudflareSetup).mockResolvedValue({ ...SETUP, tokenStored: true, progress: failed });
    vi.mocked(api.startCloudflareSetup).mockResolvedValue({ ...SETUP, tokenStored: true, progress: progress('running', 2) });
    render(<AccessSettings />);
    fireEvent.click(await screen.findByText('Cloudflare Access'));
    fireEvent.click(await screen.findByRole('button', { name: 'Use it anyway' }));
    await waitFor(() => expect(api.startCloudflareSetup).toHaveBeenCalledWith({ host: 'buddi.example.com', email: 'owner@example.com', adopt: true }));
  });
});
