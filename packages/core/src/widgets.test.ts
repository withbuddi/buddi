/** Widgets: checked at register, produced through the plugin's host on a read-only pool, bodies cut to what the page draws. */
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './registry.js';
import { parseWidgets, statOfGlanceCard, widgetBodyOf, type WidgetDefinition } from './widgets.js';
import type { PageDescriptor } from './pages.js';

const produce = async () => ({ kind: 'text' as const, text: 'hi' });
const page = { id: 'weather', title: 'Weather', place: 'rail', icon: 'sun', body: [{ kind: 'notice', text: 'x' }] } as unknown as PageDescriptor;
const parse = (widgets: unknown) => parseWidgets('demo', widgets, { pages: ['weather'], taken: () => false });

describe('parseWidgets', () => {
  it('takes a good declaration, clamps the refresh and defaults it to ten minutes', () => {
    const [a, b] = parse([
      { id: 'demo.now', title: 'Now', sizes: ['small', 'medium'], refreshSeconds: 5, link: { page: 'weather' }, produce },
      { id: 'demo.later', title: 'Later', sizes: ['medium'], sensitive: true, produce },
    ]);
    expect(a).toMatchObject({ id: 'demo.now', plugin: 'demo', sizes: ['small', 'medium'], refreshSeconds: 60, link: { page: 'weather' } });
    expect(b).toMatchObject({ refreshSeconds: 600, sensitive: true });
    expect(parse([{ id: 'demo.x', title: 'X', sizes: ['small'], refreshSeconds: 1e9, produce }])[0]!.refreshSeconds).toBe(86_400);
  });

  it.each([
    [{ id: 'other.now', title: 'T', sizes: ['small'], produce }, /must be named demo\.<name>/],
    [{ id: 'demo.Now', title: 'T', sizes: ['small'], produce }, /must be named/],
    [{ id: 'demo.now', title: '', sizes: ['small'], produce }, /needs a title/],
    [{ id: 'demo.now', title: 'x'.repeat(41), sizes: ['small'], produce }, /needs a title/],
    [{ id: 'demo.now', title: 'T', sizes: [], produce }, /sizes must list/],
    [{ id: 'demo.now', title: 'T', sizes: ['large'], produce }, /sizes must list/],
    [{ id: 'demo.now', title: 'T', sizes: ['small', 'small'], produce }, /sizes must list/],
    [{ id: 'demo.now', title: 'T', sizes: ['small'] }, /needs a produce function/],
    [{ id: 'demo.now', title: 'T', sizes: ['small'], link: { page: 'nowhere' }, produce }, /not a page of this plugin/],
    [{ id: 'demo.now', title: 'T', sizes: ['small'], refreshSeconds: 'often', produce }, /refreshSeconds must be a number/],
  ])('refuses %o', (widget, message) => {
    expect(() => parse([widget])).toThrow(message);
  });

  it('refuses the same id twice, in one plugin or across plugins', () => {
    const w = { id: 'demo.now', title: 'T', sizes: ['small'], produce };
    expect(() => parse([w, w])).toThrow(/declared twice/);
    expect(() => parseWidgets('demo', [w], { pages: [], taken: (id) => id === 'demo.now' })).toThrow(/declared twice/);
  });
});

describe('widgetBodyOf', () => {
  it('passes each kind through, cut to size', () => {
    const stat = widgetBodyOf({ kind: 'stat', icon: 'sun', value: '18°C', caption: 'c'.repeat(50), trend: { label: 'Next', points: [1, Number.NaN, 2, 3] }, foot: 'High 20°' });
    expect(stat).toEqual({ ok: true, body: { kind: 'stat', icon: 'sun', value: '18°C', caption: `${'c'.repeat(39)}…`, trend: { label: 'Next', points: [1, 2, 3] }, foot: 'High 20°' } });
    const list = widgetBodyOf({ kind: 'list', rows: [{ title: 'A', side: '09:30', tone: 'loud' }, { sub: 'no title' }, { title: 'B' }, { title: 'C' }, { title: 'D' }], more: '1 more' });
    expect(list).toEqual({ ok: true, body: { kind: 'list', rows: [{ title: 'A', side: '09:30' }, { title: 'B' }, { title: 'C' }], more: '1 more' } });
    const strip = widgetBodyOf({ kind: 'strip', value: '18°', items: Array.from({ length: 10 }, (_, i) => ({ label: `${i}h`, icon: i === 0 ? 'rocket' : 'rain', value: `${i}°` })) });
    expect(strip.ok && strip.body.kind === 'strip' ? strip.body.items.length : 0).toBe(8);
    expect(strip.ok && strip.body.kind === 'strip' ? strip.body.items[0] : null).toEqual({ label: '0h', value: '0°' });
    expect(widgetBodyOf({ kind: 'progress', value: '€1,284', ratio: 1.4, tone: 'accent' })).toEqual({ ok: true, body: { kind: 'progress', value: '€1,284', ratio: 1, tone: 'accent' } });
    expect(widgetBodyOf({ kind: 'text', icon: 'mail', text: '  Two   spaces ' })).toEqual({ ok: true, body: { kind: 'text', icon: 'mail', text: 'Two spaces' } });
  });

  it('refuses what it cannot draw, saying why', () => {
    expect(widgetBodyOf(null)).toMatchObject({ ok: false });
    expect(widgetBodyOf({ kind: 'html', html: '<b>x</b>' })).toMatchObject({ ok: false, reason: expect.stringMatching(/not "html"/) });
    expect(widgetBodyOf({ kind: 'stat', caption: 'no value' })).toMatchObject({ ok: false, reason: 'a stat needs a value' });
    expect(widgetBodyOf({ kind: 'list', rows: [] })).toMatchObject({ ok: false });
    expect(widgetBodyOf({ kind: 'strip', items: [{ label: 'x' }] })).toMatchObject({ ok: false });
    expect(widgetBodyOf({ kind: 'progress', value: '1', ratio: Number.NaN })).toMatchObject({ ok: false });
    expect(widgetBodyOf({ kind: 'text', text: ' ' })).toMatchObject({ ok: false });
  });

  it('turns an older glance card into a stat', () => {
    expect(statOfGlanceCard({ value: '70°F', caption: 'Clear', trend: { label: 'Next 12 hours', points: [70, 69] }, foot: 'High 74°' }, 'sun')).toEqual({
      kind: 'stat', icon: 'sun', value: '70°F', caption: 'Clear', trend: { label: 'Next 12 hours', points: [70, 69] }, foot: 'High 74°',
    });
    expect(statOfGlanceCard(undefined, 'sun')).toBeUndefined();
    expect(statOfGlanceCard({ value: '' }, 'sun')).toBeUndefined();
  });
});

describe('a clocks body', () => {
  it('keeps zones and labels, cuts labels, keeps four faces and a known time format', () => {
    const faces = ['Europe/Lisbon', 'America/New_York', 'Asia/Kolkata', 'Asia/Kathmandu', 'Pacific/Auckland'].map((zone, i) => ({ label: i === 0 ? 'L'.repeat(40) : zone, zone }));
    const checked = widgetBodyOf({ kind: 'clocks', home: 'Europe/Lisbon', clocks: faces, time: '12h' });
    expect(checked.ok).toBe(true);
    if (!checked.ok || checked.body.kind !== 'clocks') return;
    expect(checked.body.clocks).toHaveLength(4);
    expect(checked.body.clocks[0]!.label).toHaveLength(24);
    expect(checked.body.clocks[0]!.label.endsWith('…')).toBe(true);
    expect(checked.body.time).toBe('12h');
    expect(widgetBodyOf({ kind: 'clocks', home: 'UTC', clocks: [{ label: 'UTC', zone: 'UTC' }], time: 'sundial' })).toEqual({ ok: true, body: { kind: 'clocks', home: 'UTC', clocks: [{ label: 'UTC', zone: 'UTC' }] } });
  });

  it('drops faces with an unknown zone or no label, and refuses a body with none left or no home', () => {
    const checked = widgetBodyOf({ kind: 'clocks', home: 'Europe/Paris', clocks: [{ label: 'Mars', zone: 'Mars/Olympus' }, { label: 'Offset', zone: '+02:00' }, { zone: 'Asia/Tokyo' }, { label: 'Tokyo', zone: 'Asia/Tokyo' }] });
    expect(checked).toEqual({ ok: true, body: { kind: 'clocks', home: 'Europe/Paris', clocks: [{ label: 'Tokyo', zone: 'Asia/Tokyo' }] } });
    expect(widgetBodyOf({ kind: 'clocks', home: 'Europe/Paris', clocks: [{ label: 'Mars', zone: 'Mars/Olympus' }] })).toMatchObject({ ok: false });
    expect(widgetBodyOf({ kind: 'clocks', home: 'Nowhere/At_all', clocks: [{ label: 'Tokyo', zone: 'Asia/Tokyo' }] })).toMatchObject({ ok: false, reason: expect.stringMatching(/home/) });
    expect(widgetBodyOf({ kind: 'clocks', clocks: [{ label: 'Tokyo', zone: 'Asia/Tokyo' }] })).toMatchObject({ ok: false });
  });

  it('keeps a face’s coordinates when both are sound, and drops them otherwise (the face stays)', () => {
    const checked = widgetBodyOf({
      kind: 'clocks',
      home: 'Europe/Paris',
      clocks: [
        { label: 'Tokyo', zone: 'Asia/Tokyo', latitude: 35.68, longitude: 139.69 },
        { label: 'Half', zone: 'Asia/Tokyo', latitude: 35.68 },
        { label: 'Off', zone: 'Asia/Tokyo', latitude: 135, longitude: 10 },
        { label: 'Text', zone: 'Asia/Tokyo', latitude: '35', longitude: '139' },
      ],
    });
    expect(checked).toEqual({
      ok: true,
      body: {
        kind: 'clocks',
        home: 'Europe/Paris',
        clocks: [
          { label: 'Tokyo', zone: 'Asia/Tokyo', latitude: 35.68, longitude: 139.69 },
          { label: 'Half', zone: 'Asia/Tokyo' },
          { label: 'Off', zone: 'Asia/Tokyo' },
          { label: 'Text', zone: 'Asia/Tokyo' },
        ],
      },
    });
  });
});

describe('the registry', () => {
  it('lists widgets with their plugin, produces them read-only through the host, and forgets them on unregister', async () => {
    let seen: { db: unknown; buddi: unknown; size: string } | null = null;
    const widget: WidgetDefinition = {
      id: 'demo.now', title: 'Now', sizes: ['small'],
      async produce(ctx, request) {
        seen = { db: (ctx as unknown as { db: unknown }).db, buddi: ctx.buddi, size: request.size };
        return { kind: 'text', text: 'hi' };
      },
    };
    const registry = new ToolRegistry();
    registry.register({ name: 'demo', version: '1', schema: 'demo', migrationsDir: '', tools: [], pages: [page], widgets: [widget] });
    expect(registry.widgets().map((w) => [w.id, w.plugin, w.refreshSeconds])).toEqual([['demo.now', 'demo', 600]]);
    const pool = { query: async () => ({ rows: [] }) };
    expect(await registry.widget('demo.now')!.produce({ db: pool } as never, { size: 'small' })).toEqual({ kind: 'text', text: 'hi' });
    expect(seen!.size).toBe('small');
    expect(seen!.db).not.toBe(pool); // the read-only wrapper
    expect(seen!.buddi).toBeDefined();
    expect(() => registry.register({ name: 'other', version: '1', schema: 'other', migrationsDir: '', tools: [], widgets: [{ ...widget, id: 'demo.now' }] })).toThrow(/must be named other/);
    registry.unregister('demo');
    expect(registry.widgets()).toEqual([]);
    expect(registry.widget('demo.now')).toBeUndefined();
  });
});
