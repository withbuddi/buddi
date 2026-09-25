/**
 * The rail's Settings entry: a dot, and no number, when a newer buddi is ready.
 */
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { api } from '../api';
import { Rail } from './Rail';

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
