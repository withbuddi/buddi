/** Home's widgets: the default and saved layouts, the cache, timeouts and failures kept to their own frame, older glance cards. */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, type HomeContribution, type PageDescriptor, type WidgetDefinition } from '@buddi/core';
import { createWidgets, widgetsRoute, WIDGETS_SETTINGS_KEY } from './widgets.js';

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

const page = { id: 'weather', title: 'Weather', place: 'rail', icon: 'sun', body: [{ kind: 'notice', text: 'x' }] } as unknown as PageDescriptor;

function setup(opts: { widgets?: WidgetDefinition[]; home?: HomeContribution[]; timeoutMs?: number } = {}) {
  const registry = new ToolRegistry();
  registry.register({ name: 'demo', version: '1', schema: 'demo', migrationsDir: '', tools: [], pages: [page], widgets: opts.widgets ?? [], home: opts.home ?? [] });
  const pool = fakePool();
  let now = new Date('2026-10-01T08:00:00Z');
  const service = createWidgets({ pool: pool as never, registry, ctx: { db: pool } as never, now: () => now, timeoutMs: opts.timeoutMs ?? 50 });
  return { service, pool, registry, tick: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

const text = (t: string) => ({ kind: 'text' as const, text: t });

describe('widgets', () => {
  it('lays out every widget that is not sensitive by default, with a link resolved, and its body', async () => {
    const { service } = setup({
      widgets: [
        { id: 'demo.now', title: 'Now', sizes: ['medium', 'small'], link: { page: 'weather' }, produce: async (_ctx, { size }) => text(`at ${size}`) },
        { id: 'demo.money', title: 'Money', sizes: ['small'], sensitive: true, produce: async () => text('€1') },
      ],
    });
    const answer = await service.answer();
    expect(answer.arranged).toBe(false);
    expect(answer.available).toEqual([
      { id: 'demo.now', plugin: 'demo', title: 'Now', sizes: ['medium', 'small'], link: { plugin: 'demo', page: 'weather', place: 'rail' } },
      { id: 'demo.money', plugin: 'demo', title: 'Money', sizes: ['small'], sensitive: true },
    ]);
    expect(answer.layout).toEqual([{ id: 'demo.now', size: 'medium' }]);
    expect(answer.widgets).toEqual({ 'demo.now': { state: 'ok', body: text('at medium'), updatedAt: '2026-10-01T08:00:00.000Z' } });
  });

  it('saves the owner layout and reads it back, refusing unknown ids, repeats and sizes a widget does not offer', async () => {
    const { service, pool } = setup({
      widgets: [
        { id: 'demo.a', title: 'A', sizes: ['small', 'medium'], produce: async () => text('a') },
        { id: 'demo.b', title: 'B', sizes: ['small'], produce: async () => null },
      ],
    });
    const saved = await service.saveLayout({ layout: [{ id: 'demo.b', size: 'small' }, { id: 'demo.a', size: 'medium' }] });
    expect(saved.status).toBe(200);
    expect(pool.rows.get(WIDGETS_SETTINGS_KEY)).toEqual({ layout: [{ id: 'demo.b', size: 'small' }, { id: 'demo.a', size: 'medium' }] });
    const answer = await service.answer();
    expect(answer).toMatchObject({ arranged: true, layout: [{ id: 'demo.b', size: 'small' }, { id: 'demo.a', size: 'medium' }] });
    expect(answer.widgets['demo.b']).toEqual({ state: 'empty', updatedAt: '2026-10-01T08:00:00.000Z' });
    expect((await service.saveLayout({ layout: [{ id: 'demo.x', size: 'small' }] })).status).toBe(400);
    expect((await service.saveLayout({ layout: [{ id: 'demo.a', size: 'small' }, { id: 'demo.a', size: 'small' }] })).status).toBe(400);
    expect((await service.saveLayout({ layout: [{ id: 'demo.b', size: 'medium' }] })).body).toEqual({ error: 'demo.b comes in small, not "medium"' });
    expect((await service.saveLayout({ nope: true })).status).toBe(400);
    // An empty layout is a choice, not "never arranged".
    await service.saveLayout({ layout: [] });
    expect(await service.answer()).toMatchObject({ arranged: true, layout: [], widgets: {} });
  });

  it('drops a saved widget whose plugin is gone and puts a size it no longer offers back to its first', async () => {
    const { service, pool } = setup({ widgets: [{ id: 'demo.a', title: 'A', sizes: ['small'], produce: async () => text('a') }] });
    pool.rows.set(WIDGETS_SETTINGS_KEY, { layout: [{ id: 'gone.x', size: 'small' }, { id: 'demo.a', size: 'medium' }, { id: 'demo.a', size: 'small' }, 'junk'] });
    expect((await service.answer()).layout).toEqual([{ id: 'demo.a', size: 'small' }]);
  });

  it('produces at most once per refresh, and again after it', async () => {
    let calls = 0;
    const { service, tick } = setup({ widgets: [{ id: 'demo.a', title: 'A', sizes: ['small'], refreshSeconds: 120, produce: async () => text(`call ${++calls}`) }] });
    await Promise.all([service.answer(), service.answer()]);
    await service.answer();
    expect(calls).toBe(1);
    tick(119_000);
    await service.answer();
    expect(calls).toBe(1);
    tick(2_000);
    expect((await service.answer()).widgets['demo.a']!.body).toEqual(text('call 2'));
  });

  it('keeps a failure to its own frame: a timeout and a throw are errors, a bad body says why, the others still draw', async () => {
    const { service } = setup({
      widgets: [
        { id: 'demo.slow', title: 'Slow', sizes: ['small'], produce: () => new Promise(() => {}) },
        { id: 'demo.broken', title: 'Broken', sizes: ['small'], produce: async () => { throw new Error('down'); } },
        { id: 'demo.html', title: 'Html', sizes: ['small'], produce: async () => ({ kind: 'html', html: '<b>' }) as never },
        { id: 'demo.fine', title: 'Fine', sizes: ['small'], produce: async () => text('fine') },
      ],
    });
    const { widgets } = await service.answer();
    expect(widgets['demo.slow']).toEqual({ state: 'error', error: 'did not answer in 0 seconds' });
    expect(widgets['demo.broken']).toEqual({ state: 'error', error: 'down' });
    expect(widgets['demo.html']).toMatchObject({ state: 'error', error: expect.stringMatching(/not "html"/) });
    expect(widgets['demo.fine']).toMatchObject({ state: 'ok', body: text('fine') });
  });

  it('marks a widget stale when a refresh fails after a good answer, retries after a minute, and Try again forces it', async () => {
    let fail = false;
    let calls = 0;
    const { service, tick } = setup({ widgets: [{ id: 'demo.a', title: 'A', sizes: ['small'], refreshSeconds: 3600, produce: async () => { calls++; if (fail) throw new Error('offline'); return text('good'); } }] });
    await service.answer();
    fail = true;
    tick(3_600_000);
    expect((await service.answer()).widgets['demo.a']).toEqual({ state: 'stale', body: text('good'), updatedAt: '2026-10-01T08:00:00.000Z', error: 'offline' });
    tick(30_000);
    await service.answer();
    expect(calls).toBe(2);
    tick(31_000);
    await service.answer();
    expect(calls).toBe(3);
    fail = false;
    const forced = await widgetsRoute(service, { method: 'POST', path: '/api/widgets/demo.a/refresh', body: {} });
    expect((forced.body as { widgets: Record<string, unknown> }).widgets['demo.a']).toMatchObject({ state: 'ok', body: text('good') });
    expect(calls).toBe(4);
  });

  it('offers an older glance card as a small widget, unless a widget of that id is declared, and leaves out one the owner hid', async () => {
    const glance = (id: string, card: boolean): HomeContribution => ({
      id, title: `Glance ${id}`, placement: 'glance',
      produce: async () => ({ icon: 'sun', text: '18°C Lyon', link: { route: { page: 'weather' } }, ...(card ? { card: { value: '18°C', caption: 'Clear · Lyon' } } : {}) }),
    });
    const { service, pool } = setup({
      home: [glance('demo.card', true), glance('demo.line', false), glance('demo.twin', true), glance('demo.hid', true)],
      widgets: [{ id: 'demo.twin', title: 'Twin', sizes: ['medium'], produce: async () => text('declared') }],
    });
    pool.rows.set('home', { hiddenGlances: ['demo.hid'] });
    const answer = await service.answer();
    expect(answer.available.map((w) => w.id)).toEqual(['demo.twin', 'demo.card', 'demo.hid']);
    expect(answer.available[1]).toEqual({ id: 'demo.card', plugin: 'demo', title: 'Glance demo.card', sizes: ['small'], link: { plugin: 'demo', page: 'weather', place: 'rail' } });
    expect(answer.layout).toEqual([{ id: 'demo.twin', size: 'medium' }, { id: 'demo.card', size: 'small' }]);
    expect(answer.widgets['demo.card']).toMatchObject({ state: 'ok', body: { kind: 'stat', icon: 'sun', value: '18°C', caption: 'Clear · Lyon' } });
    expect(answer.widgets['demo.twin']).toMatchObject({ body: text('declared') });
    // A glance id can be saved, as the card it sends.
    expect((await service.saveLayout({ layout: [{ id: 'demo.card', size: 'small' }] })).status).toBe(200);
  });

  it('routes by method and path', async () => {
    const { service } = setup();
    expect((await widgetsRoute(service, { method: 'GET', path: '/api/widgets', body: {} })).status).toBe(200);
    expect((await widgetsRoute(service, { method: 'POST', path: '/api/widgets', body: {} })).status).toBe(405);
    expect((await widgetsRoute(service, { method: 'GET', path: '/api/widgets/layout', body: {} })).status).toBe(405);
    expect((await widgetsRoute(service, { method: 'PUT', path: '/api/widgets/layout', body: { layout: [] } })).status).toBe(200);
    expect((await widgetsRoute(service, { method: 'GET', path: '/api/widgets/x/refresh', body: {} })).status).toBe(405);
    expect((await widgetsRoute(service, { method: 'GET', path: '/api/widgets/nope', body: {} })).status).toBe(404);
  });
});
