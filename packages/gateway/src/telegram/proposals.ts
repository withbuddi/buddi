/**
 * Proposals over Telegram: Keep or Discard, on the phone.
 *
 * A learning proposal (a skill, a rule for a plugin, a change to an agent's
 * own file) arrives as a card with two buttons. The rules are the approval
 * cards' rules (see `approvals.ts`), for the same reason — keeping a proposal
 * changes what an agent does from then on:
 *
 *  - The only thing that decides a proposal here is a tap whose
 *    `callback_data` names its id. There is no text command that keeps one,
 *    and a plain "yes" in the chat decides nothing.
 *  - The sender is re-authenticated against core on every tap: a paired owner
 *    identity, in the chat that identity is bound to. A stranger's tap is
 *    recorded as `surface.rejected` and answered with nothing useful.
 *  - The decision is the dashboard's own keep or discard (`decide`), which
 *    moves the row in one guarded statement and applies what keeping does. A
 *    second tap, or a decision already taken on the dashboard, is told so.
 *
 * What the card says is read from the stored proposal, never from the wire.
 */
import { getProposal, resolveOwnerForSurface, type Proposal, type Queryable } from '@buddi/core';
import {
  MAX_CALLBACK_DATA_BYTES,
  type InlineKeyboardMarkup,
  type TelegramApi,
  type TelegramUpdate,
} from './api.js';
import { PROPOSAL_CALLBACK_PREFIX, SURFACE } from './surface.js';

export { PROPOSAL_CALLBACK_PREFIX };

export type ProposalVerb = 'keep' | 'discard';

/** `prp:<proposalId>:keep|discard`. */
export function proposalCallbackData(id: string, verb: ProposalVerb): string {
  const data = `${PROPOSAL_CALLBACK_PREFIX}:${id}:${verb}`;
  if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_DATA_BYTES) {
    throw new Error(`proposal callback data is too long for Telegram: ${data.length} bytes`);
  }
  return data;
}

/** Parse a proposal tap, or nothing. Strict: the id must be a uuid. */
export function parseProposalCallback(data: string | undefined): { id: string; verb: ProposalVerb } | undefined {
  const m = /^prp:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(keep|discard)$/i.exec((data ?? '').trim());
  if (!m) return undefined;
  return { id: (m[1] as string).toLowerCase(), verb: (m[2] as string).toLowerCase() as ProposalVerb };
}

export function proposalKeyboard(id: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: 'Keep', callback_data: proposalCallbackData(id, 'keep') },
      { text: 'Discard', callback_data: proposalCallbackData(id, 'discard') },
    ]],
  };
}

const NO_KEYBOARD: InlineKeyboardMarkup = { inline_keyboard: [] };

function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The card: who proposes what, why, and what keeping it does. Plain text. */
export function proposalCardText(proposal: Proposal): string {
  const p = proposal.payload;
  const who = proposal.agent;
  const lines: string[] = [];
  switch (proposal.kind) {
    case 'skill':
      lines.push(`${who} proposes a skill: ${String(p.name ?? 'unnamed')}`);
      if (typeof p.when === 'string' && p.when.trim() !== '') lines.push('', `When: ${clip(p.when, 300)}`);
      break;
    case 'policy':
      lines.push(`${who} proposes a rule for ${String(p.plugin ?? 'a plugin')}: ${String(p.action ?? '')}`.trim());
      break;
    case 'change':
      lines.push(`${who} proposes a change to its ${p.part === 'tools' ? 'tools' : 'instructions'}`);
      break;
  }
  if (typeof p.why === 'string' && p.why.trim() !== '') lines.push('', clip(p.why, 600));
  lines.push('', keepMeans(proposal));
  if (proposal.untrusted) lines.push('It was made with untrusted text in view.');
  lines.push('The whole of it is on the dashboard, under Proposals.');
  return lines.join('\n');
}

function keepMeans(proposal: Proposal): string {
  switch (proposal.kind) {
    case 'skill':
      return `Kept, it becomes a skill ${proposal.agent} follows next time.`;
    case 'policy':
      return `Kept, ${String(proposal.payload.plugin ?? 'the plugin')} applies it.`;
    case 'change':
      return `Kept, ${proposal.agent}'s file changes as proposed.`;
  }
}

/** The card once decided: the same text, the outcome, no buttons. */
export function decidedProposalText(proposal: Proposal, outcome: string): string {
  return `${proposalCardText(proposal)}\n\n${outcome}`;
}

/** What deciding asks of the host: the dashboard's own keep and discard. */
export type DecideProposal = (
  id: string,
  verb: ProposalVerb,
) => Promise<{ ok: true; note?: string } | { ok: false; message: string }>;

export interface ProposalsOptions {
  api: Pick<TelegramApi, 'sendMessage' | 'editMessageText' | 'answerCallbackQuery'>;
  pool: Queryable;
  decide: DecideProposal;
  log?: (line: string) => void;
}

export type CallbackQuery = NonNullable<TelegramUpdate['callback_query']>;

/** The proposal cards: post one, handle a tap. Owns no state; every fact is core's. */
export class TelegramProposals {
  readonly #opts: ProposalsOptions;
  readonly #log: (line: string) => void;

  constructor(opts: ProposalsOptions) {
    this.#opts = opts;
    this.#log = opts.log ?? ((line) => console.error(line));
  }

  /**
   * Post the card for one proposal. False, and nothing sent, when it is no
   * longer open: decided on the dashboard between the notification and now.
   */
  async request(chatId: string, id: string): Promise<boolean> {
    const proposal = await getProposal(this.#opts.pool, id);
    if (!proposal || proposal.state !== 'open') return false;
    await this.#opts.api.sendMessage(chatId, proposalCardText(proposal), { replyMarkup: proposalKeyboard(proposal.id) });
    return true;
  }

  /** One tap. Authenticate, decide, and only then say what happened. */
  async handleCallback(query: CallbackQuery): Promise<void> {
    const { api, pool } = this.#opts;
    const userId = query.from?.id === undefined ? '' : String(query.from.id);
    const chatId = query.message?.chat?.id === undefined ? '' : String(query.message.chat.id);
    const messageId = query.message?.message_id;

    const parsed = parseProposalCallback(query.data);
    if (!parsed || userId === '' || chatId === '') {
      await api.answerCallbackQuery(query.id).catch(() => {});
      return;
    }

    const resolution = await resolveOwnerForSurface(pool, {
      surface: SURFACE,
      externalUserId: userId,
      externalChatId: chatId,
    });
    if (!resolution.ok) {
      this.#log(`telegram: proposal callback rejected (${resolution.reason}) from user ${userId} in chat ${chatId}`);
      await pool.query(
        `insert into core.events (kind, conversation_id, payload) values ($1, null, $2::jsonb)`,
        ['surface.rejected', JSON.stringify({
          surface: SURFACE,
          kind: 'callback',
          reason: resolution.reason,
          externalUserId: userId,
          externalChatId: chatId,
          callbackId: query.id,
          proposalId: parsed.id,
        })],
      );
      await api.answerCallbackQuery(query.id).catch(() => {});
      return;
    }

    const decided = await this.#opts.decide(parsed.id, parsed.verb).catch((err: unknown) => ({
      ok: false as const,
      message: err instanceof Error ? err.message : String(err),
    }));
    const proposal = await getProposal(pool, parsed.id).catch(() => null);

    if (!decided.ok) {
      await api.answerCallbackQuery(query.id, clip(decided.message, 190)).catch(() => {});
      // Decided elsewhere: the card says how it ended and loses its buttons.
      // Refused while still open (a skill that cannot be written): it keeps them.
      if (proposal && proposal.state !== 'open' && messageId !== undefined) {
        await this.#edit(chatId, messageId, decidedProposalText(proposal, endedText(proposal)));
      }
      return;
    }

    const outcome = parsed.verb === 'keep' ? `Kept.${decided.note ? ` ${decided.note}` : ''}` : 'Discarded.';
    await api.answerCallbackQuery(query.id, parsed.verb === 'keep' ? 'Kept.' : 'Discarded.').catch(() => {});
    if (proposal && messageId !== undefined) {
      await this.#edit(chatId, messageId, decidedProposalText(proposal, outcome));
    }
  }

  async #edit(chatId: string, messageId: number, text: string): Promise<void> {
    try {
      await this.#opts.api.editMessageText(chatId, messageId, text, { replyMarkup: NO_KEYBOARD });
    } catch (err) {
      this.#log(`telegram: editing proposal message ${messageId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function endedText(proposal: Proposal): string {
  switch (proposal.state) {
    case 'kept':
      return 'Already kept.';
    case 'discarded':
      return 'Already discarded.';
    case 'expired':
      return 'Not decided in 30 days, so it expired.';
    default:
      return '';
  }
}
