/** Home glances: produced side by side, hidden ones marked, links resolved, failures and blanks left out. */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, type HomeContribution, type PageDescriptor } from '@buddi/core';
import { HOME_DISMISSED_MAX, cardOf, readGlances, readHome, readHomeDismissed, setGlanceHidden, setHomeDismissed } from './read.js';

/** `core.web_settings` as a map, answering the statements the settings use (a read, and the locked update). */
function fakePool() {
  const rows = new Map<string, unknown>();
  const pool = {
    rows,
    async query(sql: string, params: unknown[] = []) {
      const q = sql.trim();
      if (q.startsWith('select value')) {
        const value = rows.get(params[0] as string);
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (q.startsWith('insert')) {
        if (!rows.has(params[0] as string)) rows.set(params[0] as string, null);
        return { rows: [] };
      }
      if (q.startsWith('update')) rows.set(params[0] as string, JSON.parse(params[1] as string));
      return { rows: [] };
    },
    async connect() {
      return { query: pool.query, release() {} };
    },
  };
  return pool;
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

  it('passes a card through, cut to size, and drops one without a figure or with a short trend', async () => {
    const registry = registryWith([
      {
        id: 'weather.now', title: 'Weather at home', placement: 'glance',
        produce: async () => ({
          icon: 'sun', text: '70°F, clear in Somerset',
          card: { value: '70°F', caption: 'Clear · Somerset', trend: { label: 'Next 12 hours', points: [70, 69, Number.NaN, 66] }, foot: 'High 74° · Low 58°' },
        }),
      },
    ]);
    const [view] = await readGlances({ pool: fakePool() as never, registry, ctx: {} as never });
    expect(view!.card).toEqual({ value: '70°F', caption: 'Clear · Somerset', trend: { label: 'Next 12 hours', points: [70, 69, 66] }, foot: 'High 74° · Low 58°' });
    expect(cardOf({ caption: 'no figure' })).toBeUndefined();
    expect(cardOf('nope')).toBeUndefined();
    expect(cardOf({ value: '18°C', trend: { label: 'x', points: [1] }, caption: 'y'.repeat(50) })).toEqual({ value: '18°C', caption: `${'y'.repeat(39)}…` });
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

describe('what the owner closed on Home', () => {
  it('keeps one version per slot beside the hidden glances, shows it again on null, and refuses a bad slot or token', async () => {
    const pool = fakePool();
    const registry = registryWith(glances);
    await setGlanceHidden({ pool: pool as never, registry }, 'weather.now', true);
    expect((await setHomeDismissed(pool as never, 'digest', '2026-09-20T00:00:00Z')).status).toBe(200);
    await setHomeDismissed(pool as never, 'watcher-error:mail-watch', 'IMAP timed out');
    expect(pool.rows.get('home')).toEqual({
      hiddenGlances: ['weather.now'],
      dismissed: { digest: '2026-09-20T00:00:00Z', 'watcher-error:mail-watch': 'IMAP timed out' },
    });
    // The next week's digest is a new version: the slot moves on to it.
    await setHomeDismissed(pool as never, 'digest', '2026-09-27T00:00:00Z');
    expect((await readHomeDismissed(pool as never)).digest).toBe('2026-09-27T00:00:00Z');
    await setHomeDismissed(pool as never, 'digest', null);
    expect(await readHomeDismissed(pool as never)).toEqual({ 'watcher-error:mail-watch': 'IMAP timed out' });
    expect((await setHomeDismissed(pool as never, 'Bad Slot', 'x')).status).toBe(400);
    expect((await setHomeDismissed(pool as never, 'digest', '')).status).toBe(400);
    expect((await setHomeDismissed(pool as never, 'digest', undefined)).status).toBe(400);
  });

  it('keeps at most the newest HOME_DISMISSED_MAX slots', async () => {
    const pool = fakePool();
    for (let i = 0; i <= HOME_DISMISSED_MAX; i += 1) await setHomeDismissed(pool as never, `connection:c${i}`, 'x');
    const kept = await readHomeDismissed(pool as never);
    expect(Object.keys(kept)).toHaveLength(HOME_DISMISSED_MAX);
    expect(kept['connection:c0']).toBeUndefined();
    expect(kept[`connection:c${HOME_DISMISSED_MAX}`]).toBe('x');
  });
});
