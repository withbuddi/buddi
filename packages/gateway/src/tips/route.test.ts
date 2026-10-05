import { describe, expect, it } from 'vitest';
import { facts } from '../__fixtures__/tip-facts.js';
import type { Facts, SettingsStore } from './facts.js';
import { TIPS_PAGES_CAP, TIPS_PAGES_KEY } from './facts.js';
import { TIPS_ENABLED_KEY, TIPS_STATE_KEY, tipsRoute } from './route.js';
import type { TipRule } from './rules.js';

function memoryStore(): SettingsStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    read: async <T>(key: string) => (data.has(key) ? (structuredClone(data.get(key)) as T) : null),
    write: async (key, value) => { data.set(key, structuredClone(value)); },
  };
}

const RULES: TipRule[] = [
  { id: 'a', when: (f) => f.groups === 0, holdsForDays: 0, text: 'Tip a.', action: { label: 'Do a', route: '#/a' }, cooldownDays: 7 },
  { id: 'b', when: () => true, holdsForDays: 0, text: 'Tip b.', action: { label: 'Do b', route: '#/b' }, cooldownDays: 7 },
];

function setup(over: Partial<Facts> = {}) {
  const store = memoryStore();
  let now = new Date('2026-09-01T10:00:00Z');
  const deps = { store, facts: async () => facts(over), now: () => now, timezone: 'UTC', rules: RULES };
  const call = (method: string, path: string, body?: Record<string, unknown>) => tipsRoute(deps, { method, path, ...(body ? { body } : {}) });
  return { store, call, tomorrow: () => { now = new Date(now.getTime() + 86_400_000); } };
}

describe('tips routes', () => {
  it('serves today’s tip, and remembers it was shown', async () => {
    const { store, call } = setup();
    const current = await call('GET', '/api/tips/current');
    expect(current).toEqual({ status: 200, body: { enabled: true, tip: { id: 'a', text: 'Tip a.', action: { label: 'Do a', route: '#/a' } } } });
    expect((store.data.get(TIPS_STATE_KEY) as any).a.shownAt).toBe('2026-09-01');
  });

  it('dismiss removes it for good; later puts it off', async () => {
    const { call, tomorrow } = setup();
    await call('GET', '/api/tips/current');
    expect(await call('POST', '/api/tips/a/dismiss')).toEqual({ status: 200, body: { ok: true } });
    expect((await call('GET', '/api/tips/current')).body).toMatchObject({ tip: null });
    tomorrow();
    expect((await call('GET', '/api/tips/current')).body).toMatchObject({ tip: { id: 'b' } });
    expect((await call('POST', '/api/tips/b/later')).status).toBe(200);
    expect((await call('GET', '/api/tips/current')).body).toMatchObject({ tip: null });
    tomorrow();
    expect((await call('GET', '/api/tips/current')).body).toMatchObject({ tip: null });
    expect((await call('POST', '/api/tips/nope/dismiss')).status).toBe(404);
  });

  it('shows nothing while tips are off, and the switch says so', async () => {
    const { store, call } = setup();
    expect((await call('GET', '/api/tips/settings')).body).toEqual({ enabled: true });
    expect((await call('PUT', '/api/tips/settings', { enabled: 'no' })).status).toBe(400);
    expect((await call('PUT', '/api/tips/settings', { enabled: false })).body).toEqual({ enabled: false });
    expect(store.data.get(TIPS_ENABLED_KEY)).toBe(false);
    expect((await call('GET', '/api/tips/current')).body).toEqual({ tip: null, enabled: false });
    expect(store.data.has(TIPS_STATE_KEY)).toBe(false);
  });

  it('records a page once a day, capped', async () => {
    const { store, call, tomorrow } = setup();
    expect((await call('POST', '/api/tips/seen-page', { page: '#/nope' })).status).toBe(400);
    expect((await call('POST', '/api/tips/seen-page', { page: 'settings/notifications' })).status).toBe(200);
    expect(store.data.get(TIPS_PAGES_KEY)).toEqual({ 'settings/notifications': '2026-09-01' });
    tomorrow();
    for (let i = 0; i < TIPS_PAGES_CAP + 5; i++) await call('POST', '/api/tips/seen-page', { page: `p/x${i}` });
    const pages = store.data.get(TIPS_PAGES_KEY) as Record<string, string>;
    expect(Object.keys(pages)).toHaveLength(TIPS_PAGES_CAP);
    expect(pages['settings/notifications']).toBeUndefined();
  });

  it('lists every rule and where it stands, without marking anything shown', async () => {
    const { store } = setup({ groups: 1 });
    const RULES3: TipRule[] = [...RULES, { id: 'c', when: () => true, holdsForDays: 3, text: 'Tip c.', action: { label: 'Do c', route: '#/c' }, cooldownDays: 7 }];
    const deps = { store, facts: async () => facts({ groups: 1 }), now: () => new Date('2026-09-01T10:00:00Z'), timezone: 'UTC', rules: RULES3 };
    const list = async () => (await tipsRoute(deps, { method: 'GET', path: '/api/tips' })).body as { tips: any[]; enabled: boolean };
    const first = await list();
    expect(first.enabled).toBe(true);
    expect(first.tips.map((t) => [t.id, t.status])).toEqual([['a', 'quiet'], ['b', 'today'], ['c', 'holding']]);
    expect(first.tips[1]).toMatchObject({ text: 'Tip b.', action: { label: 'Do b', route: '#/b' }, holdsSince: '2026-09-01' });
    expect(store.data.has(TIPS_STATE_KEY)).toBe(false);
    expect((await tipsRoute(deps, { method: 'POST', path: '/api/tips' })).status).toBe(405);

    // Shown, then dismissed with its day, then brought back.
    await tipsRoute(deps, { method: 'GET', path: '/api/tips/current' });
    expect((await list()).tips[1]).toMatchObject({ status: 'shown', shownAt: '2026-09-01' });
    await tipsRoute(deps, { method: 'POST', path: '/api/tips/b/dismiss' });
    expect((await list()).tips[1]).toMatchObject({ status: 'dismissed', dismissedAt: '2026-09-01' });
    expect(await tipsRoute(deps, { method: 'POST', path: '/api/tips/b/restore' })).toEqual({ status: 200, body: { ok: true } });
    expect((store.data.get(TIPS_STATE_KEY) as any).b).toEqual({ firstHeld: '2026-09-01', shownAt: '2026-09-01' });
    expect((await list()).tips[1].status).toBe('shown');
    expect((await tipsRoute(deps, { method: 'POST', path: '/api/tips/nope/restore' })).status).toBe(404);

    // Off: the list still reads.
    await tipsRoute(deps, { method: 'PUT', path: '/api/tips/settings', body: { enabled: false } });
    const off = await list();
    expect(off.enabled).toBe(false);
    expect(off.tips).toHaveLength(3);
  });

  it('stacks today’s tip first, then the others ready; later and dismiss act per tip', async () => {
    const store = memoryStore();
    let now = new Date('2026-09-01T10:00:00Z');
    const RULES3: TipRule[] = [...RULES, { id: 'c', when: () => true, holdsForDays: 0, text: 'Tip c.', action: { label: 'Do c', route: '#/c' }, cooldownDays: 7 }];
    const deps = { store, facts: async () => facts(), now: () => now, timezone: 'UTC', rules: RULES3 };
    const call = (method: string, path: string, preview?: string) => tipsRoute(deps, { method, path, ...(preview ? { preview } : {}) });
    const ids = async () => ((await call('GET', '/api/tips/queue')).body as { tips: { id: string }[] }).tips.map((t) => t.id);

    expect(await ids()).toEqual(['a', 'b', 'c']);
    // Only the front one is remembered as shown.
    const state = store.data.get(TIPS_STATE_KEY) as Record<string, { shownAt?: string }>;
    expect(state.a!.shownAt).toBe('2026-09-01');
    expect(state.b!.shownAt).toBeUndefined();
    // The current tip agrees with the stack's front.
    expect((await call('GET', '/api/tips/current')).body).toMatchObject({ tip: { id: 'a' } });

    await call('POST', '/api/tips/a/later');
    expect(await ids()).toEqual(['b', 'c']);
    await call('POST', '/api/tips/b/dismiss');
    expect(await ids()).toEqual(['c']);
    now = new Date(now.getTime() + 8 * 86_400_000);
    expect(await ids()).toEqual(['a', 'c']);
    expect((await call('POST', '/api/tips/queue')).status).toBe(405);
  });

  it('stacks previews touching nothing, and says nothing while tips are off', async () => {
    const { store, call } = setup();
    const preview = await tipsRoute({ store, facts: async () => facts(), now: () => new Date('2026-09-01T10:00:00Z'), timezone: 'UTC', rules: RULES }, { method: 'GET', path: '/api/tips/queue', preview: 'b,a' });
    expect(preview.body).toMatchObject({ preview: true, tips: [{ id: 'b' }, { id: 'a' }] });
    expect(store.data.has(TIPS_STATE_KEY)).toBe(false);
    const missing = await tipsRoute({ store, facts: async () => facts(), now: () => new Date(), timezone: 'UTC', rules: RULES }, { method: 'GET', path: '/api/tips/queue', preview: 'a,nope' });
    expect(missing.status).toBe(404);
    await call('PUT', '/api/tips/settings', { enabled: false });
    expect((await call('GET', '/api/tips/queue')).body).toEqual({ tips: [], enabled: false });
  });
});
