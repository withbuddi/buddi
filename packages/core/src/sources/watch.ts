/**
 * Source watchers — the long-lived half a source may have beside its poll
 * (`Source.watch`, host API 1.15).
 *
 * The poll is scheduled by the ledger (`run.ts`); a watcher is not scheduled
 * at all. It is started once the plugin is loaded and stopped when the plugin
 * is taken out or the process stops, and in between it owns its own sockets
 * and timers. This file only keeps that lifecycle honest:
 *
 *  1. **Reconciled, not wired.** The source loop hands over the manifests on
 *     every tick; a source with a `watch` that is not running is started, and
 *     a running one whose source is gone (plugin disabled) or replaced (plugin
 *     reloaded) is stopped. Nothing else has to remember to call stop.
 *  2. **A live clock.** A poll's context reads the tick's instant; a watcher
 *     lives for days, so its context reads `now()` every time.
 *  3. **One watcher's failure is its own.** A `watch` that throws is logged
 *     and tried again next tick; a `stop` that throws is logged and forgotten.
 */
import type { Pool } from 'pg';
import type { CoreSourceContext, PluginManifest, Source, SourceWatch } from '../tools.js';
import { createPluginHost, hostBindingOf } from '../host/build.js';

export type SourceWatchInput = {
  /** The live clock. Called every time, never captured. */
  now: () => Date;
  timezone: string;
  enqueueRun: CoreSourceContext['enqueueRun'];
  log?: (line: string) => void;
};

export interface SourceWatches {
  /** Start what should run and is not; stop what runs and should not. */
  reconcile(manifests: PluginManifest[], input: SourceWatchInput): Promise<void>;
  /** Stop every watcher. Idempotent; later reconciles start nothing. */
  stopAll(): Promise<void>;
  /** The ids of the sources whose watcher is running, for logs and tests. */
  running(): string[];
}

export function createSourceWatches(pool: Pool): SourceWatches {
  const live = new Map<string, { source: Source; watch: SourceWatch }>();
  /** Stops under way: a second caller waits for the same one, not for nothing. */
  const stopping = new Map<string, Promise<void>>();
  let stopped = false;
  let allStopped: Promise<void> | null = null;

  const stopOne = (id: string, log: (line: string) => void): Promise<void> => {
    const pending = stopping.get(id);
    if (pending) return pending;
    const entry = live.get(id);
    if (!entry) return Promise.resolve();
    live.delete(id);
    const done = (async () => {
      try {
        await entry.watch.stop();
      } catch (err) {
        log(`source ${id}: watcher did not stop cleanly: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        stopping.delete(id);
      }
    })();
    stopping.set(id, done);
    return done;
  };

  return {
    async reconcile(manifests, input) {
      const log = input.log ?? ((line: string) => console.error(line));
      if (stopped) return;
      const wanted = new Map<string, { source: Source; manifest: PluginManifest }>();
      for (const manifest of manifests) {
        for (const source of manifest.sources ?? []) {
          if (typeof source.watch === 'function' && !wanted.has(source.id)) wanted.set(source.id, { source, manifest });
        }
      }
      for (const [id, entry] of [...live]) {
        if (wanted.get(id)?.source !== entry.source) await stopOne(id, log);
      }
      for (const [id, { source, manifest }] of wanted) {
        if (live.has(id) || stopped) continue;
        const ctx: CoreSourceContext = {
          db: pool,
          now: () => input.now(),
          timezone: input.timezone,
          log,
          enqueueRun: input.enqueueRun,
        };
        try {
          ctx.buddi = createPluginHost(hostBindingOf(manifest), ctx);
          live.set(id, { source, watch: source.watch!(ctx) });
        } catch (err) {
          log(`source ${id}: watcher did not start: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
    stopAll() {
      // The signal handler's call and the shutdown path's `finally` both
      // land here: the second gets the first's promise, so nothing (the pool
      // ending) runs while a watcher is still stopping.
      if (allStopped) return allStopped;
      stopped = true;
      const log = (line: string): void => console.error(line);
      allStopped = Promise.all([...[...live.keys()].map((id) => stopOne(id, log)), ...stopping.values()]).then(() => {});
      return allStopped;
    },
    running() {
      return [...live.keys()];
    },
  };
}
