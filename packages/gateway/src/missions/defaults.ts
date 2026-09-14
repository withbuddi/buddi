/**
 * The missions a fresh install registers — `buddi missions add-defaults`.
 *
 * The gateway no longer *knows* any of them. A scheduled mission is domain
 * knowledge ("every Friday, recap the week" means nothing without the plugin
 * that can compute one), so every default comes from an installed plugin's
 * `missions` suggestions and is resolved here against the agent catalog:
 *
 *  - `agentRole: 'recap'` lands on whichever agent claims that role;
 *  - a role nobody claims is **skipped with a printed reason**, never quietly
 *    registered on the default agent;
 *  - `agentId` pins one agent by name, and an id the catalog does not know is
 *    skipped the same way.
 *
 * `sentinel-wake` is the exception, and stays here: it has no cron and no
 * domain — a watcher enqueues it — so it is infrastructure, not a suggestion.
 * Its speaker is still resolved by role (see `sentinelWakeMission`).
 *
 * Registration is idempotent by construction: the mission is upserted, and its
 * schedule is only replaced when the cron, the zone or the misfire policy
 * actually differ, so running the command twice leaves one mission and one
 * active schedule revision.
 */
import {
  getActiveSchedule,
  setSchedule,
  timezoneFromEnv,
  upsertMission,
  type AgentCatalog,
  type MisfirePolicy,
  type PluginManifest,
  type SuggestedMission,
  type UpsertMissionInput,
} from '@buddi/core';
import type { Pool } from 'pg';
import { gatewayCatalog, installedManifests } from '../agents/catalog.js';
import { gettingStartedMission, GETTING_STARTED_CRON, GETTING_STARTED_ID } from './getting-started.js';
import {
  arcWindow,
  endsTheArc,
  nudgePolicy,
  refusalText,
  type Engagement,
  type NudgeState,
  type OnboardingWindowState,
} from './nudge-policy.js';
import { readArcState, readEngagement } from './nudge-state.js';
import { sentinelWakeMission } from './sentinel-wake.js';

export type DefaultMission = {
  mission: UpsertMissionInput;
  /** No cron at all: the mission exists to be enqueued, never scheduled. */
  cron?: string;
  /** The installation's zone unless the suggestion pinned one. */
  timezone?: string;
  misfirePolicy?: MisfirePolicy;
};

/** A suggestion that could not be placed, and the sentence saying why. */
export type SkippedMission = {
  missionId: string;
  reason: string;
};

export type MissionPlan = {
  entries: DefaultMission[];
  skipped: SkippedMission[];
};

/** Every suggestion the installed plugins make, in plugin then declared order. */
export function suggestedMissions(
  manifests: readonly PluginManifest[] = installedManifests(),
): SuggestedMission[] {
  return manifests.flatMap((m) => m.missions ?? []);
}

/** The first suggested mission claiming a role, for a surface that runs one. */
export function suggestedMissionForRole(
  role: string,
  manifests: readonly PluginManifest[] = installedManifests(),
): SuggestedMission | undefined {
  return suggestedMissions(manifests).find((m) => m.agentRole === role);
}

/**
 * What `add-defaults` should do about the first-run arc.
 *
 * `register: false` is the owner having opted out: the mission is not created
 * at all, so there is nothing to notice, enable by accident or wonder about.
 * `enabled` is the window — an installation past its first two weeks registers
 * the mission disabled, which is also what it would have disabled itself to.
 */
export type ArcRegistration =
  | { register: false; reason: string }
  | { register: true; enabled: boolean; reason: string };

/**
 * Decide it from the two facts that matter, with no database in sight.
 *
 * Default when nothing is known: registered, disabled. A fresh checkout with no
 * onboarding row has no first run to be inside of, and the honest answer to
 * "should it nudge?" without evidence is no.
 */
export function planArc(
  input: {
    engagement: Engagement | undefined;
    onboarding: OnboardingWindowState | null;
    /** The counters, when there is a row. An arc already over stays over. */
    nudges?: NudgeState | null;
  },
  now: Date,
): ArcRegistration {
  if (input.engagement === 'quiet') {
    return { register: false, reason: 'the owner set engagement to quiet' };
  }
  const window = arcWindow(input.onboarding, now);
  if (!window.open) return { register: true, enabled: false, reason: window.reason };

  // Re-running `add-defaults` must not undo the arc stopping itself: three
  // unanswered messages or a spent budget are the owner's answer, not a state
  // to be reset by a command that means "register what the plugins suggest".
  if (input.nudges) {
    const decision = nudgePolicy(input.nudges, now);
    if (!decision.allow && endsTheArc(decision.reason)) {
      return { register: true, enabled: false, reason: refusalText(decision.reason) };
    }
  }
  return { register: true, enabled: true, reason: window.reason };
}

/** What `planDefaultMissions` assumes when the caller knows nothing. */
export const ARC_UNKNOWN: ArcRegistration = {
  register: true,
  enabled: false,
  reason: 'the onboarding state was not read',
};

/**
 * Resolve every suggestion against the catalog. Pure: it decides *what* would
 * be registered and what cannot be, and touches no database.
 */
export function planDefaultMissions(
  catalog: AgentCatalog,
  manifests: readonly PluginManifest[] = installedManifests(),
  arc: ArcRegistration = ARC_UNKNOWN,
): MissionPlan {
  const entries: DefaultMission[] = [];
  const skipped: SkippedMission[] = [];

  for (const suggestion of suggestedMissions(manifests)) {
    let agentId: string | undefined;
    if (suggestion.agentRole !== undefined) {
      const resolution = catalog.agentForRole(suggestion.agentRole);
      if (!resolution.ok) {
        skipped.push({ missionId: suggestion.id, reason: resolution.problem.message });
        continue;
      }
      agentId = resolution.agent.id;
    } else if (suggestion.agentId !== undefined) {
      const agent = catalog.get(suggestion.agentId);
      if (!agent) {
        skipped.push({
          missionId: suggestion.id,
          reason: `no agent "${suggestion.agentId}" is installed here`,
        });
        continue;
      }
      agentId = agent.id;
    } else {
      skipped.push({
        missionId: suggestion.id,
        reason: 'the suggestion names neither an agentRole nor an agentId',
      });
      continue;
    }

    entries.push({
      mission: {
        id: suggestion.id,
        name: suggestion.name,
        agentId,
        prompt: suggestion.prompt,
        enabled: suggestion.enabledByDefault ?? true,
        alwaysDeliver: suggestion.alwaysDeliver ?? false,
      },
      cron: suggestion.cron,
      ...(suggestion.timezone ? { timezone: suggestion.timezone } : {}),
      misfirePolicy: suggestion.misfirePolicy ?? 'coalesce',
    });
  }

  // The first-run arc. Gateway infrastructure like `sentinel-wake` — no plugin
  // owns "introduce yourself" — but unlike it, it is scheduled, and whether it
  // is *enabled* is the onboarding window's answer, not this file's.
  if (arc.register) {
    entries.push({
      mission: gettingStartedMission(catalog, arc.enabled),
      cron: GETTING_STARTED_CRON,
      // The arc is about today. A laptop that was shut for three days owes the
      // owner one message this morning, not three.
      misfirePolicy: 'latest-only',
    });
  } else {
    skipped.push({ missionId: GETTING_STARTED_ID, reason: arc.reason });
  }

  // Infrastructure, last and always: it needs no plugin and has no schedule.
  entries.push({ mission: sentinelWakeMission(catalog) });
  return { entries, skipped };
}

export type RegistrationOutcome =
  | {
      missionId: string;
      /** 'registered' when a new schedule revision was written, else 'up-to-date'. */
      schedule: 'registered' | 'up-to-date' | 'none';
      cron?: string;
      timezone?: string;
      revision?: number;
    }
  | { missionId: string; schedule: 'skipped'; reason: string };

/** Upsert one mission and point it at its schedule, if it has one. */
export async function registerDefault(
  pool: Pool,
  entry: DefaultMission,
  timezone: string,
): Promise<RegistrationOutcome> {
  const mission = await upsertMission(pool, entry.mission);
  if (!entry.cron) return { missionId: mission.id, schedule: 'none' };

  const zone = entry.timezone ?? timezone;
  const misfirePolicy = entry.misfirePolicy ?? 'coalesce';
  const existing = await getActiveSchedule(pool, mission.id);
  if (
    existing &&
    existing.cron === entry.cron &&
    existing.timezone === zone &&
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
    timezone: zone,
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

export interface AddDefaultMissionsOptions {
  catalog?: AgentCatalog;
  manifests?: readonly PluginManifest[];
  /** Injected in tests; read from the onboarding row and the preferences. */
  arc?: ArcRegistration;
  now?: () => Date;
}

/** Read the two facts `planArc` needs. Absent onboarding is not an error. */
export async function readArcRegistration(pool: Pool, now: Date): Promise<ArcRegistration> {
  const onboarding = await readArcState(pool);
  const engagement = await readEngagement(pool);
  return planArc(
    {
      engagement,
      onboarding: onboarding
        ? {
            state: onboarding.state,
            completedAt: onboarding.completedAt,
            surface: onboarding.surface,
          }
        : null,
      nudges: onboarding,
    },
    now,
  );
}

/**
 * Register whatever the installed plugins suggest. Safe to run repeatedly.
 *
 * Skipped suggestions come back in the same list, so the caller prints one line
 * per mission whether it landed or not — an install with no plugins registers
 * only `sentinel-wake` and says nothing was suggested.
 */
export async function addDefaultMissions(
  pool: Pool,
  env: NodeJS.ProcessEnv,
  opts: AddDefaultMissionsOptions = {},
): Promise<RegistrationOutcome[]> {
  const timezone = timezoneFromEnv(env);
  const catalog = opts.catalog ?? gatewayCatalog(env);
  const now = (opts.now ?? ((): Date => new Date()))();
  const arc = opts.arc ?? (await readArcRegistration(pool, now));
  const plan = planDefaultMissions(catalog, opts.manifests ?? installedManifests(), arc);
  const outcomes: RegistrationOutcome[] = [];
  for (const entry of plan.entries) {
    outcomes.push(await registerDefault(pool, entry, timezone));
  }
  for (const skip of plan.skipped) {
    outcomes.push({ missionId: skip.missionId, schedule: 'skipped', reason: skip.reason });
  }
  return outcomes;
}
