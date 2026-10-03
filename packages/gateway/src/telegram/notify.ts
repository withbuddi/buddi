/**
 * Owner notification over Telegram — the outbound half of the surface.
 *
 * The scheduler's Friday recap calls this. It never guesses a destination: the
 * chat comes from the paired surface identity in core, and if nothing is paired
 * it fails with a typed error rather than sending somewhere plausible.
 */
import {
  createPool,
  listSurfaceIdentities,
  renderOffers,
  TELEGRAM_SURFACE,
  type Offer,
  type Queryable,
} from '@buddi/core';
import { TelegramApi, TelegramApiError, type FetchLike, type InlineKeyboardMarkup } from './api.js';
import { toPlainText } from './outbound.js';
import { offersKeyboard, SURFACE } from './surface.js';

/** No paired owner chat: there is nowhere to send, and no fallback is invented. */
export class OwnerNotPairedError extends Error {
  override readonly name = 'OwnerNotPairedError';
  readonly code = 'owner-not-paired';
  constructor(message = 'no Telegram owner chat is paired (pair a phone in Settings → Telegram, or run `buddi telegram pair`)') {
    super(message);
  }
}

/** Telegram is not configured at all. */
export class TelegramNotConfiguredError extends Error {
  override readonly name = 'TelegramNotConfiguredError';
  readonly code = 'telegram-not-configured';
  constructor(missing: string) {
    super(`Telegram notification unavailable: ${missing} is not set`);
  }
}

export interface NotifyOptions {
  /**
   * The actions the report offered, already stored. How they are drawn is not
   * decided here: `renderOffers` reads Telegram's own profile and says whether
   * this surface gets controls or words, and this function does what it says.
   */
  offers?: readonly Offer[];
  /**
   * The same message as Telegram HTML, already cut into messages that fit
   * (`ownerMessageHtml`). Sent with `parse_mode: 'HTML'`; when Telegram
   * refuses the markup, the text goes as plain text with its Markdown taken out.
   */
  html?: readonly string[];
  /** A keyboard of the caller's own (Keep/Stop on "Still useful?"), used when there are no offers. */
  replyMarkup?: InlineKeyboardMarkup;
  /** Reuse an open pool; otherwise one is created from DATABASE_URL and closed. */
  pool?: Queryable;
  token?: string;
  api?: Pick<TelegramApi, 'sendMessage'>;
  fetch?: FetchLike;
  env?: NodeJS.ProcessEnv;
}

/** The paired owner's chat id for Telegram, or undefined if none is bound. */
export async function ownerChatId(pool: Queryable): Promise<string | undefined> {
  const identities = await listSurfaceIdentities(pool, SURFACE);
  for (const identity of identities) {
    if (identity.externalChatId) return identity.externalChatId;
  }
  return undefined;
}

/**
 * Send a plain-text message to the paired owner chat.
 * Throws `OwnerNotPairedError` when no chat is paired.
 */
export async function notifyOwner(text: string, opts: NotifyOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;
  let pool = opts.pool;
  let ownPool: { end(): Promise<void> } | undefined;
  if (!pool) {
    const url = env.DATABASE_URL;
    if (!url) throw new TelegramNotConfiguredError('DATABASE_URL');
    const created = createPool(url);
    pool = created;
    ownPool = created;
  }
  try {
    const chatId = await ownerChatId(pool);
    if (!chatId) throw new OwnerNotPairedError();

    let api = opts.api;
    if (!api) {
      const token = opts.token ?? env.TELEGRAM_BOT_TOKEN;
      if (!token) throw new TelegramNotConfiguredError('TELEGRAM_BOT_TOKEN');
      api = new TelegramApi({ token, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
    }
    const rendered = renderOffers(TELEGRAM_SURFACE, text, opts.offers ?? []);
    const markup =
      rendered.controls.length > 0
        ? { replyMarkup: offersKeyboard(rendered.controls) }
        : opts.replyMarkup
          ? { replyMarkup: opts.replyMarkup }
          : {};
    // HTML only when Telegram draws the offers as buttons: offers spelled out
    // as words belong to the plain text.
    const html = opts.html && opts.html.length > 0 && rendered.text === text.trim() ? opts.html : null;
    if (html) {
      let sent = 0;
      try {
        for (const [index, part] of html.entries()) {
          await api.sendMessage(chatId, part, { parseMode: 'HTML', ...(index === html.length - 1 ? markup : {}) });
          sent += 1;
        }
        return chatId;
      } catch (err) {
        // Markup Telegram will not parse is ours to fix, not the owner's to
        // miss: the first message goes again as plain text. Past the first,
        // the owner already has the start, so the failure is reported.
        if (!(err instanceof TelegramApiError) || err.status !== 400 || sent > 0) throw err;
      }
    }
    await api.sendMessage(chatId, html ? toPlainText(rendered.text) : rendered.text, markup);
    return chatId;
  } finally {
    await ownPool?.end();
  }
}
