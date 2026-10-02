/**
 * Reminders and proposed schedules against a throwaway database.
 *
 * Two things only a real database can settle:
 *
 *  - a due reminder becomes exactly one queue job, and a fired one's run that
 *    decides to stay silent delivers nothing;
 *  - `schedule.propose` is gated, so the call becomes an action the owner
 *    approves, and the mission and its schedule revision exist only after
 *    `executeApproved` has run — never before.
 *
 * Skipped unless DATABASE_URL is set; the owner's own database is untouched.
 */
import {
  createPool,
  createReminder,
  decideApproval,
  dueReminders,
  ensureOwner,
  enqueue,
  executeApproved,
  getActiveSchedule,
  getMission,
  endExpiredMissions,
  keepMission,
  noteMissionRun,
  setMissionEnabled,
  upsertMission,
  listJobs,
  listPendingActions,
  listReminders,
  runMigrations,
  ToolRegistry,
  type AgentCatalog,
  type Job,
  type JobContext,
  type CoreToolContext,
} from '@buddi/core';
import type { CompletionResponse, RuntimeProvider } from '@buddi/runtime';
import { manifest as artifactsManifest } from '@buddi/tool-artifacts';
import { manifest as emailManifest } from '@buddi/tool-email';
import { manifest as memoryManifest } from '@buddi/tool-memory';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToolRegistry, loadGatewayCatalog } from '../agents/catalog.js';
import { AGENT_RUN_JOB_KIND, createAgentRunHandler } from './agent-run.js';

/**
 * Just enough `JobContext` to call a handler outside the worker loop. Handed
 * over explicitly rather than left off: a handler that reaches for `suspend`
 * would otherwise throw on `undefined` only on the day it started doing so.
 */
const jobContext = (): JobContext => ({
  signal: new AbortController().signal,
  heartbeat: async () => true,
  suspend: async () => {},
  lost: false,
});
import {
  agentMissionId,
  createReminderTick,
  reminderDedupKey,
} from './reminders.js';
import { testDatabaseUrl } from '@buddi/core/testing';
import { registerDefault } from './defaults.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_reminders_gw_test_${process.pid}`;

const ENV = { BUDDI_TZ: 'America/New_York' } as NodeJS.ProcessEnv;

/**
 * The agent a fired reminder wakes — a fixture this repository ships, never
 * whatever is installed on the machine running the suite: `private/` is
 * gitignored, a fresh clone has none of it, and making another agent is a
 * supported action that must not break the platform's own tests.
 */
const MISSION_AGENT = 'mission-agent';

function fixtureCatalog(registry: ToolRegistry): AgentCatalog {
  return loadGatewayCatalog({
    dir: path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '__fixtures__',
      'mission-agents',
    ),
    env: ENV,
    registry,
  });
}
const NOW = new Date('2026-09-14T12:00:00Z');
const TZ = 'America/New_York';

/** A provider that calls one mission tool and stops — an unattended run's shape. */
function decidingProvider(
  tool: 'mission.report' | 'mission.silent',
  args: unknown,
  calls: string[],
): RuntimeProvider {
  let turn = 0;
  return {
    async complete(): Promise<CompletionResponse> {
      turn += 1;
      if (turn === 1) {
        calls.push(tool);
        return {
          content: [{ type: 'tool_use', id: 'tu-1', name: tool, input: args }],
          stopReason: 'tool_use',
          usage: { input: 1, output: 1 },
          model: 'claude-test',
        };
      }
      return {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { input: 1, output: 1 },
        model: 'claude-test',
      };
    },
  };
}

suite('reminders and proposed schedules (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let ctx: CoreToolContext;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [emailManifest, memoryManifest, artifactsManifest]);
    await ensureOwner(pool, 'owner');
    ctx = { db: pool, ownerId: 'owner', now: () => NOW, timezone: TZ };
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('truncate core.reminders cascade');
    await pool.query('truncate core.jobs cascade');
    await pool.query('truncate core.approvals, core.actions cascade');
    await pool.query('truncate core.occurrences, core.schedule_specs, core.missions cascade');
  });

  /* ---------------- firing ---------------- */

  const enqueueRun = async (input: { agentId: string; prompt: string; dedupKey: string }) => {
    await enqueue(pool, {
      kind: AGENT_RUN_JOB_KIND,
      payload: { agentId: input.agentId, prompt: input.prompt },
      dedupKey: input.dedupKey,
    });
  };

  it('turns one due reminder into exactly one agent run, twice over', async () => {
    const created = await createReminder(pool, {
      agentId: 'finance-advisor',
      dueAt: new Date(NOW.getTime() + 2 * 3_600_000),
      text: 'check whether the card payment went out',
      now: NOW,
      timezone: TZ,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const at = new Date(NOW.getTime() + 3 * 3_600_000);
    const tick = createReminderTick({
      pool,
      now: () => at,
      timezone: TZ,
      enqueueRun,
      log: () => {},
    });

    expect(await tick()).toEqual({ fired: 1, expired: 0 });
    const jobs = await listJobs(pool, { kind: AGENT_RUN_JOB_KIND });
    expect(jobs).toHaveLength(1);
    expect((jobs[0] as Job).dedupKey).toBe(reminderDedupKey(created.reminder.id));

    // A second pass is a no-op on both sides of the handoff.
    expect(await tick()).toEqual({ fired: 0, expired: 0 });
    expect(await listJobs(pool, { kind: AGENT_RUN_JOB_KIND })).toHaveLength(1);
    expect(await dueReminders(pool, at)).toHaveLength(0);
    expect((await listReminders(pool, { state: 'fired' }))[0]?.id).toBe(created.reminder.id);
  });

  it('delivers nothing when the fired run decides the fact no longer matters', async () => {
    const created = await createReminder(pool, {
      agentId: MISSION_AGENT,
      dueAt: new Date(NOW.getTime() + 2 * 3_600_000),
      text: 'check whether the card payment went out',
      now: NOW,
      timezone: TZ,
    });
    if (!created.ok) throw new Error('setup');

    const at = new Date(NOW.getTime() + 3 * 3_600_000);
    await createReminderTick({ pool, now: () => at, timezone: TZ, enqueueRun, log: () => {} })();
    const job = (await listJobs(pool, { kind: AGENT_RUN_JOB_KIND }))[0] as Job;

    const registry = createToolRegistry();
    const catalog = fixtureCatalog(registry);
    const delivered: string[] = [];
    const calls: string[] = [];
    const handle = createAgentRunHandler({
      pool,
      registry,
      catalog,
      provider: decidingProvider('mission.silent', { reason: 'the card was already paid' }, calls),
      ctx,
      now: () => at,
      deliver: async (text) => {
        delivered.push(text);
        return 'chat';
      },
      log: () => {},
    });

    const outcome = (await handle({ ...job, attempts: 1 } as Job, jobContext())) as {
      decision: string;
      delivered: boolean;
      reason?: string;
    };
    expect(calls).toEqual(['mission.silent']);
    expect(outcome).toMatchObject({ decision: 'silent', delivered: false });
    expect(outcome.reason).toBe('the card was already paid');
    expect(delivered).toEqual([]);

    const { rows } = await pool.query(
      `select kind from core.events where kind in ('mission.silent', 'mission.delivered')`,
    );
    expect(rows.map((r) => r.kind)).toEqual(['mission.silent']);
  });

  /* ---------------- schedule.propose ---------------- */

  it('records an approval first and only then writes the mission and its schedule', async () => {
    const registry = createToolRegistry();
    const agentCtx: CoreToolContext = { ...ctx, agentId: 'finance-advisor' };

    const proposed = await registry.invoke(
      'schedule.propose',
      {
        name: 'Monday card check',
        cron: '0 8 * * MON',
        prompt: 'Check whether last week transfers landed, then report or stay silent.',
      },
      agentCtx,
    );
    expect(proposed).toMatchObject({ ok: false, reason: 'approval-required' });
    if (proposed.ok || proposed.reason !== 'approval-required') return;

    const missionId = agentMissionId('finance-advisor', 'monday-card-check');
    // Nothing exists yet: the proposal is a request, not a schedule.
    expect(await getMission(pool, missionId)).toBeNull();

    const pending = await listPendingActions(pool, { now: NOW });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.tool).toBe('schedule.propose');
    expect(pending[0]?.preview).toContain('every Monday at 08:00 America/New_York');
    expect(pending[0]?.envelope).toMatchObject({
      agentId: 'finance-advisor',
      missionId,
      cron: '0 8 * * MON',
      timezone: TZ,
      misfirePolicy: 'coalesce',
    });

    const decided = await decideApproval(pool, {
      actionId: proposed.actionId,
      decision: 'approved',
      by: 'owner',
      via: 'telegram',
      now: NOW,
    });
    expect(decided.ok).toBe(true);

    const executed = await executeApproved(pool, {
      actionId: proposed.actionId,
      registry,
      ctx,
      worker: 'test',
      now: NOW,
    });
    expect(executed.ok).toBe(true);

    const mission = await getMission(pool, missionId);
    expect(mission).toMatchObject({
      id: missionId,
      agentId: 'finance-advisor',
      enabled: true,
      // The notify policy applies: an agent's own schedule does not get to
      // speak unconditionally.
      alwaysDeliver: false,
    });
    const spec = await getActiveSchedule(pool, missionId);
    // No zone named: it follows the owner's zone when the Profile changes.
    expect(spec).toMatchObject({ cron: '0 8 * * MON', timezone: TZ, timezoneExplicit: false, misfirePolicy: 'coalesce' });
  });

  it('keeps a zone the agent named on purpose', async () => {
    const registry = createToolRegistry();
    const proposed = await registry.invoke(
      'schedule.propose',
      { name: 'Tokyo open', cron: '0 9 * * MON-FRI', timezone: 'Asia/Tokyo', prompt: 'Check the Tokyo open.' },
      { ...ctx, agentId: 'finance-advisor' },
    );
    if (proposed.ok || proposed.reason !== 'approval-required') throw new Error('expected an approval');
    await decideApproval(pool, { actionId: proposed.actionId, decision: 'approved', by: 'owner', via: 'telegram', now: NOW });
    expect((await executeApproved(pool, { actionId: proposed.actionId, registry, ctx, worker: 'test', now: NOW })).ok).toBe(true);
    const spec = await getActiveSchedule(pool, agentMissionId('finance-advisor', 'tokyo-open'));
    expect(spec).toMatchObject({ timezone: 'Asia/Tokyo', timezoneExplicit: true });
  });

  it('a built-in mission follows the owner zone unless its suggestion names one', async () => {
    const base = { agentId: 'finance-advisor', prompt: 'p' };
    await registerDefault(pool, { mission: { id: 'zone-follows', name: 'f', ...base }, cron: '0 8 * * *' }, 'Europe/Lisbon');
    await registerDefault(pool, { mission: { id: 'zone-pinned', name: 'p', ...base }, cron: '0 8 * * *', timezone: 'Asia/Tokyo' }, 'Europe/Lisbon');
    expect(await getActiveSchedule(pool, 'zone-follows')).toMatchObject({ timezone: 'Europe/Lisbon', timezoneExplicit: false });
    expect(await getActiveSchedule(pool, 'zone-pinned')).toMatchObject({ timezone: 'Asia/Tokyo', timezoneExplicit: true });
    // Registered again unchanged: up to date, no new revision.
    const again = await registerDefault(pool, { mission: { id: 'zone-follows', name: 'f', ...base }, cron: '0 8 * * *' }, 'Europe/Lisbon');
    expect(again).toMatchObject({ schedule: 'up-to-date', revision: 1 });
  });

  it('gives an agent\'s watch its stop condition and an end, then ends it quietly and keeps it listed', async () => {
    const registry = createToolRegistry();
    const agentCtx: CoreToolContext = { ...ctx, agentId: 'finance-advisor' };
    const proposed = await registry.invoke(
      'schedule.propose',
      { name: 'Store watch', cron: '0 * * * *', prompt: 'Check whether the listing is approved.', stopWhen: 'the listing is approved' },
      agentCtx,
    );
    if (proposed.ok || proposed.reason !== 'approval-required') throw new Error('expected an approval');
    const pending = await listPendingActions(pool, { now: NOW });
    expect(pending[0]?.preview).toContain('It stops itself when: the listing is approved');
    expect(pending[0]?.preview).toContain('It ends on its own after');
    await decideApproval(pool, { actionId: proposed.actionId, decision: 'approved', by: 'owner', via: 'telegram', now: NOW });
    expect((await executeApproved(pool, { actionId: proposed.actionId, registry, ctx, worker: 'test', now: NOW })).ok).toBe(true);

    const id = agentMissionId('finance-advisor', 'store-watch');
    const mission = await getMission(pool, id);
    expect(mission?.stopWhen).toBe('the listing is approved');
    // Thirty days, as nothing else was named.
    expect(mission?.endsAt?.getTime()).toBe(NOW.getTime() + 30 * 86_400_000);

    // The day after: switched off quietly, still listed, as ended.
    const after = new Date(NOW.getTime() + 31 * 86_400_000);
    expect(await endExpiredMissions(pool, after)).toEqual([id]);
    expect(await getMission(pool, id)).toMatchObject({ enabled: false, endedAt: after });
    // Switched back on by the owner: the end goes with it.
    expect(await setMissionEnabled(pool, id, true)).toMatchObject({ enabled: true, endsAt: null, endedAt: null });
    expect(await endExpiredMissions(pool, after)).toEqual([]);
  });

  it('refuses an end date already past', async () => {
    const registry = createToolRegistry();
    await expect(registry.invoke(
      'schedule.propose',
      { name: 'Late watch', cron: '0 * * * *', prompt: 'p', endsOn: '2020-01-01' },
      { ...ctx, agentId: 'finance-advisor' },
    )).resolves.toMatchObject({ ok: false });
    expect(await listPendingActions(pool, { now: NOW })).toHaveLength(0);
  });

  it('asks "Still useful?" once after 48 quiet runs; a report or Keep starts the count again', async () => {
    const id = agentMissionId('finance-advisor', 'quiet-watch');
    await upsertMission(pool, { id, name: 'Quiet watch', agentId: 'finance-advisor', prompt: 'p' });
    let asks = 0;
    for (let i = 0; i < 47; i++) if ((await noteMissionRun(pool, id, false, NOW)).ask) asks += 1;
    expect(asks).toBe(0);
    // A report in between resets the count.
    expect(await noteMissionRun(pool, id, true, NOW)).toEqual({ quietRuns: 0, ask: false });
    for (let i = 0; i < 47; i++) await noteMissionRun(pool, id, false, NOW);
    expect(await noteMissionRun(pool, id, false, NOW)).toEqual({ quietRuns: 48, ask: true });
    // Asked once, not on every run after.
    expect(await noteMissionRun(pool, id, false, NOW)).toEqual({ quietRuns: 49, ask: false });
    expect((await getMission(pool, id))?.stillUsefulAskedAt).toEqual(NOW);
    // Keep: the count and the question start again.
    expect(await keepMission(pool, id)).toMatchObject({ quietRuns: 0, stillUsefulAskedAt: null });
  });

  it('refuses a cron that would run more often than hourly, recording nothing', async () => {
    const registry = createToolRegistry();
    const result = await registry.invoke(
      'schedule.propose',
      { name: 'Constant', cron: '*/10 * * * *', prompt: 'look again' },
      { ...ctx, agentId: 'finance-advisor' },
    );
    expect(result).toMatchObject({ ok: false, reason: 'tool-error' });
    expect(await listPendingActions(pool, { now: NOW })).toHaveLength(0);
  });

  it('lets an agent stop its own schedule without asking, and nobody else\'s', async () => {
    const registry = createToolRegistry();
    const agentCtx: CoreToolContext = { ...ctx, agentId: 'finance-advisor' };
    const proposed = await registry.invoke(
      'schedule.propose',
      { name: 'Monday card check', cron: '0 8 * * MON', prompt: 'Check the transfers.' },
      agentCtx,
    );
    if (proposed.ok || proposed.reason !== 'approval-required') throw new Error('setup');
    await decideApproval(pool, {
      actionId: proposed.actionId,
      decision: 'approved',
      by: 'owner',
      via: 'telegram',
      now: NOW,
    });
    await executeApproved(pool, { actionId: proposed.actionId, registry, ctx, worker: 't', now: NOW });
    const missionId = agentMissionId('finance-advisor', 'monday-card-check');

    // Another agent cannot stop it.
    const stranger = await registry.invoke(
      'schedule.cancel_mine',
      { missionId },
      { ...ctx, agentId: 'credit-coach' },
    );
    expect(stranger.ok && (stranger.output as { reason: string }).reason).toBe('not-yours');
    expect((await getMission(pool, missionId))?.enabled).toBe(true);

    // Its own, it may always stop — no approval anywhere in this path.
    const own = await registry.invoke('schedule.cancel_mine', { missionId }, agentCtx);
    expect(own.ok && (own.output as { ok: boolean }).ok).toBe(true);
    expect((await getMission(pool, missionId))?.enabled).toBe(false);
    expect(await listPendingActions(pool, { now: NOW })).toHaveLength(0);
  });

  it('lists an agent\'s own schedules and never the owner\'s', async () => {
    const registry = createToolRegistry();
    const agentCtx: CoreToolContext = { ...ctx, agentId: 'finance-advisor' };
    const proposed = await registry.invoke(
      'schedule.propose',
      { name: 'Monday card check', cron: '0 8 * * MON', prompt: 'Check the transfers.' },
      agentCtx,
    );
    if (proposed.ok || proposed.reason !== 'approval-required') throw new Error('setup');
    await decideApproval(pool, {
      actionId: proposed.actionId,
      decision: 'approved',
      by: 'owner',
      via: 'telegram',
      now: NOW,
    });
    await executeApproved(pool, { actionId: proposed.actionId, registry, ctx, worker: 't', now: NOW });

    const listed = await registry.invoke('schedule.list_mine', {}, agentCtx);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const { schedules } = listed.output as { schedules: { missionId: string; cadence: string }[] };
    expect(schedules).toHaveLength(1);
    expect(schedules[0]?.cadence).toBe('every Monday at 08:00 America/New_York');

    const others = await registry.invoke('schedule.list_mine', {}, { ...ctx, agentId: 'concierge' });
    expect(others.ok && (others.output as { schedules: unknown[] }).schedules).toEqual([]);
  });
});
