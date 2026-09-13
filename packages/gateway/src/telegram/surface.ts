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
  getActiveAgent,
  recordSurfaceUpdate,
  resolveOwnerForSurface,
  setActiveAgent,
  setSurfaceCursor,
  type Queryable,
} from '@buddi/core';
import { createConversation } from '@buddi/runtime';
import { MAX_MESSAGE_CHARS, type TelegramApi, type TelegramUpdate } from './api.js';
import { isUnknownAgentError, type AgentCatalog, type CatalogAgent } from './types.js';

export const SURFACE = 'telegram';

/** The bubble posted when the agent that is working is not known by name. */
export const PLACEHOLDER_TEXT = '⏳ Working on it…';

/** `⏳ Finance Advisor is working…` — the owner sees *who* they are waiting on. */
export function placeholderText(agentName?: string): string {
  const name = (agentName ?? '').trim();
  return name === '' ? PLACEHOLDER_TEXT : `⏳ ${name} is working…`;
}

/**
 * `/status` and `/recap` are finance features: they are answered by this agent
 * whichever one the chat is currently talking to.
 */
export const FINANCE_ADVISOR_ID = 'finance-advisor';

/** Telegram rate-limits edits; one per this window is plenty for a progress line. */
export const PROGRESS_EDIT_INTERVAL_MS = 1500;

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
  'Just write your question. Commands:',
  '/agents — list the agents you can talk to',
  '/use <id> — switch to an agent',
  '/whoami — which agent is active here',
  '/status — where you stand right now (finance advisor)',
  '/recap — run the weekly recap now (finance advisor)',
  '/new — start a fresh conversation with the active agent',
  '/id — your numeric user id and this chat id',
  '/help — this message',
].join('\n');

/** `/use` with an id the catalog does not know. Never an error to the owner. */
export const UNKNOWN_AGENT_TEXT = 'Unknown agent. Send /agents to see the list.';

/** `/use` with no argument at all. */
export const USE_WITHOUT_ID_TEXT = 'Send /use <id>, for example /use finance-advisor. Send /agents to see the list.';

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

export interface RunRequest {
  conversationId: string;
  chatId: string;
  text: string;
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

export interface TelegramSurfaceOptions {
  api: TelegramApi;
  pool: Queryable;
  /** Every agent this installation can talk to; the surface only reads it. */
  catalog: AgentCatalog;
  /** Submits one turn and returns the reply text. */
  run(req: RunRequest): Promise<string>;
  /** Runs a mission inline for `/recap`. Absent: the command is unavailable. */
  runMission?: RunMission;
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

/** `• finance-advisor — Finance Advisor (active)`, one line per agent. */
export function agentsText(
  agents: readonly { id: string; name: string }[],
  activeId: string,
): string {
  if (agents.length === 0) return 'No agents are installed.';
  const lines = agents.map(
    (a) => `• ${a.id} — ${a.name}${a.id === activeId ? ' (active)' : ''}`,
  );
  return ['Agents:', ...lines, '', 'Send /use <id> to switch.'].join('\n');
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
      if (update.callback_query) {
        // Approvals arrive in roadmap step 3; nothing here resolves an action.
        this.#log(`telegram: callback_query ignored (no approvals yet)`);
      }
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
      await this.#reject(update, userId, chatId, resolution.reason);
      return;
    }

    const text = (message.text ?? '').trim();
    if (text === '') {
      this.enqueue(chatId, async () => {
        await this.#opts.api.sendMessage(chatId, 'I can only read text messages for now.');
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
    });
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

  /** One accepted owner message: commands first, then a run. */
  async handleText(chatId: string, userId: string, text: string): Promise<void> {
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
      await this.#opts.api.sendMessage(
        chatId,
        agentsText(this.#opts.catalog.list(), active.id),
      );
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
        `You are talking to ${active.name} (${active.id}).`,
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

    const conversationId = await ensureConversationForChat(this.#opts.pool, chatId, agent.id);

    await this.#withBubble(
      chatId,
      async (progress) => {
        const reply = await this.#opts.run({
          conversationId,
          chatId,
          agent,
          text: prompt,
          onToolCall: (name) => progress.noteToolCall(name),
        });
        return note ? `${note}\n\n${reply}` : reply;
      },
      agent.name,
    );
  }

  /** `/use <id>` — switch this chat to another agent, or explain why not. */
  async handleUse(chatId: string, text: string): Promise<void> {
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
    if (this.#opts.setChatMenu) {
      await this.#opts.setChatMenu(chatId, agent).catch((err) => {
        this.#log(`telegram: menu refresh for chat ${chatId} failed: ${message(err)}`);
      });
    }
    await this.#opts.api.sendMessage(chatId, `You are now talking to ${agent.name}.`);
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
      this.#financeAgent().name,
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
  ): Promise<void> {
    const stopTyping = this.#startTyping(chatId);
    const placeholder = placeholderText(agentName);
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
      const reply = await produce(progress);
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
