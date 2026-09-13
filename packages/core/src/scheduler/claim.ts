import type { Pool } from 'pg';
import { OCCURRENCE_COLUMNS, toOccurrence, type Occurrence } from './types.js';

export type FinishInput = {
  state: 'succeeded' | 'failed';
  runConversationId?: string | null;
  error?: string | null;
};

/**
 * Atomically take the oldest due occurrence.
 *
 * The `for update skip locked` sub-select is the whole point: two schedulers (or
 * two workers in one process) never hand the same occurrence to two runs, and a
 * locked row is stepped over rather than waited on.
 */
export async function claimNextOccurrence(pool: Pool, now: Date): Promise<Occurrence | null> {
  const { rows } = await pool.query(
    `update core.occurrences
     set state = 'claimed', claimed_at = $1
     where id = (
       select id from core.occurrences
       where state = 'pending' and scheduled_at <= $1
       order by scheduled_at, id
       for update skip locked
       limit 1
     )
     returning ${OCCURRENCE_COLUMNS}`,
    [now.toISOString()],
  );
  return rows.length > 0 ? toOccurrence(rows[0]) : null;
}

/** Close out a claimed occurrence. Only a claimed row transitions. */
export async function finishOccurrence(
  pool: Pool,
  id: string,
  input: FinishInput,
): Promise<Occurrence | null> {
  if (input.state !== 'succeeded' && input.state !== 'failed') {
    throw new Error(`finishOccurrence: invalid terminal state "${input.state}"`);
  }
  const { rows } = await pool.query(
    `update core.occurrences
     set state = $2,
         finished_at = now(),
         run_conversation_id = coalesce($3::uuid, run_conversation_id),
         error = $4
     where id = $1::uuid and state = 'claimed'
     returning ${OCCURRENCE_COLUMNS}`,
    [id, input.state, input.runConversationId ?? null, input.error ?? null],
  );
  return rows.length > 0 ? toOccurrence(rows[0]) : null;
}

/** Release a claimed occurrence back to `pending` (startup recovery). */
export async function releaseStaleClaims(pool: Pool, olderThan: Date): Promise<number> {
  const { rowCount } = await pool.query(
    `update core.occurrences
     set state = 'pending', claimed_at = null
     where state = 'claimed' and claimed_at < $1`,
    [olderThan.toISOString()],
  );
  return rowCount ?? 0;
}

/** Read one occurrence by id. */
export async function getOccurrence(pool: Pool, id: string): Promise<Occurrence | null> {
  const { rows } = await pool.query(
    `select ${OCCURRENCE_COLUMNS} from core.occurrences where id = $1::uuid`,
    [id],
  );
  return rows.length > 0 ? toOccurrence(rows[0]) : null;
}

/** Occurrences for one mission, newest first. */
export async function listOccurrences(
  pool: Pool,
  missionId: string,
  limit = 100,
): Promise<Occurrence[]> {
  const { rows } = await pool.query(
    `select ${OCCURRENCE_COLUMNS} from core.occurrences
     where mission_id = $1
     order by scheduled_at desc
     limit $2`,
    [missionId, limit],
  );
  return rows.map(toOccurrence);
}
