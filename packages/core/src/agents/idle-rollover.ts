/**
 * How long a chat with an agent may sit idle before the next message starts a
 * fresh conversation (docs/agents.md, "Idle rollover").
 *
 * An agent file may say `idleRollover: 1d`. Absent, it is three hours: a new
 * sitting. `never` turns the idle rule off for that agent only; the size rule
 * (`conversation-lifetime.ts` in the gateway) still applies, because a
 * transcript past its budget is charged for on every turn whatever the clock
 * says.
 */

/** The values the Brain tab offers and the frontmatter accepts. */
export const IDLE_ROLLOVERS = ['3h', '1d', '1w', 'never'] as const;
export type IdleRollover = (typeof IDLE_ROLLOVERS)[number];

/** What an agent that says nothing gets. */
export const DEFAULT_IDLE_ROLLOVER: IdleRollover = '3h';

const HOUR = 60 * 60_000;
const SPANS: Record<IdleRollover, number> = {
  '3h': 3 * HOUR,
  '1d': 24 * HOUR,
  '1w': 7 * 24 * HOUR,
  never: Number.POSITIVE_INFINITY,
};

/** The setting in milliseconds; `never` is `Infinity`, which no gap exceeds. */
export function idleRolloverMs(setting: IdleRollover | undefined): number {
  return SPANS[setting ?? DEFAULT_IDLE_ROLLOVER];
}

/** Is this a value an agent file may carry? */
export function isIdleRollover(value: unknown): value is IdleRollover {
  return typeof value === 'string' && (IDLE_ROLLOVERS as readonly string[]).includes(value);
}
