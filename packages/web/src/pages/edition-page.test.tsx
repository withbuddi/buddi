import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api';
import { PluginPage } from './PluginPage';
import type { PluginPageDescriptor } from './types';
vi.mock('../api', async (load) => ({ ...await load<typeof import('../api')>(), api: { pageQuery: vi.fn(), pageAct: vi.fn() } }));
const page = { plugin: 'news', id: 'stories', title: 'News', place: 'rail', actions: [
  { kind: 'link', label: 'Latest edition', to: { page: 'stories', params: { edition: { const: 'latest' } } } },
], body: [{ kind: 'edition', param: 'edition', query: { query: 'edition', params: { id: { param: 'edition' } } } }] } as PluginPageDescriptor;
const saved = { id: 'e_saved', name: 'Evening edition', when: 'Tue 6 Oct', lede: 'Two stories tonight.', groups: [{ topic: 'US', stories: [{ title: 'A saved headline', lead: 'The saved summary.', outlet: 'Example', more: 0, logos: [] }] }], notes: [] };
afterEach(() => { cleanup(); vi.clearAllMocks(); });
describe('saved edition drawer', () => {
  it('opens the latest saved edition without navigating to chat, and closes to News', async () => {
    vi.mocked(api.pageQuery).mockResolvedValue({ data: { edition: saved } } as never);
    const navigate = vi.fn();
    const user = userEvent.setup({ delay: null, pointerEventsCheck: 0 });
    const view = render(<PluginPage page={page} navigate={navigate} timezone="UTC" />);
    expect(api.pageQuery).not.toHaveBeenCalled();
    await user.click(screen.getByRole('link', { name: 'Latest edition' }));
    expect(navigate).toHaveBeenCalledWith('#/p/news/stories?edition=latest');
    view.rerender(<PluginPage page={page} params={{ edition: 'latest' }} navigate={navigate} timezone="UTC" />);
    expect(await screen.findByText('A saved headline')).toBeVisible();
    expect(api.pageQuery).toHaveBeenCalledWith('news', 'edition', { id: 'latest' });
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(navigate).toHaveBeenLastCalledWith('#/p/news/stories');
  });
  it('opens a specific notification edition, never silently substituting the latest', async () => {
    vi.mocked(api.pageQuery).mockResolvedValue({ data: { edition: saved } } as never);
    render(<PluginPage page={page} params={{ edition: 'e_saved' }} navigate={vi.fn()} timezone="UTC" />);
    expect(await screen.findByText('The saved summary.')).toBeVisible();
    expect(api.pageQuery).toHaveBeenCalledWith('news', 'edition', { id: 'e_saved' });
  });
  it('shows an honest empty state when there is no saved edition', async () => {
    vi.mocked(api.pageQuery).mockResolvedValue({ data: { edition: null } } as never);
    render(<PluginPage page={page} params={{ edition: 'latest' }} navigate={vi.fn()} timezone="UTC" />);
    expect(await screen.findByText('No saved edition')).toBeVisible();
    expect(screen.queryByTestId('edition-card')).not.toBeInTheDocument();
  });
  it('shows a failed read as an error, not as no edition', async () => {
    vi.mocked(api.pageQuery).mockRejectedValue(new Error('Edition lookup unavailable'));
    render(<PluginPage page={page} params={{ edition: 'latest' }} navigate={vi.fn()} timezone="UTC" />);
    expect(await screen.findByText(/Edition lookup unavailable/)).toBeVisible();
    expect(screen.queryByText('No saved edition')).not.toBeInTheDocument();
  });
});
