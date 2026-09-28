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
});
