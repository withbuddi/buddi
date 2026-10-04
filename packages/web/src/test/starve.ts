/**
 * A starved scheduler, for `vitest.starve.config.ts` only.
 *
 * React's Scheduler runs its work, passive effects among it, on setImmediate.
 * A loaded CI runner reaches that work late, after promises the test is
 * awaiting have already settled; that ordering is what made tests pass here
 * and fail on the gate. This pushes every setImmediate back by up to
 * STARVE_MS (default 30) of real time, a random amount each when STARVE_JITTER
 * is set, so those races fail on a laptop too.
 */
const real = globalThis.setImmediate;
const realTimeout = globalThis.setTimeout;
const most = Number(process.env.STARVE_MS ?? 30);
const jitter = process.env.STARVE_JITTER !== undefined;
const starved = (fn: (...args: unknown[]) => void, ...args: unknown[]): NodeJS.Immediate =>
  real(() => realTimeout(() => fn(...args), jitter ? Math.random() * most : most));
globalThis.setImmediate = starved as unknown as typeof setImmediate;
