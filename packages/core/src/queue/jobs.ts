/**
 * The queue's state transitions. Every one of them is a single statement whose
 * WHERE clause is the guarantee:
 *
 *  - `claimJob` takes exactly one ready row with `for update skip locked`, so
 *    two workers never see the same job and a locked row is stepped over rather
 *    than waited on.
 *  - `heartbeat`, `completeJob`, `failJob` and `suspendJob` all match on
 *    `lease_owner = $worker and state = 'leased'`. That is the fence: a worker
 *    whose lease expired and was reclaimed elsewhere updates nothing and is
 *    told so (`false` / `null`), instead of writing over the new owner's run.
 *  - `interruptLeases` is startup recovery, the running sweep and the
 *    shutdown release — a lease that outlived its run is settled: requeued
 *    once when the run had done nothing yet, failed with the reason otherwise.
 *    (`releaseStaleLeases` is the older, unconditional put-back.)
 */
import type { Pool } from 'pg';
import { appendEvent } from '../events.js';
import { PAUSED_SQL } from './flags.js';
import {
  retryProfileFor,
  UNATTENDED_JOB_KINDS,
  UNATTENDED_RETRY_PROFILE,
  type FailureClass,
} from './retry-policy.js';
import {
  ACKNOWLEDGED_FAILED_SQL,
  JOB_COLUMNS,
  UNACKNOWLEDGED_FAILED_SQL,
  RETRY_BASE_MS,
  RETRY_FACTOR,
  toJob,
  type Job,
  type JobRow,
  type JobState,
} from './types.js';

export type EnqueueInput = {
  kind: string;
  payload?: unknown;
  priority?: number;
  runAfter?: Date;
  /**
   * Cap on attempts. Defaults to the kind's retry profile — three for anything
   * someone is waiting on, eight for unattended work — rather than to a
   * constant, so a triage run is not held to a prompt's patience.
   */
  maxAttempts?: number;
  /**
   * Idempotency. Enqueueing the same key twice returns the job that is already
   * there — which is what lets a caller enqueue blindly (one job per scheduled
   * occurrence) without first asking whether it did so already.
   */
  dedupKey?: string;
  conversationId?: string;
};

/** Put work on the queue. Idempotent when `dedupKey` is given. */
export async function enqueue(pool: Pool, input: EnqueueInput): Promise<Job> {
  if (!input.kind || input.kind.trim() === '') throw new Error('enqueue: kind is required');
  const { rows } = await pool.query<JobRow>(
    `insert into core.jobs (kind, payload, priority, run_after, max_attempts, dedup_key, conversation_id)
     values ($1, coalesce($2::jsonb, '{}'::jsonb), $3, coalesce($4::timestamptz, now()), $5, $6, $7::uuid)
     on conflict (dedup_key) do nothing
     returning ${JOB_COLUMNS}`,
    [
      input.kind,
      input.payload === undefined ? null : JSON.stringify(input.payload),
      input.priority ?? 0,
      input.runAfter?.toISOString() ?? null,
      input.maxAttempts ?? retryProfileFor(input.kind).maxAttempts,
      input.dedupKey ?? null,
      input.conversationId ?? null,
    ],
  );

  if (rows.length > 0) {
    const job = toJob(rows[0] as JobRow);
    await appendEvent(
      pool,
      'job.enqueued',
      { jobId: job.id, kind: job.kind, dedupKey: job.dedupKey, priority: job.priority },
      job.conversationId ?? undefined,
    );
    return job;
  }

  // The dedup key was taken: the existing job *is* the answer, not an error.
  const existing = await getJobByDedupKey(pool, input.dedupKey as string);
  if (!existing) throw new Error(`enqueue: conflict on dedup key "${input.dedupKey}" but no row`);
  return existing;
}

export type ClaimInput = {
  /** Stable identity of the claiming worker; the fence token for every write. */
  worker: string;
  /** Restrict to these kinds. Omitted: any kind. */
  kinds?: readonly string[];
  now: Date;
  leaseMs: number;
};

/**
 * Atomically take one ready job, or return null.
 *
 * The pause flag is read inside this statement: a paused installation claims
 * nothing, and the check cannot drift out of date between reading and taking.
 */
export async function claimJob(pool: Pool, input: ClaimInput): Promise<Job | null> {
  const now = input.now.toISOString();
  const until = new Date(input.now.getTime() + input.leaseMs).toISOString();
  const kinds = input.kinds && input.kinds.length > 0 ? [...input.kinds] : null;

  const { rows } = await pool.query<JobRow>(
    `update core.jobs
     set state = 'leased',
         lease_owner = $1,
         lease_until = $2::timestamptz,
         attempts = attempts + 1,
         updated_at = now()
     where id = (
       select j.id from core.jobs j
       where j.state = 'pending'
         and j.run_after <= $3::timestamptz
         and ($4::text[] is null or j.kind = any($4::text[]))
         and not ${PAUSED_SQL}
       order by j.priority desc, j.run_after, j.created_at
       for update skip locked
       limit 1
     )
     returning ${JOB_COLUMNS}`,
    [input.worker, until, now, kinds],
  );
  if (rows.length === 0) return null;
  const job = toJob(rows[0] as JobRow);
  await appendEvent(
    pool,
    'job.claimed',
    { jobId: job.id, kind: job.kind, worker: input.worker, attempt: job.attempts },
    job.conversationId ?? undefined,
  );
  return job;
}

/**
 * Extend the lease. `false` means the lease was lost — reclaimed by another
 * worker, cancelled, or resumed elsewhere — and the caller **must stop**: any
 * further write it attempts will match no row anyway.
 */
export async function heartbeat(
  pool: Pool,
  jobId: string,
  worker: string,
  leaseMs: number,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update core.jobs
     set lease_until = now() + make_interval(secs => $3::double precision),
         updated_at = now()
     where id = $1::uuid and state = 'leased' and lease_owner = $2`,
    [jobId, worker, leaseMs / 1000],
  );
  return (rowCount ?? 0) > 0;
}

/** Finish a leased job. Null when the lease was lost. */
export async function completeJob(
  pool: Pool,
  jobId: string,
  worker: string,
  result?: unknown,
): Promise<Job | null> {
  const { rows } = await pool.query<JobRow>(
    `update core.jobs
     set state = 'succeeded',
         result = $3::jsonb,
         lease_owner = null,
         lease_until = null,
         last_error = null,
         updated_at = now()
     where id = $1::uuid and state = 'leased' and lease_owner = $2
     returning ${JOB_COLUMNS}`,
    [jobId, worker, result === undefined ? null : JSON.stringify(result)],
  );
  if (rows.length === 0) return null;
  const job = toJob(rows[0] as JobRow);
  await appendEvent(
    pool,
    'job.succeeded',
    { jobId: job.id, kind: job.kind, worker, attempts: job.attempts },
    job.conversationId ?? undefined,
  );
  return job;
}

export type FailInput = {
  /** False ends the job now — a permanent problem, not a flaky one. */
  retry: boolean;
  /** How long to wait before the next claim. Defaults to 1m, 5m, 25m. */
  backoffMs?: number;
  /**
   * Why this attempt failed, as the retry policy read it. Recorded on the
   * `job.failed` event — `last_error` stays the raw message, so a wave of
   * failures can still be grouped by the thing that actually broke.
   */
  classification?: { class: FailureClass; reason: string };
};

/**
 * Record a failed attempt. Retries are bounded by `max_attempts`: past it the
 * job is `failed` and waits for a human (`buddi jobs retry <id>`), never a
 * fourth silent attempt.
 */
export async function failJob(
  pool: Pool,
  jobId: string,
  worker: string,
  error: string,
  input: FailInput = { retry: true },
): Promise<Job | null> {
  // One statement: whether this was the last attempt is decided against the
  // row itself, not against a copy read a moment earlier.
  const { rows } = await pool.query<JobRow>(
    `update core.jobs
     set state = case when $3 and attempts < max_attempts then 'pending' else 'failed' end,
         last_error = $4,
         run_after = case when $3 and attempts < max_attempts
           then now() + make_interval(secs => (coalesce($5::double precision,
                ${RETRY_BASE_MS / 1000} * ${RETRY_FACTOR} ^ greatest(attempts - 1, 0))))
           else run_after end,
         lease_owner = null,
         lease_until = null,
         acknowledged_at = null,
         acknowledged_by = null,
         updated_at = now()
     where id = $1::uuid and state = 'leased' and lease_owner = $2
     returning ${JOB_COLUMNS}`,
    [jobId, worker, input.retry, error, input.backoffMs === undefined ? null : input.backoffMs / 1000],
  );
  if (rows.length === 0) return null;
  const job = toJob(rows[0] as JobRow);
  const retrying = job.state === 'pending';
  await appendEvent(
    pool,
    'job.failed',
    {
      jobId: job.id,
      kind: job.kind,
      worker,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      error,
      retrying,
      ...(retrying ? { retryAt: job.runAfter.toISOString() } : {}),
      ...(input.classification
        ? { failureClass: input.classification.class, failureReason: input.classification.reason }
        : {}),
    },
    job.conversationId ?? undefined,
  );
  return job;
}

/**
 * Park a job while something outside the queue decides — an approval, above
 * all. Nothing is held: no worker, no transaction, no open lease. The job is a
 * row until `resumeJob` puts it back.
 */
export type SuspendInput = {
  /**
   * Merged into the payload (`||`, shallow), in the same statement that parks
   * the job. This is how a run records what it is waiting on — which action,
   * which conversation to continue — so the worker that picks the job up after
   * the decision carries on without anything having been held in memory.
   */
  payloadPatch?: Record<string, unknown>;
  /**
   * Don't park after all when the payload, as it is before the patch, already
   * contains this (`@>`): what the job would wait for arrived while it was
   * being suspended (a mission's card answered before its job parked). The
   * job goes straight back on the queue instead, in the same statement, so
   * nothing can land between the check and the suspension.
   */
  wakeIf?: Record<string, unknown>;
};

export async function suspendJob(
  pool: Pool,
  jobId: string,
  worker: string,
  reason: string,
  opts: SuspendInput = {},
): Promise<Job | null> {
  const patch = opts.payloadPatch;
  const wakeIf = opts.wakeIf;
  const { rows } = await pool.query<JobRow>(
    `update core.jobs
     set state = case when $5::jsonb is not null and coalesce(payload, '{}'::jsonb) @> $5::jsonb then 'pending' else 'suspended' end,
         suspended_reason = case when $5::jsonb is not null and coalesce(payload, '{}'::jsonb) @> $5::jsonb then null else $3 end,
         run_after = case when $5::jsonb is not null and coalesce(payload, '{}'::jsonb) @> $5::jsonb then now() else run_after end,
         attempts = case when $5::jsonb is not null and coalesce(payload, '{}'::jsonb) @> $5::jsonb and attempts > 0 then attempts - 1 else attempts end,
         payload = case when $4::jsonb is null then payload else coalesce(payload, '{}'::jsonb) || $4::jsonb end,
         lease_owner = null,
         lease_until = null,
         updated_at = now()
     where id = $1::uuid and state = 'leased' and lease_owner = $2
     returning ${JOB_COLUMNS}`,
    [jobId, worker, reason, patch === undefined ? null : JSON.stringify(patch), wakeIf === undefined ? null : JSON.stringify(wakeIf)],
  );
  if (rows.length === 0) return null;
  const job = toJob(rows[0] as JobRow);
  await appendEvent(
    pool,
    'job.suspended',
    { jobId: job.id, kind: job.kind, worker, reason },
    job.conversationId ?? undefined,
  );
  if (job.state === 'pending') {
    await appendEvent(pool, 'job.resumed', { jobId: job.id, kind: job.kind, woken: 'at-suspension' }, job.conversationId ?? undefined);
  }
  return job;
}

export type ResumeInput = {
  /**
   * Merged into the payload (`||`, shallow). This is how an approval outcome
   * reaches the run that was waiting for it, without the worker having kept
   * anything in memory across the wait.
   */
  payloadPatch?: Record<string, unknown>;
  /** Don't spend another attempt on the resumed run (default: true). */
  refundAttempt?: boolean;
};

/** Put a suspended job back on the queue. */
export async function resumeJob(
  pool: Pool,
  jobId: string,
  input: ResumeInput = {},
): Promise<Job | null> {
  const patch = input.payloadPatch;
  const refund = input.refundAttempt !== false;
  const { rows } = await pool.query<JobRow>(
    `update core.jobs
     set state = 'pending',
         suspended_reason = null,
         run_after = now(),
         attempts = case when $3 and attempts > 0 then attempts - 1 else attempts end,
         payload = case when $2::jsonb is null then payload else coalesce(payload, '{}'::jsonb) || $2::jsonb end,
         updated_at = now()
     where id = $1::uuid and state = 'suspended'
     returning ${JOB_COLUMNS}`,
    [jobId, patch === undefined ? null : JSON.stringify(patch), refund],
  );
  if (rows.length === 0) return null;
  const job = toJob(rows[0] as JobRow);
  await appendEvent(
    pool,
    'job.resumed',
    { jobId: job.id, kind: job.kind, ...(patch ? { patched: Object.keys(patch) } : {}) },
    job.conversationId ?? undefined,
  );
  return job;
}

/**
 * Hand back every lease that outlived its worker.
 *
 * Attempts are left alone: the attempt was spent when the job was claimed, so a
 * process that dies mid-job cannot loop forever on the installation's behalf.
 */
export async function releaseStaleLeases(pool: Pool, now: Date): Promise<number> {
  const { rows } = await pool.query<JobRow>(
    `update core.jobs
     set state = 'pending',
         lease_owner = null,
         lease_until = null,
         last_error = coalesce(last_error, 'lease expired'),
         updated_at = now()
     where state = 'leased' and lease_until < $1::timestamptz
     returning ${JOB_COLUMNS}`,
    [now.toISOString()],
  );
  for (const row of rows) {
    const job = toJob(row);
    await appendEvent(pool, 'job.lease_expired', {
      jobId: job.id,
      kind: job.kind,
      attempts: job.attempts,
    });
  }
  return rows.length;
}

/** Why a lease is being taken back from a run that never finished. */
export const INTERRUPTED_REASON = 'interrupted by a restart';

export type InterruptScope =
  /** Every lease whose expiry passed: the holder stopped heartbeating. */
  | { expiredBy: Date }
  /**
   * Start-up recovery: every lease that expired, and every lease held by a
   * previous boot of this worker family (`holderPrefix`), whatever its expiry —
   * a restart takes seconds, the lease lasts minutes, and the process that
   * held it is gone either way.
   */
  | { expiredBy: Date; self: string; holderPrefix: string }
  /** Graceful shutdown: the leases this worker holds. */
  | { heldBy: string };

export type InterruptedJob = Job & {
  /** True when the job went back on the queue; false when it failed for the owner. */
  requeued: boolean;
  /** Non-auto tools this attempt had already called (its side effects). */
  acted: string[];
};

/**
 * Take back the leases of runs that will never report, and settle each one.
 *
 * The retry policy is the run's own record: an attempt that had not yet
 * called a tool with an effect (any tier but `auto`, or an `auto` tool marked
 * `sideEffect`, read from the `tool.called` events carrying this job's id
 * since its latest claim) and whose report was not delivered (a
 * `mission.delivered` event for its occurrence or conversation) goes
 * back on the queue — once. One that had acted, or that was already requeued
 * after an interruption, or that has no attempts left, fails with the reason in
 * `last_error`, where Activity → Jobs shows it; a mission occurrence it was
 * running is closed as failed with the same reason. Nothing is re-run that
 * might send, buy or write a second time without the owner deciding.
 *
 * Every write is fenced on the holder the candidate query saw, so a lease
 * reclaimed in between is left alone. The attempt stays spent.
 */
export async function interruptLeases(
  pool: Pool,
  scope: InterruptScope,
  detail?: string,
  opts: {
    /**
     * False when the attempt may still be running in this process (its
     * handler ignored the stop): putting it back would let the next start run
     * it beside the one still going, so it fails instead.
     */
    requeue?: boolean;
  } = {},
): Promise<InterruptedJob[]> {
  const params: unknown[] = [];
  let where: string;
  if ('heldBy' in scope) {
    params.push(scope.heldBy);
    where = 'j.lease_owner = $1';
  } else if ('self' in scope) {
    params.push(scope.expiredBy.toISOString(), scope.self, `${scope.holderPrefix}%`);
    where = `j.lease_owner is distinct from $2 and (j.lease_until < $1::timestamptz or j.lease_owner like $3)`;
  } else {
    params.push(scope.expiredBy.toISOString());
    where = 'j.lease_until < $1::timestamptz';
  }
  const { rows: candidates } = await pool.query<{
    id: string; lease_owner: string | null; attempts: number; max_attempts: number;
    acted: string[]; requeues: number;
  }>(
    `select j.id, j.lease_owner, j.attempts, j.max_attempts,
       coalesce((select array_agg(distinct a.name order by a.name) from (
          select e.payload->>'name' as name
            from core.events e
           where e.kind = 'tool.called'
             and e.payload->>'jobId' = j.id::text
             and (coalesce(e.payload->>'tier', 'gated') <> 'auto' or e.payload->>'sideEffect' = 'true')
             and e.created_at >= coalesce((select max(c.created_at) from core.events c
                  where c.kind = 'job.claimed' and c.payload->>'jobId' = j.id::text), j.created_at)
          union all
          -- An earlier version recorded calls without the job or the tier, so
          -- one of those since this claim may be this run's: count it as acted.
          select 'a tool call recorded by an earlier version'
            from core.events e
           where e.kind = 'tool.called'
             and not (e.payload ? 'tier')
             and (j.conversation_id is null or e.conversation_id is null or e.conversation_id = j.conversation_id)
             and e.created_at >= coalesce((select max(c.created_at) from core.events c
                  where c.kind = 'job.claimed' and c.payload->>'jobId' = j.id::text), j.created_at)
          union all
          select 'its report was delivered'
            from core.events e
           where e.kind = 'mission.delivered'
             and ((j.payload->>'occurrenceId' is not null and e.payload->>'occurrenceId' = j.payload->>'occurrenceId')
                  or (j.conversation_id is not null and e.conversation_id = j.conversation_id))
             and e.created_at >= coalesce((select max(c.created_at) from core.events c
                  where c.kind = 'job.claimed' and c.payload->>'jobId' = j.id::text), j.created_at)
       ) a), '{}'::text[]) as acted,
       (select count(*)::int from core.events e
         where e.kind = 'job.interrupted' and e.payload->>'jobId' = j.id::text
           and e.payload->>'requeued' = 'true') as requeues
     from core.jobs j
     where j.state = 'leased' and ${where}`,
    params,
  );

  const settled: InterruptedJob[] = [];
  const why = detail ? `${INTERRUPTED_REASON} (${detail})` : INTERRUPTED_REASON;
  for (const c of candidates) {
    const acted = c.acted.filter((name) => typeof name === 'string' && name !== '');
    const requeue = opts.requeue !== false && acted.length === 0 && c.requeues === 0 && c.attempts < c.max_attempts;
    const message = requeue
      ? `${why}; queued again`
      : opts.requeue === false && acted.length === 0
        ? `${why} while it was still running; not run again on its own, so it never runs twice at once. Retry it if it should run.`
      : acted.length > 0
        ? `${why} after it had acted (${acted.join(', ')}); not run again on its own, so nothing happens twice. Retry it if it should run.`
        : c.requeues > 0
          ? `${why} a second time; not run again on its own. Retry it if it should run.`
          : `${why} on its last attempt.`;
    const { rows } = await pool.query<JobRow>(
      `update core.jobs
       set state = case when $3 then 'pending' else 'failed' end,
           run_after = case when $3 then now() else run_after end,
           last_error = $4,
           lease_owner = null,
           lease_until = null,
           acknowledged_at = null,
           acknowledged_by = null,
           updated_at = now()
       where id = $1::uuid and state = 'leased' and lease_owner is not distinct from $2
       returning ${JOB_COLUMNS}`,
      [c.id, c.lease_owner, requeue, message],
    );
    if (rows.length === 0) continue;
    const job = toJob(rows[0] as JobRow);
    await appendEvent(
      pool,
      'job.interrupted',
      { jobId: job.id, kind: job.kind, holder: c.lease_owner, attempts: job.attempts, requeued: requeue, acted, reason: why },
      job.conversationId ?? undefined,
    );
    if (!requeue) {
      // A mission's occurrence is the run the owner sees on Missions; it closes
      // with the job rather than staying claimed for a run that will not come.
      const occurrenceId = (job.payload as { occurrenceId?: unknown } | null)?.occurrenceId;
      if (typeof occurrenceId === 'string') {
        await pool.query(
          `update core.occurrences set state = 'failed', finished_at = now(), error = $2
            where id::text = $1 and state = 'claimed'`,
          [occurrenceId, message],
        );
      }
      await appendEvent(
        pool,
        'job.failed',
        {
          jobId: job.id, kind: job.kind, worker: c.lease_owner, attempts: job.attempts,
          maxAttempts: job.maxAttempts, error: message, retrying: false,
          failureClass: 'interrupted', failureReason: why,
        },
        job.conversationId ?? undefined,
      );
    }
    settled.push({ ...job, requeued: requeue, acted });
  }
  return settled;
}

/**
 * Stop a job for good. Anything not already finished can be cancelled, and so
 * can a failed one: "failed" is the queue waiting for a human, and giving up
 * is one of the two answers a human has.
 */
export async function cancelJob(pool: Pool, jobId: string): Promise<Job | null> {
  const { rows } = await pool.query<JobRow>(
    `update core.jobs
     set state = 'cancelled',
         lease_owner = null,
         lease_until = null,
         updated_at = now()
     where id = $1::uuid and state in ('pending', 'leased', 'suspended', 'failed')
     returning ${JOB_COLUMNS}`,
    [jobId],
  );
  if (rows.length === 0) return null;
  const job = toJob(rows[0] as JobRow);
  await appendEvent(
    pool,
    'job.cancelled',
    { jobId: job.id, kind: job.kind },
    job.conversationId ?? undefined,
  );
  return job;
}

/**
 * Put a finished job back in line — `buddi jobs retry`. The attempt counter is
 * reset: a human looked at it, so the bound starts over.
 *
 * A row enqueued before the unattended profile existed carries the old cap of
 * three, which would give it six more minutes and then kill it again. Retrying
 * lifts the cap to the kind's current profile, so the owner's second chance is
 * the horizon the work should have had the first time.
 */
export async function retryJob(pool: Pool, jobId: string): Promise<Job | null> {
  const { rows } = await pool.query<JobRow>(
    `update core.jobs
     set state = 'pending',
         attempts = 0,
         max_attempts = case when kind = any($2::text[])
           then greatest(max_attempts, $3::int) else max_attempts end,
         run_after = now(),
         lease_owner = null,
         lease_until = null,
         suspended_reason = null,
         acknowledged_at = null,
         acknowledged_by = null,
         updated_at = now()
     where id = $1::uuid and state in ('failed', 'cancelled', 'suspended')
     returning ${JOB_COLUMNS}`,
    [jobId, [...UNATTENDED_JOB_KINDS], UNATTENDED_RETRY_PROFILE.maxAttempts],
  );
  if (rows.length === 0) return null;
  const job = toJob(rows[0] as JobRow);
  await appendEvent(
    pool,
    'job.enqueued',
    { jobId: job.id, kind: job.kind, requeued: true },
    job.conversationId ?? undefined,
  );
  return job;
}

export async function getJob(pool: Pool, jobId: string): Promise<Job | null> {
  const { rows } = await pool.query<JobRow>(
    `select ${JOB_COLUMNS} from core.jobs where id = $1::uuid`,
    [jobId],
  );
  return rows.length > 0 ? toJob(rows[0] as JobRow) : null;
}

export async function getJobByDedupKey(pool: Pool, dedupKey: string): Promise<Job | null> {
  const { rows } = await pool.query<JobRow>(
    `select ${JOB_COLUMNS} from core.jobs where dedup_key = $1`,
    [dedupKey],
  );
  return rows.length > 0 ? toJob(rows[0] as JobRow) : null;
}

export type ListJobsInput = {
  state?: JobState;
  kind?: string;
  limit?: number;
  /** Skip this many, for the next page. */
  offset?: number;
  /**
   * Failed jobs only: `open` is the ones still asking for the owner (the
   * footer's count), `dismissed` the ones he dismissed or that went quiet by
   * age. Omitted: both.
   */
  failed?: 'open' | 'dismissed';
  /** Leave out the dismissed failed jobs — the default view, which asks nothing of them. */
  hideDismissed?: boolean;
};

/** The inspection path: newest first, bounded. */
export async function listJobs(pool: Pool, input: ListJobsInput = {}): Promise<Job[]> {
  const failed = input.failed === 'open' ? UNACKNOWLEDGED_FAILED_SQL
    : input.failed === 'dismissed' ? ACKNOWLEDGED_FAILED_SQL
    : input.hideDismissed ? `not ${ACKNOWLEDGED_FAILED_SQL}` : 'true';
  const { rows } = await pool.query<JobRow>(
    `select ${JOB_COLUMNS} from core.jobs
     where ($1::text is null or state = $1)
       and ($2::text is null or kind = $2)
       and ${failed}
     order by created_at desc, id
     limit $3 offset $4`,
    [input.state ?? null, input.kind ?? null, Math.max(1, Math.min(input.limit ?? 50, 500)), Math.max(0, input.offset ?? 0)],
  );
  return rows.map(toJob);
}

export interface ListDeadJobsInput {
  /** Restrict to these kinds. Defaults to the unattended ones. */
  kinds?: readonly string[];
  /** Only jobs that died strictly after this instant. */
  after: Date;
  /**
   * Tie-breaker inside `after`'s millisecond. PostgreSQL timestamps retain
   * microseconds while JavaScript Date does not, so timestamp-only cursors can
   * rediscover the row that produced them. When present, ordering and paging
   * use the millisecond bucket plus this job id.
   */
  afterId?: string;
  /** Only jobs that died at or before this instant. */
  until?: Date;
  limit?: number;
}

/**
 * Work that will not happen: jobs that reached `failed` and are waiting for a
 * human, oldest death first.
 *
 * "Died at" is `updated_at` — the moment the last attempt was written off —
 * which is what a wave is grouped by, not `created_at`.
 */
export async function listDeadJobs(pool: Pool, input: ListDeadJobsInput): Promise<Job[]> {
  const kinds = [...(input.kinds ?? UNATTENDED_JOB_KINDS)];
  const { rows } = await pool.query<JobRow>(
    `select ${JOB_COLUMNS} from core.jobs
     where state = 'failed'
       and kind = any($1::text[])
       and case
             when $5::uuid is null then updated_at > $2::timestamptz
             else (date_trunc('milliseconds', updated_at), id) >
                  (date_trunc('milliseconds', $2::timestamptz), $5::uuid)
           end
       and ($3::timestamptz is null or updated_at <= $3::timestamptz)
     order by date_trunc('milliseconds', updated_at), id
     limit $4`,
    [
      kinds,
      input.after.toISOString(),
      input.until?.toISOString() ?? null,
      Math.max(1, Math.min(input.limit ?? 500, 1000)),
      input.afterId ?? null,
    ],
  );
  return rows.map(toJob);
}

/**
 * Retry every dead job matching a filter — `buddi jobs retry --all`.
 *
 * One statement rather than a loop of `retryJob` calls: an outage kills jobs in
 * waves, and the owner's answer to a wave is a wave. The event per job is still
 * written, because the queue's history is how anyone reconstructs an evening.
 */
export async function retryJobs(
  pool: Pool,
  input: {
    state?: JobState;
    kind?: string;
    limit?: number;
    /** Only these jobs (still only failed, cancelled or suspended ones). */
    ids?: readonly string[];
    /** Failed jobs only: the ones still asking, or the dismissed ones. Omitted: both. */
    failed?: 'open' | 'dismissed';
  } = {},
): Promise<Job[]> {
  const failed = input.failed === 'open' ? UNACKNOWLEDGED_FAILED_SQL : input.failed === 'dismissed' ? ACKNOWLEDGED_FAILED_SQL : 'true';
  const { rows } = await pool.query<JobRow>(
    `update core.jobs
     set state = 'pending',
         attempts = 0,
         max_attempts = case when kind = any($3::text[])
           then greatest(max_attempts, $4::int) else max_attempts end,
         run_after = now(),
         lease_owner = null,
         lease_until = null,
         suspended_reason = null,
         acknowledged_at = null,
         acknowledged_by = null,
         updated_at = now()
     where id in (
       select id from core.jobs
       where ($6::uuid[] is not null or state = coalesce($1::text, 'failed'))
         and ($6::uuid[] is null or id = any($6::uuid[]))
         and ($2::text is null or kind = $2::text)
         and state in ('failed', 'cancelled', 'suspended')
         and ${failed}
       order by updated_at
       limit $5
     )
     returning ${JOB_COLUMNS}`,
    [
      input.state ?? null,
      input.kind ?? null,
      [...UNATTENDED_JOB_KINDS],
      UNATTENDED_RETRY_PROFILE.maxAttempts,
      Math.max(1, Math.min(input.limit ?? 500, 1000)),
      input.ids ? [...input.ids] : null,
    ],
  );
  const jobs = rows.map(toJob);
  for (const job of jobs) {
    await appendEvent(
      pool,
      'job.enqueued',
      { jobId: job.id, kind: job.kind, requeued: true, bulk: true },
      job.conversationId ?? undefined,
    );
  }
  return jobs;
}

/**
 * How many jobs sit in each state — `buddi doctor` prints exactly this.
 *
 * `failed` is the failed jobs still asking for the owner: the footer's count,
 * Home's, the doctor's. The ones he dismissed, or that went quiet by age, are
 * `dismissed` — still failed, still listed under history, asking nothing.
 */
export type JobCounts = Record<JobState, number> & { dismissed: number };

export async function countJobsByState(pool: Pool): Promise<JobCounts> {
  const { rows } = await pool.query<{ state: string; n: string }>(
    `select case when ${ACKNOWLEDGED_FAILED_SQL} then 'dismissed' else state end as state,
            count(*)::text as n
       from core.jobs group by 1`,
  );
  const counts: JobCounts = {
    pending: 0,
    leased: 0,
    succeeded: 0,
    failed: 0,
    suspended: 0,
    cancelled: 0,
    dismissed: 0,
  };
  for (const row of rows) counts[row.state as keyof JobCounts] = Number(row.n);
  return counts;
}

/**
 * Dismiss failed jobs: they stop asking for the owner and stay on record.
 *
 * By ids, or every failed job still asking (`all`). Only failed jobs move;
 * one already dismissed keeps the moment it was dismissed. Returns the jobs
 * this call dismissed, so a surface can offer Undo for exactly those.
 */
export async function dismissJobs(
  pool: Pool,
  input: { ids?: readonly string[]; all?: boolean; by?: string },
): Promise<Job[]> {
  if (!input.all && (!input.ids || input.ids.length === 0)) return [];
  const { rows } = await pool.query<JobRow>(
    `update core.jobs
        set acknowledged_at = now(), acknowledged_by = $2
      where ${UNACKNOWLEDGED_FAILED_SQL}
        and ($1::uuid[] is null or id = any($1::uuid[]))
      returning ${JOB_COLUMNS}`,
    [input.all ? null : [...(input.ids ?? [])], input.by ?? 'owner'],
  );
  const jobs = rows.map(toJob);
  if (jobs.length > 0) {
    await appendEvent(pool, 'job.dismissed', { jobIds: jobs.map((j) => j.id), by: input.by ?? 'owner' });
  }
  return jobs;
}

/** Take a dismissal back (Undo): the jobs ask for the owner again. */
export async function undismissJobs(pool: Pool, ids: readonly string[]): Promise<Job[]> {
  if (ids.length === 0) return [];
  const { rows } = await pool.query<JobRow>(
    `update core.jobs
        set acknowledged_at = null, acknowledged_by = null
      where state = 'failed' and acknowledged_at is not null and id = any($1::uuid[])
      returning ${JOB_COLUMNS}`,
    [[...ids]],
  );
  const jobs = rows.map(toJob);
  if (jobs.length > 0) await appendEvent(pool, 'job.undismissed', { jobIds: jobs.map((j) => j.id) });
  return jobs;
}
