/**
 * Offered actions — what a report hands the owner to *do*.
 *
 * A report used to be prose and nothing else. This is the other half: a
 * handful of next moves the agent already worked out, rendered as buttons
 * where a surface has them and as plain words where it does not.
 *
 * The trust story is deliberately boring. An offer is a **shortcut for typing
 * a sentence**, not a capability: taking one enqueues an ordinary agent run
 * with the agent's own prompt, and every tier, every approval and every
 * preview along that run is exactly what it was before. Nothing here can send
 * mail, move money or authorize anything — an offer that leads to an effect
 * leads to the same approval the owner would have seen anyway.
 */

/** The longest label a surface will render. Telegram buttons wrap badly past this. */
export const MAX_OFFER_LABEL = 28;

/** The longest prompt an offer may carry. It is a request, not a briefing. */
export const MAX_OFFER_PROMPT = 500;

/** At most this many offers on one report. Three fit a phone; more is a menu. */
export const MAX_OFFERS = 3;

/**
 * How long a button stays live.
 *
 * It was a week, and a week was wrong. An offer is the tail of a conversation:
 * it describes a decision that was live when the agent wrote it, and two days
 * later the mail has been answered, the bill is paid, or the owner has simply
 * stopped thinking about it. Sixty-five of them accumulated on this
 * installation before anyone noticed, and a list nobody can finish is a list
 * nobody reads. Forty-eight hours is long enough to cover a night and a busy
 * next day, and short enough that what is on the table is genuinely on the
 * table.
 *
 * Rows written before this keep the expiry they were given — see migration
 * 033. This is a fact about offers made from now on.
 */
export const OFFER_TTL_MS = 48 * 60 * 60_000;

/**
 * How long a dismissed or lapsed offer stays readable under the fold.
 *
 * Refusing something should not make it vanish as if it never happened: for a
 * week the owner can open the fold and see what they turned down and what
 * expired underneath them. After that it is gone from every read; the row
 * stays for the record.
 */
export const OFFER_FOLD_MS = 7 * 24 * 60 * 60_000;

/**
 * Why an offer lapsed — three ways the moment can pass without anybody
 * deciding anything.
 *
 *  - `owner-moved-on`: the conversation had an owner turn after the offer was
 *    made. They answered in words instead of tapping, which is an answer.
 *  - `rolled-over`: the conversation ended — a lifetime boundary, or archived.
 *  - `agent-removed`: the agent that offered it is no longer installed, so
 *    there is nobody to take it.
 */
export type LapseReason = 'owner-moved-on' | 'rolled-over' | 'agent-removed';

/** What an agent offers, before it is stored. */
export interface OfferedAction {
  /** What the owner reads: "Draft a reply", "Remind me tomorrow". */
  label: string;
  /** What the agent is asked when the owner takes it, in the owner's voice. */
  prompt: string;
}

/** A stored offer: an `OfferedAction` with an id a surface can bind a tap to. */
export interface Offer extends OfferedAction {
  id: string;
  agentId: string;
  conversationId: string | null;
  createdAt: string;
  expiresAt: string;
  takenAt: string | null;
  takenVia: string | null;
  takenJobId: string | null;
  /** When the owner said no. Null means they never did. */
  dismissedAt: string | null;
  /** When the moment passed without them. Null means it has not. */
  lapsedAt: string | null;
  /** Which condition lapsed it, when one did. */
  lapseReason: LapseReason | null;
}

/** Still on the table: nobody took it, refused it, or let it go stale. */
export function isOfferLive(offer: Offer, now: Date): boolean {
  return (
    offer.takenAt === null &&
    offer.dismissedAt === null &&
    offer.lapsedAt === null &&
    new Date(offer.expiresAt).getTime() > now.getTime()
  );
}

export const OFFER_COLUMNS =
  'id, agent_id, conversation_id, label, prompt, created_at, expires_at, taken_at, ' +
  'taken_via, taken_job_id, dismissed_at, lapsed_at, lapse_reason';

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function toOffer(row: Record<string, any>): Offer {
  return {
    id: String(row.id),
    agentId: row.agent_id,
    conversationId: row.conversation_id === null || row.conversation_id === undefined
      ? null
      : String(row.conversation_id),
    label: row.label,
    prompt: row.prompt,
    createdAt: iso(row.created_at) ?? '',
    expiresAt: iso(row.expires_at) ?? '',
    takenAt: iso(row.taken_at),
    takenVia: row.taken_via ?? null,
    takenJobId: row.taken_job_id === null || row.taken_job_id === undefined
      ? null
      : String(row.taken_job_id),
    dismissedAt: iso(row.dismissed_at),
    lapsedAt: iso(row.lapsed_at),
    lapseReason: (row.lapse_reason ?? null) as LapseReason | null,
  };
}

/** Why an offer could not be taken. Each is an ordinary outcome, not an error. */
export type OfferRefusal = 'unknown' | 'already-taken' | 'expired' | 'dismissed' | 'lapsed';

/**
 * What a tap on a lapsed button is told, on every surface.
 *
 * Deliberately not "expired" and not "already taken": neither happened. The
 * owner moved on, and the honest sentence says so without implying they did
 * something wrong or that something is running.
 */
export const OFFER_LAPSED_MESSAGE = 'That offer has lapsed.';

/** What a tap on an offer the owner themselves dismissed is told. */
export const OFFER_DISMISSED_MESSAGE = 'You dismissed that one.';

export type TakeOfferResult =
  | { ok: true; offer: Offer }
  | { ok: false; reason: OfferRefusal; message: string; offer?: Offer };
