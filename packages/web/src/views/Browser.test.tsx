import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type BrowserStatus } from '../api';
import { Browser } from './Browser';

vi.mock('../api', () => ({ api: { browser: vi.fn(), browserControl: vi.fn(), browserSettings: vi.fn(), computerPermissions: vi.fn() }, ApiError: class extends Error {} }));
const status: BrowserStatus = { state: 'running', enabled: true, busy: false, hasScreenshot: true,
  session: { id: 's1', agentId: 'concierge', conversationId: 'c1', requestId: 'r1', task: 'Book a fixture appointment', expiresAt: new Date().toISOString(), steps: 3, maxSteps: 80 },
  page: { id: 'o1', url: '/fixture', title: 'Appointment', capturedAt: new Date().toISOString(), tabs: [] } };
beforeEach(() => { vi.mocked(api.browser).mockResolvedValue(status); vi.mocked(api.browserControl).mockResolvedValue(status); });
describe('host browser panel', () => {
  it('shows native control settings, saves explicit mode choices and requests permissions only on click', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...status, mode: 'computer', session: undefined, settings: { mode: 'computer', browserApp: 'com.google.Chrome', allowedApps: ['com.google.Chrome'] }, permissions: { supported: true, accessibility: false, screenRecording: true } });
    render(<Browser />);
    expect(await screen.findByRole('heading', { name: 'Computer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop computer control' })).toBeInTheDocument();
    expect(api.computerPermissions).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Control mode'), { target: { value: 'playwright' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save control settings' }));
    await waitFor(() => expect(api.browserSettings).toHaveBeenCalledWith({ mode: 'playwright', browserApp: 'com.google.Chrome', allowedApps: ['com.google.Chrome'] }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Request macOS permissions' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Request macOS permissions' }));
    await waitFor(() => expect(api.computerPermissions).toHaveBeenCalledWith(true));
  });
  it('uses release-without-closing wording and disables settings during a native session', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...status, mode: 'computer', settings: { mode: 'computer', browserApp: 'com.google.Chrome', allowedApps: ['com.google.Chrome'] } });
    render(<Browser />);
    await screen.findByRole('heading', { name: 'Computer' });
    expect(screen.getByLabelText('Control mode')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Release control' }));
    await waitFor(() => expect(api.browserControl).toHaveBeenCalledWith('release', 's1'));
  });
  it('selects among conversations and sends scoped release but a global Stop', async () => {
    const second = { ...status, session: { ...status.session!, id: 's2', agentId: 'other', conversationId: 'c2' }, page: { ...status.page!, id: 'o2', title: 'Other page' } };
    vi.mocked(api.browser).mockResolvedValue({ ...second, sessions: [status, second] });
    render(<Browser />);
    await screen.findByAltText('Last browser observation: Other page');
    fireEvent.click(screen.getByRole('button', { name: /concierge · c1/ }));
    expect(screen.getByAltText('Last browser observation: Appointment')).toHaveAttribute('src', '/api/browser/screenshot?v=o1&sessionId=s1');
    fireEvent.click(screen.getByRole('button', { name: 'Close & release' }));
    await waitFor(() => expect(api.browserControl).toHaveBeenCalledWith('release', 's1'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Stop all browsers' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Stop all browsers' }));
    await waitFor(() => expect(api.browserControl).toHaveBeenCalledWith('stop'));
  });
  it('shows the actual task, host observation and controlling agent', async () => {
    render(<Browser />);
    expect(await screen.findByText('Book a fixture appointment')).toBeInTheDocument();
    expect(screen.getByText('concierge')).toBeInTheDocument();
    expect(screen.getByAltText('Last browser observation: Appointment')).toHaveAttribute('src', '/api/browser/screenshot?v=o1&sessionId=s1');
  });
  it('Stop calls only the authenticated control endpoint', async () => {
    render(<Browser />);
    await screen.findByText('concierge');
    fireEvent.click(screen.getByRole('button', { name: 'Stop all browsers' }));
    await waitFor(() => expect(api.browserControl).toHaveBeenCalledWith('stop'));
  });
  it('does not offer control when the host is unavailable', async () => {
    vi.mocked(api.browser).mockResolvedValue({ state: 'unavailable', enabled: false, busy: false, hasScreenshot: false });
    render(<Browser />);
    expect(await screen.findByText(/Start buddi serve/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop all browsers' })).toBeDisabled();
  });
  it('renders resume after an owner stop and reports control failures', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...status, state: 'stopped', session: undefined, hasScreenshot: false });
    vi.mocked(api.browserControl).mockRejectedValue(new Error('Host is restarting'));
    render(<Browser />);
    await screen.findByText('stopped');
    fireEvent.click(screen.getByRole('button', { name: 'Resume access' }));
    expect(await screen.findByText('Host is restarting')).toBeInTheDocument();
  });
});
