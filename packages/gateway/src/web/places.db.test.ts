/**
 * Settings → Profile's places over the wire: find a place on a stubbed
 * geocoder (its zone carried through), save Home and Work, rename, refuse a
 * second Home, remove, and `GET /api/owner` carrying the list. Own database,
 * dropped after; skipped without one.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, runMigrations, testDatabaseUrl, type CoreToolContext, type HttpArea } from '@buddi/core/testing';
import { createToolRegistry, loadGatewayCatalog, reloadableCatalog } from '../agents/catalog.js';
import { mintTicket } from './token.js';
import { createWebApp } from './server.js';
import { csrfCookieName, portOf } from './http.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_gateway_places_test_${process.pid}`;
const TOKEN = 'a-test-dashboard-token-long-enough';
const NOW = new Date('2026-10-01T10:00:00Z');

const asked: string[] = [];
const geocoder: HttpArea = {
  async request(req) {
    const name = new URL(req.url).searchParams.get('name') ?? '';
    asked.push(name);
    const results =
      name === 'Portland'
        ? [
            { name: 'Portland', latitude: 45.52, longitude: -122.68, timezone: 'America/Los_Angeles', admin1: 'Oregon', country: 'United States' },
            { name: 'Portland', latitude: 43.66, longitude: -70.26, timezone: 'America/New_York', admin1: 'Maine', country: 'United States' },
          ]
        : [];
    return { ok: true, status: 200, headers: {}, json: async () => ({ results }), text: async () => '' } as never;
  },
};

suite('places over the wire', () => {
  let admin: Pool;
  let pool: Pool;
  let server: ReturnType<typeof createWebApp>;
  let base: string;
  let call: (method: string, route: string, body?: unknown) => Promise<{ status: number; body: any }>;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, []);
    const dir = mkdtempSync(path.join(tmpdir(), 'buddi-places-'));
    mkdirSync(path.join(dir, 'agents'), { recursive: true });
    const assets = path.join(dir, 'web');
    mkdirSync(assets);
    writeFileSync(path.join(assets, 'index.html'), '<!doctype html><title>buddi</title>');
    const env = {} as NodeJS.ProcessEnv;
    const registry = createToolRegistry({});
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
      placesHttp: geocoder,
      log: () => {},
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/?t=${encodeURIComponent(mintTicket(TOKEN))}`, { redirect: 'manual' });
    const jar = new Map<string, string>();
    for (const raw of res.headers.getSetCookie()) {
      const [pair] = raw.split(';');
      const [name, value] = (pair as string).split('=');
      jar.set(name as string, value as string);
    }
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const csrf = jar.get(csrfCookieName(portOf(new URL(base)))) as string;
    call = async (method, route, body) => {
      const r = await fetch(`${base}${route}`, {
        method,
        headers: { cookie, 'x-buddi-csrf': csrf, origin: base, 'content-type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: r.status, body: (await r.json()) as any };
    };
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => { server?.closeAllConnections?.(); server?.close(() => resolve()); });
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  it('finds, saves, renames, refuses and removes', async () => {
    expect((await call('POST', '/api/owner/places/find', { address: 'x' })).status).toBe(400);
    const found = await call('POST', '/api/owner/places/find', { address: '12 Elm St, Portland, Maine' });
    expect(found.status).toBe(200);
    expect(found.body.found[0]).toEqual({ name: 'Portland, Maine, United States', latitude: 43.66, longitude: -70.26, timezone: 'America/New_York' });
    expect(asked).toEqual(['Elm St', 'Portland', 'Maine']);

    const home = await call('POST', '/api/owner/places', { label: 'Home', address: '12 Elm St, Portland, Maine', ...found.body.found[0] });
    expect(home.status).toBe(200);
    expect(home.body.place).toMatchObject({ id: 'home', label: 'Home', timezone: 'America/New_York' });
    expect((await call('POST', '/api/owner/places', { label: 'home', ...found.body.found[0] })).body).toEqual({ error: 'You already have a place called Home.' });
    expect((await call('POST', '/api/owner/places', { label: 'Work', ...found.body.found[0], timezone: 'Mars/Base' })).status).toBe(400);
    const work = await call('POST', '/api/owner/places', { label: 'Work', address: 'Congress St', ...found.body.found[0] });
    expect(work.body.places.map((p: { label: string }) => p.label)).toEqual(['Home', 'Work']);
    const renamed = await call('POST', '/api/owner/places', { id: 'work', label: 'Office', address: 'Congress St', ...found.body.found[0] });
    expect(renamed.body.place).toMatchObject({ id: 'work', label: 'Office' });

    const owner = await call('GET', '/api/owner');
    expect(owner.body.places.map((p: { id: string }) => p.id)).toEqual(['home', 'work']);
    expect((await call('POST', '/api/owner/places/remove', { id: 'work' })).body.places).toHaveLength(1);
    expect((await call('POST', '/api/owner/places/remove', { id: 'work' })).status).toBe(404);
  });
});
