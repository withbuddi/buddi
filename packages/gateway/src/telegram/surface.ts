/**
 * The Telegram surface (roadmap step 2).
 *
 * A surface authenticates the sender and translates presentation; it never
 * decides authorization and never creates a run for anyone but the owner.
 * Concretely:
 *
 *  - Identity is the *numeric* user id Telegram asserts. Usernames, forward
 *    headers and chat membership are never consulted. Only private chats.
 *  - Authorization is `resolveOwnerForSurface` in core. A refusal is recorded
 *    as a `surface.rejected` event and is never answered — an unknown sender
 *    learns nothing, not even that the bot is alive.
 *  - Offline contract: an update row is written to the dedup ledger *before*
 *    the polling offset advances, and an update id is processed at most once.
 *  - Runs are serialized per chat, so two quick messages cannot interleave in
 *    one conversation.
 */
import {
  DEFAULT_TIMEZONE,
  consumePairingCode,
  getActiveAgent,
  getOwnerDisplayName,
  listSurfaceIdentitiesDetailed,
  localDateString,
  recordSurfaceUpdate,
  resolveOwnerForSurface,
  setActiveAgent,
  setSurfaceCursor,
  touchSurfaceIdentity,
  type Queryable,
} from '@buddi/core';
import { createConversation } from '@buddi/runtime';
import {
  MAX_CALLBACK_DATA_BYTES,
  MAX_MESSAGE_CHARS,
  type InlineKeyboardMarkup,
  type TelegramApi,
  type TelegramUpdate,
} from './api.js';
import {
  attachmentNote,
  extractAttachment,
  filesText,
  formatBytes,
  getLastAttachment,
  gotAudioText,
  gotFileText,
  isViewable,
  listChatAttachments,
  MAX_ATTACHMENT_BYTES,
  ATTACHMENT_RECENCY_MS,
  oversizeText,
  recordChatAttachment,
  referencesAttachment,
  type ArtifactRow,
  type ArtifactStore,
  type IncomingAttachment,
} from './attachments.js';
import { isUnknownAgentError, type AgentCatalog, type CatalogAgent } from './types.js';

export const SURFACE = 'telegram';

/** The bubble posted when the agent that is working is not known by name. */
export const PLACEHOLDER_TEXT = '⏳ Working on it…';

/**
 * The name the bubble uses: the handle, capitalized — `ledger` → `Ledger`.
 *
 * The owner addresses agents by handle, so the progress line answers in the
 * same currency. The long `name` stays where there is room for it: the command
 * menu and `/agents`.
 */
export function handleLabel(handle?: string): string {
  const raw = (handle ?? '').trim().replace(/^@/, '');
  if (raw === '') return '';
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

/** `⏳ Ledger is working…` — the owner sees *who* they are waiting on. */
export function placeholderText(agentLabel?: string): string {
  const name = (agentLabel ?? '').trim();
  return name === '' ? PLACEHOLDER_TEXT : `⏳ ${name} is working…`;
}

/** `⏳ Ledger is reading your file…` — a file run says what it is doing. */
export function readingText(agentLabel?: string): string {
  const name = (agentLabel ?? '').trim();
  return name === '' ? '⏳ Reading your file…' : `⏳ ${name} is reading your file…`;
}

/**
 * `/status` and `/recap` are finance features: they are answered by this agent
 * whichever one the chat is currently talking to.
 */
export const FINANCE_ADVISOR_ID = 'finance-advisor';

/** Telegram rate-limits edits; one per this window is plenty for a progress line. */
export const PROGRESS_EDIT_INTERVAL_MS = 1500;

/** `/files` never floods the chat: the tail of the history, newest first. */
export const FILES_LIMIT = 10;

/** Progress lines stay short — a long one is truncated with an ellipsis. */
export const PROGRESS_MAX_CHARS = 200;

/** Tool name → what the owner sees while it runs. */
const TOOL_LABELS: Record<string, string> = {
  'finance.list_accounts': 'checking accounts',
  'finance.project_cashflow': 'projecting cash flow',
  'finance.summary': 'summarizing spending',
  'finance.list_liabilities': 'checking debts',
  'finance.spending_baseline': 'measuring typical spending',
};

/** Unknown tools degrade to their own name: `finance.list_txns` → `list txns`. */
export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/^finance\./, '').replace(/_/g, ' ');
}

/** `⏳ Working… (checking accounts, projecting cash flow)`, capped in length. */
export function progressLine(labels: readonly string[], placeholder = PLACEHOLDER_TEXT): string {
  const line = labels.length === 0
    ? placeholder
    : `⏳ Working… (${labels.join(', ')})`;
  return line.length <= PROGRESS_MAX_CHARS
    ? line
    : `${line.slice(0, PROGRESS_MAX_CHARS - 1)}…`;
}

/** Presentation hint passed to the run as `systemSuffix`. Not policy. */
export const SURFACE_HINT =
  'Surface: Telegram. Plain text only, no markdown tables, short lines.';

export const HELP = [
  'buddi on Telegram.',
  '',
  'Send a statement, a receipt photo or a CSV and tell me what to do with it.',
  '',
  'Just write your question. Commands:',
  '/agents — list the agents you can talk to, and tap one to switch',
  '/use <handle> — switch to an agent, e.g. /use @ledger',
  '@handle … — ask that agent this one message without switching',
  '/whoami — which agent is active here',
  '/status — where you stand right now (finance advisor)',
  '/recap — run the weekly recap now (finance advisor)',
  '/files — the last files you sent me',
  '/approvals — anything waiting for your approval',
  '/devices — the devices paired to this installation',
  '/new — start a fresh conversation with the active agent',
  '/id — your numeric user id and this chat id',
  '/help — this message',
].join('\n');

/**
 * A file arrived in a build with no artifact store wired up. Not an error the
 * owner caused, and said as a fact about the installation rather than a stack.
 */
export const FILES_UNAVAILABLE_TEXT =
  'I can read files only when the artifact store is wired up, and it is not in this build. Paste the numbers instead and I can still help.';

/** Download or storage failed. The owner is told, and can simply resend. */
export const FILE_FAILED_TEXT =
  "I couldn't save that file — send it again and I'll retry.";

/** No approval machinery in this build: said as a fact, not as an error. */
export const APPROVALS_UNAVAILABLE_TEXT =
  'Approvals are not wired up in this build, so nothing can be waiting for one.';

/** `/use` with an id the catalog does not know. Never an error to the owner. */
export const UNKNOWN_AGENT_TEXT = 'Unknown agent. Send /agents to see the list.';

/** `/use` with no argument at all. */
export const USE_WITHOUT_ID_TEXT = 'Send /use <handle>, for example /use @ledger. Send /agents to see the list.';

/**
 * A message addressed to `@nobody`. The typo is quoted back rather than spelled
 * with an `@`: Telegram would render that as a link to a user who is not there.
 */
export function unknownHandleText(handle: string): string {
  return `No agent called "${handle}". Send /agents.`;
}

/** `@ledger` and nothing else: there is no question to route. */
export function emptyMentionText(handle: string): string {
  return `What would you like to ask ${handleLabel(handle) || handle}?`;
}

/* ------------------------------------------------------------------ *
 * Pairing by one-time code
 * ------------------------------------------------------------------ */

/*
 * `/start <code>` from an unpaired user is the *only* message this surface
 * answers without a paired identity behind it, and the exception is narrow on
 * purpose:
 *
 *  - Only a good code is answered. A wrong, spent or expired one gets silence,
 *    exactly like any other stranger — a reply would confirm the bot exists and
 *    turn the code space into something worth probing.
 *  - Five attempts per user id per hour. The code space is 32^8, so five tries
 *    an hour is not a brute force; it is a typo budget.
 *  - The code is claimed in core, atomically. The surface never reads a code and
 *    then decides.
 */

/** Attempts one user id may make in `PAIRING_WINDOW_MS`. A typo budget. */
export const PAIRING_MAX_ATTEMPTS = 5;

/** The rate-limit window for pairing attempts: one hour. */
export const PAIRING_WINDOW_MS = 60 * 60 * 1000;

/** How often a device's `last_seen_at` is written, at most: once per 5 minutes. */
export const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

/**
 * The code in `/start ABCD2345`, if there is one. `/start` alone is the plain
 * welcome and returns nothing. Telegram's `/start@thebot CODE` form is accepted
 * because Telegram itself sends it.
 */
export function parseStartCode(text: string): string | undefined {
  const m = /^\/start(?:@\S+)?[ \t]+(\S+)[ \t]*$/i.exec(text.trim());
  return m ? (m[1] as string) : undefined;
}

/**
 * The name a device is *called*: `@username` when Telegram reports one, else
 * the first name, else nothing.
 *
 * Cosmetic by construction. It is stored so `buddi telegram devices` lists a
 * name instead of a bare number, and it is never read by anything that decides
 * whether a message is the owner's — a username is not an identity.
 */
export function senderLabel(from?: { username?: string; first_name?: string }): string | null {
  const username = (from?.username ?? '').trim();
  if (username !== '') return `@${username.replace(/^@/, '')}`;
  const first = (from?.first_name ?? '').trim();
  return first === '' ? null : first;
}

/** The one sentence a successful pairing answers with. */
export function pairedText(ownerDisplayName: string): string {
  return `Paired. You're talking to buddi as ${ownerDisplayName}. Send /help.`;
}

/** Shown when the owner row carries no name of its own. */
export const OWNER_FALLBACK_NAME = 'the owner';

/** Nothing is paired at all — only reachable when the row was just deleted. */
export const NO_DEVICES_TEXT = 'No devices are paired.';

/** What a device looks like to `/devices`. Structural: core's row satisfies it. */
export interface DeviceLine {
  id: string;
  surface: string;
  externalUserId: string;
  label: string | null;
  pairedAt: Date | null;
  lastSeenAt: Date | null;
}

/**
 * `/devices` — every paired device, with the id needed to revoke one.
 *
 * Unpairing is deliberately *not* a chat command: a stolen phone is already in
 * a paired chat, and letting that chat unpair the others would hand it the
 * installation. Revocation stays on the machine that hosts buddi.
 */
export function devicesText(devices: readonly DeviceLine[], timezone: string): string {
  if (devices.length === 0) return NO_DEVICES_TEXT;
  const lines = devices.map((d) => {
    const name = d.label && d.label.trim() !== '' ? d.label : d.externalUserId;
    const paired = d.pairedAt ? localDateString(d.pairedAt, timezone) : 'unknown';
    const seen = d.lastSeenAt ? localDateString(d.lastSeenAt, timezone) : 'never';
    return `• ${name} (${d.surface}) — paired ${paired}, last seen ${seen}\n  ${d.id}`;
  });
  return [
    'Paired devices:',
    ...lines,
    '',
    'To unpair one, run this where buddi is installed: buddi devices unpair <id>',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * @mentions
 * ------------------------------------------------------------------ */

/**
 * A message addressed to one agent: `@ledger can I afford a bike?`.
 *
 * Telegram itself may put its own mention first — tapping the bot in a group
 * list, or an autocompleted `@buddi_agent_bot` — so the bot's own username is
 * stripped before anything is parsed. It is a routing prefix, never part of the
 * question, and it is removed from the text the agent is given either way.
 */
export function stripBotMention(text: string, botUsername?: string): string {
  const bot = (botUsername ?? '').trim().replace(/^@/, '');
  if (bot === '') return text;
  const re = new RegExp(`^\\s*@${bot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[:,]?\\s*`, 'i');
  return text.replace(re, '');
}

export interface Mention {
  /** The handle as typed, without the `@`. Resolution is the catalog's job. */
  handle: string;
  /** What is left of the message once the address is taken off the front. */
  rest: string;
}

/**
 * Parse a leading `@handle`, optionally followed by `:` or `,`.
 *
 * Only at the very start: `@ledger what now?` addresses an agent, `pay @ledger`
 * is a sentence. An email address or a handle glued to other text matches
 * nothing, so a message is never rerouted by accident.
 */
export function parseMention(text: string, botUsername?: string): Mention | undefined {
  const stripped = stripBotMention(text, botUsername).trimStart();
  const m = /^@([A-Za-z][A-Za-z0-9-]{1,19})\s*[:,]?[ \t]*([\s\S]*)$/.exec(stripped);
  if (!m) return undefined;
  return { handle: m[1] as string, rest: (m[2] as string).trim() };
}

/** The mission `/recap` runs. Named here so the surface asks for one thing. */
export const RECAP_MISSION_ID = 'friday-recap';

/** `buddi-telegram` standalone has no scheduler wiring, and says so plainly. */
export const RECAP_UNAVAILABLE_TEXT =
  'The weekly recap runs from the scheduler, which is only wired up under `buddi serve`. Start buddi that way and /recap will work here.';

/** Nothing to run: the mission has never been registered. */
export const RECAP_NOT_REGISTERED_TEXT =
  'The weekly recap mission is not registered yet. Register it with: pnpm missions add-friday-recap';

/**
 * The outcome of an inline mission run. `unknown-mission` is not an error: the
 * installation simply never registered it, and the owner is told how to.
 */
export type MissionOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: 'unknown-mission' };

/**
 * Run a mission now and hand its text back for this chat. Injected by `serve`,
 * which owns the executor the scheduler uses; absent in the standalone surface.
 */
export type RunMission = (
  missionId: string,
  chatId: string,
  onToolCall?: (name: string, input: unknown) => void,
) => Promise<MissionOutcome>;

/** One artifact handed to the model as a content block, not as prose. */
export interface RunAttachment {
  artifactId: string;
  mime: string;
  kind: string;
}

export interface RunRequest {
  conversationId: string;
  chatId: string;
  text: string;
  /**
   * Files this turn can *see* — images and PDFs. Saved-but-unviewable files
   * (a CSV) are named in `text` with their artifact id instead, so the agent
   * reaches them through a tool rather than pretending to have read them.
   */
  attachments?: RunAttachment[];
  /**
   * The agent this turn belongs to — the chat's active one, except for the
   * finance-only commands, which name the finance advisor explicitly. The
   * surface resolves it; the caller never re-decides which agent runs.
   */
  agent: CatalogAgent;
  /**
   * Called by the runtime as each tool call is proposed. The surface uses it to
   * keep the placeholder bubble alive with a human progress line; it is purely
   * presentational and must never affect the run.
   */
  onToolCall?: (name: string, input: unknown) => void;
}

/**
 * What the surface asks of the approval machinery. A tap and a list; nothing
 * about state, and nothing it could decide on its own.
 */
export interface ApprovalHooks {
  handleCallback(query: NonNullable<TelegramUpdate['callback_query']>): Promise<void>;
  /** The `/approvals` answer, already rendered. */
  pending(): Promise<string>;
}

export interface TelegramSurfaceOptions {
  api: TelegramApi;
  pool: Queryable;
  /** Every agent this installation can talk to; the surface only reads it. */
  catalog: AgentCatalog;
  /**
   * The bot's own @username, as `getMe` reports it. Used for one thing: taking
   * Telegram's own mention off the front of a message before the owner's
   * `@handle` is read.
   */
  botUsername?: string;
  /**
   * Where an incoming file is put. Absent: files are declined in one sentence
   * and nothing else about the surface changes.
   */
  artifacts?: ArtifactStore;
  /** Submits one turn and returns the reply text. */
  run(req: RunRequest): Promise<string>;
  /** Runs a mission inline for `/recap`. Absent: the command is unavailable. */
  runMission?: RunMission;
  /**
   * The approval surface, when this build has the machinery wired up.
   *
   * Structural on purpose: the surface routes a tap and a command to it and
   * knows nothing else. Every authorization decision — is this the owner, is
   * this action still pending — is made inside it, against core.
   */
  approvals?: ApprovalHooks;
  /**
   * Re-publish this chat's command menu after `/use`, so the menu names the
   * agent now active. Cosmetic: a failure is logged, never surfaced.
   */
  setChatMenu?: (chatId: string, agent: CatalogAgent) => Promise<void>;
  log?: (line: string) => void;
  /** Typing indicator cadence; Telegram's own lasts ~5s. */
  typingIntervalMs?: number;
  /** Minimum gap between placeholder edits. Default 1.5s (Telegram rate limits). */
  progressIntervalMs?: number;
  /** Clock, injected in tests. */
  now?: () => number;
  /** The owner's timezone, for every date this surface renders. */
  timezone?: string;
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
      out.push(stripInline(cells.join(' — ')));
      continue;
    }

    out.push(stripInline(line.replace(HEADING_RE, '$1')));
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/* ------------------------------------------------------------------ *
 * The progress bubble
 * ------------------------------------------------------------------ */

/**
 * Keeps one placeholder message up to date while a run is in flight.
 *
 * Every edit is cosmetic: failures (too old, identical text, rate limit) are
 * logged and dropped, never surfaced to the run. Edits are serialized on one
 * promise chain so they cannot arrive out of order, and `settle()` waits for
 * that chain before the final answer is written.
 */
export class ProgressBubble {
  readonly #labels: string[] = [];
  #chain: Promise<void> = Promise.resolve();
  #lastEditAt = 0;
  #lastText: string;

  constructor(
    private readonly api: TelegramApi,
    private readonly chatId: string,
    private readonly messageId: number | undefined,
    private readonly log: (line: string) => void,
    private readonly intervalMs: number,
    private readonly now: () => number,
    placeholder: string = PLACEHOLDER_TEXT,
  ) {
    this.#lastText = placeholder;
  }

  /** Synchronous: the runtime's callback must never wait on Telegram. */
  noteToolCall(name: string): void {
    const label = toolLabel(name);
    if (!this.#labels.includes(label)) this.#labels.push(label);
    if (this.messageId === undefined) return;

    const at = this.now();
    if (this.#lastEditAt !== 0 && at - this.#lastEditAt < this.intervalMs) return;
    const text = progressLine(this.#labels);
    if (text === this.#lastText) return;

    this.#lastEditAt = at;
    this.#lastText = text;
    const id = this.messageId;
    this.#chain = this.#chain.then(() =>
      this.api.editMessageText(this.chatId, id, text).catch((err) => {
        this.log(`telegram: progress edit failed: ${message(err)}`);
      }),
    );
  }

  /** Wait for in-flight edits, so the final answer is the last write. */
  settle(): Promise<void> {
    return this.#chain;
  }
}

/* ------------------------------------------------------------------ *
 * Conversation mapping (core.surface_conversations)
 * ------------------------------------------------------------------ */

/*
 * A conversation belongs to a (chat, agent) pair, not to a chat: switching with
 * `/use` resumes that agent's own thread, and `/new` resets only the agent the
 * chat is talking to right now. Two agents never share a history.
 */

export async function getConversationForChat(
  pool: Queryable,
  chatId: string,
  agentId: string,
): Promise<string | undefined> {
  const { rows } = await pool.query(
    `select conversation_id from core.surface_conversations
      where surface = $1 and external_chat_id = $2 and agent_id = $3`,
    [SURFACE, chatId, agentId],
  );
  return rows[0]?.conversation_id ? String(rows[0].conversation_id) : undefined;
}

export async function setConversationForChat(
  pool: Queryable,
  chatId: string,
  agentId: string,
  conversationId: string,
): Promise<void> {
  await pool.query(
    `insert into core.surface_conversations (surface, external_chat_id, agent_id, conversation_id)
     values ($1, $2, $3, $4)
     on conflict (surface, external_chat_id, agent_id) do update
       set conversation_id = excluded.conversation_id, created_at = now()`,
    [SURFACE, chatId, agentId, conversationId],
  );
}

/** The chat's conversation with this agent, created on first contact. */
export async function ensureConversationForChat(
  pool: Queryable,
  chatId: string,
  agentId: string,
): Promise<string> {
  const existing = await getConversationForChat(pool, chatId, agentId);
  if (existing) return existing;
  const id = await createConversation(pool, agentId);
  await setConversationForChat(pool, chatId, agentId, id);
  return id;
}

/** Drop the mapping so the next message to this agent starts fresh. */
export async function startNewConversationForChat(
  pool: Queryable,
  chatId: string,
  agentId: string,
): Promise<string> {
  const id = await createConversation(pool, agentId);
  await setConversationForChat(pool, chatId, agentId, id);
  return id;
}

/**
 * `• ledger — Finance Advisor (active)`, one line per agent.
 *
 * The handle carries no `@`: Telegram turns `@ledger` in bot text into a link
 * to a *Telegram user* that does not exist, and tapping it errors. The `@`
 * spelling survives only where it is an instruction the owner should type.
 */
export function agentsText(
  agents: readonly { id: string; handle: string; name: string }[],
  activeId: string,
): string {
  if (agents.length === 0) return 'No agents are installed.';
  const lines = agents.map(
    (a) => `• ${a.handle} — ${a.name}${a.id === activeId ? ' (active)' : ''}`,
  );
  return [
    'Agents:',
    ...lines,
    '',
    'Tap one to switch. You can also send /use <handle>, or start a message with @handle to ask that one just this once.',
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * Switching agent by button
 * ------------------------------------------------------------------ */

/**
 * The prefix every "switch to this agent" callback carries.
 *
 * Approvals own `apr:`; this surface owns `use:`. The two never overlap, and
 * `callbackKind` is the only thing that decides which handler sees a tap.
 */
export const USE_CALLBACK_PREFIX = 'use';

/** Agent ids are catalog directory names: letters, digits, `-`, `_` and `.`. */
const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,48}$/;

/** `use:<agentId>`, refused rather than truncated if it cannot fit. */
export function agentCallbackData(agentId: string): string {
  const data = `${USE_CALLBACK_PREFIX}:${agentId}`;
  if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_DATA_BYTES) {
    throw new Error(`agent callback data is too long for Telegram: ${data.length} bytes`);
  }
  return data;
}

/** The agent id in a `use:` callback, or nothing. Strict: a tap binds an id. */
export function parseAgentCallback(data: string | undefined): string | undefined {
  const raw = (data ?? '').trim();
  if (!raw.startsWith(`${USE_CALLBACK_PREFIX}:`)) return undefined;
  const id = raw.slice(USE_CALLBACK_PREFIX.length + 1);
  return AGENT_ID_RE.test(id) ? id : undefined;
}

/**
 * Which handler owns a callback payload. One small dispatcher keyed by prefix,
 * so approvals keep owning `apr:` and nothing else has to know about them.
 */
export type CallbackKind = 'agent' | 'approval';

export function callbackKind(data: string | undefined): CallbackKind {
  return (data ?? '').trim().startsWith(`${USE_CALLBACK_PREFIX}:`) ? 'agent' : 'approval';
}

/**
 * One button per agent, one per row: `Switch to Ledger`, and `✓ Ledger
 * (active)` for the one this chat is already talking to. The active button
 * stays tappable — a no-op that says so — because a keyboard that changes
 * shape under a thumb is worse than one that answers.
 */
export function agentsKeyboard(
  agents: readonly { id: string; handle: string; name: string }[],
  activeId: string,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: agents.map((a) => {
      const label = handleLabel(a.handle) || a.name;
      return [
        {
          text: a.id === activeId ? `✓ ${label} (active)` : `Switch to ${label}`,
          callback_data: agentCallbackData(a.id),
        },
      ];
    }),
  };
}

/** What a tap on the agent this chat is already talking to answers. */
export function alreadyActiveText(agentLabel: string): string {
  return `Already talking to ${agentLabel}.`;
}

/** What a successful switch answers on the button. */
export function switchedText(agentLabel: string): string {
  return `Now talking to ${agentLabel}.`;
}

async function appendSurfaceEvent(
  pool: Queryable,
  kind: string,
  payload: unknown,
): Promise<void> {
  await pool.query(
    `insert into core.events (kind, conversation_id, payload)
     values ($1, null, $2::jsonb)`,
    [kind, JSON.stringify(payload ?? null)],
  );
}

/* ------------------------------------------------------------------ *
 * The surface
 * ------------------------------------------------------------------ */

export class TelegramSurface {
  readonly #opts: TelegramSurfaceOptions;
  readonly #log: (line: string) => void;
  /** One promise chain per chat: runs never interleave within a chat. */
  readonly #queues = new Map<string, Promise<void>>();
  /** Pairing attempt timestamps per user id, for the hourly limit. */
  readonly #pairingAttempts = new Map<string, number[]>();
  /** When each identity's `last_seen_at` was last written. */
  readonly #lastTouch = new Map<string, number>();
  #offset: number | undefined;
  #running = false;
  #abort: AbortController | undefined;

  constructor(opts: TelegramSurfaceOptions) {
    this.#opts = opts;
    this.#log = opts.log ?? ((line) => console.error(line));
  }

  /** The next update id to ask Telegram for. */
  get offset(): number | undefined {
    return this.#offset;
  }

  set offset(value: number | undefined) {
    this.#offset = value;
  }

  /** Poll until `stop()`. Each batch is persisted before the offset advances. */
  async start(): Promise<void> {
    this.#running = true;
    while (this.#running) {
      this.#abort = new AbortController();
      let updates: TelegramUpdate[];
      try {
        updates = await this.#opts.api.getUpdates(this.#offset, this.#abort.signal);
      } catch (err) {
        if (!this.#running) break;
        this.#log(`telegram: poll failed: ${message(err)}`);
        await sleep(3000);
        continue;
      }
      if (!this.#running) break;
      await this.processUpdates(updates);
    }
    await this.drain();
  }

  /** Stop polling; the in-flight long poll is aborted. */
  stop(): void {
    this.#running = false;
    this.#abort?.abort();
  }

  /** Wait for every queued run to finish (graceful shutdown). */
  async drain(): Promise<void> {
    await Promise.all([...this.#queues.values()]);
  }

  /**
   * Persist, then advance, then dispatch — in that order, per update.
   * A crash after persistence loses the message; a crash before it replays it.
   * That is the offline contract's trade, made explicit.
   */
  async processUpdates(updates: TelegramUpdate[]): Promise<void> {
    for (const update of updates) {
      const updateId = String(update.update_id);
      const fresh = await recordSurfaceUpdate(this.#opts.pool, SURFACE, updateId);
      await setSurfaceCursor(this.#opts.pool, SURFACE, String(update.update_id + 1));
      this.#offset = update.update_id + 1;
      if (!fresh) {
        this.#log(`telegram: update ${updateId} already processed, skipping`);
        continue;
      }
      await this.dispatch(update);
    }
  }

  /** Authenticate and enqueue. Returns once the work is *queued*, not done. */
  async dispatch(update: TelegramUpdate): Promise<void> {
    const message = update.message ?? update.edited_message;
    if (!message) {
      const callback = update.callback_query;
      if (!callback) return;
      // Every tap is serialized on the chat's own chain, so a callback cannot
      // interleave with a run in that chat. Which handler sees it is decided by
      // the callback prefix alone: `use:` here, everything else to approvals.
      const callbackChat = callback.message?.chat?.id;
      const chain = callbackChat === undefined ? `cb:${callback.id}` : String(callbackChat);
      if (callbackKind(callback.data) === 'agent') {
        this.enqueue(chain, () => this.handleAgentCallback(callback));
        return;
      }
      const approvals = this.#opts.approvals;
      if (!approvals) {
        this.#log('telegram: callback_query ignored (no approval machinery wired)');
        return;
      }
      // Authorization belongs to the approval handler, which re-establishes the
      // owner identity from core.
      this.enqueue(chain, () => approvals.handleCallback(callback));
      return;
    }

    const fromId = message.from?.id;
    const chatId = String(message.chat?.id ?? '');
    if (fromId === undefined || chatId === '') return;
    const userId = String(fromId);

    if (message.chat.type !== 'private') {
      await this.#reject(update, userId, chatId, 'non-private-chat');
      return;
    }
    if (message.from?.is_bot === true) {
      await this.#reject(update, userId, chatId, 'bot-sender');
      return;
    }

    const resolution = await resolveOwnerForSurface(this.#opts.pool, {
      surface: SURFACE,
      externalUserId: userId,
      externalChatId: chatId,
    });
    if (!resolution.ok) {
      // The one exception to silence: an unpaired user presenting a code. A
      // `chat-mismatch` is never offered this path — that user id is already
      // paired somewhere else, and a code would not be the honest fix.
      const code =
        resolution.reason === 'unpaired' ? parseStartCode(message.text ?? '') : undefined;
      if (code !== undefined) {
        const label = senderLabel(message.from);
        this.enqueue(chatId, () =>
          this.handlePairing(update, userId, chatId, code, label),
        );
        return;
      }
      await this.#reject(update, userId, chatId, resolution.reason);
      return;
    }

    // "This device spoke." Written after the message is accepted, throttled,
    // and never allowed to cost the owner an answer. The name Telegram reports
    // rides along: it fills in a device that paired without one (the startup
    // allowlist pairs by id alone) and never overwrites a stored label.
    await this.#touch(userId, senderLabel(message.from));

    // A file takes the same authorized path a sentence does — it is queued on
    // this chat's chain, so a document and the message after it cannot race.
    const incoming = extractAttachment(message);
    if (incoming) {
      const messageId = String(message.message_id);
      this.enqueue(chatId, () =>
        this.handleAttachment(chatId, resolution.ownerId, messageId, incoming),
      );
      return;
    }

    const text = (message.text ?? '').trim();
    if (text === '') {
      this.enqueue(chatId, async () => {
        await this.#opts.api.sendMessage(chatId, 'I can only read text and files for now.');
      });
      return;
    }

    this.enqueue(chatId, () => this.handleText(chatId, userId, text));
  }

  /** Never replies. An unknown sender learns nothing from silence. */
  async #reject(
    update: TelegramUpdate,
    userId: string,
    chatId: string,
    reason: string,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    this.#log(
      `telegram: rejected update ${update.update_id} (${reason}) from user ${userId} in chat ${chatId}`,
    );
    await appendSurfaceEvent(this.#opts.pool, 'surface.rejected', {
      surface: SURFACE,
      reason,
      updateId: String(update.update_id),
      externalUserId: userId,
      externalChatId: chatId,
      ...(detail ?? {}),
    });
  }

  #now(): number {
    return (this.#opts.now ?? (() => Date.now()))();
  }

  /** Five attempts per user id per hour, counted in memory. */
  #allowPairingAttempt(userId: string): boolean {
    const at = this.#now();
    const recent = (this.#pairingAttempts.get(userId) ?? []).filter(
      (t) => at - t < PAIRING_WINDOW_MS,
    );
    if (recent.length >= PAIRING_MAX_ATTEMPTS) {
      this.#pairingAttempts.set(userId, recent);
      return false;
    }
    recent.push(at);
    this.#pairingAttempts.set(userId, recent);
    return true;
  }

  /**
   * `/start <code>` from an unpaired user. Success is the only outcome that
   * says anything at all; every failure is logged and answered with silence.
   */
  async handlePairing(
    update: TelegramUpdate,
    userId: string,
    chatId: string,
    code: string,
    label: string | null,
  ): Promise<void> {
    if (!this.#allowPairingAttempt(userId)) {
      await this.#reject(update, userId, chatId, 'pairing-rate-limited');
      return;
    }

    const result = await consumePairingCode(this.#opts.pool, {
      surface: SURFACE,
      code,
      externalUserId: userId,
      externalChatId: chatId,
      label,
    });
    if (!result.ok) {
      // One event reason for every bad code, with the detail in the payload:
      // the *sender* is told nothing either way.
      await this.#reject(update, userId, chatId, 'bad-pairing-code', {
        pairing: result.reason,
      });
      return;
    }

    this.#log(`telegram: paired user ${userId} in chat ${chatId} by code`);
    this.#lastTouch.set(userId, this.#now());
    const ownerName =
      (await getOwnerDisplayName(this.#opts.pool).catch(() => undefined)) ??
      OWNER_FALLBACK_NAME;
    await this.#opts.api.sendMessage(chatId, pairedText(ownerName));

    // The menu is scoped per chat and this chat had none: publish it now, or
    // the freshly paired device sees a bot with no commands.
    if (this.#opts.setChatMenu) {
      try {
        const agent = await this.activeAgent(chatId);
        await this.#opts.setChatMenu(chatId, agent);
      } catch (err) {
        this.#log(`telegram: menu for newly paired chat ${chatId} failed: ${message(err)}`);
      }
    }
  }

  /** `last_seen_at`, at most once per identity per `TOUCH_INTERVAL_MS`. */
  async #touch(userId: string, label: string | null): Promise<void> {
    const at = this.#now();
    const last = this.#lastTouch.get(userId);
    if (last !== undefined && at - last < TOUCH_INTERVAL_MS) return;
    this.#lastTouch.set(userId, at);
    try {
      await touchSurfaceIdentity(this.#opts.pool, SURFACE, userId, { label });
    } catch (err) {
      this.#log(`telegram: last-seen for user ${userId} failed: ${message(err)}`);
    }
  }

  /** Serialize per chat. */
  enqueue(chatId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.#queues.get(chatId) ?? Promise.resolve();
    const next = previous.then(work).catch((err) => {
      this.#log(`telegram: chat ${chatId} failed: ${message(err)}`);
    });
    this.#queues.set(chatId, next);
    return next;
  }

  /**
   * The agent this chat is talking to. A stored id the catalog no longer knows
   * (an agent file was removed) degrades to the default rather than failing the
   * message — the owner's question still gets answered.
   */
  async activeAgent(chatId: string): Promise<CatalogAgent> {
    const stored = await getActiveAgent(this.#opts.pool, SURFACE, chatId);
    if (stored === null) return this.#opts.catalog.defaultAgent();
    try {
      return this.#opts.catalog.resolve(stored);
    } catch (err) {
      if (!isUnknownAgentError(err)) throw err;
      this.#log(`telegram: chat ${chatId} pinned unknown agent ${stored}, using the default`);
      return this.#opts.catalog.defaultAgent();
    }
  }

  /** The finance advisor, for the finance-only commands; default if absent. */
  #financeAgent(): CatalogAgent {
    return this.#opts.catalog.get(FINANCE_ADVISOR_ID) ?? this.#opts.catalog.defaultAgent();
  }

  /** One accepted owner message: an address, then commands, then a run. */
  async handleText(chatId: string, userId: string, raw: string): Promise<void> {
    // Telegram's own mention is a routing prefix, never part of the question.
    const text = stripBotMention(raw, this.#opts.botUsername).trim();

    // `@ledger can I afford it?` — this one message goes to that agent, in that
    // agent's own conversation, and the chat keeps the agent it was talking to.
    const mention = parseMention(text);
    if (mention) {
      const addressed = this.#opts.catalog.byHandle(mention.handle);
      if (!addressed) {
        await this.#opts.api.sendMessage(chatId, unknownHandleText(mention.handle));
        return;
      }
      if (mention.rest === '') {
        await this.#opts.api.sendMessage(chatId, emptyMentionText(addressed.handle));
        return;
      }
      await this.#runFor(chatId, addressed, mention.rest);
      return;
    }

    const command = text.startsWith('/') ? (text.split(/\s+/)[0] as string).toLowerCase() : '';

    if (command === '/id') {
      await this.#opts.api.sendMessage(
        chatId,
        `Your Telegram user id: ${userId}\nThis chat id: ${chatId}`,
      );
      return;
    }
    if (command === '/start' || command === '/help') {
      await this.#opts.api.sendMessage(chatId, HELP);
      return;
    }
    if (command === '/agents') {
      const active = await this.activeAgent(chatId);
      const agents = this.#opts.catalog.list();
      await this.#opts.api.sendMessage(chatId, agentsText(agents, active.id), {
        replyMarkup: agentsKeyboard(agents, active.id),
      });
      return;
    }
    if (command === '/use') {
      await this.handleUse(chatId, text);
      return;
    }
    if (command === '/whoami') {
      const active = await this.activeAgent(chatId);
      await this.#opts.api.sendMessage(
        chatId,
        `You are talking to ${active.name}. Send /agents to switch.`,
      );
      return;
    }
    if (command === '/new') {
      const active = await this.activeAgent(chatId);
      await startNewConversationForChat(this.#opts.pool, chatId, active.id);
      await this.#opts.api.sendMessage(
        chatId,
        `New conversation started with ${active.name}.`,
      );
      return;
    }
    if (command === '/recap') {
      await this.handleRecap(chatId);
      return;
    }
    if (command === '/approvals') {
      const approvals = this.#opts.approvals;
      await this.#opts.api.sendMessage(
        chatId,
        approvals ? await approvals.pending() : APPROVALS_UNAVAILABLE_TEXT,
      );
      return;
    }
    if (command === '/devices') {
      const devices = await listSurfaceIdentitiesDetailed(this.#opts.pool);
      await this.#opts.api.sendMessage(
        chatId,
        devicesText(devices, this.#opts.timezone ?? DEFAULT_TIMEZONE),
      );
      return;
    }
    if (command === '/files') {
      const rows = await listChatAttachments(this.#opts.pool, SURFACE, chatId, FILES_LIMIT);
      await this.#opts.api.sendMessage(
        chatId,
        filesText(rows, this.#opts.timezone ?? DEFAULT_TIMEZONE),
      );
      return;
    }

    // `/status` is a finance feature: it is answered by the finance advisor
    // whoever the chat is talking to, in that advisor's own conversation, and
    // the active agent is left exactly as it was.
    const active = await this.activeAgent(chatId);
    const status = command === '/status';
    const agent = status ? this.#financeAgent() : active;
    const prompt = status ? 'Status' : text;
    const note =
      status && agent.id !== active.id
        ? `(${agent.name} answered this one; you are still talking to ${active.name}.)`
        : undefined;

    await this.#runFor(chatId, agent, prompt, { note, carry: !status });
  }

  /**
   * One turn with one agent: its own conversation for this chat, the progress
   * bubble named after its handle, and the active agent left exactly as it was.
   */
  async #runFor(
    chatId: string,
    agent: CatalogAgent,
    prompt: string,
    opts: { note?: string | undefined; carry?: boolean } = {},
  ): Promise<void> {
    const conversationId = await ensureConversationForChat(this.#opts.pool, chatId, agent.id);

    // "import this statement" three minutes after a PDF means that PDF. The
    // carry is deliberately narrow — a recent file, a sentence that points at
    // one — and a command never carries anything.
    const carried =
      opts.carry === false ? undefined : await this.#carriedAttachment(chatId, prompt);
    const label = handleLabel(agent.handle);

    await this.#withBubble(
      chatId,
      async (progress) => {
        const reply = await this.#opts.run({
          conversationId,
          chatId,
          agent,
          text: carried ? `${prompt}\n\n${carried.note}` : prompt,
          ...(carried?.attachments.length ? { attachments: carried.attachments } : {}),
          onToolCall: (name) => progress.noteToolCall(name),
        });
        return opts.note ? `${opts.note}\n\n${reply}` : reply;
      },
      label,
      carried ? readingText(label) : undefined,
    );
  }

  /**
   * The file a follow-up sentence is about, if there is one.
   *
   * Two conditions, both required: the chat received a file within the last
   * thirty minutes, and this sentence points at a file at all. Neither is
   * certain — but the cost of a wrong carry is one extra attachment on a run
   * the owner was having anyway, and the cost of missing it is re-uploading a
   * bank statement.
   */
  async #carriedAttachment(
    chatId: string,
    text: string,
  ): Promise<{ attachments: RunAttachment[]; note: string } | undefined> {
    if (!this.#opts.artifacts) return undefined;
    if (!referencesAttachment(text)) return undefined;

    const last = await getLastAttachment(this.#opts.pool, SURFACE, chatId);
    if (!last || last.mime === undefined) return undefined;
    const age = (this.#opts.now ?? (() => Date.now()))() - last.createdAt.getTime();
    if (!Number.isFinite(age) || age < 0 || age > ATTACHMENT_RECENCY_MS) return undefined;

    return this.#attachmentTurn({
      artifactId: last.artifactId,
      mime: last.mime,
      kind: last.kind ?? 'other',
      filename: last.filename ?? null,
      sizeBytes: last.sizeBytes ?? 0,
    });
  }

  /**
   * How one artifact reaches a run: as a viewable block when the model can
   * actually look at it, and always as a note naming its id.
   */
  #attachmentTurn(a: {
    artifactId: string;
    mime: string;
    kind: string;
    filename: string | null;
    sizeBytes: number;
  }): { attachments: RunAttachment[]; note: string } {
    const viewable = isViewable(a.kind as 'image' | 'document' | 'audio' | 'other', a.mime);
    return {
      attachments: viewable
        ? [{ artifactId: a.artifactId, mime: a.mime, kind: a.kind }]
        : [],
      note: attachmentNote({
        artifactId: a.artifactId,
        filename: a.filename,
        mime: a.mime,
        sizeBytes: a.sizeBytes,
        viewable,
      }),
    };
  }

  /**
   * One file from the owner: fetch it, store it, then either answer the caption
   * that came with it or ask what it is for.
   *
   * Nothing about a file is trusted before it is weighed: Telegram's claimed
   * size, `getFile`'s size and the downloaded length are each checked against
   * the same ceiling, because only the last one is a fact.
   */
  async handleAttachment(
    chatId: string,
    ownerId: string,
    messageId: string,
    incoming: IncomingAttachment,
  ): Promise<void> {
    const api = this.#opts.api;
    const store = this.#opts.artifacts;
    if (!store) {
      await api.sendMessage(chatId, FILES_UNAVAILABLE_TEXT);
      return;
    }

    const tooBig = async (bytes: number): Promise<void> => {
      this.#log(`telegram: chat ${chatId} sent ${incoming.filename} at ${formatBytes(bytes)}, over the limit`);
      await api.sendMessage(chatId, oversizeText(incoming.filename, bytes));
    };

    if (incoming.sizeBytes !== undefined && incoming.sizeBytes > MAX_ATTACHMENT_BYTES) {
      await tooBig(incoming.sizeBytes);
      return;
    }

    let row: ArtifactRow;
    try {
      const file = await api.getFile(incoming.fileId);
      const claimed = file.file_size ?? incoming.sizeBytes;
      if (claimed !== undefined && claimed > MAX_ATTACHMENT_BYTES) {
        await tooBig(claimed);
        return;
      }
      if (!file.file_path) throw new Error('getFile returned no file_path');

      const bytes = await api.downloadFile(file.file_path);
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        await tooBig(bytes.length);
        return;
      }

      row = await store.save({
        bytes,
        mime: incoming.mime,
        filename: incoming.filename,
        source: { surface: SURFACE, chatId, messageId },
        ...(incoming.caption ? { caption: incoming.caption } : {}),
        createdBy: ownerId,
      });
    } catch (err) {
      this.#log(`telegram: attachment from chat ${chatId} failed: ${message(err)}`);
      await appendSurfaceEvent(this.#opts.pool, 'surface.error', {
        surface: SURFACE,
        externalChatId: chatId,
        message: message(err),
      });
      await api.sendMessage(chatId, FILE_FAILED_TEXT).catch(() => {});
      return;
    }

    const filename = row.filename ?? incoming.filename;
    await recordChatAttachment(this.#opts.pool, SURFACE, chatId, {
      artifactId: row.id,
      messageId,
      filename,
      kind: row.kind,
      mime: row.mime,
      sizeBytes: row.sizeBytes,
    });

    // Voice notes are kept, not heard: no run is started over bytes no model
    // in this build can read, with or without a caption.
    if (row.kind === 'audio') {
      await api.sendMessage(chatId, gotAudioText(filename, row.sizeBytes));
      return;
    }

    const caption = incoming.caption;
    if (!caption) {
      await api.sendMessage(chatId, gotFileText(filename, row.kind, row.sizeBytes));
      return;
    }

    const agent = await this.activeAgent(chatId);
    const conversationId = await ensureConversationForChat(this.#opts.pool, chatId, agent.id);
    const turn = this.#attachmentTurn({
      artifactId: row.id,
      mime: row.mime,
      kind: row.kind,
      filename,
      sizeBytes: row.sizeBytes,
    });

    await this.#withBubble(
      chatId,
      (progress) =>
        this.#opts.run({
          conversationId,
          chatId,
          agent,
          text: `${caption}\n\n${turn.note}`,
          ...(turn.attachments.length ? { attachments: turn.attachments } : {}),
          onToolCall: (name) => progress.noteToolCall(name),
        }),
      handleLabel(agent.handle),
      readingText(handleLabel(agent.handle)),
    );
  }

  /** `/use <handle|id>` — switch this chat to another agent, or explain why not. */
  async handleUse(chatId: string, text: string): Promise<void> {
    // `@ledger`, `ledger` and `finance-advisor` all name the same agent; the
    // catalog decides, and the leading `@` is only how the owner types a handle.
    const requested = text.split(/\s+/).slice(1).join(' ').trim();
    if (requested === '') {
      await this.#opts.api.sendMessage(chatId, USE_WITHOUT_ID_TEXT);
      return;
    }

    let agent: CatalogAgent;
    try {
      agent = this.#opts.catalog.resolve(requested);
    } catch (err) {
      if (!isUnknownAgentError(err)) throw err;
      await this.#opts.api.sendMessage(chatId, UNKNOWN_AGENT_TEXT);
      return;
    }

    await setActiveAgent(this.#opts.pool, SURFACE, chatId, agent.id);
    // The menu names the active agent, so it is re-published for this chat.
    await this.#republishMenu(chatId, agent);
    await this.#opts.api.sendMessage(chatId, `You are now talking to ${agent.name}.`);
  }

  /**
   * A tap on an agent button under `/agents`.
   *
   * Same rule as an approval callback: the sender is re-authenticated against
   * core on every tap — a button is not trusted because it sits in a chat that
   * was once paired — and a stranger is answered with a bare, empty callback
   * answer and recorded as `surface.rejected`.
   */
  async handleAgentCallback(query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const api = this.#opts.api;
    const pool = this.#opts.pool;
    const userId = query.from?.id === undefined ? '' : String(query.from.id);
    const chatId = query.message?.chat?.id === undefined ? '' : String(query.message.chat.id);
    const messageId = query.message?.message_id;

    const agentId = parseAgentCallback(query.data);
    if (agentId === undefined || userId === '' || chatId === '') {
      await api.answerCallbackQuery(query.id).catch(() => {});
      return;
    }

    const resolution = await resolveOwnerForSurface(pool, {
      surface: SURFACE,
      externalUserId: userId,
      externalChatId: chatId,
    });
    if (!resolution.ok) {
      this.#log(
        `telegram: agent callback rejected (${resolution.reason}) from user ${userId} in chat ${chatId}`,
      );
      await appendSurfaceEvent(pool, 'surface.rejected', {
        surface: SURFACE,
        kind: 'callback',
        reason: resolution.reason,
        externalUserId: userId,
        externalChatId: chatId,
        callbackId: query.id,
        agentId,
      });
      await api.answerCallbackQuery(query.id).catch(() => {});
      return;
    }

    // The callback carries an *id*, so the lookup is exact: a handle never
    // resolves here, and an agent that has since been removed is said plainly.
    const agent = this.#opts.catalog.get(agentId);
    if (!agent) {
      await api.answerCallbackQuery(query.id, UNKNOWN_AGENT_TEXT).catch(() => {});
      return;
    }

    const label = handleLabel(agent.handle) || agent.name;
    const active = await this.activeAgent(chatId);
    if (active.id === agent.id) {
      // Tappable, but nothing moves: no write, no edit, no menu churn.
      await api.answerCallbackQuery(query.id, alreadyActiveText(label)).catch(() => {});
      return;
    }

    await setActiveAgent(pool, SURFACE, chatId, agent.id);

    // The list the owner is looking at now names a different active agent, so
    // the message it sits under is refreshed. Cosmetic: a failed edit is logged.
    if (messageId !== undefined) {
      const agents = this.#opts.catalog.list();
      try {
        await api.editMessageText(chatId, messageId, agentsText(agents, agent.id), {
          replyMarkup: agentsKeyboard(agents, agent.id),
        });
      } catch (err) {
        this.#log(`telegram: refreshing the agent list failed: ${message(err)}`);
      }
    }

    await api.answerCallbackQuery(query.id, switchedText(label)).catch(() => {});
    await this.#republishMenu(chatId, agent);
  }

  /** The chat menu names the active agent. Cosmetic: a failure is logged. */
  async #republishMenu(chatId: string, agent: CatalogAgent): Promise<void> {
    if (!this.#opts.setChatMenu) return;
    await this.#opts.setChatMenu(chatId, agent).catch((err) => {
      this.#log(`telegram: menu refresh for chat ${chatId} failed: ${message(err)}`);
    });
  }

  /**
   * `/recap` — the weekly mission, run now, through the same executor the
   * scheduler uses. The answer lands in this chat's progress bubble.
   */
  async handleRecap(chatId: string): Promise<void> {
    const runMission = this.#opts.runMission;
    if (!runMission) {
      await this.#opts.api.sendMessage(chatId, RECAP_UNAVAILABLE_TEXT);
      return;
    }
    await this.#withBubble(
      chatId,
      async (progress) => {
        const outcome = await runMission(RECAP_MISSION_ID, chatId, (name) =>
          progress.noteToolCall(name),
        );
        return outcome.ok ? outcome.text : RECAP_NOT_REGISTERED_TEXT;
      },
      handleLabel(this.#financeAgent().handle),
    );
  }

  /**
   * The one shared shape of a long operation: typing indicator, a placeholder
   * posted before the provider is called, a progress line kept alive while it
   * runs, and the same bubble becoming the answer.
   */
  async #withBubble(
    chatId: string,
    produce: (progress: ProgressBubble) => Promise<string>,
    agentName?: string,
    placeholderOverride?: string,
  ): Promise<void> {
    const stopTyping = this.#startTyping(chatId);
    const placeholder = placeholderOverride ?? placeholderText(agentName);
    // An explicit bubble, posted before the provider is called: the owner sees
    // that the question landed, and the same bubble becomes the answer.
    const placeholderId = await this.#opts.api
      .sendMessage(chatId, placeholder)
      .catch((err) => {
        this.#log(`telegram: placeholder failed: ${message(err)}`);
        return undefined;
      });

    const progress = new ProgressBubble(
      this.#opts.api,
      chatId,
      placeholderId,
      this.#log,
      this.#opts.progressIntervalMs ?? PROGRESS_EDIT_INTERVAL_MS,
      this.#opts.now ?? (() => Date.now()),
      placeholder,
    );

    try {
      // Everything an agent or a mission writes passes the plain-text net: we
      // never send `parse_mode`, so stray markdown would be shown literally.
      const reply = toPlainText(await produce(progress));
      await progress.settle();
      await this.#finish(chatId, placeholderId, reply);
    } catch (err) {
      this.#log(`telegram: run failed: ${message(err)}`);
      await appendSurfaceEvent(this.#opts.pool, 'surface.error', {
        surface: SURFACE,
        externalChatId: chatId,
        message: message(err),
      });
      await progress.settle();
      await this.#replace(chatId, placeholderId, `Something went wrong: ${message(err)}`).catch(
        () => {},
      );
    } finally {
      stopTyping();
    }
  }

  /**
   * Land the answer in the placeholder when it fits — one bubble, no flicker —
   * and otherwise drop the placeholder and send the chunks.
   */
  async #finish(
    chatId: string,
    placeholderId: number | undefined,
    reply: string,
  ): Promise<void> {
    const text = reply.trim() === '' ? '(no reply)' : reply;
    if (placeholderId !== undefined && text.length > MAX_MESSAGE_CHARS) {
      await this.#opts.api.deleteMessage(chatId, placeholderId).catch((err) => {
        this.#log(`telegram: placeholder delete failed: ${message(err)}`);
      });
      await this.#opts.api.sendMessage(chatId, text);
      return;
    }
    await this.#replace(chatId, placeholderId, text);
  }

  /** Edit the placeholder, falling back to a new message on any edit failure. */
  async #replace(
    chatId: string,
    placeholderId: number | undefined,
    text: string,
  ): Promise<void> {
    if (placeholderId !== undefined) {
      try {
        await this.#opts.api.editMessageText(chatId, placeholderId, text);
        return;
      } catch (err) {
        this.#log(`telegram: final edit failed, sending instead: ${message(err)}`);
      }
    }
    await this.#opts.api.sendMessage(chatId, text);
  }

  #startTyping(chatId: string): () => void {
    const send = (): void => {
      this.#opts.api.sendChatAction(chatId).catch(() => {});
    };
    send();
    const timer = setInterval(send, this.#opts.typingIntervalMs ?? 5000);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
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
