/**
 * Goals the owner measures, against a throwaway database (docs/goals.md,
 * "Metrics the owner reports" and "Frequency goals").
 *
 * The owner is the sensor here: a goal on `owner.weight` travels the same
 * approval, the same watcher and the same surfaces as a debt goal, and these
 * are the parts only a real Postgres settles — the definition and the first
 * value written only once the goal exists, `goal.record` landing on the right
 * goal from any agent, and the watcher staying quiet enough to leave on.
 *
 * Skipped unless DATABASE_URL is set; the owner's own database is untouched.
 */
import {
  ToolRegistry,
  createPool,
  decideApproval,
  ensureOwner,
  executeApproved,
  getOwnerMetric,
  latestOwnerValue,
  listGoals,
  listPendingActions,
  ownerValues,
  recentChecks,
  runMigrations,
  SENTINEL_WAKE_MISSION_ID,
  upsertMission,
  type CoreToolContext,
  type MetricDefinition,
  type PluginManifest,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGoalManifest } from './goals.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_goals_owner_test_${process.pid}`;

const TZ = 'America/New_York';
/** A Tuesday, 09:00 in New York. */
const T0 = new Date('2026-09-22T13:00:00Z');
const DAY = 24 * 60 * 60_000;
const HOLDER = 'coach';

const debt: MetricDefinition = {
  id: 'test.debt',
  description: 'A number a plugin measures.',
  unit: 'currency',
  direction: 'down',
  measure: async () => ({ value: 100, currency: 'USD', asOf: new Date() }),
};

const metricPlugin: PluginManifest = {
  name: 'test',
  version: '0.1.0',
  schema: 'core',
  migrationsDir: '',
  tools: [],
  metrics: [debt],
};

const weightDef = { slug: 'weight', label: 'Weight', unit: 'number', direction: 'down', unitLabel: 'lb' } as const;

suite('goals the owner measures (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let ctx: CoreToolContext;
  let registry: ToolRegistry;
  let now: Date;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, []);
    await ensureOwner(pool, 'owner');
    ctx = { db: pool, ownerId: 'owner', now: () => now, timezone: TZ };
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    now = T0;
    registry = new ToolRegistry();
    registry.register(metricPlugin);
    registry.register(createGoalManifest(registry));
    await pool.query('truncate core.goals cascade');
    await pool.query('truncate core.owner_metrics cascade');
    await pool.query('truncate core.approvals, core.actions cascade');
    await pool.query('truncate core.sentinel_findings, core.sentinel_runs, core.digest_items cascade');
    await pool.query('truncate core.occurrences, core.last_materialized, core.schedule_specs, core.missions cascade');
    await pool.query('truncate core.owner_notifications cascade');
    await upsertMission(pool, {
      id: SENTINEL_WAKE_MISSION_ID,
      name: 'Sentinel wake',
      agentId: 'buddi',
      prompt: 'Verify the finding.',
    });
  });

  const agentCtx = (over: Partial<CoreToolContext> = {}): CoreToolContext => ({
    ...ctx,
    agentId: HOLDER,
    ...over,
  });

  /** Propose a goal, approve it, execute it. */
  async function setGoal(input: Record<string, unknown>): Promise<{ preview: string; output: unknown }> {
    const proposed = await registry.invoke('goal.set', input, agentCtx());
    if (proposed.ok || proposed.reason !== 'approval-required') {
      throw new Error(`expected a card, got ${JSON.stringify(proposed)}`);
    }
    expect(await listPendingActions(pool, { now })).toHaveLength(1);
    await decideApproval(pool, { actionId: proposed.actionId, decision: 'approved', by: 'owner', via: 'web', now });
    const executed = await executeApproved(pool, { actionId: proposed.actionId, registry, ctx, worker: 'test', now });
    if (!executed.ok) throw new Error(`execute failed: ${JSON.stringify(executed)}`);
    return { preview: proposed.preview, output: executed.result };
  }

  /** The §8 example: 288 to 220 by December. */
  const weightGoal = (over: Record<string, unknown> = {}) =>
    setGoal({
      title: '288 to 220 by December',
      metric: { owner: weightDef },
      baseline: { value: 288 },
      target: { kind: 'absolute', value: 220 },
      deadline: '2026-12-31',
      cadence: 'weekly',
      milestones: [260, 240],
      ...over,
    });

  /** What a refused proposal says, having written nothing. */
  async function refused(input: Record<string, unknown>): Promise<string> {
    const answer = await registry.invoke('goal.set', input, agentCtx());
    if (answer.ok || answer.reason === 'approval-required') throw new Error(`expected a refusal, got ${JSON.stringify(answer)}`);
    expect(await listPendingActions(pool, { now })).toHaveLength(0);
    return JSON.stringify(answer);
  }

  /* ---------------- owner metrics ---------------- */

  it('sets a goal on a new owner metric, and the metric and its first value exist only once it is approved', async () => {
    const proposed = await registry.invoke(
      'goal.set',
      {
        title: '288 to 220 by December',
        metric: { owner: weightDef },
        baseline: { value: 288 },
        target: { kind: 'absolute', value: 220 },
        deadline: '2026-12-31',
        cadence: 'weekly',
      },
      agentCtx(),
    );
    if (proposed.ok || proposed.reason !== 'approval-required') throw new Error('expected a card');
    expect(proposed.preview).toContain('From 288 lb today to 220 lb by 2026-12-31');
    expect(proposed.preview).toContain('Measured by you, when you tell buddi');
    // A card is not a goal: nothing about the metric is written yet.
    expect(await getOwnerMetric(pool, 'weight')).toBeNull();

    await decideApproval(pool, { actionId: proposed.actionId, decision: 'approved', by: 'owner', via: 'web', now });
    const executed = await executeApproved(pool, { actionId: proposed.actionId, registry, ctx, worker: 'test', now });
    expect(executed.ok).toBe(true);

    expect(await getOwnerMetric(pool, 'weight')).toMatchObject({ unit: 'number', unitLabel: 'lb', direction: 'down' });
    const [goal] = await listGoals(pool, {});
    expect(goal).toMatchObject({ metric: 'owner.weight', baseline: { value: 288 }, params: {} });
    expect(await latestOwnerValue(pool, 'weight')).toMatchObject({ value: 288, source: 'api' });
    const [check] = await recentChecks(pool, goal?.id as string);
    expect(check).toMatchObject({ value: 288, note: 'baseline, said when the goal was set' });
  });

  it('lists owner metrics beside plugin metrics, with their source', async () => {
    await weightGoal();
    const answer = await registry.invoke('goal.metrics', {}, agentCtx());
    if (!answer.ok) throw new Error('goal.metrics');
    const listed = (answer.output as { metrics: Array<Record<string, unknown>> }).metrics;
    expect(listed.map((m) => [m.id, m.source])).toEqual([
      ['test.debt', 'plugin'],
      ['owner.weight', 'owner'],
    ]);
    expect(listed[1]).toMatchObject({ label: 'Weight', unit: 'number', unitLabel: 'lb', direction: 'down' });
  });

  it('uses an existing owner metric by id, measuring its latest value as the baseline', async () => {
    await weightGoal();
    const { preview } = await setGoal({
      title: 'Under 280 by November',
      metric: 'owner.weight',
      target: { kind: 'absolute', value: 280 },
      deadline: '2026-11-30',
      cadence: 'weekly',
    });
    expect(preview).toContain('From 288 lb today to 280 lb');
    expect(preview).not.toContain('a new metric');
    expect(await ownerValues(pool, 'weight')).toHaveLength(1);
  });

  it('refuses, before any card, what an owner metric cannot be', async () => {
    const base = {
      title: 'Weight',
      target: { kind: 'absolute', value: 220 },
      deadline: '2026-12-31',
      cadence: 'weekly',
    };
    expect(await refused({ ...base, metric: { owner: { ...weightDef, slug: 'Body_Weight' } }, baseline: { value: 288 } })).toMatch(
      /not a metric name/,
    );
    // A new metric has no number yet, so the owner has to say one.
    expect(await refused({ ...base, metric: { owner: weightDef } })).toMatch(/Ask the owner where they are today/);
    // A plugin metric is measured, never told.
    expect(await refused({ ...base, metric: 'test.debt', target: { kind: 'absolute', value: 40 }, baseline: { value: 90 } })).toMatch(
      /baseline is measured too/,
    );
    // The wrong way is refused on an owner metric as on any other.
    expect(await refused({ ...base, metric: { owner: weightDef }, baseline: { value: 200 } })).toMatch(/should go down/);

    await weightGoal();
    expect(
      await refused({ ...base, metric: { owner: { ...weightDef, direction: 'up' } }, baseline: { value: 200 } }),
    ).toMatch(/owner\.weight already exists as number \(lb\), better down/);
  });
});
