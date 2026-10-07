/**
 * Run now (docs/agents.md, "Run now"): the owner starts one occurrence of a
 * mission instead of waiting for its schedule.
 *
 * It goes the way a scheduled occurrence goes from the moment the scheduler
 * hands it over: a `mission-run` job keyed by the occurrence, run by the same
 * handler and executor, so the plugin context, `mission.report` and
 * `mission.silent`, delivery through the owner's notifications and the quiet
 * count behind "Still useful?" are the scheduled run's own. The dashboard
 * route, `buddi missions run` and nothing else call this.
 */
import { appendEvent, enqueue, isPaused, startManualOccurrence, type Job, type Mission, type Occurrence } from '@buddi/core';
import type { Pool } from 'pg';

/** The scheduler's kind: run one occurrence of a scheduled mission. */
export const MISSION_JOB_KIND = 'mission-run';

/**
 * Hand one due occurrence to the queue.
 *
 * The dedup key *is* the occurrence id, which is what makes the handoff safe to
 * repeat: a process that dies between claiming and running leaves the claim to
 * the stale sweep, the occurrence is claimed again, and this enqueue returns the
 * job that already exists rather than running the mission twice.
 */
export async function queueOccurrence(pool: Pool, occurrence: Occurrence, mission: Mission): Promise<Job> {
  return enqueue(pool, {
    kind: MISSION_JOB_KIND,
    payload: { occurrenceId: occurrence.id, missionId: mission.id },
    dedupKey: occurrence.id,
  });
}

export type RunNowResult =
  | { ok: true; job: Job; occurrence: Occurrence; mission: Mission }
  | { ok: false; status: 404 | 409; error: string; occurrence?: Occurrence };

/** Start one occurrence now and queue it, or say in the owner's words why not. */
export async function runMissionNow(pool: Pool, missionId: string, now: Date): Promise<RunNowResult> {
  if (await isPaused(pool)) {
    return { ok: false, status: 409, error: 'buddi is paused, and nothing runs until you resume it.' };
  }
  const started = await startManualOccurrence(pool, missionId, now);
  if (!started.ok) {
    if (started.reason === 'unknown') return { ok: false, status: 404, error: `no such mission: ${missionId}` };
    const name = started.mission.name;
    if (started.reason === 'disabled') {
      return { ok: false, status: 409, error: started.mission.endedAt ? `${name} has ended. Switch it on first.` : `${name} is off. Switch it on first.` };
    }
    if (started.reason === 'paused') {
      return { ok: false, status: 409, error: `${name} is ${started.mission.pausedReason ?? 'paused'}.` };
    }
    return {
      ok: false,
      status: 409,
      error: started.occurrence.state === 'pending' ? `${name} is already queued.` : `${name} is already running.`,
      occurrence: started.occurrence,
    };
  }
  const job = await queueOccurrence(pool, started.occurrence, started.mission);
  await appendEvent(pool, 'occurrence.queued', {
    occurrenceId: started.occurrence.id,
    missionId: started.mission.id,
    scheduledAt: started.occurrence.scheduledAt.toISOString(),
    manual: true,
  });
  return { ok: true, job, occurrence: started.occurrence, mission: started.mission };
}
