/**
 * DB-backed sentinel tests. Skipped unless DATABASE_URL is set.
 *
 * They never touch the owner's real data: the suite creates a throwaway
 * database, runs core's migrations into it, and drops it at the end.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CORE_MIGRATIONS_DIR, CORE_SCHEMA, createPool, migrate } from '../db.js';
import { runScheduler } from '../scheduler/runner.js';
import { upsertMission } from '../scheduler/missions.js';
import type { PluginManifest } from '../tools.js';
import { consumeDigestItems, pendingDigestItems, renderDigest } from './digest.js';
import { getFinding, openFindings, runSentinels } from './run.js';
import { sentinelIsEnabled, sentinelSwitches, setSentinelEnabled } from './switches.js';
import {
  INFO_COOLDOWN_MS,
  SENTINEL_WAKE_MISSION_ID,
  URGENT_COOLDOWN_MS,
  type Finding,
  type Sentinel,
} from './types.js';
import { testDatabaseUrl } from '../testing/database-url.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_sentinels_test_${process.pid}`;

const T0 = new Date('2026-09-11T12:00:00Z');
const at = (ms: number): Date => new Date(T0.getTime() + ms);

/** A sentinel whose answer the test sets, run after run. */
function scripted(id: string, script: Finding[][]): Sentinel {
  let call = 0;
  return {
    id,
    description: 'test watcher',
    every: 60,
    async run() {
      const findings = script[Math.min(call, script.length - 1)] ?? [];
      call += 1;
      return findings;
    },
  };
}

function pluginWith(...sentinels: Sentinel[]): PluginManifest[] {
  return [
    {
      name: 'test',
      version: '0.0.0',
      schema: 'core',
      migrationsDir: '',
      tools: [],
      sentinels,
    },
  ];
}

const urgent: Finding = {
  key: 'finance.floor-breach:2026-10-02',
  severity: 'urgent',
  title: 'Safety floor breaks in 21 days',
  detail: 'Projected minimum 120 EUR on 2026-10-02, floor is 500 EUR.',
  agentId: 'finance-advisor',
  data: { minimum: 120, on: '2026-10-02' },
};

const info: Finding = {
  key: 'finance.subscription-jump:netflix',
  severity: 'info',
  title: 'Netflix went from 12 to 24 EUR',
  detail: 'Charged 24 EUR on 2026-09-09; the previous three months were 12 EUR.',
};

suite('sentinels (postgres)', () => {
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
    await pool.query(
      'truncate core.sentinel_findings, core.sentinel_runs, core.sentinel_switches, core.digest_items cascade',
    );
    await pool.query(
      'truncate core.occurrences, core.last_materialized, core.schedule_specs, core.missions cascade',
    );
    await pool.query('truncate core.events cascade');
  });

  const wakeMission = async (): Promise<void> => {
    await upsertMission(pool, {
      id: SENTINEL_WAKE_MISSION_ID,
      name: 'Sentinel wake',
      agentId: 'finance-advisor',
      prompt: 'Verify the finding.',
    });
  };

  const wakes = async (): Promise<{ id: string; payload: any }[]> => {
    const { rows } = await pool.query(
      `select id, payload from core.occurrences
       where mission_id = $1 order by scheduled_at`,
      [SENTINEL_WAKE_MISSION_ID],
    );
    return rows;
  };

  const events = async (kind: string): Promise<any[]> => {
    const { rows } = await pool.query(
      `select payload from core.events where kind = $1 order by created_at, id`,
      [kind],
    );
    return rows.map((r) => r.payload);
  };

  describe('an urgent finding', () => {
    it('enqueues a wake occurrence carrying the finding', async () => {
      await wakeMission();
      const manifests = pluginWith(scripted('w', [[urgent]]));

      const [outcome] = await runSentinels(pool, manifests, T0, 'UTC');

      expect(outcome).toMatchObject({ sentinelId: 'w', ran: true, findings: 1, fired: 1 });
      const queued = await wakes();
      expect(queued).toHaveLength(1);
      expect(queued[0]?.payload).toEqual({
        finding: {
          key: urgent.key,
          sentinelId: 'w',
          severity: 'urgent',
          title: urgent.title,
          detail: urgent.detail,
          agentId: 'finance-advisor',
          data: { minimum: 120, on: '2026-10-02' },
        },
      });
      const stored = await getFinding(pool, urgent.key);
      expect(stored?.cooldownUntil?.getTime()).toBe(T0.getTime() + URGENT_COOLDOWN_MS);
      expect(await events('sentinel.finding')).toMatchObject([{ fired: true }]);
    });

    it('stays quiet for the same key until the cooldown passes', async () => {
      await wakeMission();
      const manifests = pluginWith(scripted('w', [[urgent]]));

      await runSentinels(pool, manifests, T0, 'UTC');
      await runSentinels(pool, manifests, at(60_000), 'UTC'); // due again, same fact
      expect(await wakes()).toHaveLength(1);

      const after = at(URGENT_COOLDOWN_MS + 1);
      const [outcome] = await runSentinels(pool, manifests, after, 'UTC');
      expect(outcome?.fired).toBe(1);
      expect(await wakes()).toHaveLength(2);
    });

    it('does not fire — and does not burn its cooldown — with no wake mission', async () => {
      const manifests = pluginWith(scripted('w', [[urgent]]));
      const [outcome] = await runSentinels(pool, manifests, T0, 'UTC');

      expect(outcome?.fired).toBe(0);
      expect(await wakes()).toHaveLength(0);
      expect((await getFinding(pool, urgent.key))?.cooldownUntil).toBeNull();

      await wakeMission();
      await runSentinels(pool, manifests, at(60_000), 'UTC');
      expect(await wakes()).toHaveLength(1);
    });

    it('gives two findings in the same instant two distinct occurrences', async () => {
      await wakeMission();
      const second: Finding = { ...urgent, key: 'finance.floor-breach:2026-11-02' };
      await runSentinels(pool, pluginWith(scripted('w', [[urgent, second]])), T0, 'UTC');
      expect(await wakes()).toHaveLength(2);
    });
  });

  describe('an info finding', () => {
    it('goes to the digest, once, and waits there', async () => {
      const manifests = pluginWith(scripted('w', [[info]]));

      await runSentinels(pool, manifests, T0, 'UTC');
      await runSentinels(pool, manifests, at(60_000), 'UTC');

      const items = await pendingDigestItems(pool);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ findingKey: info.key, title: info.title });
      expect(await wakes()).toHaveLength(0);
      expect((await getFinding(pool, info.key))?.cooldownUntil?.getTime()).toBe(
        T0.getTime() + INFO_COOLDOWN_MS,
      );
      expect(renderDigest(items)).toContain(info.title);
    });

    it('is consumed exactly once, and stamps the finding delivered', async () => {
      await runSentinels(pool, pluginWith(scripted('w', [[info]])), T0, 'UTC');
      const items = await pendingDigestItems(pool);
      const ids = items.map((i) => i.id);

      expect(await consumeDigestItems(pool, ids, at(1000))).toBe(1);
      expect(await consumeDigestItems(pool, ids, at(2000))).toBe(0);
      expect(await pendingDigestItems(pool)).toHaveLength(0);
      expect((await getFinding(pool, info.key))?.deliveredAt).not.toBeNull();
    });
  });

  describe('resolution', () => {
    it('marks a finding resolved when the sentinel stops reporting it', async () => {
      await wakeMission();
      const manifests = pluginWith(scripted('w', [[urgent], []]));

      await runSentinels(pool, manifests, T0, 'UTC');
      const [outcome] = await runSentinels(pool, manifests, at(60_000), 'UTC');

      expect(outcome?.resolved).toBe(1);
      expect(await openFindings(pool, 'w')).toHaveLength(0);
      const resolved = await getFinding(pool, urgent.key);
      expect(resolved?.resolvedAt).not.toBeNull();
      expect(resolved?.cooldownUntil).toBeNull();
      expect(await events('sentinel.resolved')).toMatchObject([{ key: urgent.key }]);
    });

    it('speaks again immediately when a resolved fact comes back', async () => {
      await wakeMission();
      const manifests = pluginWith(scripted('w', [[urgent], [], [urgent]]));

      await runSentinels(pool, manifests, T0, 'UTC');
      await runSentinels(pool, manifests, at(60_000), 'UTC');
      await runSentinels(pool, manifests, at(120_000), 'UTC');

      expect(await wakes()).toHaveLength(2);
      expect((await getFinding(pool, urgent.key))?.resolvedAt).toBeNull();
    });
  });

  describe('the run ledger', () => {
    it('respects `every` and does not run a sentinel early', async () => {
      const manifests = pluginWith(scripted('w', [[info]]));
      await runSentinels(pool, manifests, T0, 'UTC');
      const [outcome] = await runSentinels(pool, manifests, at(30_000), 'UTC');
      expect(outcome).toMatchObject({ ran: false });
    });

    it('records a thrown error and lets the other sentinels finish', async () => {
      const boom: Sentinel = {
        id: 'boom',
        description: 'always fails',
        every: 60,
        async run() {
          throw new Error('finance schema is missing');
        },
      };
      const manifests = pluginWith(boom, scripted('w', [[info]]));

      const outcomes = await runSentinels(pool, manifests, T0, 'UTC');

      expect(outcomes[0]).toMatchObject({ sentinelId: 'boom', error: 'finance schema is missing' });
      expect(outcomes[1]).toMatchObject({ sentinelId: 'w', findings: 1, fired: 1 });
      const { rows } = await pool.query(
        `select sentinel_id, last_error from core.sentinel_runs order by sentinel_id`,
      );
      expect(rows).toMatchObject([
        { sentinel_id: 'boom', last_error: 'finance schema is missing' },
        { sentinel_id: 'w', last_error: null },
      ]);
      expect(await pendingDigestItems(pool)).toHaveLength(1);
    });
  });

  describe("the owner's switch", () => {
    it('is on for a watcher nobody has touched', async () => {
      expect(sentinelIsEnabled(await sentinelSwitches(pool), 'w')).toBe(true);
    });

    it('stops a watcher running at all', async () => {
      const manifests = pluginWith(scripted('w', [[info], [info]]));
      await setSentinelEnabled(pool, 'w', false, T0);

      const [outcome] = await runSentinels(pool, manifests, T0, 'UTC');
      expect(outcome).toMatchObject({ sentinelId: 'w', ran: false, disabled: true });
      expect(await pendingDigestItems(pool)).toHaveLength(0);
      // Nothing ran, so nothing is in the ledger either.
      const { rows } = await pool.query(`select count(*)::int as n from core.sentinel_runs`);
      expect(rows[0].n).toBe(0);
    });

    it('leaves its open findings alone rather than resolving them', async () => {
      const manifests = pluginWith(scripted('w', [[info]]));
      await runSentinels(pool, manifests, T0, 'UTC');
      expect(await openFindings(pool, 'w')).toHaveLength(1);

      await setSentinelEnabled(pool, 'w', false, at(60_000));
      await runSentinels(pool, manifests, at(120_000), 'UTC');
      const open = await openFindings(pool, 'w');
      expect(open).toHaveLength(1);
      expect(open[0]!.resolvedAt).toBeNull();
    });

    it('runs again once it is switched back on', async () => {
      const manifests = pluginWith(scripted('w', [[info]]));
      await setSentinelEnabled(pool, 'w', false, T0);
      await runSentinels(pool, manifests, T0, 'UTC');
      const back = await setSentinelEnabled(pool, 'w', true, at(60_000));
      expect(back).toMatchObject({ sentinelId: 'w', enabled: true });

      const [outcome] = await runSentinels(pool, manifests, at(120_000), 'UTC');
      expect(outcome).toMatchObject({ ran: true, findings: 1, fired: 1 });
    });
  });

  describe('the scheduler runner', () => {
    it('runs the sentinel tick on every pass, before materializing', async () => {
      const order: string[] = [];
      const scheduler = runScheduler({
        pool,
        now: () => T0,
        tickMs: 1000,
        autoStart: false,
        sentinelTick: async () => {
          order.push('sentinels');
        },
        execute: async () => ({}),
      });

      await scheduler.tick();
      await scheduler.tick();

      expect(order).toEqual(['sentinels', 'sentinels']);
    });

    it('keeps ticking when the sentinel tick itself throws', async () => {
      const errors: unknown[] = [];
      const scheduler = runScheduler({
        pool,
        now: () => T0,
        tickMs: 1000,
        autoStart: false,
        sentinelTick: async () => {
          throw new Error('sentinel runner is broken');
        },
        onError: (err) => errors.push(err),
        execute: async () => ({}),
      });

      await expect(scheduler.tick()).resolves.toMatchObject({ materialized: 0, executed: 0 });
      expect((errors[0] as Error).message).toBe('sentinel runner is broken');
    });
  });
});
