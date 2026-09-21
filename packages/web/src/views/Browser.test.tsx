import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type BrowserStatus } from '../api';
import { useAsync } from '../ui';
import { Browser, BrowserPanel } from './Browser';

vi.mock('../api', () => ({ api: { browser: vi.fn(), browserControl: vi.fn(), browserSettings: vi.fn(), computerPermissions: vi.fn(), installedApps: vi.fn(), browserProfiles: vi.fn(), extension: vi.fn(), pairExtension: vi.fn(), forgetExtension: vi.fn() }, ApiError: class extends Error {} }));
const status: BrowserStatus = { state: 'running', enabled: true, busy: false, hasScreenshot: true,
  session: { id: 's1', agentId: 'concierge', conversationId: 'c1', requestId: 'r1', task: 'Book a fixture appointment', expiresAt: new Date().toISOString(), steps: 3, maxSteps: 80 },
  page: { id: 'o1', url: '/fixture', title: 'Appointment', capturedAt: new Date().toISOString(), tabs: [] } };
const settings = { mode: 'computer' as const, browserApp: 'com.google.Chrome', allowedApps: ['com.google.Chrome'] };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.browser).mockResolvedValue(status); vi.mocked(api.browserControl).mockResolvedValue(status);
  vi.mocked(api.browserProfiles).mockResolvedValue({ profiles: [{ directory: 'Default', name: 'Amen' }, { directory: 'Profile 2', name: 'Work' }] });
  vi.mocked(api.extension).mockResolvedValue({ connected: false, pending: false, path: '/opt/buddi/extension' });
  vi.mocked(api.installedApps).mockResolvedValue({ apps: [{ id: 'com.google.Chrome', name: 'Google Chrome', path: '/Applications/Google Chrome.app' }, { id: 'com.apple.TextEdit', name: 'TextEdit', path: '/System/Applications/TextEdit.app' }] });
});

/** The Canvas view, fed the way the Canvas feeds it. */
function Panel(): JSX.Element {
  const { data, error, reload } = useAsync(() => api.browser(), []);
  return <BrowserPanel data={data} error={error} reload={reload} />;
}

describe('computer & browser settings', () => {
  it('shows permissions as a checklist, requests them only on click, and switches mode with one choice', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...status, mode: 'computer', session: undefined, settings, permissions: { supported: true, accessibility: false, screenRecording: true } });
    render(<Browser />);
    expect(await screen.findByText('Accessibility')).toBeInTheDocument();
    expect(screen.getAllByText('Needed')).toHaveLength(1);
    expect(api.computerPermissions).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('radio', { name: /Give agents their own browser/ }));
    await waitFor(() => expect(api.browserSettings).toHaveBeenCalledWith({ ...settings, mode: 'playwright' }));
    fireEvent.click(screen.getByRole('button', { name: 'Request macOS permissions' }));
    await waitFor(() => expect(api.computerPermissions).toHaveBeenCalledWith(true));
  });
  it('adds an app from the installed list by name, and disables changes during a session', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...status, mode: 'computer', session: undefined, settings });
    render(<Browser />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add an app' }));
    fireEvent.change(await screen.findByLabelText('Search apps'), { target: { value: 'text' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Allow' }));
    await waitFor(() => expect(api.browserSettings).toHaveBeenCalledWith({ ...settings, allowedApps: ['com.google.Chrome', 'com.apple.TextEdit'] }));
  });
  it('lets the owner pick which Chrome profile websites open in', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...status, mode: 'computer', session: undefined, settings });
    render(<Browser />);
    const select = await screen.findByLabelText('Browser profile');
    expect(await screen.findByRole('option', { name: 'Work (Profile 2)' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'Profile 2' } });
    await waitFor(() => expect(api.browserSettings).toHaveBeenCalledWith({ ...settings, browserProfile: 'Profile 2' }));
  });
  it('says who is driving and links to that conversation, with settings locked meanwhile', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...status, mode: 'computer', settings });
    render(<Browser />);
    expect(await screen.findByText('Book a fixture appointment')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Book a fixture appointment/ })).toHaveAttribute('href', '#/chat/concierge/c1');
    expect(screen.getByRole('button', { name: 'Add an app' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Stop computer control' }));
    await waitFor(() => expect(api.browserControl).toHaveBeenCalledWith('stop'));
  });
});

describe('your own browser', () => {
  const chosen = { ...settings, mode: 'extension' as const };
  it('offers the third mode and shows nothing about pairing until it is chosen', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...status, mode: 'computer', session: undefined, settings });
    render(<Browser />);
    fireEvent.click(await screen.findByRole('radio', { name: /Your browser/ }));
    await waitFor(() => expect(api.browserSettings).toHaveBeenCalledWith(chosen));
    expect(screen.queryByText(/Load unpacked/)).not.toBeInTheDocument();
  });
  it('says it is not connected, prints the unpacked folder and the four words', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...status, mode: 'extension', session: undefined, settings: chosen });
    render(<Browser />);
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(screen.getByText(/chrome:\/\/extensions/)).toHaveTextContent('Developer mode');
    expect(screen.getByText(/chrome:\/\/extensions/)).toHaveTextContent('Load unpacked');
    expect(screen.getByText('/opt/buddi/extension')).toBeInTheDocument();
    expect(screen.queryByLabelText('Pairing code')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Forget this browser' })).toBeDisabled();
  });
  it('pairs with the code the extension is showing, and forgets a paired browser', async () => {
    const paired = new Date('2026-09-20T10:00:00Z').toISOString();
    vi.mocked(api.browser).mockResolvedValue({ ...status, mode: 'extension', session: undefined, settings: chosen });
    vi.mocked(api.extension).mockResolvedValue({ connected: false, pending: true, path: '/opt/buddi/extension', pairedAt: paired, extension: '0.1.0' });
    render(<Browser />);
    const field = await screen.findByLabelText('Pairing code');
    expect(screen.getByRole('button', { name: 'Pair' })).toBeDisabled();
    fireEvent.change(field, { target: { value: '482 913' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    await waitFor(() => expect(api.pairExtension).toHaveBeenCalledWith('482 913'));
    fireEvent.click(screen.getByRole('button', { name: 'Forget this browser' }));
    await waitFor(() => expect(api.forgetExtension).toHaveBeenCalled());
  });
});

describe('the Canvas browser view', () => {
  it('shows the task, the host observation and the controlling agent, and releases only its own session', async () => {
    render(<Panel />);
    expect(await screen.findByText('Book a fixture appointment')).toBeInTheDocument();
    expect(screen.getByText('concierge')).toBeInTheDocument();
    expect(screen.getByAltText('Last browser observation: Appointment')).toHaveAttribute('src', '/api/browser/screenshot?v=o1&sessionId=s1');
    fireEvent.click(screen.getByRole('button', { name: 'Close & release' }));
    await waitFor(() => expect(api.browserControl).toHaveBeenCalledWith('release', 's1'));
    fireEvent.click(screen.getByRole('button', { name: 'Stop all browsers' }));
    await waitFor(() => expect(api.browserControl).toHaveBeenCalledWith('stop'));
  });
  it('does not offer control when the host is unavailable', async () => {
    vi.mocked(api.browser).mockResolvedValue({ state: 'unavailable', enabled: false, busy: false, hasScreenshot: false });
    render(<Panel />);
    expect(await screen.findByText(/Start buddi serve/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop all browsers' })).toBeDisabled();
  });
  it('renders resume after an owner stop and reports control failures', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...status, state: 'stopped', session: undefined, hasScreenshot: false });
    vi.mocked(api.browserControl).mockRejectedValue(new Error('Host is restarting'));
    render(<Panel />);
    await screen.findByText('stopped');
    fireEvent.click(screen.getByRole('button', { name: 'Resume access' }));
    expect(await screen.findByText('Host is restarting')).toBeInTheDocument();
  });
});
