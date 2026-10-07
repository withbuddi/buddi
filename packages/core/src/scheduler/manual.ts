/**
 * Run now: one occurrence of a mission, started by the owner instead of the clock.
 *
 * It is an occurrence like any other — the same row, the same job, the same
 * report or silence — so it shows in the mission's recent list and counts
 * where a scheduled run counts (the quiet-run counter behind "Still useful?"
 * included: the owner asked, and a run that found nothing still found
 * nothing). Only the payload says how it started: `{ manual: true }`.
 *
 * The row is written already `claimed`, because the caller hands it to the
 * queue at once; a process that dies in between leaves a claim the stale
 * sweep releases, and the scheduler then queues it the normal way.
 */
import type { Pool } from 'pg';
import { appendEvent } from '../events.js';
import { toMission, OCCURRENCE_COLUMNS, toOccurrence, type Mission, type MissionRow, type Occurrence, type OccurrenceRow } from './types.js';

/** The payload a Run now occurrence carries. */
export const MANUAL_OCCURRENCE_PAYLOAD = { manual: true } as const;

/** Whether an occurrence was started by Run now rather than a schedule or a watcher. */
export function isManualOccurrence(payload: unknown): boolean {
  return payload !== null && typeof payload === 'object' && (payload as { manual?: unknown }).manual === true;
}

export type ManualOccurrenceResult =
  | { ok: true; mission: Mission; occurrence: Occurrence }
  | { ok: false; reason: 'unknown' }
  | { ok: false; reason: 'disabled'; mission: Mission }
  | { ok: false; reason: 'paused'; mission: Mission }
  | { ok: false; reason: 'busy'; mission: Mission; occurrence: Occurrence };

/**
 * Start one occurrence of `missionId` now, or say why not: unknown, switched
 * off (or ended), paused by a disabled plugin, or one already queued or
 * running. The check and the insert hold the mission's row lock — the same
 * one materialization takes — so two clicks cannot both start a run.
 */
export async function startManualOccurrence(pool: Pool, missionId: string, now: Date): Promise<ManualOccurrenceResult> {
  const client = await pool.connect();
  let result: ManualOccurrenceResult;
  try {
    await client.query('begin');
    const found = await client.query<MissionRow>(`select * from core.missions where id = $1 for update`, [missionId]);
    const row = found.rows[0];
    if (!row) {
      await client.query('rollback');
      return { ok: false, reason: 'unknown' };
    }
    const mission = toMission(row);
    if (!mission.enabled) {
      await client.query('rollback');
      return { ok: false, reason: 'disabled', mission };
    }
    if (mission.pausedReason !== null) {
      await client.query('rollback');
      return { ok: false, reason: 'paused', mission };
    }
    const busy = await client.query<OccurrenceRow>(
      `select ${OCCURRENCE_COLUMNS} from core.occurrences
        where mission_id = $1 and state in ('pending', 'claimed')
        order by scheduled_at desc limit 1`,
      [missionId],
    );
    if (busy.rows[0]) {
      await client.query('rollback');
      return { ok: false, reason: 'busy', mission, occurrence: toOccurrence(busy.rows[0]) };
    }
    // Revision 0 is the one occurrences outside a schedule use; the instant
    // steps a millisecond when another occurrence already holds it.
    let inserted: OccurrenceRow | undefined;
    for (let offset = 0; offset < 60 && !inserted; offset++) {
      const at = new Date(now.getTime() + offset);
      const { rows } = await client.query<OccurrenceRow>(
        `insert into core.occurrences (mission_id, schedule_revision, scheduled_at, state, claimed_at, payload)
         values ($1, 0, $2, 'claimed', $3, $4::jsonb)
         on conflict (mission_id, schedule_revision, scheduled_at) do nothing
         returning ${OCCURRENCE_COLUMNS}`,
        [missionId, at.toISOString(), now.toISOString(), JSON.stringify(MANUAL_OCCURRENCE_PAYLOAD)],
      );
      inserted = rows[0];
    }
    if (!inserted) throw new Error(`could not allocate an occurrence instant for mission "${missionId}"`);
    await client.query('commit');
    result = { ok: true, mission, occurrence: toOccurrence(inserted) };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await appendEvent(pool, 'occurrence.claimed', {
    occurrenceId: result.occurrence.id,
    missionId,
    scheduledAt: result.occurrence.scheduledAt.toISOString(),
    manual: true,
  });
  return result;
}
