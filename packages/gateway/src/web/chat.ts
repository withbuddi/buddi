/**
 * The browser as a surface.
 *
 * Until now the dashboard read the event log; it could approve an action and
 * pause the installation, but it could not *talk*. This module is the other
 * half: send a message to any agent, watch the tool calls land, attach a file,
 * decide an approval that stopped a run — the same four things Telegram and the
 * terminal do, through the same core.
 *
 * What is deliberately **not** here:
 *
 *  - No second run path. `runAgent` is called with the same options the
 *    Telegram surface builds, and a gated tool stops the run exactly as it does
 *    anywhere else: the action is created, the owner is asked, and approving
 *    goes through `executeApproved` on the existing `/api/approvals` routes.
 *    There is no web-shaped approval and no web-shaped executor.
 *  - No delivery policy. These are interactive turns with a person watching, so
 *    the notify policy — which decides whether an *unattended* run is allowed
 *    to speak — has nothing to say about them.
 *  - No transport of its own. Progress reaches the page by the events the run
 *    already writes; see `stream.ts`.
 *
 * The one thing this module owns that the others do not have to think about is
 * **serialization**. A browser can fire two messages at a conversation faster
 * than a run can finish, so runs are chained per conversation exactly the way
 * `TelegramSurface.enqueue` chains them per chat: the second message waits, it
 * does not interleave.
 */
import { randomUUID } from 'node:crypto';
import {
  WEB_SURFACE,
  getAction,
  getArtifact,
  listOpenOffers,
  ToolRegistry,
  type AgentCatalog,
  type ArtifactRow,
  type CatalogAgent,
  type ToolContext,
} from '@buddi/core';
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  createConversation,
  runAgent,
  type AttachmentRef,
  type RunAgentOptions,
  type RuntimeProvider,
} from '@buddi/runtime';
import type { Pool } from 'pg';
import { FIRST_RUN_SUFFIX, shouldStartFirstRun } from '../agents/first-run.js';
import { listRecentConversations } from '../chat/conversations.js';
import {
  OFFER_POLICY_SUFFIX,
  OFFER_TOOLS,
  createOfferManifest,
  storeTurnOffers,
  withdrawTurnOffers,
  type OfferSink,
} from '../surfaces/offered-actions.js';
import { failedTurnReply } from '../surfaces/failure.js';
import { conversationForTurn } from '../surfaces/conversation-lifetime.js';
import {
  attachmentNote,
  classifyMime,
  isViewable,
  type ArtifactStore,
} from '../telegram/attachments.js';

/** The surface id every web run is attributed to in the event log. */
export const WEB_CHAT_SURFACE = WEB_SURFACE.id;

/** Conversations the picker shows per agent. */
export const CHAT_CONVERSATIONS_LIMIT = 20;

/** The longest message the composer may send. Generous; a bound all the same. */
export const MAX_CHAT_MESSAGE_CHARS = 16_000;

/** Said when this build has no provider wired — a fact, not an error. */
export const CHAT_UNAVAILABLE =
  'chat is not wired up in this process, so the dashboard can read but not talk';

/** Said when the artifact store is absent. */
export const ATTACHMENTS_UNAVAILABLE =
  'the artifact store is not wired up in this process, so files cannot be attached here';

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

export interface ChatAgentView {
  id: string;
  handle: string;
  name: string;
  description: string;
  available: boolean;
  unavailableReason?: string;
  roles: string[];
  provider: string;
  model: string;
}

/**
 * Every agent the composer may address, with why one of them cannot answer.
 *
 * An unavailable agent is *listed*, not hidden: "@scout needs OPENAI_API_KEY"
 * is something the owner can fix, and an agent that silently vanished from a
 * picker is something they cannot.
 */
export function readChatAgents(catalog: AgentCatalog): {
  agents: ChatAgentView[];
  defaultAgentId: string;
} {
  const agents = catalog.list().map((summary): ChatAgentView => {
    const full = catalog.get(summary.id);
    return {
      id: summary.id,
      handle: summary.handle,
      name: summary.name,
      description: summary.description,
      available: summary.available,
      ...(summary.unavailableReason === undefined
        ? {}
        : { unavailableReason: summary.unavailableReason }),
      roles: [...summary.roles],
      provider: summary.providerKind,
      model: full?.provider.model ?? full?.model ?? '',
    };
  });
  return { agents, defaultAgentId: catalog.defaultAgent().id };
}

export interface ChatConversationView {
  id: string;
  startedAt: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  preview: string;
}

/**
 * One agent's recent conversations, newest first.
 *
 * `listRecentConversations` is the terminal's `/resume` picker, reused
 * unchanged: the question "which of my conversations with this agent do I
 * mean" is the same question at a prompt and in a sidebar, and answering it
 * twice would be two places for the preview to be computed differently.
 */
export async function readChatConversations(
  pool: Pool,
  agentId: string,
  limit = CHAT_CONVERSATIONS_LIMIT,
): Promise<ChatConversationView[]> {
  const lines = await listRecentConversations(pool, agentId, limit);
  return lines.map((line) => ({
    id: line.id,
    startedAt: line.createdAt?.toISOString() ?? null,
    lastMessageAt: line.lastMessageAt?.toISOString() ?? null,
    messageCount: line.messages,
    preview: line.preview,
  }));
}

/* ------------------------------------------------------------------ *
 * The transcript
 * ------------------------------------------------------------------ */

export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; name: string; ok: boolean; output: unknown; error?: string }
  | { type: 'attachment'; artifactId: string; filename: string | null; mime: string; kind: string }
  | { type: 'unknown'; raw: unknown };

export interface ChatMessageView {
  id: string;
  role: string;
  at: string;
  blocks: ChatBlock[];
}

export interface ChatRunView {
  runId: string | null;
  surface: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  turns: number | null;
  stopped: string | null;
  usage: { input: number; output: number };
  actionId: string | null;
  resumed: boolean;
}

/**
 * One action the last turn offered, as the page draws it.
 *
 * The same `core.offers` row Telegram binds to a button and the Offers page
 * lists. The prompt rides along because the owner should be able to read what
 * a chip will ask before they click it.
 */
export interface ChatOfferView {
  id: string;
  label: string;
  prompt: string;
  expiresAt: string;
}

export interface ChatTranscript {
  conversationId: string;
  agentId: string;
  startedAt: string;
  messages: ChatMessageView[];
  runs: ChatRunView[];
  usage: { input: number; output: number };
  /**
   * What is still on the table in this conversation — usually nothing. Read
   * with the transcript rather than pushed on the stream, so a reloaded page
   * and a live one show the same chips, and a withdrawn offer simply stops
   * being returned.
   */
  offers: ChatOfferView[];
}

/**
 * The whole conversation, in the shape the page draws.
 *
 * Two joins happen here rather than in the browser, because both need the
 * database and neither is the page's business:
 *
 *  - a `tool_result` carries only the `tool_use_id` it answers, so the **name**
 *    of the tool is joined on from the call it belongs to. A page should never
 *    have to walk backwards through a transcript to label a result.
 *  - an `artifact_ref` carries an id, so the **filename** is joined on from
 *    `core.artifacts` — one query for the whole transcript, not one per block.
 */
export async function readChatTranscript(
  pool: Pool,
  conversationId: string,
  now: Date = new Date(),
): Promise<ChatTranscript | null> {
  const { rows: head } = await pool.query(
    `select id, agent_id, created_at from core.conversations where id = $1::uuid`,
    [conversationId],
  );
  const conversation = head[0];
  if (!conversation) return null;

  const { rows: messages } = await pool.query(
    `select id, role, content, created_at from core.messages
      where conversation_id = $1::uuid
      order by created_at asc, id asc`,
    [conversationId],
  );

  const parsed = messages.map((m) => ({
    id: String(m.id),
    role: String(m.role),
    at: new Date(m.created_at).toISOString(),
    raw: rawBlocks(m.content),
  }));

  // The name of every tool call in this conversation, by its id.
  const toolNames = new Map<string, string>();
  const artifactIds = new Set<string>();
  for (const message of parsed) {
    for (const block of message.raw) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        toolNames.set(block.id, String(block.name ?? ''));
      }
      if (block.type === 'artifact_ref' && typeof block.artifactId === 'string') {
        artifactIds.add(block.artifactId);
      }
    }
  }
  const artifacts = await artifactsById(pool, [...artifactIds]);

  // Untaken, unexpired, this conversation's. A chip the owner clicks goes
  // through the same claim-once take the Telegram tap does.
  const open = await listOpenOffers(pool, { now, conversationId, limit: 10 }).catch(() => []);

  return {
    offers: open.map((offer) => ({
      id: offer.id,
      label: offer.label,
      prompt: offer.prompt,
      expiresAt: offer.expiresAt,
    })),
    conversationId: String(conversation.id),
    agentId: String(conversation.agent_id),
    startedAt: new Date(conversation.created_at).toISOString(),
    messages: parsed.map((m) => ({
      id: m.id,
      role: m.role,
      at: m.at,
      blocks: m.raw.map((block) => toChatBlock(block, toolNames, artifacts)),
    })),
    ...(await runsOf(pool, conversationId)),
  };
}

function rawBlocks(content: unknown): Array<Record<string, any>> {
  const value = typeof content === 'string' ? safeParse(content) : content;
  if (!Array.isArray(value)) return [];
  return value.map((b) => (b ?? {}) as Record<string, any>);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

function toChatBlock(
  block: Record<string, any>,
  toolNames: Map<string, string>,
  artifacts: Map<string, ArtifactRow>,
): ChatBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: String(block.text ?? '') };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: String(block.id ?? ''),
        name: String(block.name ?? ''),
        input: block.input ?? null,
      };
    case 'tool_result': {
      const toolUseId = String(block.tool_use_id ?? '');
      const ok = block.is_error !== true;
      const content = block.content;
      const output = typeof content === 'string' ? maybeJson(content) : (content ?? null);
      return {
        type: 'tool_result',
        toolUseId,
        name: toolNames.get(toolUseId) ?? '',
        ok,
        output,
        ...(ok ? {} : { error: typeof content === 'string' ? content : JSON.stringify(content ?? null) }),
      };
    }
    case 'artifact_ref': {
      const artifactId = String(block.artifactId ?? '');
      const row = artifacts.get(artifactId);
      return {
        type: 'attachment',
        artifactId,
        filename: row?.filename ?? null,
        mime: row?.mime ?? String(block.mime ?? 'application/octet-stream'),
        kind: row?.kind ?? String(block.kind ?? 'other'),
      };
    }
    default:
      return { type: 'unknown', raw: block };
  }
}

/**
 * A tool result is stored as a string because that is what the provider wire
 * wants. Handing the page that string would make it re-parse JSON it did not
 * produce, so it is parsed here — and left as text when it is not JSON, which
 * is what a refusal or the awaiting-approval sentence is.
 */
function maybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const first = trimmed[0];
  if (first !== '{' && first !== '[' && first !== '"') return text;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

async function artifactsById(pool: Pool, ids: readonly string[]): Promise<Map<string, ArtifactRow>> {
  const out = new Map<string, ArtifactRow>();
  if (ids.length === 0) return out;
  const { rows } = await pool.query(
    `select id, kind, mime, filename, size_bytes, sha256, storage_path, caption, created_at
       from core.artifacts where id = any($1::uuid[])`,
    [ids],
  );
  for (const row of rows) {
    out.set(String(row.id), {
      id: String(row.id),
      kind: row.kind,
      mime: row.mime,
      filename: row.filename ?? null,
      sizeBytes: Number(row.size_bytes),
      sha256: row.sha256,
      storagePath: row.storage_path,
      caption: row.caption ?? null,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    });
  }
  return out;
}

/** The runs this conversation has had, paired up from the event log. */
async function runsOf(
  pool: Pool,
  conversationId: string,
): Promise<{ runs: ChatRunView[]; usage: { input: number; output: number } }> {
  const { rows } = await pool.query(
    `select kind, payload, created_at from core.events
      where conversation_id = $1::uuid
        and kind in ('run.started', 'run.resumed', 'run.finished', 'chat.run.failed')
      order by id asc`,
    [conversationId],
  );

  const runs: ChatRunView[] = [];
  for (const event of rows) {
    const p = (event.payload ?? {}) as Record<string, any>;
    if (event.kind === 'run.started' || event.kind === 'run.resumed') {
      runs.push({
        runId: typeof p.runId === 'string' ? p.runId : null,
        surface: typeof p.surface === 'string' ? p.surface : null,
        startedAt: new Date(event.created_at).toISOString(),
        finishedAt: null,
        turns: null,
        stopped: null,
        usage: { input: 0, output: 0 },
        actionId: typeof p.actionId === 'string' ? p.actionId : null,
        resumed: event.kind === 'run.resumed',
      });
      continue;
    }
    const open = runs.find((r) => r.finishedAt === null);
    const finished = {
      finishedAt: new Date(event.created_at).toISOString(),
      turns: typeof p.turns === 'number' ? p.turns : null,
      stopped: typeof p.stopped === 'string' ? p.stopped : null,
      usage: { input: Number(p.usage?.input ?? 0), output: Number(p.usage?.output ?? 0) },
    };
    if (open) {
      Object.assign(open, finished, {
        actionId: typeof p.actionId === 'string' ? p.actionId : open.actionId,
      });
    } else {
      runs.push({
        runId: typeof p.runId === 'string' ? p.runId : null,
        surface: typeof p.surface === 'string' ? p.surface : null,
        startedAt: null,
        resumed: false,
        actionId: typeof p.actionId === 'string' ? p.actionId : null,
        ...finished,
      });
    }
  }

  const usage = runs.reduce(
    (acc, run) => ({ input: acc.input + run.usage.input, output: acc.output + run.usage.output }),
    { input: 0, output: 0 },
  );
  return { runs, usage };
}

/* ------------------------------------------------------------------ *
 * Sending
 * ------------------------------------------------------------------ */

export interface WebChatDeps {
  pool: Pool;
  catalog: AgentCatalog;
  registry: ToolRegistry;
  ctx: ToolContext;
  now: () => Date;
  timezone: string;
  /** The adapter for one agent — its own pinned provider, never the process's. */
  providerFor(agent: CatalogAgent): RuntimeProvider;
  artifacts?: ArtifactStore | undefined;
  memoryPreamble?: ((agentId: string) => Promise<string>) | undefined;
  /** Refuse the turn with this sentence — the global pause, in practice. */
  gate?: (() => Promise<string | null>) | undefined;
  log?: ((line: string) => void) | undefined;
}

export interface SendRequest {
  agentId: string;
  conversationId?: string | undefined;
  text: string;
  attachmentIds?: string[] | undefined;
}

export type SendResult =
  | {
      ok: true;
      conversationId: string;
      runId: string;
      /**
       * Set when the conversation the page asked for had ended and this message
       * opened a new one. The page follows `conversationId` — it already does,
       * because a first message returns an id the page did not have — and shows
       * `note` so the fresh, empty thread is explained rather than surprising.
       */
      boundary?: { note: string; previousConversationId: string };
    }
  | { ok: false; status: number; error: string };

/**
 * The web surface's run queue.
 *
 * One promise chain per conversation, one cancel handle per conversation, and
 * nothing else: everything durable about a run is in the database before this
 * object hears about it, so losing this object (a restart) loses a spinner and
 * never a turn.
 */
export class WebChat {
  readonly #deps: WebChatDeps;
  readonly #queues = new Map<string, Promise<void>>();
  readonly #running = new Map<string, { runId: string; cancel: () => void }>();
  readonly #log: (line: string) => void;

  constructor(deps: WebChatDeps) {
    this.#deps = deps;
    this.#log = deps.log ?? ((line) => console.error(line));
  }

  /** A fresh conversation with this agent. */
  async newConversation(agentId: string): Promise<{ ok: true; conversationId: string } | { ok: false; status: number; error: string }> {
    const agent = this.#resolve(agentId);
    if (!agent) return { ok: false, status: 404, error: `no such agent: ${agentId}` };
    return { ok: true, conversationId: await createConversation(this.#deps.pool, agent.id) };
  }

  /**
   * Accept one message and return once it is *queued*, not once it is answered.
   *
   * Everything that can be refused is refused here, synchronously, so the page
   * gets a status it can act on: an unknown agent, a conversation belonging to
   * someone else, an empty message, an attachment that does not exist. What
   * cannot be known yet — whether the provider answers — belongs to the run,
   * and reaches the page on the stream.
   */
  async send(request: SendRequest): Promise<SendResult> {
    const agent = this.#resolve(request.agentId);
    if (!agent) return { ok: false, status: 404, error: `no such agent: ${request.agentId}` };

    const text = request.text.trim();
    if (text === '') return { ok: false, status: 400, error: '`text` must not be empty' };
    if (text.length > MAX_CHAT_MESSAGE_CHARS) {
      return { ok: false, status: 413, error: `a message may be at most ${MAX_CHAT_MESSAGE_CHARS} characters` };
    }

    const attachmentIds = request.attachmentIds ?? [];
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      return {
        ok: false,
        status: 400,
        error: `at most ${MAX_ATTACHMENTS_PER_MESSAGE} files may ride with one message`,
      };
    }

    let conversationId = request.conversationId;
    /** Set when the thread the page was in had ended and this message starts one. */
    let boundary: { note: string; previousConversationId: string } | undefined;
    if (conversationId === undefined) {
      conversationId = await createConversation(this.#deps.pool, agent.id);
    } else {
      const owner = await conversationAgent(this.#deps.pool, conversationId);
      if (owner === null) {
        return { ok: false, status: 404, error: 'no such conversation' };
      }
      if (owner !== agent.id) {
        // Two agents never share a history — the same rule the terminal and
        // Telegram keep. Silently re-pointing the conversation would put one
        // agent's words in another agent's mouth.
        return {
          ok: false,
          status: 409,
          error: `that conversation belongs to ${owner}, not to ${agent.id}`,
        };
      }
      /*
       * The page opens on this agent's most recent conversation, which is the
       * right thing to draw at rest and the wrong thing to *continue* when the
       * most recent one is yesterday's. The rule is the one Telegram and the
       * terminal use — three hours idle, or a transcript past the budget — and
       * here it costs the page nothing: `send` already returns the id to use,
       * and the page already follows it.
       */
      const decided = await conversationForTurn(this.#deps.pool, {
        current: conversationId,
        start: () => createConversation(this.#deps.pool, agent.id),
        now: this.#deps.now(),
        log: this.#log,
      });
      conversationId = decided.conversationId;
      if (decided.boundary) {
        boundary = {
          note: decided.boundary.note,
          previousConversationId: decided.boundary.previousConversationId,
        };
        await this.#event(conversationId, 'chat.conversation.started', {
          reason: decided.boundary.reason,
          previousConversationId: decided.boundary.previousConversationId,
          agentId: agent.id,
        });
      }
    }

    const files: ArtifactRow[] = [];
    for (const id of attachmentIds) {
      const row = await getArtifact(this.#deps.pool, id).catch(() => null);
      if (!row) return { ok: false, status: 404, error: `no such attachment: ${id}` };
      files.push(row);
    }

    const runId = randomUUID();
    const target = conversationId;
    this.#enqueue(target, () => this.#run({ agent, conversationId: target, runId, text, files }));
    return { ok: true, conversationId: target, runId, ...(boundary ? { boundary } : {}) };
  }

  /**
   * Abandon the run in flight for this conversation.
   *
   * Best effort, and honest about what that means: the provider call cannot be
   * un-sent, and whatever the run has already written stays in the transcript.
   * What stops is the *waiting* — and the stream is told, so the page stops
   * spinning instead of hanging on a run nobody is watching.
   */
  cancel(conversationId: string): boolean {
    const running = this.#running.get(conversationId);
    if (!running) return false;
    running.cancel();
    return true;
  }

  /** Wait for every queued run to finish. Used by tests and by shutdown. */
  async drain(): Promise<void> {
    await Promise.all([...this.#queues.values()]);
  }

  /** Serialize per conversation, exactly as Telegram serializes per chat. */
  #enqueue(conversationId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.#queues.get(conversationId) ?? Promise.resolve();
    const next = previous.then(work).catch((err) => {
      this.#log(`web chat: conversation ${conversationId} failed: ${message(err)}`);
    });
    this.#queues.set(conversationId, next);
    return next;
  }

  #resolve(agentId: string): CatalogAgent | undefined {
    const wanted = agentId.trim();
    if (wanted === '') return undefined;
    return this.#deps.catalog.get(wanted) ?? this.#deps.catalog.byHandle(wanted.replace(/^@/, ''));
  }

  /** One turn: the user message, the run, and whatever stopped it. */
  async #run(turn: {
    agent: CatalogAgent;
    conversationId: string;
    runId: string;
    text: string;
    files: ArtifactRow[];
  }): Promise<void> {
    const deps = this.#deps;
    const { agent, conversationId, runId } = turn;
    let toolsCalled = 0;

    const blocked = deps.gate ? await deps.gate() : null;
    if (blocked !== null) {
      await this.#failed(conversationId, runId, 'refused', blocked);
      return;
    }

    // A brand-new installation's first words are the interview, whoever is
    // asking. The claim is atomic in core, so the terminal and this page racing
    // the same minute interview once — and the loser simply runs the turn.
    let systemSuffix: string | undefined;
    try {
      if (await shouldStartFirstRun(deps.pool, WEB_CHAT_SURFACE)) systemSuffix = FIRST_RUN_SUFFIX;
    } catch (err) {
      this.#log(`web chat: onboarding state unavailable: ${message(err)}`);
    }

    // Files ride with exactly one message, the way a Telegram caption rides
    // with the document it arrived on. The note is always written — even for an
    // image the model can see — because the artifact id is how the agent reaches
    // the bytes again through the artifacts tools.
    const notes = turn.files.map((row) =>
      attachmentNote({
        artifactId: row.id,
        filename: row.filename,
        mime: row.mime,
        sizeBytes: row.sizeBytes,
        viewable: isViewable(classifyMime(row.mime), row.mime),
      }),
    );
    const attachments: AttachmentRef[] = turn.files
      .filter((row) => isViewable(classifyMime(row.mime), row.mime))
      .map((row) => ({ artifactId: row.id, mime: row.mime, kind: row.kind }));

    const userMessage = notes.length === 0 ? turn.text : `${turn.text}\n\n${notes.join('\n')}`;

    // "The owner said something, and it is in the transcript." Written before
    // the provider is called, so a page that connected mid-flight still sees
    // its own message appear.
    await this.#event(conversationId, 'chat.message.appended', { role: 'user', runId });

    let provider: RuntimeProvider;
    try {
      provider = deps.providerFor(agent);
    } catch (err) {
      // An agent whose credential is missing is a fact about the installation.
      // It is permanent by construction, so nothing is offered: the sentence
      // names the variable and what to do about it, and the log gets the rest.
      await this.#failedTurn({ err, agent, conversationId, runId, toolsCalled: 0 });
      return;
    }

    // `conversation.offer` is registered per run into a copy of the base
    // registry, the way the mission tools and `conversation.ask` are: nothing
    // outside an interactive turn can call it, and two conversations never
    // share a sink. The dashboard has buttons, so what it declares is drawn as
    // chips — by the profile, not by the surface's name.
    const offers: OfferSink = {};
    const registry = new ToolRegistry();
    for (const manifest of deps.registry.manifests()) registry.register(manifest);
    registry.register(createOfferManifest(offers));

    // An offer belongs to the turn that made it; this turn retires the last
    // one's, so a chip cannot still fire after the conversation moved on.
    await withdrawTurnOffers(deps.pool, conversationId, deps.now(), this.#log);

    const base = agent.definition(deps.now(), deps.timezone);
    const options: RunAgentOptions = {
      agent: { ...base, tools: [...base.tools, ...OFFER_TOOLS] },
      provider,
      registry,
      ctx: deps.ctx,
      pool: deps.pool,
      conversationId,
      surface: WEB_SURFACE,
      runId,
      userMessage,
      systemSuffix:
        systemSuffix === undefined
          ? OFFER_POLICY_SUFFIX
          : `${OFFER_POLICY_SUFFIX}\n\n${systemSuffix}`,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(deps.memoryPreamble ? { memoryPreamble: deps.memoryPreamble } : {}),
      ...(deps.artifacts ? { loadArtifact: (id: string) => deps.artifacts!.load(id) } : {}),
      // Awaited: the runtime waits for this row before it writes anything
      // else, so "the assistant appended a message" is always ordered before
      // the `run.finished` of the turn that wrote it. Fired and forgotten, the
      // two inserts race on separate pool connections and the page can be told
      // the run is over before — or instead of — being told what it said.
      onText: async () => {
        await this.#event(conversationId, 'chat.message.appended', { role: 'assistant', runId });
      },
      // Counted only so a failed turn knows whether offering to run it again
      // would be honest — work that already happened cannot be un-happened.
      onToolCall: () => {
        toolsCalled += 1;
      },
    };

    let cancelled = false;
    let failure: unknown;
    const result = await this.#cancellable(
      conversationId,
      runId,
      async () => runAgent(options),
      () => {
        cancelled = true;
      },
      (err) => {
        failure = err;
      },
    );

    if (cancelled) {
      await this.#failed(
        conversationId,
        runId,
        'cancelled',
        'the turn was already sent, so whatever it wrote stays in the transcript',
      );
      return;
    }
    if (result === undefined) {
      // The run threw. What the owner reads, the cause chain that goes to the
      // log, and the retry chip when one is honest — all decided in one place,
      // the same one Telegram and the terminal use.
      await this.#failedTurn({
        err: failure,
        agent,
        conversationId,
        runId,
        prompt: turn.text,
        toolsCalled,
      });
      return;
    }

    // Stored before the page is told the run is over, so the refresh that
    // `run.finished` triggers already returns them.
    await storeTurnOffers(deps.pool, {
      sink: offers,
      agentId: agent.id,
      conversationId,
      now: deps.now(),
      log: this.#log,
    });

    if (result.stopped === 'awaiting-approval' && result.pendingActionId) {
      // The run proposed a gated effect and stopped. Nothing is decided here:
      // the action exists, the page is told which one, and the decision goes
      // through the approval routes that already existed.
      const action = await getAction(deps.pool, result.pendingActionId).catch(() => null);
      await this.#event(conversationId, 'chat.awaiting-approval', {
        runId,
        actionId: result.pendingActionId,
        tool: action?.tool ?? null,
      });
    }
  }

  /**
   * Race the run against a cancel.
   *
   * Identical in shape to the terminal's `#cancellable`, and for the same
   * reason: the provider call cannot be un-sent, so cancelling means this
   * surface stops waiting. The abandoned promise is caught so a run nobody is
   * watching cannot become an unhandled rejection.
   */
  async #cancellable<T>(
    conversationId: string,
    runId: string,
    work: () => Promise<T>,
    onCancel: () => void,
    onError: (err: unknown) => void,
  ): Promise<T | undefined> {
    let resolveCancel!: () => void;
    const cancelled = new Promise<undefined>((resolve) => {
      resolveCancel = (): void => {
        onCancel();
        resolve(undefined);
      };
    });
    this.#running.set(conversationId, { runId, cancel: resolveCancel });
    const started = work();
    try {
      return await Promise.race([started, cancelled]);
    } catch (err) {
      onError(err);
      return undefined;
    } finally {
      this.#running.delete(conversationId);
      void started.catch(() => {});
    }
  }

  /**
   * A run that threw, was cancelled or was refused never reaches the runtime's
   * own `run.finished`. It still has to *end* — a page waiting for the run to
   * close would otherwise spin forever — so it ends here, with the honest
   * `stopped` and the sentence that explains it.
   */
  async #failed(
    conversationId: string,
    runId: string,
    stopped: 'failed' | 'cancelled' | 'refused',
    error: string,
    owner?: { message: string; failureClass: string },
  ): Promise<void> {
    if (stopped === 'failed') this.#log(`web chat: run ${runId} failed: ${error}`);
    await this.#event(conversationId, 'chat.run.failed', {
      runId,
      surface: WEB_CHAT_SURFACE,
      turns: 0,
      stopped,
      usage: { input: 0, output: 0 },
      // `error` is the whole cause chain and belongs to the record; `message`
      // is what the page puts in front of a person. They are never the same
      // string, and the page is never handed the first one.
      error,
      ...(owner ? { message: owner.message, failureClass: owner.failureClass } : {}),
    });
  }

  /**
   * A turn that threw, rendered once: the cause chain to the log, sentences to
   * the page, and the retry stored as an ordinary offer so the chip the page
   * already draws for offers is the chip it draws for this.
   */
  async #failedTurn(input: {
    err: unknown;
    agent: CatalogAgent;
    conversationId: string;
    runId: string;
    prompt?: string;
    toolsCalled: number;
  }): Promise<void> {
    const outcome = await failedTurnReply(this.#deps.pool, {
      error: input.err,
      profile: WEB_SURFACE,
      agentId: input.agent.id,
      agentName: `@${input.agent.handle}`,
      conversationId: input.conversationId,
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      toolsCalled: input.toolsCalled,
      now: this.#deps.now(),
      log: (line: string) => this.#log(`web chat: ${line}`),
    });
    await this.#failed(input.conversationId, input.runId, 'failed', outcome.detail, {
      message: outcome.rendered.text,
      failureClass: outcome.failureClass,
    });
  }

  /** Append to the event log. Never allowed to fail a turn. */
  async #event(conversationId: string, kind: string, payload: unknown): Promise<void> {
    try {
      await this.#deps.pool.query(
        `insert into core.events (kind, conversation_id, payload) values ($1, $2::uuid, $3::jsonb)`,
        [kind, conversationId, JSON.stringify(payload ?? null)],
      );
    } catch (err) {
      this.#log(`web chat: recording ${kind} failed: ${message(err)}`);
    }
  }
}

/** Which agent owns this conversation, or null when there is no such row. */
export async function conversationAgent(pool: Pool, conversationId: string): Promise<string | null> {
  if (!/^[0-9a-fA-F-]{36}$/.test(conversationId)) return null;
  const { rows } = await pool.query(
    `select agent_id from core.conversations where id = $1::uuid`,
    [conversationId],
  );
  return rows[0] ? String(rows[0].agent_id) : null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
