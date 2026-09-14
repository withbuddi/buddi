import type { Pool } from 'pg';
import { appendEvent } from '../events.js';
import { claimNextOccurrence, finishOccurrence } from './claim.js';
import { materializeOccurrences } from './materialize.js';
import { getMission } from './missions.js';
import type { Mission, Occurrence } from './types.js';

export type ExecuteResult = {
  conversationId?: string;
  /**
   * The occurrence was handed to the durable queue rather than run here.
   *
   * `buddi serve` returns this: the scheduler's job is to decide *when*, and a
   * queued job owns the run from then on — including closing the occurrence out
   * when it finishes. The runner therefore leaves the row `claimed` and records
   * `occurrence.queued` instead of pretending the mission already succeeded.
   * A claim that is never closed is not lost: the stale-claim sweep releases it
   * and the re-enqueue is idempotent (dedup key = occurrence id).
   */
  deferred?: boolean;
};

export type RunSchedulerOptions = {
  pool: Pool;
  /** Clock injection — tests drive a simulated week of sleep through this. */
  now: () => Date;
  /** Idle delay between passes, milliseconds. */
  tickMs: number;
  /**
   * Run the mission. Injected on purpose: core never imports the runtime or a
   * gateway (the boundary check enforces it), so "execute the agent" arrives
   * from the layer above.
   */
  execute: (occurrence: Occurrence, mission: Mission) => Promise<ExecuteResult>;
  /**
   * Run the deterministic watchers, before anything is materialized.
   *
   * Injected rather than built here: the sentinels come from installed plugin
   * manifests, which core does not import. A sentinel that fails is the
   * sentinel runner's problem — this hook never takes the scheduler down with
   * it (errors go to `onError` and the pass continues).
   */
  sentinelTick?: () => Promise<void>;
  /** Max occurrences drained per pass, so one pass cannot starve the loop. */
  maxPerTick?: number;
  /** Start the background loop immediately (default true). Tests drive `tick()`. */
  autoStart?: boolean;
  onError?: (err: unknown) => void;
};

export type SchedulerHandle = {
  /** Run exactly one pass: materialize, then drain due occurrences. */
  tick(): Promise<{ materialized: number; executed: number }>;
  /** Stop the loop and wait for the in-flight pass to finish. */
  stop(): Promise<void>;
  /** Resolves when the loop has exited. */
  readonly done: Promise<void>;
};

/**
 * The scheduler loop: materialize -> claim -> execute -> finish.
 *
 * Every transition appends to core.events (`occurrence.materialized`,
 * `occurrence.claimed`, `occurrence.finished`), so the event log alone explains
 * why a mission ran, did not run, or failed.
 */
export function runScheduler(opts: RunSchedulerOptions): SchedulerHandle {
  const { pool, now, tickMs, execute } = opts;
  const maxPerTick = opts.maxPerTick ?? 100;
  let running = true;
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  let timer: NodeJS.Timeout | null = null;
  let wake: (() => void) | null = null;

  const tick = async (): Promise<{ materialized: number; executed: number }> => {
    if (opts.sentinelTick) {
      try {
        await opts.sentinelTick();
      } catch (err) {
        opts.onError?.(err);
      }
    }

    const materialized = await materializeOccurrences(pool, now());
    for (const occ of materialized) {
      await appendEvent(pool, 'occurrence.materialized', {
        occurrenceId: occ.id,
        missionId: occ.missionId,
        scheduleRevision: occ.scheduleRevision,
        scheduledAt: occ.scheduledAt.toISOString(),
        state: occ.state,
      });
    }

    let executed = 0;
    while (executed < maxPerTick) {
      const occurrence = await claimNextOccurrence(pool, now());
      if (!occurrence) break;
      executed += 1;
      await appendEvent(pool, 'occurrence.claimed', {
        occurrenceId: occurrence.id,
        missionId: occurrence.missionId,
        scheduledAt: occurrence.scheduledAt.toISOString(),
      });

      let finished: Occurrence | null = null;
      try {
        const mission = await getMission(pool, occurrence.missionId);
        if (!mission) throw new Error(`mission "${occurrence.missionId}" disappeared`);
        const result = await execute(occurrence, mission);
        if (result?.deferred) {
          await appendEvent(
            pool,
            'occurrence.queued',
            {
              occurrenceId: occurrence.id,
              missionId: occurrence.missionId,
              scheduledAt: occurrence.scheduledAt.toISOString(),
            },
            result.conversationId ?? undefined,
          );
          continue;
        }
        finished = await finishOccurrence(pool, occurrence.id, {
          state: 'succeeded',
          runConversationId: result?.conversationId ?? null,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        finished = await finishOccurrence(pool, occurrence.id, {
          state: 'failed',
          error: message,
        });
        opts.onError?.(err);
      }

      await appendEvent(
        pool,
        'occurrence.finished',
        {
          occurrenceId: occurrence.id,
          missionId: occurrence.missionId,
          scheduledAt: occurrence.scheduledAt.toISOString(),
          state: finished?.state ?? 'unknown',
          error: finished?.error ?? null,
        },
        finished?.runConversationId ?? undefined,
      );
    }

    return { materialized: materialized.length, executed };
  };

  const loop = async (): Promise<void> => {
    while (running) {
      try {
        await tick();
      } catch (err) {
        opts.onError?.(err);
      }
      if (!running) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, tickMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
      wake = null;
    }
    resolveDone();
  };

  if (opts.autoStart !== false) {
    void loop();
  } else {
    running = false;
    resolveDone();
  }

  return {
    tick,
    done,
    async stop(): Promise<void> {
      running = false;
      if (timer) clearTimeout(timer);
      wake?.();
      await done;
    },
  };
}
