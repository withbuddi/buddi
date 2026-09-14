/** Shared row shapes for the scheduler tables (core migration 002). */

export const MISFIRE_POLICIES = [
  'replay-all',
  'coalesce',
  'latest-only',
  'skip-after-deadline',
] as const;

export type MisfirePolicy = (typeof MISFIRE_POLICIES)[number];

export const OCCURRENCE_STATES = [
  'pending',
  'claimed',
  'succeeded',
  'failed',
  'skipped',
] as const;

export type OccurrenceState = (typeof OCCURRENCE_STATES)[number];

export type Mission = {
  id: string;
  name: string;
  agentId: string;
  prompt: string;
  enabled: boolean;
  /**
   * Deliver this mission's answer whether or not the agent asked for it.
   *
   * The default is false: a scheduled run speaks only when it calls
   * `mission.report`, so a watcher that found nothing stays quiet. The weekly
   * recap is the deliberate exception — the owner asked for it every Friday.
   */
  alwaysDeliver: boolean;
  createdAt: Date;
};

export type ScheduleSpec = {
  id: string;
  missionId: string;
  revision: number;
  cron: string;
  timezone: string;
  misfirePolicy: MisfirePolicy;
  deadlineMinutes: number | null;
  active: boolean;
  createdAt: Date;
};

export type Occurrence = {
  id: string;
  missionId: string;
  scheduleRevision: number;
  scheduledAt: Date;
  state: OccurrenceState;
  claimedAt: Date | null;
  finishedAt: Date | null;
  runConversationId: string | null;
  error: string | null;
  /**
   * What this run carries beyond its instant — the sentinel finding that
   * enqueued it. Null for a cron occurrence.
   */
  payload: unknown;
};

export type MissionRow = {
  id: string;
  name: string;
  agent_id: string;
  prompt: string;
  enabled: boolean;
  always_deliver: boolean;
  created_at: Date;
};

export type ScheduleSpecRow = {
  id: string;
  mission_id: string;
  revision: number;
  cron: string;
  timezone: string;
  misfire_policy: MisfirePolicy;
  deadline_minutes: number | null;
  active: boolean;
  created_at: Date;
};

export type OccurrenceRow = {
  id: string;
  mission_id: string;
  schedule_revision: number;
  scheduled_at: Date;
  state: OccurrenceState;
  claimed_at: Date | null;
  finished_at: Date | null;
  run_conversation_id: string | null;
  error: string | null;
  payload: unknown;
};

export function toMission(row: MissionRow): Mission {
  return {
    id: row.id,
    name: row.name,
    agentId: row.agent_id,
    prompt: row.prompt,
    enabled: row.enabled,
    alwaysDeliver: row.always_deliver ?? false,
    createdAt: row.created_at,
  };
}

export function toScheduleSpec(row: ScheduleSpecRow): ScheduleSpec {
  return {
    id: row.id,
    missionId: row.mission_id,
    revision: row.revision,
    cron: row.cron,
    timezone: row.timezone,
    misfirePolicy: row.misfire_policy,
    deadlineMinutes: row.deadline_minutes,
    active: row.active,
    createdAt: row.created_at,
  };
}

export function toOccurrence(row: OccurrenceRow): Occurrence {
  return {
    id: row.id,
    missionId: row.mission_id,
    scheduleRevision: row.schedule_revision,
    scheduledAt: row.scheduled_at,
    state: row.state,
    claimedAt: row.claimed_at,
    finishedAt: row.finished_at,
    runConversationId: row.run_conversation_id,
    error: row.error,
    payload: row.payload ?? null,
  };
}

export const OCCURRENCE_COLUMNS =
  'id, mission_id, schedule_revision, scheduled_at, state, claimed_at, finished_at, run_conversation_id, error, payload';
