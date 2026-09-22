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
  OFFER_DISMISSED_MESSAGE,
  OFFER_FOLD_MS,
  OFFER_LAPSED_MESSAGE,
  OFFER_TTL_MS,
  toOffer,
  type LapseReason,
  type Offer,
  type OfferedAction,
  type TakeOfferResult,
} from './types.js';

/** The three ways a row stops being on the table, as one SQL fragment. */
const LIVE = 'taken_at is null and dismissed_at is null and lapsed_at is null';

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
  const where = [LIVE, 'expires_at > $1'];
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
      where id = $1 and ${LIVE} and expires_at > $2
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
  // Dismissed and lapsed are refusals in their own right, and each is told the
  // truth rather than folded into "expired": the owner said no to one, and
  // nobody said anything at all about the other.
  if (existing.dismissedAt !== null) {
    return {
      ok: false,
      reason: 'dismissed',
      message: OFFER_DISMISSED_MESSAGE,
      offer: existing,
    };
  }
  if (existing.lapsedAt !== null) {
    return {
      ok: false,
      reason: 'lapsed',
      message: OFFER_LAPSED_MESSAGE,
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

/**
 * Give a claimed offer back, when nothing could be started from it.
 *
 * The claim is deliberately made *before* the run, so two taps cannot become
 * two runs. The cost is that a take whose run never started would leave a dead
 * button: claimed, with nothing behind it. This is the one undo — used by the
 * surface that claimed the row moments earlier, and only when starting the turn
 * failed outright, so the chip comes back rather than going grey forever.
 *
 * Nothing that has a job on it is released: that offer did start something.
 */
export async function releaseOffer(pool: Queryable, id: string): Promise<boolean> {
  const { rows } = await pool.query(
    `update core.offers set taken_at = null, taken_via = null
      where id = $1 and taken_at is not null and taken_job_id is null
      returning id`,
    [id],
  );
  return rows.length > 0;
}

/** Stamp the run a taken offer started. Bookkeeping; never fails the tap. */
export async function recordOfferJob(
  pool: Queryable,
  id: string,
  jobId: string,
): Promise<void> {
  await pool.query('update core.offers set taken_job_id = $2 where id = $1', [id, jobId]);
}

/* ------------------------------------------------------------------ *
 * Saying no
 * ------------------------------------------------------------------ */

/**
 * The owner said no to one offer.
 *
 * The other half of a button. Until now the only answers to an offer were
 * "take it" and "wait a week", which is how an installation ends up holding 65
 * of them: nothing the owner could do cleared one, so nothing did.
 *
 * It is recorded, not deleted — an offer the owner refused is a thing that
 * happened, and it stays readable under the fold for a week. A taken offer is
 * never dismissed: that one started a run, and hiding it would be a lie about
 * what the installation is doing.
 */
export async function dismissOffer(
  pool: Queryable,
  input: { id: string; now: Date },
): Promise<Offer | null> {
  const { rows } = await pool.query(
    `update core.offers
        set dismissed_at = $2
      where id = $1 and taken_at is null and dismissed_at is null
        and lapsed_at is null and expires_at > $2
      returning ${OFFER_COLUMNS}`,
    [input.id, input.now],
  );
  return rows[0] ? toOffer(rows[0]) : null;
}

/**
 * The owner said no to the offers the page actually displayed.
 *
 * The honest bulk action: the owner looked at a list of things they are never
 * going to do and cleared it. IDs bind the write to that exact displayed
 * snapshot, so a concurrently-created or undisplayed row is never swept in.
 */
export async function dismissOffers(
  pool: Queryable,
  input: { now: Date; ids: readonly string[] },
): Promise<number> {
  const ids = [...new Set(input.ids.filter((id) => id !== ''))];
  if (ids.length === 0) return 0;
  const { rows } = await pool.query(
    `update core.offers set dismissed_at = $1
      where id = any($2::uuid[]) and taken_at is null and dismissed_at is null
        and lapsed_at is null and expires_at > $1
      returning id`,
    [input.now, ids],
  );
  return rows.length;
}

/* ------------------------------------------------------------------ *
 * Lapsing
 * ------------------------------------------------------------------ */

/**
 * Mark one conversation's open offers as lapsed.
 *
 * Used where the installation *knows* the moment passed — a lifetime rollover,
 * It replaces the older `withdrawOffers`, which pushed `expires_at` back to
 * now: a tap on one of those was told the offer had expired, which was never
 * quite true — the clock had nothing to do with it. Lapsing records what
 * actually happened, and the tap is told that.
 */
export async function lapseConversationOffers(
  pool: Queryable,
  input: { conversationId: string; reason: LapseReason; now: Date },
): Promise<number> {
  const conversationId = (input.conversationId ?? '').trim();
  if (conversationId === '') return 0;
  const { rows } = await pool.query(
    `update core.offers
        set lapsed_at = $2, lapse_reason = $3
      where conversation_id = $1 and ${LIVE} and expires_at > $2
      returning id`,
    [conversationId, input.now, input.reason],
  );
  return rows.length;
}

/**
 * Find the offers whose moment has passed, and mark them.
 *
 * Three conditions, one statement, and no scheduler: this runs on every read
 * of the live list and once more at gateway start, which is as often as it
 * needs to and never in the background. It is cheap because it only ever looks
 * at rows that are still live — a handful, by construction, once this works.
 *
 *  1. **The owner moved on.** A message of theirs in the offer's conversation,
 *     written after the offer was. They answered in words; the buttons under
 *     the previous turn describe a decision that is no longer the live one.
 *  2. **The conversation ended.** Its group was archived. Lifetime rollover
 *     is explicit at the point that creates the successor conversation.
 *  3. **The agent was removed.** Only checked when the caller knows the roster
 *     (`agentIds`): a reader that cannot name the installed agents must not
 *     conclude that all of them are gone.
 *
 * Returns how many lapsed.
 */
export async function sweepLapsedOffers(
  pool: Queryable,
  input: { now: Date; agentIds?: readonly string[] | undefined },
): Promise<number> {
  const roster = input.agentIds === undefined ? null : [...input.agentIds];
  const params: unknown[] = [input.now];
  // Each condition names its own reason, and the CASE decides which is
  // recorded when more than one holds. The order is the order of directness:
  // an owner who typed the next message said the clearest thing.
  let removed = 'false';
  if (roster !== null) {
    params.push(roster);
    removed = `not (o.agent_id = any($${params.length}::text[]))`;
  }
  const movedOn = `exists (
        select 1 from core.messages m
         where m.conversation_id = o.conversation_id
           and m.role = 'user'
           and m.created_at > o.created_at)`;
  const ended = `exists (
        select 1 from core.conversations c
          left join core.groups g on g.id = c.group_id
         where c.id = o.conversation_id
           and g.archived_at is not null)`;
  const { rows } = await pool.query(
    `update core.offers o
        set lapsed_at = $1,
            lapse_reason = case
              when ${movedOn} then 'owner-moved-on'
              when ${ended} then 'rolled-over'
              else 'agent-removed' end
      where ${LIVE} and o.expires_at > $1
        and (${movedOn} or ${ended} or ${removed})
      returning o.id`,
    params,
  );
  return rows.length;
}

/**
 * What the fold holds: offers dismissed or lapsed within the last week.
 *
 * Older than that and they are gone from the read entirely — the row stays,
 * but a list of everything the owner ever said no to is not a list anybody
 * wants. Newest closing first, whichever way it closed.
 */
export async function listClosedOffers(
  pool: Queryable,
  opts: { now: Date; limit?: number; agentId?: string | undefined; foldMs?: number },
): Promise<Offer[]> {
  const since = new Date(opts.now.getTime() - (opts.foldMs ?? OFFER_FOLD_MS));
  const params: unknown[] = [since];
  const where = [
    '(dismissed_at is not null or lapsed_at is not null)',
    'taken_at is null',
    'greatest(dismissed_at, lapsed_at) > $1',
  ];
  if (opts.agentId !== undefined && opts.agentId !== '') {
    params.push(opts.agentId);
    where.push(`agent_id = $${params.length}`);
  }
  params.push(Math.min(Math.max(1, Math.trunc(opts.limit ?? 20)), 100));
  const { rows } = await pool.query(
    `select ${OFFER_COLUMNS} from core.offers
      where ${where.join(' and ')}
      order by greatest(dismissed_at, lapsed_at) desc
      limit $${params.length}`,
    params,
  );
  return rows.map(toOffer);
}
