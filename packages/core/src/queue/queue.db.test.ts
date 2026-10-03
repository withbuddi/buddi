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
import { dismissJobs, listDeadJobs, retryJobs, undismissJobs } from './jobs.js';
import { listFailureGroups } from './failures.js';
import {
  cancelJob,
  claimJob,
  completeJob,
  countJobsByState,
  enqueue,
  failJob,
  getJob,
  heartbeat,
  interruptLeases,
  listJobs,
  releaseStaleLeases,
  resumeJob,
  retryJob,
  suspendJob,
} from './jobs.js';
import { backoffFor } from './types.js';
import { runWorker } from './worker.js';
import { testDatabaseUrl } from '../testing/database-url.js';

const databaseUrl = await testDatabaseUrl();
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
    // Resumed *before* the log is truncated, never after: `setPaused` writes a
    // `system.resumed` event when it changes anything, and a test that counts
    // those events would otherwise count the cleanup of the test before it.
    await setPaused(pool, false);
    await pool.query('truncate core.jobs cascade');
    await pool.query('truncate core.events cascade');
  });

  /** The database's clock, which is the one that stamps its own timestamps. */
  const dbNow = async (): Promise<Date> => {
    const { rows } = await pool.query<{ now: Date }>('select clock_timestamp() as now');
    return new Date(rows[0]!.now);
  };

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
      // Unattended work gets the unattended profile's cap without anybody
      // having to remember to ask for it at the call site.
      expect(job.maxAttempts).toBe(8);
      expect(job.payload).toEqual({ missionId: 'x' });
      expect(await events('job.enqueued')).toHaveLength(1);
      expect((await enqueue(pool, { kind: 'a-turn-someone-waits-on' })).maxAttempts).toBe(3);
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
          // 1m then 5m — measured against the *database's* clock, which is the
          // clock that stamped `run_after`. Measured against Node's it would be
          // a assertion about how far the container has drifted.
          const waited = after!.runAfter.getTime() - (await dbNow()).getTime();
          expect(waited).toBeGreaterThan(backoffFor(n) * 0.9);
          expect(waited).toBeLessThanOrEqual(backoffFor(n));
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

  describe('dismissing failed jobs', () => {
    /** Enqueue, claim and fail for good. */
    const dead = async (key: string, error: string): Promise<string> => {
      const job = await enqueue(pool, { kind: 'k', dedupKey: key, payload: { agentId: 'ledger' } });
      const claimed = await claimJob(pool, { worker: 'w', now: at(0), leaseMs: LEASE_MS });
      expect(claimed?.id).toBe(job.id);
      await failJob(pool, job.id, 'w', error, { retry: false });
      return job.id;
    };

    it('takes dismissed and 14-day-old failures out of the count, keeps them listed, and a new failure asks again', async () => {
      const a = await dead('a', 'boom');
      const b = await dead('b', 'boom');
      const old = await dead('old', 'boom');
      await pool.query(`update core.jobs set updated_at = now() - interval '15 days' where id = $1`, [old]);

      let counts = await countJobsByState(pool);
      expect(counts.failed).toBe(2);
      expect(counts.dismissed).toBe(1);
      const quiet = await getJob(pool, old);
      expect(quiet?.acknowledgedBy).toBe('auto');
      expect(quiet?.acknowledgedAt).toBeInstanceOf(Date);

      const done = await dismissJobs(pool, { ids: [a] });
      expect(done.map((j) => [j.id, j.acknowledgedBy])).toEqual([[a, 'owner']]);
      // Dismissing twice changes nothing and says so.
      expect(await dismissJobs(pool, { ids: [a] })).toEqual([]);
      counts = await countJobsByState(pool);
      expect(counts.failed).toBe(1);
      expect(counts.dismissed).toBe(2);
      expect((await listJobs(pool, { state: 'failed' })).map((j) => j.id).sort()).toEqual([a, b, old].sort());
      expect((await listJobs(pool, { state: 'failed', failed: 'open' })).map((j) => j.id)).toEqual([b]);
      expect((await listJobs(pool, { hideDismissed: true })).map((j) => j.id)).toEqual([b]);
      expect((await events('job.dismissed'))[0]).toMatchObject({ jobIds: [a], by: 'owner' });

      expect((await undismissJobs(pool, [a])).map((j) => j.id)).toEqual([a]);
      expect((await countJobsByState(pool)).failed).toBe(2);

      expect((await dismissJobs(pool, { all: true })).map((j) => j.id).sort()).toEqual([a, b].sort());
      expect((await countJobsByState(pool)).failed).toBe(0);

      // A retry clears the dismissal; failing again asks again.
      const [again] = await retryJobs(pool, { ids: [a] });
      expect(again?.acknowledgedAt).toBeNull();
      const claimed = await claimJob(pool, { worker: 'w', now: at(1000), leaseMs: LEASE_MS });
      expect(claimed?.id).toBe(a);
      await failJob(pool, a, 'w', 'boom again', { retry: false });
      expect((await getJob(pool, a))?.acknowledgedAt).toBeNull();
      expect((await countJobsByState(pool)).failed).toBe(1);
    });

    it('retry --all leaves dismissed jobs alone', async () => {
      const a = await dead('a', 'boom');
      const b = await dead('b', 'boom');
      await dismissJobs(pool, { ids: [b] });
      expect((await retryJobs(pool, { state: 'failed', failed: 'open' })).map((j) => j.id)).toEqual([a]);
      expect((await getJob(pool, b))?.state).toBe('failed');
    });

    it('groups failures by cause, with the agent and the reason the policy recorded', async () => {
      await dead('q1', 'You exceeded your current quota. https://ai.google.dev/gemini-api/docs/rate-limits');
      await dead('q2', 'You exceeded your current quota. https://ai.google.dev/gemini-api/docs/rate-limits');
      await dead('s', 'Function call is missing a thought_signature in functionCall parts.');
      const groups = await listFailureGroups(pool, { which: 'open', now: new Date() });
      expect(groups.map((g) => [g.key, g.count]).sort()).toEqual([['gemini-quota', 2], ['gemini-thought-signature', 1]]);
      expect(groups.every((g) => g.agentIds.join() === 'ledger')).toBe(true);
      expect(await listFailureGroups(pool, { which: 'dismissed', now: new Date() })).toEqual([]);
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
      expect(after!.runAfter.getTime()).toBeGreaterThan((await dbNow()).getTime());
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
      expect(await events('job.interrupted')).toEqual([
        { jobId: job.id, kind: 'mission-run', holder: 'dead', attempts: 1, requeued: true, acted: [], reason: 'interrupted by a restart' },
      ]);
    }, 20_000);

    /**
     * The October 3 incident: a run mid-flight when serve restarted kept a
     * lease minutes long, start-up recovery released only expired leases, and
     * the run sat "leased" until a later restart came after it lapsed.
     */
    it('settles a live lease held by a previous boot at start, whatever its expiry', async () => {
      const job = await enqueue(pool, { kind: 'mission-run', runAfter: new Date(Date.now() - 60_000) });
      const dead = await claimJob(pool, { worker: 'serve:111:oldboot', now: new Date(), leaseMs: 10 * 60_000 });
      expect(dead?.id).toBe(job.id);
      // A lease that is not this family's, still live, is someone else's run.
      const foreign = await enqueue(pool, { kind: 'other', runAfter: new Date(Date.now() - 60_000) });
      await claimJob(pool, { worker: 'cli:9', kinds: ['other'], now: new Date(), leaseMs: 10 * 60_000 });

      const ran: string[] = [];
      const worker = runWorker({
        pool, worker: 'serve:222:newboot', holderPrefix: 'serve:', kinds: ['mission-run'],
        now: () => new Date(), pollMs: 5, leaseMs: 5_000, sweepMs: 0,
        handlers: { 'mission-run': async (j) => { ran.push(j.id); return null; } },
      });
      await waitFor(async () => (await getJob(pool, job.id))?.state === 'succeeded');
      await worker.stop();

      expect(ran).toEqual([job.id]);
      expect((await events('job.interrupted')).map((e) => [e.jobId, e.holder, e.requeued]))
        .toEqual([[job.id, 'serve:111:oldboot', true]]);
      expect((await getJob(pool, foreign.id))?.state).toBe('leased');
    }, 20_000);

    it('fails, rather than requeues, a run whose handler ignored the stop and is still going', async () => {
      const job = await enqueue(pool, { kind: 'mission-run', runAfter: new Date(Date.now() - 60_000) });
      let release: () => void = () => {};
      let started = false;
      const worker = runWorker({
        pool, worker: 'serve:333:stubborn', kinds: ['mission-run'], now: () => new Date(),
        pollMs: 5, leaseMs: 5_000, sweepMs: 0, stopGraceMs: 50, recoverOnStart: false,
        handlers: { 'mission-run': () => { started = true; return new Promise<null>((r) => { release = () => r(null); }); } },
      });
      await waitFor(async () => started);
      await worker.stop();
      const after = await getJob(pool, job.id);
      expect(after?.state).toBe('failed');
      expect(after?.lastError).toMatch(/while it was still running; not run again on its own/);
      release();
    }, 20_000);

    it('fails, visibly, a restart-interrupted run that had already acted', async () => {
      const job = await enqueue(pool, { kind: 'mission-run', runAfter: new Date(Date.now() - 60_000) });
      await claimJob(pool, { worker: 'serve:111:oldboot', now: new Date(), leaseMs: 10 * 60_000 });
      // What the runtime records for each call: a read, and one with an effect.
      await pool.query(
        `insert into core.events (kind, payload) values
           ('tool.called', jsonb_build_object('name', 'web.fetch', 'tier', 'auto', 'jobId', $1::text)),
           ('tool.called', jsonb_build_object('name', 'mail.send', 'tier', 'gated', 'jobId', $1::text))`,
        [job.id],
      );

      const settled = await interruptLeases(pool, { expiredBy: new Date(), self: 'serve:222:newboot', holderPrefix: 'serve:' });
      expect(settled.map((j) => [j.id, j.requeued, j.acted])).toEqual([[job.id, false, ['mail.send']]]);
      const after = await getJob(pool, job.id);
      expect(after?.state).toBe('failed');
      expect(after?.leaseOwner).toBeNull();
      expect(after?.lastError).toMatch(/^interrupted by a restart after it had acted \(mail\.send\)/);
      // It asks for the owner: Activity → Jobs lists it among the open failures.
      expect((await listJobs(pool, { failed: 'open' })).map((j) => j.id)).toEqual([job.id]);
      expect((await events('job.failed')).at(-1)).toMatchObject({ jobId: job.id, retrying: false, failureClass: 'interrupted' });
    });

    it('fails a restart-interrupted run that had reported through an auto tool with a side effect', async () => {
      const job = await enqueue(pool, { kind: 'mission-run', runAfter: new Date(Date.now() - 60_000) });
      await claimJob(pool, { worker: 'serve:111:oldboot', now: new Date(), leaseMs: 10 * 60_000 });
      await pool.query(
        `insert into core.events (kind, payload) values
           ('tool.called', jsonb_build_object('name', 'web.fetch', 'tier', 'auto', 'jobId', $1::text)),
           ('tool.called', jsonb_build_object('name', 'mission.report', 'tier', 'auto', 'sideEffect', true, 'jobId', $1::text))`,
        [job.id],
      );

      const settled = await interruptLeases(pool, { expiredBy: new Date(), self: 'serve:222:newboot', holderPrefix: 'serve:' });
      expect(settled.map((j) => [j.id, j.requeued, j.acted])).toEqual([[job.id, false, ['mission.report']]]);
      const after = await getJob(pool, job.id);
      expect(after?.state).toBe('failed');
      expect(after?.lastError).toMatch(/^interrupted by a restart after it had acted \(mission\.report\)/);
    });

    it('fails, rather than requeues, a run interrupted across the upgrade (calls recorded without job or tier)', async () => {
      const job = await enqueue(pool, { kind: 'mission-run', runAfter: new Date(Date.now() - 60_000) });
      await claimJob(pool, { worker: 'serve:111:oldboot', now: new Date(), leaseMs: 10 * 60_000 });
      await pool.query(`insert into core.events (kind, payload) values ('tool.called', jsonb_build_object('name', 'owner.notify'))`);
      const settled = await interruptLeases(pool, { expiredBy: new Date(), self: 'serve:222:newboot', holderPrefix: 'serve:' });
      expect(settled.map((j) => [j.id, j.requeued])).toEqual([[job.id, false]]);
      expect((await getJob(pool, job.id))?.lastError).toMatch(/recorded by an earlier version/);
    });

    it('fails a restart-interrupted mission run whose report was already delivered', async () => {
      const occurrenceId = '00000000-0000-4000-8000-0000000000aa';
      const job = await enqueue(pool, { kind: 'mission-run', payload: { occurrenceId }, runAfter: new Date(Date.now() - 60_000) });
      await claimJob(pool, { worker: 'serve:111:oldboot', now: new Date(), leaseMs: 10 * 60_000 });
      await pool.query(
        `insert into core.events (kind, payload) values ('mission.delivered', jsonb_build_object('occurrenceId', $1::text))`,
        [occurrenceId],
      );

      const settled = await interruptLeases(pool, { expiredBy: new Date(), self: 'serve:222:newboot', holderPrefix: 'serve:' });
      expect(settled.map((j) => [j.id, j.requeued])).toEqual([[job.id, false]]);
      expect((await getJob(pool, job.id))?.lastError).toMatch(/after it had acted \(its report was delivered\)/);
    });

    it('sweeps a lease whose heartbeat stopped while running, and requeues it only once', async () => {
      const job = await enqueue(pool, { kind: 'mission-run', runAfter: new Date(Date.now() - 60_000) });
      await claimJob(pool, { worker: 'serve:111:wedged', now: new Date(), leaseMs: 1 });
      await new Promise((r) => setTimeout(r, 20));

      // No start-up recovery and no claiming: only the running sweep can find it.
      const worker = runWorker({
        pool, worker: 'serve:222:now', kinds: ['nothing'], recoverOnStart: false,
        now: () => new Date(), pollMs: 5, leaseMs: 5_000, sweepMs: 10, handlers: {},
      });
      await waitFor(async () => (await getJob(pool, job.id))?.state === 'pending');
      await worker.stop();
      expect((await getJob(pool, job.id))?.lastError).toBe('interrupted by a restart (its lease lapsed without a heartbeat); queued again');

      // Interrupted a second time: not a third run on its own.
      await claimJob(pool, { worker: 'serve:333:again', now: new Date(), leaseMs: 1 });
      await new Promise((r) => setTimeout(r, 20));
      const second = await interruptLeases(pool, { expiredBy: new Date() });
      expect(second.map((j) => j.requeued)).toEqual([false]);
      expect((await getJob(pool, job.id))?.state).toBe('failed');
    }, 20_000);

    it('hands its leases back on shutdown (SIGTERM) instead of leaving them for the next boot', async () => {
      const job = await enqueue(pool, { kind: 'mission-run', runAfter: new Date(Date.now() - 60_000) });
      let started!: () => void;
      const running = new Promise<void>((resolve) => { started = resolve; });
      const worker = runWorker({
        pool, worker: 'serve:444:stopping', kinds: ['mission-run'],
        now: () => new Date(), pollMs: 5, leaseMs: 60_000, sweepMs: 0,
        handlers: { 'mission-run': (_j, ctx) => new Promise((_resolve, reject) => {
          started();
          ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
        }) },
      });
      await running;
      expect((await getJob(pool, job.id))?.state).toBe('leased');
      await worker.stop();

      const after = await getJob(pool, job.id);
      expect(after?.state).toBe('pending');
      expect(after?.leaseOwner).toBeNull();
      expect(after?.lastError).toBe('interrupted by a restart (buddi was stopping); queued again');
    }, 20_000);
  });
  /**
   * The September 14 incident, in the two places it was decided: how long a
   * background job keeps trying, and what the owner can find afterwards.
   */
  describe('unattended work', () => {
    it('keeps trying long past the sixth minute, where the triage runs used to die', async () => {
      const job = await enqueue(pool, {
        kind: 'agent-run',
        payload: { agentId: 'mail-triage', prompt: 'triage' },
      });
      const worker = runWorker({
        pool,
        worker: 'w-transient',
        kinds: ['agent-run'],
        now: () => new Date(),
        pollMs: 5,
        leaseMs: 5_000,
        handlers: {
          'agent-run': async () => {
            throw new Error('fetch failed');
          },
        },
        onError: () => {},
      });
      // The backoff is real minutes, so the test pulls each retry forward
      // rather than sleeping through it. Five attempts is already two more than
      // the queue used to allow.
      //
      // `attempts` goes up when the job is leased, not when it fails, so the
      // count alone is seen while the attempt is still running; pulling
      // `run_after` forward then matches nothing and the retry waits its real
      // minutes. Each round waits for the failure itself: attempt n recorded,
      // back to pending, and put off into the future by the backoff.
      const failed = async (n: number): Promise<boolean> => {
        const { rows } = await pool.query(
          `select 1 from core.jobs
            where id = $1::uuid and attempts >= $2 and state = 'pending' and run_after > now()`,
          [job.id, n],
        );
        return rows.length > 0;
      };
      for (let n = 1; n <= 5; n += 1) {
        await waitFor(() => failed(n));
        // The last failure is left where the backoff put it — minutes away —
        // so the worker cannot lease it again between here and the read below.
        if (n === 5) break;
        const pulled = await pool.query(
          `update core.jobs set run_after = now() where id = $1::uuid and state = 'pending'`,
          [job.id],
        );
        expect(pulled.rowCount).toBe(1);
      }
      await worker.stop();
      const after = await getJob(pool, job.id);
      expect(after?.state).toBe('pending');
      expect(after?.attempts).toBe(5);
      expect(after?.maxAttempts).toBe(8);
    }, 30_000);

    it('kills a permanently broken run on the first attempt instead of chasing it for hours', async () => {
      const job = await enqueue(pool, {
        kind: 'agent-run',
        payload: { agentId: 'mail-triage', prompt: 'triage' },
      });
      const worker = runWorker({
        pool,
        worker: 'w-permanent',
        kinds: ['agent-run'],
        now: () => new Date(),
        pollMs: 5,
        leaseMs: 5_000,
        handlers: {
          'agent-run': async () => {
            // What this morning's schema bug looked like on the wire.
            throw Object.assign(new Error('tools.0.custom.input_schema is invalid'), {
              name: 'ProviderError',
              status: 400,
              type: 'invalid_request_error',
            });
          },
        },
        onError: () => {},
      });
      await waitFor(async () => (await getJob(pool, job.id))?.state === 'failed');
      await worker.stop();
      const after = await getJob(pool, job.id);
      expect(after?.attempts).toBe(1);
      const failures = await events('job.failed');
      expect(failures.at(-1)).toMatchObject({ retrying: false, failureClass: 'permanent' });
    }, 30_000);

    it('lists what died, and retries a whole wave at once', async () => {
      // `before` is read from the database, because `updated_at` is stamped by
      // the database — and every claim below is anchored at T0, like every
      // other claim in this file. Claiming at `new Date()` against a
      // `run_after` the database stamped with its own microsecond `now()` is a
      // coin toss the width of a millisecond: Node's clock is truncated to the
      // millisecond, so whenever the round trip is faster than the fraction the
      // database kept, `run_after <= now` is false and the claim is a no-op.
      const before = await dbNow();
      const dead = [];
      for (let i = 0; i < 3; i += 1) {
        const job = await enqueue(pool, {
          kind: 'agent-run',
          payload: { agentId: 'mail-triage', prompt: `triage ${i}` },
          maxAttempts: 1,
          dedupKey: `wave-${i}`,
          runAfter: T0,
        });
        const claimed = await claimJob(pool, {
          worker: 'w',
          kinds: ['agent-run'],
          now: T0,
          leaseMs: LEASE_MS,
        });
        expect(claimed?.id).toBe(job.id);
        await failJob(pool, claimed!.id, 'w', 'fetch failed', { retry: true });
        dead.push(job.id);
      }
      // Something interactive that also died, and must not be swept up.
      const other = await enqueue(pool, {
        kind: 'someones-turn',
        maxAttempts: 1,
        runAfter: T0,
      });
      const claimedOther = await claimJob(pool, {
        worker: 'w',
        kinds: ['someones-turn'],
        now: T0,
        leaseMs: LEASE_MS,
      });
      expect(claimedOther?.id).toBe(other.id);
      await failJob(pool, claimedOther!.id, 'w', 'fetch failed', { retry: true });

      const listed = await listDeadJobs(pool, { after: before });
      expect(listed.map((j) => j.id).sort()).toEqual([...dead].sort());

      // The wave retried is this test's wave, named job by job — not a count of
      // whatever else the table happens to hold.
      const retried = await retryJobs(pool, { kind: 'agent-run' });
      expect(retried.map((j) => j.id).sort()).toEqual([...dead].sort());
      for (const id of dead) {
        const job = await getJob(pool, id);
        expect(job?.state).toBe('pending');
        expect(job?.attempts).toBe(0);
        // The second chance gets the horizon the work should have had first.
        expect(job?.maxAttempts).toBe(8);
      }
      expect((await getJob(pool, other.id))?.state).toBe('failed');
      expect(await listDeadJobs(pool, { after: before })).toHaveLength(0);
    }, 30_000);

    it('does not rediscover a death whose PostgreSQL microseconds Date discarded', async () => {
      const job = await enqueue(pool, {
        kind: 'agent-run',
        payload: { agentId: 'mail-triage', prompt: 'triage precision' },
        maxAttempts: 1,
        dedupKey: 'microsecond-cursor',
        runAfter: T0,
      });
      const claimed = await claimJob(pool, {
        worker: 'w',
        kinds: ['agent-run'],
        now: T0,
        leaseMs: LEASE_MS,
      });
      expect(claimed?.id).toBe(job.id);
      await failJob(pool, job.id, 'w', 'fetch failed', { retry: false });

      // node-postgres parses this as .123Z and loses the final 456µs. A plain
      // `updated_at > cursor` therefore returns this same row forever.
      await pool.query(
        `update core.jobs set updated_at = '2026-09-17 18:18:22.123456+00' where id = $1`,
        [job.id],
      );
      const cursor = new Date('2026-09-17T18:18:22.123Z');
      expect(await listDeadJobs(pool, { after: cursor })).toHaveLength(1);
      expect(await listDeadJobs(pool, { after: cursor, afterId: job.id })).toHaveLength(0);
    });
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
