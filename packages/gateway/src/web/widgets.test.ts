/**
 * Widgets: the default and saved placements per surface, settings checked and
 * handed to produce, several placements of one widget, the lock screen's
 * limits, the one conversion from widgets v1, the cache, failures kept to
 * their own frame, older glance cards, the World clock.
 */
import { describe, expect, it } from 'vitest';
import { ToolRegistry, type HomeContribution, type PageDescriptor, type WidgetDefinition } from '@buddi/core';
import { createWidgets, readStoredWidgets, widgetsRoute, WIDGETS_SETTINGS_KEY, type WidgetsAnswer } from './widgets.js';

const PLACES = [
  { id: 'home', label: 'Home', address: null, name: 'Lyon, France', latitude: 45.76, longitude: 4.84, timezone: 'Europe/Paris' },
  { id: 'work', label: 'Work', address: null, name: 'Grenoble, France', latitude: 45.19, longitude: 5.72, timezone: 'Europe/Paris' },
  { id: 'ben', label: 'Ben', address: null, name: 'Brooklyn, New York, United States', latitude: 40.65, longitude: -73.95, timezone: 'America/New_York' },
];

/** `core.web_settings` as a map, the owner's places and profile, answering the statements the service uses. */
function fakePool(opts: { places?: boolean; timeFormat?: '12h' | '24h' | null } = {}) {
  const rows = new Map<string, unknown>();
  return {
    rows,
    async query(sql: string, params: unknown[] = []) {
      if (sql.startsWith('select value')) {
        const value = rows.get(params[0] as string);
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (/from core\.owner_places/.test(sql)) {
        return { rows: (opts.places ? PLACES : []).map((p) => ({ ...p, place_name: p.name })) };
      }
      if (/from core\.owner where/.test(sql)) {
        return { rows: [{ time_format: opts.timeFormat ?? null }] };
      }
      if (/^\s*insert into core\.web_settings/i.test(sql)) {
        rows.set(params[0] as string, JSON.parse(params[1] as string));
        return { rows: [] };
      }
      throw Object.assign(new Error(`unexpected: ${sql.slice(0, 40)}`), { code: '42P01' });
    },
  };
}

const page = { id: 'weather', title: 'Weather', place: 'rail', icon: 'sun', body: [{ kind: 'notice', text: 'x' }] } as unknown as PageDescriptor;

function setup(opts: { widgets?: WidgetDefinition[]; home?: HomeContribution[]; timeoutMs?: number; places?: boolean; timeFormat?: '12h' | '24h' | null } = {}) {
  const registry = new ToolRegistry();
  registry.register({ name: 'demo', version: '1', schema: 'demo', migrationsDir: '', tools: [], pages: [page], widgets: opts.widgets ?? [], home: opts.home ?? [] });
  const pool = fakePool(opts);
  let now = new Date('2026-10-01T08:00:00Z');
  const service = createWidgets({ pool: pool as never, registry, ctx: { db: pool, timezone: 'Europe/Paris' } as never, now: () => now, timeoutMs: opts.timeoutMs ?? 50 });
  return { service, pool, registry, tick: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

const text = (t: string) => ({ kind: 'text' as const, text: t });
const ok = (r: { status: number; body: unknown }): WidgetsAnswer => {
  if (r.status !== 200) throw new Error(JSON.stringify(r.body));
  return r.body as WidgetsAnswer;
};
const errorOf = (r: { status: number; body: unknown }): string => (r.body as { error: string }).error;

describe('widgets', () => {
  it('places every widget that is not sensitive on Home by default, the World clock offered but not placed', async () => {
    const { service } = setup({
      widgets: [
        { id: 'demo.now', title: 'Now', sizes: ['medium', 'small'], link: { page: 'weather' }, produce: async (_ctx, { size }) => text(`at ${size}`) },
        { id: 'demo.money', title: 'Money', sizes: ['small'], sensitive: true, produce: async () => text('€1') },
      ],
    });
    const answer = await service.answer();
    expect(answer.arranged).toEqual({ home: false, lock: false });
    expect(answer.available.map((w) => w.id)).toEqual(['demo.now', 'demo.money', 'buddi.clock']);
    expect(answer.available[0]).toEqual({ id: 'demo.now', plugin: 'demo', title: 'Now', sizes: ['medium', 'small'], link: { plugin: 'demo', page: 'weather', place: 'rail' } });
    expect(answer.available[2]).toMatchObject({ id: 'buddi.clock', plugin: 'buddi', title: 'World clock', builtIn: true, settings: [{ key: 'style', kind: 'select', default: 'digital' }, { key: 'places', kind: 'place' }, { key: 'time', kind: 'timeFormat' }] });
    expect(answer.home).toEqual([{ key: 'd-demo-now', widget: 'demo.now', size: 'medium', settings: {}, label: 'Now' }]);
    expect(answer.views).toEqual({ 'd-demo-now': { state: 'ok', body: text('at medium'), updatedAt: '2026-10-01T08:00:00.000Z' } });
    // Until the lock screen is arranged it shows Home's first four that may show there.
    expect(answer.lock.map((p) => [p.key, p.widget])).toEqual([['l-d-demo-now', 'demo.now']]);
  });

  it('hands each placement its own resolved settings: the same widget twice, one cache per setting', async () => {
    const seen: unknown[] = [];
    const { service, pool } = setup({
      places: true,
      timeFormat: '12h',
      widgets: [{
        id: 'demo.weather', title: 'Weather', sizes: ['small', 'medium'],
        settings: [
          { key: 'place', kind: 'place', label: 'Place', inTitle: true },
          { key: 'units', kind: 'select', label: 'Units', options: [{ value: 'c', label: '°C' }, { value: 'f', label: '°F' }] },
          { key: 'time', kind: 'timeFormat', label: 'Times' },
        ],
        produce: async (_ctx, { settings = {} }) => {
          seen.push(settings);
          return text(`${(settings.place as { label: string }).label} ${settings.units} ${settings.time}`);
        },
      }],
    });
    const saved = ok(await service.saveSurface('home', {
      placements: [
        { widget: 'demo.weather', size: 'small', settings: {} },
        { widget: 'demo.weather', size: 'small', settings: { place: { place: 'work' }, units: 'f', time: '24h' } },
      ],
    }));
    expect(saved.home.map((p) => p.label)).toEqual(['Weather', 'Weather · Work']);
    const [a, b] = saved.home;
    expect(a!.key).not.toEqual(b!.key);
    expect(saved.views[a!.key]!.body).toEqual(text('Home c 12h'));
    expect(saved.views[b!.key]!.body).toEqual(text('Work f 24h'));
    // Kept: only what differs from the defaults, the place by id.
    expect(pool.rows.get(WIDGETS_SETTINGS_KEY)).toMatchObject({
      version: 2,
      home: [{ widget: 'demo.weather', size: 'small', settings: {} }, { widget: 'demo.weather', size: 'small', settings: { place: { place: 'work' }, units: 'f', time: '24h' } }],
    });
    // Read again: the same keys, nothing produced twice.
    const again = await service.answer();
    expect(again.home.map((p) => p.key)).toEqual([a!.key, b!.key]);
    expect(seen).toHaveLength(2);
  });

  it('refuses a placement it cannot keep, saying why', async () => {
    const { service } = setup({
      places: true,
      widgets: [
        { id: 'demo.a', title: 'A', sizes: ['small'], settings: [{ key: 'units', kind: 'select', label: 'Units', options: [{ value: 'c', label: '°C' }] }], produce: async () => text('a') },
        { id: 'demo.money', title: 'Money', sizes: ['small'], sensitive: true, produce: async () => text('€1') },
      ],
    });
    expect(errorOf(await service.saveSurface('home', { placements: [{ widget: 'demo.x', size: 'small' }] }))).toMatch(/no widget is installed with the id demo.x/);
    expect(errorOf(await service.saveSurface('home', { placements: [{ widget: 'demo.a', size: 'medium' }] }))).toBe('demo.a comes in small, not "medium"');
    expect(errorOf(await service.saveSurface('home', { placements: [{ widget: 'demo.a', size: 'small', settings: { units: 'k' } }] }))).toBe('A: Units: "k" is not one of its choices');
    expect(errorOf(await service.saveSurface('home', { nope: true }))).toMatch(/placements/);
    // The lock screen: four at most, never a sensitive one.
    expect(errorOf(await service.saveSurface('lock', { placements: [{ widget: 'demo.money', size: 'small' }] }))).toMatch(/Money is sensitive/);
    expect(errorOf(await service.saveSurface('lock', { placements: Array.from({ length: 5 }, () => ({ widget: 'demo.a', size: 'small' })) }))).toMatch(/at most 4/);
    expect(ok(await service.saveSurface('lock', { placements: Array.from({ length: 4 }, () => ({ widget: 'demo.a', size: 'small' })) })).lock).toHaveLength(4);
  });

  it('keeps each surface its own: the lock screen arranged apart from Home, an empty list a choice', async () => {
    const { service, pool } = setup({
      widgets: [
        { id: 'demo.a', title: 'A', sizes: ['small', 'medium'], produce: async () => text('a') },
        { id: 'demo.b', title: 'B', sizes: ['small'], produce: async () => text('b') },
      ],
    });
    ok(await service.saveSurface('lock', { placements: [{ widget: 'demo.b', size: 'small' }] }));
    // Home stays the default while only the lock screen was arranged.
    let answer = await service.answer({ surface: 'lock' });
    expect(answer.arranged).toEqual({ home: false, lock: true });
    expect(answer.home.map((p) => p.widget)).toEqual(['demo.a', 'demo.b']);
    expect(answer.lock.map((p) => p.widget)).toEqual(['demo.b']);
    expect(Object.keys(answer.views)).toEqual([answer.lock[0]!.key]);
    ok(await service.saveSurface('home', { placements: [] }));
    answer = await service.answer();
    expect(answer).toMatchObject({ arranged: { home: true, lock: true }, home: [], views: {} });
    expect(answer.lock.map((p) => p.widget)).toEqual(['demo.b']);
    expect(pool.rows.get(WIDGETS_SETTINGS_KEY)).toMatchObject({ version: 2, home: [], lock: [{ widget: 'demo.b' }] });
  });

  it('reads the widgets v1 layout as Home’s placements once, and writes the new shape on the next save', async () => {
    expect(readStoredWidgets({ layout: [{ id: 'demo.a', size: 'medium' }, { id: 'demo.a', size: 'small' }, { id: 'gone.x' }, 'junk'] })).toEqual({
      home: [
        { key: 'v1-demo-a', widget: 'demo.a', size: 'medium', settings: {} },
        { key: 'v1-gone-x', widget: 'gone.x', size: 'small', settings: {} },
      ],
    });
    const { service, pool } = setup({ widgets: [{ id: 'demo.a', title: 'A', sizes: ['small'], produce: async () => text('a') }] });
    pool.rows.set(WIDGETS_SETTINGS_KEY, { layout: [{ id: 'gone.x', size: 'small' }, { id: 'demo.a', size: 'medium' }] });
    const answer = await service.answer();
    // A plugin gone is left out; a size it no longer offers goes back to its first.
    expect(answer.home).toEqual([{ key: 'v1-demo-a', widget: 'demo.a', size: 'small', settings: {}, label: 'A' }]);
    expect(answer.arranged.home).toBe(true);
    ok(await service.saveSurface('home', { placements: answer.home }));
    expect(pool.rows.get(WIDGETS_SETTINGS_KEY)).toEqual({ version: 2, home: [{ key: 'v1-demo-a', widget: 'demo.a', size: 'small', settings: {} }] });
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
    expect((await service.answer()).views['d-demo-a']!.body).toEqual(text('call 2'));
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
    const { views } = await service.answer();
    expect(views['d-demo-slow']).toEqual({ state: 'error', error: 'did not answer in 0 seconds' });
    expect(views['d-demo-broken']).toEqual({ state: 'error', error: 'down' });
    expect(views['d-demo-html']).toMatchObject({ state: 'error', error: expect.stringMatching(/not "html"/) });
    expect(views['d-demo-fine']).toMatchObject({ state: 'ok', body: text('fine') });
  });

  it('marks a placement stale when a refresh fails after a good answer, retries after a minute, and Try again forces it', async () => {
    let fail = false;
    let calls = 0;
    const { service, tick } = setup({ widgets: [{ id: 'demo.a', title: 'A', sizes: ['small'], refreshSeconds: 3600, produce: async () => { calls++; if (fail) throw new Error('offline'); return text('good'); } }] });
    await service.answer();
    fail = true;
    tick(3_600_000);
    expect((await service.answer()).views['d-demo-a']).toEqual({ state: 'stale', body: text('good'), updatedAt: '2026-10-01T08:00:00.000Z', error: 'offline' });
    tick(30_000);
    await service.answer();
    expect(calls).toBe(2);
    tick(31_000);
    await service.answer();
    expect(calls).toBe(3);
    fail = false;
    const forced = await widgetsRoute(service, { method: 'POST', path: '/api/widgets/d-demo-a/refresh', body: {} });
    expect((forced.body as WidgetsAnswer).views['d-demo-a']).toMatchObject({ state: 'ok', body: text('good') });
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
    expect(answer.available.map((w) => w.id)).toEqual(['demo.twin', 'buddi.clock', 'demo.card', 'demo.hid']);
    expect(answer.home.map((p) => [p.widget, p.size])).toEqual([['demo.twin', 'medium'], ['demo.card', 'small']]);
    expect(answer.views['d-demo-card']).toMatchObject({ state: 'ok', body: { kind: 'stat', icon: 'sun', value: '18°C', caption: 'Clear · Lyon' } });
    // A glance id can be placed, as the card it sends.
    expect((await service.saveSurface('home', { placements: [{ widget: 'demo.card', size: 'small' }] })).status).toBe(200);
  });

  it('reads a setting’s choices for the sheet, and previews unsaved settings through the same cache', async () => {
    let reads = 0;
    const { service } = setup({
      places: true,
      widgets: [{
        id: 'demo.mail', title: 'Waiting', sizes: ['small'],
        settings: [{ key: 'mailbox', kind: 'select', label: 'Mailbox', default: '', inTitle: true, options: async () => { reads++; return [{ value: '', label: 'All' }, { value: 'm1', label: 'sam@hey.com' }]; } }],
        produce: async (_ctx, { settings = {} }) => text(`in ${settings.mailbox || 'all'}`),
      }],
    });
    const sheet = await widgetsRoute(service, { method: 'GET', path: '/api/widgets/settings/demo.mail', body: {} });
    expect(sheet.body).toMatchObject({
      widget: 'demo.mail',
      fields: [{ key: 'mailbox', kind: 'select', options: [{ value: '', label: 'All' }, { value: 'm1', label: 'sam@hey.com' }] }],
      places: [{ id: 'home', label: 'Home' }, { id: 'work' }, { id: 'ben', timezone: 'America/New_York' }],
    });
    const preview = await widgetsRoute(service, { method: 'POST', path: '/api/widgets/preview', body: { widget: 'demo.mail', size: 'small', settings: { mailbox: 'm1' } } });
    expect(preview.body).toEqual({ view: { state: 'ok', body: text('in m1'), updatedAt: '2026-10-01T08:00:00.000Z' }, label: 'Waiting · sam@hey.com' });
    expect((await widgetsRoute(service, { method: 'POST', path: '/api/widgets/preview', body: { widget: 'demo.mail', size: 'small', settings: { mailbox: 'zz' } } })).status).toBe(400);
    expect((await widgetsRoute(service, { method: 'GET', path: '/api/widgets/settings/demo.none', body: {} })).status).toBe(404);
    expect(reads).toBeGreaterThan(0);
  });

  it('produces the World clock every time, with the placement’s places and format', async () => {
    const { service, tick } = setup({ places: true });
    const saved = ok(await service.saveSurface('home', { placements: [{ widget: 'buddi.clock', size: 'small', settings: { places: [{ place: 'ben' }], time: '12h' } }] }));
    const key = saved.home[0]!.key;
    expect(saved.views[key]!.body).toEqual({ kind: 'stat', icon: 'clock', value: '4:00 AM', caption: 'Ben · Brooklyn', foot: '6 h behind' });
    tick(60_000);
    expect((await service.answer()).views[key]!.body).toMatchObject({ value: '4:01 AM' });
  });

  it('draws the World clock Analog as a clocks body: the owner’s zone first, the style kept with the placement', async () => {
    const { service } = setup({ places: true });
    const saved = ok(await service.saveSurface('home', { placements: [{ widget: 'buddi.clock', size: 'medium', settings: { style: 'analog', places: [{ place: 'ben' }], time: '12h' } }] }));
    const placement = saved.home[0]!;
    expect(placement.settings).toMatchObject({ style: 'analog' });
    expect(saved.views[placement.key]!.body).toMatchObject({ kind: 'clocks', time: '12h', clocks: [{ zone: expect.any(String) }, { label: 'Ben', zone: 'America/New_York' }] });
    expect((await widgetsRoute(service, { method: 'PUT', path: '/api/widgets/home', body: { placements: [{ widget: 'buddi.clock', size: 'small', settings: { style: 'sundial' } }] } })).status).toBe(400);
  });

  it('reads Profile as the asking browser’s clock while the owner left Time on Auto', async () => {
    const auto = setup({ places: true, timeFormat: null });
    const placed = ok(await auto.service.saveSurface('home', { placements: [{ widget: 'buddi.clock', size: 'small', settings: { places: [{ place: 'ben' }] } }] }));
    const key = placed.home[0]!.key;
    expect(placed.views[key]!.body).toMatchObject({ value: '04:00' });
    expect((await auto.service.answer({ hour: '12' })).views[key]!.body).toMatchObject({ value: '4:00 AM' });
    // A format the owner picked wins over the browser.
    const picked = setup({ places: true, timeFormat: '24h' });
    const again = ok(await picked.service.saveSurface('home', { placements: [{ widget: 'buddi.clock', size: 'small', settings: { places: [{ place: 'ben' }] } }] }));
    expect((await picked.service.answer({ hour: '12' })).views[again.home[0]!.key]!.body).toMatchObject({ value: '04:00' });
  });

  it('routes by method and path', async () => {
    const { service } = setup();
    expect((await widgetsRoute(service, { method: 'GET', path: '/api/widgets', body: {} })).status).toBe(200);
    expect((await widgetsRoute(service, { method: 'GET', path: '/api/widgets', body: {}, query: new URLSearchParams('surface=lock') })).status).toBe(200);
    expect((await widgetsRoute(service, { method: 'POST', path: '/api/widgets', body: {} })).status).toBe(405);
    expect((await widgetsRoute(service, { method: 'GET', path: '/api/widgets/home', body: {} })).status).toBe(405);
    expect((await widgetsRoute(service, { method: 'PUT', path: '/api/widgets/home', body: { placements: [] } })).status).toBe(200);
    expect((await widgetsRoute(service, { method: 'PUT', path: '/api/widgets/lock', body: { placements: [] } })).status).toBe(200);
    expect((await widgetsRoute(service, { method: 'GET', path: '/api/widgets/preview', body: {} })).status).toBe(405);
    expect((await widgetsRoute(service, { method: 'GET', path: '/api/widgets/x/refresh', body: {} })).status).toBe(405);
    expect((await widgetsRoute(service, { method: 'GET', path: '/api/widgets/nope', body: {} })).status).toBe(404);
  });
});
