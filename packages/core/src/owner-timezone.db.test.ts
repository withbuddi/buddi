/**
 * The owner's zone is Settings → Profile: a save applies to the process at
 * once, and the schedules that follow it (made without a zone) move with it;
 * one whose zone was named on purpose stays. Schedules from before the flag
 * are settled at start. Skipped unless
 * DATABASE_URL is set; a throwaway database of its own.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, migrate } from './db.js';
import { refreshOwnerTimezone, setOwnerProfile } from './onboarding/store.js';
import { saveOwnerProfile, settleScheduleZones } from './owner-timezone.js';
import { getActiveSchedule, setSchedule, upsertMission } from './scheduler/missions.js';
import { nextAfter } from './scheduler/cron.js';
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

  const mission = async (id: string, timezone: string, timezoneExplicit: boolean): Promise<void> => {
    await upsertMission(pool, { id, name: id, agentId: 'scout', prompt: 'p' });
    await setSchedule(pool, id, { cron: '0 8 * * *', timezone, timezoneExplicit, misfirePolicy: 'coalesce' });
  };
  /** As a buddi from before the flag left it: no answer either way. */
  const unflagged = async (id: string, timezone: string): Promise<void> => {
    await mission(id, timezone, true);
    await pool.query('update core.schedule_specs set timezone_explicit = null where mission_id = $1', [id]);
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

  it('moves the schedules that follow the owner and leaves a zone named on purpose, even the old one', async () => {
    await mission('recap', 'America/New_York', false);
    await mission('tokyo-market', 'Asia/Tokyo', true);
    await mission('ny-open', 'America/New_York', true); // named New York on purpose
    const saved = await saveOwnerProfile(pool, { timezone: 'Europe/Lisbon' }, ENV);
    expect(saved.zoneChange).toEqual({ from: 'America/New_York', to: 'Europe/Lisbon', missions: ['recap'] });
    const recap = await getActiveSchedule(pool, 'recap');
    expect(recap).toMatchObject({ cron: '0 8 * * *', timezone: 'Europe/Lisbon', timezoneExplicit: false, misfirePolicy: 'coalesce', revision: 2 });
    // The next run is 8 AM in Lisbon now.
    expect(nextAfter(recap!.cron, new Date('2026-10-02T00:00:00Z'), recap!.timezone)?.toISOString()).toBe('2026-10-02T07:00:00.000Z');
    expect(await getActiveSchedule(pool, 'tokyo-market')).toMatchObject({ timezone: 'Asia/Tokyo', revision: 1 });
    expect(await getActiveSchedule(pool, 'ny-open')).toMatchObject({ timezone: 'America/New_York', timezoneExplicit: true, revision: 1 });

    // The same zone again: nothing moves. A save without a zone: nothing moves.
    expect((await saveOwnerProfile(pool, { timezone: 'Europe/Lisbon' }, ENV)).zoneChange).toBeUndefined();
    expect((await saveOwnerProfile(pool, { about: 'hi' }, ENV)).zoneChange).toBeUndefined();
    // Cleared: back to BUDDI_TZ, and the schedules that follow go with it.
    const cleared = await saveOwnerProfile(pool, { timezone: null }, ENV);
    expect(cleared.zoneChange).toEqual({ from: 'Europe/Lisbon', to: 'America/New_York', missions: ['recap'] });
    expect(await getActiveSchedule(pool, 'recap')).toMatchObject({ timezone: 'America/New_York', timezoneExplicit: false, revision: 3 });
  });

  it('a schedule that follows the owner moves even when it was left in another zone', async () => {
    // A Profile change an older buddi made without moving it: a save still brings it along.
    await mission('standup', 'Asia/Tokyo', false);
    const saved = await saveOwnerProfile(pool, { timezone: 'Europe/Lisbon' }, ENV);
    expect(saved.zoneChange?.missions).toEqual(['standup']);
    expect(await getActiveSchedule(pool, 'standup')).toMatchObject({ timezone: 'Europe/Lisbon' });
  });

  it('at start, settles the schedules from before the flag by provenance: only one buddi made without a zone follows', async () => {
    // As an older buddi left it: made in the install's default (New York), the profile saying Lisbon.
    await unflagged('learning-digest', 'America/New_York');
    await unflagged('scout-standup', 'America/New_York');
    await unflagged('already-moved', 'Europe/Lisbon'); // moved by pre.29's save
    await unflagged('tokyo-market', 'Asia/Tokyo'); // named on purpose
    await unflagged('ny-open', 'America/New_York'); // the owner's (or schedule.propose's) New York: no provenance
    await unflagged('custom-cron', 'America/New_York'); // a declared id, but its cron is no longer the declared one
    await pool.query(`update core.schedule_specs set cron = '0 6 * * *' where mission_id = 'custom-cron'`);
    await setOwnerProfile(pool, { timezone: 'Europe/Lisbon' });
    const declared = [
      { missionId: 'learning-digest', cron: null },
      { missionId: 'scout-standup', cron: '0 8 * * *' },
      { missionId: 'already-moved', cron: '0 8 * * *' },
      { missionId: 'tokyo-market', cron: '0 8 * * *' }, // declared, but sits in a zone that was never a default
      { missionId: 'custom-cron', cron: '0 8 * * *' },
    ];

    const first = await settleScheduleZones(pool, ENV, declared);
    expect(first).toEqual({ to: 'Europe/Lisbon', missions: ['learning-digest', 'scout-standup'], settled: { following: 3, explicit: 3 } });
    expect(await getActiveSchedule(pool, 'scout-standup')).toMatchObject({ timezone: 'Europe/Lisbon', timezoneExplicit: false });
    expect(await getActiveSchedule(pool, 'already-moved')).toMatchObject({ timezone: 'Europe/Lisbon', timezoneExplicit: false, revision: 1 });
    expect(await getActiveSchedule(pool, 'tokyo-market')).toMatchObject({ timezone: 'Asia/Tokyo', timezoneExplicit: true });
    expect(await getActiveSchedule(pool, 'ny-open')).toMatchObject({ timezone: 'America/New_York', timezoneExplicit: true, revision: 1 });
    expect(await getActiveSchedule(pool, 'custom-cron')).toMatchObject({ timezone: 'America/New_York', timezoneExplicit: true });

    // Nothing left to settle or move; and a later Profile change moves the ones that follow.
    expect(await settleScheduleZones(pool, ENV, declared)).toEqual({ to: 'Europe/Lisbon', missions: [], settled: { following: 0, explicit: 0 } });
    const saved = await saveOwnerProfile(pool, { timezone: 'Asia/Tokyo' }, ENV);
    expect(saved.zoneChange?.missions).toEqual(['already-moved', 'learning-digest', 'scout-standup']);
    expect(await getActiveSchedule(pool, 'tokyo-market')).toMatchObject({ revision: 1 });
  });

  it('without provenance every legacy schedule stays where it is, even in the default zone', async () => {
    await unflagged('recap', 'America/New_York');
    await setOwnerProfile(pool, { timezone: 'Europe/Lisbon' });
    const r = await settleScheduleZones(pool, ENV);
    expect(r).toEqual({ to: 'Europe/Lisbon', missions: [], settled: { following: 0, explicit: 1 } });
    expect(await getActiveSchedule(pool, 'recap')).toMatchObject({ timezone: 'America/New_York', timezoneExplicit: true });
  });

  it('settles against BUDDI_TZ when the install named one, and catches a Profile change made while stopped', async () => {
    const env = { BUDDI_TZ: 'America/Chicago' } as NodeJS.ProcessEnv;
    await unflagged('chicago-made', 'America/Chicago');
    await unflagged('ny-made', 'America/New_York'); // not this install's default: named on purpose
    // The Profile changed under a stopped buddi: written to the row, nothing moved.
    await setOwnerProfile(pool, { timezone: 'Europe/Berlin' });
    rememberOwnerTimezone(null);
    const declared = [
      { missionId: 'chicago-made', cron: '0 8 * * *' },
      { missionId: 'ny-made', cron: '0 8 * * *' },
    ];
    const r = await settleScheduleZones(pool, env, declared);
    expect(r.to).toBe('Europe/Berlin');
    expect(r.missions).toEqual(['chicago-made']);
    expect(await getActiveSchedule(pool, 'ny-made')).toMatchObject({ timezone: 'America/New_York', timezoneExplicit: true });
  });
});
