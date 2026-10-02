/** Row shapes for the durable queue (core migration 009). */

export const JOB_STATES = [
  'pending',
  'leased',
  'succeeded',
  'failed',
  'suspended',
  'cancelled',
] as const;

export type JobState = (typeof JOB_STATES)[number];

/** States a job never leaves on its own. */
export const TERMINAL_JOB_STATES: readonly JobState[] = ['succeeded', 'failed', 'cancelled'];

export function isJobState(value: string): value is JobState {
  return (JOB_STATES as readonly string[]).includes(value);
}

export type Job = {
  id: string;
  kind: string;
  payload: unknown;
  state: JobState;
  priority: number;
  runAfter: Date;
  attempts: number;
  maxAttempts: number;
  /** Who holds the lease, while one is held. */
  leaseOwner: string | null;
  /** When the hold expires. Past it, any worker may reclaim the job. */
  leaseUntil: Date | null;
  lastError: string | null;
  result: unknown;
  conversationId: string | null;
  dedupKey: string | null;
  suspendedReason: string | null;
  /**
   * When a failed job stopped asking for the owner: dismissed by him, or
   * quiet on its own once it is AUTO_QUIET_DAYS old. Null for every job that
   * is not failed, and for a failed one still in the footer's count.
   */
  acknowledgedAt: Date | null;
  /** `owner` when dismissed, `auto` when it went quiet by age. */
  acknowledgedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type JobRow = {
  id: string;
  kind: string;
  payload: unknown;
  state: JobState;
  priority: number;
  run_after: Date;
  attempts: number;
  max_attempts: number;
  lease_owner: string | null;
  lease_until: Date | null;
  last_error: string | null;
  result: unknown;
  conversation_id: string | null;
  dedup_key: string | null;
  suspended_reason: string | null;
  acknowledged_at: Date | null;
  acknowledged_by: string | null;
  created_at: Date;
  updated_at: Date;
};

export function toJob(row: JobRow): Job {
  return {
    id: String(row.id),
    kind: row.kind,
    payload: row.payload ?? null,
    state: row.state,
    priority: row.priority,
    runAfter: row.run_after,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    result: row.result ?? null,
    conversationId: row.conversation_id,
    dedupKey: row.dedup_key,
    suspendedReason: row.suspended_reason,
    acknowledgedAt: row.acknowledged_at ?? null,
    acknowledgedBy: row.acknowledged_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * A failed job older than this stops asking for the owner on its own: it
 * leaves the footer's count and the Jobs page's list of decisions, and stays
 * in the history. Read, not written — no sweeper has to have run.
 */
export const AUTO_QUIET_DAYS = 14;

const QUIET_BY_AGE = `updated_at < now() - interval '${AUTO_QUIET_DAYS} days'`;

/** A failed job that still asks for the owner: not dismissed, not quiet by age. */
export const UNACKNOWLEDGED_FAILED_SQL =
  `(state = 'failed' and acknowledged_at is null and not (${QUIET_BY_AGE}))`;

/** A failed job that no longer asks: dismissed, or quiet by age. */
export const ACKNOWLEDGED_FAILED_SQL =
  `(state = 'failed' and (acknowledged_at is not null or ${QUIET_BY_AGE}))`;

export const JOB_COLUMNS =
  'id, kind, payload, state, priority, run_after, attempts, max_attempts, lease_owner, ' +
  'lease_until, last_error, result, conversation_id, dedup_key, suspended_reason, ' +
  `case when state <> 'failed' then null when acknowledged_at is not null then acknowledged_at ` +
  `when ${QUIET_BY_AGE} then updated_at + interval '${AUTO_QUIET_DAYS} days' end as acknowledged_at, ` +
  `case when state <> 'failed' then null when acknowledged_at is not null then acknowledged_by ` +
  `when ${QUIET_BY_AGE} then 'auto' end as acknowledged_by, ` +
  'created_at, updated_at';

/**
 * Bounded retry with exponential backoff: 1m, 5m, 25m.
 *
 * `attempts` is the number *already* spent (it is incremented on claim), so the
 * first failure waits a minute and the third never happens — max_attempts is 3.
 */
export const RETRY_BASE_MS = 60_000;
export const RETRY_FACTOR = 5;

export function backoffFor(attempts: number, baseMs = RETRY_BASE_MS): number {
  const n = Math.max(1, attempts);
  return baseMs * RETRY_FACTOR ** (n - 1);
}
