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
import {
  getOffer,
  listOpenOffers,
  offerActions,
  recordOfferJob,
  releaseOffer,
  takeOffer,
  withdrawOffers,
} from './store.js';
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

  /**
   * The claim is made before the run, so two taps cannot become two runs. When
   * the run then fails to start at all, the claim is handed back — otherwise a
   * surface that stumbled would leave a button that is dead for everybody.
   * Never a claim that did start something: a job on the row is the proof.
   */
  it('gives a claim back when nothing was started from it, and never one that was', async () => {
    const [first, second] = await two();
    const nothing = first?.id as string;
    const started = second?.id as string;

    await takeOffer(pool, { id: nothing, via: 'web', now: NOW });
    expect(await releaseOffer(pool, nothing)).toBe(true);
    const back = await getOffer(pool, nothing);
    expect(back?.takenAt).toBeNull();
    expect(back?.takenVia).toBeNull();
    // On the table again, and takeable again.
    expect((await listOpenOffers(pool, { now: NOW })).map((o) => o.id)).toContain(nothing);
    expect((await takeOffer(pool, { id: nothing, via: 'web', now: NOW })).ok).toBe(true);

    await takeOffer(pool, { id: started, via: 'telegram', now: NOW });
    await recordOfferJob(pool, started, '11111111-1111-4111-8111-111111111111');
    expect(await releaseOffer(pool, started)).toBe(false);
    expect((await getOffer(pool, started))?.takenAt).not.toBeNull();
  });

  /**
   * An offer made in a live conversation belongs to the turn that made it. The
   * conversation's next turn withdraws what the last one left on the table, so
   * a button cannot still fire an hour and three subjects later — and a tap on
   * the dead one gets the ordinary "expired", never silence and never a
   * surprise run.
   */
  it('withdraws a conversation’s open offers, and a later tap is refused as expired', async () => {
    const { rows } = await pool.query(
      `insert into core.conversations (agent_id) values ('mail-triage') returning id`,
    );
    const conversationId = String(rows[0].id);
    const stored = await offerActions(pool, {
      agentId: 'mail-triage',
      conversationId,
      actions: [
        { label: 'Send it', prompt: 'send the reply I drafted' },
        { label: 'Edit the draft', prompt: 'change the second paragraph' },
      ],
      now: NOW,
    });
    // One of them was taken before the turn moved on; withdrawing must not
    // touch it, and must not un-take it.
    const takenId = stored[1]?.id as string;
    await takeOffer(pool, { id: takenId, via: 'telegram', now: NOW });

    expect(
      await listOpenOffers(pool, { now: later(1000), conversationId }),
    ).toHaveLength(1);

    expect(await withdrawOffers(pool, { conversationId, now: later(1000) })).toBe(1);
    expect(await listOpenOffers(pool, { now: later(1000), conversationId })).toEqual([]);

    const late = await takeOffer(pool, {
      id: stored[0]?.id as string,
      via: 'web',
      now: later(2000),
    });
    expect(late).toMatchObject({ ok: false, reason: 'expired' });
    // Withdrawn, not deleted: the row is still there for the record.
    expect((await getOffer(pool, stored[0]?.id as string))?.takenAt).toBeNull();
    expect((await getOffer(pool, takenId))?.takenVia).toBe('telegram');

    // Another conversation's offers are nobody else's to retire.
    const elsewhere = await offerActions(pool, {
      agentId: 'mail-triage',
      actions: [{ label: 'Remind me', prompt: 'remind me tomorrow' }],
      now: NOW,
    });
    expect(await withdrawOffers(pool, { conversationId, now: later(3000) })).toBe(0);
    expect((await getOffer(pool, elsewhere[0]?.id as string))?.takenAt).toBeNull();
    expect(await listOpenOffers(pool, { now: later(3000) })).toHaveLength(1);
  });

  it('keeps the agent that offered it; an offer never changes hands', async () => {
    const [first] = await two();
    const taken = await takeOffer(pool, { id: first?.id as string, via: 'web', now: NOW });
    expect(taken.ok && taken.offer.agentId).toBe('mail-triage');
  });
});
