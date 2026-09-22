/**
 * The Goals surfaces against a throwaway database.
 *
 * Three things only a real Postgres settles:
 *
 *  - the two page queries answer under the **read-only pool** — the same one
 *    the query route hands a plugin — so "a page cannot write" is enforced by
 *    the server rather than promised by this file;
 *  - `goal.owner_close` closes a goal the owner never held, and does not exist
 *    for anybody but the owner;
 *  - the Home block says the same thing the page does, off the same rows.
 *
 * Skipped unless DATABASE_URL is set; the owner's own database is untouched.
 */
import {
  ToolRegistry,
  createGoal,
  createPool,
  ensureOwner,
  getGoal,
  pageQueryContext,
  recordCheck,
  runMigrations,
  runSentinels,
  SENTINEL_WAKE_MISSION_ID,
  upsertMission,
  type MetricDefinition,
  type PageQuery,
  type PluginManifest,
  type ToolContext,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGoalManifest } from './goals.js';
import { createGoalHome } from './goals-page.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_goals_page_test_${process.pid}`;

const TZ = 'America/New_York';
const T0 = new Date('2026-09-22T13:00:00Z');
const WEEK = 7 * 24 * 60 * 60_000;
const HOLDER = 'ledger';

/** What the scripted metric answers next. `null` is "cannot measure now". */
let scripted: number | null = 100;

const debt: MetricDefinition = {
  id: 'test.debt',
  description: 'A number a test drives by hand.',
  unit: 'currency',
  direction: 'down',
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

suite('the Goals page reads (postgres)', () => {
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
    registry = new ToolRegistry();
    registry.register(metricPlugin);
    registry.register(createGoalManifest(registry));
    await pool.query('truncate core.goals cascade');
    await pool.query('truncate core.sentinel_findings, core.sentinel_runs cascade');
    await pool.query('truncate core.occurrences, core.missions cascade');
    await upsertMission(pool, {
      id: SENTINEL_WAKE_MISSION_ID,
      name: 'Sentinel wake',
      agentId: 'buddi',
      prompt: 'verify',
      enabled: true,
      alwaysDeliver: false,
    });
  });

  /** One page query by name, as the query route finds it. */
  function query(name: string): PageQuery {
    const found = registry.queries().find((q) => q.plugin === 'goal' && q.name === name);
    if (!found) throw new Error(`no query ${name}`);
    return found;
  }

  /**
   * Run one, through the very same read-only context the route builds. A
   * statement that is not a select fails on the statement, not on a promise.
   */
  async function read(name: string, params: unknown = {}): Promise<any> {
    const q = query(name);
    const parsed = q.params.parse(params);
    return (await q.produce(parsed, pageQueryContext(ctx))) as any;
  }

  async function aGoal(over: Record<string, unknown> = {}) {
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
    await recordCheck(pool, {
      goalId: made.goal.id,
      at: T0,
      value: 100,
      currency: 'USD',
      note: 'baseline, measured when the goal was set',
    });
    return made.goal;
  }

  it('lists the goals, open first, with progress and pace in the line', async () => {
    const open = await aGoal();
    const done = await aGoal({ title: 'Inbox to zero' });
    await pool.query(`update core.goals set state = 'met' where id = $1`, [done.id]);
    // A second check, so there is a pace and a projection to read.
    await recordCheck(pool, {
      goalId: open.id,
      at: new Date(T0.getTime() + WEEK),
      value: 90,
      currency: 'USD',
      onTrack: true,
      projected: 40,
    });

    const answer = await read('goals');
    expect(answer.goals.map((row: any) => [row.title, row.group])).toEqual([
      ['Debt down to 40', 'open'],
      ['Inbox to zero', 'done'],
    ]);
    const first = answer.goals[0];
    expect(first.sub).toContain('progress 17%');
    expect(first.sub).toContain('a week down');
    expect(first.sub).toContain('on track');
    expect(first.value).toBe('$90');
    expect(first.tone).toBe('good');
    expect(first.holder).toBe(HOLDER);
  });

  it('reads one goal: the figures, the checks, the milestones and the wakes', async () => {
    const goal = await aGoal();
    // A week in, past the milestone and heading the right way.
    await recordCheck(pool, {
      goalId: goal.id,
      at: new Date(T0.getTime() + WEEK),
      value: 75,
      currency: 'USD',
      onTrack: true,
      projected: 20,
    });
    // And a look that failed, which is a fact about the plugin, not the goal.
    await recordCheck(pool, {
      goalId: goal.id,
      at: new Date(T0.getTime() + 2 * WEEK),
      value: null,
      note: 'the bank did not answer',
    });

    const one = await read('goal', { id: goal.id });
    expect(one.title).toBe('Debt down to 40');
    expect(one.holder).toBe('@ledger');
    expect(one.agentId).toBe(HOLDER);
    expect(one.baseline).toContain('$100');
    // The newest *number*, not the newest row: the failed look does not erase it.
    expect(one.now).toBe('$75');
    expect(one.target).toBe('$40');
    expect(one.deadline).toBe('2026-11-03');
    expect(one.standing).toContain('not measured since');
    expect(one.checks).toHaveLength(3);
    expect(one.checks[0].value).toBe('not measured');
    expect(one.checks[0].note).toBe('the bank did not answer');
    expect(one.milestones).toEqual([
      expect.objectContaining({ label: '$80', crossed: 'crossed 2026-09-29', crossedTone: 'good' }),
    ]);
    expect(one.findings).toEqual([]);
  });

  it('shows the findings the watcher raised about that goal, and no others', async () => {
    const goal = await aGoal();
    const other = await aGoal({ title: 'Another' });
    // Six weeks on with the number standing still: the deadline passes and the
    // watcher settles both goals, writing a finding under each.
    scripted = 100;
    await runSentinels(pool, registry.manifests(), new Date(T0.getTime() + 7 * WEEK), TZ, () => undefined, 'owner');

    const one = await read('goal', { id: goal.id });
    expect(one.findings.length).toBeGreaterThan(0);
    for (const finding of one.findings) {
      expect(finding.key.startsWith(`goal.${goal.id}.`)).toBe(true);
      expect(finding.key.startsWith(`goal.${other.id}.`)).toBe(false);
      expect(finding.when).toBe('2026-11-10');
    }
    expect(one.findings.some((f: any) => f.title.includes('deadline passed'))).toBe(true);
  });

  it('refuses an id that is not a goal, in words meant for the owner', async () => {
    await expect(read('goal', { id: '00000000-0000-0000-0000-000000000000' })).rejects.toThrow(
      /No goal here has that id/,
    );
  });

  it('cannot write: the pool a query is handed refuses anything but a select', async () => {
    const goal = await aGoal();
    const readOnly = pageQueryContext(ctx);
    await expect(readOnly.db.query(`update core.goals set title = 'nope' where id = $1`, [goal.id])).rejects.toThrow(
      /may only read/,
    );
  });

  describe('goal.owner_close', () => {
    it('closes a goal the owner never held, and says so', async () => {
      const goal = await aGoal();
      const result = await registry.invoke(
        'goal.owner_close',
        { id: goal.id, note: 'We refinanced; this number stopped meaning anything.' },
        { ...ctx, agentId: 'owner' },
      );
      expect(result.ok).toBe(true);
      const after = await getGoal(pool, goal.id);
      expect(after?.state).toBe('closed');
      expect(after?.closedNote).toBe('We refinanced; this number stopped meaning anything.');
      expect(after?.closedAt).not.toBeNull();
    });

    it('keeps the word buddi chose, and only adds the note', async () => {
      const goal = await aGoal();
      await pool.query(`update core.goals set state = 'met' where id = $1`, [goal.id]);
      const result = await registry.invoke(
        'goal.owner_close',
        { id: goal.id, note: 'Done, and we agreed we were done.' },
        { ...ctx, agentId: 'owner' },
      );
      expect(result.ok).toBe(true);
      expect((await getGoal(pool, goal.id))?.state).toBe('met');
    });

    it('does not exist for an agent: an ownerOnly tool is unknown, not forbidden', async () => {
      const goal = await aGoal();
      const result = await registry.invoke(
        'goal.owner_close',
        { id: goal.id, note: 'not mine to close' },
        { ...ctx, agentId: HOLDER },
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.reason).toBe('unknown-tool');
      expect((await getGoal(pool, goal.id))?.state).toBe('open');
    });

    it('refuses an id that is not a goal', async () => {
      const result = await registry.invoke(
        'goal.owner_close',
        { id: '00000000-0000-0000-0000-000000000000', note: 'nothing here' },
        { ...ctx, agentId: 'owner' },
      );
      expect(result.ok).toBe(false);
      expect(result.ok === false && result.message).toMatch(/No goal here has that id/);
    });
  });

  describe('the Home block', () => {
    const block = () => createGoalHome(registry).produce(ctx);

    it('is nothing at all until there is an open goal', async () => {
      expect(await block()).toBeNull();
      const goal = await aGoal();
      await pool.query(`update core.goals set state = 'closed' where id = $1`, [goal.id]);
      expect(await block()).toBeNull();
    });

    it('says the same thing the page says, in the owner’s currency', async () => {
      const goal = await aGoal();
      await recordCheck(pool, {
        goalId: goal.id,
        at: new Date(T0.getTime() + WEEK),
        value: 90,
        currency: 'USD',
        onTrack: true,
        projected: 40,
      });
      const home = await block();
      expect(home?.id).toBe('goal.goals');
      expect(home?.stats).toEqual([
        { label: 'Open', value: '1' },
        { label: 'Off track', value: '0' },
      ]);
      expect(home?.rows).toHaveLength(1);
      const row = home!.rows[0]!;
      expect(row.title).toBe('Debt down to 40');
      expect(row.side).toBe('$90');
      expect(row.tone).toBe('good');
      const page = await read('goals');
      expect(row.sub).toBe(page.goals[0].sub);
    });

    it('is loud only when a goal has missed twice running', async () => {
      const goal = await aGoal();
      await recordCheck(pool, {
        goalId: goal.id,
        at: new Date(T0.getTime() + WEEK),
        value: 99,
        currency: 'USD',
        onTrack: false,
        projected: 95,
      });
      const once = await block();
      expect(once?.rows[0]?.sub).toContain('off track');
      // One miss is a fact, not an alarm: the row carries no tone yet.
      expect(once?.rows[0]?.tone).toBeUndefined();
      expect(once?.stats[1]).toEqual({ label: 'Off track', value: '1', tone: 'critical' });

      await recordCheck(pool, {
        goalId: goal.id,
        at: new Date(T0.getTime() + 2 * WEEK),
        value: 98,
        currency: 'USD',
        onTrack: false,
        projected: 94,
      });
      expect((await block())?.rows[0]?.tone).toBe('critical');
    });

    it('says when a number went missing rather than inventing one', async () => {
      const goal = await aGoal();
      await recordCheck(pool, {
        goalId: goal.id,
        at: new Date(T0.getTime() + WEEK),
        value: null,
        note: 'the bank did not answer',
      });
      const home = await block();
      expect(home?.rows[0]?.sub).toContain('not measured since 2026-09-22');
      expect(home?.rows[0]?.side).toBe('$100');
    });
  });
});
