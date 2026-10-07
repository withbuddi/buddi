/**
 * Run now (docs/agents.md, "Run now"), against a throwaway database: a manual
 * occurrence goes the way a scheduled one goes — the same `mission-run` job,
 * the same executor, the report delivered through the same `deliver`, the
 * occurrence closed by the same handler — and a silent one counts toward
 * "Still useful?" like any run.
 *
 * Skipped unless DATABASE_URL is set; the owner's own database is untouched.
 */
import {
  createPool,
  ensureOwner,
  getJob,
  getMission,
  getOccurrence,
  isManualOccurrence,
  listOccurrences,
  runMigrations,
  runScheduler,
  runWorker,
  setSchedule,
  ToolRegistry,
  upsertMission,
  type CoreToolContext,
} from '@buddi/core';
import type { CompletionResponse, RuntimeProvider } from '@buddi/runtime';
import { manifest as memoryManifest } from '@buddi/tool-memory';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '@buddi/core/testing';
import { loadGatewayCatalog } from '../agents/catalog.js';
import { createMissionJobHandler } from '../serve.js';
import { createMissionExecutor } from './execute.js';
import { MISSION_JOB_KIND, queueOccurrence, runMissionNow } from './run-now.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_missions_run_now_test_${process.pid}`;
const ENV = { BUDDI_TZ: 'UTC' } as NodeJS.ProcessEnv;
const AGENT = 'browser-agent';
// An agent's own watch, so the quiet count behind "Still useful?" applies.
const MISSION_ID = `agent:${AGENT}:brief`;

type Step = { tool: string; input: unknown } | { text: string };
function scripted(steps: Step[]): RuntimeProvider {
  let n = 0;
  return {
    async complete(): Promise<CompletionResponse> {
      const step = steps[n++] ?? { text: 'done' };
      if ('tool' in step) {
        return { content: [{ type: 'tool_use', id: `tu-${n}`, name: step.tool, input: step.input }], stopReason: 'tool_use', usage: { input: 1, output: 1 }, model: 'claude-test' };
      }
      return { content: [{ type: 'text', text: step.text }], stopReason: 'end_turn', usage: { input: 1, output: 1 }, model: 'claude-test' };
    },
  };
}

async function waitFor(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting');
}

suite('Run now on a mission (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let registry: ToolRegistry;
  let ctx: CoreToolContext;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [memoryManifest]);
    await ensureOwner(pool, 'owner');
    ctx = { db: pool, ownerId: 'owner', now: () => new Date(), timezone: 'UTC' };
    registry = new ToolRegistry();
    registry.register(memoryManifest);
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
    await pool.query('truncate core.occurrences, core.schedule_specs, core.last_materialized, core.missions cascade');
    await pool.query('truncate core.owner_notifications, core.messages, core.events cascade');
    await pool.query('truncate core.conversations cascade');
  });

  const catalog = () => loadGatewayCatalog({
    dir: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'browsing-agents'),
    env: ENV,
    registry,
  });

  /** The serve worker for mission runs, with a scripted model and a `deliver` that keeps what it was given. */
  const worker = (steps: Step[], delivered: string[]) => {
    const execute = createMissionExecutor({
      pool, registry, catalog: catalog(), provider: scripted(steps), ctx, env: ENV, now: () => new Date(),
      deliver: async (text) => { delivered.push(text); return 'chat-1'; },
      log: () => {},
    });
    const handler = createMissionJobHandler({ pool, execute, log: () => {} });
    return runWorker({ pool, worker: 'test', kinds: [MISSION_JOB_KIND], handlers: { [MISSION_JOB_KIND]: handler }, now: () => new Date(), pollMs: 5, leaseMs: 5_000 });
  };

  it('a manual occurrence is delivered through the same job, executor and deliver as a cron one', async () => {
    await upsertMission(pool, { id: MISSION_ID, name: 'Brief', agentId: AGENT, prompt: 'Brief the owner.', browser: null });
    await setSchedule(pool, MISSION_ID, { cron: '* * * * *', timezone: 'UTC', timezoneExplicit: false, misfirePolicy: 'coalesce' });
    const delivered: string[] = [];
    const running = worker([
      { tool: 'mission.report', input: { urgency: 'normal', text: 'From the clock.' } },
      { text: 'done' },
      { tool: 'mission.report', input: { urgency: 'normal', text: 'Because you asked.' } },
      { text: 'done' },
    ], delivered);
    try {
      // The clock: the scheduler as serve runs it, a minute on.
      const queued: string[] = [];
      const scheduler = runScheduler({
        pool, now: () => new Date(Date.now() + 61_000), tickMs: 1_000, autoStart: false,
        execute: async (occurrence, mission) => { queued.push((await queueOccurrence(pool, occurrence, mission)).id); return { deferred: true }; },
      });
      await scheduler.tick();
      expect(queued).toHaveLength(1);
      await waitFor(async () => (await getJob(pool, queued[0]!))?.state === 'succeeded');
      expect(delivered).toEqual(['From the clock.']);

      // Run now: the same kind of job, the same way out.
      const now = await runMissionNow(pool, MISSION_ID, new Date());
      if (!now.ok) throw new Error(now.error);
      const cronJob = await getJob(pool, queued[0]!);
      const manualJob = await getJob(pool, now.job.id);
      expect(manualJob?.kind).toBe(cronJob?.kind);
      await waitFor(async () => (await getJob(pool, now.job.id))?.state === 'succeeded');
      expect(delivered).toEqual(['From the clock.', 'Because you asked.']);
      expect((await getOccurrence(pool, now.occurrence.id))?.state).toBe('succeeded');

      const occurrences = await listOccurrences(pool, MISSION_ID);
      const byId = (id: string) => occurrences.find((o) => o.id === id);
      expect(occurrences).toHaveLength(2);
      expect(byId(now.occurrence.id)).toMatchObject({ state: 'succeeded', scheduleRevision: 0 });
      expect(isManualOccurrence(byId(now.occurrence.id)?.payload)).toBe(true);
      expect(occurrences.filter((o) => o.id !== now.occurrence.id).map((o) => [o.state, isManualOccurrence(o.payload)])).toEqual([['succeeded', false]]);
      const { rows } = await pool.query<{ kind: string }>(`select kind from core.events where kind = 'mission.delivered' order by id`);
      expect(rows.map((r) => r.kind)).toEqual(['mission.delivered', 'mission.delivered']);
    } finally {
      await running.stop();
    }
  }, 30_000);

  it('a silent manual run counts toward "Still useful?" like a scheduled one', async () => {
    await upsertMission(pool, { id: MISSION_ID, name: 'Brief', agentId: AGENT, prompt: 'Brief the owner.', browser: null });
    const delivered: string[] = [];
    const running = worker([{ tool: 'mission.silent', input: { reason: 'nothing new' } }, { text: 'done' }], delivered);
    try {
      const now = await runMissionNow(pool, MISSION_ID, new Date());
      if (!now.ok) throw new Error(now.error);
      await waitFor(async () => (await getJob(pool, now.job.id))?.state === 'succeeded');
      expect(delivered).toEqual([]);
      expect((await getMission(pool, MISSION_ID))?.quietRuns).toBe(1);
      const silent = await pool.query(`select payload from core.events where kind = 'mission.silent'`);
      expect(silent.rows[0]?.payload).toMatchObject({ missionId: MISSION_ID, occurrenceId: now.occurrence.id });
    } finally {
      await running.stop();
    }
  }, 30_000);

  it('refuses while one is queued or running, a mission that is off or paused, and an unknown one', async () => {
    await upsertMission(pool, { id: MISSION_ID, name: 'Brief', agentId: AGENT, prompt: 'p', browser: null });
    const first = await runMissionNow(pool, MISSION_ID, new Date());
    expect(first.ok).toBe(true);
    expect(await runMissionNow(pool, MISSION_ID, new Date())).toMatchObject({ ok: false, status: 409, error: 'Brief is already running.' });
    await pool.query(`update core.occurrences set state = 'pending', claimed_at = null`);
    expect(await runMissionNow(pool, MISSION_ID, new Date())).toMatchObject({ ok: false, status: 409, error: 'Brief is already queued.' });
    await pool.query(`update core.occurrences set state = 'succeeded'`);
    await pool.query(`update core.missions set paused_reason = 'paused: finance is disabled'`);
    expect(await runMissionNow(pool, MISSION_ID, new Date())).toMatchObject({ ok: false, status: 409, error: 'Brief is paused: finance is disabled.' });
    await pool.query(`update core.missions set paused_reason = null, enabled = false`);
    expect(await runMissionNow(pool, MISSION_ID, new Date())).toMatchObject({ ok: false, status: 409, error: 'Brief is off. Switch it on first.' });
    expect(await runMissionNow(pool, 'nope', new Date())).toMatchObject({ ok: false, status: 404 });
  });
});
