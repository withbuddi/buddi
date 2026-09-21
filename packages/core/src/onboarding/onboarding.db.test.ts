/**
 * The first-run state machine, against a throwaway database. Skipped unless
 * DATABASE_URL is set; the owner's own database is never touched.
 *
 * Two properties carry the whole feature and both are asserted here rather
 * than described: it starts **once**, and every accessor is **idempotent**.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, migrate } from '../db.js';
import { ensureOwner } from '../owner.js';
import {
  beginOnboarding,
  completeOnboarding,
  getOnboarding,
  getOwnerProfile,
  isOnboardingComplete,
  markStepDone,
  setOwnerProfile,
  skipOnboarding,
} from './store.js';
import { ONBOARDING_STEPS } from './types.js';
import { testDatabaseUrl } from '../testing/database-url.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_onboarding_test_${process.pid}`;

suite('onboarding (postgres)', () => {
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
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('truncate core.onboarding cascade');
    await pool.query('truncate core.owner cascade');
  });

  /* ---------------- the machine ---------------- */

  it('a fresh installation is pending, and reading it writes nothing', async () => {
    const before = await getOnboarding(pool);
    expect(before.state).toBe('pending');
    expect(before.stepsDone).toEqual([]);
    expect(before.startedAt).toBeNull();
    expect(await isOnboardingComplete(pool)).toBe(false);

    const { rows } = await pool.query('select count(*)::int as n from core.onboarding');
    expect(rows[0].n).toBe(0);
  });

  it('starts once: the second surface to ask is told no', async () => {
    const first = await beginOnboarding(pool, 'telegram');
    expect(first.started).toBe(true);
    expect(first.onboarding.state).toBe('in-progress');
    expect(first.onboarding.surface).toBe('telegram');

    const second = await beginOnboarding(pool, 'cli');
    expect(second.started).toBe(false);
    // And the surface that actually started it keeps the credit.
    expect(second.onboarding.surface).toBe('telegram');
    expect(second.onboarding.state).toBe('in-progress');
  });

  it('never restarts something already finished', async () => {
    await beginOnboarding(pool, 'cli');
    await completeOnboarding(pool, 'cli');
    const again = await beginOnboarding(pool, 'telegram');
    expect(again.started).toBe(false);
    expect(again.onboarding.state).toBe('done');
  });

  it('records steps as a set, in the order they happened', async () => {
    await beginOnboarding(pool, 'cli');
    await markStepDone(pool, 'name');
    await markStepDone(pool, 'timezone');
    const twice = await markStepDone(pool, 'name');
    expect(twice.stepsDone).toEqual(['name', 'timezone']);
    // Free-form: nothing enforces the canonical set or its order.
    const extra = await markStepDone(pool, 'told-me-about-the-dog');
    expect(extra.stepsDone).toContain('told-me-about-the-dog');
    expect(ONBOARDING_STEPS).toContain('first-mission');
  });

  it('completes idempotently, keeping the first instant', async () => {
    await beginOnboarding(pool, 'telegram');
    const first = await completeOnboarding(pool, 'telegram');
    expect(first.state).toBe('done');
    expect(first.completedAt).not.toBeNull();

    const again = await completeOnboarding(pool, 'cli');
    expect(again.state).toBe('done');
    expect(again.completedAt?.getTime()).toBe(first.completedAt?.getTime());
    expect(await isOnboardingComplete(pool)).toBe(true);
  });

  it('treats a skip as an answer: complete, and never asked again', async () => {
    const skipped = await skipOnboarding(pool, 'not now');
    expect(skipped.state).toBe('skipped');
    expect(await isOnboardingComplete(pool)).toBe(true);
    expect((await beginOnboarding(pool, 'telegram')).started).toBe(false);

    // The reason is history, kept in the event log rather than in the row.
    const { rows } = await pool.query(
      `select payload from core.events where kind = 'onboarding.skipped'`,
    );
    expect(rows[0]?.payload?.reason).toBe('not now');
  });

  it('keeps done and skipped terminal, in both directions', async () => {
    await beginOnboarding(pool, 'web');
    const done = await completeOnboarding(pool, 'web');
    expect(done.state).toBe('done');
    // A skip arriving afterwards — a second tab, the other surface — reads the
    // record rather than rewriting its ending.
    const afterSkip = await skipOnboarding(pool, 'too late');
    expect(afterSkip.state).toBe('done');
    expect(afterSkip.completedAt?.getTime()).toBe(done.completedAt?.getTime());
    const { rows } = await pool.query(
      `select payload from core.events where kind = 'onboarding.skipped'`,
    );
    expect(rows.some((row) => row.payload?.reason === 'too late')).toBe(false);
  });

  it('keeps skipped terminal against a later completion', async () => {
    const skipped = await skipOnboarding(pool, 'not now');
    expect(skipped.state).toBe('skipped');
    const completed = await completeOnboarding(pool, 'web');
    expect(completed.state).toBe('skipped');
    expect(completed.completedAt?.getTime()).toBe(skipped.completedAt?.getTime());
  });

  it('skips from cold, with no interview ever started', async () => {
    const skipped = await skipOnboarding(pool);
    expect(skipped.state).toBe('skipped');
    expect(skipped.completedAt).not.toBeNull();
  });

  /* ---------------- the profile ---------------- */

  it('writes only the fields it is given, and leaves the rest alone', async () => {
    await ensureOwner(pool, 'Amen from Telegram');

    await setOwnerProfile(pool, { preferredName: 'Amen' });
    await setOwnerProfile(pool, { timezone: 'Europe/Paris' });
    const profile = await getOwnerProfile(pool);

    expect(profile.preferredName).toBe('Amen');
    expect(profile.timezone).toBe('Europe/Paris');
    expect(profile.language).toBeNull();
    // The name pairing recorded is a different fact and is never overwritten.
    expect(profile.displayName).toBe('Amen from Telegram');
  });

  it('creates the owner row when there is none yet', async () => {
    const profile = await setOwnerProfile(pool, { preferredName: 'Ada', language: 'French' });
    expect(profile.preferredName).toBe('Ada');
    expect(profile.language).toBe('French');
  });

  it('clears a field with an explicit null, and treats blank as cleared', async () => {
    await setOwnerProfile(pool, { preferredName: 'Amen', language: 'English' });
    await setOwnerProfile(pool, { preferredName: null, language: '   ' });
    const profile = await getOwnerProfile(pool);
    expect(profile.preferredName).toBeNull();
    expect(profile.language).toBeNull();
  });

  it('answers with an empty profile on an installation with no owner row', async () => {
    expect(await getOwnerProfile(pool)).toEqual({
      preferredName: null,
      timezone: null,
      language: null,
      // `about` joined the profile with migration 022; an empty installation
      // has nothing to say in it either.
      about: null,
      displayName: null,
    });
  });
});
