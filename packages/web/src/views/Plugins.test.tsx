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
    expect(await screen.findByText('What it reaches in buddi')).toBeInTheDocument();
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

    // The agent it would unlock, and the two places accepting one happens.
    expect(await screen.findByText('@sky')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /on the Agents page/ })).toHaveAttribute('href', '#/agents');

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

  /**
   * The button that finishes what "1 agent proposed" starts.
   *
   * Accepting is gated, so the page never writes an agent: it asks the route,
   * gets an approval back, and draws the very card Home draws — with the whole
   * tool grant on it — for the owner to decide there.
   */
  it('accepts a proposed agent and draws the approval in place', async () => {
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
    vi.mocked(api.acceptPluginAgent).mockResolvedValue({ approvalId: 'action-1', preview: 'the whole grant' });
    vi.mocked(api.approval).mockResolvedValue({
      id: 'action-1',
      tool: 'platform.accept_plugin_agent',
      toolVersion: '1',
      agentId: 'owner',
      conversationId: null,
      jobId: null,
      preview: 'This gives @gardener your garden tools (2)',
      envelope: {},
      canonicalArgs: {},
      argsHash: 'sha256-x',
      policyVersion: 1,
      state: 'pending',
      decidedBy: null,
      decidedVia: null,
      decidedAt: null,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      outcome: null,
    });

    render(<Plugins />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(api.acceptPluginAgent).toHaveBeenCalledWith('garden', 'gardener'));

    // The card, with the grant on it, and the decision still the owner's.
    expect(await screen.findByText('This gives @gardener your garden tools (2)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
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

    expect(await screen.findByText('you, from this machine')).toBeInTheDocument();
    expect(screen.getByText('a file on this machine')).toBeInTheDocument();
    expect(screen.getByText('someone')).toBeInTheDocument();
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

  it('names what buddi already ships with, and what each of them adds', async () => {
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
        ],
      }),
    );
    render(<Plugins />);

    expect(await screen.findByText('Ships with buddi')).toBeInTheDocument();
    expect(screen.getByText('1.0.0 \u00b7 4 tools, 1 watcher')).toBeInTheDocument();
    expect(screen.getByText('1.0.0 \u00b7 1 tool')).toBeInTheDocument();
    expect(screen.getByText('What buddi remembers about you.')).toBeInTheDocument();
  });
});
