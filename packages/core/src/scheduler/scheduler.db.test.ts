/**
 * DB-backed scheduler tests. Skipped unless DATABASE_URL is set.
 *
 * They never touch the owner's real data: the suite creates a throwaway
 * database, runs core's migrations into it, and drops it at the end.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, migrate } from '../db.js';
import { claimNextOccurrence, finishOccurrence, listOccurrences } from './claim.js';
import { materializeOccurrences } from './materialize.js';
import { getActiveSchedule, listMissions, setSchedule, upsertMission } from './missions.js';
import { runScheduler } from './runner.js';
import type { Mission, Occurrence } from './types.js';
import { testDatabaseUrl } from '../testing/database-url.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_scheduler_test_${process.pid}`;

const at = (iso: string): Date => new Date(iso);

suite('scheduler (postgres)', () => {
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
    await pool.query('truncate core.occurrences, core.last_materialized, core.schedule_specs, core.missions cascade');
    await pool.query('truncate core.events cascade');
  });

  const mission = async (id: string): Promise<Mission> =>
    upsertMission(pool, {
      id,
      name: 'Friday recap',
      agentId: 'finance-advisor',
      prompt: 'Summarize the week.',
    });

  /** Backdate a spec so materialization has a catch-up window to work with. */
  const backdateSpec = async (
    missionId: string,
    createdAt: string,
    revision?: number,
  ): Promise<void> => {
    await pool.query(
      `update core.schedule_specs set created_at = $2
       where mission_id = $1 and ($3::int is null or revision = $3)`,
      [missionId, createdAt, revision ?? null],
    );
  };

  const states = (rows: Occurrence[]): string[] =>
    [...rows]
      .sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime())
      .map((r) => `${r.scheduledAt.toISOString()} ${r.state}`);

  describe('missions', () => {
    it('upserts and lists missions', async () => {
      await mission('m1');
      const updated = await upsertMission(pool, {
        id: 'm1',
        name: 'Renamed',
        agentId: 'finance-advisor',
        prompt: 'p',
      });
      expect(updated.name).toBe('Renamed');
      const all = await listMissions(pool);
      expect(all).toHaveLength(1);
    });

    it('creates a new revision and deactivates the old one', async () => {
      await mission('m1');
      const r1 = await setSchedule(pool, 'm1', {
        cron: '0 8 * * FRI',
        timezone: 'America/New_York',
        misfirePolicy: 'coalesce',
      });
      const r2 = await setSchedule(pool, 'm1', {
        cron: '0 9 * * FRI',
        timezone: 'America/New_York',
        misfirePolicy: 'replay-all',
      });
      expect(r1.revision).toBe(1);
      expect(r2.revision).toBe(2);
      const active = await getActiveSchedule(pool, 'm1');
      expect(active).toMatchObject({ revision: 2, cron: '0 9 * * FRI' });
      const { rows } = await pool.query(
        `select revision, active from core.schedule_specs where mission_id = 'm1' order by revision`,
      );
      expect(rows).toEqual([
        { revision: 1, active: false },
        { revision: 2, active: true },
      ]);
    });

    it('validates cron, timezone, policy and deadline', async () => {
      await mission('m1');
      await expect(
        setSchedule(pool, 'm1', { cron: 'nope', timezone: 'UTC', misfirePolicy: 'coalesce' }),
      ).rejects.toThrow(/cron/);
      await expect(
        setSchedule(pool, 'm1', { cron: '0 8 * * *', timezone: 'Mars/Olympus', misfirePolicy: 'coalesce' }),
      ).rejects.toThrow(/timezone/);
      await expect(
        setSchedule(pool, 'm1', {
          cron: '0 8 * * *',
          timezone: 'UTC',
          misfirePolicy: 'skip-after-deadline',
        }),
      ).rejects.toThrow(/deadlineMinutes/);
      await expect(
        setSchedule(pool, 'ghost', { cron: '0 8 * * *', timezone: 'UTC', misfirePolicy: 'coalesce' }),
      ).rejects.toThrow(/no such mission/);
    });
  });

  describe('materialization', () => {
    it('is idempotent: running twice produces the same rows', async () => {
      await mission('m1');
      await setSchedule(pool, 'm1', {
        cron: '0 * * * *',
        timezone: 'UTC',
        misfirePolicy: 'replay-all',
      });
      await backdateSpec('m1', '2026-09-13T00:00:00Z');

      const now = at('2026-09-13T05:30:00Z');
      const first = await materializeOccurrences(pool, now);
      expect(first).toHaveLength(5); // 01:00 .. 05:00

      const second = await materializeOccurrences(pool, now);
      expect(second).toHaveLength(0); // nothing new

      const { rows } = await pool.query(`select count(*)::int as n from core.occurrences`);
      expect(rows[0].n).toBe(5);
    });

    it('is idempotent even when the watermark is rewound', async () => {
      await mission('m1');
      await setSchedule(pool, 'm1', {
        cron: '0 * * * *',
        timezone: 'UTC',
        misfirePolicy: 'replay-all',
      });
      await backdateSpec('m1', '2026-09-13T00:00:00Z');
      const now = at('2026-09-13T05:30:00Z');
      await materializeOccurrences(pool, now);

      // Simulate a lost/rolled-back watermark; the unique key still protects us.
      await pool.query(`delete from core.last_materialized`);
      const again = await materializeOccurrences(pool, now);
      expect(again).toHaveLength(0);
      const { rows } = await pool.query(`select count(*)::int as n from core.occurrences`);
      expect(rows[0].n).toBe(5);
    });

    it('skips disabled missions and missions with no active spec', async () => {
      await mission('m1');
      await setSchedule(pool, 'm1', { cron: '0 * * * *', timezone: 'UTC', misfirePolicy: 'replay-all' });
      await backdateSpec('m1', '2026-09-13T00:00:00Z');
      await pool.query(`update core.missions set enabled = false where id = 'm1'`);
      await mission('m2'); // no schedule at all

      expect(await materializeOccurrences(pool, at('2026-09-13T05:30:00Z'))).toHaveLength(0);
    });

    it('does not backfill instants from before a new revision existed', async () => {
      await mission('m1');
      await setSchedule(pool, 'm1', { cron: '0 * * * *', timezone: 'UTC', misfirePolicy: 'replay-all' });
      await backdateSpec('m1', '2026-09-13T00:00:00Z');
      await materializeOccurrences(pool, at('2026-09-13T03:30:00Z'));

      await setSchedule(pool, 'm1', { cron: '0 * * * *', timezone: 'UTC', misfirePolicy: 'replay-all' });
      await backdateSpec('m1', '2026-09-13T03:30:00Z', 2);
      const created = await materializeOccurrences(pool, at('2026-09-13T05:30:00Z'));
      // Revision 2 was created "now-ish" in wall time, so only instants after the
      // old watermark are produced, each under revision 2.
      expect(created.every((o) => o.scheduleRevision === 2)).toBe(true);
      expect(created.map((o) => o.scheduledAt.toISOString())).toEqual([
        '2026-09-13T04:00:00.000Z',
        '2026-09-13T05:00:00.000Z',
      ]);
    });
  });

  describe('misfire policies over an 8-day sleep', () => {
    // Daily 08:00 UTC. Asleep from 2026-09-01T00:00Z, waking 2026-09-09T09:00Z.
    const asleepFrom = '2026-09-01T00:00:00Z';
    const wakeAt = at('2026-09-09T09:00:00Z');
    const expected = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(
      (d) => `2026-09-0${d}T08:00:00.000Z`,
    );

    const sleep = async (
      policy: 'replay-all' | 'coalesce' | 'latest-only' | 'skip-after-deadline',
      deadlineMinutes?: number,
    ): Promise<Occurrence[]> => {
      await mission('m1');
      await setSchedule(pool, 'm1', {
        cron: '0 8 * * *',
        timezone: 'UTC',
        misfirePolicy: policy,
        deadlineMinutes: deadlineMinutes ?? null,
      });
      await backdateSpec('m1', asleepFrom);
      return materializeOccurrences(pool, wakeAt);
    };

    it('replay-all queues every missed instant', async () => {
      const rows = await sleep('replay-all');
      expect(rows).toHaveLength(9);
      expect(states(rows)).toEqual(expected.map((t) => `${t} pending`));
    });

    it('coalesce queues only the newest and records the rest as skipped', async () => {
      const rows = await sleep('coalesce');
      expect(rows).toHaveLength(9);
      expect(states(rows)).toEqual([
        ...expected.slice(0, 8).map((t) => `${t} skipped`),
        `${expected[8]} pending`,
      ]);
    });

    it('latest-only additionally skips when work is already queued', async () => {
      await mission('m1');
      await setSchedule(pool, 'm1', {
        cron: '0 8 * * *',
        timezone: 'UTC',
        misfirePolicy: 'latest-only',
      });
      await backdateSpec('m1', asleepFrom);

      // A pending occurrence from an earlier revision is still waiting.
      await pool.query(
        `insert into core.occurrences (mission_id, schedule_revision, scheduled_at, state)
         values ('m1', 0, '2026-08-31T08:00:00Z', 'pending')`,
      );

      const rows = await materializeOccurrences(pool, wakeAt);
      expect(rows).toHaveLength(9);
      expect(rows.every((r) => r.state === 'skipped')).toBe(true);
    });

    it('latest-only behaves like coalesce when nothing is queued', async () => {
      const rows = await sleep('latest-only');
      expect(states(rows)).toEqual([
        ...expected.slice(0, 8).map((t) => `${t} skipped`),
        `${expected[8]} pending`,
      ]);
    });

    it('skip-after-deadline skips instants past their deadline only', async () => {
      // 24h deadline: only the 2026-09-09T08:00Z instant (1h old at wake) survives.
      const rows = await sleep('skip-after-deadline', 24 * 60);
      expect(states(rows)).toEqual([
        ...expected.slice(0, 8).map((t) => `${t} skipped`),
        `${expected[8]} pending`,
      ]);

      await pool.query('truncate core.occurrences, core.last_materialized, core.schedule_specs, core.missions cascade');

      // 3-day deadline: the last three instants are still inside it.
      const wide = await sleep('skip-after-deadline', 3 * 24 * 60);
      const pending = wide.filter((r) => r.state === 'pending').map((r) => r.scheduledAt.toISOString());
      expect(pending).toEqual([
        '2026-09-07T08:00:00.000Z',
        '2026-09-08T08:00:00.000Z',
        '2026-09-09T08:00:00.000Z',
      ]);
    });
  });

  describe('claiming', () => {
    const seed = async (): Promise<void> => {
      await mission('m1');
      await setSchedule(pool, 'm1', { cron: '0 * * * *', timezone: 'UTC', misfirePolicy: 'replay-all' });
      await backdateSpec('m1', '2026-09-13T00:00:00Z');
      await materializeOccurrences(pool, at('2026-09-13T05:30:00Z'));
    };

    it('claims oldest-first and refuses to hand the same row out twice', async () => {
      await seed();
      const now = at('2026-09-13T05:30:00Z');
      const a = await claimNextOccurrence(pool, now);
      const b = await claimNextOccurrence(pool, now);
      expect(a?.scheduledAt.toISOString()).toBe('2026-09-13T01:00:00.000Z');
      expect(b?.scheduledAt.toISOString()).toBe('2026-09-13T02:00:00.000Z');
      expect(a?.state).toBe('claimed');
    });

    it('does not claim occurrences scheduled in the future', async () => {
      await seed();
      const claimed = await claimNextOccurrence(pool, at('2026-09-13T00:30:00Z'));
      expect(claimed).toBeNull();
    });

    it('is exclusive under two concurrent claimers', async () => {
      await seed();
      const now = at('2026-09-13T05:30:00Z');
      const url = new URL(databaseUrl as string);
      url.pathname = `/${TEST_DB}`;
      const other = createPool(url.toString());
      try {
        const results = await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            claimNextOccurrence(i % 2 === 0 ? pool : other, now),
          ),
        );
        const ids = results.filter((r): r is Occurrence => r !== null).map((r) => r.id);
        expect(ids).toHaveLength(5); // exactly the five pending rows
        expect(new Set(ids).size).toBe(5); // and no row twice
      } finally {
        await other.end();
      }
    });

    it('finishes only claimed rows', async () => {
      await seed();
      const claimed = await claimNextOccurrence(pool, at('2026-09-13T05:30:00Z'));
      const done = await finishOccurrence(pool, claimed!.id, { state: 'succeeded' });
      expect(done?.state).toBe('succeeded');
      // A second finish is a no-op: the row is no longer claimed.
      expect(await finishOccurrence(pool, claimed!.id, { state: 'failed', error: 'x' })).toBeNull();
    });

    it('records failures with their error', async () => {
      await seed();
      const claimed = await claimNextOccurrence(pool, at('2026-09-13T05:30:00Z'));
      const done = await finishOccurrence(pool, claimed!.id, { state: 'failed', error: 'boom' });
      expect(done).toMatchObject({ state: 'failed', error: 'boom' });
    });
  });

  describe('runner', () => {
    it('materializes, executes and finishes, appending events at each step', async () => {
      await mission('m1');
      await setSchedule(pool, 'm1', { cron: '0 * * * *', timezone: 'UTC', misfirePolicy: 'replay-all' });
      await backdateSpec('m1', '2026-09-13T00:00:00Z');

      const seen: string[] = [];
      const handle = runScheduler({
        pool,
        now: () => at('2026-09-13T02:30:00Z'),
        tickMs: 60_000,
        autoStart: false,
        execute: async (occurrence, m) => {
          seen.push(`${m.id}@${occurrence.scheduledAt.toISOString()}`);
          return {};
        },
      });
      try {
        const result = await handle.tick();
        expect(result).toEqual({ materialized: 2, executed: 2 });
      } finally {
        await handle.stop();
      }

      expect(seen).toEqual(['m1@2026-09-13T01:00:00.000Z', 'm1@2026-09-13T02:00:00.000Z']);

      const rows = await listOccurrences(pool, 'm1');
      expect(rows.every((r) => r.state === 'succeeded')).toBe(true);

      const { rows: events } = await pool.query<{ kind: string; n: string }>(
        `select kind, count(*)::text as n from core.events group by kind order by kind`,
      );
      expect(Object.fromEntries(events.map((e) => [e.kind, Number(e.n)]))).toEqual({
        'occurrence.materialized': 2,
        'occurrence.claimed': 2,
        'occurrence.finished': 2,
      });
    });

    it('marks an occurrence failed when execute throws, and keeps going', async () => {
      await mission('m1');
      await setSchedule(pool, 'm1', { cron: '0 * * * *', timezone: 'UTC', misfirePolicy: 'replay-all' });
      await backdateSpec('m1', '2026-09-13T00:00:00Z');

      const errors: unknown[] = [];
      const handle = runScheduler({
        pool,
        now: () => at('2026-09-13T02:30:00Z'),
        tickMs: 60_000,
        autoStart: false,
        execute: async (occurrence) => {
          if (occurrence.scheduledAt.toISOString() === '2026-09-13T01:00:00.000Z') {
            throw new Error('agent exploded');
          }
          return {};
        },
        onError: (err) => errors.push(err),
      });
      try {
        await handle.tick();
      } finally {
        await handle.stop();
      }

      expect(errors).toHaveLength(1);
      const rows = await listOccurrences(pool, 'm1');
      expect(states(rows)).toEqual([
        '2026-09-13T01:00:00.000Z failed',
        '2026-09-13T02:00:00.000Z succeeded',
      ]);
      expect(rows.find((r) => r.state === 'failed')?.error).toBe('agent exploded');
    });

    it('records the conversation the run produced', async () => {
      await mission('m1');
      await setSchedule(pool, 'm1', { cron: '0 * * * *', timezone: 'UTC', misfirePolicy: 'coalesce' });
      await backdateSpec('m1', '2026-09-13T00:00:00Z');

      const { rows } = await pool.query<{ id: string }>(
        `insert into core.conversations (agent_id) values ('finance-advisor') returning id`,
      );
      const conversationId = rows[0]!.id;

      const handle = runScheduler({
        pool,
        now: () => at('2026-09-13T02:30:00Z'),
        tickMs: 60_000,
        autoStart: false,
        execute: async () => ({ conversationId }),
      });
      try {
        await handle.tick();
      } finally {
        await handle.stop();
      }

      const occs = await listOccurrences(pool, 'm1');
      const ran = occs.find((o) => o.state === 'succeeded');
      expect(ran?.runConversationId).toBe(conversationId);
    });

    it('stop() ends the loop', async () => {
      const handle = runScheduler({
        pool,
        now: () => new Date(),
        tickMs: 5,
        execute: async () => ({}),
      });
      await handle.stop();
      await expect(handle.done).resolves.toBeUndefined();
    });
  });
});
