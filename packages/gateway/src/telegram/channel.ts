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
import {
  getAction,
  missionIdOfStillUsefulKey,
  proposalIdOfKey,
  type ActionRecord,
  type OwnerChannel,
  type Queryable,
} from '@buddi/core';
import { notifyOwner, ownerChatId, OwnerNotPairedError } from './notify.js';
import { stillUsefulKeyboard } from './still-useful.js';

/**
 * Telegram turns any `@word` into a link to that public username, so an
 * agent's signature ("@buddi: …", at a line's start or after a list dash)
 * would point at a stranger's account. A word joiner after the `@` looks the
 * same and is not a mention. Only the signature pattern is touched.
 */
export function unlinkSignatures(text: string): string {
  return text.replace(/(^|\n|- )@(?=[A-Za-z0-9_-]+: )/g, '$1@\u2060');
}

/**
 * The one message text a channel with no title field sends; what it asks of
 * the owner, if anything, last. A batch (the end-of-day or end-of-focus
 * message) lists titles only in its text, so each part that asks for
 * something adds its own line: the part's title and its action.
 */
export function ownerMessageText(message: {
  title: string;
  text?: string;
  action?: string;
  parts?: ReadonlyArray<{ title: string; action?: string }>;
}): string {
  const text = message.text?.trim();
  const body = text ? `${message.title}\n\n${text}` : message.title;
  const asks = (message.parts ?? [])
    .filter((part) => (part.action?.trim() ?? '') !== '')
    .map((part) => `→ ${part.title.trim()}: ${part.action!.trim()}`);
  const action = message.action?.trim();
  const lines = [...asks, ...(action ? [`→ ${action}`] : [])];
  return lines.length > 0 ? `${body}\n\n${lines.join('\n')}` : body;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      // An agent's own message (`owner.notify`) is information only: plain
      // text, already signed "@agent: …", never a button or a card.
      const offers = message.kind === 'agent' ? [] : message.offers ?? [];
      // "Still useful?" asks Keep or Stop: the buttons say it, so the
      // spelled-out action line goes.
      const stillUseful = message.kind !== 'agent' && UUID.test(message.id) && missionIdOfStillUsefulKey(message.dedupeKey) !== undefined;
      const { action: _asked, ...withoutAction } = message;
      const chatId = await sendText(unlinkSignatures(ownerMessageText(stillUseful ? withoutAction : message)), {
        pool: opts.pool,
        env: opts.env ?? process.env,
        ...(offers.length > 0 ? { offers } : {}),
        ...(stillUseful ? { replyMarkup: stillUsefulKeyboard(message.id) } : {}),
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
      // So does each "Still useful?" in it, with its Keep and Stop.
      for (const part of message.parts ?? []) {
        if (!UUID.test(part.id) || missionIdOfStillUsefulKey(part.dedupeKey) === undefined) continue;
        const { action: _partAsked, ...bare } = part;
        await sendText(unlinkSignatures(ownerMessageText(bare)), {
          pool: opts.pool,
          env: opts.env ?? process.env,
          replyMarkup: stillUsefulKeyboard(part.id),
        }).catch(() => '');
      }
      return { id: chatId };
    },
  };
}
