import type { Pool } from 'pg';
import { parseCron } from './cron.js';
import { coalesceOptions, type CoalesceOptions } from './enqueue.js';
import {
  MISFIRE_POLICIES,
  toMission,
  toScheduleSpec,
  type Mission,
  type MissionRow,
  type MisfirePolicy,
  type ScheduleSpec,
  type ScheduleSpecRow,
} from './types.js';

export type UpsertMissionInput = {
  id: string;
  name: string;
  agentId: string;
  prompt: string;
  enabled?: boolean;
  /** Deliver unconditionally (the weekly recap). Default false. */
  alwaysDeliver?: boolean;
  /** Coalesce its event-driven occurrences per agent (`enqueueOccurrence`). Default none. */
  coalesce?: CoalesceOptions | null;
};

export type SetScheduleInput = {
  cron: string;
  timezone: string;
  misfirePolicy: MisfirePolicy;
  deadlineMinutes?: number | null;
};

const MISSION_COLUMNS =
  'id, name, agent_id, prompt, enabled, always_deliver, paused_reason, coalesce_window_seconds, coalesce_max_wait_seconds, created_at';
const SPEC_COLUMNS =
  'id, mission_id, revision, cron, timezone, misfire_policy, deadline_minutes, active, created_at';

/** Create or update a mission definition. Schedules are set separately. */
export async function upsertMission(pool: Pool, input: UpsertMissionInput): Promise<Mission> {
  if (!input.id.trim()) throw new Error('upsertMission: id is required');
  const coalesce = input.coalesce == null ? null : coalesceOptions(input.coalesce);
  if (input.coalesce != null && coalesce === null) {
    throw new Error('upsertMission: coalesce needs whole seconds, a window of 1–3600 and a max wait no shorter than it (at most 86400)');
  }
  const { rows } = await pool.query<MissionRow>(
    `insert into core.missions (id, name, agent_id, prompt, enabled, always_deliver, coalesce_window_seconds, coalesce_max_wait_seconds)
     values ($1, $2, $3, $4, coalesce($5, true), coalesce($6, false), $7, $8)
     on conflict (id) do update
       set name = excluded.name,
           agent_id = excluded.agent_id,
           prompt = excluded.prompt,
           enabled = excluded.enabled,
           always_deliver = excluded.always_deliver,
           coalesce_window_seconds = excluded.coalesce_window_seconds,
           coalesce_max_wait_seconds = excluded.coalesce_max_wait_seconds
     returning ${MISSION_COLUMNS}`,
    [
      input.id,
      input.name,
      input.agentId,
      input.prompt,
      input.enabled ?? null,
      input.alwaysDeliver ?? null,
      coalesce?.windowSeconds ?? null,
      coalesce?.maxWaitSeconds ?? null,
    ],
  );
  return toMission(rows[0] as MissionRow);
}

/**
 * Point a mission at a new schedule.
 *
 * Schedules are append-only revisions: the previous active spec is deactivated
 * and a new revision is inserted in the same transaction, so occurrences
 * already materialized under the old revision keep their provenance and their
 * idempotency key stays valid.
 */
export async function setSchedule(
  pool: Pool,
  missionId: string,
  input: SetScheduleInput,
): Promise<ScheduleSpec> {
  parseCron(input.cron); // fail loudly here, not at materialization time
  if (!MISFIRE_POLICIES.includes(input.misfirePolicy)) {
    throw new Error(`setSchedule: unknown misfire policy "${input.misfirePolicy}"`);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input.timezone });
  } catch {
    throw new Error(`setSchedule: unknown timezone "${input.timezone}"`);
  }
  if (input.misfirePolicy === 'skip-after-deadline' && !(Number(input.deadlineMinutes) > 0)) {
    throw new Error('setSchedule: skip-after-deadline requires a positive deadlineMinutes');
  }

  const client = await pool.connect();
  try {
    await client.query('begin');
    const mission = await client.query(
      `select id from core.missions where id = $1 for update`,
      [missionId],
    );
    if (mission.rowCount === 0) throw new Error(`setSchedule: no such mission "${missionId}"`);

    await client.query(
      `update core.schedule_specs set active = false where mission_id = $1 and active`,
      [missionId],
    );
    const { rows } = await client.query<ScheduleSpecRow>(
      `insert into core.schedule_specs
         (mission_id, revision, cron, timezone, misfire_policy, deadline_minutes, active)
       values (
         $1,
         coalesce((select max(revision) from core.schedule_specs where mission_id = $1), 0) + 1,
         $2, $3, $4, $5, true
       )
       returning ${SPEC_COLUMNS}`,
      [
        missionId,
        input.cron.trim(),
        input.timezone,
        input.misfirePolicy,
        input.deadlineMinutes ?? null,
      ],
    );
    await client.query('commit');
    return toScheduleSpec(rows[0] as ScheduleSpecRow);
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** All missions, oldest first. */
export async function listMissions(pool: Pool): Promise<Mission[]> {
  const { rows } = await pool.query<MissionRow>(
    `select ${MISSION_COLUMNS} from core.missions order by created_at, id`,
  );
  return rows.map(toMission);
}

/** One mission by id, or null. */
export async function getMission(pool: Pool, missionId: string): Promise<Mission | null> {
  const { rows } = await pool.query<MissionRow>(
    `select ${MISSION_COLUMNS} from core.missions where id = $1`,
    [missionId],
  );
  return rows.length > 0 ? toMission(rows[0] as MissionRow) : null;
}

/** The active schedule spec for a mission, or null. */
export async function getActiveSchedule(
  pool: Pool,
  missionId: string,
): Promise<ScheduleSpec | null> {
  const { rows } = await pool.query<ScheduleSpecRow>(
    `select ${SPEC_COLUMNS} from core.schedule_specs
     where mission_id = $1 and active
     order by revision desc limit 1`,
    [missionId],
  );
  return rows.length > 0 ? toScheduleSpec(rows[0] as ScheduleSpecRow) : null;
}

/** Enable or disable a mission without touching its schedule history. */
export async function setMissionEnabled(
  pool: Pool,
  missionId: string,
  enabled: boolean,
): Promise<Mission | null> {
  const { rows } = await pool.query<MissionRow>(
    `update core.missions set enabled = $2 where id = $1 returning ${MISSION_COLUMNS}`,
    [missionId, enabled],
  );
  return rows.length > 0 ? toMission(rows[0] as MissionRow) : null;
}

/** The reason a disabled plugin's missions carry: "paused: finance is disabled". */
export function pluginPausedReason(plugin: string): string {
  return `paused: ${plugin} is disabled`;
}

/**
 * Pause the given missions because `plugin` is disabled. Only missions not
 * already paused for another reason are touched; the owner's `enabled` switch
 * is left alone. Returns the ids that were paused.
 */
export async function pausePluginMissions(
  pool: Pool,
  plugin: string,
  missionIds: readonly string[],
): Promise<string[]> {
  if (missionIds.length === 0) return [];
  const { rows } = await pool.query<{ id: string }>(
    `update core.missions set paused_reason = $2
      where id = any($1::text[]) and (paused_reason is null or paused_reason = $2)
      returning id`,
    [missionIds, pluginPausedReason(plugin)],
  );
  const paused = rows.map((r) => r.id).sort();
  // A run already due would otherwise still fire, and its agent has lost the tools.
  if (paused.length > 0) {
    await pool.query(
      `update core.occurrences set state = 'skipped', finished_at = now(), error = $2
        where mission_id = any($1::text[]) and state = 'pending'`,
      [paused, pluginPausedReason(plugin)],
    );
  }
  return paused;
}

/** Resume every mission `pausePluginMissions` paused for `plugin`. Returns their ids. */
export async function resumePluginMissions(pool: Pool, plugin: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `update core.missions set paused_reason = null where paused_reason = $1 returning id`,
    [pluginPausedReason(plugin)],
  );
  return rows.map((r) => r.id).sort();
}
