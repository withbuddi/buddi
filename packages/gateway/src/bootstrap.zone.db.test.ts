/**
 * The wiring every long-running entry point builds (`createWiringAsync`)
 * keeps the owner's zone live: a Settings → Profile save reaches the
 * dashboard's session clock, the lock screen and every surface without a
 * restart. The async wiring is a spread of the sync one plus what it adds,
 * and a spread once froze the zone of the moment it was built. Own database,
 * dropped after; skipped without one.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, rememberOwnerTimezone, runMigrations, setOwnerProfile, testDatabaseUrl } from '@buddi/core/testing';
import { createWiringAsync, type Wiring } from './bootstrap.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_gateway_zone_test_${process.pid}`;

suite('the async wiring and the owner zone', () => {
  let admin: Pool;
  let wiring: Wiring | undefined;
  let dir: string;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    const pool = createPool(url.toString());
    await runMigrations(pool, []);
    await pool.end();
    dir = await mkdtemp(path.join(tmpdir(), 'buddi-zone-'));
    rememberOwnerTimezone(null);
    wiring = await createWiringAsync({
      DATABASE_URL: url.toString(),
      BUDDI_AGENTS_DIR: dir,
      BUDDI_VAULT: 'memory',
      BUDDI_PLUGINS_FILE: path.join(dir, 'plugins.json'),
      BUDDI_TZ: 'America/Chicago',
    });
  }, 60_000);

  afterAll(async () => {
    rememberOwnerTimezone(null);
    await wiring?.pool.end();
    if (dir) await rm(dir, { recursive: true, force: true });
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  it('answers the profile zone after a save, with no restart; BUDDI_TZ until then', async () => {
    const w = wiring as Wiring;
    expect(w.timezone).toBe('America/Chicago');
    await setOwnerProfile(w.pool, { timezone: 'Europe/Lisbon' });
    expect(w.timezone).toBe('Europe/Lisbon');
    expect(w.ctx.timezone).toBe('Europe/Lisbon');
    await setOwnerProfile(w.pool, { timezone: null });
    expect(w.timezone).toBe('America/Chicago');
  });
});
