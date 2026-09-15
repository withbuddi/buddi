/**
 * The offer store.
 *
 * Two operations matter and both are one statement each. `offerActions` writes
 * the set a report carries; `takeOffer` claims one *atomically*, so two taps —
 * an impatient thumb on Telegram, the same offer clicked on the dashboard —
 * produce one run and one "already taken", never two runs.
 *
 * Validation lives here rather than in a prompt: a label or a prompt over the
 * cap is truncated at the boundary, and a set over `MAX_OFFERS` is cut, because
 * a report that offered nine buttons is a report the owner stops reading — with
 * one exception, `maxPromptChars`, for the offer that carries the owner's own
 * words back to the agent verbatim.
 */
import type { Queryable } from '../owner.js';
import {
  MAX_OFFERS,
  MAX_OFFER_LABEL,
  MAX_OFFER_PROMPT,
  OFFER_COLUMNS,
  OFFER_TTL_MS,
  toOffer,
  type Offer,
  type OfferedAction,
  type TakeOfferResult,
} from './types.js';

/** A button label: one line, whatever the agent typed. */
function clipLabel(value: string, max: number): string {
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * A prompt, trimmed and capped but never reflowed.
 *
 * A prompt is a sentence sent to an agent, not a caption: nothing renders it on
 * one line, and a "Try again" offer carries the owner's own message, paragraph
 * breaks and all. Collapsing its whitespace would quietly rewrite it.
 */
function clipPrompt(value: string, max: number): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Normalize what an agent offered: trimmed, capped, de-duplicated by label,
 * and never more than `MAX_OFFERS`. Empty entries are dropped rather than
 * stored as a blank button.
 */
export function normalizeOffers(
  actions: readonly OfferedAction[],
  maxPromptChars: number = MAX_OFFER_PROMPT,
): OfferedAction[] {
  const seen = new Set<string>();
  const out: OfferedAction[] = [];
  for (const action of actions) {
    const label = clipLabel(action?.label ?? '', MAX_OFFER_LABEL);
    const prompt = clipPrompt(action?.prompt ?? '', maxPromptChars);
    if (label === '' || prompt === '') continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, prompt });
    if (out.length >= MAX_OFFERS) break;
  }
  return out;
}

export interface OfferActionsInput {
  agentId: string;
  conversationId?: string | null;
  actions: readonly OfferedAction[];
  now: Date;
  ttlMs?: number;
  /**
   * Raise the prompt cap for this call only.
   *
   * `MAX_OFFER_PROMPT` exists to stop an *agent* writing a briefing where a
   * request belongs, and truncating one at the boundary is the right answer
   * there. A "Try again" offer is different in kind: its prompt is the owner's
   * own sentence, and the whole promise of the button is that it re-runs
   * exactly what they said. A retry that silently ran the first 500 characters
   * of their message would be worse than no button, so that caller raises the
   * cap rather than accepting the ellipsis.
   */
  maxPromptChars?: number;
}

/** Store the offers a report carries. Returns them with the ids a surface binds. */
export async function offerActions(
  pool: Queryable,
  input: OfferActionsInput,
): Promise<Offer[]> {
  const agentId = (input.agentId ?? '').trim();
  if (agentId === '') throw new Error('offerActions: an offer belongs to the agent that made it');
  const actions = normalizeOffers(input.actions, input.maxPromptChars);
  if (actions.length === 0) return [];

  const expiresAt = new Date(input.now.getTime() + (input.ttlMs ?? OFFER_TTL_MS));
  const stored: Offer[] = [];
  for (const action of actions) {
    const { rows } = await pool.query(
      `insert into core.offers (agent_id, conversation_id, label, prompt, created_at, expires_at)
       values ($1, $2, $3, $4, $5, $6)
       returning ${OFFER_COLUMNS}`,
      [agentId, input.conversationId ?? null, action.label, action.prompt, input.now, expiresAt],
    );
    const row = rows[0];
    if (!row) throw new Error('offerActions: insert returned no row');
    stored.push(toOffer(row));
  }
  return stored;
}

/** One offer by id, or null. */
export async function getOffer(pool: Queryable, id: string): Promise<Offer | null> {
  const { rows } = await pool.query(
    `select ${OFFER_COLUMNS} from core.offers where id = $1`,
    [id],
  );
  return rows[0] ? toOffer(rows[0]) : null;
}

/** What is still on the table: untaken, unexpired, newest first. */
export async function listOpenOffers(
  pool: Queryable,
  opts: { now: Date; limit?: number; agentId?: string; conversationId?: string },
): Promise<Offer[]> {
  const params: unknown[] = [opts.now];
  const where = ['taken_at is null', 'expires_at > $1'];
  if (opts.agentId) {
    params.push(opts.agentId);
    where.push(`agent_id = $${params.length}`);
  }
  // What one conversation currently has on the table: the dashboard's chat
  // draws exactly this set under the turn that offered it.
  if (opts.conversationId) {
    params.push(opts.conversationId);
    where.push(`conversation_id = $${params.length}`);
  }
  params.push(Math.min(Math.max(1, Math.trunc(opts.limit ?? 20)), 100));
  const { rows } = await pool.query(
    `select ${OFFER_COLUMNS} from core.offers
      where ${where.join(' and ')}
      order by created_at desc
      limit $${params.length}`,
    params,
  );
  return rows.map(toOffer);
}

export interface TakeOfferInput {
  id: string;
  /** The surface the tap came from. Recorded for the record, never trusted. */
  via: string;
  now: Date;
}

/**
 * Claim an offer, once.
 *
 * The UPDATE *is* the claim: `taken_at is null and expires_at > now` in the
 * WHERE clause means the database decides the race, not a read-then-write here.
 * Nothing runs as a result — the caller enqueues the run and stamps the job id
 * with `recordOfferJob`, so a claim that cannot be enqueued is still visibly a
 * claim rather than a silently repeatable button.
 */
export async function takeOffer(pool: Queryable, input: TakeOfferInput): Promise<TakeOfferResult> {
  const { rows } = await pool.query(
    `update core.offers
        set taken_at = $2, taken_via = $3
      where id = $1 and taken_at is null and expires_at > $2
      returning ${OFFER_COLUMNS}`,
    [input.id, input.now, input.via],
  );
  const claimed = rows[0];
  if (claimed) return { ok: true, offer: toOffer(claimed) };

  const existing = await getOffer(pool, input.id);
  if (!existing) {
    return { ok: false, reason: 'unknown', message: 'That option is no longer available.' };
  }
  if (existing.takenAt !== null) {
    return {
      ok: false,
      reason: 'already-taken',
      message: 'Already on it.',
      offer: existing,
    };
  }
  return {
    ok: false,
    reason: 'expired',
    message: 'That option has expired — just ask me instead.',
    offer: existing,
  };
}

/** Stamp the run a taken offer started. Bookkeeping; never fails the tap. */
export async function recordOfferJob(
  pool: Queryable,
  id: string,
  jobId: string,
): Promise<void> {
  await pool.query('update core.offers set taken_job_id = $2 where id = $1', [id, jobId]);
}

/**
 * Withdraw every offer still open in one conversation.
 *
 * An offer belongs to the turn that made it. In a live conversation the turn
 * ends the moment the owner says the next thing, so the buttons that turn drew
 * stop being an accurate picture of what is on the table — the owner may have
 * answered in words, asked for something else, or had a newer turn offer a new
 * set. Rather than leave a button that still fires hours later, the next turn
 * of the same conversation withdraws what the previous one offered.
 *
 * Withdrawing is expiry, not deletion: the row stays for the record, and a tap
 * on the dead button gets the ordinary "that option has expired — just ask me
 * instead" rather than silence or a surprise run. Taken offers are untouched.
 *
 * Returns how many were withdrawn.
 */
export async function withdrawOffers(
  pool: Queryable,
  input: { conversationId: string; now: Date },
): Promise<number> {
  const conversationId = (input.conversationId ?? '').trim();
  if (conversationId === '') return 0;
  const { rows } = await pool.query(
    `update core.offers
        set expires_at = $2
      where conversation_id = $1 and taken_at is null and expires_at > $2
      returning id`,
    [conversationId, input.now],
  );
  return rows.length;
}
