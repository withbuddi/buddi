/**
 * What every surface needs to know about proactive messages: two verbs.
 *
 * `/quiet` has to mean the same thing typed into Telegram and typed at the
 * terminal, and "the owner answered" has to count from either. Both live here
 * so neither surface re-decides them — a surface routes the word and prints the
 * sentence; it never parses a duration or writes a counter.
 */
import { localDateTimeString, type Queryable } from '@buddi/core';
import { parseQuiet, quietConfirmation } from './nudge-policy.js';
import { noteOwnerActivity, setQuietUntil } from './nudge-state.js';

/** The port a surface is handed. Absent in a build with no arc at all. */
export interface EngagementHooks {
  /** `/quiet`, `/quiet 1d`, `/quiet 1w`, `/quiet off` — the line to reply with. */
  quiet(arg: string): Promise<string>;
  /**
   * The owner said something, on this surface. Never allowed to throw: a failed
   * counter must not cost them their answer.
   */
  noteActivity(): Promise<void>;
}

export interface EngagementDeps {
  pool: Queryable;
  now: () => Date;
  timezone: string;
  /** The line shown when there is no onboarding row to write to. */
  unavailableText: string;
  log?: (line: string) => void;
}

export function createEngagementHooks(deps: EngagementDeps): EngagementHooks {
  const log = deps.log ?? ((line: string) => console.error(line));
  return {
    async quiet(arg: string): Promise<string> {
      const now = deps.now();
      const request = parseQuiet(arg, now);
      if (request.kind === 'unparsable') return quietConfirmation(request);

      const until = request.kind === 'off' ? null : request.until;
      const written = await setQuietUntil(deps.pool, until, now);
      if (!written) return deps.unavailableText;
      return quietConfirmation(
        request,
        until ? localDateTimeString(until, deps.timezone) : undefined,
      );
    },
    async noteActivity(): Promise<void> {
      try {
        await noteOwnerActivity(deps.pool, deps.now());
      } catch (err) {
        log(`engagement: could not clear the unanswered counter: ${
          err instanceof Error ? err.message : String(err)
        }`);
      }
    },
  };
}
