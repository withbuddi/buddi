import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  it('offers the third mode and shows pairing only once it is chosen', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...status, mode: 'computer', session: undefined, settings });
    render(<Browser />);
    expect(screen.queryByText(/Load unpacked/)).not.toBeInTheDocument();
    // Saving the mode is what makes the page reload; from then on the host
    // answers with the new mode, which is when the pairing block appears.
    vi.mocked(api.browserSettings).mockImplementation(async (next) => {
      vi.mocked(api.browser).mockResolvedValue({ ...status, mode: 'extension', session: undefined, settings: next });
      return { ...status, mode: 'extension', session: undefined, settings: next };
    });
    fireEvent.click(await screen.findByRole('radio', { name: /Your browser/ }));
    await waitFor(() => expect(api.browserSettings).toHaveBeenCalledWith(chosen));
    expect(await screen.findByText(/Load unpacked/)).toBeInTheDocument();
    expect(await screen.findByRole('radio', { name: /Your browser/ })).toHaveAttribute('aria-checked', 'true');
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

/**
 * The dashboard noticing the extension.
 *
 * `chrome.runtime.sendMessage` to a fixed id is the only way a page can ask,
 * so the fake below is exactly what the browser would put on `globalThis`: a
 * function that answers when the extension is there and rejects when it is not.
 */
describe('finding the extension from the dashboard', () => {
  const chosen = { ...settings, mode: 'extension' as const };
  const EXTENSION_ID = 'kmbckpnnjfggeffkkbmkggojnolkdokb';
  const answers = (answer: unknown) => {
    const sendMessage = vi.fn(async (id: string, message: unknown) => {
      expect(id).toBe(EXTENSION_ID);
      expect(message).toEqual({ type: 'buddi.status' });
      if (answer instanceof Error) throw answer;
      return answer;
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    return sendMessage;
  };
  const here = () => window.location.origin;
  beforeEach(() => {
    vi.mocked(api.browser).mockResolvedValue({ ...status, mode: 'extension', session: undefined, settings: chosen });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('says the extension is missing when nothing answers', async () => {
    answers(new Error('Could not establish connection.'));
    render(<Browser />);
    expect(await screen.findByText('The buddi extension is not installed in this browser.')).toBeInTheDocument();
    expect(screen.getByText(/chrome:\/\/extensions/)).toHaveTextContent('Load unpacked');
  });

  it('says so in a browser that has no extensions at all', async () => {
    render(<Browser />);
    expect(await screen.findByText('The buddi extension is not installed in this browser.')).toBeInTheDocument();
  });

  it('names the version it found, and fills in the code it is showing', async () => {
    answers({ installed: true, version: '0.1.0', state: 'pairing', code: '482 913', gateway: here() });
    vi.mocked(api.extension).mockResolvedValue({ connected: false, pending: true, path: '/opt/buddi/extension' });
    render(<Browser />);
    expect(await screen.findByText(/Extension found, version 0\.1\.0/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Pairing code')).toHaveValue('482 913'));
    // Pair is the only thing to press: the code arrived, nothing else changed.
    const pair = screen.getByRole('button', { name: 'Pair' });
    expect(pair).toBeEnabled();
    fireEvent.click(pair);
    await waitFor(() => expect(api.pairExtension).toHaveBeenCalledWith('482 913'));
  });

  it('says when the browser it found is already paired', async () => {
    answers({ installed: true, version: '0.1.0', state: 'paired', gateway: here() });
    render(<Browser />);
    expect(await screen.findByText(/already paired/)).toBeInTheDocument();
    expect(screen.queryByText(/pointed at/)).not.toBeInTheDocument();
  });

  it('points out an extension aimed at another buddi', async () => {
    answers({ installed: true, version: '0.1.0', state: 'disconnected', gateway: 'http://127.0.0.1:4999' });
    render(<Browser />);
    expect(await screen.findByText(`The extension is pointed at http://127.0.0.1:4999; set it to ${here()} in the popup.`)).toBeInTheDocument();
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
