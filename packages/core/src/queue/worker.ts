/**
 * The worker loop: claim -> run -> complete | fail | suspend.
 *
 * Three things it is careful about, because the architecture asks for them by
 * name:
 *
 *  - **Startup recovery is Phase 1.** Before the first claim, every lease that
 *    outlived its process is released. A machine that lost power mid-mission
 *    picks the work back up rather than leaving it leased forever.
 *  - **Leases are heartbeated, and the heartbeat is a fence.** When a heartbeat
 *    says the lease is gone, the run is abandoned *immediately* — another
 *    worker owns the job now, and writing anything further would be writing
 *    over it.
 *  - **Suspension is durable.** A handler that returns `{ suspended: reason }`
 *    parks the job as a row. No worker, no transaction and no open provider
 *    call is held while an approval waits for a human.
 *
 * Core injects nothing of its own here: handlers arrive from the layer above
 * (core never imports the runtime or a gateway), keyed by job kind. A job whose
 * kind has no handler fails closed — it is never run by a handler that happens
 * to be nearby.
 */
import type { Pool } from 'pg';
import {
  claimJob,
  completeJob,
  failJob,
  heartbeat,
  releaseStaleLeases,
  suspendJob,
} from './jobs.js';
import { decideRetry } from './retry-policy.js';
import type { Job } from './types.js';

/** What a handler may return instead of a result: park the job, durably. */
export type Suspension = {
  suspended: string;
  /**
   * Merged into the job's payload as it is parked. A run that stopped on an
   * approval writes what it is waiting for here — the action, the conversation
   * — because the worker that resumes it is a different process as often as
   * not, and nothing may be kept in memory across the wait.
   */
  payloadPatch?: Record<string, unknown>;
};

export function isSuspension(value: unknown): value is Suspension {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Suspension).suspended === 'string'
  );
}

export interface JobContext {
  /** Aborted on lease loss, cancellation observed by heartbeat, or shutdown. */
  readonly signal: AbortSignal;
  /**
   * Extend the lease mid-run. `false` means the lease is gone and the handler
   * must stop; the loop stops calling it either way.
   */
  heartbeat(): Promise<boolean>;
  /** Park this job now. The handler should return promptly afterwards. */
  suspend(reason: string, opts?: { payloadPatch?: Record<string, unknown> }): Promise<void>;
  /** True once the lease was observed lost. Long handlers should check it. */
  readonly lost: boolean;
}

export type JobHandler = (job: Job, ctx: JobContext) => Promise<unknown>;

export interface RunWorkerOptions {
  pool: Pool;
  /** Stable identity for this worker; it is the fence token on every write. */
  worker: string;
  /** Kinds this worker claims. Omitted or empty: every kind. */
  kinds?: readonly string[];
  handlers: Record<string, JobHandler>;
  now: () => Date;
  /** Idle delay between empty claims. */
  pollMs: number;
  /** How long a claim is held before it may be reclaimed. */
  leaseMs: number;
  /** Heartbeat cadence. Defaults to a third of the lease. */
  heartbeatMs?: number;
  /** Release stale leases before the first claim (default true). */
  recoverOnStart?: boolean;
  onError?: (err: unknown, job?: Job) => void;
}

export interface WorkerHandle {
  /** One pass: claim at most one job and run it. Returns the job, if any. */
  tick(): Promise<Job | null>;
  /** Release leases left by a dead process. Called once at startup. */
  recover(): Promise<number>;
  stop(): Promise<void>;
  readonly done: Promise<void>;
}

export function runWorker(opts: RunWorkerOptions): WorkerHandle {
  const { pool, worker, handlers, now } = opts;
  const leaseMs = opts.leaseMs;
  const heartbeatMs = opts.heartbeatMs ?? Math.max(1000, Math.floor(leaseMs / 3));
  const kinds = opts.kinds && opts.kinds.length > 0 ? [...opts.kinds] : undefined;
  const onError = opts.onError ?? ((): void => {});

  let running = true;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let timer: NodeJS.Timeout | null = null;
  let wake: (() => void) | null = null;
  const active = new Set<AbortController>();

  const recover = async (): Promise<number> => releaseStaleLeases(pool, now());

  const tick = async (): Promise<Job | null> => {
    const claimStartedAt = Date.now();
    const job = await claimJob(pool, {
      worker,
      ...(kinds ? { kinds } : {}),
      now: now(),
      leaseMs,
    });
    if (!job) return null;
    // Stop/expiry can happen while the claim query is in flight. Do not start
    // a handler on a claim whose authority has already ended.
    if (!running || Date.now() >= claimStartedAt + leaseMs) return job;

    const handler = handlers[job.kind];
    if (!handler) {
      // Fail closed: an unknown kind is a configuration problem, not something
      // to hand to whichever handler is at hand. No retry — a redeploy that
      // adds the handler can `buddi jobs retry` it.
      await failJob(pool, job.id, worker, `no handler for job kind "${job.kind}"`, {
        retry: false,
      });
      return job;
    }

    let lost = false;
    let finished = false;
    const controller = new AbortController();
    active.add(controller);
    const loseLease = (): void => {
      lost = true;
      controller.abort(new Error('job lease lost'));
    };
    let leaseTimer: NodeJS.Timeout;
    const fenceUntil = (deadline: number): void => {
      clearTimeout(leaseTimer);
      leaseTimer = setTimeout(loseLease, Math.max(0, deadline - Date.now()));
      leaseTimer.unref?.();
    };
    fenceUntil(claimStartedAt + leaseMs);
    let suspendedBy: string | null = null;
    let suspendPatch: Record<string, unknown> | undefined;

    const beat = async (): Promise<boolean> => {
      if (lost || finished) return false;
      const startedAt = Date.now();
      let alive: boolean;
      try {
        alive = await heartbeat(pool, job.id, worker, leaseMs);
      } catch (err) {
        onError(err, job);
        // No confirmed renewal: the local lease deadline still stops this run.
        return !lost;
      }
      if (finished) return false;
      if (!alive) loseLease();
      else if (!lost) fenceUntil(startedAt + leaseMs);
      return alive && !lost;
    };

    const ctx: JobContext = {
      signal: controller.signal,
      heartbeat: beat,
      async suspend(reason, opts): Promise<void> {
        suspendedBy = reason;
        if (opts?.payloadPatch) suspendPatch = opts.payloadPatch;
      },
      get lost(): boolean {
        return lost;
      },
    };

    const ticker = setInterval(() => {
      void beat();
    }, heartbeatMs);
    if (typeof ticker.unref === 'function') ticker.unref();

    try {
      const result = await handler(job, ctx);
      clearInterval(ticker);
      if (lost || !running) return job; // Leave recovery to the lease owner.

      const suspension = isSuspension(result) ? result.suspended : suspendedBy;
      const patch = (isSuspension(result) ? result.payloadPatch : undefined) ?? suspendPatch;
      if (suspension !== null && suspension !== undefined) {
        await suspendJob(pool, job.id, worker, suspension, patch ? { payloadPatch: patch } : {});
        return job;
      }
      await completeJob(pool, job.id, worker, result ?? null);
    } catch (err) {
      clearInterval(ticker);
      onError(err, job);
      if (lost || !running) return job;
      const message = err instanceof Error ? err.message : String(err);
      // The retry policy, not the loop, decides whether there is any point.
      // A permanent failure — a rejected schema, an auth error, a 400 — dies
      // here on the first attempt; a transport error or a 429 gets the kind's
      // horizon, which for unattended work is hours rather than minutes.
      const decision = decideRetry({
        kind: job.kind,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        createdAt: job.createdAt,
        now: now(),
        error: err,
      });
      await failJob(pool, job.id, worker, message, {
        retry: decision.retry,
        ...(decision.backoffMs === undefined ? {} : { backoffMs: decision.backoffMs }),
        classification: { class: decision.failureClass, reason: decision.reason },
      }).catch((e) => onError(e, job));
    } finally {
      finished = true;
      clearInterval(ticker);
      clearTimeout(leaseTimer!);
      active.delete(controller);
    }
    return job;
  };

  const loop = async (): Promise<void> => {
    if (opts.recoverOnStart !== false) {
      await recover().catch(onError);
    }
    while (running) {
      let job: Job | null = null;
      try {
        job = await tick();
      } catch (err) {
        onError(err);
      }
      if (!running) break;
      // A job ran: try again immediately, the queue may be backed up.
      if (job) continue;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, opts.pollMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
      wake = null;
    }
    resolveDone();
  };

  void loop();

  return {
    tick,
    recover,
    done,
    async stop(): Promise<void> {
      running = false;
      for (const controller of active) controller.abort(new Error('worker stopped'));
      if (timer) clearTimeout(timer);
      wake?.();
      await done;
    },
  };
}
