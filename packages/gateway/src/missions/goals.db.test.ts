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
  SENTINEL_WAKE_MISSION_ID,
  upsertMission,
  type MetricDefinition,
  type PluginManifest,
  type ToolContext,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGoalManifest, GOALS_SENTINEL_ID, goalKey } from './goals.js';

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
  let ctx: ToolContext;
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

  const agentCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
    ...ctx,
    agentId: HOLDER,
    conversationId: undefined,
    ...over,
  });

  /** Propose a goal, approve it, execute it. The whole card, end to end. */
  async function setGoal(
    input: Record<string, unknown>,
    over: Partial<ToolContext> = {},
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

  it('refuses the approval when the number moved between the card and the yes', async () => {
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
     * The world moved between the card and the yes. What the owner approved
     * was "from $100 today", and a goal measured against $73 is a different
     * goal — so the executor refuses rather than storing a baseline nobody
     * agreed to, and the agent proposes it again with the number that is now
     * true. This is the platform's rule (`effect-changed`), and it is the
     * whole of "the baseline the owner saw is the baseline stored".
     */
    scripted = 73;
    await decideApproval(pool, { actionId: proposed.actionId, decision: 'approved', by: 'owner', via: 'cli', now: T0 });
    const executed = await executeApproved(pool, { actionId: proposed.actionId, registry, ctx, worker: 't', now: T0 });
    expect(executed).toMatchObject({ ok: false, reason: 'effect-changed' });
    expect(await listGoals(pool, {})).toHaveLength(0);
  });

  it('refuses the thirteenth open goal with the sentence, and nothing is written', async () => {
    for (let i = 0; i < MAX_OPEN_GOALS; i += 1) {
      const made = await createGoal(pool, {
        title: `goal ${i}`,
        agentId: HOLDER,
        metric: 'test.debt',
        target: { kind: 'absolute', value: 0 },
        baseline: { value: 100, asOf: T0 },
        deadline: new Date(T0.getTime() + 10 * WEEK),
        cadence: 'weekly',
      });
      expect(made.ok).toBe(true);
    }
    const thirteenth = await createGoal(pool, {
      title: 'one too many',
      agentId: HOLDER,
      metric: 'test.debt',
      target: { kind: 'absolute', value: 0 },
      baseline: { value: 100, asOf: T0 },
      deadline: new Date(T0.getTime() + 10 * WEEK),
      cadence: 'weekly',
    });
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
    const after = await createGoal(pool, {
      title: 'now there is room',
      agentId: HOLDER,
      metric: 'test.debt',
      target: { kind: 'absolute', value: 0 },
      baseline: { value: 100, asOf: T0 },
      deadline: new Date(T0.getTime() + 10 * WEEK),
      cadence: 'weekly',
    });
    expect(after.ok).toBe(true);
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

    // Week 4: still under 80, so the milestone is the same fact — no second wake.
    scripted = 55;
    await tick(new Date(T0.getTime() + 4 * WEEK));
    expect((await wakes()).filter((w) => w.key === milestone)).toHaveLength(1);

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
    expect((await getFinding(pool, milestone))?.resolvedAt).not.toBeNull();
    expect(await wakes()).toHaveLength(before);
    // And the check history is one row per week plus the baseline.
    expect(await recentChecks(pool, goal.id, 20)).toHaveLength(6);
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
