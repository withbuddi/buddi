/**
 * Settings → System, Local models (host API 1.32): the engine's line with its
 * state, version and sizes, the shared models, and Remove. Nothing here
 * downloads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { api, type RuntimesView } from '../api';
import { LocalModels } from './Settings';

vi.mock('../api', async (load) => ({
  ...(await load<typeof import('../api')>()),
  api: { runtimes: vi.fn(), removeEngine: vi.fn(), removeModel: vi.fn() },
}));

const engine = (over: Partial<RuntimesView['onnx']> = {}): RuntimesView['onnx'] => ({
  state: 'ready', version: '1.30.0', sizeBytes: 44_856_768, downloadBytes: 113_507_888,
  platform: 'darwin-arm64', available: true, sessions: { open: 0, loaded: 0 }, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('local models', () => {
  it('shows the engine ready with its version and sizes, and removes it once the owner confirms', async () => {
    vi.mocked(api.runtimes).mockResolvedValue({ onnx: engine(), models: [{ id: 'minilm', state: 'ready', sizeBytes: 90_000_000 }] });
    vi.mocked(api.removeEngine).mockResolvedValue({ onnx: engine({ state: 'absent' }), models: [] });
    render(<LocalModels />);
    expect(await screen.findByText(/ONNX Runtime 1\.30\.0 · 45 MB on disk \(114 MB download\)/)).toBeInTheDocument();
    expect(screen.getByText('minilm')).toBeInTheDocument();
    const [removeEngine] = screen.getAllByRole('button', { name: 'Remove' });
    fireEvent.click(removeEngine!);
    // Asked first: nothing removed yet.
    expect(await screen.findByText(/Plugins that use it will ask you again/)).toBeInTheDocument();
    expect(api.removeEngine).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    await waitFor(() => expect(screen.queryByText(/Plugins that use it will ask you again/)).toBeNull());
    expect(api.removeEngine).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    const dialog = await screen.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.removeEngine).toHaveBeenCalledTimes(1));
  });

  it('removes a failed engine at once: there is nothing to lose', async () => {
    vi.mocked(api.runtimes).mockResolvedValue({ onnx: engine({ state: 'failed', reason: 'The engine could not be loaded: wrong architecture' }), models: [] });
    vi.mocked(api.removeEngine).mockResolvedValue({ onnx: engine({ state: 'absent' }), models: [] });
    render(<LocalModels />);
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.removeEngine).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('says so where the engine is not offered, with nothing to remove', async () => {
    vi.mocked(api.runtimes).mockResolvedValue({
      onnx: engine({ state: 'failed', available: false, version: '', platform: 'win32-x64', reason: 'The engine is not available on this platform (win32-x64).' }),
      models: [],
    });
    render(<LocalModels />);
    expect(await screen.findByText('Not available on this platform (win32-x64).')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  });

  it('shows why a failed engine failed', async () => {
    vi.mocked(api.runtimes).mockResolvedValue({ onnx: engine({ state: 'failed', reason: 'The engine could not be loaded: wrong architecture' }), models: [] });
    render(<LocalModels />);
    expect(await screen.findByText('The engine could not be loaded: wrong architecture')).toBeInTheDocument();
    expect(screen.getByText('failed')).toBeInTheDocument();
  });
});
