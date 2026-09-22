/**
 * Taking an offer from the dashboard.
 *
 * The bug this is written against: a chip clicked in the open conversation
 * queued a background run, the answer went to Telegram, and the thread the
 * owner was looking at showed nothing at all — while a second chip, clicked
 * while that job still held its lease, was refused with a 409 the page never
 * drew.
 *
 * So the rules under test are the two halves of that: a chip taken in its own
 * conversation is a *turn* of that conversation — sent exactly as a typed
 * message is, with the label stamped on it, and nothing on the queue — and
 * every refusal comes back as a status and a sentence the page can show.
 *
 * The database is a stub here, holding one offers table, because what is being
 * tested is the decision the route makes and not what Postgres does with an
 * UPDATE; `offers.db.test.ts` and `chat.web.db.test.ts` hold the real rows.
 */
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { OFFER_LAPSED_MESSAGE, type JobControl, type ToolContext, type ToolRegistry } from '@buddi/core';
import {
  OFFER_EXPIRED,
  OFFER_TAKEN_ALREADY,
  dismissOfferFromWeb,
  dismissOffersFromWeb,
  takeOfferFromWeb,
  type SendOfferTurn,
  type WriteDeps,
} from './write.js';

const NOW = new Date('2026-09-21T10:00:00.000Z');
const CONVERSATION = '11111111-1111-4111-8111-111111111111';

interface OfferRow {
  id: string;
  agent_id: string;
  conversation_id: string | null;
  label: string;
  prompt: string;
  created_at: Date;
  expires_at: Date;
  taken_at: Date | null;
  taken_via: string | null;
  taken_job_id: string | null;
  dismissed_at: Date | null;
  lapsed_at: Date | null;
  lapse_reason: string | null;
}

function offerRow(over: Partial<OfferRow> = {}): OfferRow {
  return {
    id: 'off-1',
    agent_id: 'postman',
    conversation_id: CONVERSATION,
    label: 'Send it',
    prompt: 'send the reply I drafted to Dorothée',
    created_at: NOW,
    expires_at: new Date(NOW.getTime() + 60_000),
    taken_at: null,
    taken_via: null,
    taken_job_id: null,
    dismissed_at: null,
    lapsed_at: null,
    lapse_reason: null,
    ...over,
  };
}

/** One offers table, and a log of every statement the route made. */
function stubPool(rows: OfferRow[]): { pool: Pool; statements: string[]; rows: OfferRow[] } {
  const statements: string[] = [];
  const pool = {
    async query(text: string, params: unknown[] = []): Promise<{ rows: OfferRow[] }> {
      statements.push(text);
      const id = String(params[0] ?? '');
      const row = rows.find((r) => r.id === id);
      if (/^\s*update core\.offers\s+set taken_at = \$2/.test(text)) {
        const now = params[1] as Date;
        if (!row || row.taken_at !== null || row.expires_at <= now) return { rows: [] };
        row.taken_at = now;
        row.taken_via = String(params[2]);
        return { rows: [row] };
      }
      if (/^\s*update core\.offers set taken_at = null/.test(text)) {
        if (!row || row.taken_at === null || row.taken_job_id !== null) return { rows: [] };
        row.taken_at = null;
        row.taken_via = null;
        return { rows: [row] };
      }
      if (/select .* from core\.offers where id = \$1/.test(text)) {
        return { rows: row ? [row] : [] };
      }
      if (/^\s*update core\.offers\s+set dismissed_at = \$2/.test(text)) {
        const now = params[1] as Date;
        if (!row || row.taken_at !== null || row.dismissed_at !== null || row.lapsed_at !== null || row.expires_at <= now) return { rows: [] };
        row.dismissed_at = params[1] as Date;
        return { rows: [row] };
      }
      if (/^\s*update core\.offers set dismissed_at = \$1/.test(text)) {
        const at = params[0] as Date;
        const ids = params[1] as string[];
        const cleared = rows.filter(
          (r) => r.taken_at === null && r.dismissed_at === null && r.lapsed_at === null
            && r.expires_at > at && ids.includes(r.id),
        );
        for (const r of cleared) r.dismissed_at = at;
        return { rows: cleared };
      }
      throw new Error(`the stub pool was asked something it does not hold: ${text}`);
    },
  } as unknown as Pool;
  return { pool, statements, rows };
}

function deps(pool: Pool): WriteDeps {
  return {
    pool,
    registry: {} as ToolRegistry,
    ctx: {} as ToolContext,
    now: () => NOW,
    // A queue exists in this process — which is exactly why "no job was
    // enqueued" is worth asserting.
    jobs: {} as JobControl,
  };
}

describe('taking an offer from the dashboard', () => {
  it('runs the chip in its own conversation as a turn, and queues nothing', async () => {
    const { pool, statements } = stubPool([offerRow()]);
    const sent: Parameters<SendOfferTurn>[0][] = [];
    const send: SendOfferTurn = async (input) => {
      sent.push(input);
      return { ok: true, conversationId: input.conversationId, runId: 'run-1' };
    };

    const result = await takeOfferFromWeb(deps(pool), 'off-1', { conversationId: CONVERSATION, send });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    // The turn is sent on the offer's conversation, with the prompt the *agent*
    // wrote, carrying the label the owner actually clicked.
    expect(sent).toEqual([
      {
        agentId: 'postman',
        conversationId: CONVERSATION,
        prompt: 'send the reply I drafted to Dorothée',
        offer: { id: 'off-1', label: 'Send it' },
      },
    ]);
    // Nothing on the queue: no job id for the page, and no job row written.
    expect((result as { body: { jobId: string | null; runId?: string } }).body.jobId).toBeNull();
    expect((result as { body: { runId?: string } }).body.runId).toBe('run-1');
    expect(statements.some((s) => /core\.jobs/.test(s))).toBe(false);
  });

  it('keeps the queued path for a chip taken away from its conversation', async () => {
    const { pool } = stubPool([offerRow()]);
    let called = 0;
    const send: SendOfferTurn = async () => {
      called += 1;
      return { ok: true, conversationId: CONVERSATION, runId: 'run-1' };
    };

    // The Offers list, or another thread: the page is not in the conversation
    // that offered this, so the run goes on the queue — where the handler puts
    // it back in the offer's own conversation.
    const result = await takeOfferFromWeb(deps(pool), 'off-1', {
      conversationId: '22222222-2222-4222-8222-222222222222',
      send,
    }).catch((err: unknown) => err);

    expect(called).toBe(0);
    // The stub has no jobs table, so reaching for one is the assertion.
    expect(String(result)).toMatch(/core\.jobs/);
  });

  it('surfaces the 409 when the offer is already taken, and the 404 when it never was', async () => {
    const { pool } = stubPool([offerRow({ taken_at: NOW, taken_via: 'telegram' })]);
    const send: SendOfferTurn = async () => ({ ok: true, conversationId: CONVERSATION, runId: 'r' });

    const taken = await takeOfferFromWeb(deps(pool), 'off-1', { conversationId: CONVERSATION, send });
    expect(taken.ok).toBe(false);
    expect(taken.status).toBe(409);
    expect((taken as { body: { error: string } }).body.error).toMatch(/already/i);

    const unknown = await takeOfferFromWeb(deps(pool), 'off-nope', { conversationId: CONVERSATION, send });
    expect(unknown.status).toBe(404);
    expect((unknown as { body: { error: string } }).body.error).not.toBe('');
  });

  it('refuses an expired chip in words the page can show', async () => {
    const { pool } = stubPool([offerRow({ expires_at: new Date(NOW.getTime() - 1) })]);
    let called = 0;
    const send: SendOfferTurn = async () => {
      called += 1;
      return { ok: true, conversationId: CONVERSATION, runId: 'r' };
    };

    const result = await takeOfferFromWeb(deps(pool), 'off-1', { conversationId: CONVERSATION, send });

    expect(result.status).toBe(409);
    expect((result as { body: { error: string } }).body.error).toBe(OFFER_EXPIRED);
    expect(OFFER_EXPIRED).toMatch(/expired/i);
    expect(called).toBe(0);
  });

  it('gives the claim back when the turn could not be started', async () => {
    const { pool, rows } = stubPool([offerRow()]);
    const send: SendOfferTurn = async () => ({
      ok: false,
      status: 409,
      error: 'Postman has no model account.',
    });

    const result = await takeOfferFromWeb(deps(pool), 'off-1', { conversationId: CONVERSATION, send });

    expect(result.status).toBe(409);
    expect((result as { body: { error: string } }).body.error).toBe('Postman has no model account.');
    // The chip is on the table again: a take that started nothing must not
    // leave a button that is dead for everyone.
    expect(rows[0]!.taken_at).toBeNull();
  });
});

/**
 * The other answer.
 *
 * Every test above is about yes. These are about no, which is the half the
 * page did not have: the owner could take an offer or wait a week, and on an
 * installation with 65 of them that is not a choice.
 */
describe('dismissing an offer from the dashboard', () => {
  it('records the refusal, starts nothing, and is idempotent', async () => {
    const { pool, rows, statements } = stubPool([offerRow()]);

    const result = await dismissOfferFromWeb(deps(pool), 'off-1');

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(rows[0]!.dismissed_at).toEqual(NOW);
    // Nothing runs and nothing is queued: refusing is the cheapest write here.
    expect(statements.some((s) => /core\.jobs/.test(s))).toBe(false);
    expect(rows[0]!.taken_at).toBeNull();

    // Two tabs, or a double click. Saying no twice is not an error.
    const again = await dismissOfferFromWeb(deps(pool), 'off-1');
    expect(again.ok).toBe(true);
    expect(again.status).toBe(200);
  });

  it('refuses to hide one that is already running, and 404s an id that names nothing', async () => {
    const { pool, rows } = stubPool([offerRow({ taken_at: NOW, taken_via: 'telegram' })]);

    const running = await dismissOfferFromWeb(deps(pool), 'off-1');
    expect(running.status).toBe(409);
    expect((running as { body: { error: string } }).body.error).toBe(OFFER_TAKEN_ALREADY);
    expect(rows[0]!.dismissed_at).toBeNull();

    expect((await dismissOfferFromWeb(deps(pool), 'off-nope')).status).toBe(404);
  });

  it('reports a stale offer as lapsed or expired instead of rewriting it as refused', async () => {
    const { pool, rows } = stubPool([
      offerRow({ id: 'off-lapsed', lapsed_at: NOW, lapse_reason: 'owner-moved-on' }),
      offerRow({ id: 'off-expired', expires_at: new Date(NOW.getTime() - 1) }),
    ]);
    const lapsed = await dismissOfferFromWeb(deps(pool), 'off-lapsed');
    const expired = await dismissOfferFromWeb(deps(pool), 'off-expired');
    expect(lapsed).toEqual({ ok: false, status: 409, body: { error: OFFER_LAPSED_MESSAGE } });
    expect(expired).toEqual({ ok: false, status: 409, body: { error: OFFER_EXPIRED } });
    expect(rows.every((row) => row.dismissed_at === null)).toBe(true);
  });

  it('clears the list and says how many it cleared', async () => {
    const { pool, rows } = stubPool([
      offerRow(),
      offerRow({ id: 'off-2', label: 'Edit it' }),
      offerRow({ id: 'off-3', agent_id: 'ledger', label: 'Pay it' }),
      offerRow({ id: 'off-4', taken_at: NOW }),
    ]);

    const mine = await dismissOffersFromWeb(deps(pool), ['off-3']);
    expect((mine as { body: { dismissed: number } }).body.dismissed).toBe(1);

    const all = await dismissOffersFromWeb(deps(pool), ['off-1', 'off-2']);
    expect((all as { body: { dismissed: number } }).body.dismissed).toBe(2);
    // The one that is running is untouched: it started work.
    expect(rows.find((r) => r.id === 'off-4')!.dismissed_at).toBeNull();

    expect((await dismissOffersFromWeb(deps(pool), ['off-1', 'off-2'])).ok).toBe(true);
    expect(((await dismissOffersFromWeb(deps(pool), ['off-1', 'off-2'])) as { body: { dismissed: number } }).body.dismissed).toBe(0);
  });
});
