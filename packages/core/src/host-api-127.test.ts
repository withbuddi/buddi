/**
 * Host API 1.27's grammar and checks that need no database: a list row's
 * images, a link out (`{ href }`), the `news` page icon, a widget row's
 * image, a mission's `context` and `reportMax`, and `optional` in a manifest.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parsePageContributions } from './pages.js';
import { widgetBodyOf } from './widgets.js';
import { REPORT_MAX_LIMIT, missionExtrasProblem, type PluginManifest } from './tools.js';
import { ToolRegistry } from './registry.js';
import { createPluginHost, hostBindingOf } from './host/build.js';
import { pluginRequiresMismatch } from './plugin/requires.js';
import { HOST_API_VERSION } from './plugin/version.js';

const list = (item: Record<string, unknown>) => ({
  id: 'stories',
  title: 'News',
  place: 'rail',
  icon: 'news',
  body: [{ kind: 'list', query: { query: 'stories' }, rows: 'stories', key: 'id', item: { title: { path: 'title' }, ...item } }],
});
const parse = (page: unknown) =>
  parsePageContributions({
    plugin: 'news',
    pages: [page],
    queries: [{ name: 'stories', params: z.object({}), produce: async () => ({}) }],
    tools: [],
  }).pages;

describe('host API 1.27', () => {
  it('is this build', () => {
    expect(HOST_API_VERSION).toBe('1.27');
  });

  describe('page grammar', () => {
    it('takes images on a list row: up to four fixed slots, or one array in the row', () => {
      expect(() => parse(list({ images: [{ asset: { path: 'outlets[0].logo' }, label: { path: 'outlets[0].name' } }] }))).not.toThrow();
      expect(() => parse(list({ images: { from: 'outlets', asset: 'logo', label: 'name' } }))).not.toThrow();
      const five = Array.from({ length: 5 }, () => ({ asset: { path: 'logo' }, label: { path: 'name' } }));
      expect(() => parse(list({ images: five }))).toThrow();
      expect(() => parse(list({ images: [{ asset: { path: 'logo' } }] }))).toThrow();
      expect(() => parse(list({ images: { from: 'outlets', asset: 'logo', label: 'name', src: 'https://x' } }))).toThrow();
    });

    it('takes a link out read from the data, and only as a value reference', () => {
      expect(() => parse(list({ to: { href: { path: 'url' } } }))).not.toThrow();
      const link = { id: 'l', title: 'L', place: 'rail', body: [{ kind: 'link', label: 'Read', to: { href: { path: 'url' } } }] };
      expect(() => parse(link)).not.toThrow();
      expect(() => parse(list({ to: { href: 'https://example.com' } }))).toThrow();
      expect(() => parse(list({ to: { href: { path: 'url' }, page: 'stories' } }))).toThrow();
    });

    it('draws the news icon', () => {
      expect(parse(list({}))[0]!.icon).toBe('news');
    });
  });

  describe('a widget row image', () => {
    const body = (image: unknown) => widgetBodyOf({ kind: 'list', rows: [{ title: 'Story', image }] }, { plugin: 'news' });

    it('becomes buddi\'s own path to the plugin\'s asset, at 64 px', () => {
      expect(body({ asset: 'lemonde.fr' })).toEqual({
        ok: true,
        body: { kind: 'list', rows: [{ title: 'Story', image: { src: '/api/plugin-assets/news/lemonde.fr?size=64' } }] },
      });
    });

    it('is left off for a URL, a bad key, a src the plugin wrote, or no plugin to bind it to', () => {
      for (const image of [{ asset: 'https://evil.example/logo.png' }, { asset: '../x' }, { src: '/api/plugin-assets/news/x' }, 'x']) {
        expect(body(image)).toEqual({ ok: true, body: { kind: 'list', rows: [{ title: 'Story' }] } });
      }
      expect(widgetBodyOf({ kind: 'list', rows: [{ title: 'S', image: { asset: 'x' } }] })).toEqual({ ok: true, body: { kind: 'list', rows: [{ title: 'S' }] } });
    });
  });

  describe('mission context and reportMax', () => {
    it('bounds reportMax and checks the context names a plugin it may use', () => {
      expect(missionExtrasProblem({ id: 'm', reportMax: 3800 }, [])).toBeUndefined();
      expect(missionExtrasProblem({ id: 'm', reportMax: REPORT_MAX_LIMIT + 1 }, [])).toMatch(/200 to 6000/);
      expect(missionExtrasProblem({ id: 'm', reportMax: 12.5 }, [])).toMatch(/whole number/);
      const context = { plugin: 'news', export: 'edition_material', args: { edition: 'morning' } };
      expect(missionExtrasProblem({ id: 'm', context }, ['news'])).toBeUndefined();
      expect(missionExtrasProblem({ id: 'm', context }, ['weather'])).toMatch(/reads its context from news, which it does not require/);
      expect(missionExtrasProblem({ id: 'm', context: { plugin: 'news' } }, ['news'])).toMatch(/context.export/);
      expect(missionExtrasProblem({ id: 'm', context: { ...context, extra: 1 } }, ['news'])).toMatch(/not extra/);
    });

    it('refuses at register a plugin mission whose context reads a plugin it does not require', () => {
      const r = new ToolRegistry();
      const mission = { id: 'edition', name: 'Edition', agentId: 'anchor', cron: '0 7 * * *', prompt: 'p' };
      const manifest = (extra: Partial<PluginManifest>): PluginManifest => ({ name: 'brief', version: '0.1.0', schema: 'brief', migrationsDir: '', tools: [], ...extra });
      expect(() => r.register(manifest({ missions: [{ ...mission, context: { plugin: 'news', export: 'headlines' } }] }))).toThrow(
        /plugin brief: mission "edition" reads its context from news, which it does not require/,
      );
      expect(() => r.register(manifest({ missions: [{ ...mission, context: { plugin: 'brief', export: 'material' } }] }))).not.toThrow();
      r.unregister('brief');
      expect(() => r.register(manifest({ requires: { news: '^0.1.0' }, missions: [{ ...mission, reportMax: 3800, context: { plugin: 'news', export: 'headlines' } }] }))).not.toThrow();
    });
  });

  describe('optional plugins', () => {
    const manifest = (extra: Partial<PluginManifest>): PluginManifest => ({ name: 'news', version: '0.1.0', schema: 'news', migrationsDir: '', tools: [], ...extra });

    it('give ctx.buddi.plugins, and refuse a name both required and optional', () => {
      const facts = { db: {} as never, now: () => new Date(), timezone: 'UTC' };
      expect(createPluginHost(hostBindingOf(manifest({})), facts).plugins).toBeUndefined();
      const host = createPluginHost(hostBindingOf(manifest({ optional: { speech: '^0.1.3' } })), facts);
      expect(typeof host.plugins!.has).toBe('function');
      // Not bound to a registry: nothing is known to be there.
      expect(host.plugins!.has!('speech')).toBe(false);
      expect(() => hostBindingOf(manifest({ requires: { speech: '*' }, optional: { speech: '*' } }))).toThrow(/both requires and optional/);
      expect(() => hostBindingOf(manifest({ optional: { speech: 'latest' } }))).toThrow(/not a version range/);
    });

    it('say what differs from package.json in the optional sentence', () => {
      expect(pluginRequiresMismatch('news', { speech: '^0.1.3' }, {}, 'optional')).toBe(
        'plugin "news" can use speech ^0.1.3 in its manifest, and nothing in package.json\'s buddi.optional; the install card was drawn from the second, so the two must match',
      );
    });
  });
});
