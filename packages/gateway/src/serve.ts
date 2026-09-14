#!/usr/bin/env node
/**
 * `buddi serve` — one process, both halves of the installation.
 *
 * The Telegram surface (inbound: the owner asks) and the scheduler runner
 * (outbound: missions deliver) share one pool, one registry and one resolved
 * provider. They are otherwise independent: the surface polls Telegram, the
 * runner materializes and drains occurrences, and a signal stops both, waiting
 * for in-flight work rather than cutting it off.
 *
 * Stale claims are released every tick: a claim older than fifteen minutes is a
 * process that died mid-run, and the occurrence goes back to `pending` rather
 * than sitting claimed forever.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  finishOccurrence,
  getActiveSchedule,
  getMission,
  listMissions,
  nextAfter,
  releaseStaleClaims,
  runScheduler,
  runSentinels,
  collectSentinels,
  type Mission,
} from '@buddi/core';
import type { Pool } from 'pg';
import { createWiring, loadEnv } from './bootstrap.js';
import { insertOccurrence } from './missions-cli.js';
import { createMissionExecutor, type MissionExecutorDeps } from './missions/execute.js';
import { createDigestPrepare } from './missions/recap.js';
import { notifyOwner } from './telegram/notify.js';
import { describePaired, startTelegram } from './telegram/main.js';
import type { MissionOutcome, RunMission } from './telegram/surface.js';

/** Scheduler cadence and the age at which a claim is considered abandoned. */
export const TICK_MS = 30_000;
export const STALE_CLAIM_MS = 15 * 60_000;

export interface MissionLine {
  mission: Mission;
  cron?: string;
  timezone?: string;
  next?: Date | null;
}

/** Every mission with the next instant its active schedule would fire. */
export async function describeMissions(pool: Pool, now: Date): Promise<MissionLine[]> {
  const missions = await listMissions(pool);
  const lines: MissionLine[] = [];
  for (const mission of missions) {
    const spec = await getActiveSchedule(pool, mission.id);
    if (!spec) {
      lines.push({ mission });
      continue;
    }
    lines.push({
      mission,
      cron: spec.cron,
      timezone: spec.timezone,
      next: mission.enabled ? nextAfter(spec.cron, now, spec.timezone) : null,
    });
  }
  return lines;
}

export function formatMissionLine(line: MissionLine): string {
  const { mission } = line;
  const state = mission.enabled ? '' : ' [disabled]';
  if (!line.cron) return `  ${mission.id} (${mission.agentId})${state} — no schedule`;
  const next = line.next
    ? `next ${line.next.toISOString()}`
    : mission.enabled
      ? 'next (never)'
      : 'next (disabled)';
  return `  ${mission.id} (${mission.agentId})${state} — ${line.cron} ${line.timezone} — ${next}`;
}

/** What `createInlineMissionRunner` needs: an executor's deps minus delivery. */
export type InlineMissionDeps = Omit<
  MissionExecutorDeps,
  'deliver' | 'onToolCall' | 'requireDelivery' | 'notifyPolicy' | 'prepare'
>;

/**
 * `/recap` in Telegram: run a mission *now*, through the very executor the
 * scheduler uses, and hand the text back to the chat that asked.
 *
 * The occurrence is written claimed and closed out like any other run, so an
 * on-demand recap shows up in the mission's history. Delivery is a no-op that
 * only names the chat: the surface already owns the bubble the answer lands in,
 * and sending it twice would be the bug.
 */
export function createInlineMissionRunner(base: InlineMissionDeps): RunMission {
  return async function runMission(missionId, chatId, onToolCall): Promise<MissionOutcome> {
    const mission = await getMission(base.pool, missionId);
    if (!mission) return { ok: false, reason: 'unknown-mission' };

    const spec = await getActiveSchedule(base.pool, mission.id);
    const occurrence = await insertOccurrence(
      base.pool,
      mission.id,
      spec?.revision ?? 0,
      base.now(),
      'claimed',
    );
    const execute = createMissionExecutor({
      ...base,
      deliver: async () => chatId,
      // The owner asked for this one, in a chat that is open: the answer belongs
      // in the bubble whatever the run decided about notifying.
      notifyPolicy: false,
      prepare: createDigestPrepare(base.pool, { now: base.now }),
      ...(onToolCall ? { onToolCall } : {}),
    });

    try {
      const result = await execute(occurrence, mission);
      await finishOccurrence(base.pool, occurrence.id, {
        state: 'succeeded',
        runConversationId: result.conversationId,
      });
      return { ok: true, text: result.text };
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      await finishOccurrence(base.pool, occurrence.id, { state: 'failed', error: text }).catch(
        () => {},
      );
      throw err;
    }
  };
}

export async function main(): Promise<void> {
  loadEnv();

  let wiring;
  try {
    wiring = createWiring(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const { pool, now } = wiring;

  try {
    const missionDeps = {
      pool,
      registry: wiring.registry,
      catalog: wiring.catalog,
      provider: wiring.provider,
      ctx: wiring.ctx,
      env: process.env,
      now,
    };

    const telegram = await startTelegram({
      ...missionDeps,
      runMission: createInlineMissionRunner(missionDeps),
    });

    const execute = createMissionExecutor({
      ...missionDeps,
      deliver: (text) => notifyOwner(text, { pool, env: process.env }),
      prepare: createDigestPrepare(pool, { now }),
    });

    // The watchers. They run inside the scheduler tick, before materialization,
    // so an urgent finding enqueued now is claimed in the same pass.
    const sentinels = collectSentinels(wiring.registry.manifests());
    const sentinelTick = async (): Promise<void> => {
      const outcomes = await runSentinels(pool, wiring.registry.manifests(), now(), wiring.timezone);
      for (const outcome of outcomes) {
        if (!outcome.ran) continue;
        if (outcome.error) {
          console.error(`sentinel ${outcome.sentinelId}: ${outcome.error}`);
          continue;
        }
        if (outcome.fired > 0 || outcome.resolved > 0) {
          console.log(
            `sentinel ${outcome.sentinelId}: ${outcome.findings} finding(s), ${outcome.fired} fired, ${outcome.resolved} resolved`,
          );
        }
      }
    };

    const sweepStaleClaims = async (): Promise<void> => {
      const released = await releaseStaleClaims(pool, new Date(now().getTime() - STALE_CLAIM_MS));
      if (released > 0) console.error(`scheduler: released ${released} stale claim(s)`);
    };
    await sweepStaleClaims();
    const sweep = setInterval(() => {
      void sweepStaleClaims().catch((err) =>
        console.error(`scheduler: stale-claim sweep failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    }, TICK_MS);
    if (typeof sweep.unref === 'function') sweep.unref();

    const scheduler = runScheduler({
      pool,
      now,
      tickMs: TICK_MS,
      sentinelTick,
      execute: async (occurrence, mission) => {
        const result = await execute(occurrence, mission);
        console.log(
          result.delivered
            ? `mission ${mission.id} delivered (${result.text.length} chars) → conversation ${result.conversationId}`
            : `mission ${mission.id} stayed silent (${result.reason ?? result.decision}) → conversation ${result.conversationId}`,
        );
        return { conversationId: result.conversationId };
      },
      onError: (err) =>
        console.error(`scheduler: ${err instanceof Error ? err.message : String(err)}`),
    });

    const missions = await describeMissions(pool, now());

    console.log('buddi serve — telegram surface + scheduler');
    console.log(`  bot: @${telegram.botUsername ?? '(unknown)'} (id ${telegram.botId})`);
    console.log(`  paired owner ids: ${describePaired(telegram.paired)}`);
    console.log(`  model: ${wiring.model} (${wiring.credentialKind})`);
    console.log(`  scheduler: tick ${TICK_MS / 1000}s, stale claims released after ${STALE_CLAIM_MS / 60_000}m`);
    console.log(
      sentinels.length === 0
        ? '  sentinels: none installed'
        : `  sentinels (${sentinels.length}): ${sentinels
            .map((s) => `${s.id} every ${s.every}s`)
            .join(', ')}`,
    );
    console.log(
      missions.length === 0
        ? '  missions: none registered (pnpm missions add-friday-recap)'
        : `  missions (${missions.length}):`,
    );
    for (const line of missions) console.log(formatMissionLine(line));
    console.log(`  last cursor: ${telegram.cursor ?? '(none)'}`);

    let stopping = false;
    const shutdown = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      console.log(`\n${signal}: stopping scheduler and telegram surface…`);
      clearInterval(sweep);
      void Promise.all([scheduler.stop(), telegram.stop()]);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    await Promise.all([telegram.done, scheduler.done]);
    console.log('buddi serve stopped cleanly');
  } finally {
    await pool.end();
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    process.exit(1);
  });
}
