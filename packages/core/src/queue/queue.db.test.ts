/**
 * DB-backed queue tests. Skipped unless DATABASE_URL is set.
 *
 * They never touch the owner's real data: the suite creates a throwaway
 * database, runs core's migrations into it, and drops it at the end.
 *
 * What is asserted here is the whole contract the rest of the system leans on:
 * two workers never claim the same job, an expired lease is reclaimed, a worker
 * that lost its lease is told so and writes nothing, retries are bounded and
 * backed off, suspension survives as a row, a dedup key makes enqueue
 * idempotent, and a paused installation claims nothing at all.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, migrate } from '../db.js';
import { isPaused, setPaused } from './flags.js';
import {
  cancelJob,
  claimJob,
  completeJob,
  countJobsByState,
  enqueue,
  failJob,
  getJob,
  heartbeat,
  listJobs,
  releaseStaleLeases,
  resumeJob,
  retryJob,
  suspendJob,
} from './jobs.js';
import { backoffFor } from './types.js';
import { runWorker } from './worker.js';

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_queue_test_${process.pid}`;

// The database stamps `run_after` with its own `now()`, so the test clock is
// anchored a few minutes ahead of real time: everything enqueued here is due at
// T0, and `at(ms)` is still a strictly later instant.
const T0 = new Date(Date.now() + 5 * 60_000);
const at = (ms: number): Date => new Date(T0.getTime() + ms);

const LEASE_MS = 60_000;

suite('queue (postgres)', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);

    const testUrl = new URL(databaseUrl as string);
    testUrl.pathname = `/${TEST_DB}`;
    pool = createPool(testUrl.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('truncate core.jobs cascade');
    await pool.query('truncate core.events cascade');
    await setPaused(pool, false);
  });

  const events = async (kind: string): Promise<any[]> => {
    const { rows } = await pool.query(
      `select payload from core.events where kind = $1 order by created_at, id`,
      [kind],
    );
    return rows.map((r) => r.payload);
  };

  describe('enqueue', () => {
    it('puts a pending job on the queue and records it', async () => {
      const job = await enqueue(pool, { kind: 'mission-run', payload: { missionId: 'x' } });
      expect(job.state).toBe('pending');
      expect(job.attempts).toBe(0);
      expect(job.maxAttempts).toBe(3);
      expect(job.payload).toEqual({ missionId: 'x' });
      expect(await events('job.enqueued')).toHaveLength(1);
    });

    it('is idempotent on a dedup key — the second call returns the first job', async () => {
      const first = await enqueue(pool, { kind: 'mission-run', dedupKey: 'occ-1' });
      const second = await enqueue(pool, {
        kind: 'mission-run',
        dedupKey: 'occ-1',
        payload: { different: true },
      });
      expect(second.id).toBe(first.id);
      expect(second.payload).toEqual(first.payload);
      expect(await listJobs(pool, {})).toHaveLength(1);
      // Only the first enqueue is a fact; the second changed nothing.
      expect(await events('job.enqueued')).toHaveLength(1);
    });

    it('honours run_after — a job in the future is not claimable yet', async () => {
      await enqueue(pool, { kind: 'k', runAfter: at(60_000) });
      expect(await claimJob(pool, { worker: 'w', now: T0, leaseMs: LEASE_MS })).toBeNull();
      expect(await claimJob(pool, { worker: 'w', now: at(60_001), leaseMs: LEASE_MS })).not.toBeNull();
    });
  });

  describe('claiming', () => {
    it('never hands the same job to two workers', async () => {
      for (let i = 0; i < 10; i += 1) await enqueue(pool, { kind: 'k', payload: { i } });

      // Both claimers run concurrently against the same rows, interleaved.
      const claim = async (worker: string): Promise<string[]> => {
        const taken: string[] = [];
        for (;;) {
          const job = await claimJob(pool, { worker, now: T0, leaseMs: LEASE_MS });
          if (!job) break;
          taken.push(job.id);
        }
        return taken;
      };
      const [a, b] = await Promise.all([claim('worker-a'), claim('worker-b')]);

      expect(a.length + b.length).toBe(10);
      expect(new Set([...a, ...b]).size).toBe(10);
      expect(a.filter((id) => b.includes(id))).toEqual([]);
    });

    it('takes the highest priority first', async () => {
      await enqueue(pool, { kind: 'k', payload: { n: 'low' } });
      await enqueue(pool, { kind: 'k', payload: { n: 'high' }, priority: 10 });
      const job = await claimJob(pool, { worker: 'w', now: T0, leaseMs: LEASE_MS });
      expect((job?.payload as any).n).toBe('high');
    });

    it('only claims the kinds it was asked for', async () => {
      await enqueue(pool, { kind: 'mail-ingest' });
      expect(
        await claimJob(pool, { worker: 'w', kinds: ['mission-run'], now: T0, leaseMs: LEASE_MS }),
      ).toBeNull();
      expect(
        await claimJob(pool, { worker: 'w', kinds: ['mail-ingest'], now: T0, leaseMs: LEASE_MS }),
      ).not.toBeNull();
    });

    it('spends an attempt on claim, so a crash loop stays bounded', async () => {
      await enqueue(pool, { kind: 'k' });
      const job = await claimJob(pool, { worker: 'w', now: T0, leaseMs: LEASE_MS });
      expect(job?.attempts).toBe(1);
      expect(job?.leaseOwner).toBe('w');
      expect(job?.leaseUntil?.toISOString()).toBe(at(LEASE_MS).toISOString());
    });
  });

  describe('leases', () => {
    it('reclaims a job whose lease expired, attempts unchanged', async () => {
      await enqueue(pool, { kind: 'k' });
      const first = await claimJob(pool, { worker: 'dead', now: T0, leaseMs: LEASE_MS });
      expect(await claimJob(pool, { worker: 'live', now: at(1000), leaseMs: LEASE_MS })).toBeNull();

      const released = await releaseStaleLeases(pool, at(LEASE_MS + 1));
      expect(released).toBe(1);

      const back = await getJob(pool, first!.id);
      expect(back?.state).toBe('pending');
      expect(back?.attempts).toBe(1); // the dead worker's attempt is spent
      expect(back?.leaseOwner).toBeNull();

      const second = await claimJob(pool, { worker: 'live', now: at(LEASE_MS + 2), leaseMs: LEASE_MS });
      expect(second?.id).toBe(first!.id);
      expect(second?.attempts).toBe(2);
    });

    it('tells a worker that lost its lease, and refuses its writes', async () => {
      await enqueue(pool, { kind: 'k' });
      const job = await claimJob(pool, { worker: 'stale', now: T0, leaseMs: LEASE_MS });
      expect(await heartbeat(pool, job!.id, 'stale', LEASE_MS)).toBe(true);

      await releaseStaleLeases(pool, at(LEASE_MS + 1));
      await claimJob(pool, { worker: 'new-owner', now: at(LEASE_MS + 2), leaseMs: LEASE_MS });

      // Fencing: the old worker learns it is out, and nothing it does lands.
      expect(await heartbeat(pool, job!.id, 'stale', LEASE_MS)).toBe(false);
      expect(await completeJob(pool, job!.id, 'stale', { ok: true })).toBeNull();
      expect(await failJob(pool, job!.id, 'stale', 'boom')).toBeNull();
      expect(await suspendJob(pool, job!.id, 'stale', 'approval')).toBeNull();
      expect((await getJob(pool, job!.id))?.state).toBe('leased');
      expect((await getJob(pool, job!.id))?.leaseOwner).toBe('new-owner');
    });
  });

  describe('completion and retries', () => {
    it('completes with a result', async () => {
      await enqueue(pool, { kind: 'k' });
      const job = await claimJob(pool, { worker: 'w', now: T0, leaseMs: LEASE_MS });
      const done = await completeJob(pool, job!.id, 'w', { chars: 12 });
      expect(done?.state).toBe('succeeded');
      expect(done?.result).toEqual({ chars: 12 });
      expect(await events('job.succeeded')).toHaveLength(1);
    });

    it('retries with exponential backoff, then fails for good', async () => {
      await enqueue(pool, { kind: 'k' });

      const attempt = async (n: number): Promise<void> => {
        const job = await claimJob(pool, { worker: 'w', now: at(n * 3_600_000), leaseMs: LEASE_MS });
        expect(job?.attempts).toBe(n);
        const after = await failJob(pool, job!.id, 'w', `boom ${n}`, { retry: true });
        if (n < 3) {
          expect(after?.state).toBe('pending');
          const waited = after!.runAfter.getTime() - Date.now();
          // 1m then 5m — asserted as the gap from "now", loosely, since the row
          // clock is the database's.
          expect(waited).toBeGreaterThan(backoffFor(n) * 0.5);
          expect(waited).toBeLessThan(backoffFor(n) * 1.5);
        } else {
          expect(after?.state).toBe('failed');
          expect(after?.lastError).toBe('boom 3');
        }
      };

      await attempt(1);
      await attempt(2);
      await attempt(3);

      // Past max_attempts nothing else is claimed on its own.
      expect(await claimJob(pool, { worker: 'w', now: at(10 * 3_600_000), leaseMs: LEASE_MS })).toBeNull();
      const failures = await events('job.failed');
      expect(failures.map((f) => f.retrying)).toEqual([true, true, false]);
    });

    it('fails immediately when the caller says not to retry', async () => {
      await enqueue(pool, { kind: 'k' });
      const job = await claimJob(pool, { worker: 'w', now: T0, leaseMs: LEASE_MS });
      const after = await failJob(pool, job!.id, 'w', 'unknown kind', { retry: false });
      expect(after?.state).toBe('failed');
      expect(after?.attempts).toBe(1);
    });

    it('a human retry resets the attempt budget', async () => {
      await enqueue(pool, { kind: 'k' });
      const job = await claimJob(pool, { worker: 'w', now: T0, leaseMs: LEASE_MS });
      await failJob(pool, job!.id, 'w', 'boom', { retry: false });
      const again = await retryJob(pool, job!.id);
      expect(again?.state).toBe('pending');
      expect(again?.attempts).toBe(0);
    });
  });

  describe('suspension', () => {
    it('round-trips through suspended and back, carrying the outcome', async () => {
      await enqueue(pool, { kind: 'k', payload: { step: 1 } });
      const job = await claimJob(pool, { worker: 'w', now: T0, leaseMs: LEASE_MS });

      const parked = await suspendJob(pool, job!.id, 'w', 'awaiting approval a1');
      expect(parked?.state).toBe('suspended');
      expect(parked?.suspendedReason).toBe('awaiting approval a1');
      expect(parked?.leaseOwner).toBeNull();
      // Nothing is held: it is a row, and no worker picks it up meanwhile.
      expect(await claimJob(pool, { worker: 'w2', now: at(1000), leaseMs: LEASE_MS })).toBeNull();

      const back = await resumeJob(pool, job!.id, {
        payloadPatch: { approval: 'approved', actionId: 'a1' },
      });
      expect(back?.state).toBe('pending');
      expect(back?.suspendedReason).toBeNull();
      expect(back?.payload).toEqual({ step: 1, approval: 'approved', actionId: 'a1' });
      // Waiting for a human did not spend an attempt.
      expect(back?.attempts).toBe(0);

      const resumed = await claimJob(pool, { worker: 'w2', now: at(2000), leaseMs: LEASE_MS });
      expect(resumed?.id).toBe(job!.id);
      expect((resumed?.payload as any).approval).toBe('approved');
      expect(await events('job.suspended')).toHaveLength(1);
      expect(await events('job.resumed')).toHaveLength(1);
    });

    it('resuming something that was never suspended does nothing', async () => {
      const job = await enqueue(pool, { kind: 'k' });
      expect(await resumeJob(pool, job.id)).toBeNull();
    });
  });

  describe('pause', () => {
    it('blocks claims while paused and resumes cleanly', async () => {
      await enqueue(pool, { kind: 'k' });
      await setPaused(pool, true);
      expect(await isPaused(pool)).toBe(true);
      expect(await claimJob(pool, { worker: 'w', now: T0, leaseMs: LEASE_MS })).toBeNull();

      await setPaused(pool, false);
      expect(await isPaused(pool)).toBe(false);
      expect(await claimJob(pool, { worker: 'w', now: T0, leaseMs: LEASE_MS })).not.toBeNull();
      expect(await events('system.paused')).toHaveLength(1);
      expect(await events('system.resumed')).toHaveLength(1);
    });

    it('enqueueing still works while paused — work accumulates, nothing runs', async () => {
      await setPaused(pool, true);
      const job = await enqueue(pool, { kind: 'k' });
      expect(job.state).toBe('pending');
      expect(await claimJob(pool, { worker: 'w', now: T0, leaseMs: LEASE_MS })).toBeNull();
    });
  });

  describe('inspection', () => {
    it('lists and counts by state, and cancels', async () => {
      const a = await enqueue(pool, { kind: 'k1' });
      await enqueue(pool, { kind: 'k2' });
      const cancelled = await cancelJob(pool, a.id);
      expect(cancelled?.state).toBe('cancelled');

      expect((await listJobs(pool, { kind: 'k2' })).map((j) => j.kind)).toEqual(['k2']);
      expect((await listJobs(pool, { state: 'cancelled' })).map((j) => j.id)).toEqual([a.id]);
      const counts = await countJobsByState(pool);
      expect(counts.pending).toBe(1);
      expect(counts.cancelled).toBe(1);
    });
  });

  describe('runWorker', () => {
    it('runs a handler end to end, heartbeating while it works', async () => {
      await enqueue(pool, { kind: 'mission-run', payload: { missionId: 'friday-recap' } });
      const seen: string[] = [];
      const worker = runWorker({
        pool,
        worker: 'w1',
        kinds: ['mission-run'],
        now: () => new Date(),
        pollMs: 5,
        leaseMs: 5_000,
        heartbeatMs: 1_000,
        handlers: {
          'mission-run': async (job, ctx) => {
            seen.push((job.payload as any).missionId);
            expect(await ctx.heartbeat()).toBe(true);
            return { delivered: true };
          },
        },
      });

      await waitFor(async () => (await countJobsByState(pool)).succeeded === 1);
      await worker.stop();
      expect(seen).toEqual(['friday-recap']);
      const [done] = await listJobs(pool, { state: 'succeeded' });
      expect(done?.result).toEqual({ delivered: true });
    }, 20_000);

    it('suspends when the handler asks, and finishes the job when it is resumed', async () => {
      const job = await enqueue(pool, { kind: 'gated', payload: {} });
      let pass = 0;
      const worker = runWorker({
        pool,
        worker: 'w1',
        kinds: ['gated'],
        now: () => new Date(),
        pollMs: 5,
        leaseMs: 5_000,
        handlers: {
          gated: async (j) => {
            pass += 1;
            const approval = (j.payload as any).approval;
            if (!approval) return { suspended: 'awaiting approval' };
            return { sent: approval };
          },
        },
      });

      await waitFor(async () => (await getJob(pool, job.id))?.state === 'suspended');
      expect(pass).toBe(1);

      await resumeJob(pool, job.id, { payloadPatch: { approval: 'approved' } });
      await waitFor(async () => (await getJob(pool, job.id))?.state === 'succeeded');
      await worker.stop();

      expect(pass).toBe(2);
      expect((await getJob(pool, job.id))?.result).toEqual({ sent: 'approved' });
    }, 20_000);

    it('fails a job whose kind has no handler, without retrying it', async () => {
      const job = await enqueue(pool, { kind: 'nobody-handles-this' });
      const worker = runWorker({
        pool,
        worker: 'w1',
        now: () => new Date(),
        pollMs: 5,
        leaseMs: 5_000,
        handlers: {},
      });
      await waitFor(async () => (await getJob(pool, job.id))?.state === 'failed');
      await worker.stop();
      expect((await getJob(pool, job.id))?.lastError).toContain('no handler');
    }, 20_000);

    it('retries a throwing handler and stops at max_attempts', async () => {
      const job = await enqueue(pool, { kind: 'flaky', maxAttempts: 2 });
      const worker = runWorker({
        pool,
        worker: 'w1',
        kinds: ['flaky'],
        now: () => new Date(),
        pollMs: 5,
        leaseMs: 5_000,
        handlers: {
          flaky: async () => {
            throw new Error('upstream said no');
          },
        },
        onError: () => {},
      });
      // Backoff is real time, so only the first attempt happens promptly; the
      // point under test is that it does not spin. Wait for the state *after*
      // the first failure — `pending` alone is also the job's initial state, so
      // the attempt count is what makes the condition unambiguous under load.
      await waitFor(async () => {
        const j = await getJob(pool, job.id);
        return j?.state === 'pending' && j.attempts === 1;
      });
      await worker.stop();
      const after = await getJob(pool, job.id);
      expect(after?.attempts).toBe(1);
      expect(after?.lastError).toBe('upstream said no');
      expect(after!.runAfter.getTime()).toBeGreaterThan(Date.now());
    }, 20_000);

    it('releases stale leases at startup (Phase 1 recovery)', async () => {
      // `run_after` is supplied instead of being left to the database's own
      // `now()`: both claims below are made at the *test's* clock, so a
      // Postgres clock running a second or two ahead of Node's — the database
      // here lives in a VM — cannot turn a claim into a silent no-op. Every
      // other claim in this file is anchored at T0 for the same reason.
      const job = await enqueue(pool, {
        kind: 'mission-run',
        runAfter: new Date(Date.now() - 60_000),
      });

      // A process that died holding the lease, with the lease already over.
      const dead = await claimJob(pool, { worker: 'dead', now: new Date(), leaseMs: 1 });
      expect(dead?.id).toBe(job.id);
      expect(dead?.leaseOwner).toBe('dead');
      expect((await getJob(pool, job.id))?.state).toBe('leased');
      await new Promise((r) => setTimeout(r, 50));

      const ran: string[] = [];
      const worker = runWorker({
        pool,
        worker: 'fresh',
        kinds: ['mission-run'],
        now: () => new Date(),
        pollMs: 5,
        leaseMs: 5_000,
        handlers: { 'mission-run': async (j) => { ran.push(j.id); return null; } },
      });
      // `succeeded` is terminal and reachable from `leased` only by way of
      // `pending`, so the wait is unambiguous: nothing else could have run it.
      await waitFor(async () => (await getJob(pool, job.id))?.state === 'succeeded');
      await worker.stop();

      expect(ran).toEqual([job.id]);
      const after = await getJob(pool, job.id);
      expect(after?.leaseOwner).toBeNull();
      // The dead worker's attempt stays spent — recovery is not a refund — so
      // the finished job carries one attempt for the process that died and one
      // for the process that picked the work back up.
      expect(after?.attempts).toBe(2);
      // And recovery is recorded as a fact, once, for the job that was stranded.
      expect(await events('job.lease_expired')).toEqual([
        { jobId: job.id, kind: 'mission-run', attempts: 1 },
      ]);
    }, 20_000);
  });
});

/** Poll a condition; the worker loop is asynchronous by design. */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
