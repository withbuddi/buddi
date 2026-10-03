/**
 * The worker loop: claim -> run -> complete | fail | suspend.
 *
 * Three things it is careful about, because the architecture asks for them by
 * name:
 *
 *  - **Startup recovery is Phase 1.** Before the first claim, every lease that
 *    outlived its process is settled (`interruptLeases`): the expired ones,
 *    and every one held by a previous boot of this worker (`holderPrefix`),
 *    however long its lease still had to run. A restart takes seconds and a
 *    lease lasts minutes, so expiry alone would leave the run stranded until
 *    some later restart happened to come after it lapsed.
 *  - **Leases are swept while running.** Every `sweepMs` a lease whose
 *    heartbeat stopped longer than the lease ago is settled the same way.
 *  - **Shutdown hands its leases back.** `stop()` aborts the runs, gives them
 *    `stopGraceMs` to unwind, and settles whatever this worker still holds, so
 *    the next boot finds nothing leased.
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
  interruptLeases,
  suspendJob,
  type InterruptedJob,
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
  /**
   * Worker ids of the same family as this one (`serve:` for every boot of
   * `buddi serve`). At start, a lease held by any other id with this prefix
   * belongs to a process that is gone, and is settled whatever its expiry.
   * Omitted: only expired leases are.
   */
  holderPrefix?: string;
  /** Cadence of the running sweep for expired leases (default one minute; 0 turns it off). */
  sweepMs?: number;
  /** How long `stop()` lets aborted runs unwind before settling their leases (default 5s). */
  stopGraceMs?: number;
  /** Told about every lease settled at start, by the sweep, or at stop. */
  onInterrupted?: (jobs: InterruptedJob[], when: 'start' | 'sweep' | 'stop') => void;
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
  let resolveLoop: () => void = () => {};
  const loopExited = new Promise<void>((resolve) => {
    resolveLoop = resolve;
  });
  let stopping: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let wake: (() => void) | null = null;
  const active = new Set<AbortController>();

  const onInterrupted = opts.onInterrupted ?? ((): void => {});
  const recover = async (): Promise<number> => {
    const scope = opts.holderPrefix
      ? { expiredBy: now(), self: worker, holderPrefix: opts.holderPrefix }
      : { expiredBy: now() };
    const jobs = await interruptLeases(pool, scope);
    if (jobs.length > 0) onInterrupted(jobs, 'start');
    return jobs.length;
  };

  // The running sweep: a run whose holder stopped heartbeating (a process that
  // died without being told, a worker wedged past its lease) is settled within
  // a minute of its lease lapsing, rather than at whichever restart comes next.
  let sweeping = false;
  const sweepMs = opts.sweepMs ?? 60_000;
  const sweeper = sweepMs > 0 ? setInterval(() => {
    if (!running || sweeping) return;
    sweeping = true;
    void interruptLeases(pool, { expiredBy: now() }, 'its lease lapsed without a heartbeat')
      .then((jobs) => { if (jobs.length > 0) onInterrupted(jobs, 'sweep'); })
      .catch(onError)
      .finally(() => { sweeping = false; });
  }, sweepMs) : null;
  sweeper?.unref?.();

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
    resolveLoop();
  };

  void loop();

  return {
    tick,
    recover,
    done,
    stop(): Promise<void> {
      stopping ??= (async () => {
        running = false;
        if (sweeper) clearInterval(sweeper);
        for (const controller of active) controller.abort(new Error('worker stopped'));
        if (timer) clearTimeout(timer);
        wake?.();
        // Bounded: a handler that ignores its signal does not hold the stop
        // past the service manager's grace (launchd's is 20s).
        let grace: NodeJS.Timeout | undefined;
        await Promise.race([
          loopExited,
          new Promise<void>((resolve) => { grace = setTimeout(resolve, opts.stopGraceMs ?? 5_000); grace.unref?.(); }),
        ]);
        clearTimeout(grace);
        // The runs this process was in the middle of are settled now, not left
        // leased for the next boot to find.
        try {
          const jobs = await interruptLeases(pool, { heldBy: worker }, 'buddi was stopping');
          if (jobs.length > 0) onInterrupted(jobs, 'stop');
        } catch (err) {
          onError(err);
        }
        resolveDone();
      })();
      return stopping;
    },
  };
}
