/** Home contributions: a block by default, a glance when it says so, each produced through its plugin's host. */
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './registry.js';
import type { HomeContribution } from './home.js';

describe('home contributions', () => {
  it('keeps blocks and glances apart by placement, in registration order, and knows whose each is', async () => {
    const home: HomeContribution[] = [
      { id: 'demo.block', title: 'Block', produce: async () => ({ id: 'demo.block', title: 'Block', stats: [], rows: [] }) },
      { id: 'demo.glance', title: 'Glance', placement: 'glance', produce: async () => ({ icon: 'sun', text: '21°C Paris' }) },
    ];
    const registry = new ToolRegistry();
    registry.register({ name: 'demo', version: '1', schema: 'demo', migrationsDir: '', tools: [], home });
    const contributions = registry.home();
    expect(contributions.map((c) => [c.id, c.placement ?? 'block'])).toEqual([
      ['demo.block', 'block'],
      ['demo.glance', 'glance'],
    ]);
    const glance = contributions[1]!;
    expect(glance.placement === 'glance' ? await glance.produce({} as never) : null).toEqual({ icon: 'sun', text: '21°C Paris' });
    expect(registry.homePlugin('demo.glance')).toBe('demo');
    expect(registry.homePlugin('other.glance')).toBeUndefined();
  });
});
