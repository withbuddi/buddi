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
  runSentinels,
  TELEGRAM_SURFACE,
  SENTINEL_WAKE_MISSION_ID,
  upsertMission,
  pageQueryContext,
  type CoreToolContext,
  type HomeBlock,
  type MetricDefinition,
  type PluginManifest,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GOALS_SENTINEL_ID, createGoalManifest, goalKey, staleWindow } from './goals.js';

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
    // The §8 example, word for word.
    expect(proposed.preview).toContain('From 288 lb today to 220 lb by 2026-12-31: 4.76 lb a week down, checked weekly');
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

  /* ---------------- goal.record ---------------- */

  /** Record through the registry, as an agent on a surface would. */
  async function record(input: Record<string, unknown>, over: Partial<CoreToolContext> = {}) {
    const answer = await registry.invoke('goal.record', input, agentCtx(over));
    if (!answer.ok) throw new Error(`goal.record: ${JSON.stringify(answer)}`);
    return answer.output as { ok: boolean; reason?: string; message?: string; pace?: string };
  }

  it('lands a value said to any agent on the goal that watches it, and answers with the pace', async () => {
    await weightGoal();
    now = new Date(T0.getTime() + 7 * DAY);
    const answer = await record(
      { metric: 'weight', value: 285, note: 'after the holidays' },
      { agentId: 'concierge', surface: TELEGRAM_SURFACE, conversationId: '0b7c7a8e-1a51-4bd7-9f7c-3a1d2f4e5a6b' },
    );
    expect(answer.ok).toBe(true);
    expect(answer.pace).toMatch(/^288 to 220 by December: 285 lb now, 4% of the way; [\d.]+ lb a week down from here reaches 220 lb by 2026-12-31\.$/);
    expect(await latestOwnerValue(pool, 'weight')).toMatchObject({
      value: 285,
      source: 'telegram',
      note: 'after the holidays',
      conversationId: '0b7c7a8e-1a51-4bd7-9f7c-3a1d2f4e5a6b',
    });
  });

  it('refuses a value far from the last one until the owner confirms it', async () => {
    await weightGoal();
    const [goal] = await listGoals(pool, {});
    const answer = await record({ goal: goal?.id, value: 28.5 });
    expect(answer).toMatchObject({ ok: false, reason: 'confirm' });
    expect(answer.message).toMatch(/28\.5 lb is a long way from the last value, 288 lb/);
    expect(await ownerValues(pool, 'weight')).toHaveLength(1);

    now = new Date(T0.getTime() + 3_600_000);
    const confirmed = await record({ goal: goal?.id, value: 150, confirmed: true });
    expect(confirmed.ok).toBe(true);
    expect(await latestOwnerValue(pool, 'weight')).toMatchObject({ value: 150 });
  });

  it('refuses a number a plugin measures, a date that has not happened, and naming both', async () => {
    await weightGoal();
    expect(await record({ metric: 'test.debt', value: 90 })).toMatchObject({ reason: 'not-owner-metric' });
    expect(await record({ metric: 'weight', value: 287, asOf: '2027-01-02' })).toMatchObject({ reason: 'as-of-future' });
    const [goal] = await listGoals(pool, {});
    expect(await record({ goal: goal?.id, metric: 'weight', value: 287 })).toMatchObject({ reason: 'name-one' });
    // "This morning", written as today's date before nine, is still today.
    now = new Date('2026-09-22T11:00:00Z');
    expect((await record({ metric: 'weight', value: 287, asOf: '2026-09-22' })).ok).toBe(true);
  });

  /* ---------------- the watcher ---------------- */

  const tick = (at: Date) => runSentinels(pool, registry.manifests(), at, TZ, () => undefined, 'owner');

  /** The wake occurrences, oldest first. */
  async function wakes(): Promise<Array<{ key: string; notify?: { urgency?: string; dedupeKey?: string } }>> {
    const { rows } = await pool.query<{ payload: { finding: { key: string; notify?: { urgency?: string; dedupeKey?: string } } } }>(
      `select payload from core.occurrences where mission_id = $1 order by scheduled_at`,
      [SENTINEL_WAKE_MISSION_ID],
    );
    return rows.map((row) => row.payload.finding);
  }

  it('checks a new value within the hour, and records nothing for a cadence the owner said nothing in', async () => {
    await weightGoal();
    const [goal] = await listGoals(pool, {});
    const id = goal?.id as string;
    // A week on, nothing new: the cadence is due but there is nothing to check.
    await tick(new Date(T0.getTime() + 7 * DAY));
    expect(await recentChecks(pool, id, 10)).toHaveLength(1);
    // The owner says a number; the next tick takes it.
    now = new Date(T0.getTime() + 8 * DAY);
    await record({ metric: 'weight', value: 285 });
    await tick(new Date(T0.getTime() + 8 * DAY + 3_600_000));
    const checks = await recentChecks(pool, id, 10);
    expect(checks.map((c) => c.value)).toEqual([285, 288]);
    // And no second check inside the same week, however many values arrive.
    now = new Date(T0.getTime() + 9 * DAY);
    await record({ metric: 'weight', value: 284 });
    await tick(new Date(T0.getTime() + 9 * DAY + 3_600_000));
    expect(await recentChecks(pool, id, 10)).toHaveLength(2);
  });

  it('says "not told this week" once per cadence, as today, and never as not measurable', async () => {
    await weightGoal();
    const [goal] = await listGoals(pool, {});
    const id = goal?.id as string;

    await tick(new Date(T0.getTime() + 6 * DAY));
    expect(await wakes()).toHaveLength(0);

    // A week with nothing said: one wake, carrying the end-of-day urgency.
    const window1 = staleWindow(T0, new Date(T0.getTime() + 7 * DAY + 3_600_000), 'weekly', TZ) as string;
    expect(window1).toBe('2026-09-29');
    for (let h = 1; h <= 30; h += 1) await tick(new Date(T0.getTime() + 7 * DAY + h * 3_600_000));
    expect(await wakes()).toEqual([
      expect.objectContaining({
        key: goalKey(id, 'stale.2026-09-29'),
        notify: { urgency: 'today', dedupeKey: `goal:${id}:stale:2026-09-29` },
      }),
    ]);

    // The owner answers: the finding resolves and nothing else is said.
    now = new Date(T0.getTime() + 9 * DAY);
    await record({ metric: 'weight', value: 286 });
    await tick(new Date(T0.getTime() + 9 * DAY + 3_600_000));
    const { rows } = await pool.query(
      `select key, resolved_at from core.sentinel_findings where sentinel_id = $1 order by first_seen_at`,
      [GOALS_SENTINEL_ID],
    );
    expect(rows.map((r) => [r.key, r.resolved_at !== null])).toEqual([[goalKey(id, 'stale.2026-09-29'), true]]);

    // Two more silent weeks: one wake each, in their own windows, and no
    // "not measurable" ever — for the owner's number that is the same silence.
    for (let d = 10; d <= 24; d += 1) await tick(new Date(T0.getTime() + d * DAY));
    const keys = (await wakes()).map((w) => w.key);
    expect(keys).toEqual([
      goalKey(id, 'stale.2026-09-29'),
      goalKey(id, 'stale.2026-10-08'),
      goalKey(id, 'stale.2026-10-15'),
    ]);
    const { rows: all } = await pool.query(`select key from core.sentinel_findings where key like $1`, [`goal.${id}.not-measurable`]);
    expect(all).toHaveLength(0);
  });

  /* ---------------- frequency goals ---------------- */

  const runsDef = { slug: 'runs', label: 'Runs', unit: 'count', direction: 'up' } as const;

  /** Run twice a week until Sunday 1 November; a streak of two is a milestone. */
  const runGoal = () =>
    setGoal({
      title: 'Run twice a week',
      metric: { owner: runsDef },
      target: { kind: 'frequency', count: 2, per: 'week' },
      deadline: '2026-11-01',
      cadence: 'weekly',
      milestones: [2],
    });

  /** 10:00 in New York on a local day. */
  const localTen = (day: string) => new Date(`${day}T14:00:00Z`);

  it('sets a frequency goal on an owner metric, and refuses one a plugin would measure', async () => {
    const { preview } = await runGoal();
    expect(preview).toContain('twice a week until 2026-11-01, checked weekly, held by @coach');
    expect(preview).toContain('Milestones you will hear about, once each: 2 weeks in a row.');
    const [goal] = await listGoals(pool, {});
    expect(goal).toMatchObject({ target: { kind: 'frequency', count: 2, per: 'week' }, baseline: { value: 0 } });
    expect(await ownerValues(pool, 'runs')).toHaveLength(0);

    const base = { title: 'x', deadline: '2026-11-01', cadence: 'weekly' };
    expect(
      await refused({ ...base, metric: 'test.debt', target: { kind: 'frequency', count: 2, per: 'week' } }),
    ).toMatch(/counts the times the owner tells buddi/);
    expect(
      await refused({ ...base, metric: 'owner.runs', target: { kind: 'frequency', count: 2, per: 'week' }, milestones: [4, 2] }),
    ).toMatch(/not a streak/);

    // A goal keeps its shape: a frequency goal is not turned into a level one.
    const answer = await registry.invoke(
      'goal.update',
      { id: goal?.id, target: { kind: 'absolute', value: 3 } },
      agentCtx(),
    );
    expect(JSON.stringify(answer)).toMatch(/is a frequency goal and stays one/);
  });

  it('counts runs in Monday weeks, says a short week once, a streak once, and settles by the windows', async () => {
    await runGoal();
    const [goal] = await listGoals(pool, {});
    const id = goal?.id as string;
    const runs = new Set([
      '2026-09-24', // the week it was set: partial, not a gap
      '2026-09-29', '2026-10-01', // met
      '2026-10-05', '2026-10-07', // met: two in a row
      '2026-10-14', // short
      '2026-10-20', '2026-10-22', // met
      '2026-10-26', '2026-10-30', // met
    ]);
    let lastAnswer = '';
    for (let day = new Date('2026-09-23T12:00:00Z'); day <= new Date('2026-11-02T12:00:00Z'); day = new Date(day.getTime() + DAY)) {
      const local = day.toISOString().slice(0, 10);
      if (runs.has(local)) {
        now = new Date(`${local}T12:00:00Z`);
        lastAnswer = (await record({ metric: 'runs', value: 1 })).pace ?? '';
      }
      await tick(localTen(local));
    }
    // The last run: this week is done, and the streak restarted after the short week.
    expect(lastAnswer).toBe('Run twice a week: 2 of 2 this week, done; 1 week in a row.');

    const keys = (await wakes()).map((w) => w.key);
    expect(keys).toEqual([
      goalKey(id, 'milestone.2'),
      goalKey(id, 'short.2026-10-12'),
      goalKey(id, 'target-reached'),
    ]);
    const [settled] = await listGoals(pool, {});
    expect(settled?.state).toBe('met');
  });

  it('answers goal.status with the windows and the newest values', async () => {
    await runGoal();
    const [goal] = await listGoals(pool, {});
    for (const day of ['2026-09-29', '2026-10-01', '2026-10-06']) {
      now = new Date(`${day}T12:00:00Z`);
      await record({ goal: goal?.id, value: 1 });
    }
    now = new Date('2026-10-07T12:00:00Z');
    const answer = await registry.invoke('goal.status', { id: goal?.id }, agentCtx());
    if (!answer.ok) throw new Error('goal.status');
    const [shown] = (answer.output as { goals: Array<Record<string, unknown>> }).goals;
    expect(shown).toMatchObject({
      value: 1,
      valueFormatted: '1 of 2 this week, 1 to go by 2026-10-11; 1 week in a row',
      verdict: 'on-track',
      streak: 1,
      paceNeededInWords: '1 more this week',
    });
    expect((shown?.windows as Array<{ start: string; state: string }>).map((w) => [w.start, w.state])).toEqual([
      ['2026-09-21', 'partial'],
      ['2026-09-28', 'met'],
      ['2026-10-05', 'open'],
    ]);
    expect((shown?.values as unknown[]).length).toBe(3);
  });

  /* ---------------- where it shows ---------------- */

  /** One page query, through the read-only context the route builds. */
  async function read(name: string, params: unknown = {}): Promise<any> {
    const q = registry.queries().find((one) => one.plugin === 'goal' && one.name === name);
    if (!q) throw new Error(`no query ${name}`);
    return q.produce(q.params.parse(params), pageQueryContext(ctx));
  }

  async function home(): Promise<HomeBlock | null> {
    const block = registry.home().find((b) => b.id === 'goal.goals');
    if (!block) throw new Error('no home block');
    return block.produce(pageQueryContext(ctx));
  }

  it('shows an owner metric’s own values on the page, and draws them on the canvas with the target', async () => {
    await weightGoal();
    const [goal] = await listGoals(pool, {});
    now = new Date(T0.getTime() + 7 * DAY);
    await record({ metric: 'weight', value: 285, asOf: '2026-09-29' });

    const detail = await read('goal', { id: goal?.id });
    expect(detail).toMatchObject({ shape: 'level', owned: true, baseline: '288 lb on 2026-09-22', target: '220 lb' });
    expect(detail.values.map((v: { value: string; source: string }) => [v.value, v.source])).toEqual([
      ['285 lb', 'api'],
      ['288 lb', 'api'],
    ]);
    expect(detail.windows).toEqual([]);

    const status = await registry.invoke('goal.status', { id: goal?.id }, agentCtx());
    if (!status.ok) throw new Error('goal.status');
    const chart = (status.output as { chart: { points: Array<{ value: number }>; target: number } }).chart;
    expect(chart.points.map((p) => p.value)).toEqual([288, 285]);
    expect(chart.target).toBe(220);
  });

  it('shows a frequency goal as windows met or short, on the page, the list, Home and the canvas', async () => {
    await runGoal();
    const [goal] = await listGoals(pool, {});
    for (const day of ['2026-09-29', '2026-10-01', '2026-10-06']) {
      now = new Date(`${day}T12:00:00Z`);
      await record({ goal: goal?.id, value: 1 });
    }
    now = new Date('2026-10-13T12:00:00Z');

    const detail = await read('goal', { id: goal?.id });
    expect(detail).toMatchObject({
      shape: 'frequency',
      target: 'twice a week',
      now: '0 of 2 this week, 2 to go by 2026-10-18',
      standing: 'short last week',
      verdict: 'off-track',
      projection: '1 of 2 weeks met',
    });
    expect(detail.windows.map((w: { label: string; count: string; state: string }) => [w.label, w.count, w.state])).toEqual([
      ['Week of 2026-10-12', '0 of 2', 'open'],
      ['Week of 2026-10-05', '1 of 2', 'short'],
      ['Week of 2026-09-28', '2 of 2', 'met'],
      ['Week of 2026-09-21', '0 of 2', 'partial'],
    ]);
    expect(detail.milestones).toEqual([
      { key: '2', label: '2 weeks in a row', crossed: 'not yet', crossedTone: 'neutral' },
    ]);

    const list = await read('goals');
    expect(list.goals[0]).toMatchObject({ value: '0 of 2', verdict: 'off-track', tone: 'neutral' });
    const block = await home();
    expect(block?.rows?.[0]).toMatchObject({ side: '0 of 2', sub: '0 of 2 this week, 2 to go by 2026-10-18 · short last week' });

    const status = await registry.invoke('goal.status', { id: goal?.id }, agentCtx());
    if (!status.ok) throw new Error('goal.status');
    const chart = (status.output as { chart: { points: Array<{ value: number }>; target: number; label: string } }).chart;
    expect(chart.points.map((p) => p.value)).toEqual([0, 2, 1, 0]);
    expect(chart.target).toBe(2);
    expect(chart.label).toBe('Run twice a week — twice a week until 2026-11-01');
  });
});
