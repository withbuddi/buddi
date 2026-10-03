import type { Pool, PoolClient } from 'pg';
import type { Queryable } from '../owner.js';
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
  /**
   * Whether `timezone` was named on purpose (a tool's or CLI's zone, the
   * owner's choice, a mission that declares one). False when it is just the
   * owner's zone of the moment: the schedule then follows the owner's zone
   * (`rezoneSchedules`). Default true.
   */
  timezoneExplicit?: boolean;
  misfirePolicy: MisfirePolicy;
  deadlineMinutes?: number | null;
};

const MISSION_COLUMNS =
  'id, name, agent_id, prompt, enabled, always_deliver, paused_reason, stop_when, ends_at, ended_at, quiet_runs, still_useful_asked_at, coalesce_window_seconds, coalesce_max_wait_seconds, created_at';
const SPEC_COLUMNS =
  'id, mission_id, revision, cron, timezone, timezone_explicit, misfire_policy, deadline_minutes, active, created_at';

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
  checkSchedule(input);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const spec = await insertScheduleRevision(client, missionId, input);
    await client.query('commit');
    return spec;
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function checkSchedule(input: SetScheduleInput): void {
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
}

/** The new revision, inside a transaction the caller holds. */
async function insertScheduleRevision(client: PoolClient, missionId: string, input: SetScheduleInput): Promise<ScheduleSpec> {
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
       (mission_id, revision, cron, timezone, timezone_explicit, misfire_policy, deadline_minutes, active)
     values (
       $1,
       coalesce((select max(revision) from core.schedule_specs where mission_id = $1), 0) + 1,
       $2, $3, $6, $4, $5, true
     )
     returning ${SPEC_COLUMNS}`,
    [
      missionId,
      input.cron.trim(),
      input.timezone,
      input.misfirePolicy,
      input.deadlineMinutes ?? null,
      input.timezoneExplicit ?? true,
    ],
  );
  return toScheduleSpec(rows[0] as ScheduleSpecRow);
}

/**
 * A mission, its schedule and its lifespan in one transaction: all of them,
 * or none. For a mission that must never run without its end (an agent's own
 * watch, `schedule.propose`).
 */
export async function upsertScheduledMission(
  pool: Pool,
  input: {
    mission: UpsertMissionInput;
    schedule: SetScheduleInput;
    lifespan?: { stopWhen: string | null; endsAt: Date | null };
  },
): Promise<{ mission: Mission; spec: ScheduleSpec }> {
  checkSchedule(input.schedule);
  const client = await pool.connect();
  try {
    await client.query('begin');
    const asPool = client as unknown as Pool;
    let mission = await upsertMission(asPool, input.mission);
    const spec = await insertScheduleRevision(client, mission.id, input.schedule);
    if (input.lifespan) mission = (await setMissionLifespan(asPool, mission.id, input.lifespan)) ?? mission;
    await client.query('commit');
    return { mission, spec };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Move every active schedule that follows the owner's zone (not named on
 * purpose, `timezoneExplicit` false) and is not in `to` already: a new
 * revision each, same cron, misfire policy and deadline, so its next run is
 * computed in `to`. Used when the owner's zone changes and at start, so a
 * mission set for "8 AM" stays 8 AM where the owner now is. A schedule whose
 * zone was named on purpose is left alone. Returns the mission ids moved.
 */
export async function rezoneSchedules(pool: Pool, to: string): Promise<string[]> {
  const { rows } = await pool.query<ScheduleSpecRow>(
    `select ${SPEC_COLUMNS} from core.schedule_specs
      where active and timezone_explicit = false and timezone <> $1
      order by mission_id`,
    [to],
  );
  const moved: string[] = [];
  for (const row of rows) {
    const spec = toScheduleSpec(row);
    await setSchedule(pool, spec.missionId, {
      cron: spec.cron,
      timezone: to,
      timezoneExplicit: false,
      misfirePolicy: spec.misfirePolicy,
      deadlineMinutes: spec.deadlineMinutes,
    });
    moved.push(spec.missionId);
  }
  return moved;
}

/**
 * A schedule buddi itself made without naming a zone, so one from before
 * `timezone_explicit` existed can be proven to follow the owner: a default
 * mission a plugin suggests without a timezone, the learning digest, a
 * starter's or a plugin agent's declared mission. `cron` null matches any
 * cron (the digest's day and hour are the owner's to change and still follow).
 */
export interface OwnerFollowingDeclaration {
  missionId: string;
  cron: string | null;
}

/**
 * Settle the schedules made before `timezone_explicit` existed (null) by
 * provenance, not by zone alone: one follows the owner from now on only when
 * buddi made it without a zone — its mission is in `declared` (and its cron
 * matches, when the declaration names one) — and it still sits in one of
 * `following` (the default zone of the time, or the owner's zone now). Any
 * other — made by schedule.propose, by the owner on the dashboard, by an agent
 * naming a zone, or simply unknown — was possibly named on purpose and keeps
 * its zone. Returns how many active ones were settled each way.
 */
export async function settleUnflaggedSchedules(
  pool: Pool,
  following: readonly string[],
  declared: readonly OwnerFollowingDeclaration[] = [],
): Promise<{ following: number; explicit: number }> {
  const { rows } = await pool.query<{ explicit: boolean; n: string }>(
    `with declared as (
       select d.mission_id, d.cron
         from unnest($2::text[], $3::text[]) as d(mission_id, cron)
     ), settled as (
       update core.schedule_specs s
          set timezone_explicit = not (
                s.timezone = any($1::text[])
                and exists (
                  select 1 from declared d
                   where d.mission_id = s.mission_id and (d.cron is null or d.cron = s.cron)
                )
              )
        where s.timezone_explicit is null
       returning s.active, s.timezone_explicit
     )
     select timezone_explicit as explicit, count(*)::text as n from settled where active group by timezone_explicit`,
    [[...following], declared.map((d) => d.missionId), declared.map((d) => d.cron)],
  );
  const count = (explicit: boolean): number => Number(rows.find((r) => r.explicit === explicit)?.n ?? 0);
  return { following: count(false), explicit: count(true) };
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
    // Switching an ended watch back on is the owner saying it is not over:
    // its end goes with the switch, or the next tick would end it again.
    `update core.missions
        set enabled = $2,
            ends_at = case when $2 and ended_at is not null then null else ends_at end,
            ended_at = case when $2 then null else ended_at end
      where id = $1 returning ${MISSION_COLUMNS}`,
    [missionId, enabled],
  );
  return rows.length > 0 ? toMission(rows[0] as MissionRow) : null;
}

/* ------------------------------------------------------------------ *
 * Missions that stop themselves (docs/missions.md, "When a mission stops")
 * ------------------------------------------------------------------ */

/** How long an agent-proposed watch runs when it names no end of its own. */
export const AGENT_MISSION_DEFAULT_DAYS = 30;

/** Silent runs in a row after which the owner is asked "Still useful?". */
export const STILL_USEFUL_AFTER_QUIET_RUNS = 48;

/**
 * When a watch is done and when it ends. A mission given a new lifespan is a
 * live one again: a previous end and its quiet count go.
 */
export async function setMissionLifespan(
  pool: Pool,
  missionId: string,
  input: { stopWhen: string | null; endsAt: Date | null },
): Promise<Mission | null> {
  const { rows } = await pool.query<MissionRow>(
    `update core.missions set stop_when = $2, ends_at = $3, ended_at = null, quiet_runs = 0, still_useful_asked_at = null
      where id = $1 returning ${MISSION_COLUMNS}`,
    [missionId, input.stopWhen, input.endsAt],
  );
  return rows.length > 0 ? toMission(rows[0] as MissionRow) : null;
}

/**
 * Switch off every enabled mission whose end has come, quietly: no message,
 * just `enabled = false` and `ended_at`, so it stays listed as ended. Returns
 * the ids it ended.
 */
export async function endExpiredMissions(pool: Pool, now: Date): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `update core.missions set enabled = false, ended_at = $1
      where enabled and ends_at is not null and ends_at <= $1
      returning id`,
    [now],
  );
  return rows.map((r) => r.id);
}

/**
 * One run's outcome on the quiet counter: a report resets it, a silent run adds
 * one. Answers the count after, and whether this run is the one that should
 * ask the owner "Still useful?" (the threshold reached, not asked yet). The
 * ask is claimed in the same statement, so two runs cannot both ask.
 */
export async function noteMissionRun(
  pool: Pool,
  missionId: string,
  spoke: boolean,
  now: Date,
  threshold: number = STILL_USEFUL_AFTER_QUIET_RUNS,
): Promise<{ quietRuns: number; ask: boolean }> {
  if (spoke) {
    await pool.query(`update core.missions set quiet_runs = 0 where id = $1`, [missionId]);
    return { quietRuns: 0, ask: false };
  }
  const { rows } = await pool.query<{ quiet_runs: number; ask: boolean }>(
    `with before as (select still_useful_asked_at from core.missions where id = $1 for update)
     update core.missions m
        set quiet_runs = m.quiet_runs + 1,
            still_useful_asked_at = case
              when m.still_useful_asked_at is null and m.quiet_runs + 1 >= $3 then $2
              else m.still_useful_asked_at end
       from before
      where m.id = $1
      returning m.quiet_runs, (before.still_useful_asked_at is null and m.quiet_runs >= $3) as ask`,
    [missionId, now, threshold],
  );
  const row = rows[0];
  return row ? { quietRuns: row.quiet_runs, ask: row.ask } : { quietRuns: 0, ask: false };
}

/** The owner's Keep on "Still useful?": the counter starts again, and so may the question. */
export async function keepMission(pool: Pool, missionId: string): Promise<Mission | null> {
  const { rows } = await pool.query<MissionRow>(
    `update core.missions set quiet_runs = 0, still_useful_asked_at = null
      where id = $1 returning ${MISSION_COLUMNS}`,
    [missionId],
  );
  return rows.length > 0 ? toMission(rows[0] as MissionRow) : null;
}

/** The notification key "Still useful?" carries: one open question per mission. */
export function stillUsefulKey(missionId: string): string {
  return `still-useful:${missionId}`;
}

/** The mission a "Still useful?" notification key is about, or undefined. */
export function missionIdOfStillUsefulKey(key: string | null | undefined): string | undefined {
  const raw = (key ?? '').trim();
  if (!raw.startsWith('still-useful:')) return undefined;
  const id = raw.slice('still-useful:'.length);
  return id === '' ? undefined : id;
}

export type StillUsefulOutcome = 'kept' | 'stopped' | 'already-kept' | 'already-stopped' | 'gone';

/** Which "Still useful?" an answer is for: one prompt (a button under it) or the mission's open one. */
export type StillUsefulTarget = { notificationId: string } | { missionId: string };

/**
 * The owner's answer to "Still useful?", from any surface. Keep starts the
 * quiet count again; Stop switches the mission off. Either way the question
 * is closed and the answer is written on its notification rows.
 *
 * One transaction claims the question: the mission row is locked first, then
 * the prompt's row, and the decision applies only while that very prompt is
 * still the open one — not answered (here or on the dashboard), and not an
 * older prompt of a mission that was asked again since. Anything else changes
 * nothing and says what already happened, so a second tap, an opposite tap
 * (Keep then Stop), a replayed old button and a race with the dashboard each
 * apply at most once.
 */
export async function answerStillUseful(
  pool: Pool,
  target: StillUsefulTarget,
  choice: 'keep' | 'stop',
  now: Date = new Date(),
): Promise<{ outcome: StillUsefulOutcome; missionId?: string }> {
  let missionId: string | undefined;
  let key: string;
  if ('notificationId' in target) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target.notificationId)) return { outcome: 'gone' };
    const { rows } = await pool.query<{ dedupe_key: string | null }>(
      `select dedupe_key from core.owner_notifications where id = $1`,
      [target.notificationId],
    );
    missionId = missionIdOfStillUsefulKey(rows[0]?.dedupe_key);
    if (!missionId) return { outcome: 'gone' };
  } else {
    missionId = target.missionId;
  }
  key = stillUsefulKey(missionId);

  const client = await pool.connect();
  try {
    await client.query('begin');
    const mission = await client.query<{ enabled: boolean; still_useful_asked_at: Date | null }>(
      `select enabled, still_useful_asked_at from core.missions where id = $1 for update`,
      [missionId],
    );
    const m = mission.rows[0];
    if (!m) {
      await client.query('commit');
      return { outcome: 'gone', missionId };
    }
    const settled = (): StillUsefulOutcome => (m.enabled ? 'already-kept' : 'already-stopped');

    let open = m.enabled && m.still_useful_asked_at !== null;
    if ('notificationId' in target) {
      const note = await client.query<{ answer: string | null; created_at: Date }>(
        `select answer, created_at from core.owner_notifications where id = $1 for update`,
        [target.notificationId],
      );
      const n = note.rows[0];
      if (!n) {
        await client.query('commit');
        return { outcome: 'gone', missionId };
      }
      if (n.answer === 'keep' || n.answer === 'stop') {
        await client.query('commit');
        return { outcome: n.answer === 'keep' ? 'already-kept' : 'already-stopped', missionId };
      }
      // An older prompt than the open question answers nothing.
      open = open && m.still_useful_asked_at !== null && n.created_at.getTime() >= m.still_useful_asked_at.getTime();
    }
    if (!open) {
      if ('notificationId' in target) {
        await client.query(
          `update core.owner_notifications
              set acted_at = coalesce(acted_at, $2), seen_at = coalesce(seen_at, $2), updated_at = $2
            where id = $1`,
          [target.notificationId, now],
        );
      }
      await client.query('commit');
      return { outcome: settled(), missionId };
    }

    await client.query(
      `update core.missions
          set enabled = case when $2 = 'stop' then false else enabled end,
              quiet_runs = 0, still_useful_asked_at = null
        where id = $1`,
      [missionId, choice],
    );
    await client.query(
      `update core.owner_notifications
          set acted_at = coalesce(acted_at, $3), seen_at = coalesce(seen_at, $3), updated_at = $3,
              answer = $2
        where dedupe_key = $1 and answer is null and (acted_at is null or id = $4::uuid)`,
      [key, choice, now, 'notificationId' in target ? target.notificationId : null],
    );
    await client.query('commit');
    return { outcome: choice === 'keep' ? 'kept' : 'stopped', missionId };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
