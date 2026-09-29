/** Home glances: produced side by side, hidden ones marked, links resolved, failures and blanks left out. */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, type HomeContribution, type PageDescriptor } from '@buddi/core';
import { readGlances, readHome, setGlanceHidden } from './read.js';

/** `core.web_settings` as a map, answering the two statements the settings use. */
function fakePool() {
  const rows = new Map<string, unknown>();
  return {
    rows,
    async query(sql: string, params: unknown[] = []) {
      if (sql.startsWith('select value')) {
        const value = rows.get(params[0] as string);
        return { rows: value === undefined ? [] : [{ value }] };
      }
      rows.set(params[0] as string, JSON.parse(params[1] as string));
      return { rows: [] };
    },
  };
}

const settingsPage = { id: 'settings', title: 'Weather', place: 'settings', body: [{ kind: 'notice', text: 'x' }] } as unknown as PageDescriptor;

function registryWith(home: HomeContribution[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({ name: 'weather', version: '1', schema: 'weather', migrationsDir: '', tools: [], home, pages: [settingsPage] });
  return registry;
}

const glances: HomeContribution[] = [
  { id: 'weather.now', title: 'Weather at home', placement: 'glance', produce: async () => ({ icon: 'cloud', text: '18°C Lyon', link: { route: { page: 'settings' } } }) },
  { id: 'weather.long', title: 'Long', placement: 'glance', produce: async () => ({ icon: 'rocket' as never, text: 'x'.repeat(80), link: { route: { page: 'nowhere' } } }) },
  { id: 'weather.none', title: 'None', placement: 'glance', produce: async () => null },
  { id: 'weather.broken', title: 'Broken', placement: 'glance', produce: async () => { throw new Error('down'); } },
  { id: 'weather.block', title: 'Block', produce: async () => ({ id: 'weather.block', title: 'Block', stats: [], rows: [] }) },
];

describe('Home glances', () => {
  it('draws each glance in order, resolving its link, cutting long text and dropping failures', async () => {
    const pool = fakePool();
    const registry = registryWith(glances);
    const views = await readGlances({ pool: pool as never, registry, ctx: {} as never });
    expect(views.map((g) => g.id)).toEqual(['weather.now', 'weather.long']);
    expect(views[0]).toEqual({
      id: 'weather.now', title: 'Weather at home', plugin: 'weather', icon: 'cloud', text: '18°C Lyon',
      link: { plugin: 'weather', page: 'settings', place: 'settings' }, hidden: false,
    });
    expect(views[1]!.icon).toBe('dot');
    expect(views[1]!.text).toHaveLength(60);
    expect(views[1]!.link).toBeUndefined();
    // And a glance is never drawn as a block.
    expect((await readHome({ registry, ctx: {} as never })).map((b) => b.id)).toEqual(['weather.block']);
  });

  it('remembers a hidden glance, shows it again, and refuses an id nobody contributes', async () => {
    const pool = fakePool();
    const registry = registryWith(glances);
    expect((await setGlanceHidden({ pool: pool as never, registry }, 'weather.now', true)).status).toBe(200);
    expect(pool.rows.get('home')).toEqual({ hiddenGlances: ['weather.now'] });
    expect((await readGlances({ pool: pool as never, registry, ctx: {} as never }))[0]!.hidden).toBe(true);
    await setGlanceHidden({ pool: pool as never, registry }, 'weather.now', false);
    expect((await readGlances({ pool: pool as never, registry, ctx: {} as never }))[0]!.hidden).toBe(false);
    expect((await setGlanceHidden({ pool: pool as never, registry }, 'weather.block', true)).status).toBe(404);
  });
});
