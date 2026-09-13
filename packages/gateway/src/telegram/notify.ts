/**
 * Owner notification over Telegram — the outbound half of the surface.
 *
 * The scheduler's Friday recap calls this. It never guesses a destination: the
 * chat comes from the paired surface identity in core, and if nothing is paired
 * it fails with a typed error rather than sending somewhere plausible.
 */
import { createPool, listSurfaceIdentities, type Queryable } from '@buddi/core';
import { TelegramApi, type FetchLike } from './api.js';
import { SURFACE } from './surface.js';

/** No paired owner chat: there is nowhere to send, and no fallback is invented. */
export class OwnerNotPairedError extends Error {
  override readonly name = 'OwnerNotPairedError';
  readonly code = 'owner-not-paired';
  constructor(message = 'no Telegram owner chat is paired (set TELEGRAM_OWNER_USER_ID and message the bot once)') {
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
    await api.sendMessage(chatId, text);
    return chatId;
  } finally {
    await ownPool?.end();
  }
}
