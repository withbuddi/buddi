/** The rail's plugin pages: all shown until the owner hides one, kept by the installation. */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, type PageDescriptor } from '@buddi/core';
import { readRail, setRailPageHidden } from './rail.js';

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

const page = (id: string, place: 'rail' | 'settings'): PageDescriptor =>
  ({ id, title: id, place, body: [{ kind: 'notice', text: 'x' }] }) as unknown as PageDescriptor;

function registry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register({ name: 'calendar', version: '1', schema: 'calendar', migrationsDir: '', tools: [], pages: [page('agenda', 'rail'), page('settings', 'settings')] });
  return r;
}

describe('the rail setting', () => {
  it('hides nothing at first, remembers a hidden page, and shows it again', async () => {
    const pool = fakePool();
    expect(await readRail(pool)).toEqual({ hidden: [] });
    expect(await setRailPageHidden({ pool, registry: registry() }, 'calendar', 'agenda', true)).toEqual({
      status: 200,
      body: { plugin: 'calendar', page: 'agenda', hidden: true },
    });
    expect(pool.rows.get('rail')).toEqual({ hidden: ['calendar:agenda'] });
    expect(await readRail(pool)).toEqual({ hidden: ['calendar:agenda'] });
    await setRailPageHidden({ pool, registry: registry() }, 'calendar', 'agenda', false);
    expect(await readRail(pool)).toEqual({ hidden: [] });
  });

  it('refuses a page that is not an installed rail page', async () => {
    const pool = fakePool();
    expect((await setRailPageHidden({ pool, registry: registry() }, 'calendar', 'settings', true)).status).toBe(404);
    expect((await setRailPageHidden({ pool, registry: registry() }, 'mail', 'agenda', true)).status).toBe(404);
    expect(pool.rows.size).toBe(0);
  });

  it('reads a damaged value as nothing hidden', async () => {
    const pool = fakePool();
    pool.rows.set('rail', { hidden: 'calendar:agenda' });
    expect(await readRail(pool)).toEqual({ hidden: [] });
  });
});
