import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { PluginPage } from './PluginPage';
import type { PluginPageDescriptor } from './types';
vi.mock('../api', async (load) => ({ ...await load<typeof import('../api')>(), api: { pageQuery: vi.fn(), pageAct: vi.fn(), reportAudio: vi.fn() } }));

// Host API 1.33: a `sheet` opened by a page parameter, holding a `digest`.
const page = { plugin: 'demo', id: 'digests', title: 'Digests', place: 'rail', actions: [
  { kind: 'link', label: 'Latest', to: { page: 'digests', params: { saved: { const: 'latest' } } } },
], body: [{
  kind: 'sheet', param: 'saved', title: 'Digest', heading: { path: 'digest.name' }, query: { query: 'digest', params: { id: { param: 'saved' } } },
  body: [{ kind: 'digest', path: 'digest', emptyTitle: 'Nothing saved', empty: 'Saved digests appear here.' }],
}] } as PluginPageDescriptor;
const saved = {
  id: 'd_saved', name: 'Late digest', when: 'Tue 6 Oct', lede: 'Two stories tonight.', foot: 'More tomorrow.', report: '#/p/demo/digests?saved=d_saved',
  groups: [{ topic: 'US', stories: [{ title: 'A saved headline', lead: 'The saved summary.', outlet: 'Example', more: 0, logos: [{ name: 'Example', logo: 'example' }] }] }], notes: [],
};
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('a sheet over the page, with a digest (host API 1.33)', { timeout: 180_000 }, () => {
  it('opens on its parameter, asks only then, draws the digest in the plugin’s words and closes back to the page', async () => {
    vi.mocked(api.pageQuery).mockResolvedValue({ data: { digest: saved } } as never);
    vi.mocked(api.reportAudio).mockResolvedValue({ audio: null });
    const navigate = vi.fn();
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const view = render(<PluginPage page={page} navigate={navigate} timezone="UTC" />);
    expect(api.pageQuery).not.toHaveBeenCalled();
    await user.click(screen.getByRole('link', { name: 'Latest' }));
    expect(navigate).toHaveBeenCalledWith('#/p/demo/digests?saved=latest');
    view.rerender(<PluginPage page={page} params={{ saved: 'latest' }} navigate={navigate} timezone="UTC" />);
    expect(await screen.findByText('A saved headline')).toBeVisible();
    expect(screen.getByRole('dialog')).toHaveTextContent('Late digest');
    expect(screen.getByText('More tomorrow.')).toBeVisible();
    expect(screen.queryByText(/News/)).not.toBeInTheDocument();
    expect(api.pageQuery).toHaveBeenCalledWith('demo', 'digest', { id: 'latest' });
    expect(api.reportAudio).toHaveBeenCalledWith('#/p/demo/digests?saved=d_saved');
    expect(document.querySelector('img')?.getAttribute('src')).toBe('/api/plugin-assets/demo/example?size=64');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(navigate).toHaveBeenLastCalledWith('#/p/demo/digests');
  });

  it('never plays another plugin’s report', async () => {
    vi.mocked(api.pageQuery).mockResolvedValue({ data: { digest: { ...saved, report: '#/p/other/x?saved=d_saved' } } } as never);
    render(<PluginPage page={page} params={{ saved: 'd_saved' }} navigate={vi.fn()} timezone="UTC" />);
    expect(await screen.findByText('The saved summary.')).toBeVisible();
    expect(api.reportAudio).not.toHaveBeenCalled();
  });

  it('shows the plugin’s empty state when nothing is saved', async () => {
    vi.mocked(api.pageQuery).mockResolvedValue({ data: { digest: null } } as never);
    render(<PluginPage page={page} params={{ saved: 'latest' }} navigate={vi.fn()} timezone="UTC" />);
    expect(await screen.findByText('Nothing saved')).toBeVisible();
    expect(screen.queryByTestId('edition-card')).not.toBeInTheDocument();
  });

  it('shows a failed read as an error, not as an empty state', async () => {
    vi.mocked(api.pageQuery).mockRejectedValue(new Error('Lookup unavailable'));
    render(<PluginPage page={page} params={{ saved: 'latest' }} navigate={vi.fn()} timezone="UTC" />);
    expect(await screen.findByText(/Lookup unavailable/)).toBeVisible();
    expect(screen.queryByText('Nothing saved')).not.toBeInTheDocument();
  });
});
