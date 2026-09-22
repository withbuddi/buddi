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
  dismissOffer,
  dismissOffers,
  getOffer,
  lapseConversationOffers,
  listClosedOffers,
  listOpenOffers,
  offerActions,
  recordOfferJob,
  releaseOffer,
  sweepLapsedOffers,
  takeOffer,
} from './store.js';
import { OFFER_FOLD_MS, OFFER_TTL_MS } from './types.js';
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
    await pool.query('truncate core.conversations cascade');
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
   * conversation's next turn lapses what the last one left on the table, so a
   * button cannot still fire an hour and three subjects later — and a tap on
   * the dead one is told it lapsed, never silence and never a surprise run.
   */
  it('lapses a conversation’s open offers, and a later tap is told so', async () => {
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
    // One of them was taken before the turn moved on; lapsing must not touch
    // it, and must not un-take it.
    const takenId = stored[1]?.id as string;
    await takeOffer(pool, { id: takenId, via: 'telegram', now: NOW });

    expect(
      await listOpenOffers(pool, { now: later(1000), conversationId }),
    ).toHaveLength(1);

    expect(
      await lapseConversationOffers(pool, { conversationId, reason: 'owner-moved-on', now: later(1000) }),
    ).toBe(1);
    expect(await listOpenOffers(pool, { now: later(1000), conversationId })).toEqual([]);

    const late = await takeOffer(pool, {
      id: stored[0]?.id as string,
      via: 'web',
      now: later(2000),
    });
    expect(late).toMatchObject({ ok: false, reason: 'lapsed' });
    // Lapsed, not deleted: the row is still there for the record.
    expect((await getOffer(pool, stored[0]?.id as string))?.takenAt).toBeNull();
    expect((await getOffer(pool, takenId))?.takenVia).toBe('telegram');

    // Another conversation's offers are nobody else's to retire.
    const elsewhere = await offerActions(pool, {
      agentId: 'mail-triage',
      actions: [{ label: 'Remind me', prompt: 'remind me tomorrow' }],
      now: NOW,
    });
    expect(
      await lapseConversationOffers(pool, { conversationId, reason: 'owner-moved-on', now: later(3000) }),
    ).toBe(0);
    expect((await getOffer(pool, elsewhere[0]?.id as string))?.takenAt).toBeNull();
    expect(await listOpenOffers(pool, { now: later(3000) })).toHaveLength(1);
  });

  it('keeps the agent that offered it; an offer never changes hands', async () => {
    const [first] = await two();
    const taken = await takeOffer(pool, { id: first?.id as string, via: 'web', now: NOW });
    expect(taken.ok && taken.offer.agentId).toBe('mail-triage');
  });
});

suite('saying no to an offer (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  const DB = `buddi_offers_no_test_${process.pid}`;

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

  beforeEach(async () => {
    await pool.query('truncate core.offers cascade');
    await pool.query('truncate core.conversations cascade');
  });

  const conversation = async (agentId = 'mail-triage', at: Date = NOW): Promise<string> => {
    const { rows } = await pool.query(
      'insert into core.conversations (agent_id, created_at) values ($1, $2) returning id',
      [agentId, at],
    );
    return String(rows[0].id);
  };

  const ownerSaid = async (conversationId: string, at: Date): Promise<void> => {
    await pool.query(
      `insert into core.messages (conversation_id, role, content, created_at)
       values ($1::uuid, 'user', $2::jsonb, $3)`,
      [conversationId, JSON.stringify([{ type: 'text', text: 'never mind' }]), at],
    );
  };

  const offerIn = async (
    conversationId: string | null,
    agentId = 'mail-triage',
    label = 'Send it',
  ): Promise<string> => {
    const [stored] = await offerActions(pool, {
      agentId,
      conversationId,
      actions: [{ label, prompt: 'send the reply I drafted' }],
      now: NOW,
    });
    return stored?.id as string;
  };

  /**
   * The whole point. 65 offers piled up on the owner's installation because
   * there was no answer but yes; dismissing is the answer he did not have.
   */
  it('takes a dismissed offer off the table everywhere, and refuses a later tap', async () => {
    const id = await offerIn(null);
    expect(await listOpenOffers(pool, { now: NOW })).toHaveLength(1);

    const dismissed = await dismissOffer(pool, { id, now: later(1000) });
    expect(dismissed?.dismissedAt).not.toBeNull();
    expect(await listOpenOffers(pool, { now: later(2000) })).toEqual([]);

    const late = await takeOffer(pool, { id, via: 'telegram', now: later(2000) });
    expect(late).toMatchObject({ ok: false, reason: 'dismissed' });
    // Recorded, not deleted: the row and its prompt are still there.
    expect((await getOffer(pool, id))?.label).toBe('Send it');
  });

  it('never dismisses one that is already running', async () => {
    const id = await offerIn(null);
    await takeOffer(pool, { id, via: 'web', now: NOW });
    expect(await dismissOffer(pool, { id, now: later(1000) })).toBeNull();
    expect((await getOffer(pool, id))?.dismissedAt).toBeNull();
  });

  it('never rewrites a lapsed or expired offer as an owner refusal', async () => {
    const lapsed = await offerIn(null, 'mail-triage', 'Lapsed');
    await pool.query(
      `update core.offers set lapsed_at = $2, lapse_reason = 'owner-moved-on' where id = $1`,
      [lapsed, later(1000)],
    );
    const expired = await offerIn(null, 'mail-triage', 'Expired');
    expect(await dismissOffer(pool, { id: lapsed, now: later(2000) })).toBeNull();
    expect(await dismissOffer(pool, { id: expired, now: later(3 * 24 * 60 * 60_000) })).toBeNull();
    expect((await getOffer(pool, lapsed))?.dismissedAt).toBeNull();
    expect((await getOffer(pool, expired))?.dismissedAt).toBeNull();
  });

  it('clears only the displayed ids', async () => {
    const one = await offerIn(null, 'mail-triage', 'One');
    const two = await offerIn(null, 'mail-triage', 'Two');
    const three = await offerIn(null, 'ledger', 'Three');

    expect(await dismissOffers(pool, { now: later(1000), ids: [three] })).toBe(1);
    expect((await listOpenOffers(pool, { now: later(1000) })).map((o) => o.agentId)).toEqual([
      'mail-triage',
      'mail-triage',
    ]);
    expect(await dismissOffers(pool, { now: later(2000), ids: [one] })).toBe(1);
    expect((await listOpenOffers(pool, { now: later(2000) })).map((o) => o.id)).toEqual([two]);
    expect(await dismissOffers(pool, { now: later(2000), ids: [two] })).toBe(1);
    expect(await listOpenOffers(pool, { now: later(2000) })).toEqual([]);
    // Nothing left to clear, and asking again is not an error.
    expect(await dismissOffers(pool, { now: later(3000), ids: [one, two, three] })).toBe(0);
  });

  /* ---------------- the three ways a moment passes ---------------- */

  it('lapses an offer when the owner answered in words instead', async () => {
    const conv = await conversation();
    const id = await offerIn(conv);
    await ownerSaid(conv, later(60_000));

    expect(await sweepLapsedOffers(pool, { now: later(120_000) })).toBe(1);
    const row = await getOffer(pool, id);
    expect(row?.lapseReason).toBe('owner-moved-on');
    expect(await listOpenOffers(pool, { now: later(120_000) })).toEqual([]);
    expect(await takeOffer(pool, { id, via: 'telegram', now: later(120_000) })).toMatchObject({
      ok: false,
      reason: 'lapsed',
    });
  });

  it('keeps unrelated newer conversations live, and lapses one whose group was archived', async () => {
    const conv = await conversation('mail-triage', NOW);
    const id = await offerIn(conv);
    // Agents may have concurrent conversations; a newer one proves nothing
    // about this one's lifetime.
    await conversation('mail-triage', later(60_000));

    expect(await sweepLapsedOffers(pool, { now: later(120_000) })).toBe(0);
    expect((await getOffer(pool, id))?.lapseReason).toBeNull();

    // Archived, by the group the conversation belongs to.
    const { rows } = await pool.query(
      `insert into core.groups (name, coordinator_agent_id, archived_at) values ('done', 'ledger', $1) returning id`,
      [later(60_000)],
    );
    const archived = await conversation('ledger', NOW);
    await pool.query('update core.conversations set group_id = $2 where id = $1', [archived, rows[0].id]);
    const inArchive = await offerIn(archived, 'ledger');
    expect(await sweepLapsedOffers(pool, { now: later(120_000) })).toBe(1);
    expect((await getOffer(pool, inArchive))?.lapseReason).toBe('rolled-over');
  });

  it('lapses an offer whose agent was removed, and only when the roster is known', async () => {
    const id = await offerIn(null, 'departed');
    // A caller that cannot name the installed agents concludes nothing.
    expect(await sweepLapsedOffers(pool, { now: later(1000) })).toBe(0);
    expect(await sweepLapsedOffers(pool, { now: later(1000), agentIds: ['departed', 'ledger'] })).toBe(0);

    expect(await sweepLapsedOffers(pool, { now: later(1000), agentIds: ['ledger'] })).toBe(1);
    expect((await getOffer(pool, id))?.lapseReason).toBe('agent-removed');
  });

  it('lapses a conversation’s offers outright when the thread is known to have ended', async () => {
    const conv = await conversation();
    const id = await offerIn(conv);
    expect(await lapseConversationOffers(pool, { conversationId: conv, reason: 'rolled-over', now: later(1000) })).toBe(1);
    expect((await getOffer(pool, id))?.lapseReason).toBe('rolled-over');
    // Nothing left live to lapse twice.
    expect(await lapseConversationOffers(pool, { conversationId: conv, reason: 'rolled-over', now: later(2000) })).toBe(0);
  });

  /* ---------------- the fold ---------------- */

  it('keeps the dismissed and the lapsed readable for a week, then stops', async () => {
    const dismissed = await offerIn(null);
    const conv = await conversation();
    const lapsed = await offerIn(conv);
    await ownerSaid(conv, later(60_000));
    await dismissOffer(pool, { id: dismissed, now: later(60_000) });
    await sweepLapsedOffers(pool, { now: later(120_000) });

    const fold = await listClosedOffers(pool, { now: later(120_000) });
    expect(fold.map((o) => o.id).sort()).toEqual([dismissed, lapsed].sort());

    // A week later they are gone from the read — the rows are not.
    expect(await listClosedOffers(pool, { now: later(OFFER_FOLD_MS + 120_000) })).toEqual([]);
    expect(await getOffer(pool, dismissed)).not.toBeNull();
  });

  /**
   * A week was too long: an offer is the tail of a conversation, and the facts
   * behind it are stale long before the button is.
   */
  it('gives a new offer 48 hours, and leaves what was already written alone', async () => {
    expect(OFFER_TTL_MS).toBe(48 * 60 * 60_000);
    const [fresh] = await offerActions(pool, {
      agentId: 'mail-triage',
      actions: [{ label: 'Send it', prompt: 'send it' }],
      now: NOW,
    });
    expect(new Date(fresh?.expiresAt as string).getTime() - NOW.getTime()).toBe(48 * 60 * 60_000);

    // A row written before the change keeps the week it was promised: nothing
    // backfills, and the migration says so.
    const [old] = await offerActions(pool, {
      agentId: 'mail-triage',
      actions: [{ label: 'Remind me', prompt: 'remind me' }],
      now: NOW,
      ttlMs: 7 * 24 * 60 * 60_000,
    });
    expect((await listOpenOffers(pool, { now: later(72 * 60 * 60_000) })).map((o) => o.id)).toEqual([
      old?.id,
    ]);
  });
});
