import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, type BrowserRouteStatus, type BrowserStatus } from '../api';
import { pluginSettingsRoute } from '../routes';
import { appsProvided, appWord, Browser, chromeState, clearWarning, downloadsLine, installTarget, lookingLine, olderExtension, otherBuddis, othersWords, pairWithCode, SANDBOX_COMMAND, SELF_PAIRED_WINDOW_MS, STORE_URL } from './Browser';

vi.mock('../api', () => ({ api: { session: vi.fn(), browser: vi.fn(), browserControl: vi.fn(), browserSettings: vi.fn(), browserPin: vi.fn(), browserCheck: vi.fn(), browserInstall: vi.fn(), browserDownloads: vi.fn(), clearBrowserDownloads: vi.fn(), fileBrowserDownload: vi.fn(), extension: vi.fn(), pairExtension: vi.fn(), forgetExtension: vi.fn(), agents: vi.fn(), setAgentEngine: vi.fn() }, ApiError: class extends Error {} }));

const settings = { version: 2 as const, yourChrome: true, yourApps: 'on' as const, signInSites: [] as string[], defaultRoute: 'auto' as const, stopExpiryMinutes: 60, maxOwnPages: 3, showWindow: false };
const routes = (over: Partial<Record<'own' | 'chrome' | 'apps', Partial<BrowserRouteStatus> | null>> = {}): BrowserRouteStatus[] => [
  { kind: 'own', allowed: true, available: true, provider: 'core', ...over.own },
  { kind: 'chrome', allowed: true, available: true, provider: 'core', paired: true, connected: true, ...over.chrome },
  ...(over.apps === null ? [] : [{ kind: 'apps' as const, allowed: true, available: true, provider: 'computer', installed: true, label: 'Computer', mode: 'on' as const, ...over.apps }]),
];
const base: BrowserStatus = { state: 'idle', enabled: true, busy: false, hasScreenshot: false, settings, routes: routes(), browser: { engine: 'chromium', headless: true } };
const paired = { connected: true, pending: false, path: '/opt/buddi/extension', pairedAt: '2026-09-21T09:00:00Z', extension: '0.1.4' };
const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const FIREFOX_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const useAgent = (ua: string) => vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue(ua);
const answers = (answer: unknown) => {
  const sendMessage = vi.fn(async () => { if (answer instanceof Error) throw answer; return answer; });
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
  return sendMessage;
};
const row = async (title: string) => (await screen.findByText(title, { selector: '.ui-list-title' })).closest('.ui-list-row') as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  useAgent(CHROME_MAC);
  vi.mocked(api.session).mockResolvedValue({ csrf: 'c', timezone: 'UTC', host: '127.0.0.1', port: 1, platform: 'darwin' });
  vi.mocked(api.browser).mockResolvedValue(base);
  vi.mocked(api.browserDownloads).mockResolvedValue({ bytes: 0, files: 0, agents: [], fileCap: 50 * 1024 * 1024, agentCap: 500 * 1024 * 1024, retentionDays: 30 });
  vi.mocked(api.browserSettings).mockResolvedValue(base);
  vi.mocked(api.browserControl).mockResolvedValue(base);
  vi.mocked(api.extension).mockResolvedValue(paired);
  vi.mocked(api.agents).mockResolvedValue({ agents: [], engines: [], providers: [] } as never);
  vi.mocked(api.setAgentEngine).mockResolvedValue({ agent: {} as never, changed: ['browser'], note: '' });
  answers({ installed: true, version: '0.1.4', state: 'paired', gateway: window.location.origin });
});
afterEach(() => vi.unstubAllGlobals());

describe('Where agents may look: one row per route, no radio buttons', () => {
  it('draws the three rows ready, with the kit’s words, and no mode radios or apps list on the page', async () => {
    render(<Browser />);
    expect(await screen.findByText(/Agents pick where to look for each task/)).toBeInTheDocument();
    const own = await row('buddi’s own browser');
    expect(within(own).getByText('For every page, out of sight. You watch it on the Canvas.')).toBeInTheDocument();
    expect(within(own).getByText('ready')).toBeInTheDocument();
    expect(within(own).queryByRole('switch')).not.toBeInTheDocument();
    const chrome = await row('Your Chrome');
    expect(await within(chrome).findByText('connected')).toBeInTheDocument();
    expect(within(chrome).getByText('Used only for sites that need your sign-in · background tabs in a buddi group')).toBeInTheDocument();
    expect(await within(chrome).findByRole('switch', { name: 'Let agents use your Chrome' })).toBeChecked();
    const apps = await row('Your apps');
    expect(within(apps).getByText('From the Computer plugin · when you name an app')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Control mode' })).not.toBeInTheDocument();
    expect(screen.queryByText('Apps agents may use')).not.toBeInTheDocument();
  });
  it('turns your Chrome and your apps on and off as switches', async () => {
    render(<Browser />);
    fireEvent.click(await within(await row('Your Chrome')).findByRole('switch', { name: 'Let agents use your Chrome' }));
    await waitFor(() => expect(api.browserSettings).toHaveBeenCalledWith({ yourChrome: false }));
    fireEvent.click(await within(await row('Your apps')).findByRole('switch', { name: 'Let agents use your apps' }));
    await waitFor(() => expect(api.browserSettings).toHaveBeenCalledWith({ yourApps: 'off' }));
  });
  it('says Chrome off in the kit’s words, and Chrome closed when paired but not running', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...base, settings: { ...settings, yourChrome: false } });
    const { unmount } = render(<Browser />);
    expect(await screen.findByText('Off. Sites that need a sign-in use your saved logins, or ask you.')).toBeInTheDocument();
    unmount();
    vi.mocked(api.browser).mockResolvedValue(base);
    vi.mocked(api.extension).mockResolvedValue({ ...paired, connected: false });
    render(<Browser />);
    expect(await screen.findByText('Chrome closed')).toBeInTheDocument();
    expect(screen.getByText(/Chrome isn’t open on this Mac; agents wait or use their own browser/)).toBeInTheDocument();
  });
  it('offers to pair again when buddi moved port since the pairing', async () => {
    vi.mocked(api.extension).mockResolvedValue({ ...paired, connected: false, portMoved: { from: 4317, to: 4391 } });
    vi.mocked(api.forgetExtension).mockResolvedValue({ ok: true } as never);
    render(<Browser />);
    const chrome = await row('Your Chrome');
    expect(await within(chrome).findByText(/Port 4317 was taken by another program, so buddi now listens on 4391\. .*http:\/\/127\.0\.0\.1:4391/)).toBeInTheDocument();
    fireEvent.click(within(chrome).getByRole('button', { name: 'Pair again' }));
    await waitFor(() => expect(api.forgetExtension).toHaveBeenCalled());
  });
  it('lists the sign-in sites under your Chrome', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...base, settings: { ...settings, signInSites: ['amazon.com', 'chase.com'] } });
    render(<Browser />);
    expect(await screen.findByText('Always for amazon.com and chase.com')).toBeInTheDocument();
  });
  it('shows a Stop that holds as a warning with Resume', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...base, stop: { at: '2026-10-03T10:12:00Z', until: '2026-10-03T11:12:00Z' } });
    render(<Browser timezone="UTC" />);
    expect(await screen.findByText(/Agents’ browsing is paused since .*by you from the Canvas, until .*An agent that needs a page asks you in its chat\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(api.browserControl).toHaveBeenCalledWith('resume'));
  });
  it('says who is looking now and links to that conversation’s Canvas', async () => {
    const session = { id: 's1', agentId: 'concierge', conversationId: 'c1', requestId: 'r1', task: 'Check the cart', expiresAt: new Date().toISOString(), steps: 3, maxSteps: 200 };
    vi.mocked(api.browser).mockResolvedValue({ ...base, state: 'running', session, route: 'chrome', page: { id: 'p', url: 'https://www.amazon.com/cart', title: 'Your cart', capturedAt: '', tabs: [] } });
    render(<Browser />);
    const link = (await screen.findByText('Your cart')).closest('a')!;
    expect(link).toHaveAttribute('href', expect.stringContaining('c1'));
    expect(within(link).getByText('Looking at amazon.com · in your Chrome · background tab')).toBeInTheDocument();
  });
});

describe('buddi’s own browser: health and its one fix', () => {
  it('missing: says so and installs on click', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...base, browser: { engine: 'none', headless: true } });
    render(<Browser />);
    expect(await screen.findByText('Chromium isn’t installed, so agents can’t look at pages yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Install · 150 MB' }));
    await waitFor(() => expect(api.browserInstall).toHaveBeenCalledOnce());
  });
  it('installing: a spinner and the percent, no button', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...base, browser: { engine: 'none', headless: true, install: { state: 'running', progress: { phase: 'downloading', percent: 61, what: 'Chromium', download: 1 } } } });
    render(<Browser />);
    expect(await screen.findByText('Installing Chromium… 61%')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Install/ })).not.toBeInTheDocument();
  });
  it('sandbox: the one Linux command to copy, and Check again', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...base, browser: { engine: 'chromium', headless: true, problem: 'no-sandbox' } });
    vi.mocked(api.browserCheck).mockResolvedValue({ ok: true });
    render(<Browser />);
    expect(await screen.findByText(SANDBOX_COMMAND)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(api.browserCheck).toHaveBeenCalledOnce());
  });
});

describe('your Chrome: Add to Chrome, the code, Pair again', () => {
  it('none: Add to Chrome opens the store in a new tab', async () => {
    vi.mocked(api.extension).mockResolvedValue({ connected: false, pending: false, path: '/opt/buddi/extension' });
    answers(new Error('Could not establish connection.'));
    render(<Browser />);
    const add = await screen.findByRole('link', { name: /Add to Chrome/ });
    expect(add).toHaveAttribute('href', STORE_URL);
    expect(add).toHaveAttribute('target', '_blank');
    expect(screen.getByText(/Add the buddi extension to Chrome, then pair it here/)).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Let agents use your Chrome' })).not.toBeInTheDocument();
  });
  it('none, in Firefox or on a phone: no install button, and says where it runs', async () => {
    vi.mocked(api.extension).mockResolvedValue({ connected: false, pending: false, path: '/opt/buddi/extension' });
    answers(new Error('none'));
    useAgent(FIREFOX_MAC);
    render(<Browser />);
    expect(await screen.findByText(/runs in Chrome, Edge, Brave or Arc on a computer/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Add to Chrome/ })).not.toBeInTheDocument();
  });
  it('none: the app window offers the six digits inline, with nothing waiting yet', async () => {
    vi.mocked(api.extension).mockResolvedValue({ connected: false, pending: false, path: '/opt/buddi/extension' });
    answers(new Error('none'));
    vi.mocked(api.pairExtension).mockResolvedValue(paired);
    render(<Browser />);
    await screen.findByText(/Add the buddi extension to Chrome, then pair it here/);
    expect(screen.getByText('Enter the code · Open the buddi icon in Chrome; type its code here')).toBeInTheDocument();
    const input = screen.getByRole('textbox', { name: 'Pairing code' });
    expect(screen.getByRole('button', { name: 'Pair' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '482913' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    await waitFor(() => expect(api.pairExtension).toHaveBeenCalledWith('482913'));
  });
  it('a buddi:// link pre-fills the code; the owner still presses Pair', async () => {
    vi.mocked(api.extension).mockResolvedValue({ connected: false, pending: true, path: '/x' });
    answers(new Error('none'));
    vi.mocked(api.pairExtension).mockResolvedValue(paired);
    window.location.hash = '#/settings/computer?code=482913';
    try {
      render(<Browser />);
      await screen.findByText('Type the six digits the extension shows.');
      expect(screen.getByRole('textbox', { name: 'Pairing code' })).toHaveValue('482913');
      expect(api.pairExtension).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
      await waitFor(() => expect(api.pairExtension).toHaveBeenCalledWith('482913'));
    } finally { window.location.hash = ''; }
  });
  it('a linked code leaves the address once Pair worked, so a reload does not type it in again', async () => {
    vi.mocked(api.extension).mockResolvedValue({ connected: false, pending: true, path: '/x' });
    answers(new Error('none'));
    vi.mocked(api.pairExtension).mockResolvedValue(paired);
    window.history.replaceState(null, '', '/?from=extension#/settings/computer?code=482913&x=1');
    try {
      render(<Browser />);
      await screen.findByText('Type the six digits the extension shows.');
      expect(window.location.hash).toBe('#/settings/computer?code=482913&x=1');
      fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
      await waitFor(() => expect(window.location.hash).toBe('#/settings/computer?x=1'));
      expect(window.location.search).toBe('?from=extension');
    } finally { window.history.replaceState(null, '', '/'); }
  });
  it('a failed Pair keeps the linked code in the address', async () => {
    vi.mocked(api.extension).mockResolvedValue({ connected: false, pending: true, path: '/x' });
    answers(new Error('none'));
    vi.mocked(api.pairExtension).mockRejectedValue(Object.assign(new Error('No browser is waiting to be paired'), { status: 409 }));
    window.location.hash = '#/settings/computer?code=482913';
    try {
      render(<Browser />);
      await screen.findByText('Type the six digits the extension shows.');
      fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
      expect(await screen.findByText(/No browser is waiting to be paired/)).toBeInTheDocument();
      expect(window.location.hash).toBe('#/settings/computer?code=482913');
    } finally { window.location.hash = ''; }
  });
  it('unpaired, extension found but not connected: the field is there too', async () => {
    vi.mocked(api.extension).mockResolvedValue({ connected: false, pending: false, path: '/x' });
    answers({ installed: true, version: '0.1.4', state: 'disconnected', gateway: window.location.origin });
    render(<Browser />);
    expect(await screen.findByText('Enter the code · Open the buddi icon in Chrome; type its code here')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Pairing code' })).toBeInTheDocument();
  });
  it('offers Install unpacked only when buddi runs from a checkout', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    vi.mocked(api.extension).mockResolvedValue({ ...paired, checkout: false });
    const { unmount } = render(<Browser />);
    await user.click(await within(await row('Your Chrome')).findByRole('button', { name: 'More for your Chrome' }));
    expect(await screen.findByRole('menuitem', { name: /Forget this Chrome/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Install unpacked/ })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    unmount();
    vi.mocked(api.extension).mockResolvedValue({ ...paired, checkout: true });
    render(<Browser />);
    await user.click(await within(await row('Your Chrome')).findByRole('button', { name: 'More for your Chrome' }));
    expect(await screen.findByRole('menuitem', { name: /Install unpacked/ })).toBeInTheDocument();
  }, 60_000);
  it('pair: reads the code the extension shows in this browser and pairs by itself', async () => {
    vi.mocked(api.extension).mockResolvedValue({ connected: false, pending: true, path: '/x' });
    answers({ installed: true, version: '0.1.4', state: 'pairing', code: '482913', gateway: window.location.origin });
    vi.mocked(api.pairExtension).mockResolvedValue(paired);
    render(<Browser />);
    expect(await screen.findByText('Extension 0.1.4 found in Chrome')).toBeInTheDocument();
    expect(await screen.findByLabelText('Pairing code')).toHaveTextContent('482 · 913');
    await waitFor(() => expect(api.pairExtension).toHaveBeenCalledWith('482913'));
    expect(api.pairExtension).toHaveBeenCalledOnce();
  });
  it('pair: from another browser the six digits are typed once', async () => {
    vi.mocked(api.extension).mockResolvedValue({ connected: false, pending: true, path: '/x' });
    answers(new Error('none'));
    vi.mocked(api.pairExtension).mockResolvedValue(paired);
    render(<Browser />);
    await screen.findByText('Type the six digits the extension shows.');
    const input = screen.getByRole('textbox', { name: 'Pairing code' });
    fireEvent.change(input, { target: { value: '123 456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair' }));
    await waitFor(() => expect(api.pairExtension).toHaveBeenCalledWith('123 456'));
  });
  it('broken: Chrome forgot the pairing, Pair again starts over', async () => {
    vi.mocked(api.extension).mockResolvedValue({ ...paired, connected: false });
    answers({ installed: true, version: '0.1.4', state: 'disconnected', gateway: window.location.origin });
    vi.mocked(api.forgetExtension).mockResolvedValue({ connected: false, pending: false, path: '/x' });
    render(<Browser />);
    expect(await screen.findByText('Chrome forgot the pairing, so agents use their own browser instead.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pair again' }));
    await waitFor(() => expect(api.forgetExtension).toHaveBeenCalledOnce());
  });
  it('asks for an update only below the minimum the gateway declares, and points out another buddi', async () => {
    vi.mocked(api.extension).mockResolvedValue({ ...paired, extensionMinimum: '0.1.0.24' });
    answers({ installed: true, version: '0.1.0.20', state: 'paired', gateway: 'http://127.0.0.1:4317' });
    render(<Browser />);
    expect(await screen.findByText(/This extension is 0\.1\.0\.20; this buddi needs 0\.1\.0\.24 or later/)).toBeInTheDocument();
    expect(screen.getByText(/The extension is pointed at http:\/\/127\.0\.0\.1:4317/)).toBeInTheDocument();
  });
  it('one extension for several buddis: says this buddi and how many others, and never asks to re-point it', async () => {
    answers({ installed: true, version: '0.1.0.49', state: 'paired', gateway: window.location.origin, pairings: [
      { origin: window.location.origin, name: 'buddi-dev', state: 'paired', enabled: true },
      { origin: 'http://127.0.0.1:4317', name: 'buddi', state: 'paired', enabled: true },
    ] });
    render(<Browser />);
    expect(await screen.findByText(/paired with this buddi and 1 other/)).toBeInTheDocument();
    expect(screen.queryByText(/The extension is pointed at/)).toBeNull();
  });
  it('one extension for several buddis: this buddi switched off in its popup reads as off, not as forgotten', async () => {
    vi.mocked(api.extension).mockResolvedValue({ ...paired, connected: false });
    answers({ installed: true, version: '0.1.0.49', state: 'disconnected', gateway: window.location.origin, pairings: [
      { origin: window.location.origin, name: 'buddi-dev', state: 'disconnected', enabled: false },
    ] });
    render(<Browser />);
    expect(await screen.findByText(/Switched off for this buddi in the buddi extension/)).toBeInTheDocument();
    expect(screen.queryByText(/Chrome forgot the pairing/)).toBeNull();
  });
  it('counts the other buddis an extension works for', () => {
    const here = window.location.origin;
    expect(otherBuddis(null)).toBe(0);
    expect(otherBuddis({ installed: true, version: '1', state: 'paired', gateway: here })).toBe(0);
    expect(otherBuddis({ installed: true, version: '1', state: 'paired', gateway: here, pairings: [{ origin: here, name: 'a', state: 'paired' }, { origin: 'http://127.0.0.1:1', name: 'b', state: 'paired' }, { origin: 'http://127.0.0.1:2', name: 'c', state: 'disconnected' }] })).toBe(2);
    expect(othersWords(0)).toBeNull();
    expect(othersWords(1)).toBe('paired with this buddi and 1 other');
    expect(othersWords(2)).toBe('paired with this buddi and 2 others');
    // An extension that knows several, with no pairing for this buddi, is a pairing Chrome forgot.
    expect(chromeState({ connected: false, pending: false, path: '', pairedAt: 'x' }, { installed: true, version: '1', state: 'disconnected', gateway: 'http://127.0.0.1:1', pairings: [{ origin: 'http://127.0.0.1:1', name: 'b', state: 'paired' }] })).toBe('broken');
  });
  it('forgets this Chrome only after a second word', async () => {
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    vi.mocked(api.forgetExtension).mockResolvedValue({ connected: false, pending: false, path: '/x' });
    render(<Browser />);
    await user.click(await within(await row('Your Chrome')).findByRole('button', { name: 'More for your Chrome' }));
    await user.click(await screen.findByRole('menuitem', { name: /Forget this Chrome/ }));
    expect(api.forgetExtension).not.toHaveBeenCalled();
    await user.click(await screen.findByRole('button', { name: 'Forget' }));
    await waitFor(() => expect(api.forgetExtension).toHaveBeenCalledOnce());
  }, 60_000);
});

describe('your apps: only with the Computer plugin', () => {
  it('broken: the macOS fix on the row sends to the plugin’s page, no switch', async () => {
    const navigate = vi.fn();
    vi.mocked(api.browser).mockResolvedValue({ ...base, routes: routes({ apps: { available: false, message: 'macOS hasn’t allowed Screen Recording, so agents can’t see app windows.', repair: 'permissions' } }) });
    render(<Browser navigate={navigate} />);
    const apps = await row('Your apps');
    expect(within(apps).getByText('macOS hasn’t allowed Screen Recording, so agents can’t see app windows.')).toBeInTheDocument();
    expect(within(apps).queryByRole('switch')).not.toBeInTheDocument();
    fireEvent.click(within(apps).getByRole('button', { name: 'Allow in macOS' }));
    expect(navigate).toHaveBeenCalledWith(pluginSettingsRoute('computer'));
  });
  it('without the plugin: no apps row, one line offering it on a Mac, nothing elsewhere', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...base, routes: routes({ apps: { installed: false } }) });
    const { unmount } = render(<Browser />);
    expect(await screen.findByTestId('computer-plugin-offer')).toHaveTextContent('Agents can also work in apps on this Mac with the Computer plugin.');
    expect(screen.queryByText('Your apps')).not.toBeInTheDocument();
    unmount();
    vi.mocked(api.session).mockResolvedValue({ csrf: 'c', timezone: 'UTC', host: '127.0.0.1', port: 1, platform: 'linux' });
    render(<Browser />);
    await row('Your Chrome');
    expect(screen.queryByTestId('computer-plugin-offer')).not.toBeInTheDocument();
  });
  it('Settings opens the plugin’s own page', async () => {
    const navigate = vi.fn();
    render(<Browser navigate={navigate} />);
    fireEvent.click(await within(await row('Your apps')).findByRole('button', { name: 'Manage apps' }));
    expect(navigate).toHaveBeenCalledWith(pluginSettingsRoute('computer'));
  });
  it('reads a provider only from the plugin', () => {
    expect(appsProvided({ kind: 'apps', allowed: true, available: true, provider: 'computer', installed: true })).toBe(true);
    expect(appsProvided({ kind: 'apps', allowed: true, available: true, provider: 'core', installed: false })).toBe(false);
    expect(appsProvided(undefined)).toBe(false);
  });
});

describe('Advanced', () => {
  const open = async () => { fireEvent.click(await screen.findByText('Advanced')); };
  it('sets the first choice, the Stop’s length, the pages at once and the window', async () => {
    render(<Browser />);
    await open();
    fireEvent.click(screen.getByRole('radio', { name: 'Own browser only' }));
    await waitFor(() => expect(api.browserSettings).toHaveBeenCalledWith({ defaultRoute: 'own' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Until I say' }));
    await waitFor(() => expect(api.browserSettings).toHaveBeenCalledWith({ stopExpiryMinutes: 0 }));
    fireEvent.click(screen.getByRole('radio', { name: '5' }));
    await waitFor(() => expect(api.browserSettings).toHaveBeenCalledWith({ maxOwnPages: 5 }));
    fireEvent.click(screen.getByRole('switch', { name: 'Show buddi’s browser as a window' }));
    await waitFor(() => expect(api.browserSettings).toHaveBeenCalledWith({ showWindow: true }));
    expect(screen.getByText(/Missions run without you, so they look only in buddi’s own browser/)).toBeInTheDocument();
  });
  it('lists the agents with their own rule, changes and removes one, and gives another its rule', async () => {
    vi.mocked(api.agents).mockResolvedValue({ agents: [], providers: [], engines: [
      { id: 'ledger', name: 'Ledger', browser: 'own' }, { id: 'home', name: 'Home Manager', browser: 'chrome' }, { id: 'scout', name: 'Scout', browser: 'auto' },
    ] } as never);
    render(<Browser />);
    await open();
    const select = await screen.findByRole('combobox', { name: 'Where Ledger may look' });
    expect(select).toHaveValue('own');
    fireEvent.change(select, { target: { value: 'chrome' } });
    await waitFor(() => expect(api.setAgentEngine).toHaveBeenCalledWith('ledger', { browser: 'chrome' }));
    fireEvent.click(within(screen.getByText('Home Manager').closest('.ui-list-row') as HTMLElement).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.setAgentEngine).toHaveBeenCalledWith('home', { browser: 'auto' }));
    fireEvent.click(screen.getByRole('button', { name: /Give an agent its own rule/ }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Agent' }), { target: { value: 'scout' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add this rule' }));
    await waitFor(() => expect(api.setAgentEngine).toHaveBeenCalledWith('scout', { browser: 'own' }));
  });
  it('says when no agent has its own rule', async () => {
    render(<Browser />);
    await open();
    expect(await screen.findByText('No agent has its own rule. Every agent follows the first choice.')).toBeInTheDocument();
  });
  it('adds and removes a site that needs the owner’s sign-in', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...base, settings: { ...settings, signInSites: ['chase.com'] } });
    render(<Browser />);
    await open();
    fireEvent.change(screen.getByRole('textbox', { name: 'A site that needs your sign-in' }), { target: { value: 'https://www.Amazon.com/cart' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(api.browserSettings).toHaveBeenCalledWith({ signInSites: ['chase.com', 'amazon.com'] }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove chase.com' }));
    await waitFor(() => expect(api.browserSettings).toHaveBeenCalledWith({ forgetSignInSite: 'chase.com' }));
  });
  it('lists the sites buddi learned beside the owner’s, marked, and removes one from both', async () => {
    vi.mocked(api.browser).mockResolvedValue({ ...base, settings: { ...settings, signInSites: ['chase.com'] }, learnedSignInSites: ['amazon.com'] });
    render(<Browser />);
    expect(await screen.findByText('Always for chase.com and amazon.com')).toBeInTheDocument();
    await open();
    const learned = screen.getByText('amazon.com', { selector: '.br-site-chip' });
    expect(learned).toHaveAttribute('data-learned', 'true');
    expect(screen.getByText('chase.com', { selector: '.br-site-chip' })).not.toHaveAttribute('data-learned');
    fireEvent.click(screen.getByRole('button', { name: 'Remove amazon.com' }));
    await waitFor(() => expect(api.browserSettings).toHaveBeenCalledWith({ forgetSignInSite: 'amazon.com' }));
  });
});

describe('the words', () => {
  it('tells desktop Chromium browsers from the rest and from phones', () => {
    expect(installTarget({ userAgent: CHROME_MAC })).toBe('chromium');
    expect(installTarget({ userAgent: FIREFOX_MAC })).toBe('other');
    expect(installTarget({ userAgent: IPHONE })).toBe('phone');
  });
  it('compares Chrome versions part by part', () => {
    expect(olderExtension('0.1.0.20', '0.1.0.24')).toBe(true);
    expect(olderExtension('0.1.1', '0.1.0.24')).toBe(false);
    expect(olderExtension('dev', '0.1.0.24')).toBe(false);
  });
  it('reads the Chrome state from the gateway and the extension in this browser', () => {
    expect(chromeState(undefined, null)).toBe('none');
    expect(chromeState({ connected: false, pending: true, path: '' }, null)).toBe('pair');
    expect(chromeState({ connected: true, pending: false, path: '', pairedAt: 'x' }, null)).toBe('connected');
    expect(chromeState({ connected: false, pending: false, path: '', pairedAt: 'x' }, null)).toBe('notrunning');
    expect(chromeState({ connected: false, pending: false, path: '', pairedAt: 'x' }, { installed: true, version: '1', state: 'disconnected', gateway: window.location.origin })).toBe('broken');
  });
  it('says where a page is looked at in one quiet line', () => {
    const page = { id: 'p', url: 'https://www.amazon.com/cart', title: 'Cart', capturedAt: '', tabs: [] };
    expect(lookingLine({ ...base, page })).toBe('Looking at amazon.com · in buddi’s browser');
    expect(lookingLine({ ...base, page, route: 'chrome' })).toBe('Looking at amazon.com · in your Chrome · background tab');
    expect(lookingLine({ ...base, page: { ...page, appId: 'com.apple.iWork.Numbers' }, route: 'apps' })).toBe('Working in Numbers · its own window');
    expect(lookingLine({ ...base, page, needsOwner: { kind: 'sign-in', question: 'x', options: [] } })).toBe('Waiting for you · it asks for your sign-in');
    expect(appWord('com.google.Chrome')).toBe('Chrome');
  });
});

describe('pairWithCode: a typed code racing the page\'s own pairing', () => {
  const conflict = () => Object.assign(new Error('This buddi is already paired'), { status: 409 });
  const NOW = Date.parse('2026-10-04T12:00:00Z');
  it('swallows a 409 when the extension was paired within the last ten seconds', async () => {
    const extension = vi.fn(async () => ({ pairedAt: new Date(NOW - 4_000).toISOString() }));
    await expect(pairWithCode('482913', { pair: async () => { throw conflict(); }, extension, now: () => NOW })).resolves.toBeUndefined();
    expect(extension).toHaveBeenCalledOnce();
    expect(SELF_PAIRED_WINDOW_MS).toBe(10_000);
  });
  it('keeps the 409 when the pairing is older, absent, or unreadable', async () => {
    for (const extension of [
      async () => ({ pairedAt: new Date(NOW - 60_000).toISOString() }),
      async () => ({}),
      async () => { throw new Error('offline'); },
    ]) {
      await expect(pairWithCode('482913', { pair: async () => { throw conflict(); }, extension, now: () => NOW })).rejects.toThrow('already paired');
    }
  });
  it('never looks again for any other failure', async () => {
    const extension = vi.fn(async () => ({ pairedAt: new Date(NOW).toISOString() }));
    await expect(pairWithCode('482913', { pair: async () => { throw Object.assign(new Error('Wrong code'), { status: 400 }); }, extension, now: () => NOW })).rejects.toThrow('Wrong code');
    expect(extension).not.toHaveBeenCalled();
  });
});

describe('Downloads: what agents downloaded, and Clear', () => {
  const held = { bytes: 36_000, files: 2, agents: [{ agent: 'cfo', bytes: 36_000, files: 2 }], fileCap: 50 * 1024 * 1024, agentCap: 500 * 1024 * 1024, retentionDays: 30 };
  it('says what the area holds and its rules in one line', () => {
    expect(downloadsLine(held)).toBe('2 files waiting · 35 KB · kept 30 days, at most 50.0 MB a file');
    expect(downloadsLine({ ...held, files: 0, bytes: 0 })).toBe('Nothing waiting · kept 30 days, at most 50.0 MB a file');
  });
  const waiting = [
    { id: 'cfo/2026-10-05/april.csv', agent: 'cfo', day: '2026-10-05', name: 'april.csv', size: 18_000, mime: 'text/csv' },
    { id: 'cfo/2026-10-04/march.csv', agent: 'cfo', day: '2026-10-04', name: 'march.csv', size: 18_000, mime: 'text/csv' },
  ];
  it('lists what waits with its agent and day, and files one into Files', async () => {
    vi.mocked(api.agents).mockResolvedValue({ agents: [{ id: 'cfo', name: 'CFO' }], engines: [], providers: [] } as never);
    vi.mocked(api.browserDownloads).mockResolvedValue({ ...held, waiting });
    vi.mocked(api.fileBrowserDownload).mockResolvedValue({ ...held, files: 1, waiting: waiting.slice(1), filed: { artifactId: 'a1', name: 'april.csv' } });
    render(<Browser />);
    const rows = await screen.findAllByTestId('download-waiting');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('april.csv')).toBeInTheDocument();
    expect(await within(rows[0]!).findByText('CFO · 5 October · 18 KB · not in Files yet')).toBeInTheDocument();
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'File it' }));
    await waitFor(() => expect(api.fileBrowserDownload).toHaveBeenCalledWith('cfo/2026-10-05/april.csv'));
  });
  it('asks before Clear, with the count and that these copies are not in Files, and explains the Chrome permission', async () => {
    vi.mocked(api.browserDownloads).mockResolvedValue({ ...held, waiting });
    vi.mocked(api.clearBrowserDownloads).mockResolvedValue({ ...held, files: 0, bytes: 0, agents: [], waiting: [] });
    render(<Browser />);
    const line = await screen.findByTestId('downloads-row');
    expect(await within(line).findByText(/2 files waiting · 35 KB/)).toBeInTheDocument();
    expect(within(line).getByText(/Allow downloads/)).toBeInTheDocument();
    fireEvent.click(within(line).getByRole('button', { name: 'Clear' }));
    // Nothing goes on the first press: a confirmation says how many and that Files has no copy.
    expect(api.clearBrowserDownloads).not.toHaveBeenCalled();
    expect(await screen.findByText('Clear 2 downloads?')).toBeInTheDocument();
    expect(screen.getByText(clearWarning(2))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep them' }));
    expect(api.clearBrowserDownloads).not.toHaveBeenCalled();
    fireEvent.click(within(line).getByRole('button', { name: 'Clear' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear 2' }));
    await waitFor(() => expect(api.clearBrowserDownloads).toHaveBeenCalled());
    expect(clearWarning(2)).toBe('These 2 files are not in Files: they are the only copies. Clearing deletes them for good. File the ones you want first.');
    expect(clearWarning(1)).toBe('This file is not in Files: it is the only copy. Clearing deletes it for good. File it first.');
  });
});
