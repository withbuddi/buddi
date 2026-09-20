/**
 * Settings → Plugins: what the page actually sends when the owner says yes.
 *
 * Three payloads carry the whole safety story of this section, so they are
 * what is pinned here: the integrity the card was showing goes back with the
 * approval, `acknowledgeDrift` is sent only from the second card and never
 * from the first, and dropping a plugin's data needs its own name typed back
 * before the button is even live.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api, type PluginsView, type StagedPluginView } from '../api';
import { Plugins } from './Plugins';

vi.mock('../api', async (load) => {
  const real = await load<typeof import('../api')>();
  return {
    ...real,
    api: {
      plugins: vi.fn(),
      stagePlugin: vi.fn(),
      pluginJob: vi.fn(),
      approveStaged: vi.fn(),
      rejectStaged: vi.fn(),
      updatePlugin: vi.fn(),
      uninstallPlugin: vi.fn(),
      serviceAction: vi.fn(),
    },
  };
});

const TRUST =
  "A plugin runs inside buddi's process with everything buddi can do; it is not sandboxed, and a " +
  'plugin that wants to can bypass tool approvals and the network allowlist. Install only what you ' +
  'would run as yourself.';

const STAGED: StagedPluginView = {
  id: 'stage-1',
  name: 'weather',
  version: '2.1.0',
  source: { kind: 'registry', name: 'weather', version: '2.1.0' },
  publisher: 'someone',
  integrity: 'sha512-AAAA',
  dependencies: { count: 4, withScripts: ['node-gyp-thing'] },
  claims: { schema: 'weather', hosts: ['api.example.test'], text: 'It tells you the weather.', missing: false },
  scripts: [],
  state: 'staged',
};

function view(over: Partial<PluginsView> = {}): PluginsView {
  return {
    trust: TRUST,
    installed: [],
    staged: [],
    restartNeeded: false,
    checkout: true,
    ...over,
  };
}

const PLAN = {
  drift: ['its buddi.md claims no hosts, and its manifest declares api.example.test'],
  agents: [],
};

beforeEach(() => { vi.clearAllMocks(); });

describe('the plugins section', () => {
  it('shows the trust sentence word for word, above everything', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view());
    render(<Plugins />);
    expect(await screen.findByText(TRUST)).toBeInTheDocument();
  });

  it('sends back the integrity it showed, and acknowledges no drift on the first approval', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view({ staged: [STAGED] }));
    vi.mocked(api.approveStaged).mockResolvedValue({ plan: PLAN });
    render(<Plugins />);

    // The facts the card is asked to show are the ones the decision rests on.
    expect(await screen.findByText('sha512-AAAA')).toBeInTheDocument();
    expect(screen.getByText(/4, of which these run install scripts: node-gyp-thing/)).toBeInTheDocument();
    expect(screen.getByText('api.example.test')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(api.approveStaged).toHaveBeenCalledWith('stage-1', { integrity: 'sha512-AAAA' }));
  });

  it('only acknowledges the drift from the second card, which lists it', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view({ staged: [STAGED] }));
    vi.mocked(api.approveStaged)
      .mockResolvedValueOnce({ plan: PLAN })
      .mockResolvedValueOnce({ installed: undefined, restartNeeded: true });
    render(<Plugins />);
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));

    expect(await screen.findByText(PLAN.drift[0]!)).toBeInTheDocument();
    // The first approval is gone as a path: it cannot be the one that agrees.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Install' })).toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: 'Install anyway' }));
    await waitFor(() =>
      expect(api.approveStaged).toHaveBeenLastCalledWith('stage-1', {
        integrity: 'sha512-AAAA',
        acknowledgeDrift: true,
      }),
    );
  });

  it('throws a staged package away without approving anything', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view({ staged: [STAGED] }));
    vi.mocked(api.rejectStaged).mockResolvedValue({ rejected: 'stage-1' });
    render(<Plugins />);
    fireEvent.click(await screen.findByRole('button', { name: 'Not this one' }));
    await waitFor(() => expect(api.rejectStaged).toHaveBeenCalledWith('stage-1'));
    expect(api.approveStaged).not.toHaveBeenCalled();
  });

  it('keeps the data by default, and needs the name typed back to drop it', async () => {
    vi.mocked(api.plugins).mockResolvedValue(
      view({
        installed: [
          {
            name: 'weather',
            version: '2.1.0',
            source: { kind: 'registry', name: 'weather', version: '2.1.0' },
            publisher: 'someone',
            installedAt: new Date().toISOString(),
            contribution: { tools: 3, sentinels: 1, views: 0, agents: 1 },
            unlocks: [{ id: 'sky', handle: 'sky', drift: { state: 'not-accepted', message: 'not accepted yet' } }],
            loaded: true,
          },
        ],
      }),
    );
    vi.mocked(api.uninstallPlugin).mockResolvedValue({ name: 'weather', purged: false, notes: [], restartNeeded: true });
    render(<Plugins />);

    // The agent it would unlock, and where accepting one happens.
    expect(await screen.findByText('@sky')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Accept them on the Agents page/ })).toHaveAttribute('href', '#/agents');

    fireEvent.click(screen.getByRole('button', { name: 'Remove…' }));
    fireEvent.click(screen.getByLabelText(/Also drop its data/));
    const go = screen.getByRole('button', { name: 'Remove and drop its data' });
    expect(go).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Type weather to confirm'), { target: { value: 'weathr' } });
    expect(go).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Type weather to confirm'), { target: { value: 'weather' } });
    expect(go).toBeEnabled();
    fireEvent.click(go);
    await waitFor(() =>
      expect(api.uninstallPlugin).toHaveBeenCalledWith('weather', { purge: true, confirm: 'weather' }),
    );
  });

  it('tells a checkout the command instead of offering a restart button', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view({ restartNeeded: true, checkout: true }));
    render(<Plugins />);
    expect(await screen.findByText(/buddi serve/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart to load it' })).not.toBeInTheDocument();
  });

  it('offers the service restart on a packaged installation', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view({ restartNeeded: true, checkout: false }));
    vi.mocked(api.serviceAction).mockResolvedValue({ supervised: true });
    render(<Plugins />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart to load it' }));
    await waitFor(() => expect(api.serviceAction).toHaveBeenCalledWith('restart'));
  });
});
