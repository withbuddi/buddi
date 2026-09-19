/**
 * The dashboard's writes — every one of them a call into a core function that
 * already existed.
 *
 * There is no second path to an effect. Approving from the dashboard runs
 * `decideApproval` then `executeApproved` then `resumeJobForAction`, in that
 * order, exactly as `TelegramApprovals.handleCallback` does: the same atomic
 * transition, the same Executor, the same claim, the same effect ledger rows.
 * A surface establishes identity; authorization lives in core, and a *second*
 * implementation of the decision here would be a second place for it to be
 * wrong (ARCHITECTURE.md, "Owner and surface authentication").
 *
 * Because each write goes through core, each write emits core's own events —
 * so the dashboard shows its own actions in the log a second later, with no
 * special casing anywhere.
 */
import {
  cancelJob,
  cancelReminder,
  decideApproval,
  enqueue,
  executeApproved,
  getAction,
  getMission,
  recordOfferJob,
  resumeJobForAction,
  retryJob,
  takeOffer,
  setMissionEnabled,
  setPaused,
  setSchedule,
  toActionRecord,
  getActiveSchedule,
  MISFIRE_POLICIES,
  type ApprovalState,
  type Decision,
  type JobControl,
  type MisfirePolicy,
  type ToolContext,
  type ToolRegistry,
  type PermissionScope,
  type ActionRecord,
} from '@buddi/core';
import type { Pool } from 'pg';
import { toApprovalView, toJobView, type ApprovalView, type JobView } from './read.js';

/** The surface name recorded on every decision made here. */
export const WEB_SURFACE = 'web';

/** The worker id stamped on an action claimed by a dashboard decision. */
export const WEB_WORKER = 'web-approval';

export interface WriteDeps {
  resumeInteractive?: (action: ActionRecord, outcome: { actionId: string; state: ApprovalState; result?: unknown; error?: string }) => void;
  pool: Pool;
  registry: ToolRegistry;
  ctx: ToolContext;
  now: () => Date;
  /** The queue, when this process has one. Absent: a decision wakes nothing. */
  jobs?: JobControl | undefined;
  log?: ((line: string) => void) | undefined;
}

export type WriteResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; body: { error: string; detail?: unknown } };

function fail(status: number, error: string, detail?: unknown): WriteResult<never> {
  return { ok: false, status, body: { error, ...(detail === undefined ? {} : { detail }) } };
}

/* ------------------------------------------------------------------ *
 * Approvals
 * ------------------------------------------------------------------ */

export interface DecideResult {
  action: ApprovalView;
  /** What the Executor did, when the decision was `approved`. */
  execution: { state: ApprovalState; message?: string; result?: unknown } | null;
  /** Whether the suspended run was woken. */
  resumed: 'resumed' | 'no-job' | 'no-queue' | 'failed';
}

export async function decideApprovalFromWeb(
  deps: WriteDeps,
  actionId: string,
  decision: Decision,
  permissionScope: PermissionScope = 'once',
): Promise<WriteResult<DecideResult>> {
  const now = deps.now();
  const outcome = await decideApproval(deps.pool, {
    actionId,
    decision,
    by: deps.ctx.ownerId,
    via: WEB_SURFACE,
    now,
    permissionScope,
    registry: deps.registry,
  });

  if (!outcome.ok) {
    const current = await getAction(deps.pool, actionId);
    const status = outcome.reason === 'not-found' ? 404 : 409;
    return {
      ok: false,
      status,
      body: {
        error: outcome.message,
        ...(current ? { detail: toApprovalView(current) } : {}),
      },
    };
  }

  const action = outcome.action;

  if (decision === 'rejected') {
    const resumed = await wake(deps, action, { state: 'rejected' });
    const after = (await getAction(deps.pool, actionId)) ?? action;
    return { ok: true, status: 200, body: { action: toApprovalView(after), execution: null, resumed } };
  }

  // Approved. The Executor is the only thing that runs it, and it claims the
  // action atomically — a second tap, from any surface, cannot double it.
  const execution = await executeApproved(deps.pool, {
    actionId: action.id,
    registry: deps.registry,
    ctx: deps.ctx,
    worker: WEB_WORKER,
    now,
  });
  const state: ApprovalState = execution.ok ? 'succeeded' : execution.state;
  if (action.tool === 'host.exec' && !action.jobId && execution.ok &&
      (execution.result as { state?: string })?.state === 'completed') {
    deps.resumeInteractive?.(action, { actionId: action.id, state, result: execution.result });
  }
  const resumed = await wake(deps, action, {
    state,
    ...(execution.ok ? { result: execution.result } : { error: execution.message }),
  });

  const after = (await getAction(deps.pool, actionId)) ?? action;
  return {
    ok: true,
    status: 200,
    body: {
      action: toApprovalView(after),
      execution: execution.ok
        ? { state: 'succeeded', result: execution.result }
        : { state: execution.state, message: execution.message },
      resumed,
    },
  };
}

/** Wake the suspended run, if there is one. Never fails the decision. */
async function wake(
  deps: WriteDeps,
  action: { id: string; jobId: string | null },
  outcome: { state: ApprovalState; result?: unknown; error?: string },
): Promise<DecideResult['resumed']> {
  try {
    return await resumeJobForAction(deps.pool, deps.jobs, action, outcome);
  } catch (err) {
    deps.log?.(
      `web: resuming job ${action.jobId} for action ${action.id} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 'failed';
  }
}

/* ------------------------------------------------------------------ *
 * Pause
 * ------------------------------------------------------------------ */

export async function setPausedFromWeb(
  deps: WriteDeps,
  paused: boolean,
): Promise<WriteResult<{ paused: boolean }>> {
  const now = await setPaused(deps.pool, paused);
  return { ok: true, status: 200, body: { paused: now } };
}

/* ------------------------------------------------------------------ *
 * Missions
 * ------------------------------------------------------------------ */

export async function setMissionEnabledFromWeb(
  deps: WriteDeps,
  missionId: string,
  enabled: boolean,
): Promise<WriteResult<{ id: string; enabled: boolean }>> {
  const mission = await setMissionEnabled(deps.pool, missionId, enabled);
  if (!mission) return fail(404, `no such mission: ${missionId}`);
  return { ok: true, status: 200, body: { id: mission.id, enabled: mission.enabled } };
}

export interface ScheduleChange {
  cron?: string | undefined;
  timezone?: string | undefined;
  misfirePolicy?: string | undefined;
  deadlineMinutes?: number | null | undefined;
}

/**
 * Change a mission's misfire policy (or its cron, or its zone).
 *
 * `setSchedule` is append-only: the active spec is deactivated and a new
 * revision inserted, so occurrences already materialized keep their provenance
 * and their idempotency key stays valid. Anything the caller omits is carried
 * over from the active spec rather than reset to a default — a dashboard that
 * silently moved a cron because the owner changed a dropdown would be a bug.
 */
export async function setScheduleFromWeb(
  deps: WriteDeps,
  missionId: string,
  change: ScheduleChange,
): Promise<WriteResult<unknown>> {
  const mission = await getMission(deps.pool, missionId);
  if (!mission) return fail(404, `no such mission: ${missionId}`);
  const active = await getActiveSchedule(deps.pool, missionId);

  const cron = (change.cron ?? active?.cron ?? '').trim();
  const timezone = (change.timezone ?? active?.timezone ?? '').trim();
  const policy = (change.misfirePolicy ?? active?.misfirePolicy ?? '') as MisfirePolicy;

  if (cron === '' || timezone === '') {
    return fail(400, 'this mission has no schedule yet; a cron and a timezone are required');
  }
  if (!(MISFIRE_POLICIES as readonly string[]).includes(policy)) {
    return fail(400, `unknown misfire policy: ${policy} (expected ${MISFIRE_POLICIES.join(', ')})`);
  }

  const deadlineMinutes =
    change.deadlineMinutes === undefined ? (active?.deadlineMinutes ?? null) : change.deadlineMinutes;

  try {
    const spec = await setSchedule(deps.pool, missionId, {
      cron,
      timezone,
      misfirePolicy: policy,
      deadlineMinutes,
    });
    return {
      ok: true,
      status: 200,
      body: {
        missionId,
        cron: spec.cron,
        timezone: spec.timezone,
        revision: spec.revision,
        misfirePolicy: spec.misfirePolicy,
        deadlineMinutes: spec.deadlineMinutes,
      },
    };
  } catch (err) {
    return fail(400, err instanceof Error ? err.message : String(err));
  }
}

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

export async function retryJobFromWeb(
  deps: WriteDeps,
  jobId: string,
): Promise<WriteResult<{ job: JobView }>> {
  const job = await retryJob(deps.pool, jobId);
  if (!job) return fail(409, 'only a failed, cancelled or suspended job can be retried');
  return { ok: true, status: 200, body: { job: toJobView(job) } };
}

export async function cancelJobFromWeb(
  deps: WriteDeps,
  jobId: string,
): Promise<WriteResult<{ job: JobView }>> {
  const job = await cancelJob(deps.pool, jobId);
  if (!job) return fail(409, 'only a pending, running or suspended job can be cancelled');
  return { ok: true, status: 200, body: { job: toJobView(job) } };
}

/* ------------------------------------------------------------------ *
 * Reminders
 * ------------------------------------------------------------------ */

export async function cancelReminderFromWeb(
  deps: WriteDeps,
  reminderId: string,
  reason: string,
): Promise<WriteResult<{ id: string; state: string }>> {
  const reminder = await cancelReminder(
    deps.pool,
    reminderId,
    reason.trim() === '' ? 'cancelled from the dashboard' : reason,
    deps.now(),
  );
  if (!reminder) return fail(409, 'only a pending reminder can be cancelled');
  return { ok: true, status: 200, body: { id: reminder.id, state: reminder.state } };
}

/**
 * The owner chose one of the actions an agent offered, on the dashboard.
 *
 * Identical to the Telegram tap in every way that matters, because it is the
 * same two steps against the same rows: claim the offer atomically, then
 * enqueue an ordinary agent run with the prompt the *agent* wrote. The request
 * body names an id and nothing else — there is no way to post a prompt of your
 * own through here — and the run that starts has the tools, tiers and approval
 * gate it always had.
 */
export async function takeOfferFromWeb(
  deps: WriteDeps,
  offerId: string,
): Promise<WriteResult<{ id: string; label: string; jobId: string | null }>> {
  const taken = await takeOffer(deps.pool, { id: offerId, via: 'web', now: deps.now() });
  if (!taken.ok) {
    return fail(taken.reason === 'unknown' ? 404 : 409, taken.message);
  }
  let jobId: string | null = null;
  if (deps.jobs) {
    const job = await enqueue(deps.pool, {
      kind: 'agent-run',
      payload: {
        agentId: taken.offer.agentId,
        prompt: taken.offer.prompt,
        conversationHint: `offer:${taken.offer.id}`,
      },
      dedupKey: `offer:${taken.offer.id}`,
    });
    jobId = job.id;
    await recordOfferJob(deps.pool, taken.offer.id, job.id).catch(() => {});
  }
  return {
    ok: true,
    status: 200,
    body: { id: taken.offer.id, label: taken.offer.label, jobId },
  };
}

/** Re-exported so the router does not have to reach into core for the cast. */
export { toActionRecord };
