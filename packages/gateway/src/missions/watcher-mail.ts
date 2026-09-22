/**
 * What a mail watcher's wake run is given beyond the finding.
 *
 * docs/specs/email.md §7 asks that a watcher's finding lead to *«a report, a
 * draft, or a reminder, never to a send without the card»* — and §6 settled
 * what a mail run is given before it judges anything: **the thread, not the
 * message**. A wake run is a mail run. Without this the agent would be woken
 * with one line about a conversation it cannot see and would have to go and
 * fetch it, or worse, answer from the finding alone.
 *
 * So when the finding comes from an `email.*` watcher and names a thread, the
 * conversation is rendered into the prompt with the same bounded, fenced block
 * the triage prompt uses (`threadBlock` in the email plugin) — the last few
 * turns quoted, the ones before them a line each, every piece of sender text
 * marked as untrusted data. One extra instruction goes with it, and it is the
 * point of the whole watcher: verify, then report or draft. Never send.
 *
 * It is a *gateway* concern because the finding and the mission are the
 * gateway's; the rendering is the plugin's own, imported rather than reinvented,
 * so the wake run and the triage run cannot quote the owner two different
 * versions of the same conversation.
 */
import {
  findThread,
  threadBlock,
  threadMessages,
  type ThreadForPrompt,
} from '@buddi/tool-email';
import type { Pool } from 'pg';
import type { PrepareRun } from './execute.js';
import type { FindingPayload } from './sentinel-wake.js';

/** How many turns of the conversation the wake run is given. As §6's prompt. */
export const WAKE_TURNS_QUOTED = 3;
export const WAKE_TURNS_LISTED = 10;

/** The instruction that travels with a mail finding. It is the whole boundary. */
export const MAIL_WAKE_INSTRUCTION =
  'This finding is about the conversation quoted above. Verify it before you say anything: ' +
  'read the thread with email.read_thread and check that it is still true — the watcher can be ' +
  'out of date, and the owner may have answered from his phone. If it holds, either report it or ' +
  'draft a reply with email.draft_reply and leave it for the owner. You may set a reminder with ' +
  'reminder.set when the finding is about a date. Never send mail, and never propose a send: a ' +
  'watcher has woken you, the owner has not asked for anything yet.';

/** The thread id a mail finding carries in its data, or null. */
export function threadIdOf(finding: FindingPayload | null | undefined): string | null {
  if (!finding || !finding.sentinelId.startsWith('email.')) return null;
  const data = finding.data;
  if (data === null || typeof data !== 'object') return null;
  const id = (data as { threadId?: unknown }).threadId;
  return typeof id === 'string' && id.trim() !== '' ? id.trim() : null;
}

/**
 * The conversation, bounded the way §6 bounds it: the newest turns quoted at
 * length, everything before them one line each.
 */
export async function threadForWake(pool: Pool, threadId: string): Promise<ThreadForPrompt | null> {
  const thread = await findThread(pool, threadId);
  if (!thread) return null;
  const turns = await threadMessages(pool, threadId, WAKE_TURNS_QUOTED + WAKE_TURNS_LISTED);
  const quoted = turns.slice(-WAKE_TURNS_QUOTED);
  const listed = turns.slice(0, Math.max(0, turns.length - quoted.length));
  return {
    id: threadId,
    state: thread.state,
    messageCount: thread.messageCount,
    recent: quoted.map((m) => ({
      direction: m.direction,
      from: m.from,
      date: m.date,
      subject: m.subject,
      snippet: m.snippet,
      bodyText: m.bodyText,
    })),
    older: listed.map((m) => ({
      direction: m.direction,
      from: m.from,
      date: m.date,
      subject: m.subject,
      snippet: m.snippet,
    })),
  };
}

/**
 * The `prepare` for a mail watcher's wake run.
 *
 * Returns null for everything else — another plugin's finding, a cron mission,
 * a mail finding whose thread has since been deleted. There is no commit: the
 * conversation is read, not consumed.
 */
export function createMailWatcherPrepare(pool: Pool): PrepareRun {
  return async function prepare(_mission, finding) {
    const threadId = threadIdOf(finding);
    if (threadId === null) return null;
    let thread: ThreadForPrompt | null = null;
    try {
      thread = await threadForWake(pool, threadId);
    } catch {
      // The email schema may not be there at all. A wake run with no thread
      // block is a worse prompt, not a broken one.
      return null;
    }
    if (thread === null) return null;
    return {
      appendix: [...threadBlock(thread), '', MAIL_WAKE_INSTRUCTION].join('\n').trim(),
    };
  };
}
