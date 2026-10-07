/**
 * Host API 1.33's generic contracts: the `story` and `query` canvas
 * renderers, messenger delivery and `attachments`, and the `sheet` and
 * `digest` page components.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { checkQueryViews, parsePageContributions } from './pages.js';
import { leadsWithMedia, messengerAttachments, viewDescriptorSchema } from './views.js';

const queries = [
  { name: 'digest', params: z.object({ id: z.string() }), produce: async () => ({}) },
  { name: 'secret', params: z.object({}), sensitive: true, produce: async () => ({}) },
];

describe('host API 1.33: view descriptors', () => {
  it('takes a story view over one row or a list of rows', () => {
    expect(viewDescriptorSchema.parse({ tool: 'demo.read', renderer: 'story', map: {} }).renderer).toBe('story');
    expect(viewDescriptorSchema.parse({ tool: 'demo.find', renderer: 'story', map: { rows: 'hits' } }).map).toEqual({ rows: 'hits' });
    expect(() => viewDescriptorSchema.parse({ tool: 'demo.find', renderer: 'story', map: { rows: 'a b' } })).toThrow();
  });

  it('takes a query view, and checks its body against the plugin’s queries and the page grammar', () => {
    const view = { tool: 'demo.save', renderer: 'query', map: { query: 'digest', params: { id: 'saved' }, body: [{ kind: 'digest', path: 'digest' }] } };
    expect(viewDescriptorSchema.parse(view).renderer).toBe('query');
    expect(() => checkQueryViews({ plugin: 'demo', views: [view], queries })).not.toThrow();
    expect(() => checkQueryViews({ plugin: 'demo', views: [{ ...view, map: { ...view.map, query: 'other' } }], queries })).toThrow(/does not contribute/);
    expect(() => checkQueryViews({ plugin: 'demo', views: [{ ...view, map: { ...view.map, query: 'secret' } }], queries })).toThrow(/sensitive/);
    expect(() => checkQueryViews({ plugin: 'demo', views: [{ ...view, map: { ...view.map, body: [{ kind: 'nope' }] } }], queries })).toThrow(/invalid body/);
    const button = { kind: 'button', action: { tool: 'demo.save', label: 'Save' } };
    expect(() => checkQueryViews({ plugin: 'demo', views: [{ ...view, map: { ...view.map, body: [button] } }], queries })).toThrow(/read-only/);
  });

  it('declares media-first messenger delivery, optionally only for some inputs', () => {
    const plain = viewDescriptorSchema.parse({ tool: 'demo.read', renderer: 'story', map: {}, messenger: { mediaFirst: true } });
    expect(leadsWithMedia(plain, {})).toBe(true);
    const when = viewDescriptorSchema.parse({ tool: 'demo.list', renderer: 'structured', map: {}, messenger: { mediaFirst: true, when: { path: 'play', equals: true } } });
    expect(leadsWithMedia(when, { play: true })).toBe(true);
    expect(leadsWithMedia(when, { play: false })).toBe(false);
    expect(leadsWithMedia(when, null)).toBe(false);
    expect(leadsWithMedia(undefined, {})).toBe(false);
    expect(() => viewDescriptorSchema.parse({ tool: 'demo.read', renderer: 'story', map: {}, messenger: { mediaFirst: false } })).toThrow();
  });
});

describe('host API 1.33: messenger attachments', () => {
  it('keeps the plugin’s own images, audio files and its own reports’ recordings', () => {
    expect(messengerAttachments('demo', {
      attachments: [
        { kind: 'image', asset: 'story-a_1', caption: '  A caption  ' },
        { kind: 'audio', artifact: 'abc-123' },
        { kind: 'audio', report: '#/p/demo/stories?edition=e_1' },
      ],
    })).toEqual([
      { kind: 'image', asset: 'story-a_1', caption: 'A caption' },
      { kind: 'audio', artifact: 'abc-123' },
      { kind: 'audio', report: '#/p/demo/stories?edition=e_1' },
    ]);
  });

  it('drops another plugin’s report, unsafe keys, remote addresses, extra fields and duplicates', () => {
    expect(messengerAttachments('demo', {
      attachments: [
        { kind: 'audio', report: '#/p/other/stories?edition=e_1' },
        { kind: 'audio', report: 'https://example.com/a.ogg' },
        { kind: 'image', asset: '../secret' },
        { kind: 'image', asset: 'https://example.com/photo.jpg' },
        { kind: 'image', asset: 'ok', plugin: 'other' },
        { kind: 'audio', artifact: 'a', report: '#/p/demo/x' },
        { kind: 'video', artifact: 'a' },
        { kind: 'image', asset: 'ok' },
        { kind: 'image', asset: 'ok' },
      ],
    })).toEqual([{ kind: 'image', asset: 'ok' }]);
    expect(messengerAttachments('demo', { attachments: 'x' })).toEqual([]);
    expect(messengerAttachments('demo', null)).toEqual([]);
  });

  it('keeps at most four', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ kind: 'image', asset: `a${i}` }));
    expect(messengerAttachments('demo', { attachments: many })).toHaveLength(4);
  });
});

describe('host API 1.33: sheet and digest components', () => {
  const page = (body: unknown[]) => ({ id: 'stories', title: 'Stories', place: 'rail', body });
  it('takes a sheet opened by a page parameter, with a digest inside', () => {
    const sheet = { kind: 'sheet', param: 'edition', title: 'Digest', heading: { path: 'digest.name' }, query: { query: 'digest', params: { id: { param: 'edition' } } }, body: [{ kind: 'digest', path: 'digest', emptyTitle: 'Nothing saved', empty: 'Saved digests appear here.' }] };
    const link = { kind: 'link', label: 'Latest', to: { page: 'stories', params: { edition: { const: 'latest' } } } };
    expect(() => parsePageContributions({ plugin: 'demo', pages: [page([link, sheet])], queries })).not.toThrow();
    expect(() => parsePageContributions({ plugin: 'demo', pages: [page([{ ...sheet, body: [] }])], queries })).toThrow();
    expect(() => parsePageContributions({ plugin: 'demo', pages: [page([{ ...sheet, query: { query: 'gone' } }])], queries })).toThrow(/no query called gone/);
  });
});
