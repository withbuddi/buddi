/**
 * What the conversation header says.
 *
 * The switcher used to live at the head of the column. With the agents moved to
 * a rail, the space goes to the thing the owner otherwise has no way to know:
 * **which conversation this is, and whether it is about to become a different
 * one.** Conversations now end on their own — three hours idle, or once the
 * transcript grows past its budget — and a thread that silently rolled over
 * looks exactly like an agent that forgot everything. One line prevents that.
 *
 * The limits are not written here. They arrive with the transcript, from the
 * server module that enforces them, so this can never say "three hours" about
 * an installation that means something else.
 */
import { fmtRelative, fmtTime } from '../format';
import type { ChatLifetime } from './types';

export type ConversationTone = 'quiet' | 'note';

export interface ConversationLine {
  text: string;
  /** The rule, in full, for the owner who wonders why. */
  title: string;
  tone: ConversationTone;
}

/** Has this conversation already crossed a limit, so the next message starts one? */
export function hasRolledOver(lifetime: ChatLifetime, now: number): boolean {
  if (lifetime.messages <= 0) return false;
  if (lifetime.chars > lifetime.maxChars) return true;
  if (lifetime.lastActivityAt === null) return false;
  return now - Date.parse(lifetime.lastActivityAt) > lifetime.idleTimeoutMs;
}

/** "3 hours", "90 minutes" — the limit in the coarsest honest unit. */
export function spanText(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours >= 1 && Number.isInteger(hours)) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const minutes = Math.round(ms / 60_000);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export function conversationLine(opts: {
  lifetime: ChatLifetime | null;
  startedAt: string | null;
  now: number;
  timezone: string;
}): ConversationLine {
  const { lifetime, startedAt, now, timezone } = opts;

  if (!lifetime || lifetime.messages <= 0) {
    return {
      text: 'New conversation',
      title: 'Nothing has been said in this one yet.',
      tone: 'quiet',
    };
  }

  const rule =
    `A conversation ends after ${spanText(lifetime.idleTimeoutMs)} idle, or once its transcript ` +
    `grows past ${Math.round(lifetime.maxChars / 1000)}k characters. ` +
    'What the agent remembers about you carries over.';

  const count = `${lifetime.messages} message${lifetime.messages === 1 ? '' : 's'}`;

  if (hasRolledOver(lifetime, now)) {
    return {
      text: `${count} · your next message starts a fresh one`,
      title: rule,
      tone: 'note',
    };
  }

  // Relative, not wall-clock: what the owner is judging is the thread's *age*
  // against the rule above, and "started 2 hours ago" answers that where
  // "since 15 Sept 2026, 20:58" makes them do the arithmetic. The exact time is
  // on hover, where a precise answer belongs.
  const ago = startedAt ? fmtRelative(startedAt, now) : '';
  return {
    text: ago === '' ? count : `${count} · started ${ago}`,
    title: startedAt ? `Started ${fmtTime(startedAt, timezone)}. ${rule}` : rule,
    tone: 'quiet',
  };
}
