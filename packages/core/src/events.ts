import type { Pool } from 'pg';
import { primeSecretScrubber, scrubDeep } from './secrets/scrub.js';

export type EventRow = {
  id: string;
  kind: string;
  conversationId: string | null;
  payload: unknown;
  createdAt: Date;
};

/**
 * Append-only event log (core.events).
 *
 * Choke point 2 of the scrub (owner-secrets §5): the payload is scrubbed
 * *before* it is written, so Activity, the canvas, the transcript and the
 * Telegram relay — which all read events — see only the `‹secret:NAME›` form.
 * The prime happens here rather than at boot only so a secret saved a moment
 * ago is in the automaton that reads the next event; when nothing is stale it
 * is one boolean check.
 */
export async function appendEvent(
  pool: Pool,
  kind: string,
  payload: unknown,
  conversationId?: string,
): Promise<EventRow> {
  await primeSecretScrubber();
  const { rows } = await pool.query(
    `insert into core.events (kind, conversation_id, payload)
     values ($1, $2, $3::jsonb)
     returning id, kind, conversation_id, payload, created_at`,
    [kind, conversationId ?? null, JSON.stringify(scrubDeep(payload ?? null))],
  );
  const row = rows[0];
  return {
    id: String(row.id),
    kind: row.kind,
    conversationId: row.conversation_id,
    payload: row.payload,
    createdAt: row.created_at,
  };
}
