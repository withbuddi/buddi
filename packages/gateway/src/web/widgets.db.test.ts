/**
 * Widgets over the wire, signed in: the default placements, Home's saved to
 * `core.web_settings` and read back (one widget twice), the lock screen's own
 * pick, refused placements, a failing widget kept to its frame, the CSRF gate
 * on the write, the preview and the settings sheet, the widgets v1 layout
 * read once. Own database, dropped after; skipped without one.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, readWebSetting, runMigrations, testDatabaseUrl, type CoreToolContext } from '@buddi/core/testing';
import { createToolRegistry, loadGatewayCatalog, reloadableCatalog } from '../agents/catalog.js';
import { mintTicket } from './token.js';
import { createWebApp } from './server.js';
import { csrfCookieName, portOf } from './http.js';
import { WIDGETS_SETTINGS_KEY } from './widgets.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_gateway_widgets_test_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';
const NOW = new Date('2026-09-28T10:00:00Z');

function agent(id: string, extra: string[] = []): string {
  return ['---', `id: ${id}`, `handle: ${id}`, `name: ${id[0]!.toUpperCase()}${id.slice(1)}`, `description: The ${id}.`,
    'provider: anthropic', 'model: claude-sonnet-5', 'tools: [system.*]', ...extra, '---', '', `You are ${id}.`, ''].join('\n');
}

suite('widgets against Postgres', () => {
  let admin: Pool;
  let pool: Pool;
  let server: ReturnType<typeof createWebApp>;
  let base: string;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, []);

    const dir = mkdtempSync(path.join(tmpdir(), 'buddi-widgets-'));
    mkdirSync(path.join(dir, 'agents', 'concierge'), { recursive: true });
    writeFileSync(path.join(dir, 'agents', 'concierge', 'agent.md'), agent('concierge', ['roles: [front-desk]', 'default: true']));
    const assets = path.join(dir, 'web');
    mkdirSync(assets);
    writeFileSync(path.join(assets, 'index.html'), '<!doctype html><title>buddi</title>');
    const env = {} as NodeJS.ProcessEnv;
    const registry = createToolRegistry({});
    registry.register({
      name: 'demo', version: '1', schema: 'demo', migrationsDir: '', tools: [],
      widgets: [
        { id: 'demo.now', title: 'Now', sizes: ['small', 'medium'], produce: async (_ctx, { size }) => ({ kind: 'stat', value: size === 'small' ? '18°C' : '18°C, clear' }) },
        { id: 'demo.broken', title: 'Broken', sizes: ['small'], produce: async () => { throw new Error('the service is down'); } },
        { id: 'demo.money', title: 'Money', sizes: ['small'], sensitive: true, produce: async () => ({ kind: 'progress', value: '€1', ratio: 0.5 }) },
      ],
    });
    const catalog = reloadableCatalog(() => loadGatewayCatalog({ dir: path.join(dir, 'agents'), env, registry }));
    server = createWebApp({
      pool,
      registry,
      catalog,
      ctx: { db: pool, ownerId: 'owner', now: () => NOW, timezone: 'UTC' } as CoreToolContext,
      timezone: 'UTC',
      now: () => NOW,
      config: { enabled: true, host: '127.0.0.1', port: 0 },
      openAccess: false,
      token: TOKEN,
      env,
      assetsDir: assets,
      log: () => {},
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => { server?.closeAllConnections?.(); server?.close(() => resolve()); });
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  it('serves the gallery and the layout, saves the owner layout, and refuses one it cannot keep', async () => {
    const res = await fetch(`${base}/?t=${encodeURIComponent(mintTicket(TOKEN))}`, { redirect: 'manual' });
    const jar = new Map<string, string>();
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, value] = (pair as string).split('=');
      jar.set(name as string, value as string);
    }
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = jar.get(csrfCookieName(portOf(new URL(base)))) as string;
    const call = async (method: string, route: string, body?: unknown, headers: Record<string, string> = { 'x-buddi-csrf': csrf }) => {
      const r = await fetch(`${base}/api/widgets${route}`, {
        method,
        headers: { cookie, origin: base, 'content-type': 'application/json', ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };

    expect((await fetch(`${base}/api/widgets`)).status).toBe(401);
    const first = await call('GET', '');
    expect(first.status).toBe(200);
    // Beside the built-in mail widget, which says to add a mailbox.
    const demo = (ids: string[]) => ids.filter((id) => id.startsWith('demo.'));
    expect(demo(first.body.available.map((w: { id: string }) => w.id))).toEqual(['demo.now', 'demo.broken', 'demo.money']);
    expect(first.body.arranged).toEqual({ home: false, lock: false });
    const ids = (list: Array<{ widget: string }>) => demo(list.map((p) => p.widget));
    expect(ids(first.body.home)).toEqual(['demo.now', 'demo.broken']);
    const keyOf = (list: Array<{ key: string; widget: string }>, widget: string) => list.find((p) => p.widget === widget)!.key;
    expect(first.body.views[keyOf(first.body.home, 'demo.now')]).toMatchObject({ state: 'ok', body: { kind: 'stat', value: '18°C' } });
    expect(first.body.views[keyOf(first.body.home, 'demo.broken')]).toEqual({ state: 'error', error: 'the service is down' });

    // Home: the same widget twice, each with its own key; the lock screen its own pick.
    const saved = await call('PUT', '/home', { placements: [{ widget: 'demo.money', size: 'small' }, { widget: 'demo.now', size: 'medium' }, { widget: 'demo.now', size: 'small' }] });
    expect(saved.status).toBe(200);
    expect(saved.body.arranged).toEqual({ home: true, lock: false });
    expect(saved.body.home.map((p: { widget: string; size: string }) => [p.widget, p.size])).toEqual([['demo.money', 'small'], ['demo.now', 'medium'], ['demo.now', 'small']]);
    expect(saved.body.views[saved.body.home[1].key].body.value).toBe('18°C, clear');
    expect(saved.body.views[saved.body.home[2].key].body.value).toBe('18°C');
    expect(await readWebSetting(pool, WIDGETS_SETTINGS_KEY)).toMatchObject({ version: 2, home: [{ widget: 'demo.money' }, { widget: 'demo.now' }, { widget: 'demo.now' }] });
    expect((await call('GET', '')).body.home.map((p: { key: string }) => p.key)).toEqual(saved.body.home.map((p: { key: string }) => p.key));
    // Until it is arranged, the lock screen shows the first of Home's that may show there.
    expect(saved.body.lock.map((p: { widget: string }) => p.widget)).toEqual(['demo.now', 'demo.now']);
    const lock = await call('PUT', '/lock', { placements: [{ widget: 'demo.now', size: 'small' }] });
    expect(lock.status).toBe(200);
    expect(lock.body.lock.map((p: { widget: string }) => p.widget)).toEqual(['demo.now']);
    expect((await call('GET', '?surface=lock')).body.views[lock.body.lock[0].key]).toMatchObject({ state: 'ok' });

    expect((await call('PUT', '/home', { placements: [{ widget: 'demo.nope', size: 'small' }] })).status).toBe(400);
    expect((await call('PUT', '/lock', { placements: [{ widget: 'demo.money', size: 'small' }] })).status).toBe(400);
    expect((await call('PUT', '/home', { placements: [{ widget: 'demo.money', size: 'small' }] }, {})).status).toBe(403);
    expect((await call('POST', `/${saved.body.home[1].key}/refresh`)).status).toBe(200);
    expect((await call('POST', '/preview', { widget: 'demo.now', size: 'small', settings: {} })).body.view).toMatchObject({ state: 'ok' });
    expect((await call('GET', '/settings/buddi.clock')).body).toMatchObject({ widget: 'buddi.clock', fields: [{ key: 'places' }, { key: 'time' }], places: [] });

    // The widgets v1 layout reads as Home's placements.
    await pool.query(`update core.web_settings set value = $1::jsonb where key = $2`, [JSON.stringify({ layout: [{ id: 'demo.now', size: 'medium' }] }), WIDGETS_SETTINGS_KEY]);
    expect((await call('GET', '')).body.home).toEqual([{ key: 'v1-demo-now', widget: 'demo.now', size: 'medium', settings: {}, label: 'Now' }]);
  });
});
