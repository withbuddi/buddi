/**
 * The rail's Settings entry: a dot, and no number, when a newer buddi is ready.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, render, screen } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { api } from '../api';
import { CONNECTION_DOT, Rail, focusUntilLabel } from './Rail';
import { buildDiffers } from '../build';
import { resetInstallPrompt } from '../views/parts/KeepClose';

vi.mock('../api', async (load) => {
  const real = await load<typeof import('../api')>();
  return {
    ...real,
    api: { ...real.api, owner: vi.fn(async () => ({})), focus: vi.fn(async () => ({ focus: null })), setFocus: vi.fn(async () => ({ focus: null })) },
  };
});

function rail(updateAvailable?: boolean): void {
  render(
    <Tooltip.Provider>
      <Rail attention={0} place="#/" onNavigate={vi.fn()} theme="system" onTheme={vi.fn()} updateAvailable={updateAvailable} />
    </Tooltip.Provider>,
  );
}

describe('the Settings entry', () => {
  it('carries a dot when a newer buddi is ready', () => {
    rail(true);
    const settings = screen.getByRole('link', { name: 'Settings, a newer buddi is ready' });
    const dot = screen.getByTestId('rail-dot');
    expect(settings).toContainElement(dot);
    expect(dot).toHaveAttribute('data-kind', 'dot');
    expect(dot).toHaveClass('ui-badge');
    expect(dot).toBeEmptyDOMElement();
    expect(api.owner).toHaveBeenCalled();
  });

  it('carries the same dot when a connection needs the owner', () => {
    render(
      <Tooltip.Provider>
        <Rail attention={0} place="#/" onNavigate={vi.fn()} theme="system" onTheme={vi.fn()} settingsDot={CONNECTION_DOT} />
      </Tooltip.Provider>,
    );
    expect(screen.getByRole('link', { name: 'Settings, a connection needs you' })).toContainElement(screen.getByTestId('rail-dot'));
  });

  it('carries nothing otherwise', () => {
    rail();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.queryByTestId('rail-dot')).not.toBeInTheDocument();
  });
});

// Radix menus under jsdom are slow on a busy CI runner: no typing delay, no
// pointer-events check, and room for the slowest press.
describe('the owner menu', { timeout: 180_000 }, () => {
  it('names the running version, and the newer one when there is one', async () => {
    const { userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(
      <Tooltip.Provider>
        <Rail attention={0} place="#/" onNavigate={vi.fn()} theme="system" onTheme={vi.fn()} updateAvailable version={{ current: '0.1.0-pre.17', latest: '0.1.0-pre.18', updateAvailable: true }} />
      </Tooltip.Provider>,
    );
    await user.click(screen.getByRole('button', { name: 'You' }));
    expect(await screen.findByText('buddi 0.1.0-pre.17')).toBeInTheDocument();
    expect(screen.getByText('A newer buddi is ready: 0.1.0-pre.18')).toBeInTheDocument();
  });
});

describe('Reload in the owner menu', { timeout: 180_000 }, () => {
  function displayMode(standalone: boolean): void {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(display-mode: standalone)' ? standalone : false,
      media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
  }

  async function openMenu(props: { stale?: boolean; reload?: () => void } = {}): Promise<void> {
    const { userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(
      <Tooltip.Provider>
        <Rail attention={0} place="#/" onNavigate={vi.fn()} theme="system" onTheme={vi.fn()} {...props} />
      </Tooltip.Provider>,
    );
    await user.click(screen.getByRole('button', { name: props.stale ? 'You, reload to update' : 'You' }));
    await screen.findByText('Change appearance');
  }

  afterEach(() => { vi.unstubAllGlobals(); });

  it('is not there in a browser tab', async () => {
    displayMode(false);
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: /Reload/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId('owner-dot')).not.toBeInTheDocument();
  });

  it('is there in an installed app, and reloads the page', async () => {
    displayMode(true);
    const reload = vi.fn();
    await openMenu({ reload });
    const item = screen.getByRole('menuitem', { name: /^Reload/ });
    expect(item).not.toHaveAttribute('data-update');
    const { userEvent } = await import('@testing-library/user-event');
    await userEvent.setup({ delay: null, pointerEventsCheck: 0 }).click(item);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('is there inside buddi.app, whose window has no reload of its own', async () => {
    displayMode(false);
    vi.stubGlobal('navigator', { ...navigator, userAgent: `${navigator.userAgent} buddi-mac/0.1.0` });
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /^Reload/ })).toBeInTheDocument();
  });

  it('reads Reload to update, in any mode, when the served build is newer', async () => {
    displayMode(false);
    const reload = vi.fn();
    await openMenu({ stale: true, reload });
    expect(screen.getByTestId('owner-dot')).toBeInTheDocument();
    const item = screen.getByRole('menuitem', { name: /Reload to update/ });
    expect(item).toHaveAttribute('data-update', 'true');
    const { userEvent } = await import('@testing-library/user-event');
    await userEvent.setup({ delay: null, pointerEventsCheck: 0 }).click(item);
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe('Install the app in the owner menu', { timeout: 180_000 }, () => {
  function offerInstall(prompt = vi.fn(async () => undefined)): typeof prompt {
    const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & { prompt: typeof prompt; userChoice: Promise<{ outcome: string }> };
    event.prompt = prompt;
    event.userChoice = Promise.resolve({ outcome: 'dismissed' });
    act(() => { window.dispatchEvent(event); });
    return prompt;
  }
  function displayMode(standalone: boolean): void {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(display-mode: standalone)' ? standalone : false,
      media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
  }
  async function openMenu(): Promise<import('@testing-library/user-event').UserEvent> {
    const { userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    render(
      <Tooltip.Provider>
        <Rail attention={0} place="#/" onNavigate={vi.fn()} theme="system" onTheme={vi.fn()} />
      </Tooltip.Provider>,
    );
    await user.click(screen.getByRole('button', { name: 'You' }));
    await screen.findByText('Change appearance');
    return user;
  }
  afterEach(() => { resetInstallPrompt(); vi.unstubAllGlobals(); });

  it('is not there until the browser offers an install', async () => {
    displayMode(false);
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Install the app' })).not.toBeInTheDocument();
  });

  it('is there once it does, and hands the prompt over', async () => {
    displayMode(false);
    const prompt = offerInstall();
    const user = await openMenu();
    await user.click(screen.getByRole('menuitem', { name: 'Install the app' }));
    expect(prompt).toHaveBeenCalledOnce();
  });

  it('is not there inside the installed app', async () => {
    displayMode(true);
    offerInstall();
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Install the app' })).not.toBeInTheDocument();
  });
});

describe('buildDiffers', () => {
  it('is true only when both builds are known and differ', () => {
    expect(buildDiffers('0.1.0+b', '0.1.0+a')).toBe(true);
    expect(buildDiffers('0.1.0+a', '0.1.0+a')).toBe(false);
    expect(buildDiffers(undefined, '0.1.0+a')).toBe(false);
    expect(buildDiffers('0.1.0+b', undefined)).toBe(false);
  });
});

describe('Focus in the owner menu', { timeout: 180_000 }, () => {
  it('switches a mode for a duration, and shows the moon while one is on', { timeout: 180_000 }, async () => {
    const { userEvent } = await import('@testing-library/user-event');
    const { act, fireEvent, within } = await import('@testing-library/react');
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const until = new Date(Date.now() + 3_600_000).toISOString();
    vi.mocked(api.focus).mockResolvedValueOnce({ focus: null });
    vi.mocked(api.setFocus).mockResolvedValueOnce({ focus: { mode: 'do-not-disturb', until, startedAt: new Date().toISOString(), by: 'dashboard' } });
    await act(async () => {
      render(
        <Tooltip.Provider>
          <Rail attention={0} place="#/" onNavigate={vi.fn()} theme="system" onTheme={vi.fn()} timezone="UTC" />
        </Tooltip.Provider>,
      );
    });
    expect(screen.queryByTestId('owner-focus')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'You' }));
    await user.click(await screen.findByRole('menuitem', { name: /Focus/ }));
    expect(await screen.findByText('No focus is on.')).toBeInTheDocument();
    vi.mocked(api.focus).mockResolvedValue({ focus: { mode: 'do-not-disturb', until, startedAt: new Date().toISOString(), by: 'dashboard' } });
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Do not disturb for 1 hour' })); });
    expect(api.setFocus).toHaveBeenCalledWith('do-not-disturb', '1h');
    expect(await screen.findByTestId('owner-focus')).toBeInTheDocument();
    const owner = screen.getByRole('button', { name: /^You, Do not disturb until/ });
    expect(within(owner).getByTestId('owner-focus')).toBeInTheDocument();

    // Open again: the state with its end, and Turn off.
    await user.click(owner);
    await user.click(await screen.findByRole('menuitem', { name: /Focus/ }));
    expect(await screen.findByText(/^Do not disturb until .*\.$/)).toBeInTheDocument();
    vi.mocked(api.setFocus).mockResolvedValueOnce({ focus: null });
    vi.mocked(api.focus).mockResolvedValue({ focus: null });
    await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: 'Turn off' })); });
    expect(api.setFocus).toHaveBeenLastCalledWith('normal', undefined);
  });

  it('says when a focus ends in words', () => {
    const now = new Date('2026-09-15T10:00:00.000Z');
    expect(focusUntilLabel({ mode: 'urgent-only', until: null, startedAt: null, by: 'telegram' }, 'UTC', now)).toBe('until you turn it off');
    expect(focusUntilLabel({ mode: 'urgent-only', until: '2026-09-15T13:30:00.000Z', startedAt: null, by: 'dashboard' }, 'UTC', now)).toBe('until 13:30');
    expect(focusUntilLabel({ mode: 'do-not-disturb', until: '2026-09-16T08:00:00.000Z', startedAt: null, by: 'dashboard' }, 'UTC', now)).toBe('until Wed 08:00');
  });
});
