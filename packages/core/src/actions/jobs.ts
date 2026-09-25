/**
 * How an approval reaches the suspended run that is waiting for it.
 *
 * A run that proposes a gated tool call does not hold a worker or a database
 * transaction open while the owner sleeps (docs/architecture.md, "Queue, concurrency,
 * recovery": «Runs suspend durably while awaiting approval»). The queue owns
 * suspension; the approval machinery owns the decision. They meet at exactly
 * this interface and nowhere else:
 *
 *   suspendJob(pool, jobId, { reason, actionId })
 *   resumeJob(pool, jobId, { payloadPatch: { approval: { actionId, state } } })
 *
 * It is declared here, in the module that needs to *call* it, so the approval
 * path compiles and is testable whether or not the queue module is present in
 * a given build. Wire the real functions in at the composition root; leave it
 * out and a decided action simply records its outcome without waking anything.
 */
import type { ApprovalState, Queryable } from './types.js';

/**
 * The patch a resumed job carries: which action was decided, and how.
 *
 * A type alias rather than an interface, deliberately: the queue takes a
 * `Record<string, unknown>` patch, and only an alias carries the implicit index
 * signature that makes this shape one of those without a cast.
 */
export type ApprovalPayloadPatch = {
  approval: {
    actionId: string;
    state: ApprovalState;
    /** The effect's result, when it ran. Absent for a rejection. */
    result?: unknown;
    error?: string;
  };
};

/**
 * The half of the queue the approval path calls.
 *
 * Suspension is the job layer's own business — it happens where the run is,
 * with the worker's lease in hand (`suspendJob(pool, jobId, worker, reason)`).
 * A decision, by contrast, arrives from a surface that knows nothing about
 * workers, so waking the run is expressed here and nowhere else.
 */
export interface JobControl {
  /** Wake a suspended job with the decision's outcome. */
  resumeJob(
    pool: Queryable,
    jobId: string,
    opts: { payloadPatch: ApprovalPayloadPatch },
  ): Promise<unknown>;
}

/**
 * Wake the job an action belongs to, if there is one and if this build has a
 * queue wired in. Never throws into the decision path: an approval that was
 * recorded stays recorded even if the wake-up fails, and the failure is the
 * caller's to log.
 */
export async function resumeJobForAction(
  pool: Queryable,
  jobs: JobControl | undefined,
  action: { id: string; jobId: string | null; tool?: string },
  outcome: { state: ApprovalState; result?: unknown; error?: string },
): Promise<'resumed' | 'no-job' | 'no-queue'> {
  if (action.jobId === null) return 'no-job';
  if (!jobs) return 'no-queue';
  await jobs.resumeJob(pool, action.jobId, {
    payloadPatch: {
      approval: {
        actionId: action.id,
        ...(action.tool ? { tool: action.tool } : {}),
        state: outcome.state,
        ...(outcome.result === undefined ? {} : { result: outcome.result }),
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
      },
    },
  });
  return 'resumed';
}
