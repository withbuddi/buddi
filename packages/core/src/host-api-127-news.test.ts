/**
 * Host API 1.27's page grammar for the News page and its source manager: the
 * `stories` component, a page's head actions, a chip pick with its add chip, a
 * tab kept in a page parameter, a quiet notice with a link and a button, and a
 * list row's logo, tag, status line and ⋯ menu actions.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parsePageContributions } from './pages.js';

const TOOLS = ['news.hide_story', 'news.mute_outlet', 'news.refresh', 'news.set_source', 'news.remove_source'];

const parse = (page: unknown, extra: unknown[] = []) =>
  parsePageContributions({
    plugin: 'news',
    pages: [page, ...extra],
    queries: [
      { name: 'stories', params: z.object({ topic: z.string().optional(), filter: z.string().optional() }), produce: async () => ({}) },
      { name: 'overview', params: z.object({}), produce: async () => ({}) },
      { name: 'topics', params: z.object({}), produce: async () => ({}) },
      { name: 'sources', params: z.object({}), produce: async () => ({}) },
    ],
    tools: TOOLS,
  }).pages;

const settings = { id: 'sources', title: 'News', place: 'settings', body: [{ kind: 'notice', text: 'x' }] };

const stories = (extra: Record<string, unknown> = {}) => ({
  kind: 'stories',
  query: { query: 'stories', params: { topic: { param: 'topic' } } },
  rows: 'stories',
  groups: { param: 'topic' },
  ways: [
    {
      tool: 'news.hide_story', label: 'Not interested', hint: 'Hides it and shows fewer like it', hides: true,
      args: { id: { row: 'id' }, action: { const: 'not_interested' } }, done: 'Hidden. You’ll see fewer like it.',
      undo: { tool: 'news.hide_story', label: 'Undo', args: { id: { row: 'id' }, action: { const: 'undo' } } },
    },
    { tool: 'news.mute_outlet', label: 'Mute {name}', group: 'Mute an outlet', each: 'outlets', hides: true, args: { outlet: { item: 'id' }, muted: { const: true } } },
  ],
  ask: { label: 'Ask Anchor', to: { chat: { path: 'anchor' } } },
  edition: { label: 'Read the edition', to: { chat: { path: 'anchor' } }, when: { path: 'told', equals: true } },
  emptyStates: [
    { when: { path: 'state', equals: 'first' }, title: 'The first fetch is running', text: { path: 'note' }, warm: true },
    { when: { path: 'state', equals: 'told' }, title: 'Anchor has told you all of this', actions: [{ label: 'Show all', set: { filter: 'all' } }] },
  ],
  ...extra,
});

const page = (body: unknown[], extra: Record<string, unknown> = {}) => ({ id: 'stories', title: 'News', place: 'rail', icon: 'news', data: { query: 'overview' }, body, ...extra });

describe('host API 1.27: the News page grammar', () => {
  it('accepts a chat reference and limits question suggestions', () => {
    const context = { title: { path: 'title' }, text: { path: 'chatContext' }, suggestions: ['Explain this story', 'Compare the sources'] };
    const withContext = (value: unknown) => stories({ ask: { label: 'Ask Anchor', to: { chat: { path: 'anchor' } }, context: value } });
    expect(() => parse(page([withContext(context)]))).not.toThrow();
    expect(() => parse(page([withContext({ ...context, suggestions: ['a', 'b', 'c', 'd'] })]))).toThrow();
  });

  it('takes a stories feed with its ways out, sheet buttons and empty states', () => {
    expect(() => parse(page([stories()]), [settings])).not.toThrow();
  });

  it('refuses an Undo on a way that does not hide, an { item } with no each, and a way to an unknown tool', () => {
    const undoNoHide = stories({ ways: [{ tool: 'news.hide_story', label: 'X', args: {}, undo: { tool: 'news.hide_story', label: 'Undo', args: {} } }] });
    expect(() => parse(page([undoNoHide]))).toThrow(/undo/);
    const itemNoEach = stories({ ways: [{ tool: 'news.mute_outlet', label: 'X', args: { outlet: { item: 'id' } } }] });
    expect(() => parse(page([itemNoEach]))).toThrow(/each/);
    const unknown = stories({ ways: [{ tool: 'news.nope', label: 'X', args: {} }] });
    expect(() => parse(page([unknown]))).toThrow(/news\.nope/);
  });

  it('refuses an empty state action that both goes and sets, and one that does neither', () => {
    const both = stories({ emptyStates: [{ when: { path: 's', equals: 1 }, title: 'T', actions: [{ label: 'A', set: { filter: 'all' }, to: { page: 'stories' } }] }] });
    expect(() => parse(page([both]))).toThrow();
    const neither = stories({ emptyStates: [{ when: { path: 's', equals: 1 }, title: 'T', actions: [{ label: 'A' }] }] });
    expect(() => parse(page([neither]))).toThrow();
  });

  it('takes head actions on a rail page, links and buttons only, never on a settings tab', () => {
    const actions = [
      { kind: 'link', label: 'Sources', to: { page: 'sources' } },
      { kind: 'link', label: 'Latest edition', to: { chat: { path: 'anchor' } }, tone: 'accent', when: { path: 'anchor', not: true, equals: null } },
    ];
    expect(() => parse(page([stories()], { actions }), [settings])).not.toThrow();
    expect(() => parse(page([stories()], { actions: [{ kind: 'notice', text: 'x' }] }))).toThrow(/links, buttons and menus/);
    expect(() => parse({ ...settings, actions: [actions[0]] })).toThrow(/rail page/);
  });

  it('takes a chip pick with an add chip and a tab kept in a parameter; an add chip needs chips', () => {
    const tabs = (pick: Record<string, unknown>) => ({
      kind: 'tabs',
      param: 'filter',
      pick: { param: 'topic', label: 'Topic', optionsFrom: { query: { query: 'topics' }, rows: 'topics', value: 'id', label: 'name' }, ...pick },
      tabs: [
        { id: 'all', label: 'All', body: [stories()] },
        { id: 'untold', label: 'Not yet told', body: [stories()] },
      ],
    });
    expect(() => parse(page([tabs({ look: 'chips', add: { label: 'Topic', to: { page: 'sources' } } })]), [settings])).not.toThrow();
    expect(() => parse(page([tabs({ add: { label: 'Topic', to: { page: 'sources' } } })]), [settings])).toThrow(/chips/);
  });

  it('takes a quiet notice with a link and a button', () => {
    const notice = {
      kind: 'notice', look: 'quiet', icon: 'globe', text: { path: 'fetched' },
      link: { label: { path: 'failingWords' }, to: { page: 'sources' }, when: { path: 'failing', not: true, equals: 0 } },
    };
    const warning = { kind: 'notice', tone: 'warning', title: 'Couldn’t fetch', text: 'x', action: { tool: 'news.refresh', label: 'Try now' } };
    expect(() => parse(page([notice, warning, stories()]), [settings])).not.toThrow();
    expect(() => parse(page([{ ...notice, icon: 'rocket' }]), [settings])).toThrow();
  });

  it('takes a source row with its logo, tag, status line and menu actions; a hint needs the menu', () => {
    const list = (action: Record<string, unknown>) => ({
      ...settings,
      body: [{
        kind: 'list', query: { query: 'sources' }, rows: 'sources', key: 'id',
        groupBy: { key: 'topicId', label: 'topic', aside: 'topicAside' },
        item: {
          title: { path: 'name' }, sub: { path: 'line' }, tag: { path: 'lang' },
          logo: { asset: { path: 'logo' }, label: { path: 'name' } },
          status: { text: { path: 'problem' }, tone: { path: 'problemTone' } },
        },
        actions: [action],
      }],
    });
    expect(() => parse(list({ tool: 'news.set_source', label: 'Mute {name}', menu: true, hint: 'Everywhere, not only here', args: { id: { row: 'id' } } }))).not.toThrow();
    expect(() => parse(list({ tool: 'news.set_source', label: 'Mute', hint: 'Everywhere', args: { id: { row: 'id' } } }))).toThrow(/menu/);
  });
});
