import type { Pool } from 'pg';

export type EventRow = {
  id: string;
  kind: string;
  conversationId: string | null;
  payload: unknown;
  createdAt: Date;
};

/** Append-only event log (core.events). */
export async function appendEvent(
  pool: Pool,
  kind: string,
  payload: unknown,
  conversationId?: string,
): Promise<EventRow> {
  const { rows } = await pool.query(
    `insert into core.events (kind, conversation_id, payload)
     values ($1, $2, $3::jsonb)
     returning id, kind, conversation_id, payload, created_at`,
    [kind, conversationId ?? null, JSON.stringify(payload ?? null)],
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
