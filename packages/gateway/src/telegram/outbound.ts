/**
 * What a run's outcome becomes on Telegram, and the one place it is sent from.
 *
 * The surface decides *what* a turn produced — the text, the keyboard under
 * it, the files it saved, the view it drew — and hands it here. This module
 * decides how that reaches a phone: plain text (never markdown, never a parse
 * mode, with one escaped exception for a table), a placeholder that becomes
 * the answer, an answer streamed into one message while the model speaks,
 * files after the text, and a sentence naming the dashboard for anything a
 * chat cannot hold.
 *
 * Nothing here decides who the owner is or what a run may do. Every send is
 * presentation, and every failure but the final text's is cosmetic.
 */
import {
  MAX_MESSAGE_CHARS,
  MAX_PHOTO_BYTES,
  MAX_SEND_BYTES,
  TELEGRAM_MAX_MESSAGE_CHARS,
  TelegramApiError,
  splitMessage,
  type InlineKeyboardMarkup,
  type TelegramApi,
} from './api.js';
import { formatBytes, type ArtifactRow, type ArtifactStore } from './attachments.js';
import { canvasShow, type CanvasShowInput } from '../agents/canvas.js';

/* ------------------------------------------------------------------ *
 * The first-run burst
 * ------------------------------------------------------------------ */

/** How many messages one first-run answer may be broken into. */
export const MAX_BURST_MESSAGES = 3;

/** The pause between them: long enough to read as typing, short enough to wait. */
export const BURST_GAP_MS = 600;

/**
 * Break an answer into the messages it should arrive as.
 *
 * A paragraph break is the agent saying "and then this" — in a chat that is a
 * second message, not a blank line inside one bubble. So up to
 * `MAX_BURST_MESSAGES` paragraphs become that many sends, with a typing
 * indicator in between.
 *
 * The cap is a cap, not a truncation: an answer with *more* paragraphs than
 * that is sent whole. Breaking a six-paragraph explanation into three bubbles
 * and a blob would read worse than either, and a first run should never be
 * six paragraphs anyway — the skill says two short messages, maximum.
 */
export function splitIntoMessages(text: string, max = MAX_BURST_MESSAGES): string[] {
  const body = text.trim();
  if (body === '') return [];
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (paragraphs.length <= 1 || paragraphs.length > max) return [body];
  return paragraphs;
}


/**
 * Send one answer as up to three messages, typing between them.
 *
 * The pause is the whole point: three bubbles posted in the same millisecond
 * are one block with extra steps. `splitIntoMessages` decides how many there
 * are; this only paces them.
 */
export async function sendBurst(
  api: Pick<TelegramApi, 'sendMessage' | 'sendChatAction'>,
  chatId: string,
  reply: string,
  gapMs: number = BURST_GAP_MS,
): Promise<void> {
  const parts = splitIntoMessages(reply);
  if (parts.length === 0) {
    await api.sendMessage(chatId, '(no reply)');
    return;
  }
  for (const [index, part] of parts.entries()) {
    if (index > 0) {
      await api.sendChatAction(chatId).catch(() => {});
      await sleep(gapMs);
    }
    await api.sendMessage(chatId, part);
  }
}

/* ------------------------------------------------------------------ *
 * Plain text safety net
 * ------------------------------------------------------------------ */

/*
 * We never send `parse_mode`, so any markdown a model emits is shown to the
 * owner literally: `**Status — 2026-09-13**`, backticks, pipe tables. The
 * prompt asks for plain text; this is the deterministic net under that ask.
 *
 * It is pure and conservative: markers are only removed when they actually
 * wrap a span, so arithmetic (`2 * 3`) and identifiers (`snake_case`) survive
 * untouched, and no digit, currency symbol or word is ever rewritten.
 */

/** A ``` fence line, with or without a language tag. */
const FENCE_RE = /^\s*```[A-Za-z0-9_+-]*\s*$/;

/** `# Heading` → `Heading`. Only at the start of a line, marker plus space. */
const HEADING_RE = /^(\s*)#{1,6}[ \t]+(?=\S)/;

/** `[label](url)` → `label (url)`. */
const LINK_RE = /\[([^\]\n]*)\]\(([^()\s]*)\)/g;

/** `` `code` `` → `code`. Single backticks only; the span may not be empty. */
const INLINE_CODE_RE = /`([^`\n]+)`/g;

/** `**bold**` — both markers must hug non-space, so `a ** b` is left alone. */
const BOLD_STAR_RE = /\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g;

/** `__bold__` — word characters on either side mean it is an identifier. */
const BOLD_UNDER_RE = /(^|[^\w])__(?=\S)([^_\n]+?)(?<=\S)__(?!\w)/g;

/** `*italic*` — a lone `*` (as in `2 * 3`) never matches: it wraps nothing. */
const ITALIC_STAR_RE = /\*(?=\S)([^*\n]+?)(?<=\S)\*/g;

/** `_italic_` — `snake_case` keeps its underscores: they sit inside a word. */
const ITALIC_UNDER_RE = /(^|[^\w])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g;

/** `|---|:--:|` and friends: a table rule carries no content. */
function isTableSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

/** `| a | b |` → `a — b`; the separator row is dropped by the caller. */
function tableCells(line: string): string[] | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || trimmed.length < 2) return undefined;
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  if (!inner.includes('|') && inner.trim() === '') return undefined;
  return inner.split('|').map((cell) => cell.trim());
}

/** Marker removal inside one line of prose. Never applied to fenced code. */
function stripInline(line: string): string {
  return line
    .replace(LINK_RE, (whole, label: string, url: string) => {
      const text = label.trim();
      if (url === '') return text;
      return text === '' ? url : `${text} (${url})`;
    })
    .replace(INLINE_CODE_RE, '$1')
    .replace(BOLD_STAR_RE, '$1')
    .replace(BOLD_UNDER_RE, '$1$2')
    .replace(ITALIC_STAR_RE, '$1')
    .replace(ITALIC_UNDER_RE, '$1$2');
}

/* ------------------------------------------------------------------ *
 * Tool names never reach the owner
 * ------------------------------------------------------------------ */

/**
 * The namespaces the runtime registers tools under. Tool names are internal
 * plumbing: the owner is told what happened, never which function did it.
 * The personas say so, and this pass is the deterministic net under that ask
 * for the turns where the model slips anyway.
 *
 * The surface is constructed without a registry to read, so this is the one
 * place the namespaces live. A new namespace belongs here the day its tools
 * are registered.
 */
export const TOOL_NAMESPACES = [
  'finance',
  'memory',
  'artifacts',
  'email',
  'agent',
  'mission',
  'reminder',
  'schedule',
] as const;

/**
 * Tool names that carry no underscore. A dotted pair counts as a tool only
 * when the namespace is known *and* the second half is snake_case or one of
 * these — "has a dot" is never the rule, so `gmail.com`, `shotcrisp.app`,
 * `Statement.pdf`, `v1.2.3` and an email address are all left alone.
 */
const TOOL_WORDS = [
  'summary',
  'balance',
  'delegate',
  'report',
  'silent',
  'status',
  'search',
  'send',
  'list',
  'add',
  'set',
  'get',
  'cancel',
  'snooze',
  'purge',
  'remember',
  'recall',
  'forget',
  'note',
  'read',
  'text',
  'describe',
  'reconcile',
] as const;

const NAMESPACE_ALT = TOOL_NAMESPACES.join('|');

/**
 * `finance.set_liability`, `agent.delegate`. The guards on either side keep
 * the match off anything that merely contains a dot: a longer hostname
 * (`mail.finance.summary.io`), a path segment, an address local part. A dot
 * that ends a sentence is not a continuation, so a mention may close one.
 */
const TOOL_REF_SRC =
  `(?<![\\w./@-])(?:${NAMESPACE_ALT})\\.` +
  `(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+|${TOOL_WORDS.join('|')})(?![\\w@/-])(?!\\.[A-Za-z0-9])`;

/** `(finance.set_liability)`, `(via agent.delegate)` — the whole aside goes. */
const TOOL_PAREN_RE = new RegExp(
  `[ \\t]*\\((?:\\s*(?:via|see|using|through|with|by)\\s+)?${TOOL_REF_SRC}` +
    `(?:[ \\t]*(?:,|and|\\+|&)[ \\t]*${TOOL_REF_SRC})*[ \\t]*\\)`,
  'gi',
);

/** `` `finance.x` ``, `'finance.x'`, `"finance.x"` — the quotes leave with it. */
const TOOL_QUOTED_RE = new RegExp(`[\`'"“‘]${TOOL_REF_SRC}[\`'"”’]`, 'gi');

/** A bare mention, with the connector that introduced it when there is one. */
const TOOL_BARE_RE = new RegExp(
  `(?:[ \\t]+(?:via|using|through|by calling)[ \\t]+)?${TOOL_REF_SRC}`,
  'gi',
);

/**
 * Spacing and punctuation left dangling by a removal: `stored , and` or
 * `on the calendar .`. Applied only to a line something was actually removed
 * from, so prose that mentions no tool is returned byte for byte.
 */
function tidyAfterRemoval(cleaned: string, indent: string): string {
  const body = cleaned
    .replace(/\(\s*\)/g, '')
    .replace(/\[\s*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\([ \t]+/g, '(')
    .replace(/[ \t]+([,.;:!?)])/g, '$1')
    .replace(/,(?:[ \t]*,)+/g, ',')
    .replace(/,[ \t]*([.;:!?])/g, '$1')
    .replace(/([.;:!?])[ \t]*,/g, '$1')
    .trim();
  if (body === '') return '';
  // All that survived is punctuation: the mention *was* the sentence. Drop
  // the remains and leave every other line of the answer untouched.
  return /^[,.;:!?—-]+$/.test(body) ? '' : `${indent}${body}`;
}

/** One line of prose, minus any tool reference and the mess it leaves. */
function stripToolNamesFromLine(line: string): string {
  const cleaned = line
    .replace(TOOL_PAREN_RE, '')
    .replace(TOOL_QUOTED_RE, '')
    .replace(TOOL_BARE_RE, '');
  if (cleaned === line) return line;
  return tidyAfterRemoval(cleaned, /^[ \t]*/.exec(line)?.[0] ?? '');
}

/**
 * Remove internal tool names from an agent answer. Pure, idempotent, and
 * conservative: a line with no tool reference in it is returned unchanged.
 *
 * Exported on its own so every surface that renders an answer — Telegram
 * through `toPlainText`, the CLI directly — applies the same rule.
 */
export function stripToolNames(text: string): string {
  if (text === '') return '';
  return text.split('\n').map(stripToolNamesFromLine).join('\n');
}

/**
 * Render agent-authored markdown as the plain text Telegram will display
 * verbatim. Pure: same input, same output, no clock and no I/O.
 *
 * Applied to final agent and mission answers only. Progress lines and the
 * surface's own copy (`/help`, `/agents`) are already plain by construction.
 */
export function toPlainText(text: string): string {
  if (text === '') return '';
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      // Drop the fence, keep whatever it wrapped.
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const cells = tableCells(line);
    if (cells) {
      if (isTableSeparatorRow(cells)) continue;
      out.push(stripToolNamesFromLine(stripInline(cells.join(' — '))));
      continue;
    }

    out.push(stripToolNamesFromLine(stripInline(line.replace(HEADING_RE, '$1'))));
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}


/* ------------------------------------------------------------------ *
 * Landing the answer
 * ------------------------------------------------------------------ */

/** What every send below needs: the Bot API and somewhere to say it failed. */
export interface OutboundDeps {
  api: TelegramApi;
  log: (line: string) => void;
}

/** How many times the final text is re-sent after a 429 before giving up. */
const FINAL_RETRIES = 3;

/**
 * Land the finished answer: in `messageId` (the placeholder, or the message
 * the stream has been editing) when there is one, as new messages otherwise.
 *
 * Longer than Telegram's 4,096: the first part goes in that message and the
 * rest follows as new messages, cut at paragraph boundaries. A keyboard sits
 * under the last part. This is the one write that must land — a 429 is waited
 * out, and an edit Telegram refuses becomes a fresh message.
 */
export async function landAnswer(
  deps: OutboundDeps,
  chatId: string,
  messageId: number | undefined,
  reply: string,
  keyboard?: InlineKeyboardMarkup,
): Promise<void> {
  const text = reply.trim() === '' ? '(no reply)' : reply;
  const parts = splitMessage(text, TELEGRAM_MAX_MESSAGE_CHARS);
  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1;
    const markup = last && keyboard ? { replyMarkup: keyboard } : {};
    const send = { ...markup, splitAt: TELEGRAM_MAX_MESSAGE_CHARS };
    if (index === 0 && messageId !== undefined) {
      const edited = await retrying(deps, () => deps.api.editMessageText(chatId, messageId, part, markup))
        .then(() => true)
        .catch((err) => {
          // Telegram refuses an edit whose text is already there: the answer
          // landed, which is all this call is for.
          if (err instanceof TelegramApiError && /not modified/i.test(err.description) && !keyboard) return true;
          deps.log(`telegram: final edit failed, sending instead: ${message(err)}`);
          return false;
        });
      if (edited) continue;
    }
    await retrying(deps, () => deps.api.sendMessage(chatId, part, send));
  }
}

/** Run a Bot API call, waiting out a 429 as often as `FINAL_RETRIES` allows. */
async function retrying<T>(deps: OutboundDeps, call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await call();
    } catch (err) {
      if (!(err instanceof TelegramApiError) || err.retryAfter === undefined || attempt >= FINAL_RETRIES) throw err;
      deps.log(`telegram: rate limited, waiting ${err.retryAfter}s before the final text`);
      await sleep(err.retryAfter * 1000);
    }
  }
}

/* ------------------------------------------------------------------ *
 * Streaming
 * ------------------------------------------------------------------ */

/** The shortest gap between two edits of a streamed answer. */
export const STREAM_EDIT_INTERVAL_MS = 1500;

/** What a streamed answer needs beyond the Bot API. */
export interface StreamOptions {
  /** Default `STREAM_EDIT_INTERVAL_MS`. */
  intervalMs?: number;
  now?: () => number;
  /**
   * Awaited once, before the first chunk is written: the placeholder's
   * progress line stops editing, and whatever edit it had in flight lands
   * first, so the stream's text is never overwritten by an older line.
   */
  takeOver?: () => Promise<void>;
  /** Send `typing` when the stream is made. Off when the caller already types. */
  typing?: boolean;
  /** Applied to the accumulated text before it is shown. Default `toPlainText`. */
  render?: (text: string) => string;
}

/**
 * One answer, shown while the model speaks.
 *
 * The first chunk lands at once — in the placeholder when there is one, as a
 * new message otherwise — and the same message is edited with the whole text
 * so far at most once per interval, cut at 4,000 characters with an ellipsis
 * while it grows. On a 429 no edit is attempted until Telegram's `retry_after`
 * has passed; the text keeps accumulating and the next edit carries all of
 * it. `finish` writes the whole answer last, whatever happened before.
 *
 * `push` is synchronous and never throws: the runtime's delta hook must not
 * wait on Telegram, and a failed edit must not cost the owner the run.
 */
export class StreamedAnswer {
  readonly #deps: OutboundDeps;
  readonly #chatId: string;
  readonly #opts: StreamOptions;
  #messageId: number | undefined;
  #text = '';
  #shown = '';
  #started = false;
  #closed = false;
  #inFlight = false;
  #lastEditAt = 0;
  #pausedUntil = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #chain: Promise<void> = Promise.resolve();

  constructor(deps: OutboundDeps, chatId: string, placeholderId: number | undefined, opts: StreamOptions = {}) {
    this.#deps = deps;
    this.#chatId = chatId;
    this.#messageId = placeholderId;
    this.#opts = opts;
    if (opts.typing) deps.api.sendChatAction(chatId).catch(() => {});
  }

  /** Has any of the answer been shown yet? */
  get streamed(): boolean {
    return this.#started;
  }

  #now(): number {
    return (this.#opts.now ?? Date.now)();
  }

  /** A piece of the answer, as the model writes it. */
  push(delta: string): void {
    if (this.#closed || delta === '') return;
    this.#text += delta;
    if (this.#text.trim() === '') return;
    if (!this.#started) {
      this.#started = true;
      this.#flush();
      return;
    }
    this.#schedule();
  }

  #schedule(): void {
    if (this.#timer !== undefined || this.#closed) return;
    const interval = this.#opts.intervalMs ?? STREAM_EDIT_INTERVAL_MS;
    const at = Math.max(this.#lastEditAt + interval, this.#pausedUntil);
    const t = setTimeout(() => {
      this.#timer = undefined;
      this.#flush();
    }, Math.max(0, at - this.#now()));
    if (typeof t.unref === 'function') t.unref();
    this.#timer = t;
  }

  #flush(): void {
    if (this.#closed) return;
    const now = this.#now();
    // Backing off, or the last write has not come back: try again later with
    // everything that arrived meanwhile, rather than queueing stale edits.
    if (now < this.#pausedUntil || this.#inFlight) {
      this.#schedule();
      return;
    }
    const render = this.#opts.render ?? toPlainText;
    const view = cutForStream(render(this.#text));
    if (view.trim() === '' || view === this.#shown) return;
    const first = this.#shown === '';
    const before = this.#shown;
    this.#shown = view;
    this.#lastEditAt = now;
    this.#inFlight = true;
    this.#chain = this.#chain.then(async () => {
      try {
        if (first && this.#opts.takeOver) await this.#opts.takeOver();
        if (this.#closed) return;
        if (this.#messageId === undefined) {
          this.#messageId = await this.#deps.api.sendMessage(this.#chatId, view);
        } else {
          await this.#deps.api.editMessageText(this.#chatId, this.#messageId, view);
        }
      } catch (err) {
        if (err instanceof TelegramApiError && err.retryAfter !== undefined) {
          this.#pausedUntil = this.#now() + err.retryAfter * 1000;
        }
        // Shown again next time: the text on the phone is not this one.
        this.#shown = before;
        this.#deps.log(`telegram: stream edit failed: ${message(err)}`);
      } finally {
        this.#inFlight = false;
      }
    });
  }

  /**
   * Write the whole answer, with its keyboard, as the last word. Waits for any
   * edit in flight and out any back-off first, so nothing older lands after it.
   */
  async finish(reply: string, keyboard?: InlineKeyboardMarkup): Promise<void> {
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    await this.#chain;
    if (!this.#started && this.#opts.takeOver) await this.#opts.takeOver();
    const wait = this.#pausedUntil - this.#now();
    if (wait > 0) await sleep(wait);
    await landAnswer(this.#deps, this.#chatId, this.#messageId, reply, keyboard);
  }
}

/** The text so far, cut to what one message holds while it is still growing. */
export function cutForStream(text: string, limit = MAX_MESSAGE_CHARS): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}

/* ------------------------------------------------------------------ *
 * The canvas, on a phone
 * ------------------------------------------------------------------ */

/** A view an agent drew with `canvas.show`: the platform's shapes, checked. */
export type CanvasView = CanvasShowInput;

/**
 * The canvas after one tool call: what `canvas.show` drew, nothing after
 * `canvas.clear`, unchanged by anything else. The canvas holds one view, so
 * the last one drawn is the one a run leaves behind.
 */
export function canvasAfterCall(
  current: CanvasView | undefined,
  name: string,
  input: unknown,
): CanvasView | undefined {
  if (name === 'canvas.clear') return undefined;
  if (name !== 'canvas.show') return current;
  const parsed = canvasShow.input.safeParse(input);
  return parsed.success ? (parsed.data as CanvasView) : current;
}

type TableView = Extract<CanvasView, { renderer: 'table' }>;
type Cell = string | number | boolean | null;

function cellText(value: Cell | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value).replace(/\s+/g, ' ').trim();
}

/** Every row as strings, padded to the column count (ragged rows are padded). */
function tableGrid(view: TableView): string[][] {
  const width = view.data.columns.length;
  return view.data.rows.map((row) => Array.from({ length: width }, (_, i) => cellText(row[i] as Cell | undefined)));
}

/**
 * A table as monospace lines: a header, a rule, the rows, numbers aligned to
 * the right. Plain text; the HTML wrapper is `tableMessage`.
 */
export function tableText(view: TableView): string {
  const headers = view.data.columns.map((c) => c.label);
  const rows = tableGrid(view);
  const numeric = view.data.columns.map((c, i) =>
    c.unit === 'number' || c.unit === 'currency' || c.unit === 'percent' ||
    (rows.length > 0 && rows.every((r) => r[i] === '' || /^-?[\d.,]+%?$/.test(r[i] as string))),
  );
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] as string).length)));
  const line = (cells: readonly string[]): string =>
    cells.map((cell, i) => (numeric[i] ? cell.padStart(widths[i] as number) : cell.padEnd(widths[i] as number))).join('  ').trimEnd();
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The table as one HTML message — the title, then the grid in `<pre>` — or
 * undefined when it would not fit one message. Every character that came from
 * the agent is escaped; the only markup is the two tags written here.
 */
export function tableMessage(view: TableView, limit = MAX_MESSAGE_CHARS): string | undefined {
  const head = view.title ? `${escapeHtml(view.title)}\n` : '';
  const html = `${head}<pre>${escapeHtml(tableText(view))}</pre>`;
  return html.length <= limit ? html : undefined;
}

/** The table as CSV: a header row, then the rows, quoted where they need it. */
export function tableCsv(view: TableView): string {
  const quote = (cell: string): string => (/[",\n\r]|^\s|\s$/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);
  const lines = [view.data.columns.map((c) => c.label), ...tableGrid(view)];
  return `${lines.map((cells) => cells.map(quote).join(',')).join('\r\n')}\r\n`;
}

/** A file name from a view title: no separators, no control characters. */
export function csvName(title: string | undefined): string {
  const base = (title ?? '').replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `${base === '' ? 'table' : base}.csv`;
}

/** Said for a view a chat cannot hold. */
export const CHART_TEXT = 'That is a chart; open the dashboard to see it.';
export const VIEW_TEXT = 'That is on the dashboard beside the chat; open the dashboard to see it.';

/** The one line for a chart or any other view, with the link when there is one. */
export function viewLine(view: CanvasView, dashboardUrl?: string): string {
  const said = view.renderer === 'timeseries' || view.renderer === 'bars' ? CHART_TEXT : VIEW_TEXT;
  return dashboardUrl ? `${said}\n${dashboardUrl}` : said;
}

/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */

/** How many of a run's files are sent; the rest are named as a count. */
export const MAX_FILES_OUT = 10;

/** Pictures Telegram shows inline. Anything else image-shaped goes as a file. */
const PHOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const MIME_EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'text/csv': '.csv',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

/** The name a file is sent under: its own, or one made from its type. */
export function sendName(row: Pick<ArtifactRow, 'id' | 'filename' | 'mime'>): string {
  if (row.filename && row.filename.trim() !== '') return row.filename.trim();
  return `file-${row.id.slice(0, 8)}${MIME_EXT[row.mime] ?? ''}`;
}

/** A file over Telegram's limit, in one sentence naming where it is. */
export function tooBigText(name: string, bytes: number, filesUrl?: string): string {
  const said = `${name} is ${formatBytes(bytes)}, over Telegram's 50 MB limit; it is on the dashboard, under Files.`;
  return filesUrl ? `${said}\n${filesUrl}` : said;
}

/** A file that could not be sent for any other reason. */
export function fileFailedText(name: string, filesUrl?: string): string {
  const said = `I could not send ${name} here; it is on the dashboard, under Files.`;
  return filesUrl ? `${said}\n${filesUrl}` : said;
}

/** What is said for the files past `MAX_FILES_OUT`. */
export function moreFilesText(count: number, filesUrl?: string): string {
  const said = `And ${count} more ${count === 1 ? 'file' : 'files'} on the dashboard, under Files.`;
  return filesUrl ? `${said}\n${filesUrl}` : said;
}

/** What sending a run's extras needs. */
export interface ExtrasDeps extends OutboundDeps {
  artifacts?: ArtifactStore;
  /** The public dashboard origin, when one is configured. Links are only given then. */
  publicOrigin?: string;
}

/** The dashboard's address for a phone, or undefined when it is on this computer only. */
export function dashboardUrl(publicOrigin: string | undefined, route = ''): string | undefined {
  if (!publicOrigin) return undefined;
  return `${publicOrigin.replace(/\/$/, '')}/${route.replace(/^\//, '')}`;
}

/** Send one file a run saved, or the sentence that stands in for it. */
async function sendFile(deps: ExtrasDeps, chatId: string, id: string, filesUrl?: string): Promise<void> {
  const store = deps.artifacts;
  if (!store?.describe) return;
  const row = await store.describe(id).catch((err) => {
    deps.log(`telegram: file ${id} unreadable: ${message(err)}`);
    return null;
  });
  if (!row) return;
  const name = sendName(row);
  if (row.sizeBytes > MAX_SEND_BYTES) {
    await deps.api.sendMessage(chatId, tooBigText(name, row.sizeBytes, filesUrl));
    return;
  }
  try {
    const loaded = await store.load(id);
    if (!loaded) throw new Error('the file is gone');
    const bytes = Buffer.from(loaded.data, 'base64');
    const mime = row.mime || loaded.mime;
    if (PHOTO_MIMES.has(mime) && bytes.length <= MAX_PHOTO_BYTES) {
      // A picture shows no name of its own, so the caption carries it.
      await deps.api.sendPhoto(chatId, bytes, { filename: name, contentType: mime, caption: name });
    } else {
      // A document shows its name already; a caption would say it twice.
      await deps.api.sendDocument(chatId, bytes, { filename: name, contentType: mime });
    }
  } catch (err) {
    deps.log(`telegram: sending ${name} failed: ${message(err)}`);
    await deps.api.sendMessage(chatId, fileFailedText(name, filesUrl)).catch(() => {});
  }
}

/** Send the view a run left on the canvas, the way a phone can hold it. */
async function sendView(deps: ExtrasDeps, chatId: string, view: CanvasView): Promise<void> {
  if (view.renderer !== 'table') {
    await deps.api.sendMessage(chatId, viewLine(view, dashboardUrl(deps.publicOrigin)));
    return;
  }
  if (view.data.rows.length === 0) {
    const empty = view.data.empty?.trim() || 'The table is empty.';
    await deps.api.sendMessage(chatId, view.title ? `${view.title}\n${empty}` : empty);
    return;
  }
  const html = tableMessage(view);
  if (html !== undefined) {
    await deps.api.sendMessage(chatId, html, { parseMode: 'HTML' });
    return;
  }
  await deps.api.sendDocument(chatId, Buffer.from(tableCsv(view), 'utf8'), {
    filename: csvName(view.title),
    contentType: 'text/csv',
  });
}

/**
 * Everything a run produced besides its text, sent after the text: the view
 * it left on the canvas, then the files it saved, in the order it saved them.
 * Each send is independent — one failure never stops the rest.
 */
export async function sendRunExtras(
  deps: ExtrasDeps,
  chatId: string,
  extras: { artifacts?: readonly string[]; canvas?: CanvasView },
): Promise<void> {
  if (extras.canvas) {
    await sendView(deps, chatId, extras.canvas).catch((err) => {
      deps.log(`telegram: sending the canvas view failed: ${message(err)}`);
    });
  }
  const ids = [...new Set(extras.artifacts ?? [])];
  if (ids.length === 0) return;
  const filesUrl = dashboardUrl(deps.publicOrigin, '#/files');
  for (const id of ids.slice(0, MAX_FILES_OUT)) {
    await sendFile(deps, chatId, id, filesUrl).catch((err) => {
      deps.log(`telegram: file ${id} not sent: ${message(err)}`);
    });
  }
  if (ids.length > MAX_FILES_OUT) {
    await deps.api.sendMessage(chatId, moreFilesText(ids.length - MAX_FILES_OUT, filesUrl)).catch(() => {});
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
}
