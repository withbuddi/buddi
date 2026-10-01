/**
 * The owner's reactions on Telegram, read as feedback (docs/telegram.md,
 * "Reactions").
 *
 * A reaction is not a command. It is filed against the message it sits on and
 * the run behind it, and the bot answers it with nothing — with one
 * exception: a 👎 asks "What was off?" once, as a reply to that message, and
 * the owner's Reply to that question is kept as the note on the 👎 instead of
 * starting a turn. The note is acknowledged with a quiet 👌 reaction, never a
 * message.
 */
import {
  announceReaction,
  claimFeedbackAsk,
  clearReaction,
  feedbackAwaitingNote,
  findSentMessage,
  latestTurn,
  recordSentMessage,
  setFeedbackAskMessage,
  setFeedbackNote,
  setReaction,
  type Queryable,
} from '@buddi/core';
import type { TelegramApi, TelegramMessageReaction } from './api.js';

export const REACTION_SOURCE = 'telegram';
export const WHAT_WAS_OFF_TEXT = 'What was off?';
/** How long a Reply to "What was off?" still counts as its note. */
export const NOTE_WINDOW_MS = 6 * 60 * 60 * 1000;
/** The bot's one quiet acknowledgement of a note. */
export const NOTE_ACK_EMOJI = '👌';

export interface ReactionDeps {
  pool: Queryable;
  api: TelegramApi;
  log: (line: string) => void;
  now: () => number;
}

/** An open dashboard tab hears it at once; a failure costs only that. */
async function announce(deps: Pick<ReactionDeps, 'pool' | 'log'>, input: Parameters<typeof announceReaction>[1]): Promise<void> {
  await announceReaction(deps.pool, input).catch((err) => {
    deps.log(`telegram: the reaction was kept but not announced to open pages: ${err instanceof Error ? err.message : String(err)}`);
  });
}

/** Remember which turn the messages an answer landed in stand for. */
export async function recordSentAnswer(
  deps: Pick<ReactionDeps, 'pool'>,
  chatId: string,
  conversationId: string,
  ids: readonly number[],
): Promise<void> {
  const turn = await latestTurn(deps.pool, conversationId);
  if (!turn) return;
  for (const id of ids) {
    await recordSentMessage(deps.pool, {
      surface: REACTION_SOURCE,
      chatId,
      externalMessageId: String(id),
      conversationId,
      messageId: turn.messageId,
      runEventId: turn.runEventId,
      agentId: turn.agentId,
    });
  }
}

/** The emoji the owner is reacting with now, or undefined when they took it back. */
export function currentEmoji(reaction: TelegramMessageReaction): string | undefined {
  for (const r of reaction.new_reaction ?? []) if (r.type === 'emoji' && r.emoji) return r.emoji;
  return undefined;
}

/**
 * The owner's reaction, already authenticated. Silent unless it is a fresh 👎
 * on a message never asked about.
 */
export async function handleReaction(deps: ReactionDeps, chatId: string, reaction: TelegramMessageReaction): Promise<void> {
  const messageId = String(reaction.message_id);
  const now = new Date(deps.now());
  const emoji = currentEmoji(reaction);
  if (emoji === undefined) {
    // Taken back, or swapped for a custom emoji or a star, which say nothing readable.
    const cleared = await clearReaction(deps.pool, { source: REACTION_SOURCE, chatId, externalMessageId: messageId, now });
    if (cleared) {
      deps.log(`telegram: chat ${chatId} — reaction on ${messageId} cleared`);
      await announce(deps, { ...cleared, cleared: true });
    }
    return;
  }
  const sent = await findSentMessage(deps.pool, REACTION_SOURCE, chatId, messageId);
  if (!sent) {
    // A reaction on the owner's own message, a card, or an answer sent before this existed.
    deps.log(`telegram: chat ${chatId} — reaction on ${messageId} is not on an agent's answer; ignored`);
    return;
  }
  const feedback = await setReaction(deps.pool, { source: REACTION_SOURCE, sent, emoji, now });
  deps.log(`telegram: chat ${chatId} — ${feedback.value} on ${messageId} (${sent.agentId})`);
  await announce(deps, { conversationId: feedback.conversationId, messageId: feedback.messageId, value: feedback.value, emoji: feedback.emoji });
  if (feedback.value !== 'down') return;
  if (!(await claimFeedbackAsk(deps.pool, feedback.id, now))) return;
  const asked = await deps.api.sendMessage(chatId, WHAT_WAS_OFF_TEXT, { replyTo: reaction.message_id }).catch((err) => {
    deps.log(`telegram: chat ${chatId} — "what was off?" not sent: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  });
  if (asked !== undefined) await setFeedbackAskMessage(deps.pool, feedback.id, String(asked));
}

/**
 * The owner's Reply to "What was off?": kept as the note and answered with a
 * quiet 👌. False when the message is not such a reply (or it came too late),
 * and it then goes on as an ordinary message.
 */
export async function takeFeedbackNote(
  deps: ReactionDeps,
  chatId: string,
  input: { replyTo: number; messageId: number; text: string },
): Promise<boolean> {
  const feedback = await feedbackAwaitingNote(deps.pool, {
    source: REACTION_SOURCE,
    chatId,
    askMessageId: String(input.replyTo),
    now: new Date(deps.now()),
    withinMs: NOTE_WINDOW_MS,
  });
  if (!feedback) return false;
  await setFeedbackNote(deps.pool, feedback.id, input.text, new Date(deps.now()));
  deps.log(`telegram: chat ${chatId} — note kept on the 👎 for ${feedback.agentId}`);
  await announce(deps, { conversationId: feedback.conversationId, messageId: feedback.messageId, value: feedback.value, emoji: feedback.emoji, note: true });
  await deps.api.setMessageReaction(chatId, input.messageId, NOTE_ACK_EMOJI).catch(() => {});
  return true;
}
