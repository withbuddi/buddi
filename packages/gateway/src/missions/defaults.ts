/**
 * The missions a fresh install registers — `buddi missions add-defaults`.
 *
 * Registration is idempotent by construction: the mission is upserted, and its
 * schedule is only replaced when the cron, the zone or the misfire policy
 * actually differ, so running the command twice leaves one mission and one
 * active schedule revision.
 *
 * Note what each one is allowed to do to the owner's evening:
 *
 *  - `friday-recap`          always delivers (the owner asked for it weekly).
 *  - `daily-check`           delivers only if it calls mission.report.
 *  - `sentinel-wake`         no schedule at all; sentinels enqueue it.
 *  - `weekly-consolidation`  registered disabled — a placeholder the finance
 *                            work enables when its tools exist.
 */
import {
  getActiveSchedule,
  setSchedule,
  upsertMission,
  type MisfirePolicy,
  type UpsertMissionInput,
} from '@buddi/core';
import type { Pool } from 'pg';
import {
  FRIDAY_RECAP_CRON,
  FRIDAY_RECAP_MISSION,
  timezoneFromEnv,
} from './recap.js';
import { SENTINEL_WAKE_MISSION } from './sentinel-wake.js';

export const DAILY_CHECK_ID = 'daily-check';
export const DAILY_CHECK_CRON = '0 8 * * *';
export const DAILY_CHECK_PROMPT = `Run the daily check. Use the finance tools for every number; never do the arithmetic yourself.

1. Project the cashflow over the next 30 days and note the minimum balance and its date.
2. List everything due in the next 3 days — charges and income, with dates and amounts.
3. List receipts or imported transactions that are still unmatched, if the tools can tell you.

Then decide, and stay silent unless something is genuinely urgent. Urgent means one of:
- the projection breaches the safety floor within 7 days;
- a minimum payment or a charge falls due within 3 days with no payment recorded;
- an account balance is already below the floor.

If none of that is true, call mission.silent with the one-line reason. If something is urgent, call mission.report with urgency 'urgent', at most 600 characters, plain text, and exactly one recommended action.`;

export const DAILY_CHECK_MISSION: UpsertMissionInput = {
  id: DAILY_CHECK_ID,
  name: 'Daily check',
  agentId: 'finance-advisor',
  prompt: DAILY_CHECK_PROMPT,
  enabled: true,
  alwaysDeliver: false,
};

export const WEEKLY_CONSOLIDATION_ID = 'weekly-consolidation';
export const WEEKLY_CONSOLIDATION_CRON = '0 20 * * SUN';
export const WEEKLY_CONSOLIDATION_PROMPT = `Placeholder. Consolidate the week's derived memories and finance observations into durable notes, then stay silent (mission.silent) unless the consolidation itself found something the owner must act on.

This mission is registered disabled on purpose: enable it once the consolidation tools exist.`;

export const WEEKLY_CONSOLIDATION_MISSION: UpsertMissionInput = {
  id: WEEKLY_CONSOLIDATION_ID,
  name: 'Weekly consolidation',
  agentId: 'finance-advisor',
  prompt: WEEKLY_CONSOLIDATION_PROMPT,
  enabled: false,
  alwaysDeliver: false,
};

export type DefaultMission = {
  mission: UpsertMissionInput;
  /** No cron at all: the mission exists to be enqueued, never scheduled. */
  cron?: string;
  misfirePolicy?: MisfirePolicy;
};

/** Every mission `add-defaults` installs, in registration order. */
export const DEFAULT_MISSIONS: DefaultMission[] = [
  { mission: FRIDAY_RECAP_MISSION, cron: FRIDAY_RECAP_CRON, misfirePolicy: 'coalesce' },
  { mission: DAILY_CHECK_MISSION, cron: DAILY_CHECK_CRON, misfirePolicy: 'coalesce' },
  { mission: SENTINEL_WAKE_MISSION },
  {
    mission: WEEKLY_CONSOLIDATION_MISSION,
    cron: WEEKLY_CONSOLIDATION_CRON,
    misfirePolicy: 'coalesce',
  },
];

export type RegistrationOutcome = {
  missionId: string;
  /** 'registered' when a new schedule revision was written, else 'up-to-date'. */
  schedule: 'registered' | 'up-to-date' | 'none';
  cron?: string;
  timezone?: string;
  revision?: number;
};

/** Upsert one mission and point it at its schedule, if it has one. */
export async function registerDefault(
  pool: Pool,
  entry: DefaultMission,
  timezone: string,
): Promise<RegistrationOutcome> {
  const mission = await upsertMission(pool, entry.mission);
  if (!entry.cron) return { missionId: mission.id, schedule: 'none' };

  const misfirePolicy = entry.misfirePolicy ?? 'coalesce';
  const existing = await getActiveSchedule(pool, mission.id);
  if (
    existing &&
    existing.cron === entry.cron &&
    existing.timezone === timezone &&
    existing.misfirePolicy === misfirePolicy
  ) {
    return {
      missionId: mission.id,
      schedule: 'up-to-date',
      cron: existing.cron,
      timezone: existing.timezone,
      revision: existing.revision,
    };
  }
  const spec = await setSchedule(pool, mission.id, {
    cron: entry.cron,
    timezone,
    misfirePolicy,
  });
  return {
    missionId: mission.id,
    schedule: 'registered',
    cron: spec.cron,
    timezone: spec.timezone,
    revision: spec.revision,
  };
}

/** Register every default mission. Safe to run repeatedly. */
export async function addDefaultMissions(
  pool: Pool,
  env: NodeJS.ProcessEnv,
): Promise<RegistrationOutcome[]> {
  const timezone = timezoneFromEnv(env);
  const outcomes: RegistrationOutcome[] = [];
  for (const entry of DEFAULT_MISSIONS) {
    outcomes.push(await registerDefault(pool, entry, timezone));
  }
  return outcomes;
}
