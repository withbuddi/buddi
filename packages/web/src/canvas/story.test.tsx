import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { StoryView } from './views/StoryView';
import { applyDescriptor } from './resolve';
import { renderablesFrom } from './renderables';
import type { ChatMessage } from '../chat/types';
afterEach(cleanup);
const detail = { id: 's1', title: 'Trade talks begin', titleOutlet: 'Publisher A', lead: 'Delegates arrived.', leadOutlet: 'Publisher B', topic: 'World', score: 4,
  sources: [{ id: 'a1', title: 'Talks open', outlet: 'Publisher A', url: 'https://' + 'example.test/article', language: 'fr', paywall: true, logo: 'publisher-a' }, { id: 'a2', title: 'Unsafe link', outlet: 'B', url: 'javascript:alert(1)', logo: '../outside' }],
  timeline: [{ at: '2026-10-06T14:00:00Z', outlet: 'B', title: 'Later report' }, { at: '2026-10-06T12:00:00Z', outlet: 'A', title: 'Earlier report' }] };
it('draws attribution, safe source links, local logos and chronological coverage with collapsed details', () => {
  const { container } = render(<StoryView props={{ value: detail, plugin: 'demo' }} timezone="UTC" />);
  expect(screen.getByText('Headline from Publisher A')).toBeTruthy();
  expect(screen.getByText('Feed excerpt from Publisher B')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Talks open ↗' }).getAttribute('rel')).toBe('noopener noreferrer');
  expect(screen.queryByRole('link', { name: /Unsafe/ })).toBeNull();
  expect(screen.getByText(/French · Paywalled/)).toBeTruthy();
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/plugin-assets/demo/publisher-a?size=64');
  expect(container.querySelector('.cv-story-timeline li')?.textContent).toContain('Earlier report');
  expect(container.querySelector('details')?.open).toBe(false);
});
it('keeps a missing-story result readable', () => {
  render(<StoryView props={{ value: { found: false, message: 'Story is no longer available.' } }} />);
  expect(screen.getByText('Story is no longer available.')).toBeTruthy();
});
it('resolves existing stored output by descriptor and names its tab for the story, not a URL host', () => {
  const descriptor = { tool: 'demo.read', renderer: 'story' as const, title: 'Story', map: {} };
  expect(applyDescriptor(descriptor, detail)).toEqual({ renderer: 'story', props: { value: detail, plugin: 'demo' } });
  const messages: ChatMessage[] = [
    { id: 'a', role: 'assistant', at: '', blocks: [{ type: 'tool_use', id: 't', name: 'demo.read', input: { id: 's1' } }] },
    { id: 'b', role: 'user', at: '', blocks: [{ type: 'tool_result', toolUseId: 't', name: 'demo.read', ok: true, output: detail }] },
  ];
  expect(renderablesFrom({ messages, descriptors: [descriptor] })[0]?.title).toBe('Story · Trade talks begin');
});
it('renders search articles with cached thumbnails, attribution and source links', () => {
  const { container } = render(<StoryView props={{ plugin: 'news', value: { query: 'Debate', articles: [{ articleId: 'a_123', storyId: 's_123', title: 'The debate', lead: 'Two candidates met.', outlet: 'Publisher', url: 'https://example.test/debate', image: { key: 'story-a_123', outlet: 'Publisher', url: 'https://example.test/debate' } }] } }} />);
  expect(screen.getByRole('heading', { name: 'Results for “Debate”' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'The debate ↗' }).getAttribute('href')).toBe('https://example.test/debate');
  expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/plugin-assets/news/story-a_123?size=768');
  expect(screen.getByText('Image: Publisher')).toBeTruthy();
  expect(container.querySelector('details')?.open).toBe(false);
});
