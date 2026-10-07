import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { StoryView } from './views/StoryView';
import { QueryView } from './views/MediaViews';
import { applyDescriptor } from './resolve';
import { renderablesFrom } from './renderables';
import type { ChatMessage } from '../chat/types';
import { api } from '../api';
vi.mock('../api', async (load) => ({ ...await load<typeof import('../api')>(), api: { pageQuery: vi.fn(), reportAudio: vi.fn() } }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

// A StoryRow (host API 1.27's `stories` shape), every word the plugin's own.
const row = {
  id: 's1', kicker: 'World', title: 'Trade talks begin', titleAttribution: 'Headline from Publisher A',
  summary: 'Delegates arrived.', summaryAttribution: 'Excerpt from Publisher B', meta: '2 sources',
  image: { key: 'story-a1', outlet: 'Publisher A', url: 'https://example.test/article', credit: 'Photographer' },
  sources: [
    { title: 'Talks open', outlet: 'Publisher A', url: 'https://example.test/article', meta: 'Publisher A · French · Paywalled', logo: 'publisher-a' },
    { title: 'Unsafe link', outlet: 'B', url: 'javascript:alert(1)', logo: '../outside' },
  ],
  timeline: [{ at: '12:00', text: 'Publisher A: Earlier report' }, { at: '14:00', text: 'B: Later report', told: true }],
};

it('draws a StoryRow in the plugin’s words: attributions, safe links, its own assets, its timeline, collapsed details', () => {
  const { container } = render(<StoryView props={{ value: row, plugin: 'demo' }} />);
  expect(screen.getByText('Headline from Publisher A')).toBeVisible();
  expect(screen.getByText('Excerpt from Publisher B')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Talks open ↗' })).toHaveAttribute('rel', 'noopener noreferrer');
  expect(screen.queryByRole('link', { name: /Unsafe/ })).toBeNull();
  expect(screen.getByText('Publisher A · French · Paywalled')).toBeVisible();
  const sources = [...container.querySelectorAll('img')].map((img) => img.getAttribute('src'));
  expect(sources).toContain('/api/plugin-assets/demo/story-a1?size=768');
  expect(sources).toContain('/api/plugin-assets/demo/publisher-a?size=64');
  expect(container.querySelector('.cv-story-timeline li')?.textContent).toContain('Earlier report');
  expect(container.querySelector('.cv-story-timeline li[data-told]')?.textContent).toContain('Later report');
  expect(container.querySelector('details')?.open).toBe(false);
  // No copy of the host's own about where the words came from.
  expect(screen.queryByText(/Feed excerpt|Source headline/)).toBeNull();
});

it('draws no images without a plugin, and keeps a missing story readable', () => {
  const { container } = render(<StoryView props={{ value: row, plugin: '' }} />);
  expect(container.querySelector('img[src*="plugin-assets"]')).toBeNull();
  cleanup();
  render(<StoryView props={{ value: { found: false, message: 'Story is no longer available.' }, plugin: 'demo' }} />);
  expect(screen.getByText('Story is no longer available.')).toBeVisible();
});

it('resolves by descriptor, takes the plugin from the tool, and names its tab for the story', () => {
  const descriptor = { tool: 'demo.read', renderer: 'story' as const, title: 'Story', map: {} };
  expect(applyDescriptor(descriptor, row)).toEqual({ renderer: 'story', props: { value: row, plugin: 'demo' } });
  const messages: ChatMessage[] = [
    { id: 'a', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 't', name: 'demo.read', input: { id: 's1' } }] },
    { id: 'b', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 't', name: 'demo.read', ok: true, output: row }] },
  ];
  expect(renderablesFrom({ messages, descriptors: [descriptor] })[0]?.title).toBe('Story · Trade talks begin');
});

it('draws a list of rows from `rows`, with thumbnails, credits and links out', () => {
  const output = { query: 'Debate', hits: [{ id: 'a1', title: 'The debate', lead: 'Two candidates met.', meta: 'Publisher · Oct 6', url: 'https://example.test/debate', image: { key: 'story-a1', outlet: 'Publisher', url: 'https://example.test/debate' } }] };
  const resolved = applyDescriptor({ tool: 'demo.find', renderer: 'story', map: { rows: 'hits' } }, output);
  const { container } = render(<StoryView props={resolved.props as never} />);
  expect(screen.getByRole('link', { name: 'The debate ↗' })).toHaveAttribute('href', 'https://example.test/debate');
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/plugin-assets/demo/story-a1?size=768');
  expect(screen.getByText('Publisher · Oct 6')).toBeVisible();
  expect(screen.getByText('Publisher')).toBeVisible();
});

it('asks the tool’s own plugin the declared query with mapped params, and draws the declared body', async () => {
  vi.mocked(api.pageQuery).mockResolvedValue({ data: { digest: { id: 'd1', name: 'Late digest', when: 'Tue', lede: 'One story.', groups: [{ topic: 'US', stories: [{ title: 'A headline', lead: 'Its line.', outlet: 'Example', more: 0, logos: [] }] }], notes: [] } } } as never);
  const resolved = applyDescriptor(
    { tool: 'demo.save', renderer: 'query', map: { query: 'digest', params: { id: 'saved' }, body: [{ kind: 'digest', path: 'digest' }] } },
    { saved: 'd1', told: 1 },
  );
  expect(resolved).toMatchObject({ renderer: 'query', props: { plugin: 'demo', query: 'digest', params: { id: 'd1' } } });
  render(<QueryView props={resolved.props as never} timezone="UTC" />);
  expect(await screen.findByText('A headline')).toBeVisible();
  expect(api.pageQuery).toHaveBeenCalledWith('demo', 'digest', { id: 'd1' });
});
