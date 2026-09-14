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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const JOB_COLUMNS =
  'id, kind, payload, state, priority, run_after, attempts, max_attempts, lease_owner, ' +
  'lease_until, last_error, result, conversation_id, dedup_key, suspended_reason, ' +
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
