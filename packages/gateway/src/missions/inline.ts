/**
 * A mission, run *now*, because the owner asked.
 *
 * `/recap` in Telegram and `/recap` at the terminal prompt are the same thing:
 * the scheduler's own executor, driven by hand, with the answer handed back to
 * whoever asked instead of delivered. Extracted from `serve.ts` so a surface
 * that is not `buddi serve` — the CLI is a separate process — can offer the
 * command without pulling the whole server in behind it.
 *
 * The occurrence is written claimed and closed out like any other run, so an
 * on-demand recap shows up in the mission's history.
 */
import { finishOccurrence, getActiveSchedule, getMission } from '@buddi/core';
import { insertOccurrence } from '../missions-cli.js';
import type { MissionOutcome, RunMission } from '../telegram/surface.js';
import { createMissionExecutor, type MissionExecutorDeps } from './execute.js';
import { createDigestPrepare } from './recap.js';

/** What `createInlineMissionRunner` needs: an executor's deps minus delivery. */
export type InlineMissionDeps = Omit<
  MissionExecutorDeps,
  'deliver' | 'onToolCall' | 'requireDelivery' | 'notifyPolicy' | 'prepare'
>;

/**
 * `/recap`: run a mission *now*, through the very executor the scheduler uses,
 * and hand the text back to the surface that asked.
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

