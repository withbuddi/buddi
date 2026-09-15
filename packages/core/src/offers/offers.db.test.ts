/**
 * The offer store against a throwaway database. Skipped unless DATABASE_URL is
 * set; the owner's own database is never touched.
 *
 * The test that matters is the double tap: an offer is a button in a chat and
 * a chip on a dashboard at the same time, so "claimed once" has to be true of
 * the *row*, not of a surface's own bookkeeping.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, migrate } from '../db.js';
import { getOffer, listOpenOffers, offerActions, recordOfferJob, takeOffer } from './store.js';
import { testDatabaseUrl } from '../testing/database-url.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_offers_test_${process.pid}`;

const NOW = new Date('2026-09-15T09:00:00Z');
const later = (ms: number): Date => new Date(NOW.getTime() + ms);

suite('offers (postgres)', () => {
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
    await pool.query('truncate core.offers cascade');
  });

  const two = () =>
    offerActions(pool, {
      agentId: 'mail-triage',
      actions: [
        { label: 'Draft a reply', prompt: 'Draft a reply to Dorothée and show it to me.' },
        { label: 'Remind me tomorrow', prompt: 'Remind me tomorrow morning about the CdC site.' },
      ],
      now: NOW,
    });

  it('stores what was offered and lists it back as open', async () => {
    const stored = await two();
    expect(stored).toHaveLength(2);
    expect(stored[0]?.id).toMatch(/^[0-9a-f-]{36}$/);
    const open = await listOpenOffers(pool, { now: NOW });
    expect(open.map((o) => o.label).sort()).toEqual(['Draft a reply', 'Remind me tomorrow']);
  });

  it('stores nothing when nothing was offered', async () => {
    expect(await offerActions(pool, { agentId: 'mail-triage', actions: [], now: NOW })).toEqual([]);
    expect(await listOpenOffers(pool, { now: NOW })).toHaveLength(0);
  });

  it('is claimed exactly once, however many thumbs land on it', async () => {
    const [first] = await two();
    const id = first?.id as string;
    const results = await Promise.all([
      takeOffer(pool, { id, via: 'telegram', now: NOW }),
      takeOffer(pool, { id, via: 'web', now: NOW }),
      takeOffer(pool, { id, via: 'telegram', now: NOW }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const refusal of results.filter((r) => !r.ok)) {
      expect(refusal).toMatchObject({ ok: false, reason: 'already-taken' });
    }
  });

  it('drops out of the open list once it is taken', async () => {
    const [first] = await two();
    await takeOffer(pool, { id: first?.id as string, via: 'web', now: NOW });
    const open = await listOpenOffers(pool, { now: NOW });
    expect(open.map((o) => o.label)).toEqual(['Remind me tomorrow']);
  });

  it('refuses an expired offer rather than starting a run about stale facts', async () => {
    const [first] = await offerActions(pool, {
      agentId: 'mail-triage',
      actions: [{ label: 'Draft a reply', prompt: 'draft it' }],
      now: NOW,
      ttlMs: 60_000,
    });
    const result = await takeOffer(pool, {
      id: first?.id as string,
      via: 'telegram',
      now: later(120_000),
    });
    expect(result).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('refuses an id that names nothing', async () => {
    const result = await takeOffer(pool, {
      id: '00000000-0000-4000-8000-000000000000',
      via: 'telegram',
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('records the run a taken offer started', async () => {
    const [first] = await two();
    const id = first?.id as string;
    await takeOffer(pool, { id, via: 'telegram', now: NOW });
    await recordOfferJob(pool, id, '11111111-1111-4111-8111-111111111111');
    const row = await getOffer(pool, id);
    expect(row?.takenJobId).toBe('11111111-1111-4111-8111-111111111111');
    expect(row?.takenVia).toBe('telegram');
  });

  it('keeps the agent that offered it; an offer never changes hands', async () => {
    const [first] = await two();
    const taken = await takeOffer(pool, { id: first?.id as string, via: 'web', now: NOW });
    expect(taken.ok && taken.offer.agentId).toBe('mail-triage');
  });
});
