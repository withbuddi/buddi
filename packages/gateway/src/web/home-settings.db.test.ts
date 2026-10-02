/**
 * Home's saved setting under concurrent writes: dismissals and glance
 * visibility change one value, and none may lose another's change. Skipped
 * unless DATABASE_URL is set; a throwaway database of its own.
 */
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, ToolRegistry, createPool, migrate, type HomeContribution } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readHomeDismissed, setGlanceHidden, setHomeDismissed } from './read.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const DB = `buddi_home_settings_${process.pid}`;

suite('home settings (postgres)', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${DB}`);
    await admin.query(`create database ${DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${DB}`);
      await admin.end();
    }
  });

  it('keeps every concurrent dismissal and glance change, from the first row on', async () => {
    const home: HomeContribution[] = [{ id: 'weather.now', title: 'Weather', placement: 'glance', produce: async () => null }];
    const registry = new ToolRegistry();
    registry.register({ name: 'weather', version: '1', schema: 'weather', migrationsDir: '', tools: [], home });
    await pool.query(`delete from core.web_settings where key = 'home'`);
    const slots = Array.from({ length: 20 }, (_, i) => `connection:c${i}`);
    await Promise.all([
      ...slots.map((slot) => setHomeDismissed(pool, slot, 'x')),
      setGlanceHidden({ pool, registry }, 'weather.now', true),
    ]);
    const dismissed = await readHomeDismissed(pool);
    expect(Object.keys(dismissed).sort()).toEqual([...slots].sort());
    const { rows } = await pool.query(`select value from core.web_settings where key = 'home'`);
    expect(rows[0].value.hiddenGlances).toEqual(['weather.now']);
  });
});
