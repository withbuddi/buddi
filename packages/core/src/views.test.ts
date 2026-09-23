/**
 * View descriptors are validated where they enter the system, because they
 * leave it again: they are serialised to a browser that cannot check them and
 * draws whatever it is handed. So the properties asserted here are the ones a
 * page cannot assert for itself — the map matches the renderer, the paths are
 * paths, and a descriptor cannot name a tool its own plugin does not ship.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './registry.js';
import type { PluginManifest } from './tools.js';
import { parseViewDescriptors, viewDescriptorSchema } from './views.js';
import { z } from 'zod';

const tool = {
  name: 'demo.read',
  description: 'read',
  tier: 'auto' as const,
  input: z.object({}),
  async execute() {
    return {};
  },
};

const manifest = (views: unknown[]): PluginManifest => ({
  name: 'demo',
  version: '1.0.0',
  schema: 'demo',
  migrationsDir: '',
  tools: [tool],
  views: views as never,
});

describe('view descriptors', () => {
  it('accepts a timeseries that names its points, its axes and its floor', () => {
    const parsed = viewDescriptorSchema.parse({
      tool: 'demo.read',
      renderer: 'timeseries',
      title: 'Balance',
      map: {
        points: 'days',
        x: 'date',
        y: 'balance',
        unit: 'currency',
        currency: { path: 'currency' },
        referenceLines: [{ value: { path: 'safetyFloor' }, label: 'Floor', tone: 'warning' }],
        mark: 'min',
      },
    });
    expect(parsed.renderer).toBe('timeseries');
  });

  it('checks the map against the renderer that will draw it', () => {
    // A bars map under a table renderer is exactly the mistake a page cannot
    // report: it would render an empty panel and say nothing.
    expect(() =>
      parseViewDescriptors(
        [{ tool: 'demo.read', renderer: 'table', map: { bars: 'x', category: 'a', value: 'b' } }],
        { plugin: 'demo' },
      ),
    ).toThrow(/invalid view descriptor for demo\.read/);
  });

  it('refuses a field the renderer does not have, rather than ignoring it', () => {
    expect(() =>
      parseViewDescriptors(
        [{ tool: 'demo.read', renderer: 'bars', map: { bars: 'x', category: 'a', value: 'b', colour: 'red' } }],
        { plugin: 'demo' },
      ),
    ).toThrow(/invalid view descriptor/);
  });

  it('refuses anything in a path that is not a path', () => {
    for (const bad of ['days.map(d => d.x)', 'days[*]', 'a b', '../secrets']) {
      expect(() =>
        parseViewDescriptors(
          [{ tool: 'demo.read', renderer: 'timeseries', map: { points: bad, x: 'a', y: 'b' } }],
          { plugin: 'demo' },
        ),
        bad,
      ).toThrow(/view path/);
    }
    // …and accepts the three spellings that are.
    for (const good of ['days', 'summary.dateRange.from', 'cards[0].name']) {
      expect(() =>
        parseViewDescriptors(
          [{ tool: 'demo.read', renderer: 'timeseries', map: { points: good, x: 'a', y: 'b' } }],
          { plugin: 'demo' },
        ),
        good,
      ).not.toThrow();
    }
  });

  it('accepts a preview that names a frame, and refuses anything beside it', () => {
    const parsed = viewDescriptorSchema.parse({
      tool: 'demo.read',
      renderer: 'preview',
      map: { src: 'url', title: { path: 'name' }, output: 'recent' },
    });
    expect(parsed.renderer).toBe('preview');
    // `src` is what the panel points at: a descriptor without one has nothing
    // to draw, and one with an extra field is a descriptor written against a
    // renderer that does not exist.
    expect(() =>
      parseViewDescriptors([{ tool: 'demo.read', renderer: 'preview', map: { output: 'recent' } }], {
        plugin: 'demo',
      }),
    ).toThrow(/invalid view descriptor/);
    expect(() =>
      parseViewDescriptors(
        [{ tool: 'demo.read', renderer: 'preview', map: { src: 'url', height: '400' } }],
        { plugin: 'demo' },
      ),
    ).toThrow(/invalid view descriptor/);
  });

  it('accepts a diff that names its text, with a title and the facts about it', () => {
    const parsed = viewDescriptorSchema.parse({
      tool: 'demo.write',
      renderer: 'diff',
      map: {
        diff: 'diff',
        title: { path: 'path' },
        metadata: [{ label: 'Bytes', value: { path: 'bytes' }, unit: 'number' }],
      },
    });
    expect(parsed.renderer).toBe('diff');
    // A diff view with no diff has nothing to draw; `text` is a document's
    // field, not this one's, and is refused rather than ignored.
    expect(() =>
      parseViewDescriptors([{ tool: 'demo.write', renderer: 'diff', map: { title: { path: 'path' } } }], {
        plugin: 'demo',
      }),
    ).toThrow(/invalid view descriptor/);
    expect(() =>
      parseViewDescriptors([{ tool: 'demo.write', renderer: 'diff', map: { diff: 'diff', text: 'plain' } }], {
        plugin: 'demo',
      }),
    ).toThrow(/invalid view descriptor/);
  });

  it('refuses a descriptor for a tool the plugin does not contribute', () => {
    expect(() =>
      parseViewDescriptors([{ tool: 'demo.gone', renderer: 'structured', map: {} }], {
        plugin: 'demo',
        tools: ['demo.read'],
      }),
    ).toThrow(/does not contribute/);
  });

  it('fails at load, not in the page', () => {
    const registry = new ToolRegistry();
    expect(() => registry.register(manifest([{ tool: 'demo.read', renderer: 'nope', map: {} }]))).toThrow(
      /plugin demo/,
    );
    // Nothing was half-registered by the refusal.
    expect(registry.has('demo.read')).toBe(false);

    registry.register(
      manifest([
        { tool: 'demo.read', renderer: 'keyvalue', map: { pairs: [{ label: 'A', value: { path: 'a' } }] } },
      ]),
    );
    expect(registry.views()).toHaveLength(1);
    expect(registry.views()[0]?.tool).toBe('demo.read');
  });

  it('serves nothing for a plugin that declares nothing', () => {
    const registry = new ToolRegistry();
    registry.register({ name: 'plain', version: '1', schema: 'plain', migrationsDir: '', tools: [tool] });
    expect(registry.views()).toEqual([]);
  });
});
