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
  /**
   * Why it is paused when that is not the owner's `enabled` switch —
   * "paused: finance is disabled". Null when not paused. A paused mission
   * materializes nothing, like a disabled one.
   */
  pausedReason: string | null;
  /** The agent's own words for when this watch is done; null when it named none. */
  stopWhen?: string | null;
  /** When it switches itself off, quietly; null runs until someone stops it. */
  endsAt?: Date | null;
  /** When it did switch itself off at `endsAt`. */
  endedAt?: Date | null;
  /** Runs in a row that told the owner nothing. */
  quietRuns?: number;
  /** When the owner was asked "Still useful?"; null when not (or since Keep). */
  stillUsefulAskedAt?: Date | null;
  /**
   * Gather this mission's event-driven occurrences for the same agent into one
   * run (`enqueueOccurrence`). Null or absent: one run per occurrence.
   */
  coalesce?: { windowSeconds: number; maxWaitSeconds: number } | null;
  /**
   * A plugin export core calls before each run (host API 1.27), its JSON
   * answer opening the run's first message. Null: the run reads nothing first.
   */
  context?: { plugin: string; export: string; args?: Record<string, unknown> } | null;
  /** The longest report its `mission.report` takes; null is `REPORT_MAX_DEFAULT`. */
  reportMax?: number | null;
  /**
   * `own`: the package opted this mission in to browsing unattended, in
   * buddi's own browser only (docs/browser.md, "Missions"). `owner`: the
   * owner also let it use their signed-in Chrome (an approval, never a
   * package alone). Null: it opens no page.
   */
  browser?: MissionBrowser | null;
  createdAt: Date;
};

/** Where a mission may browse unattended: buddi's own browser, or the owner's signed-in Chrome as well. */
export type MissionBrowser = 'own' | 'owner';

/** A stored or declared browser scope, read strictly: anything else is none. */
export function missionBrowserOf(value: unknown): MissionBrowser | null {
  return value === 'own' || value === 'owner' ? value : null;
}

export type ScheduleSpec = {
  id: string;
  missionId: string;
  revision: number;
  cron: string;
  timezone: string;
  /**
   * The zone was named on purpose and stays when the owner's zone changes.
   * False: it follows the owner's zone (Settings → Profile). A schedule from
   * before the flag reads true until the start that settles it.
   */
  timezoneExplicit: boolean;
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
  paused_reason: string | null;
  stop_when?: string | null;
  ends_at?: Date | null;
  ended_at?: Date | null;
  quiet_runs?: number | null;
  still_useful_asked_at?: Date | null;
  coalesce_window_seconds?: number | null;
  coalesce_max_wait_seconds?: number | null;
  context?: unknown;
  report_max?: number | null;
  browser?: string | null;
  created_at: Date;
};

export type ScheduleSpecRow = {
  id: string;
  mission_id: string;
  revision: number;
  cron: string;
  timezone: string;
  timezone_explicit?: boolean | null;
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
    pausedReason: row.paused_reason ?? null,
    stopWhen: row.stop_when ?? null,
    endsAt: row.ends_at ?? null,
    endedAt: row.ended_at ?? null,
    quietRuns: row.quiet_runs ?? 0,
    stillUsefulAskedAt: row.still_useful_asked_at ?? null,
    coalesce: row.coalesce_window_seconds && row.coalesce_max_wait_seconds
      ? { windowSeconds: row.coalesce_window_seconds, maxWaitSeconds: row.coalesce_max_wait_seconds }
      : null,
    context: contextOf(row.context),
    reportMax: typeof row.report_max === 'number' ? row.report_max : null,
    browser: missionBrowserOf(row.browser),
    createdAt: row.created_at,
  };
}

function contextOf(value: unknown): Mission['context'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  if (typeof c.plugin !== 'string' || typeof c.export !== 'string') return null;
  return {
    plugin: c.plugin,
    export: c.export,
    ...(c.args && typeof c.args === 'object' && !Array.isArray(c.args) ? { args: c.args as Record<string, unknown> } : {}),
  };
}

export function toScheduleSpec(row: ScheduleSpecRow): ScheduleSpec {
  return {
    id: row.id,
    missionId: row.mission_id,
    revision: row.revision,
    cron: row.cron,
    timezone: row.timezone,
    timezoneExplicit: row.timezone_explicit !== false,
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
