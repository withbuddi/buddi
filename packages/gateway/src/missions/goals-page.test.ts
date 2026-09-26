/**
 * The Goals surfaces, checked where they enter.
 *
 * A page descriptor and a view descriptor are data that cross into a browser
 * which cannot check them, so the check is `register()`. These are the
 * mistakes that would otherwise be a blank panel nobody can explain: a query
 * renamed on one side only, a write through a tool this manifest does not
 * contribute, a link to a page that is not there, a timeseries whose map does
 * not match its renderer.
 *
 * And the two promises that are this feature's rather than the engine's: the
 * Goals page is a **rail** page, so §2.5a gains no row and the places test
 * still holds; and its one write is a tool no model is ever shown.
 */
import { ToolRegistry, parseViewDescriptors, type MetricDefinition, type PluginManifest } from '@buddi/core';
import { describe, expect, it } from 'vitest';
import { createGoalManifest } from './goals.js';
import { goalViews, goalsPage } from './goals-page.js';

const debt: MetricDefinition = {
  id: 'test.debt',
  description: 'A number a test drives by hand.',
  unit: 'currency',
  direction: 'down',
  measure: async () => ({ value: 100, currency: 'USD', asOf: new Date() }),
};

const metricPlugin: PluginManifest = {
  name: 'test',
  version: '0.1.0',
  schema: 'core',
  migrationsDir: '',
  tools: [],
  metrics: [debt],
};

function goalRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(metricPlugin);
  registry.register(createGoalManifest(registry));
  return registry;
}

/** A deep copy, so a test may break one without breaking the next. */
function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('the Goals page, as a contribution', () => {
  it('registers as a rail page with its two reads', () => {
    const registry = goalRegistry();
    expect(registry.pages().map((page) => [page.plugin, page.id, page.place, page.icon])).toEqual([
      ['goal', 'goals', 'rail', 'chart'],
    ]);
    expect(registry.queries().map((query) => query.name)).toEqual(['goals', 'goal']);
  });

  it('writes through one tool, and no model is shown it', () => {
    const registry = goalRegistry();
    expect(registry.pageTools('goal')).toEqual(['goal.owner_close']);
    const listed = new Set(registry.list().map((tool) => tool.name));
    expect(listed.has('goal.owner_close')).toBe(false);
    // The rest of the family: step 1's six, and `goal.record` for the owner's numbers.
    expect([...listed].filter((name) => name.startsWith('goal.')).sort()).toEqual([
      'goal.close',
      'goal.list',
      'goal.metrics',
      'goal.record',
      'goal.set',
      'goal.status',
      'goal.update',
    ]);
  });

  it('puts a block on Home and one drawing on the canvas', () => {
    const registry = goalRegistry();
    expect(registry.home().map((block) => block.id)).toEqual(['goal.goals']);
    expect(registry.views().map((view) => [view.tool, view.renderer])).toEqual([['goal.status', 'timeseries']]);
  });

  /**
   * The chat link, said out loud.
   *
   * It is the one thing on this page that leaves the plugin, and the grammar
   * only allows it because a goal's whole point is the agent that holds it.
   */
  it('links to the holder by an agent id the query answers, never a URL', () => {
    const holder = JSON.stringify(goalsPage).match(/\{"chat":\{"path":"([A-Za-z]+)"\}\}/);
    expect(holder?.[1]).toBe('agentId');
  });

  it('refuses a page whose query was renamed on one side only', () => {
    const broken = copy(goalsPage);
    // The stats block reads `goal`; rename it and the page names a read
    // nothing contributes.
    const stats = ((broken.body[1] as { body: unknown[] }).body[0] as { detail: unknown[] }).detail[0] as {
      query: { query: string };
    };
    stats.query.query = 'goal_detail';
    const registry = new ToolRegistry();
    registry.register(metricPlugin);
    const manifest = { ...createGoalManifest(registry), pages: [broken] };
    expect(() => registry.register(manifest)).toThrow(/no query called goal_detail/);
  });

  it('refuses a write through a tool this manifest does not contribute', () => {
    const broken = copy(goalsPage);
    const form = ((broken.body[1] as { body: unknown[] }).body[0] as { detail: unknown[] }).detail[5] as {
      submit: { tool: string };
    };
    form.submit.tool = 'goal.owner_delete';
    const registry = new ToolRegistry();
    registry.register(metricPlugin);
    const manifest = { ...createGoalManifest(registry), pages: [broken] };
    expect(() => registry.register(manifest)).toThrow(/goal.owner_delete/);
  });

  it('validates the view descriptor against the renderer that draws it', () => {
    expect(() => parseViewDescriptors(goalViews, { plugin: 'goal', tools: ['goal.status'] })).not.toThrow();
    const broken = copy(goalViews[0]!) as { map: Record<string, unknown> };
    delete broken.map.points;
    expect(() => parseViewDescriptors([broken], { plugin: 'goal' })).toThrow(/points/);
  });
});
