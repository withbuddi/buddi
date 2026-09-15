/**
 * The scheduler → queue handoff, against a throwaway database.
 *
 * What matters here is the ownership rule: the scheduler decides *when* and
 * enqueues; the job handler runs the mission and is the one that closes the
 * occurrence. Skipped unless DATABASE_URL is set.
 */
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  createPool,
  getJob,
  getOccurrence,
  listJobs,
  migrate,
  runWorker,
  upsertMission,
  type Mission,
  type Occurrence,
} from '@buddi/core';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertOccurrence } from './missions-cli.js';
import { createMissionJobHandler, MISSION_JOB_KIND, queueOccurrence } from './serve.js';
import type { MissionRunResult } from './missions/execute.js';
import { testDatabaseUrl } from '@buddi/core/testing';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_serve_test_${process.pid}`;

suite('scheduled missions run as queue jobs', () => {
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
    await pool.query('truncate core.occurrences, core.missions cascade');
    await pool.query('truncate core.events cascade');
  });

  const claimedOccurrence = async (): Promise<{ occurrence: Occurrence; mission: Mission }> => {
    const mission = await upsertMission(pool, {
      id: 'friday-recap',
      name: 'Friday recap',
      agentId: 'finance-advisor',
      prompt: 'Where do I stand?',
    });
    const occurrence = await insertOccurrence(pool, mission.id, 0, new Date(), 'claimed');
    return { occurrence, mission };
  };

  const result: MissionRunResult = {
    conversationId: '00000000-0000-0000-0000-000000000000',
    text: 'all clear',
    delivered: true,
    decision: 'report',
  };

  it('enqueues one job per occurrence, idempotently', async () => {
    const { occurrence, mission } = await claimedOccurrence();
    const first = await queueOccurrence(pool, occurrence, mission);
    const second = await queueOccurrence(pool, occurrence, mission);

    expect(second.id).toBe(first.id);
    expect(first.kind).toBe(MISSION_JOB_KIND);
    expect(first.dedupKey).toBe(occurrence.id);
    expect(await listJobs(pool, {})).toHaveLength(1);
    // The occurrence is still claimed: queueing is not finishing.
    expect((await getOccurrence(pool, occurrence.id))?.state).toBe('claimed');
  });

  it('the handler runs the mission and closes the occurrence', async () => {
    const { occurrence, mission } = await claimedOccurrence();
    const job = await queueOccurrence(pool, occurrence, mission);

    const ran: string[] = [];
    const handler = createMissionJobHandler({
      pool,
      execute: async (occ) => {
        ran.push(occ.id);
        return { ...result, conversationId: await conversation(pool) };
      },
      log: () => {},
    });

    const worker = runWorker({
      pool,
      worker: 'test',
      kinds: [MISSION_JOB_KIND],
      handlers: { [MISSION_JOB_KIND]: handler },
      now: () => new Date(),
      pollMs: 5,
      leaseMs: 5_000,
    });
    await waitFor(async () => (await getJob(pool, job.id))?.state === 'succeeded');
    await worker.stop();

    expect(ran).toEqual([occurrence.id]);
    const closed = await getOccurrence(pool, occurrence.id);
    expect(closed?.state).toBe('succeeded');
    expect(closed?.runConversationId).not.toBeNull();
  }, 20_000);

  it('a duplicate delivery never runs the mission twice', async () => {
    const { occurrence, mission } = await claimedOccurrence();
    const first = await queueOccurrence(pool, occurrence, mission);
    let runs = 0;
    const handler = createMissionJobHandler({
      pool,
      execute: async () => {
        runs += 1;
        return { ...result, conversationId: await conversation(pool) };
      },
      log: () => {},
    });

    const worker = runWorker({
      pool,
      worker: 'test',
      kinds: [MISSION_JOB_KIND],
      handlers: { [MISSION_JOB_KIND]: handler },
      now: () => new Date(),
      pollMs: 5,
      leaseMs: 5_000,
    });
    await waitFor(async () => (await getOccurrence(pool, occurrence.id))?.state === 'succeeded');

    // The occurrence is claimed again — a stale-claim sweep followed by a fresh
    // scheduler pass would do exactly this — and queued again. The dedup key
    // hands back the job that already finished, so the worker has nothing to
    // claim and the mission is not run a second time.
    await pool.query(`update core.occurrences set state = 'claimed' where id = $1`, [occurrence.id]);
    const again = await queueOccurrence(pool, occurrence, mission);
    expect(again.id).toBe(first.id);
    expect(again.state).toBe('succeeded');

    await new Promise((r) => setTimeout(r, 100));
    await worker.stop();
    expect(runs).toBe(1);
    expect(await listJobs(pool, {})).toHaveLength(1);
  }, 20_000);

  it('leaves the occurrence open while the job still has attempts', async () => {
    const { occurrence, mission } = await claimedOccurrence();
    const job = await queueOccurrence(pool, occurrence, mission);
    const handler = createMissionJobHandler({
      pool,
      execute: async () => {
        throw new Error('the provider said no');
      },
      log: () => {},
    });

    const worker = runWorker({
      pool,
      worker: 'test',
      kinds: [MISSION_JOB_KIND],
      handlers: { [MISSION_JOB_KIND]: handler },
      now: () => new Date(),
      pollMs: 5,
      leaseMs: 5_000,
      onError: () => {},
    });
    // Wait for the *spent* attempt, not merely for `pending`: a job is pending
    // from the moment it is enqueued, so waiting on the state alone can be
    // satisfied before the worker has claimed it once. `attempts >= 1` is the
    // proof that the handler ran and the failure was recorded.
    await waitFor(async () => {
      const current = await getJob(pool, job.id);
      return current?.state === 'pending' && current.attempts >= 1;
    });
    await worker.stop();

    const retried = await getJob(pool, job.id);
    expect(retried?.lastError).toBe('the provider said no');
    // Retries are left: the job is queued again rather than failed.
    expect(retried?.attempts).toBeLessThan(retried?.maxAttempts ?? 0);
    // Still claimed: the retry, when it comes, will find work to do.
    expect((await getOccurrence(pool, occurrence.id))?.state).toBe('claimed');
  }, 20_000);
});

/** A conversation row to point the occurrence at; the FK is real. */
async function conversation(pool: Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into core.conversations (agent_id) values ('finance-advisor') returning id::text`,
  );
  return rows[0]!.id;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
