/**
 * Goals against a throwaway database: the parts only a real Postgres settles.
 *
 * Four things that cannot be tested anywhere else:
 *
 *  - a `goal.set` travelling the whole approval machinery — describe, an
 *    immutable action, the owner's yes, `executeApproved` — and the row that
 *    comes out carrying *the baseline the owner was shown*, never a fresh one;
 *  - the budget, which is a WHERE clause: the thirteenth open goal is refused
 *    with the sentence in the spec, not by anybody's judgement;
 *  - who may write: a delegate cannot set one, and a non-holder cannot update
 *    or close one;
 *  - the watcher over a simulated six weeks with a metric whose answers are
 *    scripted — one check per cadence, urgent on the second consecutive miss,
 *    the recovery resolving it, a milestone exactly once, seven days with no
 *    number, a deadline that passes, a target that is reached.
 *
 * Skipped unless DATABASE_URL is set; the owner's own database is untouched.
 */
import {
  MAX_OPEN_GOALS,
  TOO_MANY_GOALS,
  ToolRegistry,
  createGoal,
  createPool,
  decideApproval,
  ensureOwner,
  executeApproved,
  getFinding,
  getGoal,
  listGoals,
  listPendingActions,
  recentChecks,
  runMigrations,
  runSentinels,
  settleGoal,
  updateGoal,
  SENTINEL_WAKE_MISSION_ID,
  upsertMission,
  type MetricDefinition,
  type PluginManifest,
  type CoreToolContext,
} from '@buddi/core';
import { localDateString } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGoalManifest, GOALS_SENTINEL_ID, GOAL_WAKE_INSTRUCTION, goalKey } from './goals.js';
import { FINDING_CLOSE, FINDING_OPEN, findingOf, renderFinding } from './sentinel-wake.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_goals_test_${process.pid}`;

const TZ = 'America/New_York';
const T0 = new Date('2026-09-22T13:00:00Z');
const WEEK = 7 * 24 * 60 * 60_000;
const HOUR = 3_600_000;
const HOLDER = 'ledger';

/** What the scripted metric answers next. `null` is "cannot measure now". */
let scripted: number | null = 100;

const debt: MetricDefinition = {
  id: 'test.debt',
  description: 'A number a test drives by hand.',
  unit: 'currency',
  direction: 'down',
  // `asOf: new Date()` on purpose: it is the obvious way to write a metric, and
  // it must not void an approval a second after the owner made it.
  measure: async () => (scripted === null ? null : { value: scripted, currency: 'USD', asOf: new Date() }),
};

const metricPlugin: PluginManifest = {
  name: 'test',
  version: '0.1.0',
  schema: 'core',
  migrationsDir: '',
  tools: [],
  metrics: [debt],
};

/** A registry with the scripted metric and the goal tools over it. */
function goalRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(metricPlugin);
  registry.register(createGoalManifest(registry));
  return registry;
}

suite('goals (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let ctx: CoreToolContext;
  let registry: ToolRegistry;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, []);
    await ensureOwner(pool, 'owner');
    ctx = { db: pool, ownerId: 'owner', now: () => T0, timezone: TZ };
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    scripted = 100;
    registry = goalRegistry();
    await pool.query('truncate core.goals cascade');
    await pool.query('truncate core.approvals, core.actions cascade');
    await pool.query('truncate core.sentinel_findings, core.sentinel_runs, core.digest_items cascade');
    await pool.query('truncate core.occurrences, core.last_materialized, core.schedule_specs, core.missions cascade');
    await pool.query('truncate core.events cascade');
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
    conversationId: undefined,
    ...over,
  });

  /** Propose a goal, approve it, execute it. The whole card, end to end. */
  async function setGoal(
    input: Record<string, unknown>,
    over: Partial<CoreToolContext> = {},
  ): Promise<{ preview: string; output: unknown }> {
    const proposed = await registry.invoke('goal.set', input, agentCtx(over));
    if (proposed.ok || proposed.reason !== 'approval-required') {
      throw new Error(`expected a card, got ${JSON.stringify(proposed)}`);
    }
    const pending = await listPendingActions(pool, { now: T0 });
    expect(pending).toHaveLength(1);
    await decideApproval(pool, {
      actionId: proposed.actionId,
      decision: 'approved',
      by: 'owner',
      via: 'telegram',
      now: T0,
    });
    const executed = await executeApproved(pool, {
      actionId: proposed.actionId,
      registry,
      ctx,
      worker: 'test',
      now: T0,
    });
    if (!executed.ok) throw new Error(`execute failed: ${JSON.stringify(executed)}`);
    return { preview: proposed.preview, output: executed.result };
  }

  /** A goal with nothing interesting about it, for the tests that count rows. */
  const plainGoal = () => ({
    title: 'a goal',
    agentId: HOLDER,
    metric: 'test.debt',
    target: { kind: 'absolute' as const, value: 0 },
    baseline: { value: 100, asOf: T0 },
    deadline: new Date(T0.getTime() + 10 * WEEK),
    cadence: 'weekly' as const,
  });

  /* ---------------- setting one ---------------- */

  it('sets a goal through describe → approve → execute, storing the baseline the owner saw', async () => {
    const { preview } = await setGoal({
      title: 'Debt down to 40',
      metric: 'test.debt',
      target: { kind: 'absolute', value: 40 },
      deadline: '2026-11-03',
      cadence: 'weekly',
      milestones: [80],
    });
    expect(preview).toContain('From $100 today to $40 by 2026-11-03');
    expect(preview).toContain('held by @ledger');

    const [goal] = await listGoals(pool, {});
    expect(goal).toMatchObject({
      title: 'Debt down to 40',
      agentId: HOLDER,
      metric: 'test.debt',
      target: { kind: 'absolute', value: 40 },
      cadence: 'weekly',
      milestones: [80],
      state: 'open',
    });
    expect(goal?.baseline.value).toBe(100);

    // The first check is the baseline, so a goal's history starts where the
    // owner was told it starts.
    const checks = await recentChecks(pool, goal?.id as string);
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ value: 100, currency: 'USD' });
    expect(checks[0]?.note).toMatch(/baseline/);
  });

  it('a metric that moves after the card no longer voids the approval', async () => {
    const proposed = await registry.invoke(
      'goal.set',
      {
        title: 'Debt down to 40',
        metric: 'test.debt',
        target: { kind: 'absolute', value: 40 },
        deadline: '2026-11-03',
        cadence: 'weekly',
      },
      agentCtx(),
    );
    if (proposed.ok || proposed.reason !== 'approval-required') throw new Error('setup');
    expect(proposed.preview).toContain('From $100 today');

    /*
     * The world moved between the card and the tap. The executor re-describes
     * before it dispatches and compares envelope hashes — so if `describe`
     * measured again, one mail arriving would refuse an approval the owner had
     * just given. It does not: the baseline is measured once, and the number
     * the owner saw is the number that is stored.
     */
    scripted = 73;
    await decideApproval(pool, { actionId: proposed.actionId, decision: 'approved', by: 'owner', via: 'cli', now: T0 });
    const executed = await executeApproved(pool, { actionId: proposed.actionId, registry, ctx, worker: 't', now: T0 });
    expect(executed.ok).toBe(true);

    const [goal] = await listGoals(pool, {});
    expect(goal?.baseline.value).toBe(100);
    expect(goal?.currency).toBe('USD');
    const checks = await recentChecks(pool, goal?.id as string);
    expect(checks[0]?.value).toBe(100);
  });

  it('still refuses when the model changed the goal itself between card and yes', async () => {
    // The baseline is reused; everything else re-derives, so an envelope the
    // owner never saw is still refused.
    const proposed = await registry.invoke(
      'goal.set',
      {
        title: 'Debt down to 40',
        metric: 'test.debt',
        target: { kind: 'absolute', value: 40 },
        deadline: '2026-11-03',
        cadence: 'weekly',
      },
      agentCtx(),
    );
    if (proposed.ok || proposed.reason !== 'approval-required') throw new Error('setup');
    await pool.query(
      `update core.actions set canonical_args = jsonb_set(canonical_args, '{cadence}', '"daily"') where id = $1`,
      [proposed.actionId],
    );
    await decideApproval(pool, { actionId: proposed.actionId, decision: 'approved', by: 'owner', via: 'cli', now: T0 });
    const executed = await executeApproved(pool, { actionId: proposed.actionId, registry, ctx, worker: 't', now: T0 });
    expect(executed.ok).toBe(false);
    expect(await listGoals(pool, {})).toHaveLength(0);
  });

  it('refuses a goal pointed the wrong way, before a card exists', async () => {
    const result = await registry.invoke(
      'goal.set',
      {
        title: 'Debt down to 40',
        metric: 'test.debt',
        // test.debt goes `down` and stands at 100; 140 is already "reached".
        target: { kind: 'absolute', value: 140 },
        deadline: '2026-11-03',
        cadence: 'weekly',
      },
      agentCtx(),
    );
    expect(result).toMatchObject({ ok: false, reason: 'tool-error' });
    expect((result as { message: string }).message).toMatch(/met the moment it was set/);
    expect(await listPendingActions(pool, { now: T0 })).toHaveLength(0);
    expect(await listGoals(pool, {})).toHaveLength(0);
  });

  it('refuses the thirteenth open goal with the sentence, and nothing is written', async () => {
    for (let i = 0; i < MAX_OPEN_GOALS; i += 1) {
      const made = await createGoal(pool, { ...plainGoal(), title: `goal ${i}` });
      expect(made.ok).toBe(true);
    }
    const thirteenth = await createGoal(pool, { ...plainGoal(), title: 'one too many' });
    expect(thirteenth).toEqual({
      ok: false,
      reason: 'too-many',
      message: TOO_MANY_GOALS,
    });
    expect(TOO_MANY_GOALS).toBe('This installation already holds 12 open goals; close one first.');
    expect(await listGoals(pool, {})).toHaveLength(MAX_OPEN_GOALS);

    // A closed goal frees a slot, which is what the sentence tells the owner.
    const [first] = await listGoals(pool, {});
    await registry.invoke('goal.close', { id: first?.id, note: 'done with it' }, agentCtx());
    const after = await createGoal(pool, { ...plainGoal(), title: 'now there is room' });
    expect(after.ok).toBe(true);
  });

  it('lets exactly one of twelve racing calls take the last slot', async () => {
    for (let i = 0; i < MAX_OPEN_GOALS - 1; i += 1) {
      const made = await createGoal(pool, { ...plainGoal(), title: `goal ${i}` });
      expect(made.ok).toBe(true);
    }
    expect(await listGoals(pool, { openOnly: true })).toHaveLength(MAX_OPEN_GOALS - 1);

    /*
     * A count in a WHERE clause is not a limit: under READ COMMITTED twelve
     * concurrent statements all see eleven open goals and all insert. The
     * advisory lock is what makes the count mean something — and a thirteenth
     * goal is not merely one too many, it is one the sentinel never walks.
     */
    const racers = Array.from({ length: 12 }, (_, i) =>
      createGoal(pool, { ...plainGoal(), title: `racer ${i}` }),
    );
    const results = await Promise.all(racers);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'too-many')).toHaveLength(11);
    expect(await listGoals(pool, { openOnly: true })).toHaveLength(MAX_OPEN_GOALS);
  });

  it('refuses a delegate before any card exists', async () => {
    const result = await registry.invoke(
      'goal.set',
      {
        title: 'Debt down to 40',
        metric: 'test.debt',
        target: { kind: 'absolute', value: 40 },
        deadline: '2026-11-03',
        cadence: 'weekly',
      },
      agentCtx({ delegationDepth: 1 }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'tool-error' });
    expect((result as { message: string }).message).toMatch(/a delegate cannot set a goal/);
    expect(await listPendingActions(pool, { now: T0 })).toHaveLength(0);
    expect(await listGoals(pool, {})).toHaveLength(0);
  });

  /* ---------------- who may write ---------------- */

  it('lets any agent read a goal and only its holder change it', async () => {
    await setGoal({
      title: 'Debt down to 40',
      metric: 'test.debt',
      target: { kind: 'absolute', value: 40 },
      deadline: '2026-11-03',
      cadence: 'weekly',
    });
    const [goal] = await listGoals(pool, {});
    const id = goal?.id as string;
    const stranger = agentCtx({ agentId: 'concierge' });

    // Read is open (§5, last line).
    const listed = await registry.invoke('goal.list', {}, stranger);
    expect(listed).toMatchObject({ ok: true });
    expect((listed as { output: { goals: unknown[] } }).output.goals).toHaveLength(1);
    const status = await registry.invoke('goal.status', { id }, stranger);
    expect((status as { output: { goals: { id: string }[] } }).output.goals[0]?.id).toBe(id);

    // Write is not.
    const update = await registry.invoke('goal.update', { id, cadence: 'daily' }, stranger);
    expect(update).toMatchObject({ ok: false, reason: 'tool-error' });
    expect((update as { message: string }).message).toMatch(/belongs to ledger/);

    const close = await registry.invoke('goal.close', { id, note: 'not mine to close' }, stranger);
    expect(close).toMatchObject({ ok: true });
    expect((close as { output: { reason: string } }).output).toMatchObject({ reason: 'not-yours' });

    expect((await getGoal(pool, id))?.state).toBe('open');
  });

  it('changes a goal through a card that shows before → after', async () => {
    await setGoal({
      title: 'Debt down to 40',
      metric: 'test.debt',
      target: { kind: 'absolute', value: 40 },
      deadline: '2026-11-03',
      cadence: 'weekly',
    });
    const [goal] = await listGoals(pool, {});
    const id = goal?.id as string;

    const proposed = await registry.invoke(
      'goal.update',
      { id, target: { kind: 'absolute', value: 50 }, cadence: 'daily' },
      agentCtx(),
    );
    if (proposed.ok || proposed.reason !== 'approval-required') throw new Error('expected a card');
    expect(proposed.preview).toContain('Target:    $40 → $50');
    expect(proposed.preview).toContain('Cadence:   weekly → daily');

    await decideApproval(pool, { actionId: proposed.actionId, decision: 'approved', by: 'owner', via: 'cli', now: T0 });
    expect((await executeApproved(pool, { actionId: proposed.actionId, registry, ctx, worker: 't', now: T0 })).ok).toBe(true);

    const after = await getGoal(pool, id);
    expect(after).toMatchObject({ target: { kind: 'absolute', value: 50 }, cadence: 'daily' });
    // The metric and the baseline are what the goal IS, and are untouched.
    expect(after?.metric).toBe('test.debt');
    expect(after?.baseline.value).toBe(100);
  });

  it('refuses an approved update once the goal has moved underneath it', async () => {
    await setGoal({
      title: 'Debt down to 40',
      metric: 'test.debt',
      target: { kind: 'absolute', value: 40 },
      deadline: '2026-11-03',
      cadence: 'weekly',
    });
    const [goal] = await listGoals(pool, {});
    const id = goal?.id as string;

    const proposed = await registry.invoke('goal.update', { id, cadence: 'daily' }, agentCtx());
    if (proposed.ok || proposed.reason !== 'approval-required') throw new Error('expected a card');
    await decideApproval(pool, { actionId: proposed.actionId, decision: 'approved', by: 'owner', via: 'cli', now: T0 });

    /*
     * Between the card and the tap, the goal moved. Two layers refuse it, and
     * both are wanted: the executor re-describes and sees a different envelope
     * (the version is part of what was approved), and — for the window between
     * that check and the write, which re-describing cannot close — the UPDATE
     * itself is predicated on the version.
     */
    await pool.query(
      `update core.goals set target_value = 25, updated_at = now() where id = $1::uuid`,
      [id],
    );
    const executed = await executeApproved(pool, { actionId: proposed.actionId, registry, ctx, worker: 't', now: T0 });
    expect(executed).toMatchObject({ ok: false, reason: 'effect-changed' });

    const after = await getGoal(pool, id);
    expect(after?.cadence).toBe('weekly');
    expect(after?.target).toMatchObject({ value: 25 });

    // The store's own guard, for the window the re-description cannot cover:
    // the same write, with the version the card was drawn from.
    const stale = await updateGoal(
      pool,
      id,
      { cadence: 'daily', expectedUpdatedAt: goal?.updatedAt as Date },
      T0,
    );
    expect(stale).toMatchObject({ ok: false, reason: 'changed' });
    expect((stale as { message: string }).message).toMatch(/changed since the owner saw the card/);
    expect((await getGoal(pool, id))?.cadence).toBe('weekly');

    // And at the right version it lands.
    const fresh = await getGoal(pool, id);
    const landed = await updateGoal(
      pool,
      id,
      { cadence: 'daily', expectedUpdatedAt: fresh?.updatedAt as Date },
      new Date(T0.getTime() + 1000),
    );
    expect(landed.ok).toBe(true);
    expect((await getGoal(pool, id))?.cadence).toBe('daily');
  });

  it('refuses an approved update once the goal has been settled', async () => {
    await setGoal({
      title: 'Debt down to 40',
      metric: 'test.debt',
      target: { kind: 'absolute', value: 40 },
      deadline: '2026-11-03',
      cadence: 'weekly',
    });
    const [goal] = await listGoals(pool, {});
    const id = goal?.id as string;
    const proposed = await registry.invoke('goal.update', { id, cadence: 'daily' }, agentCtx());
    if (proposed.ok || proposed.reason !== 'approval-required') throw new Error('expected a card');
    await decideApproval(pool, { actionId: proposed.actionId, decision: 'approved', by: 'owner', via: 'cli', now: T0 });

    await settleGoal(pool, id, 'met', 'the target was reached', T0);
    const executed = await executeApproved(pool, { actionId: proposed.actionId, registry, ctx, worker: 't', now: T0 });
    // A settled goal is refused at the re-description, before anything runs.
    expect(executed.ok).toBe(false);
    expect((await getGoal(pool, id))?.cadence).toBe('weekly');
  });

  it('closes a goal with a note, and a settled one keeps its word', async () => {
    const open = await createGoal(pool, {
      title: 'a goal to close',
      agentId: HOLDER,
      metric: 'test.debt',
      target: { kind: 'absolute', value: 0 },
      baseline: { value: 100, asOf: T0 },
      deadline: new Date(T0.getTime() + WEEK),
      cadence: 'weekly',
    });
    if (!open.ok) throw new Error('setup');
    await registry.invoke('goal.close', { id: open.goal.id, note: 'the owner changed their mind' }, agentCtx());
    const closed = await getGoal(pool, open.goal.id);
    expect(closed).toMatchObject({ state: 'closed', closedNote: 'the owner changed their mind' });

    // Closing it again is a refusal, not a second close.
    const again = await registry.invoke('goal.close', { id: open.goal.id, note: 'again' }, agentCtx());
    expect((again as { output: { reason: string } }).output).toMatchObject({ reason: 'already-closed' });
  });

  it('lets the holder finalise a goal buddi already settled as met', async () => {
    /*
     * §5: "met and missed become final when the owner agrees". Buddi decides
     * the word; the holder writes the note and the date. If `settleGoal` had
     * closed the row itself there would be no way to add that note ever.
     */
    const made = await createGoal(pool, { ...plainGoal(), title: 'a goal that was met' });
    if (!made.ok) throw new Error('setup');
    const settled = await settleGoal(pool, made.goal.id, 'met', 'the target was reached', T0);
    expect(settled).toMatchObject({ state: 'met', closedAt: null });

    const closed = await registry.invoke(
      'goal.close',
      { id: made.goal.id, note: 'We hit it after the September payment.' },
      agentCtx(),
    );
    expect(closed).toMatchObject({ ok: true });
    const row = await getGoal(pool, made.goal.id);
    // The word is kept; the note and the date are added.
    expect(row).toMatchObject({ state: 'met', closedNote: 'We hit it after the September payment.' });
    expect(row?.closedAt).not.toBeNull();
    // And a settled goal is no longer counted against the budget either way.
    expect(await listGoals(pool, { openOnly: true })).toHaveLength(0);
  });

  /* ---------------- the watcher ---------------- */

  const manifests = (): PluginManifest[] => registry.manifests();
  const tick = (at: Date) => runSentinels(pool, manifests(), at, TZ, () => undefined, 'owner');

  /** The one goal in the database. */
  async function theGoal() {
    const [goal] = await listGoals(pool, {});
    if (!goal) throw new Error('no goal');
    return goal;
  }

  /** The wake occurrences, newest last, with the agent each one addresses. */
  async function wakes(): Promise<{ key: string; agentId: string | null }[]> {
    const { rows } = await pool.query<{ payload: { finding: { key: string; agentId: string | null } } }>(
      `select payload from core.occurrences where mission_id = $1 order by scheduled_at`,
      [SENTINEL_WAKE_MISSION_ID],
    );
    return rows.map((row) => ({ key: row.payload.finding.key, agentId: row.payload.finding.agentId }));
  }

  /** The unread digest lines, by finding key. */
  async function digest(): Promise<string[]> {
    const { rows } = await pool.query<{ finding_key: string }>(
      `select finding_key from core.digest_items where consumed_at is null order by created_at`,
    );
    return rows.map((r) => r.finding_key);
  }

  async function weeklyGoal(over: Record<string, unknown> = {}) {
    const made = await createGoal(pool, {
      title: 'Debt down to 40',
      agentId: HOLDER,
      metric: 'test.debt',
      target: { kind: 'absolute', value: 40 },
      baseline: { value: 100, asOf: T0 },
      deadline: new Date(T0.getTime() + 6 * WEEK),
      cadence: 'weekly',
      currency: 'USD',
      milestones: [80],
      ...over,
    });
    if (!made.ok) throw new Error('setup');
    // The baseline check, as `goal.set` would have written it.
    await pool.query(
      `insert into core.goal_checks (goal_id, at, value, currency, note) values ($1, $2, 100, 'USD', 'baseline')`,
      [made.goal.id, T0.toISOString()],
    );
    return made.goal;
  }

  it('records one check per cadence and nothing in between', async () => {
    const goal = await weeklyGoal();
    scripted = 98;

    // Five hourly ticks inside the first week: the watcher runs, the goal is
    // not due, and the history stays exactly one row long.
    for (let h = 1; h <= 5; h += 1) {
      const [outcome] = await tick(new Date(T0.getTime() + h * HOUR));
      expect(outcome?.error).toBeUndefined();
    }
    expect(await recentChecks(pool, goal.id, 10)).toHaveLength(1);

    await tick(new Date(T0.getTime() + WEEK));
    const checks = await recentChecks(pool, goal.id, 10);
    expect(checks).toHaveLength(2);
    expect(checks[0]).toMatchObject({ value: 98, currency: 'USD' });
    expect(checks[0]?.projected).not.toBeNull();
    expect(checks[0]?.paceNeeded).not.toBeNull();

    // And an hour later it is still two.
    await tick(new Date(T0.getTime() + WEEK + HOUR));
    expect(await recentChecks(pool, goal.id, 10)).toHaveLength(2);
  });

  it('walks six weeks: two misses wake the holder, the recovery resolves it, the milestone speaks once, the target settles it', async () => {
    const goal = await weeklyGoal();
    const offTrack = goalKey(goal.id, 'off-track');
    const backOnTrack = goalKey(goal.id, 'back-on-track');
    const milestone = goalKey(goal.id, 'milestone.80');
    const reachedKey = goalKey(goal.id, 'target-reached');

    // Week 1: barely moving. One miss is not news.
    scripted = 98;
    await tick(new Date(T0.getTime() + WEEK));
    expect(await getFinding(pool, offTrack)).toBeNull();

    // Week 2: the second consecutive miss is.
    scripted = 96;
    await tick(new Date(T0.getTime() + 2 * WEEK));
    expect((await getFinding(pool, offTrack))?.severity).toBe('urgent');
    expect(await wakes()).toEqual([{ key: offTrack, agentId: HOLDER }]);

    // Bound to the cadence: a weekly goal off track stays quiet for a week,
    // not the urgent default of a day.
    expect((await getFinding(pool, offTrack))?.cooldownUntil?.getTime()).toBe(T0.getTime() + 3 * WEEK);
    await tick(new Date(T0.getTime() + 2 * WEEK + 25 * HOUR));
    expect((await wakes()).filter((w) => w.key === offTrack)).toHaveLength(1);

    // Week 3: a big payment. Back on track, and the 80 milestone crossed.
    scripted = 60;
    await tick(new Date(T0.getTime() + 3 * WEEK));
    expect((await getFinding(pool, offTrack))?.resolvedAt).not.toBeNull();
    expect((await getFinding(pool, backOnTrack))?.severity).toBe('info');
    // "Back on track" waits for the digest — it is not worth a phone call.
    expect(await digest()).toContain(backOnTrack);
    // The milestone is, and it wakes exactly once.
    expect((await wakes()).filter((w) => w.key === milestone)).toEqual([
      { key: milestone, agentId: HOLDER },
    ]);

    /*
     * Week 4: still under 80. The milestone was *crossed* in week 3 and is not
     * crossed again, so the key is not returned — and a key that is not
     * returned resolves. This is what "fires once when crossed" has to mean:
     * a key returned forever would be read out in every weekly digest forever,
     * once per cooldown, for a payment made in September.
     */
    scripted = 55;
    await tick(new Date(T0.getTime() + 4 * WEEK));
    expect((await wakes()).filter((w) => w.key === milestone)).toHaveLength(1);
    expect((await getFinding(pool, milestone))?.resolvedAt).not.toBeNull();
    expect(await digest()).not.toContain(milestone);

    // Week 5: the target. The goal settles as met and the holder hears once.
    scripted = 38;
    await tick(new Date(T0.getTime() + 5 * WEEK));
    expect((await getGoal(pool, goal.id))?.state).toBe('met');
    expect((await wakes()).filter((w) => w.key === reachedKey)).toEqual([
      { key: reachedKey, agentId: HOLDER },
    ]);

    // Week 6: the goal is no longer open, so every key under it stops being
    // returned and resolves. Nothing new is raised about a finished goal.
    const before = (await wakes()).length;
    await tick(new Date(T0.getTime() + 6 * WEEK));
    expect((await getFinding(pool, reachedKey))?.resolvedAt).not.toBeNull();
    expect(await wakes()).toHaveLength(before);
    // And the check history is one row per week plus the baseline.
    expect(await recentChecks(pool, goal.id, 20)).toHaveLength(6);
  });

  it('never says a milestone twice, however long the goal stays past it', async () => {
    const goal = await weeklyGoal({ cadence: 'daily', milestones: [80, 60] });
    const first = goalKey(goal.id, 'milestone.80');
    const second = goalKey(goal.id, 'milestone.60');

    // Day 1 crosses the first milestone only.
    scripted = 75;
    await tick(new Date(T0.getTime() + 24 * HOUR));
    expect((await wakes()).map((w) => w.key)).toEqual([first]);

    // Days 2 and 3 are still past it and say nothing more about it.
    for (const day of [2, 3]) {
      scripted = 70;
      await tick(new Date(T0.getTime() + day * 24 * HOUR));
    }
    expect((await wakes()).map((w) => w.key)).toEqual([first]);
    expect(await digest()).toEqual([]);

    // Day 4 crosses the second, and that is its own fact.
    scripted = 55;
    await tick(new Date(T0.getTime() + 4 * 24 * HOUR));
    expect((await wakes()).map((w) => w.key)).toEqual([first, second]);

    // Even past the info cooldown, neither comes back.
    scripted = 50;
    await tick(new Date(T0.getTime() + 9 * 24 * HOUR));
    await tick(new Date(T0.getTime() + 10 * 24 * HOUR));
    expect((await wakes()).map((w) => w.key)).toEqual([first, second]);
    expect(await digest()).toEqual([]);
  });

  it('holds an off-track finding open when a check fails to measure', async () => {
    const goal = await weeklyGoal({ cadence: 'daily' });
    const offTrack = goalKey(goal.id, 'off-track');

    // Two measured misses: the holder is woken.
    scripted = 99;
    await tick(new Date(T0.getTime() + 24 * HOUR));
    scripted = 98;
    await tick(new Date(T0.getTime() + 2 * 24 * HOUR));
    expect((await getFinding(pool, offTrack))?.resolvedAt).toBeNull();

    /*
     * The metric then times out. That is evidence about the plugin, not about
     * the goal — the owner has not recovered — so the urgent finding stays
     * open. Reading `on_track` off a null row would resolve it and then raise
     * it again as news the next time a number arrives.
     */
    scripted = null;
    await tick(new Date(T0.getTime() + 3 * 24 * HOUR));
    const stillOpen = await getFinding(pool, offTrack);
    expect(stillOpen?.resolvedAt).toBeNull();
    expect((await recentChecks(pool, goal.id, 1))[0]?.value).toBeNull();

    // A measured recovery is what resolves it.
    scripted = 20;
    await tick(new Date(T0.getTime() + 4 * 24 * HOUR));
    expect((await getFinding(pool, offTrack))?.resolvedAt).not.toBeNull();
  });

  it('measures at the deadline even when the cadence is not due', async () => {
    /*
     * A weekly goal set on Monday with a Thursday deadline is not cadence-due
     * on Thursday. Settling it off Monday's number would record a verdict
     * about a week the goal never had — and the owner reached the target on
     * Wednesday.
     */
    const goal = await weeklyGoal({ deadline: new Date(T0.getTime() + 3 * 24 * HOUR) });
    scripted = 35;
    await tick(new Date(T0.getTime() + 3 * 24 * HOUR + HOUR));

    const checks = await recentChecks(pool, goal.id, 10);
    expect(checks).toHaveLength(2);
    expect(checks[0]?.value).toBe(35);
    expect((await getGoal(pool, goal.id))?.state).toBe('met');
    expect((await wakes()).map((w) => w.key)).toEqual([goalKey(goal.id, 'target-reached')]);
  });

  it('quotes the newest measured number in the last seven days', async () => {
    const goal = await weeklyGoal({
      cadence: 'daily',
      deadline: new Date(T0.getTime() + 3 * 24 * HOUR),
    });
    const near = goalKey(goal.id, 'deadline-near');

    // Before any check of its own it can only quote the baseline, and says so.
    await tick(new Date(T0.getTime() + HOUR));
    expect((await getFinding(pool, near))?.detail).toContain('$100');

    // Once a check lands, the urgent row is about today's number — which is
    // the number the holder is about to go and verify.
    scripted = 90;
    await tick(new Date(T0.getTime() + 24 * HOUR));
    const raised = await getFinding(pool, near);
    expect(raised?.severity).toBe('urgent');
    expect(raised?.detail).toContain('$90');
    expect(raised?.detail).toContain('short of $40');
  });

  it('takes at most one check per cadence and wakes at most once a day', async () => {
    /*
     * The 20 h margin (a deliberate deviation — see the spec) means a daily
     * goal checked at 00:00 is due again at 20:00 the same day. That is one
     * extra row; it must never be a second interruption, and it is not,
     * because findings dedup by key.
     */
    // 00:00 and 20:00 on the same day in the owner's zone, 20 h apart.
    const midnight = new Date('2026-09-24T04:00:00Z');
    const evening = new Date(midnight.getTime() + 20 * HOUR);
    expect(localDateString(midnight, TZ)).toBe(localDateString(evening, TZ));

    const goal = await weeklyGoal({ cadence: 'daily' });
    scripted = 99;
    await tick(midnight);
    scripted = 98;
    await tick(evening);

    const sameDay = await recentChecks(pool, goal.id, 10);
    expect(sameDay.filter((c) => c.at >= midnight)).toHaveLength(2);
    // Two consecutive measured misses inside one day: one key, one wake.
    const offTrack = goalKey(goal.id, 'off-track');
    expect((await getFinding(pool, offTrack))?.severity).toBe('urgent');
    expect((await wakes()).filter((w) => w.key === offTrack)).toHaveLength(1);

    scripted = 97;
    await tick(new Date(midnight.getTime() + 41 * HOUR));
    expect((await wakes()).filter((w) => w.key === offTrack)).toHaveLength(1);
    // Three rows in two days, one interruption.
    expect((await recentChecks(pool, goal.id, 10)).filter((c) => c.at >= midnight)).toHaveLength(3);
  });

  it('counts the seven silent days from the last number, not from the baseline', async () => {
    /*
     * The goal was set months ago and the plugin went missing this week. The
     * last four rows are all unmeasured, so a count over those alone collapses
     * onto the baseline and fires on day four of the outage, saying a number
     * that existed on Monday has been missing since June.
     */
    const goal = await weeklyGoal({ cadence: 'daily' });
    const key = goalKey(goal.id, 'not-measurable');
    const day = (n: number): Date => new Date(T0.getTime() + n * 24 * HOUR);

    // Thirty days of numbers, so the baseline is far behind.
    for (let d = 1; d <= 30; d += 1) {
      scripted = 100 - d;
      await tick(day(d));
    }
    // Then four days with nothing. That is four days, not thirty-four.
    scripted = null;
    for (let d = 31; d <= 34; d += 1) await tick(day(d));
    expect(await getFinding(pool, key)).toBeNull();

    // Seven days after the last number is when it becomes a fact.
    for (let d = 35; d <= 37; d += 1) await tick(day(d));
    const finding = await getFinding(pool, key);
    expect(finding?.severity).toBe('info');
    // And the date it names is the real one.
    expect(finding?.detail).toContain(`no number since ${localDateString(day(30), TZ)}`);
    expect((await wakes()).filter((w) => w.key === key)).toHaveLength(1);
  });

  it('records a check with no number, and wakes the holder once after seven days', async () => {
    const goal = await weeklyGoal({ cadence: 'daily' });
    const key = goalKey(goal.id, 'not-measurable');
    scripted = null;

    // Six days of daily checks, every one of them honest about having no number.
    for (let d = 1; d <= 6; d += 1) {
      await tick(new Date(T0.getTime() + d * 24 * HOUR));
    }
    const checks = await recentChecks(pool, goal.id, 20);
    expect(checks[0]?.value).toBeNull();
    expect(checks[0]?.note).toMatch(/cannot be measured right now/);
    expect(await getFinding(pool, key)).toBeNull();

    // The seventh day is the fact.
    await tick(new Date(T0.getTime() + 7 * 24 * HOUR));
    const finding = await getFinding(pool, key);
    expect(finding?.severity).toBe('info');
    expect(finding?.detail).toContain('never change it silently');
    expect((await wakes()).filter((w) => w.key === key)).toEqual([{ key, agentId: HOLDER }]);

    // An eighth day is the same fact: no second wake.
    await tick(new Date(T0.getTime() + 8 * 24 * HOUR));
    expect((await wakes()).filter((w) => w.key === key)).toHaveLength(1);
  });

  it('settles a goal as missed when the deadline passes', async () => {
    const goal = await weeklyGoal({ deadline: new Date(T0.getTime() + WEEK) });
    const nearKey = goalKey(goal.id, 'deadline-near');
    const passedKey = goalKey(goal.id, 'deadline-passed');

    // Inside the last seven days and nowhere near the target: urgent.
    scripted = 95;
    await tick(new Date(T0.getTime() + HOUR));
    expect((await getFinding(pool, nearKey))?.severity).toBe('urgent');
    expect((await getGoal(pool, goal.id))?.state).toBe('open');

    await tick(new Date(T0.getTime() + WEEK + HOUR));
    expect((await getGoal(pool, goal.id))?.state).toBe('missed');
    const passed = await getFinding(pool, passedKey);
    expect(passed?.severity).toBe('urgent');
    expect(passed?.detail).toContain('Verify with your own tools');
    expect((await wakes()).map((w) => w.key)).toContain(passedKey);
    expect((await wakes()).every((w) => w.agentId === HOLDER)).toBe(true);
  });

  /**
   * Telegram parity (§7): a goal wake travels the way every finding travels.
   *
   * There is no goal-shaped path to a phone and there must not be one. A goal
   * finding becomes a pending occurrence of `sentinel-wake` carrying the
   * finding as its payload; the mission executor reads it with `findingOf`,
   * runs it **as the goal's holder** rather than as the wake mission's own
   * agent, and appends `renderFinding`'s fenced block to the prompt. What the
   * holder then says with `mission.report` goes wherever its surface sends it
   * — Telegram included — and nothing on that path knows the word "goal". So
   * this asserts the join: the occurrence a goal produces is the occurrence
   * that machinery already consumes.
   */
  it('reaches Telegram the way any finding does: one wake occurrence, addressed to the holder', async () => {
    const goal = await weeklyGoal({ deadline: new Date(T0.getTime() + WEEK) });
    scripted = 95;
    await tick(new Date(T0.getTime() + WEEK + HOUR));

    const { rows } = await pool.query<{ payload: unknown }>(
      `select payload from core.occurrences where mission_id = $1 and state = 'pending' order by scheduled_at`,
      [SENTINEL_WAKE_MISSION_ID],
    );
    expect(rows.length).toBeGreaterThan(0);
    const finding = findingOf(rows[rows.length - 1]?.payload);
    expect(finding).not.toBeNull();
    // Addressed, so the executor resolves the holder and not the overview agent.
    expect(finding?.agentId).toBe(HOLDER);
    expect(finding?.sentinelId).toBe(GOALS_SENTINEL_ID);
    expect(finding?.severity).toBe('urgent');
    expect(finding?.key).toBe(goalKey(goal.id, 'deadline-passed'));

    // And it renders into the prompt fenced as untrusted data, like any other.
    const block = renderFinding(finding as NonNullable<typeof finding>);
    expect(block).toContain(FINDING_OPEN);
    expect(block).toContain(FINDING_CLOSE);
    expect(block).toContain(GOAL_WAKE_INSTRUCTION);
  });

  it('is a watcher like any other: a goal whose plugin is gone shows no number, ever', async () => {
    const goal = await weeklyGoal({ metric: 'finance.uninstalled', cadence: 'daily' });
    await tick(new Date(T0.getTime() + 24 * HOUR));
    const checks = await recentChecks(pool, goal.id, 4);
    expect(checks[0]?.value).toBeNull();
    expect(checks[0]?.note).toMatch(/no metric finance\.uninstalled is installed here/);
    const [outcome] = await tick(new Date(T0.getTime() + 25 * HOUR));
    expect(outcome?.sentinelId).toBe(GOALS_SENTINEL_ID);
    expect(outcome?.error).toBeUndefined();
  });
});
