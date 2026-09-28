/**
 * The rail's Settings entry: a dot, and no number, when a newer buddi is ready.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { api } from '../api';
import { CONNECTION_DOT, Rail } from './Rail';
import { buildDiffers } from '../build';

vi.mock('../api', async (load) => {
  const real = await load<typeof import('../api')>();
  return { ...real, api: { ...real.api, owner: vi.fn(async () => ({})) } };
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

describe('the owner menu', () => {
  it('names the running version, and the newer one when there is one', async () => {
    const { userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
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

describe('Reload in the owner menu', () => {
  function displayMode(standalone: boolean): void {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(display-mode: standalone)' ? standalone : false,
      media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }));
  }

  async function openMenu(props: { stale?: boolean; reload?: () => void } = {}): Promise<void> {
    const { userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
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
    await userEvent.setup().click(item);
    expect(reload).toHaveBeenCalledOnce();
  });

  it('reads Reload to update, in any mode, when the served build is newer', async () => {
    displayMode(false);
    const reload = vi.fn();
    await openMenu({ stale: true, reload });
    expect(screen.getByTestId('owner-dot')).toBeInTheDocument();
    const item = screen.getByRole('menuitem', { name: /Reload to update/ });
    expect(item).toHaveAttribute('data-update', 'true');
    const { userEvent } = await import('@testing-library/user-event');
    await userEvent.setup().click(item);
    expect(reload).toHaveBeenCalledOnce();
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
