/**
 * The owner's reactions to an agent's message, read as feedback.
 *
 * A surface records which conversation message and run each message it sent
 * stands for (`recordSentMessage`); a reaction on that message is then filed
 * against the turn behind it (`setReaction`). Taking the reaction back clears
 * it. A 👎 may carry a note — the owner's answer to "What was off?" — and is
 * asked about once per message, ever.
 *
 * Readers: the dashboard transcript (`feedbackForMessages`) and the weekly
 * learning digest (`feedbackWeek`). Schema: migration 058.
 */
import type { Queryable } from '../owner.js';

export type FeedbackValue = 'up' | 'down' | 'neutral';

/** The emoji that mean "good" and "not that". Everything else is neutral. */
const UP = new Set(['👍', '❤', '🔥', '👏', '🎉', '🙏']);
const DOWN = new Set(['👎', '💩', '🤮']);

/** Telegram sends ❤ without its variation selector; compare both ways. */
function bare(emoji: string): string {
  return emoji.replace(/️/g, '').trim();
}

export function reactionValue(emoji: string): FeedbackValue {
  const e = bare(emoji);
  if (UP.has(e)) return 'up';
  if (DOWN.has(e)) return 'down';
  return 'neutral';
}

export interface SentMessage {
  surface: string;
  chatId: string;
  externalMessageId: string;
  conversationId: string;
  messageId: string | null;
  runEventId: string | null;
  agentId: string;
}

/**
 * The turn a surface just delivered: its last assistant message and the run
 * that closed it, read from the conversation as it stands now.
 */
export async function latestTurn(
  db: Queryable,
  conversationId: string,
): Promise<{ messageId: string | null; runEventId: string | null; agentId: string } | null> {
  const { rows } = await db.query(
    `select c.agent_id,
            (select m.id from core.messages m
              where m.conversation_id = c.id and m.role = 'assistant'
              order by m.created_at desc, m.id desc limit 1) as message_id,
            (select e.id from core.events e
              where e.conversation_id = c.id and e.kind = 'run.finished'
              order by e.id desc limit 1) as run_event_id
       from core.conversations c where c.id = $1::uuid`,
    [conversationId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    agentId: String(row.agent_id),
    messageId: row.message_id ? String(row.message_id) : null,
    runEventId: row.run_event_id === null || row.run_event_id === undefined ? null : String(row.run_event_id),
  };
}

export async function recordSentMessage(db: Queryable, sent: SentMessage): Promise<void> {
  await db.query(
    `insert into core.surface_sent_messages
       (surface, external_chat_id, external_message_id, conversation_id, message_id, run_event_id, agent_id)
     values ($1, $2, $3, $4::uuid, $5::uuid, $6::bigint, $7)
     on conflict (surface, external_chat_id, external_message_id) do update
       set conversation_id = excluded.conversation_id, message_id = excluded.message_id,
           run_event_id = excluded.run_event_id, agent_id = excluded.agent_id`,
    [sent.surface, sent.chatId, sent.externalMessageId, sent.conversationId, sent.messageId, sent.runEventId, sent.agentId],
  );
}

export async function findSentMessage(
  db: Queryable,
  surface: string,
  chatId: string,
  externalMessageId: string,
): Promise<SentMessage | null> {
  const { rows } = await db.query(
    `select * from core.surface_sent_messages
      where surface = $1 and external_chat_id = $2 and external_message_id = $3`,
    [surface, chatId, externalMessageId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    surface: String(r.surface),
    chatId: String(r.external_chat_id),
    externalMessageId: String(r.external_message_id),
    conversationId: String(r.conversation_id),
    messageId: r.message_id ? String(r.message_id) : null,
    runEventId: r.run_event_id === null ? null : String(r.run_event_id),
    agentId: String(r.agent_id),
  };
}

export interface Feedback {
  id: string;
  source: string;
  conversationId: string;
  messageId: string | null;
  runEventId: string | null;
  agentId: string;
  value: FeedbackValue;
  emoji: string;
  note: string | null;
  askedAt: string | null;
  askMessageId: string | null;
  cleared: boolean;
  updatedAt: string;
}

function toFeedback(r: Record<string, any>): Feedback {
  return {
    id: String(r.id),
    source: String(r.source),
    conversationId: String(r.conversation_id),
    messageId: r.message_id ? String(r.message_id) : null,
    runEventId: r.run_event_id === null || r.run_event_id === undefined ? null : String(r.run_event_id),
    agentId: String(r.agent_id),
    value: r.value as FeedbackValue,
    emoji: String(r.emoji),
    note: r.note ?? null,
    askedAt: r.asked_at ? new Date(r.asked_at).toISOString() : null,
    askMessageId: r.ask_message_id ?? null,
    cleared: r.cleared_at !== null && r.cleared_at !== undefined,
    updatedAt: new Date(r.updated_at).toISOString(),
  };
}

/** File (or replace) the owner's reaction on a sent message. */
export async function setReaction(
  db: Queryable,
  input: { source: string; sent: SentMessage; emoji: string; now?: Date },
): Promise<Feedback> {
  const now = input.now ?? new Date();
  const { sent } = input;
  const { rows } = await db.query(
    `insert into core.message_feedback
       (source, external_chat_id, external_message_id, conversation_id, message_id, run_event_id, agent_id,
        value, emoji, created_at, updated_at)
     values ($1, $2, $3, $4::uuid, $5::uuid, $6::bigint, $7, $8, $9, $10, $10)
     on conflict (source, external_chat_id, external_message_id) do update
       set value = excluded.value, emoji = excluded.emoji, cleared_at = null, updated_at = excluded.updated_at
     returning *`,
    [
      input.source, sent.chatId, sent.externalMessageId, sent.conversationId, sent.messageId,
      sent.runEventId, sent.agentId, reactionValue(input.emoji), bare(input.emoji) || input.emoji, now,
    ],
  );
  return toFeedback(rows[0]);
}

/**
 * The owner took their reaction back. The row stays, so a 👎 is never asked
 * about twice. Null when there was nothing standing to clear; else where it was.
 */
export async function clearReaction(
  db: Queryable,
  input: { source: string; chatId: string; externalMessageId: string; now?: Date },
): Promise<{ conversationId: string; messageId: string | null } | null> {
  const now = input.now ?? new Date();
  const { rows } = await db.query(
    `update core.message_feedback set cleared_at = $4, updated_at = $4
      where source = $1 and external_chat_id = $2 and external_message_id = $3 and cleared_at is null
      returning id, conversation_id, message_id`,
    [input.source, input.chatId, input.externalMessageId, now],
  );
  const row = rows[0];
  return row ? { conversationId: String(row.conversation_id), messageId: row.message_id ? String(row.message_id) : null } : null;
}

/** The event an open dashboard tab hears a reaction by (its conversation stream). */
export const REACTION_EVENT = 'chat.reaction';

/**
 * Tell an open page on this conversation that a reaction changed, so it draws
 * it now instead of on its next reread. Ids and the emoji only: the note, if
 * any, is read with the transcript.
 */
export async function announceReaction(
  db: Queryable,
  input: { conversationId: string; messageId: string | null; value?: FeedbackValue; emoji?: string; cleared?: boolean; note?: boolean },
): Promise<void> {
  await db.query(
    `insert into core.events (kind, conversation_id, payload) values ($1, $2::uuid, $3::jsonb)`,
    [REACTION_EVENT, input.conversationId, JSON.stringify({
      messageId: input.messageId,
      ...(input.value ? { value: input.value } : {}),
      ...(input.emoji ? { emoji: input.emoji } : {}),
      ...(input.cleared ? { cleared: true } : {}),
      ...(input.note ? { note: true } : {}),
    })],
  );
}

/**
 * Claim the one "What was off?" for this feedback. True once per row, ever:
 * the caller sends the question only when it won the claim.
 */
export async function claimFeedbackAsk(db: Queryable, feedbackId: string, now: Date = new Date()): Promise<boolean> {
  const { rows } = await db.query(
    `update core.message_feedback set asked_at = $2 where id = $1::uuid and asked_at is null returning id`,
    [feedbackId, now],
  );
  return rows.length > 0;
}

export async function setFeedbackAskMessage(db: Queryable, feedbackId: string, askMessageId: string): Promise<void> {
  await db.query(`update core.message_feedback set ask_message_id = $2 where id = $1::uuid`, [feedbackId, askMessageId]);
}

/**
 * The open question a reply answers: the feedback whose "What was off?" is
 * `askMessageId`, asked within `withinMs`, with no note yet.
 */
export async function feedbackAwaitingNote(
  db: Queryable,
  input: { source: string; chatId: string; askMessageId: string; now: Date; withinMs: number },
): Promise<Feedback | null> {
  const { rows } = await db.query(
    `select * from core.message_feedback
      where source = $1 and external_chat_id = $2 and ask_message_id = $3
        and note is null and asked_at >= $4`,
    [input.source, input.chatId, input.askMessageId, new Date(input.now.getTime() - input.withinMs)],
  );
  return rows[0] ? toFeedback(rows[0]) : null;
}

export async function setFeedbackNote(db: Queryable, feedbackId: string, note: string, now: Date = new Date()): Promise<void> {
  await db.query(
    `update core.message_feedback set note = $2, updated_at = $3 where id = $1::uuid`,
    [feedbackId, note, now],
  );
}

/** What the dashboard draws under a message: the standing reaction, newest per message. */
export interface MessageFeedbackView {
  value: FeedbackValue;
  emoji: string;
  source: string;
  note?: string;
}

export async function feedbackForMessages(
  db: Queryable,
  messageIds: readonly string[],
): Promise<Map<string, MessageFeedbackView>> {
  const out = new Map<string, MessageFeedbackView>();
  if (messageIds.length === 0) return out;
  const { rows } = await db.query(
    `select distinct on (message_id) message_id, value, emoji, source, note
       from core.message_feedback
      where message_id = any($1::uuid[]) and cleared_at is null
      order by message_id, updated_at desc`,
    [messageIds],
  );
  for (const r of rows) {
    out.set(String(r.message_id), {
      value: r.value as FeedbackValue,
      emoji: String(r.emoji),
      source: String(r.source),
      ...(r.note ? { note: String(r.note) } : {}),
    });
  }
  return out;
}

export interface FeedbackTally {
  up: number;
  down: number;
  neutral: number;
}

/** What the weekly digest reads: standing reactions since, per agent, and the 👎 notes. */
export interface FeedbackWeek {
  byAgent: Record<string, FeedbackTally>;
  notes: Array<{ agentId: string; note: string }>;
}

export async function feedbackWeek(db: Queryable, input: { since: Date; notes?: number }): Promise<FeedbackWeek> {
  const { rows } = await db.query(
    `select agent_id, value, note from core.message_feedback
      where cleared_at is null and updated_at >= $1
      order by updated_at desc`,
    [input.since],
  );
  const byAgent: Record<string, FeedbackTally> = {};
  const notes: FeedbackWeek['notes'] = [];
  for (const r of rows) {
    const agent = String(r.agent_id);
    const tally = (byAgent[agent] ??= { up: 0, down: 0, neutral: 0 });
    tally[r.value as FeedbackValue] += 1;
    if (r.value === 'down' && r.note && notes.length < (input.notes ?? 5)) notes.push({ agentId: agent, note: String(r.note) });
  }
  return { byAgent, notes };
}
