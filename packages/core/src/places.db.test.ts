/**
 * The owner's places in core, and the three host API 1.18 additions that
 * read them or sit beside them: `owner.places()` behind `owner:places`, a
 * plugin's `setup` answer, and `ctx.buddi.plugins.call` between a plugin and
 * one it requires — with every refusal core owes. The weather plugin's Home
 * and Work come in once. The database is created by this suite and dropped.
 */
import type { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrateCore } from './db.js';
import { urlForDatabase } from './backup/restore.js';
import { testDatabaseUrl } from './testing/database-url.js';
import { ToolRegistry } from './registry.js';
import type { CoreToolContext, PluginManifest } from './tools.js';
import { resetPluginHost } from './host/build.js';
import type { BuddiHost } from './host/types.js';
import { importWeatherPlaces, listOwnerPlaces, removeOwnerPlace, saveOwnerPlace, PlaceRefusal } from './places.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const DB = `buddi_places_${process.pid}`;

function plugin(name: string, extra: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name,
    version: '1.0.0',
    schema: name,
    migrationsDir: '',
    tools: [
      {
        name: `${name}.host`,
        description: 'hand back ctx.buddi',
        tier: 'auto',
        input: z.object({}),
        execute: async (_input: unknown, ctx: CoreToolContext) => ctx.buddi,
      },
    ],
    ...extra,
  };
}

const LYON = { name: 'Lyon, Auvergne-Rhône-Alpes, France', latitude: 45.76, longitude: 4.84, timezone: 'Europe/Paris' };

suite('places', () => {
  let admin: Pool;
  let pool: Pool;
  const now = new Date('2026-10-01T08:00:00Z');
  const ctx = (): CoreToolContext => ({ db: pool, ownerId: 'owner', now: () => now, timezone: 'Europe/Paris', agentId: 'assistant' });
  async function hostOf(registry: ToolRegistry, tool: string): Promise<BuddiHost> {
    const result = await registry.invoke(tool, {}, ctx());
    if (!result.ok) throw new Error(result.message);
    return result.output as BuddiHost;
  }

  beforeAll(async () => {
    admin = createPool(urlForDatabase(databaseUrl as string, 'postgres'));
    await admin.query(`drop database if exists "${DB}"`);
    await admin.query(`create database "${DB}"`);
    pool = createPool(urlForDatabase(databaseUrl as string, DB));
    await migrateCore(pool);
  }, 120_000);

  afterEach(async () => {
    resetPluginHost();
    await pool.query('delete from core.owner_places');
    await pool.query('delete from core.owner_place_imports');
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
    await admin?.query(`drop database if exists "${DB}"`).catch(() => {});
    await admin?.end().catch(() => {});
  });

  it('are added, renamed, ordered Home then Work, and removed', async () => {
    const gym = await saveOwnerPlace(pool, { label: 'Gym', address: 'Rue X, Lyon', ...LYON });
    const work = await saveOwnerPlace(pool, { label: 'work', address: '1 Place Bellecour, Lyon', ...LYON });
    const home = await saveOwnerPlace(pool, { label: 'Home', address: '12 rue de la République, Lyon', ...LYON });
    expect((await listOwnerPlaces(pool)).map((p) => p.label)).toEqual(['Home', 'work', 'Gym']);
    expect(home).toMatchObject({ id: 'home', timezone: 'Europe/Paris', address: '12 rue de la République, Lyon' });

    const renamed = await saveOwnerPlace(pool, { id: gym.id, label: 'Climbing', address: null, ...LYON });
    expect(renamed).toMatchObject({ id: 'gym', label: 'Climbing', address: null });
    await expect(saveOwnerPlace(pool, { label: 'HOME', ...LYON })).rejects.toBeInstanceOf(PlaceRefusal);
    await expect(saveOwnerPlace(pool, { label: '  ', ...LYON })).rejects.toThrow(/Give the place a name/);
    await expect(saveOwnerPlace(pool, { label: 'Moon', ...LYON, latitude: 91 })).rejects.toThrow(/not on Earth/);

    expect(await removeOwnerPlace(pool, work.id)).toMatchObject({ label: 'work' });
    expect(await removeOwnerPlace(pool, work.id)).toBeNull();
    expect((await listOwnerPlaces(pool)).map((p) => p.id)).toEqual(['home', 'gym']);
  });

  it('are read by a plugin only when it declares owner:places', async () => {
    await saveOwnerPlace(pool, { label: 'Home', address: '12 rue X', ...LYON });
    const registry = new ToolRegistry();
    registry.register(plugin('plain'));
    registry.register(plugin('commute', { uses: ['owner:places'] }));
    expect((await hostOf(registry, 'plain.host')).owner.places).toBeUndefined();
    const places = await (await hostOf(registry, 'commute.host')).owner.places!();
    expect(places).toEqual([{ id: 'home', label: 'Home', address: '12 rue X', ...LYON }]);
  });

  it('bring the weather plugin’s Home and Work in once, keeping what the owner has', async () => {
    expect(await importWeatherPlaces(pool)).toBeNull(); // no weather schema: nothing recorded
    expect((await pool.query(`select count(*)::int as n from core.owner_place_imports`)).rows[0].n).toBe(0);
    await pool.query('create schema weather');
    await pool.query(`create table weather.place (id text primary key, label text not null, name text not null,
      latitude double precision not null, longitude double precision not null, timezone text,
      is_home boolean not null default false, created_at timestamptz not null default now())`);
    await pool.query(`insert into weather.place (id, label, name, latitude, longitude, timezone, is_home) values
      ('lyon', 'Lyon', 'Lyon, France', 45.76, 4.84, 'Europe/Paris', true),
      ('work', 'Work', 'Villeurbanne, France', 45.77, 4.88, 'Europe/Paris', false),
      ('mum', 'Mum''s', 'Nice, France', 43.7, 7.27, 'Europe/Paris', false)`);
    await saveOwnerPlace(pool, { label: 'Work', address: 'already mine', ...LYON });

    expect(await importWeatherPlaces(pool)).toBe(1);
    const places = await listOwnerPlaces(pool);
    expect(places.map((p) => [p.label, p.name])).toEqual([['Home', 'Lyon, France'], ['Work', LYON.name]]);
    // Once: a removed Home does not come back.
    await removeOwnerPlace(pool, 'home');
    expect(await importWeatherPlaces(pool)).toBeNull();
    expect((await listOwnerPlaces(pool)).map((p) => p.label)).toEqual(['Work']);
    await pool.query('drop schema weather cascade');
  });

  describe('between plugins', () => {
    const forecast = {
      params: z.object({ place: z.string() }).strict(),
      async produce(params: { place: string }, c: CoreToolContext) {
        const { rows } = await c.buddi!.db.query<{ n: number }>('select 1 as n');
        return { place: params.place, plugin: c.buddi!.plugin, n: rows[0]!.n };
      },
    };
    const write = {
      params: z.object({}),
      async produce(_p: unknown, c: CoreToolContext) {
        await c.buddi!.db.query(`insert into core.owner_places (id) values ('x')`);
        return 'wrote';
      },
    };
    const registry = (): ToolRegistry => {
      const r = new ToolRegistry();
      r.register(plugin('weather', { version: '0.2.1', exports: { forecast, write } }));
      r.register(plugin('commute', { requires: { weather: '^0.2.0' } }));
      r.register(plugin('stranger'));
      r.register(plugin('greedy', { requires: { weather: '^1.0.0' } }));
      return r;
    };

    it('call an export of a plugin they require, as that plugin', async () => {
      const host = await hostOf(registry(), 'commute.host');
      expect(await host.plugins!.call('weather', 'forecast', { place: 'home' })).toEqual({ place: 'home', plugin: 'weather', n: 1 });
    });

    it('are refused what they do not require, what is not exported, bad arguments and a write', async () => {
      const r = registry();
      expect((await hostOf(r, 'stranger.host')).plugins).toBeUndefined();
      const host = await hostOf(r, 'commute.host');
      await expect(host.plugins!.call('stranger', 'forecast')).rejects.toThrow(/may call only the plugins it requires/);
      await expect(host.plugins!.call('weather', 'commute')).rejects.toThrow(/exports no "commute"; it exports forecast, write/);
      await expect(host.plugins!.call('weather', 'toString')).rejects.toThrow(/exports no "toString"/);
      await expect(host.plugins!.call('weather', 'forecast', { place: 3 })).rejects.toThrow(/place: Expected string/);
      await expect(host.plugins!.call('weather', 'write')).rejects.toThrow(/may only read/);
      expect((await pool.query(`select count(*)::int as n from core.owner_places`)).rows[0].n).toBe(0);
      await expect((await hostOf(r, 'greedy.host')).plugins!.call('weather', 'forecast', { place: 'x' })).rejects.toThrow(
        /needs weather \^1\.0\.0, and 0\.2\.1 is installed/,
      );
      r.unregister('weather');
      await expect(host.plugins!.call('weather', 'forecast', { place: 'x' })).rejects.toThrow(/weather is not loaded/);
    });

    it('refuse a manifest whose requires or exports are malformed', () => {
      const r = new ToolRegistry();
      expect(() => r.register(plugin('a', { requires: { a: '*' } }))).toThrow(/names the plugin itself/);
      expect(() => r.register(plugin('b', { requires: { weather: 'latest' } }))).toThrow(/not a version range/);
      expect(() => r.register(plugin('c', { exports: { x: { produce: async () => 1 } as never } }))).toThrow(/needs a zod `params`/);
    });
  });

  it('ask a plugin whether it is set up, on the read-only pool', async () => {
    const r = new ToolRegistry();
    r.register(plugin('ready', { setup: { produce: async () => ({ ready: true }) } }));
    r.register(
      plugin('weather', {
        pages: [{ id: 'settings', title: 'Weather', place: 'settings', body: [{ kind: 'notice', text: 'Places' }] }] as never,
        setup: {
          async produce(c) {
            const { rows } = await c.buddi!.db.query<{ n: number }>('select count(*)::int as n from core.owner_places');
            return { ready: rows[0]!.n > 0, note: 'Pick a place for the forecast.', page: 'settings' };
          },
        },
      }),
    );
    r.register(plugin('broken', { setup: { produce: async () => ({ fine: 'yes' }) as never } }));
    r.register(plugin('writer', { setup: { produce: async (c) => (await c.buddi!.db.query(`delete from core.owner_places`), { ready: true }) } }));
    r.register(plugin('plain'));
    expect(await r.readiness('ready', ctx())).toEqual({ ready: true });
    expect(await r.readiness('weather', ctx())).toEqual({ ready: false, note: 'Pick a place for the forecast.', page: 'settings' });
    await saveOwnerPlace(pool, { label: 'Home', ...LYON });
    expect((await r.readiness('weather', ctx()))?.ready).toBe(true);
    expect(await r.readiness('plain', ctx())).toBeUndefined();
    await expect(r.readiness('broken', ctx())).rejects.toThrow(/not \{ ready/);
    await expect(r.readiness('writer', ctx())).rejects.toThrow(/may only read/);
  });
});
