/**
 * The owner's zone is Settings → Profile: a save applies to the process at
 * once, and the schedules kept in the old zone move with it. Skipped unless
 * DATABASE_URL is set; a throwaway database of its own.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, migrate } from './db.js';
import { refreshOwnerTimezone, setOwnerProfile } from './onboarding/store.js';
import { saveOwnerProfile } from './owner-timezone.js';
import { getActiveSchedule, setSchedule, upsertMission } from './scheduler/missions.js';
import { ownerTimezone, rememberOwnerTimezone } from './time.js';
import { testDatabaseUrl } from './testing/database-url.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_owner_tz_test_${process.pid}`;
const ENV = { BUDDI_TZ: 'America/New_York' } as NodeJS.ProcessEnv;

suite('owner timezone (postgres)', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const testUrl = new URL(databaseUrl as string);
    testUrl.pathname = `/${TEST_DB}`;
    pool = createPool(testUrl.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
  }, 60_000);

  afterAll(async () => {
    rememberOwnerTimezone(null);
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    rememberOwnerTimezone(null);
    await pool.query('truncate core.missions cascade');
    await pool.query('truncate core.owner cascade');
  });

  const mission = async (id: string, timezone: string): Promise<void> => {
    await upsertMission(pool, { id, name: id, agentId: 'scout', prompt: 'p' });
    await setSchedule(pool, id, { cron: '0 8 * * *', timezone, misfirePolicy: 'coalesce' });
  };

  it('a profile save is the zone at once; BUDDI_TZ is only the fallback', async () => {
    expect(ownerTimezone(ENV)).toBe('America/New_York');
    await setOwnerProfile(pool, { timezone: 'Europe/Lisbon' });
    expect(ownerTimezone(ENV)).toBe('Europe/Lisbon');
    // Another process wrote it: the refresh picks it up.
    await pool.query(`update core.owner set timezone = 'Asia/Tokyo'`);
    await refreshOwnerTimezone(pool);
    expect(ownerTimezone(ENV)).toBe('Asia/Tokyo');
    await setOwnerProfile(pool, { timezone: null });
    expect(ownerTimezone(ENV)).toBe('America/New_York');
  });

  it('moves the schedules kept in the old zone and leaves a zone named on purpose', async () => {
    await mission('recap', 'America/New_York');
    await mission('tokyo-market', 'Asia/Tokyo');
    const saved = await saveOwnerProfile(pool, { timezone: 'Europe/Lisbon' }, ENV);
    expect(saved.zoneChange).toEqual({ from: 'America/New_York', to: 'Europe/Lisbon', missions: ['recap'] });
    const recap = await getActiveSchedule(pool, 'recap');
    expect(recap).toMatchObject({ cron: '0 8 * * *', timezone: 'Europe/Lisbon', misfirePolicy: 'coalesce', revision: 2 });
    expect(await getActiveSchedule(pool, 'tokyo-market')).toMatchObject({ timezone: 'Asia/Tokyo', revision: 1 });

    // The same zone again: nothing moves. A save without a zone: nothing moves.
    expect((await saveOwnerProfile(pool, { timezone: 'Europe/Lisbon' }, ENV)).zoneChange).toBeUndefined();
    expect((await saveOwnerProfile(pool, { about: 'hi' }, ENV)).zoneChange).toBeUndefined();
    // Cleared: back to BUDDI_TZ, and the schedules follow.
    const cleared = await saveOwnerProfile(pool, { timezone: null }, ENV);
    expect(cleared.zoneChange?.to).toBe('America/New_York');
    expect(await getActiveSchedule(pool, 'recap')).toMatchObject({ timezone: 'America/New_York', revision: 3 });
  });
});
