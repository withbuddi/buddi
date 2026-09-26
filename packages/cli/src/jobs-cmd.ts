/**
 * `buddi pause` / `buddi resume` / `buddi jobs` — the queue's human interface.
 *
 * The architecture asks for two things by name: a **global pause control**, and
 * a **failed-job inspection path**. This is both, and deliberately nothing more
 * — it reads and writes core's queue through the same functions the workers
 * use, so there is no second implementation of any transition to keep in step.
 *
 * Pause is not a kill switch: a job already leased is allowed to finish rather
 * than being cut off mid-effect. What stops is *claiming*.
 */
import {
  cancelJob,
  countJobsByState,
  createPool,
  getJob,
  isPaused,
  listJobs,
  retryJob,
  retryJobs,
  setPaused,
  type Job,
  type JobState,
} from '@buddi/core';
import type { Pool } from 'pg';

/** Open the pool or say why not. The caller always closes it. */
async function withPool<T>(fn: (pool: Pool) => Promise<T>, onMissing: T): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set, so there is no database to read.');
    return onMissing;
  }
  const pool = createPool(url);
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

export async function pause(): Promise<number> {
  return withPool(async (pool) => {
    const was = await isPaused(pool);
    await setPaused(pool, true);
    const counts = await countJobsByState(pool);
    console.log(
      was
        ? 'buddi was already paused.'
        : 'buddi is paused. Nothing new will be claimed; work already running finishes.',
    );
    console.log(`  ${counts.pending} pending, ${counts.leased} still running, ${counts.suspended} suspended`);
    console.log('  resume with `buddi resume`');
    return 0;
  }, 3);
}

export async function resume(): Promise<number> {
  return withPool(async (pool) => {
    const was = await isPaused(pool);
    await setPaused(pool, false);
    const counts = await countJobsByState(pool);
    console.log(was ? 'buddi is running again.' : 'buddi was not paused.');
    console.log(`  ${counts.pending} job(s) waiting to be claimed`);
    return 0;
  }, 3);
}

/** `2026-09-13 14:05` in the local zone — job listings are read, not parsed. */
function stamp(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

export function formatJobLine(job: Job, now: Date): string {
  const bits = [
    job.id.slice(0, 8),
    job.state.padEnd(9),
    job.kind.padEnd(14),
    `try ${job.attempts}/${job.maxAttempts}`,
    stamp(job.createdAt),
  ];
  if (job.state === 'pending' && job.runAfter.getTime() > now.getTime()) {
    bits.push(`waits until ${stamp(job.runAfter)}`);
  }
  if (job.state === 'leased' && job.leaseOwner) bits.push(`held by ${job.leaseOwner}`);
  if (job.state === 'suspended' && job.suspendedReason) bits.push(`— ${job.suspendedReason}`);
  if ((job.state === 'failed' || job.state === 'pending') && job.lastError) {
    bits.push(`— ${job.lastError.split('\n')[0]}`);
  }
  return `  ${bits.join('  ')}`;
}

export interface ListJobsOptions {
  state?: JobState;
  kind?: string;
  limit?: number;
  /** One object on stdout instead of the listing. */
  json?: boolean;
}

/** One job as `buddi jobs --json` prints it. */
export function jobJson(job: Job): Record<string, unknown> {
  return {
    id: job.id,
    state: job.state,
    kind: job.kind,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    createdAt: job.createdAt.toISOString(),
    runAfter: job.runAfter.toISOString(),
    leaseOwner: job.leaseOwner ?? null,
    suspendedReason: job.suspendedReason ?? null,
    lastError: job.lastError ?? null,
  };
}

export async function jobsList(opts: ListJobsOptions = {}): Promise<number> {
  return withPool(async (pool) => {
    const counts = await countJobsByState(pool);
    const paused = await isPaused(pool);
    const jobs = await listJobs(pool, {
      ...(opts.state ? { state: opts.state } : {}),
      ...(opts.kind ? { kind: opts.kind } : {}),
      limit: opts.limit ?? 20,
    });

    if (opts.json) {
      console.log(JSON.stringify({ paused, counts, jobs: jobs.map(jobJson) }, null, 2));
      return 0;
    }
    console.log(
      `queue: ${Object.entries(counts)
        .map(([state, n]) => `${n} ${state}`)
        .join(', ')}${paused ? '   [PAUSED]' : ''}`,
    );
    if (counts.failed > 0) {
      // Say what a failed job *means*. "12 failed" is a number; "twelve pieces
      // of work that did not happen and will not happen on their own" is the
      // thing the owner needs to act on.
      console.log(
        `  ${counts.failed} job(s) gave up and will not run again on their own — ` +
          'nothing was done for them.',
      );
    }
    if (jobs.length === 0) {
      console.log(opts.state ? `  no ${opts.state} jobs` : '  no jobs');
      return 0;
    }
    const now = new Date();
    for (const job of jobs) console.log(formatJobLine(job, now));
    console.log('\n  buddi jobs retry <id> | buddi jobs cancel <id>');
    if (counts.failed > 0) console.log('  buddi jobs retry --all   run every dead job again');
    return 0;
  }, 3);
}

/** Ids may be given by their printed prefix; an ambiguous prefix is refused. */
async function resolveId(pool: Pool, idOrPrefix: string): Promise<string | null> {
  if (/^[0-9a-f-]{36}$/i.test(idOrPrefix)) return idOrPrefix;
  const { rows } = await pool.query<{ id: string }>(
    `select id::text from core.jobs where id::text like $1 limit 2`,
    [`${idOrPrefix}%`],
  );
  if (rows.length === 0) {
    console.error(`no job id starts with "${idOrPrefix}"`);
    return null;
  }
  if (rows.length > 1) {
    console.error(`"${idOrPrefix}" matches more than one job — use more characters`);
    return null;
  }
  return rows[0]?.id ?? null;
}

export async function jobsRetry(idOrPrefix: string): Promise<number> {
  return withPool(async (pool) => {
    const id = await resolveId(pool, idOrPrefix);
    if (!id) return 1;
    const job = await retryJob(pool, id);
    if (!job) {
      const current = await getJob(pool, id);
      console.error(
        current
          ? `job ${id} is ${current.state} — only failed, cancelled or suspended jobs can be retried`
          : `no job ${id}`,
      );
      return 1;
    }
    console.log(`job ${job.id} (${job.kind}) is pending again, attempts reset.`);
    return 0;
  }, 3);
}

export async function jobsCancel(idOrPrefix: string): Promise<number> {
  return withPool(async (pool) => {
    const id = await resolveId(pool, idOrPrefix);
    if (!id) return 1;
    const job = await cancelJob(pool, id);
    if (!job) {
      const current = await getJob(pool, id);
      console.error(current ? `job ${id} is already ${current.state}` : `no job ${id}`);
      return 1;
    }
    console.log(`job ${job.id} (${job.kind}) cancelled.`);
    return 0;
  }, 3);
}


export interface RetryAllOptions {
  /** Which dead state to sweep. Defaults to `failed`. */
  state?: JobState;
  kind?: string;
  limit?: number;
}

/**
 * `buddi jobs retry --all` — the owner's answer to a wave.
 *
 * An outage does not kill one job, it kills a dozen, and an inspection path
 * that makes the owner retype a dozen ids is not one. Attempts are reset and,
 * for unattended kinds, the attempt cap is lifted to the current profile: the
 * second chance gets the horizon the work should have had the first time.
 */
export async function jobsRetryAll(opts: RetryAllOptions = {}): Promise<number> {
  return withPool(async (pool) => {
    const jobs = await retryJobs(pool, {
      state: opts.state ?? 'failed',
      ...(opts.kind ? { kind: opts.kind } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
    });
    if (jobs.length === 0) {
      console.log(`no ${opts.state ?? 'failed'} jobs${opts.kind ? ` of kind ${opts.kind}` : ''} to retry.`);
      return 0;
    }
    const byKind = new Map<string, number>();
    for (const job of jobs) byKind.set(job.kind, (byKind.get(job.kind) ?? 0) + 1);
    console.log(
      `${jobs.length} job(s) are queued again: ${[...byKind]
        .map(([kind, n]) => `${n} ${kind}`)
        .join(', ')}.`,
    );
    console.log('  they run as soon as a worker picks them up — `buddi jobs` to watch.');
    return 0;
  }, 3);
}
