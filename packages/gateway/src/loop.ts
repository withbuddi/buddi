/**
 * An independent background loop — the antidote to "one slow thing stops
 * everything".
 *
 * `buddi serve` used to run the sentinels and the sources *inside* the
 * scheduler pass, on the reasonable-sounding grounds that a finding enqueued
 * now should be claimed in the same pass. The cost of that coupling only shows
 * up in production: an IMAP poll that never returns took materialization,
 * mission claiming and the stale-claim sweep down with it, and the symptom was
 * not "mail is slow" but "the scheduler stopped". A watcher that reaches the
 * network is not allowed to be on the critical path of the clock.
 *
 * So each of them gets a loop of its own, with the two properties that make an
 * unattended loop survivable:
 *
 *  - **Non-overlapping.** A tick that arrives while the previous one is still
 *    running is skipped, loudly, with the elapsed time — so a mailbox that has
 *    gone quiet reads as one line every period rather than as silence.
 *  - **Hard abort.** A run still going after `abortAfterMs` is *abandoned*: the
 *    promise cannot be cancelled, but the loop stops waiting on it and lets the
 *    next tick start clean. Combined with the per-call deadlines inside the
 *    poll itself, a wedged run can never permanently own the loop.
 *
 * The loop is also cheap to test: `autoStart: false` plus `tick()` drives it by
 * hand, with no timers involved.
 */

export interface LoopOptions {
  /** Name used in every log line. */
  name: string;
  /** Delay between ticks, ms. */
  everyMs: number;
  /** The work. Its own errors are logged, never thrown out of the loop. */
  run: () => Promise<void>;
  /**
   * After this long, an in-flight run is abandoned and the next tick is allowed
   * to start. Defaults to 2x `everyMs`.
   */
  abortAfterMs?: number;
  /** Milliseconds since epoch. Injected so tests do not sleep. */
  now?: () => number;
  log?: (line: string) => void;
  /** Run the first tick immediately on start (default true). */
  runImmediately?: boolean;
  /** Start the timer (default true). Tests drive `tick()` instead. */
  autoStart?: boolean;
}

export interface LoopHandle {
  /**
   * Try to run one tick. Resolves to what happened, so a test can assert the
   * skip without reading logs: `ran`, `skipped` (previous still running) or
   * `abandoned` (previous exceeded the hard abort and was dropped).
   */
  tick(): Promise<'ran' | 'skipped' | 'abandoned'>;
  /** Whether a run is currently in flight. */
  readonly busy: boolean;
  stop(): void;
}

export function startLoop(opts: LoopOptions): LoopHandle {
  const now = opts.now ?? (() => Date.now());
  const log = opts.log ?? ((line: string) => console.error(line));
  const abortAfterMs = opts.abortAfterMs ?? opts.everyMs * 2;

  /** When the in-flight run started, or null when idle. */
  let startedAt: number | null = null;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async (): Promise<'ran' | 'skipped' | 'abandoned'> => {
    let outcome: 'ran' | 'abandoned' = 'ran';
    if (startedAt !== null) {
      const elapsed = now() - startedAt;
      if (elapsed < abortAfterMs) {
        log(`${opts.name}: poll still running (${elapsed}ms elapsed) — skipping this tick`);
        return 'skipped';
      }
      // Past the hard deadline. We cannot kill the promise, but we can stop
      // letting it own the loop; whatever it eventually does is its own affair.
      log(
        `${opts.name}: poll still running after ${elapsed}ms (hard abort at ${abortAfterMs}ms) — ` +
          `abandoning it and starting a fresh one`,
      );
      outcome = 'abandoned';
    }

    startedAt = now();
    const mine = startedAt;
    try {
      await opts.run();
    } catch (err) {
      log(`${opts.name}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Only the *current* run clears the guard: an abandoned run that finishes
      // late must not release a newer one's claim on the loop.
      if (startedAt === mine) startedAt = null;
    }
    return outcome;
  };

  const schedule = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().finally(schedule);
    }, opts.everyMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  if (opts.autoStart !== false) {
    if (opts.runImmediately !== false) {
      void tick().finally(schedule);
    } else {
      schedule();
    }
  }

  return {
    tick,
    get busy(): boolean {
      return startedAt !== null;
    },
    stop(): void {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
