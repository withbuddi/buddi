/**
 * The one line that says a run is alive.
 *
 * Telegram gets a bubble it edits; a terminal gets a single line it rewrites in
 * place — the elapsed seconds and what the agent is doing right now, in the
 * same human words the Telegram progress line uses (`toolLabel`), erased the
 * moment the answer is ready so the transcript holds no spinner debris.
 *
 * Two properties make it safe to run anywhere:
 *
 *  - **Disabled is a real mode.** Not a TTY, or `NO_COLOR`, or `--quiet`: the
 *    spinner writes nothing at all, rather than spraying escape codes into a
 *    pipe. `buddi ask` runs with it off.
 *  - **The state machine is separate from the timer.** `line()` is pure, so a
 *    test asserts what the owner would see without a terminal, and the timer is
 *    an ordinary `setInterval` that fake timers drive.
 */
import { toolLabel } from '../telegram/surface.js';

/** Braille dots: one column wide in every terminal worth supporting. */
export const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export const FRAME_INTERVAL_MS = 120;

/** Erase the current line and park the cursor at column 0. */
export const CLEAR_LINE = '\u001b[2K\r';

export interface SpinnerOptions {
  /** Where the line goes. `process.stderr.write`, or a test's collector. */
  write(chunk: string): void;
  /** False when the output is not a terminal, or the owner asked for quiet. */
  enabled: boolean;
  /** Milliseconds since epoch. Injected so elapsed time is testable. */
  now?: () => number;
  intervalMs?: number;
}

/**
 * A spinner with three states — idle, running, stopped — and no way to write
 * anything while idle. Restarting after `stop()` is allowed and starts clean.
 */
export class Spinner {
  readonly #opts: SpinnerOptions;
  readonly #now: () => number;
  #timer: NodeJS.Timeout | null = null;
  #startedAt = 0;
  #frame = 0;
  #label = '';
  #activity = '';
  #dirty = false;

  constructor(opts: SpinnerOptions) {
    this.#opts = opts;
    this.#now = opts.now ?? ((): number => Date.now());
  }

  get running(): boolean {
    return this.#timer !== null;
  }

  /** Seconds since `start`, floored — what the line shows. */
  get elapsedSeconds(): number {
    return this.#startedAt === 0 ? 0 : Math.floor((this.#now() - this.#startedAt) / 1000);
  }

  /** The current line, exactly as it would be written. Pure. */
  line(): string {
    const what = this.#activity === '' ? this.#label : this.#activity;
    const frame = FRAMES[this.#frame % FRAMES.length] as string;
    return `${frame} ${this.elapsedSeconds}s${what === '' ? '' : ` · ${what}`}`;
  }

  /** Begin. `label` is who is working — the agent's handle, capitalized. */
  start(label = ''): void {
    if (this.#timer !== null) return;
    this.#startedAt = this.#now();
    this.#frame = 0;
    this.#label = label === '' ? '' : `${label} is working`;
    this.#activity = '';
    if (!this.#opts.enabled) return;
    this.#render();
    const timer = setInterval(() => {
      this.#frame++;
      this.#render();
    }, this.#opts.intervalMs ?? FRAME_INTERVAL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    this.#timer = timer;
  }

  /**
   * The runtime's callback. Synchronous and cheap: a progress line must never
   * make the run wait, and it must never change what the run does.
   */
  noteToolCall(name: string): void {
    this.#activity = toolLabel(name);
    if (this.#opts.enabled && this.#timer !== null) this.#render();
  }

  /** Erase the line and stop. Idempotent. */
  stop(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
    if (this.#dirty) {
      this.#opts.write(CLEAR_LINE);
      this.#dirty = false;
    }
    this.#startedAt = 0;
    this.#activity = '';
  }

  #render(): void {
    this.#opts.write(`${CLEAR_LINE}${this.line()}`);
    this.#dirty = true;
  }
}

/** A spinner that is never enabled — `buddi ask`, a pipe, `--quiet`. */
export function silentSpinner(): Spinner {
  return new Spinner({ write: () => {}, enabled: false });
}
