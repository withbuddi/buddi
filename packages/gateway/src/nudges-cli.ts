/**
 * `buddi nudges` — the owner's view of, and switch for, the first-run arc.
 *
 * The arc is the one thing in this installation that speaks without being
 * asked, so it is the one thing that most needs a single place to see what it
 * has done and to end it. Three verbs, no options: what has it sent, stop, and
 * start again.
 *
 * `stop` and `resume` write the `engagement` preference — the same stated
 * preference an agent writes when the owner says "stop suggesting things" — so
 * the command line and the conversation cannot disagree about it.
 */
import { getMission, localDateTimeString, setMissionEnabled, timezoneFromEnv } from '@buddi/core';
import type { Pool } from 'pg';
import { createWiringAsync, loadEnv } from './bootstrap.js';
import { GETTING_STARTED_ID } from './missions/getting-started.js';
import {
  arcWindow,
  nudgePolicy,
  refusalText,
  MAX_NUDGES,
  MAX_UNANSWERED,
} from './missions/nudge-policy.js';
import {
  noteOwnerActivity,
  readArcState,
  readEngagement,
  setQuietUntil,
  writeEngagement,
} from './missions/nudge-state.js';

export const USAGE = `buddi nudges — the first-run arc

  buddi nudges status     what it has sent, and whether it is still running
  buddi nudges stop       stop it, permanently, until you ask for it back
  buddi nudges resume     start it again`;

export type NudgesCommand = 'status' | 'stop' | 'resume' | 'help';

/** Pure argument parsing — the only part worth a unit test. */
export function parseNudgesArgs(argv: string[]): NudgesCommand {
  const [head, ...rest] = argv;
  if (head === undefined) return 'status';
  if (head === 'help' || head === '--help' || head === '-h') return 'help';
  if (head !== 'status' && head !== 'stop' && head !== 'resume') {
    throw new Error(`unknown action for buddi nudges: ${head} (expected status, stop or resume)`);
  }
  if (rest.length > 0) throw new Error(`unexpected argument: ${rest[0]}`);
  return head;
}

export interface StatusView {
  nudgesSent: number;
  unanswered: number;
  quietUntil: Date | null;
  /** The mission row's own flag. */
  missionEnabled: boolean | null;
  window: { open: boolean; reason: string };
  engagement: 'arc' | 'quiet' | undefined;
  /** Why it would not speak right now, if it would not. */
  blocked: string | null;
}

/**
 * The report, as text. Pure so the sentences are testable without a database —
 * and so "active" is never asserted by two different pieces of code.
 */
export function statusText(view: StatusView, timezone: string): string {
  const active =
    view.engagement !== 'quiet' && view.window.open && view.missionEnabled === true;
  const lines = [
    `nudges sent:  ${view.nudgesSent} of ${MAX_NUDGES}`,
    `unanswered:   ${view.unanswered} of ${MAX_UNANSWERED}`,
    `quiet until:  ${
      view.quietUntil ? localDateTimeString(view.quietUntil, timezone) : '(not quiet)'
    }`,
    `engagement:   ${view.engagement ?? 'arc (default)'}`,
    `window:       ${view.window.reason}`,
    `arc:          ${active ? 'active' : 'not active'}${
      view.missionEnabled === null ? ' — the mission is not registered (buddi missions add-defaults)' : ''
    }`,
  ];
  if (view.blocked) lines.push(`next message: held back — ${view.blocked}`);
  return lines.join('\n');
}

export async function buildStatus(pool: Pool, now: Date): Promise<StatusView> {
  const state = await readArcState(pool);
  const engagement = await readEngagement(pool);
  const mission = await getMission(pool, GETTING_STARTED_ID);
  const window = arcWindow(
    state
      ? { state: state.state, completedAt: state.completedAt, surface: state.surface }
      : null,
    now,
  );
  const decision = state ? nudgePolicy(state, now) : null;
  return {
    nudgesSent: state?.nudgesSent ?? 0,
    unanswered: state?.unanswered ?? 0,
    quietUntil: state?.quietUntil ?? null,
    missionEnabled: mission ? mission.enabled : null,
    window,
    engagement,
    blocked: decision && !decision.allow ? refusalText(decision.reason) : null,
  };
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let command: NudgesCommand;
  try {
    command = parseNudgesArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  if (command === 'help') {
    console.log(USAGE);
    return;
  }

  loadEnv();
  const wiring = await createWiringAsync(process.env);
  const { pool, now } = wiring;
  const timezone = timezoneFromEnv(process.env);
  try {
    if (command === 'status') {
      console.log(statusText(await buildStatus(pool, now()), timezone));
      return;
    }

    if (command === 'stop') {
      await writeEngagement(pool, 'quiet', now, timezone);
      const updated = await setMissionEnabled(pool, GETTING_STARTED_ID, false);
      console.log(
        `the first-run arc is off${updated ? '' : ' (it was not registered)'} — nothing will be suggested until "buddi nudges resume"`,
      );
      return;
    }

    // resume — asking for it back clears what stopped it, or it would stop
    // again on the next tick for a reason the owner has just overruled.
    await writeEngagement(pool, 'arc', now, timezone);
    await setQuietUntil(pool, null, now());
    await noteOwnerActivity(pool, now());
    const window = await buildStatus(pool, now());
    if (!window.window.open) {
      console.log(
        `engagement set to arc, but the first-run window is closed (${window.window.reason}) — the arc stays off`,
      );
      return;
    }
    const updated = await setMissionEnabled(pool, GETTING_STARTED_ID, true);
    console.log(
      updated
        ? 'the first-run arc is on again — at most one message a day, and only when it finds something'
        : 'engagement set to arc; the mission is not registered yet (buddi missions add-defaults)',
    );
  } finally {
    await pool.end();
  }
}
