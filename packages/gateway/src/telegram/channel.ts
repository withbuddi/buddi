/**
 * Telegram as a channel: how core's `notifyOwner` reaches the owner's phone
 * (docs/notifications.md).
 *
 * The surface registers this when it starts. A message is the text it always
 * was, with offers as buttons through `renderOffers`; an approval is the card,
 * with its bound callbacks, exactly as the approval path posted it before
 * notifications existed. A proposal is its card too, with Keep and Discard —
 * alone when it is sent alone, and after the end-of-day message when it came
 * with it.
 */
import { getAction, proposalIdOfKey, type ActionRecord, type OwnerChannel, type Queryable } from '@buddi/core';
import { notifyOwner, ownerChatId, OwnerNotPairedError } from './notify.js';

/** The one message text a channel with no title field sends. */
export function ownerMessageText(message: { title: string; text?: string }): string {
  const text = message.text?.trim();
  return text ? `${message.title}\n\n${text}` : message.title;
}

export interface TelegramChannelOptions {
  pool: Queryable;
  env?: NodeJS.ProcessEnv;
  /** Read at each delivery: the surface may start after the channel is registered. */
  botUsername?: () => string | null | undefined;
  /** The running surface's approval cards, when there is one. */
  approvals?: () => { request(chatId: string, action: ActionRecord): Promise<unknown> } | undefined;
  /** The running surface's proposal cards, when there is one. */
  proposals?: () => { request(chatId: string, id: string): Promise<boolean> } | undefined;
  /** Injected in tests; otherwise the text path is `notifyOwner` over the Bot API. */
  sendText?: typeof notifyOwner;
}

export function createTelegramChannel(opts: TelegramChannelOptions): OwnerChannel {
  const sendText = opts.sendText ?? notifyOwner;
  return {
    kind: 'telegram.chat',
    describe() {
      const bot = opts.botUsername?.();
      return { label: 'Telegram', ...(bot ? { where: `@${bot}` } : {}) };
    },
    can: { offers: true, attachments: false, markdown: false },
    // The default when the owner picked none: the phone first.
    priority: 0,
    async deliver(message) {
      const approvals = opts.approvals?.();
      if (message.kind === 'approval' && message.actionId && approvals) {
        const action = await getAction(opts.pool, message.actionId);
        if (action) {
          const chatId = await ownerChatId(opts.pool);
          if (!chatId) throw new OwnerNotPairedError();
          await approvals.request(chatId, action);
          return { id: chatId };
        }
      }
      const proposals = opts.proposals?.();
      const proposalId = proposalIdOfKey(message.dedupeKey);
      if (proposalId && proposals) {
        const chatId = await ownerChatId(opts.pool);
        if (!chatId) throw new OwnerNotPairedError();
        // Decided on the dashboard since: there is nothing left to ask.
        await proposals.request(chatId, proposalId);
        return { id: chatId };
      }
      const chatId = await sendText(ownerMessageText(message), {
        pool: opts.pool,
        env: opts.env ?? process.env,
        ...(message.offers && message.offers.length > 0 ? { offers: message.offers } : {}),
      });
      // The end-of-day message names every proposal in one line each; the
      // ones still open follow as their cards, so each can be decided here.
      if (proposals && message.parts) {
        for (const part of message.parts) {
          const id = proposalIdOfKey(part.dedupeKey);
          if (!id) continue;
          await proposals.request(chatId, id).catch(() => false);
        }
      }
      return { id: chatId };
    },
  };
}
