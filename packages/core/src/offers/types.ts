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

/** How long a button stays live. A tap next week is about stale facts. */
export const OFFER_TTL_MS = 7 * 24 * 60 * 60_000;

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
}

export const OFFER_COLUMNS =
  'id, agent_id, conversation_id, label, prompt, created_at, expires_at, taken_at, ' +
  'taken_via, taken_job_id';

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
  };
}

/** Why an offer could not be taken. Each is an ordinary outcome, not an error. */
export type OfferRefusal = 'unknown' | 'already-taken' | 'expired';

export type TakeOfferResult =
  | { ok: true; offer: Offer }
  | { ok: false; reason: OfferRefusal; message: string; offer?: Offer };
