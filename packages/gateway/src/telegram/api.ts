/**
 * Telegram Bot API client — no library, and deliberately not `fetch`.
 *
 * The surface is a thin transport: it moves text in and out and reports the
 * numeric ids Telegram asserts. It decides nothing about who the owner is
 * (that is `@buddi/core`'s `resolveOwnerForSurface`) and it executes no tool.
 *
 * ## Why not `fetch`
 *
 * This client used to call the global `fetch`, which is undici, which keeps a
 * connection pool per origin. That is the same defect that wedged the provider
 * path for hours: once a pooled connection is dead, undici keeps handing it
 * back and every subsequent request fails in a millisecond with a bare `fetch
 * failed`. It has not bitten here yet only because the poll loop reconnects to
 * `api.telegram.org` every ~25 seconds and so rarely leaves a socket idling —
 * luck, not design. The consequence if it did bite is the worst-shaped failure
 * this assistant has: a bot that is running, reachable, and answers nothing.
 *
 * So every Bot API call goes through the same `node:https` transport the
 * provider adapters use (`@buddi/runtime`'s `createHttpTransport`): HTTP/1.1,
 * `keepAlive: false`, nothing held between requests, therefore nothing that can
 * be poisoned. `sendMessage` is never retried by the transport — on an agent
 * that pools nothing `reusedSocket` is never true — so a message cannot be
 * delivered twice by this path.
 *
 * ## The long poll is its own shape
 *
 * `getUpdates` asks Telegram to hold the request open for `POLL_TIMEOUT_SECONDS`
 * and answer only when something happens. For most of that time the socket is
 * silent *on purpose*, which is the opposite of the idle-pooled-socket hazard:
 * the connection is in use, we are simply waiting on the far end. Two decisions
 * follow, and neither is copied from the provider settings:
 *
 *  - **Keep-alive stays off, even for polling.** The reflex would be to keep
 *    the poll's connection alive since it reconnects every 25 seconds anyway.
 *    But a reconnect costs one TLS handshake per 25 seconds — nothing — and
 *    keeping it would recreate the exact free list that wedged the provider,
 *    shared with `sendMessage`, in the process whose silence is hardest to
 *    notice. The whole point is that there is no pool to poison.
 *  - **The silence budget is per request, not global.** A chat call that has
 *    said nothing for `TELEGRAM_IDLE_TIMEOUT_MS` is broken; a long poll that
 *    has said nothing for that long is working. `POLL_IDLE_TIMEOUT_MS` is the
 *    poll's own deadline — Telegram's own timeout plus a margin — so a poll
 *    that truly dies is dropped and retried within seconds rather than hanging
 *    the surface until the provider's five-minute default expires.
 */
import { createHttpTransport, type HttpTransport } from '@buddi/runtime';

/** Telegram rejects messages over 4096 characters; we split well below it. */
export const MAX_MESSAGE_CHARS = 4000;

/** Telegram refuses to serve a bot any file larger than this. Their limit. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Long-poll timeout, in seconds. Telegram holds the request open that long. */
export const POLL_TIMEOUT_SECONDS = 25;

/**
 * How long an ordinary Bot API call may go silent before it is abandoned.
 *
 * Telegram answers `sendMessage` in well under a second; thirty is generous
 * enough for a bad network and short enough that a dead connection surfaces
 * while the owner is still looking at the chat.
 */
export const TELEGRAM_IDLE_TIMEOUT_MS = 30_000;

/**
 * The same budget for a long poll, where silence is the expected state.
 *
 * Telegram's own `timeout` plus fifteen seconds of margin: a poll that has not
 * been answered by then is not waiting, it is dead, and the loop should drop it
 * and open a fresh connection.
 */
export const POLL_IDLE_TIMEOUT_MS = (POLL_TIMEOUT_SECONDS + 15) * 1000;

/** The only update kinds this surface asks for. */
export const ALLOWED_UPDATES = ['message', 'callback_query'] as const;

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

export interface TelegramChat {
  id: number;
  /** 'private' | 'group' | 'supergroup' | 'channel'. Only 'private' is served. */
  type: string;
}

/** Common head of every file Telegram offers: an id we can ask `getFile` about. */
export interface TelegramFileRef {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
}

export interface TelegramDocument extends TelegramFileRef {
  file_name?: string;
  mime_type?: string;
}

/** One rendition of a photo. Telegram sends every thumbnail it made. */
export interface TelegramPhotoSize extends TelegramFileRef {
  width?: number;
  height?: number;
}

/** A recorded voice note (`voice`) or a sent audio file (`audio`). */
export interface TelegramAudio extends TelegramFileRef {
  file_name?: string;
  mime_type?: string;
  duration?: number;
}

/** What `getFile` answers: a path valid for about an hour, and the real size. */
export interface TelegramFile extends TelegramFileRef {
  file_path?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  /** The text sent *with* a file. The surface treats it as the user message. */
  caption?: string;
  document?: TelegramDocument;
  /** Every size of one photo, smallest first. */
  photo?: TelegramPhotoSize[];
  voice?: TelegramAudio;
  audio?: TelegramAudio;
  date?: number;
  forward_origin?: unknown;
  forward_from?: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  /**
   * An inline-keyboard tap. `data` is what the button carried; `message` is the
   * message the keyboard was attached to, which is what gets edited to show the
   * decision. The chat is read from `message`, never from `from`: a button is
   * bound to the message it sits under.
   */
  callback_query?: {
    id: string;
    from?: TelegramUser;
    data?: string;
    message?: { message_id: number; chat: TelegramChat };
  };
}

/**
 * One inline-keyboard button. Only `callback_data` buttons are modelled: a URL
 * button cannot resolve an approval, and nothing else needs one.
 *
 * Telegram caps `callback_data` at 64 bytes, which is why an approval callback
 * carries an action id and a verb and nothing else.
 */
export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

/** Rows of buttons, as Telegram's `reply_markup` wants them. */
export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/** Telegram's hard limit on `callback_data`, in bytes. */
export const MAX_CALLBACK_DATA_BYTES = 64;

/** One entry of the bot's command menu. `command` carries no leading slash. */
export interface TelegramBotCommand {
  command: string;
  description: string;
}

/**
 * Where a command menu applies. Only the two scopes buddi uses are modelled:
 * the global default (what an unpaired stranger would see) and a single chat.
 */
export type TelegramCommandScope =
  | { type: 'default' }
  | { type: 'chat'; chat_id: string | number };

/** A Bot API call that came back `ok: false`, or a non-2xx HTTP response. */
export class TelegramApiError extends Error {
  override readonly name = 'TelegramApiError';
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
  ) {
    super(`telegram ${method} failed (${status}): ${description}`);
  }
}

/**
 * Minimal `fetch` shape, so tests inject a fake without DOM lib types.
 *
 * The real implementation is `telegramHttp` below, not the global `fetch` — see
 * the header. The shape is still `fetch`'s because every existing test fake is
 * written against it, and because a `fetch` really can be injected (the web
 * test harness does) as long as nothing in the process is long-lived.
 */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    /** A `Buffer` is written verbatim: that is what a multipart upload needs. */
    body?: string | Buffer;
    signal?: any;
    /** How long this request may go silent. A long poll asks for more. */
    idleTimeoutMs?: number;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  /** Only the file endpoint needs bytes; a JSON-only fake may omit it. */
  arrayBuffer?(): Promise<ArrayBuffer>;
}>;

/**
 * The transport every Bot API call goes out on: one connection per request,
 * nothing pooled, nothing kept. `idleTimeoutMs` is per request, so the long
 * poll can ask for its own budget without loosening everyone else's.
 */
const telegramTransport = createHttpTransport({ idleTimeoutMs: TELEGRAM_IDLE_TIMEOUT_MS });

/**
 * Adapt a transport to `FetchLike`, so the injection seam and every existing
 * test fake are unchanged. Exported because the doctor probes the Bot API on a
 * transport of their own.
 */
export function telegramFetchOn(transport: HttpTransport): FetchLike {
  return (input, init = {}) =>
    transport(input, {
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      ...(init.body === undefined ? {} : { body: init.body }),
      ...(init.signal === undefined ? {} : { signal: init.signal as AbortSignal }),
      ...(init.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: init.idleTimeoutMs }),
    });
}

/** The default: one connection per Bot API call, nothing pooled. */
export const telegramHttp: FetchLike = telegramFetchOn(telegramTransport);

export interface TelegramApiOptions {
  token: string;
  fetch?: FetchLike;
  baseUrl?: string;
}

export class TelegramApi {
  readonly #token: string;
  readonly #fetch: FetchLike;
  readonly #baseUrl: string;

  constructor(opts: TelegramApiOptions) {
    if (!opts.token || opts.token.trim() === '') {
      throw new Error('TelegramApi: token is required (TELEGRAM_BOT_TOKEN)');
    }
    this.#token = opts.token.trim();
    this.#fetch = opts.fetch ?? telegramHttp;
    this.#baseUrl = opts.baseUrl ?? 'https://api.telegram.org';
  }

  async call<T>(
    method: string,
    body: Record<string, unknown>,
    signal?: any,
    idleTimeoutMs: number = TELEGRAM_IDLE_TIMEOUT_MS,
  ): Promise<T> {
    const res = await this.#fetch(`${this.#baseUrl}/bot${this.#token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
      idleTimeoutMs,
    });
    const raw = await res.text();
    let parsed: any;
    try {
      parsed = raw === '' ? {} : JSON.parse(raw);
    } catch {
      throw new TelegramApiError(method, res.status, `unparseable response: ${raw.slice(0, 200)}`);
    }
    if (!res.ok || parsed?.ok !== true) {
      throw new TelegramApiError(
        method,
        res.status,
        String(parsed?.description ?? 'unknown error'),
      );
    }
    return parsed.result as T;
  }

  /**
   * Resolve a `file_id` into a downloadable path. The path is short-lived, so
   * it is fetched immediately before the download and never stored.
   */
  getFile(fileId: string): Promise<TelegramFile> {
    return this.call<TelegramFile>('getFile', { file_id: fileId });
  }

  /**
   * Download a file by the path `getFile` returned.
   *
   * A different host and a different response shape from every other call:
   * this one answers bytes, not `{ok, result}`, so it does not go through
   * `call`. Telegram will not serve a bot a file over 20 MB (`MAX_FILE_BYTES`)
   * — the caller checks the size first and says so in words.
   */
  async downloadFile(filePath: string, signal?: any): Promise<Buffer> {
    const url = `${this.#baseUrl}/file/bot${this.#token}/${filePath}`;
    const res = await this.#fetch(url, { method: 'GET', signal });
    if (!res.ok) {
      throw new TelegramApiError('downloadFile', res.status, `could not download ${filePath}`);
    }
    if (typeof res.arrayBuffer === 'function') {
      return Buffer.from(await res.arrayBuffer());
    }
    // A fetch implementation without `arrayBuffer` (a test fake, an old shim):
    // latin-1 is the one text encoding that round-trips arbitrary bytes.
    return Buffer.from(await res.text(), 'latin1');
  }

  getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe', {});
  }

  /** Long poll. `offset` is the first update id we have *not* processed. */
  getUpdates(offset: number | undefined, signal?: any): Promise<TelegramUpdate[]> {
    const body: Record<string, unknown> = {
      timeout: POLL_TIMEOUT_SECONDS,
      allowed_updates: ALLOWED_UPDATES,
    };
    if (offset !== undefined) body.offset = offset;
    // The poll's own silence budget: this request is *meant* to say nothing for
    // up to `POLL_TIMEOUT_SECONDS`. See the header.
    return this.call<TelegramUpdate[]>('getUpdates', body, signal, POLL_IDLE_TIMEOUT_MS);
  }

  /**
   * Plain text only. The advisor's markdown (tables above all) renders badly on
   * Telegram, and any parse mode turns user-authored text into a parsing hazard
   * — so no `parse_mode` is ever sent.
   */
  async sendMessage(
    chatId: string | number,
    text: string,
    opts: { replyMarkup?: InlineKeyboardMarkup } = {},
  ): Promise<number | undefined> {
    let firstId: number | undefined;
    const chunks = splitMessage(text);
    for (const [index, chunk] of chunks.entries()) {
      // A keyboard belongs to the *last* chunk: it must sit under the whole
      // message the owner is being asked about, not under its first page.
      const last = index === chunks.length - 1;
      const result = await this.call<{ message_id?: number }>('sendMessage', {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
        ...(last && opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
      });
      const id = typeof result?.message_id === 'number' ? result.message_id : undefined;
      if (firstId === undefined) firstId = id;
    }
    return firstId;
  }

  /**
   * Replace the text of a message we sent. Telegram rejects an edit whose text
   * is identical to the current one, and refuses very old messages — callers
   * treat a failure as cosmetic and fall back to a fresh message.
   */
  async editMessageText(
    chatId: string | number,
    messageId: number,
    text: string,
    opts: { replyMarkup?: InlineKeyboardMarkup } = {},
  ): Promise<void> {
    await this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      // An omitted `reply_markup` leaves the old keyboard in place; an empty
      // one takes it away. A decided approval must never keep its buttons.
      ...(opts.replyMarkup ? { reply_markup: opts.replyMarkup } : {}),
    });
  }

  /**
   * Take a message's keyboard away (or replace it) without touching its text.
   *
   * `editMessageText` would work too, but only by resending text this caller
   * does not have — an offered action's report was written by an agent in a
   * previous run, and re-rendering it here would be guessing.
   */
  async editMessageReplyMarkup(
    chatId: string | number,
    messageId: number,
    replyMarkup: InlineKeyboardMarkup,
  ): Promise<void> {
    await this.call('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
  }

  /**
   * Answer a callback query. Telegram shows a spinner on the button until this
   * arrives, and expires the query after ~15 seconds, so it is sent even when
   * the decision was refused — silence would look like a broken bot.
   */
  async answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
    opts: { showAlert?: boolean } = {},
  ): Promise<void> {
    await this.call('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
      ...(opts.showAlert ? { show_alert: true } : {}),
    });
  }

  async deleteMessage(chatId: string | number, messageId: number): Promise<void> {
    await this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  async sendChatAction(chatId: string | number, action = 'typing'): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action });
  }

  /**
   * Publish the command menu for a scope. Omitting `scope` is Telegram's
   * `default` scope — buddi always passes one, so the menu is a per-chat fact.
   */
  async setMyCommands(
    commands: readonly TelegramBotCommand[],
    scope?: TelegramCommandScope,
  ): Promise<void> {
    await this.call('setMyCommands', {
      commands,
      ...(scope ? { scope } : {}),
    });
  }

  /** Clear a scope's menu, so chats in it fall back to the next scope up. */
  async deleteMyCommands(scope?: TelegramCommandScope): Promise<void> {
    await this.call('deleteMyCommands', { ...(scope ? { scope } : {}) });
  }
}

/**
 * Split a reply into Telegram-sized chunks, preferring paragraph then line
 * boundaries, and hard-cutting only a single line longer than the limit.
 */
export function splitMessage(text: string, limit = MAX_MESSAGE_CHARS): string[] {
  const body = text.trim() === '' ? '(no reply)' : text;
  if (body.length <= limit) return [body];

  const chunks: string[] = [];
  let rest = body;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf('\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest !== '') chunks.push(rest);
  return chunks;
}
