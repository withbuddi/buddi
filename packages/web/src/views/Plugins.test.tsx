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
import userEvent from '@testing-library/user-event';
import { api, type InstalledPluginView, type MarketEntryView, type PluginsView, type StagedPluginView } from '../api';
import { PAGES_CHANGED_EVENT } from '../pages/usePages';
import { pluginPageRoute, pluginSettingsRoute } from '../routes';
import { Plugins } from './Plugins';

vi.mock('../api', async (load) => {
  const real = await load<typeof import('../api')>();
  return {
    ...real,
    api: {
      plugins: vi.fn(),
      market: vi.fn(),
      stagePlugin: vi.fn(),
      pluginJob: vi.fn(),
      approveStaged: vi.fn(),
      rejectStaged: vi.fn(),
      updatePlugin: vi.fn(),
      uninstallPlugin: vi.fn(),
      setPluginEnabled: vi.fn(),
      pluginFolders: vi.fn(),
      marketAssetUrl: (url: string) => `/api/market/asset?url=${encodeURIComponent(url)}`,
      uploadPlugin: vi.fn(),
      serviceAction: vi.fn(),
      acceptPluginAgent: vi.fn(),
      approval: vi.fn(),
      decide: vi.fn(),
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
  stagedHash: 'sha256-beef',
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

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
});

const JOB = { id: 'job-1', kind: 'stage' as const, phase: 'fetching' as const, startedAt: new Date().toISOString() };

const INSTALLED: InstalledPluginView = {
  name: 'garden',
  version: '1.0.0',
  source: { kind: 'registry', name: 'buddi-plugin-garden', version: '1.0.0' },
  publisher: 'someone',
  installedAt: new Date().toISOString(),
  contribution: { tools: 1, sentinels: 0, views: 0, agents: 0 },
  unlocks: [],
  loaded: true,
};

/** A row's ⋯ menu, opened from the keyboard, and one of its items chosen. */
async function openMenuItem(plugin: string, item: string): Promise<void> {
  // Radix opens its menu on a pointer press, which user-event makes and
  // fireEvent does not. No typing delay and no pointer-events check: with the
  // defaults the press took 5–14 s under jsdom, and CI timed out on it.
  await userEvent.setup({ delay: null, pointerEventsCheck: 0 }).click(await screen.findByLabelText(`More for ${plugin}`));
  fireEvent.click(await screen.findByRole('menuitem', { name: new RegExp(`^${item}`) }));
}

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

  /**
   * A directory source has no integrity at all, and the card says so.
   *
   * The empty string still has to be sent: the route asks for the hash it
   * showed, and a page that dropped the field because it was falsy got a 400
   * telling it to send back a hash that never existed. That is the developer
   * path, so it was the one path nobody clicked.
   */
  it('approves a directory source, whose integrity is nothing at all', async () => {
    const directory: StagedPluginView = {
      ...STAGED,
      integrity: '',
      stagedHash: '',
      source: { kind: 'directory', path: '/home/o/code/weather' },
    };
    vi.mocked(api.plugins).mockResolvedValue(view({ staged: [directory] }));
    vi.mocked(api.approveStaged).mockResolvedValue({ installed: { name: 'weather', version: '2.1.0' }, restartNeeded: true });
    render(<Plugins />);

    expect(await screen.findByText('none — this came off a disk')).toBeInTheDocument();
    expect(screen.getByText(/a directory on this machine/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(api.approveStaged).toHaveBeenCalledWith('stage-1', { integrity: '' }));
  });

  it('lists what it reaches in buddi, one line each, and marks what an update adds', async () => {
    const update: StagedPluginView = {
      ...STAGED,
      previous: { name: 'weather', version: '2.0.0' },
      uses: {
        areas: [
          { use: 'http', words: 'sends web requests', added: false },
          { use: 'files:library', words: 'reads every file in your Files library', added: true },
        ],
        dropped: [{ use: 'schedule', words: 'starts agent runs by itself' }],
      },
    };
    vi.mocked(api.plugins).mockResolvedValue(view({ staged: [update] }));
    render(<Plugins />);
    expect(await screen.findByText('What it reaches')).toBeInTheDocument();
    expect(screen.getByText(/It sends web requests\./)).toBeInTheDocument();
    expect(screen.getByText(/It reads every file in your Files library\./)).toBeInTheDocument();
    expect(screen.getByText('new in 2.1.0')).toBeInTheDocument();
    expect(screen.getByText('No longer: starts agent runs by itself.')).toBeInTheDocument();
  });

  it('says a package that declares no areas reaches nothing beyond itself', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view({ staged: [STAGED] }));
    render(<Plugins />);
    expect(await screen.findByText(/Nothing beyond its own tables/)).toBeInTheDocument();
  });

  it('shows the hash of the files on disk beside the tarball\'s', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view({ staged: [STAGED] }));
    render(<Plugins />);
    expect(await screen.findByText('sha256-beef')).toBeInTheDocument();
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

    // The row says there is an agent waiting, and opens the detail.
    expect(await screen.findByText('1 agent to accept')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('weather: details'));

    // The agent it would unlock, and the two places accepting one happens.
    expect(await screen.findByText('@sky')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /on the Agents page/ })).toHaveAttribute('href', '#/agents');

    fireEvent.click(screen.getByRole('button', { name: 'Remove…' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Remove weather?' });
    expect(dialog).toHaveTextContent('Its tables and the agents you accepted from it stay.');
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
    // Done: the dialog and the sheet are gone.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('removes without dropping anything unless asked, and offers to disable instead', { timeout: 180_000 }, async () => {
    vi.mocked(api.plugins).mockResolvedValue(view({ installed: [{ ...INSTALLED, name: 'garden' }] }));
    vi.mocked(api.uninstallPlugin).mockResolvedValue({ name: 'garden', purged: false, notes: ['Removed. Its tables stay.'], restartNeeded: true });
    render(<Plugins />);
    await openMenuItem('garden', 'Remove…');
    expect(await screen.findByRole('alertdialog', { name: 'Remove garden?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Disable instead' }));
    expect(await screen.findByRole('alertdialog', { name: 'Disable garden?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

    await openMenuItem('garden', 'Remove…');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.uninstallPlugin).toHaveBeenCalledWith('garden', {}));
    expect(await screen.findByText('Removed. Its tables stay.')).toBeInTheDocument();
  });

  /**
   * The button that finishes what "1 agent proposed" starts.
   *
   * The owner's click is the approval: the route records the gated action and
   * decides it in the same request, so the page gets the agent back and says
   * it is ready, with no second card to find.
   */
  it('accepts a proposed agent in one click and says it is ready', async () => {
    vi.mocked(api.plugins).mockResolvedValue(
      view({
        installed: [
          {
            name: 'garden',
            version: '1.2.0',
            source: { kind: 'registry', name: 'garden', version: '1.2.0' },
            publisher: 'someone',
            installedAt: new Date().toISOString(),
            contribution: { tools: 2, sentinels: 0, views: 0, agents: 1 },
            unlocks: [{ id: 'gardener', handle: 'gardener', drift: { state: 'not-accepted', message: 'not accepted yet' } }],
            loaded: true,
          },
        ],
      }),
    );
    vi.mocked(api.acceptPluginAgent).mockResolvedValue({
      approvalId: 'action-1',
      agent: { id: 'gardener', handle: 'gardener', name: 'Gardener' },
    });

    render(<Plugins />);
    fireEvent.click(await screen.findByLabelText('garden: details'));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(api.acceptPluginAgent).toHaveBeenCalledWith('garden', 'gardener'));

    expect(await screen.findByText(/@gardener is ready/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Talk to @gardener' })).toHaveAttribute('href', '#/chat/gardener');
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.getByText('up to date')).toBeInTheDocument();
    expect(api.approval).not.toHaveBeenCalled();
  });

  /**
   * npm is the only source with a publisher to name. Code that came off this
   * machine was put there by the owner, and the line says that instead of
   * reporting npm's silence about something npm never had.
   */
  it('names the owner, not npm, as the publisher of local code', async () => {
    const base = {
      name: 'weather',
      version: '2.1.0',
      publisher: undefined,
      installedAt: new Date().toISOString(),
      contribution: { tools: 1, sentinels: 0, views: 0, agents: 0 },
      unlocks: [],
      loaded: true,
    };
    vi.mocked(api.plugins).mockResolvedValue(
      view({
        installed: [
          { ...base, source: { kind: 'directory', path: '/home/o/code/weather' } },
          { ...base, name: 'packed', source: { kind: 'tarball', path: '/home/o/packed.tgz' } },
          { ...base, name: 'from-npm', publisher: 'someone', source: { kind: 'registry', name: 'from-npm', version: '2.1.0' } },
        ],
      }),
    );
    render(<Plugins />);

    // The rows say it in two words each.
    expect(await screen.findByText('by you · from a directory · 1 tool')).toBeInTheDocument();
    expect(screen.getByText('by you · from a file · 1 tool')).toBeInTheDocument();
    expect(screen.getByText('by someone · from npm · 1 tool')).toBeInTheDocument();

    const detail = async (name: string, fact: string): Promise<void> => {
      fireEvent.click(screen.getByLabelText(`${name}: details`));
      expect(await screen.findByText(fact)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    };
    await detail('weather', 'you, from this machine');
    await detail('packed', 'a file on this machine');
    await detail('from-npm', 'someone');
    expect(screen.queryByText('nobody npm will name')).not.toBeInTheDocument();
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
  /**
   * The three ways in are three different questions, and the page asks the
   * one the owner chose: a package name, or a path on this machine.
   */
  it('asks a different question per mode, and stages what that mode means', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view());
    vi.mocked(api.stagePlugin).mockResolvedValue({ job: JOB });
    vi.mocked(api.pluginJob).mockResolvedValue({ ...JOB, phase: 'reading' });
    render(<Plugins />);

    expect(await screen.findByPlaceholderText('buddi-plugin-weather')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'A directory I built' }));
    const field = screen.getByPlaceholderText('/home/you/code/buddi-plugin-weather');
    expect(screen.queryByPlaceholderText('buddi-plugin-weather')).not.toBeInTheDocument();

    fireEvent.change(field, { target: { value: '/home/you/code/weather' } });
    fireEvent.click(screen.getByRole('button', { name: 'Read it first' }));
    await waitFor(() => expect(api.stagePlugin).toHaveBeenCalledWith('/home/you/code/weather'));

    // A file is not typed, so that mode has no button of its own at all.
    fireEvent.click(screen.getByRole('radio', { name: 'A file' }));
    expect(screen.queryByRole('button', { name: 'Read it first' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose a file' })).toBeInTheDocument();
  });

  it('uploads a dropped .tgz, bytes and name, and follows the job', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view());
    vi.mocked(api.uploadPlugin).mockResolvedValue({ job: JOB });
    vi.mocked(api.pluginJob).mockResolvedValue({ ...JOB, phase: 'reading' });
    render(<Plugins />);

    fireEvent.click(await screen.findByRole('radio', { name: 'A file' }));
    const file = new File(['packed bytes'], 'buddi-plugin-weather-2.1.0.tgz');
    fireEvent.drop(screen.getByRole('group', { name: 'A plugin file' }), {
      dataTransfer: { files: [file] },
    });

    await waitFor(() => expect(api.uploadPlugin).toHaveBeenCalledTimes(1));
    const sent = vi.mocked(api.uploadPlugin).mock.calls[0]![0];
    // The file itself goes on the wire, bytes and name: nothing is read or
    // re-wrapped in the page, which is what keeps a large one out of memory.
    expect(sent).toBe(file);
    expect(sent.name).toBe('buddi-plugin-weather-2.1.0.tgz');
    expect(sent.size).toBe('packed bytes'.length);
    // The zone says what it is holding, and the stage is being watched.
    expect(await screen.findByText(/buddi-plugin-weather-2.1.0.tgz/)).toBeInTheDocument();
    await waitFor(() => expect(api.pluginJob).toHaveBeenCalledWith('job-1'));
  });

  it('refuses anything that is not a .tgz without sending it anywhere', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view());
    render(<Plugins />);

    fireEvent.click(await screen.findByRole('radio', { name: 'A file' }));
    fireEvent.drop(screen.getByRole('group', { name: 'A plugin file' }), {
      dataTransfer: { files: [new File(['zipped'], 'weather.zip')] },
    });

    expect(await screen.findByText(/weather.zip is not a .tgz/)).toBeInTheDocument();
    expect(api.uploadPlugin).not.toHaveBeenCalled();
    expect(api.stagePlugin).not.toHaveBeenCalled();
  });

  it('names what buddi already ships with, folded, and what each of them adds', async () => {
    vi.mocked(api.plugins).mockResolvedValue(
      view({
        builtIn: [
          {
            name: 'memory',
            version: '1.0.0',
            contribution: { tools: 4, sentinels: 1, views: 0, agents: 0 },
            description: 'What buddi remembers about you.',
          },
          { name: 'mail', version: '1.0.0', contribution: { tools: 1, sentinels: 0, views: 0, agents: 0 } },
          {
            name: 'mcp',
            version: '0.1.0',
            contribution: { tools: 0, sentinels: 0, views: 0, agents: 0 },
            author: { name: 'Grace', url: 'https://grace.dev' },
            network: [{ host: 'mcp.notion.com', why: 'Notion, a connected service' }, { host: 'mcp.linear.app', why: 'Linear' }],
          },
        ],
      }),
    );
    render(<Plugins />);

    const fold = await screen.findByText('Ships with buddi · 3 plugins');
    expect(fold.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('memory').closest('.plugins-builtin')).toHaveTextContent('memory4 tools');
    expect(screen.getByText('mail').closest('.plugins-builtin')).toHaveTextContent('mail1 tool');
    // What each does, who made it and the hosts it talks to (what leaves the machine) are its tooltip.
    expect(screen.getByText('memory').closest('.plugins-builtin')).toHaveAttribute('title', 'What buddi remembers about you.');
    expect(screen.getByText('mcp').closest('.plugins-builtin')).toHaveAttribute(
      'title',
      'By Grace. Talks to mcp.notion.com, mcp.linear.app.',
    );
  });

  it('says who made it, on the staged card, on an installed row and in its detail, linked when there is a URL', async () => {
    vi.mocked(api.plugins).mockResolvedValue(
      view({
        staged: [{ ...STAGED, author: { name: 'withbuddi', url: 'https://withbuddi.com' } }],
        installed: [
          {
            name: 'finance',
            version: '0.1.0',
            source: { kind: 'registry', name: '@withbuddi/plugin-finance', version: '0.1.0' },
            author: { name: 'Ada', url: 'https://ada.dev' },
            description: 'Your money, in one place.',
            installedAt: new Date().toISOString(),
            contribution: { tools: 1, sentinels: 0, views: 0, agents: 0 },
            unlocks: [],
            loaded: true,
          },
        ],
      }),
    );
    render(<Plugins />);

    const staged = await screen.findByRole('link', { name: 'withbuddi' });
    expect(staged).toHaveAttribute('href', 'https://withbuddi.com');
    expect(screen.getByText('by Ada · from npm · 1 tool')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('finance: details'));
    expect(await screen.findByRole('link', { name: 'Ada' })).toHaveAttribute('href', 'https://ada.dev');
    // Not listed on withbuddi.com (Browse was never opened): its own description.
    expect(screen.getByText('Your money, in one place.')).toBeInTheDocument();
  });

  it('disables a plugin after asking, in a dialog that says it keeps everything, and enables one in one click', { timeout: 180_000 }, async () => {
    const base = {
      version: '0.1.0',
      source: { kind: 'directory' as const, path: '/home/o/code/garden' },
      installedAt: new Date().toISOString(),
      contribution: { tools: 1, sentinels: 0, views: 0, agents: 0 },
      unlocks: [],
    };
    vi.mocked(api.plugins).mockResolvedValue(
      view({
        installed: [
          { ...base, name: 'garden', loaded: true, author: { name: 'Ada', url: 'https://ada.dev' } },
          { ...base, name: 'cellar', loaded: false, enabled: false },
        ],
      }),
    );
    vi.mocked(api.setPluginEnabled).mockResolvedValue({
      name: 'garden', enabled: false, changed: true, missions: [],
      notes: ['Disabled. Its tools, pages and watchers are off now; its data is kept.'], restartNeeded: false,
    });
    const pagesChanged = vi.fn();
    window.addEventListener(PAGES_CHANGED_EVENT, pagesChanged);
    render(<Plugins />);

    // The disabled one is not a failure, and its row is dimmed.
    expect(await screen.findByText('disabled')).toBeInTheDocument();
    expect(screen.queryByText('did not load')).not.toBeInTheDocument();
    expect(screen.getByLabelText('cellar: details')).toHaveAttribute('data-dimmed', 'true');
    expect(screen.getByLabelText('garden: details')).not.toHaveAttribute('data-dimmed');

    // A local build with an author says who made it instead of "you, from this machine".
    fireEvent.click(screen.getByLabelText('garden: details'));
    expect(await screen.findByRole('link', { name: 'Ada' })).toHaveAttribute('href', 'https://ada.dev');
    expect(screen.queryByText('you, from this machine')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Disable…' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Disable garden?' });
    expect(dialog).toHaveTextContent('Its tools, pages and watchers stop now and its missions pause.');
    expect(dialog).toHaveTextContent('Its data and the agents you accepted from it are kept');
    fireEvent.click(screen.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(api.setPluginEnabled).toHaveBeenCalledWith('garden', false));
    // It takes effect at once: the sheet says so, the rail reads its pages again, and nothing asks for a restart.
    expect(await screen.findByText('Disabled. Its tools, pages and watchers are off now; its data is kept.')).toBeInTheDocument();
    expect(pagesChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/since buddi started/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    vi.mocked(api.setPluginEnabled).mockResolvedValue({
      name: 'cellar', enabled: true, changed: true, missions: [], notes: ['Enabled.'], restartNeeded: false,
    });
    await openMenuItem('cellar', 'Enable');
    await waitFor(() => expect(api.setPluginEnabled).toHaveBeenCalledWith('cellar', true));
    expect(await screen.findByText('Enabled.')).toBeInTheDocument();
    expect(pagesChanged).toHaveBeenCalledTimes(2);
    window.removeEventListener(PAGES_CHANGED_EVENT, pagesChanged);
  });

  it('opens a plugin\'s page from its row without opening the detail', async () => {
    const navigate = vi.fn();
    vi.mocked(api.plugins).mockResolvedValue(view({ installed: [{ ...INSTALLED, name: 'weather' }] }));
    render(
      <Plugins
        navigate={navigate}
        railPages={[{ plugin: 'weather', id: 'today', title: 'Weather' } as never]}
      />,
    );
    fireEvent.click(await screen.findByRole('link', { name: 'Open Weather' }));
    expect(navigate).toHaveBeenCalledWith(pluginPageRoute('weather', 'today'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('offers Settings on the row of a plugin with a settings tab and no page, and goes there', async () => {
    const navigate = vi.fn();
    vi.mocked(api.plugins).mockResolvedValue(view({ installed: [{ ...INSTALLED, name: 'speech' }] }));
    render(
      <Plugins
        navigate={navigate}
        settingsPages={[{ plugin: 'speech', id: 'settings', title: 'Speech' } as never]}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Settings' }));
    expect(navigate).toHaveBeenCalledWith(pluginSettingsRoute('speech', 'settings'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('browses the folders on the gateway\'s machine and fills the field with the one chosen', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view());
    vi.mocked(api.pluginFolders).mockImplementation(async (path?: string) =>
      path === '/home/o/code'
        ? {
            path: '/home/o/code',
            parent: '/home/o',
            home: '/home/o',
            folders: [{ name: 'buddi-plugin-garden', path: '/home/o/code/buddi-plugin-garden', plugin: true }],
          }
        : {
            path: '/home/o',
            parent: null,
            home: '/home/o',
            folders: [
              { name: 'code', path: '/home/o/code', plugin: false },
              { name: 'Documents', path: '/home/o/Documents', plugin: false },
            ],
          },
    );
    render(<Plugins />);
    fireEvent.click(await screen.findByRole('radio', { name: 'A directory I built' }));
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));

    // It starts at home, and the search narrows what is listed.
    expect(await screen.findByText('Documents')).toBeInTheDocument();
    expect(api.pluginFolders).toHaveBeenCalledWith(undefined);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Find a folder here' }), { target: { value: 'cod' } });
    expect(screen.queryByText('Documents')).toBeNull();

    fireEvent.click(screen.getByLabelText('Open code'));
    expect(await screen.findByText('buddi-plugin-garden')).toBeInTheDocument();
    expect(screen.getByText('package.json')).toBeInTheDocument();
    // The trail back up.
    expect(screen.getByRole('button', { name: 'Home' })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Open buddi-plugin-garden'));
    await waitFor(() => expect(api.pluginFolders).toHaveBeenCalledWith('/home/o/code/buddi-plugin-garden'));
  });

  it('uses the folder it is showing', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view());
    vi.mocked(api.pluginFolders).mockResolvedValue({ path: '/home/o/code/garden', parent: '/home/o/code', home: '/home/o', folders: [] });
    vi.mocked(api.stagePlugin).mockResolvedValue({ job: JOB });
    vi.mocked(api.pluginJob).mockResolvedValue(JOB);
    render(<Plugins />);
    fireEvent.click(await screen.findByRole('radio', { name: 'A directory I built' }));
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
    expect(await screen.findByText('No folders in here.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByPlaceholderText('/home/you/code/buddi-plugin-weather')).toHaveValue('/home/o/code/garden');
    fireEvent.click(screen.getByRole('button', { name: 'Read it first' }));
    await waitFor(() => expect(api.stagePlugin).toHaveBeenCalledWith('/home/o/code/garden'));
  });
});

/**
 * Browse: the list from withbuddi.com, asked for only when the tab opens.
 * Its Install stages the listed version; the card and the approvals are the
 * ones above, unchanged.
 */
describe('browsing the market', () => {
  const listing = (over: Partial<MarketEntryView>): MarketEntryView => ({
    name: 'weather',
    npm: '@withbuddi/plugin-weather',
    version: '0.1.0',
    title: 'Weather',
    summary: 'The weather for the places you save.',
    category: 'days',
    trust: 'by-buddi',
    pricing: { kind: 'free' },
    author: { name: 'withbuddi' },
    claims: { manifest: { network: [{ host: 'api.open-meteo.com' }] } },
    usesWords: [{ use: 'http', words: 'sends web requests' }],
    ...over,
  });
  const WEATHER = listing({});
  const FINANCE = listing({
    name: 'finance',
    npm: '@withbuddi/plugin-finance',
    version: '1.2.0',
    title: 'Finance',
    summary: 'Your accounts and what you owe.',
    category: 'money',
    installed: { version: '1.0.0', name: 'finance' },
    update: '1.2.0',
  });
  const GARDEN = listing({
    name: 'garden',
    npm: 'buddi-plugin-garden',
    title: 'Garden',
    summary: 'When to water.',
    category: 'home',
    trust: 'reviewed',
    reviewed: { version: '0.1.0' },
    pricing: { kind: 'subscription', trialDays: 14, vendor: 'https://garden.example' },
  });
  const INSTALLED_FINANCE: InstalledPluginView = {
    name: 'finance',
    version: '1.0.0',
    source: { kind: 'registry', name: '@withbuddi/plugin-finance', version: '1.0.0' },
    installedAt: new Date().toISOString(),
    contribution: { tools: 3, sentinels: 0, views: 0, agents: 0 },
    unlocks: [],
    loaded: true,
  };

  const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="9" cy="9" r="3.5"></circle></svg>';

  it('asks withbuddi.com only when Browse opens, and shows every listing as one grid', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view());
    vi.mocked(api.market).mockResolvedValue({ fetchedAt: new Date().toISOString(), plugins: [WEATHER, FINANCE, GARDEN] });
    render(<Plugins />);
    await screen.findByText(TRUST);
    expect(api.market).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('link', { name: 'Browse' }));
    expect(await screen.findByText('Opening this tab fetched the list from withbuddi.com. Nothing else leaves.')).toBeInTheDocument();
    await screen.findByText('Garden');
    expect(api.market).toHaveBeenCalledTimes(1);
    expect(api.market).toHaveBeenCalledWith(false);
    // The shelves are chips, and only the categories that have a listing.
    const chips = screen.getByRole('group', { name: 'Show' });
    expect([...chips.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      'All',
      'Recommended',
      'Your days',
      'Money',
      'Home',
    ]);
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    // Each listing once, with how it is trusted and what is installed.
    expect(screen.getAllByText('Weather')).toHaveLength(1);
    expect(screen.getByText('installed 1.0.0')).toBeInTheDocument();
    expect(screen.getByText('reviewed 0.1.0')).toBeInTheDocument();
    expect(screen.getAllByText('by buddi')).toHaveLength(2);
  });

  it('narrows the grid by shelf: Recommended is what buddi publishes that you do not have', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view({ installed: [INSTALLED_FINANCE] }));
    vi.mocked(api.market).mockResolvedValue({ plugins: [WEATHER, FINANCE, GARDEN] });
    render(<Plugins hash="#/settings/plugins?tab=browse" />);
    await screen.findByText('Garden');
    fireEvent.click(screen.getByRole('button', { name: 'Recommended' }));
    expect(screen.getByText('Weather')).toBeInTheDocument();
    expect(screen.queryByText('Finance')).toBeNull();
    expect(screen.queryByText('Garden')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Money' }));
    expect(screen.getByText('Finance')).toBeInTheDocument();
    expect(screen.queryByText('Weather')).toBeNull();
  });

  it('opens a listing in the sheet: its screenshot through buddi, what it reaches, its licence and price', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view());
    vi.mocked(api.market).mockResolvedValue({
      plugins: [
        {
          ...GARDEN,
          iconSvg: ICON,
          license: 'MIT',
          screenshots: ['https://withbuddi.com/plugins/garden/shots/week.webp'],
          claims: {
            package: { dependencies: { count: 3, withScripts: [] } },
            manifest: {
              network: [{ host: 'api.garden.example' }],
              tools: [{ name: 'garden.list', tier: 'auto' }, { name: 'garden.water', tier: 'gated' }],
              sentinels: [{}],
            },
          },
        },
      ],
    });
    vi.mocked(api.stagePlugin).mockResolvedValue({ job: JOB });
    vi.mocked(api.pluginJob).mockResolvedValue(JOB);
    render(<Plugins hash="#/settings/plugins?tab=browse" />);
    fireEvent.click(await screen.findByLabelText('Garden: details'));

    const sheet = await screen.findByRole('dialog');
    const shot = sheet.querySelector('img');
    // The page never fetches withbuddi.com itself: the gateway proxies the picture.
    expect(shot).toHaveAttribute('src', '/api/market/asset?url=https%3A%2F%2Fwithbuddi.com%2Fplugins%2Fgarden%2Fshots%2Fweek.webp');
    expect(shot).toHaveAttribute('alt', 'Garden, as it looks in buddi');
    // The market's own icon, drawn inline so it takes the tile's colour.
    expect(sheet.querySelector('.ui-app-icon[data-tone="accent"] svg circle')).not.toBeNull();
    expect(sheet).toHaveTextContent('buddi-plugin-garden@0.1.0');
    expect(sheet).toHaveTextContent('1 run without asking, 1 asks you first, 1 on a timer');
    expect(sheet).toHaveTextContent('api.garden.example');
    expect(sheet).toHaveTextContent('It sends web requests.');
    expect(sheet).toHaveTextContent('3, none of which run install scripts');
    expect(sheet).toHaveTextContent('MIT · a subscription · 14 days to try');
    expect(screen.getByRole('link', { name: "its maker's page" })).toHaveAttribute('href', 'https://garden.example');
    expect(sheet).toHaveTextContent('Install reads it first. Nothing of it runs until you say yes.');

    fireEvent.click(screen.getByRole('button', { name: 'Install' }));
    await waitFor(() => expect(api.stagePlugin).toHaveBeenCalledWith('buddi-plugin-garden@0.1.0'));
    // Back on Installed, reading it.
    expect(await screen.findByText(TRUST)).toBeInTheDocument();
  });

  it('stages the listed version and goes back to Installed to read the card', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view());
    vi.mocked(api.market).mockResolvedValue({ plugins: [WEATHER] });
    vi.mocked(api.stagePlugin).mockResolvedValue({ job: JOB });
    vi.mocked(api.pluginJob).mockResolvedValue(JOB);
    render(<Plugins hash="#/settings/plugins?tab=browse" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
    await waitFor(() => expect(api.stagePlugin).toHaveBeenCalledWith('@withbuddi/plugin-weather@0.1.0'));
    expect(await screen.findByText(TRUST)).toBeInTheDocument();
    expect(await screen.findByText(/Fetching the package/)).toBeInTheDocument();
  });

  it('updates to the listed version, and counts the updates on the Installed tab', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view({ installed: [INSTALLED_FINANCE] }));
    vi.mocked(api.market).mockResolvedValue({ plugins: [{ ...FINANCE, iconSvg: ICON }] });
    vi.mocked(api.updatePlugin).mockResolvedValue({ job: JOB });
    vi.mocked(api.pluginJob).mockResolvedValue(JOB);
    render(<Plugins hash="#/settings/plugins?tab=browse" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update to 1.2.0' }));
    await waitFor(() => expect(api.updatePlugin).toHaveBeenCalledWith('finance', '1.2.0', '@withbuddi/plugin-finance@1.2.0'));
    // Back on Installed, the row names the version too, wears the market's icon, and the tab counts it.
    expect(await screen.findByRole('button', { name: 'Update to 1.2.0' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Installed/ })).toHaveTextContent('Installed1');
    expect(screen.getByLabelText('finance: details').querySelector('.ui-app-icon-svg svg')).not.toBeNull();
  });

  it('filters by title, summary and npm name', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view());
    vi.mocked(api.market).mockResolvedValue({ plugins: [WEATHER, GARDEN] });
    render(<Plugins hash="#/settings/plugins?tab=browse" />);
    await screen.findByText('Garden');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'water' } });
    expect(screen.queryByText('Weather')).toBeNull();
    expect(screen.getByText('Garden')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'plugin-weather' } });
    expect(screen.queryByText('Garden')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing like it' } });
    expect(screen.getByText('Nothing listed matches')).toBeInTheDocument();
    expect(screen.getByText('No plugin on withbuddi.com mentions “nothing like it”.')).toBeInTheDocument();
  });

  it('says when withbuddi.com could not be reached, and tries again past the copy', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view());
    vi.mocked(api.market).mockResolvedValue({ plugins: [], unavailable: 'buddi could not reach withbuddi.com: offline' });
    render(<Plugins hash="#/settings/plugins?tab=browse" />);
    expect(await screen.findByText('buddi could not reach withbuddi.com: offline')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(api.market).toHaveBeenLastCalledWith(true));
  });

  it('does not ask the market from the Installed tab, and still checks for an update from the detail', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view({ installed: [INSTALLED_FINANCE] }));
    vi.mocked(api.updatePlugin).mockResolvedValue({ job: JOB });
    vi.mocked(api.pluginJob).mockResolvedValue(JOB);
    render(<Plugins />);
    // Nothing on the row names a version it does not know.
    expect(await screen.findByLabelText('finance: details')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Update/ })).toBeNull();
    fireEvent.click(screen.getByLabelText('finance: details'));
    fireEvent.click(await screen.findByRole('button', { name: 'Check for an update' }));
    await waitFor(() => expect(api.updatePlugin).toHaveBeenCalledWith('finance', undefined));
    expect(api.market).not.toHaveBeenCalled();
  });

  it('stages a market link once, on the Installed tab', async () => {
    vi.mocked(api.plugins).mockResolvedValue(view());
    vi.mocked(api.stagePlugin).mockResolvedValue({ job: JOB });
    vi.mocked(api.pluginJob).mockResolvedValue(JOB);
    const hash = '#/settings/plugins?install=%40withbuddi%2Fplugin-weather%400.1.0';
    const { rerender } = render(<Plugins hash={hash} />);
    await waitFor(() => expect(api.stagePlugin).toHaveBeenCalledWith('@withbuddi/plugin-weather@0.1.0'));
    rerender(<Plugins hash={hash} />);
    expect(await screen.findByText(TRUST)).toBeInTheDocument();
    expect(api.stagePlugin).toHaveBeenCalledTimes(1);
    expect(api.market).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/settings/plugins');
  });
});
