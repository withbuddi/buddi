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
 *  - `releaseStaleLeases` is startup recovery *and* the running sweep — a lease
 *    that outlived its process goes back to `pending` with its attempt spent.
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
  JOB_COLUMNS,
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
};

export async function suspendJob(
  pool: Pool,
  jobId: string,
  worker: string,
  reason: string,
  opts: SuspendInput = {},
): Promise<Job | null> {
  const patch = opts.payloadPatch;
  const { rows } = await pool.query<JobRow>(
    `update core.jobs
     set state = 'suspended',
         suspended_reason = $3,
         payload = case when $4::jsonb is null then payload else coalesce(payload, '{}'::jsonb) || $4::jsonb end,
         lease_owner = null,
         lease_until = null,
         updated_at = now()
     where id = $1::uuid and state = 'leased' and lease_owner = $2
     returning ${JOB_COLUMNS}`,
    [jobId, worker, reason, patch === undefined ? null : JSON.stringify(patch)],
  );
  if (rows.length === 0) return null;
  const job = toJob(rows[0] as JobRow);
  await appendEvent(
    pool,
    'job.suspended',
    { jobId: job.id, kind: job.kind, worker, reason },
    job.conversationId ?? undefined,
  );
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

export type ListJobsInput = { state?: JobState; kind?: string; limit?: number; /** Skip this many, for the next page. */ offset?: number };

/** The inspection path: newest first, bounded. */
export async function listJobs(pool: Pool, input: ListJobsInput = {}): Promise<Job[]> {
  const { rows } = await pool.query<JobRow>(
    `select ${JOB_COLUMNS} from core.jobs
     where ($1::text is null or state = $1)
       and ($2::text is null or kind = $2)
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
  input: { state?: JobState; kind?: string; limit?: number } = {},
): Promise<Job[]> {
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
         updated_at = now()
     where id in (
       select id from core.jobs
       where state = coalesce($1::text, 'failed')
         and ($2::text is null or kind = $2::text)
         and state in ('failed', 'cancelled', 'suspended')
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

/** How many jobs sit in each state — `buddi doctor` prints exactly this. */
export async function countJobsByState(pool: Pool): Promise<Record<JobState, number>> {
  const { rows } = await pool.query<{ state: JobState; n: string }>(
    `select state, count(*)::text as n from core.jobs group by state`,
  );
  const counts = {
    pending: 0,
    leased: 0,
    succeeded: 0,
    failed: 0,
    suspended: 0,
    cancelled: 0,
  } as Record<JobState, number>;
  for (const row of rows) counts[row.state] = Number(row.n);
  return counts;
}
