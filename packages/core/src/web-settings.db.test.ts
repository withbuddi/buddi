/**
 * `core.web_settings`, against real Postgres: one row per key, replaced whole.
 * The database is created by this suite, named after this process, and dropped
 * again — the owner's installation is never touched.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, migrateCore } from './db.js';
import { readWebSetting, writeWebSetting } from './web-settings.js';
import { urlForDatabase } from './backup/restore.js';
import { testDatabaseUrl } from './testing/database-url.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const DB = `buddi_web_settings_${process.pid}`;

suite('the dashboard settings table', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(urlForDatabase(databaseUrl as string, 'postgres'));
    await admin.query(`drop database if exists "${DB}"`);
    await admin.query(`create database "${DB}"`);
    pool = createPool(urlForDatabase(databaseUrl as string, DB));
    await migrateCore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`drop database if exists "${DB}"`);
    await admin?.end();
  });

  it('answers null for a key nothing has written', async () => {
    expect(await readWebSetting(pool, 'tailscale')).toBeNull();
  });

  it('keeps one row per key and replaces the value whole', async () => {
    await writeWebSetting(pool, 'tailscale', { enabled: true, login: 'owner@example.com' });
    expect(await readWebSetting(pool, 'tailscale')).toEqual({ enabled: true, login: 'owner@example.com' });
    await writeWebSetting(pool, 'tailscale', { enabled: false, login: '' });
    expect(await readWebSetting(pool, 'tailscale')).toEqual({ enabled: false, login: '' });
    const { rows } = await pool.query('select count(*)::int as n from core.web_settings');
    expect(rows[0].n).toBe(1);
  });
});
