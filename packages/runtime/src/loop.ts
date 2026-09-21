/**
 * The agent loop. Proposes tool calls, consumes results, persists everything.
 *
 * It never executes an effect itself: every tool call goes through
 * `ToolRegistry.invoke`, which is where the trust model lives. A refusal is not
 * an exception — it comes back to the model as an error-flagged tool_result, so
 * the model can see *that* it was refused and why.
 *
 * Fail closed at startup: an agent naming a tool the registry does not have
 * throws before any provider call is made.
 */
import { APPROVAL_RESUME_SPEAKER, SYSTEM_TOOLS, surfaceSection, type AgentDefinition, type SurfaceProfile, type ToolContext, type ToolRegistry } from '@buddi/core';
import type {
  ContentBlock,
  NativeSearchRecord,
  NeutralMessage,
  RuntimeProvider,
  ToolSchema,
  Usage,
  CompletionDelta,
} from './anthropic.js';
import { NATIVE_SEARCH_SYSTEM_NOTE, planNativeSearch } from './search.js';
import { compactObservations } from './projection.js';
import {
  degradeMessages,
  DEFAULT_CAPABILITIES,
  type ProviderCapabilities,
} from './capabilities.js';
import {
  assertAttachmentCount,
  hydrateContent,
  hydrateMessages,
  toArtifactRefBlocks,
  type AttachmentRef,
  type LoadArtifact,
} from './attachments.js';

/**
 * The narrow slice of `pg.Pool` the loop needs. Depending on this instead of
 * `Pool` keeps the loop testable with a two-line in-memory stub.
 */
export interface Queryable {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

export interface RunAgentOptions {
  agent: AgentDefinition;
  provider: RuntimeProvider;
  registry: ToolRegistry;
  ctx: ToolContext;
  pool: Queryable;
  conversationId: string;
  /** The owner's turn. Omitted only when `resume` carries the turn instead. */
  userMessage?: string;
  /**
   * An extra system line appended to the agent's prompt for this run only.
   *
   * Genuinely one-off instructions, and nothing else: "this is the first run,
   * follow the first-run skill". How the surface *renders* is no longer said
   * here — that is `surface` below, a declared profile rather than a sentence
   * each caller writes its own way. Presentation and framing, never policy: it
   * changes no tool, tier or authorization and is not persisted with the agent.
   */
  systemSuffix?: string;
  /**
   * What the agent remembers, rendered as a system-prompt preamble for this run.
   *
   * The runtime holds no memory schema: it asks for a block of text by agent id
   * and prepends it. Whoever wires the run decides where it comes from (the
   * memory plugin, in this build) — and whether there is any memory at all.
   * An empty string means "no block", not an empty heading.
   */
  memoryPreamble?: (agentId: string) => Promise<string>;
  /**
   * Files handed in with this message — a Telegram photo, a dropped statement.
   * Metadata only: the bytes are hydrated for the API call and never persisted
   * into `core.messages`, which stores the reference instead.
   */
  attachments?: AttachmentRef[];
  /**
   * How the runtime gets an attachment's bytes back. Injected because the
   * runtime owns no artifact schema — whoever wires the run points it at the
   * store. Absent means "this run carries no files"; a reference it cannot
   * resolve becomes a visible placeholder, never a silent omission.
   */
  loadArtifact?: LoadArtifact;
  /**
   * "The assistant said something." Awaited, because a surface that answers it
   * by writing to the event log has to have that write *land* before the run
   * moves on — an unawaited write races `run.finished` and can be ordered
   * after it, or lost to a reader tailing the log by id.
   */
  onText?: (text: string) => void | Promise<void>;
  /**
   * The answer as it is being written: a piece of text or of thinking. Never
   * awaited — it is for a page to draw, not for the record, and the record
   * is `onText`.
   */
  onDelta?: (delta: CompletionDelta) => void;
  onToolCall?: (name: string, input: unknown) => void;
  /**
   * A run inside a shared room (docs/groups.md). The history is the room as
   * this agent is allowed to see it — the projection — instead of the raw
   * rows; every turn this run writes carries `speaker`, and the opening
   * message carries `openingSpeaker` (the owner, or the coordinator that
   * asked). Absent for an ordinary conversation, where nothing changes.
   */
  transcript?: {
    load: () => Promise<NeutralMessage[]>;
    speaker: string;
    openingSpeaker: string;
    /**
     * Applied to the history before every call, not once at the start: tool
     * output the run gathers as it goes has to fit the same cap.
     */
    bound?: (messages: NeutralMessage[]) => NeutralMessage[];
  };
  /**
   * Who the opening turn is from, when it is not simply the owner.
   *
   * Written to the turn's `speaker` column and read by nothing in this file:
   * it is provenance for the surfaces, and the one caller is first run, which
   * sends the instruction that makes a new assistant introduce itself and does
   * not want that instruction read back as something the owner said. The
   * model still sees the turn — it is the prompt — and only the transcript
   * readers leave it out.
   */
  openingSpeaker?: string;
  /**
   * Resuming a run that stopped awaiting an approval.
   *
   * The tool_use that asked for it was already answered (with "awaiting owner
   * approval"), so the outcome comes back as this run's opening turn instead —
   * a tool result delivered late, and said in those words. Exactly one of
   * `userMessage` and `resume` carries the turn; both, or neither, is a defect.
   */
  resume?: ApprovalResume;
  /** Called the moment a tool call becomes a pending approval. */
  onApprovalRequired?: (actionId: string, preview: string) => void;
  /**
   * Every web search the *provider* ran for this run, once it has run them.
   *
   * The seam that keeps native search accountable. The runtime cannot write to
   * `web.fetches` — that is a plugin's schema, and the runtime imports no
   * plugin — so it hands over what it saw and the composition root, which does
   * know `@buddi/tool-web`, records it. Awaited: an audit line that loses a
   * race with the end of the run is not an audit line. It never fails a run;
   * the recorder swallows its own errors, exactly as `recordFetch` already does
   * for `web.search`.
   */
  onNativeSearch?: (searches: readonly NativeSearchEvent[]) => void | Promise<void>;
  /**
   * The environment the search-backend decision is read from. Injected by
   * tests so `BUDDI_SEARCH_PROVIDER` can be forced without touching the
   * process; defaults to `process.env`, as everything else does.
   */
  env?: Record<string, string | undefined>;
  /**
   * Which surface this run belongs to, as the profile the surface declares
   * about itself — `TELEGRAM_SURFACE`, `CLI_SURFACE`, `WEB_SURFACE`,
   * `SCHEDULED_SURFACE`, or one a host defines.
   *
   * Two jobs, and they were one thing all along. Its `id` is the provenance
   * stamped on this run's events, so a transcript still says where a turn came
   * from. Its facts become the generated surface paragraph in the system
   * prompt, so the model knows whether markdown survives, whether the owner can
   * tap a button, and whether there is a canvas — before it answers, rather
   * than having the claim stripped out of the answer afterwards.
   *
   * Omitted means "no surface declared": no paragraph, no provenance. That is
   * an eval or an ad-hoc script, not a place a person is reading.
   */
  surface?: SurfaceProfile;
  /**
   * The caller's own id for this run, recorded alongside the surface.
   *
   * The loop does not generate one — a run is identified by its events and its
   * conversation. This exists so a surface that handed an id to a client
   * (a browser following a stream) can find its own run in the log.
   */
  runId?: string;
}

/** One server-side search, stamped with the run that caused it. */
export interface NativeSearchEvent extends NativeSearchRecord {
  agentId: string;
  conversationId: string;
  /** The provider that ran it — which is also where the query text went. */
  provider: string;
}

/** How a decided action comes back into the run that proposed it. */
export interface ApprovalResume {
  actionId: string;
  /** The tool the action ran, so a file it saved on approval is recorded as produced. */
  tool?: string;
  /** The approval's state now: 'succeeded', 'failed', 'rejected', 'unknown'… */
  state: string;
  /** What the effect returned, when it ran. */
  result?: unknown;
  error?: string;
}

export interface RunResult {
  text: string;
  turns: number;
  /**
   * `awaiting-approval` is not an end: the run is suspendable at that point and
   * `pendingActionId` names what it is waiting for. Everything durable has
   * already been written, so no worker and no transaction stays open.
   */
  stopped: 'end_turn' | 'max_turns' | 'max_tokens' | 'awaiting-approval';
  usage: Usage;
  /** Set only when `stopped === 'awaiting-approval'`. */
  pendingActionId?: string;
  /**
   * What this run actually ran on (ARCHITECTURE.md, "Per-run snapshot").
   * Pinned provider, pinned model, credential kind — plus the concrete model
   * the endpoint says it served, which is the one that can differ from the pin.
   */
  snapshot: RunSnapshot;
}

/** The per-run provenance record; written to `core.events` and returned. */
export interface RunSnapshot {
  /** Stable connection identity, never the credential. */
  accountId?: string;
  provider: string;
  credentialKind: string;
  /** The model the agent file / environment pinned. */
  model: string;
  /** What the endpoint reported serving, once it has answered. */
  servedModel?: string;
  capabilities: ProviderCapabilities;
}

/**
 * What the model is told while it waits. It names the action, so the transcript
 * carries the link between the proposal and the decision that follows it.
 */
export function awaitingApprovalText(actionId: string): string {
  return `awaiting owner approval (action ${actionId}); this effect has not happened`;
}

/**
 * The tool result that comes back late, once the owner has decided.
 *
 * Written as a plain user turn because the tool_use it belongs to was already
 * answered before the run suspended: the API requires that, and inventing a
 * second result for the same call would be a lie about what happened.
 */
export function approvalOutcomeText(resume: ApprovalResume): string {
  const head = `tool result (deferred) for action ${resume.actionId}: ${resume.state}`;
  if (resume.state === 'succeeded') {
    return `${head}\nresult: ${JSON.stringify(resume.result ?? null)}`;
  }
  if (resume.state === 'rejected') {
    return `${head}\nThe owner rejected it. Do not propose the same effect again unless asked; say what you will do instead.`;
  }
  if (resume.state === 'unknown') {
    return `${head}\nThe effect was dispatched and never confirmed. Do not retry it: say plainly that it is unresolved.`;
  }
  return `${head}${resume.error ? `\nerror: ${resume.error}` : ''}`;
}

/* ------------------------------------------------------------------ *
 * Persistence helpers (core.conversations / core.messages / core.events)
 * ------------------------------------------------------------------ */

export async function createConversation(
  pool: Queryable,
  agentId: string,
): Promise<string> {
  const { rows } = await pool.query(
    `insert into core.conversations (agent_id) values ($1) returning id`,
    [agentId],
  );
  const id = rows[0]?.id;
  if (id === undefined || id === null) {
    throw new Error('createConversation: insert returned no id');
  }
  return String(id);
}

export async function loadMessages(
  pool: Queryable,
  conversationId: string,
): Promise<NeutralMessage[]> {
  const { rows } = await pool.query(
    `select role, content from core.messages
      where conversation_id = $1
      order by created_at asc, id asc`,
    [conversationId],
  );
  return rows.map((r) => ({
    role: r.role === 'assistant' ? 'assistant' : 'user',
    content: normalizeContent(r.content),
  }));
}

/** The artifact ids a tool output names as files it saved, and nothing else. */
export function producedArtifactIds(output: unknown): string[] {
  if (!output || typeof output !== 'object') return [];
  const isId = (id: unknown): id is string => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const out = output as { artifacts?: unknown; artifactId?: unknown };
  const list = Array.isArray(out.artifacts) ? out.artifacts : [];
  const ids: unknown[] = list.map((item) => (item && typeof item === 'object' ? ((item as { id?: unknown }).id ?? (item as { artifactId?: unknown }).artifactId) : undefined));
  // A tool that saves one file names it as `artifactId` at the top.
  ids.push(out.artifactId);
  return [...new Set(ids.filter(isId))];
}

/** jsonb comes back parsed from `pg`; tolerate a string for other drivers. */
function normalizeContent(raw: unknown): ContentBlock[] {
  const value = typeof raw === 'string' ? safeParse(raw) : raw;
  return Array.isArray(value) ? (value as ContentBlock[]) : [];
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

/** One use of an artifact, written with the message that references it. */
interface ArtifactUse {
  artifactId: string;
  kind: 'uploaded' | 'produced';
  agentId: string | null;
}

async function persistMessage(
  pool: Queryable,
  conversationId: string,
  role: 'user' | 'assistant',
  content: ContentBlock[],
  speaker?: string,
  uses: readonly ArtifactUse[] = [],
): Promise<void> {
  if (uses.length === 0) {
    // The column is written only when a room needs it, so a single-agent
    // conversation's rows keep the shape they always had.
    if (speaker === undefined) {
      await pool.query(
        `insert into core.messages (conversation_id, role, content)
         values ($1, $2, $3::jsonb)`,
        [conversationId, role, JSON.stringify(content)],
      );
      return;
    }
    await pool.query(
      `insert into core.messages (conversation_id, role, content, speaker)
       values ($1, $2, $3::jsonb, $4)`,
      [conversationId, role, JSON.stringify(content), speaker],
    );
    return;
  }
  // The message and the library's record of every file it carries, in one
  // statement: either both land or neither does. An upload already part of
  // another conversation is recorded as reused here, decided in the same
  // statement from the store's row and from the library's own history — an
  // eager upload carries no conversation of its own; its uses do.
  await pool.query(
    `with turn as (
       insert into core.messages (conversation_id, role, content, speaker)
       values ($1, $2, $3::jsonb, $4)
       returning conversation_id
     ), wanted as (
       select (u->>'artifactId')::uuid as artifact_id, u->>'kind' as kind, nullif(u->>'agentId', '') as agent_id
         from jsonb_array_elements($5::jsonb) as u
     )
     insert into core.artifact_uses (artifact_id, conversation_id, kind, agent_id)
     select w.artifact_id, t.conversation_id,
            case when w.kind = 'uploaded' and (
                   (a.conversation_id is not null and a.conversation_id <> t.conversation_id)
                   or exists (select 1 from core.artifact_uses p where p.artifact_id = w.artifact_id and p.conversation_id <> t.conversation_id)
                 ) then 'reused' else w.kind end,
            w.agent_id
       from turn t
       cross join wanted w
       join core.artifacts a on a.id = w.artifact_id
     on conflict (artifact_id, conversation_id, kind, coalesce(agent_id, '')) do nothing`,
    [conversationId, role, JSON.stringify(content), speaker ?? null, JSON.stringify(uses)],
  );
}

async function appendEvent(
  pool: Queryable,
  kind: string,
  payload: unknown,
  conversationId: string,
): Promise<void> {
  await pool.query(
    `insert into core.events (kind, conversation_id, payload)
     values ($1, $2, $3::jsonb)`,
    [kind, conversationId, JSON.stringify(payload ?? null)],
  );
}

/* ------------------------------------------------------------------ *
 * Tool selection — fail closed before the first API call
 * ------------------------------------------------------------------ */

export function selectTools(registry: ToolRegistry, agent: AgentDefinition): ToolSchema[] {
  const specs = new Map(registry.list().map((s) => [s.name, s]));
  const selected: ToolSchema[] = [];
  for (const name of new Set([...agent.tools, ...SYSTEM_TOOLS.filter(name => specs.has(name))])) {
    const spec = specs.get(name);
    if (!spec) {
      throw new Error(
        `agent '${agent.id}' requires tool '${name}', which is not registered`,
      );
    }
    selected.push({
      name: spec.name,
      description: spec.description,
      input_schema: spec.inputSchema,
    });
  }
  return selected;
}

/**
 * What goes into `core.messages`, which is not quite what went over the wire.
 *
 * `provider_native` blocks are dropped. Two reasons, and both matter. They are
 * one vendor's private shapes, and a conversation can be continued by an agent
 * on another provider tomorrow — posting Anthropic's `server_tool_use` to
 * OpenAI is a 400 waiting to happen. And they carry untrusted search results:
 * page extracts strangers wrote, which would otherwise be replayed into every
 * future turn of this conversation for ever. The model's answer keeps the
 * citations; the raw results do not need to outlive the turn that used them.
 */
export function persistable(content: readonly ContentBlock[]): ContentBlock[] {
  return content.filter((b) => b.type !== 'provider_native');
}

function textOf(content: ContentBlock[]): string {
  return content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

/**
 * One thing the model said, and whether it said it on its way to a tool call.
 */
export interface SpokenBlock {
  readonly text: string;
  /** The same turn also called a tool: the model kept working after this. */
  readonly beforeToolCall: boolean;
}

/**
 * The longest a line may be and still be read as "let me check that".
 *
 * Deliberately small. The cost of the two mistakes is not symmetric: a preamble
 * that survives reads as a slightly chatty answer, while a draft that does not
 * is information the owner never sees. Anything a model writes *for* the owner —
 * a drafted reply, a summary, a list — is longer than this or contains a line
 * break, and both of those keep it.
 */
const PREAMBLE_MAX_CHARS = 120;

/**
 * Is this the "thinking out loud before a tool call" line, rather than an
 * answer? Three conditions, all required, all checkable:
 *
 *   1. the same turn called a tool, so this was not the model's last word;
 *   2. it is a single line — no paragraph, no list, no draft;
 *   3. it is at most `PREAMBLE_MAX_CHARS` long.
 *
 * The surfaces already say that work is happening: the terminal spinner and
 * Telegram's progress note name each tool as it is called. A twelfth restating
 * of "let me look that up" adds nothing they do not already show.
 */
export function isPreamble(block: SpokenBlock): boolean {
  if (!block.beforeToolCall) return false;
  const text = block.text.trim();
  if (text === '' || text.includes('\n')) return false;
  return text.length <= PREAMBLE_MAX_CHARS;
}

/**
 * A run's answer: everything the model said to the owner in that run, in order.
 *
 * Blocks are joined with a blank line. Two blocks either side of a tool call
 * are usually continuous prose, and a blank line between them reads as a
 * paragraph break rather than as a seam — where joining them tightly would run
 * a draft's last sentence into the next one.
 *
 * Preambles are dropped, *unless* dropping them would leave the run mute: a run
 * whose only words were "let me check that" still says that, because a silent
 * answer is worse than a redundant one.
 */
export function joinSpoken(blocks: readonly SpokenBlock[]): string {
  const said = blocks.filter((b) => b.text.trim() !== '');
  const kept = said.filter((b) => !isPreamble(b));
  const use = kept.length > 0 ? kept : said;
  return use
    .map((b) => b.text.trim())
    .join('\n\n')
    .trim();
}

/**
 * The system prompt for one run, in one fixed order:
 *
 *   memory → the agent's own prompt (persona + generated tail)
 *          → the generated surface paragraph → the one-off suffix
 *
 * Memory goes first and the persona second on purpose — the persona's rules are
 * the last word the model reads before the generated sections, so a remembered
 * line can never read as an override of them. The surface paragraph follows the
 * persona because it is authoritative over it: a persona that likes tables does
 * not get tables on Telegram. The one-off suffix is last because it is the only
 * part that is about *this* turn.
 *
 * The order is fixed rather than caller-chosen so that two surfaces composing
 * the same agent produce the same prompt shape, and a diff of two transcripts
 * is a diff of the facts and not of the assembly.
 */
export function composeSystem(
  systemPrompt: string,
  systemSuffix?: string,
  memoryPreamble?: string,
  surface?: SurfaceProfile,
  /**
   * The generated web-search paragraph, when the provider is doing the
   * searching. It sits with the surface section rather than with the suffix
   * because it is the same kind of thing: a platform fact about this run that
   * the persona does not get to override.
   */
  webSearchNote?: string,
): string {
  const memory = (memoryPreamble ?? '').trim();
  const parts = [
    systemPrompt,
    ...(surface ? [surfaceSection(surface)] : []),
    ...((webSearchNote ?? '').trim() === '' ? [] : [(webSearchNote as string).trim()]),
    ...((systemSuffix ?? '').trim() === '' ? [] : [(systemSuffix as string).trim()]),
  ];
  const body = parts.join('\n\n');
  return memory === '' ? body : `${memory}\n\n${body}`;
}

/* ------------------------------------------------------------------ *
 * The loop
 * ------------------------------------------------------------------ */

export async function runAgent(opts: RunAgentOptions): Promise<RunResult> {
  const { agent, provider, registry, ctx, pool, conversationId, userMessage } = opts;
  ctx.signal?.throwIfAborted();
  const resume = opts.resume;

  // A turn comes from the owner or from a decided approval — never from both,
  // and never from neither.
  if ((userMessage === undefined) === (resume === undefined)) {
    throw new Error('runAgent: pass exactly one of userMessage and resume');
  }
  const openingText = resume ? approvalOutcomeText(resume) : (userMessage as string);

  // Fail closed: unknown tool names are a configuration defect, not a runtime
  // refusal — and they are caught before a single token is sent anywhere.
  const granted = selectTools(registry, agent);

  /*
   * What this provider can carry, asked *before* a request is built rather than
   * discovered as a 400 with the owner's file already in the body. An adapter
   * that does not declare a matrix is treated as the native wire.
   */
  const capabilities = provider.capabilities ?? DEFAULT_CAPABILITIES;

  /*
   * Who searches for this agent, decided once, before the first request.
   *
   * The owner's grant is provider-agnostic on purpose: `tools: [web.*]` says
   * "this agent may use the web", and nothing in an agent file names a backend.
   * What that grant *resolves to* is not: on a provider that searches
   * server-side the model is shown `web.read` and `web.status` and no
   * `web.search`, because handing it two ways to do one thing is how a model
   * ends up doing it twice — once natively, once through Tavily, two bills and
   * two sets of results to reconcile. On every other provider the grant
   * resolves exactly as it did before this existed.
   */
  const search = planNativeSearch({
    capabilities,
    grantedTools: granted.map((t) => t.name),
    ...(opts.env ? { env: opts.env } : {}),
  });
  const tools = search.enabled
    ? granted.filter((t) => !search.withheld.includes(t.name))
    : granted;
  const allowedTools = new Set(tools.map((tool) => tool.name));

  const snapshot: RunSnapshot = {
    ...(agent.provider.accountId ? { accountId: agent.provider.accountId } : {}),
    provider: agent.provider.kind,
    credentialKind: agent.provider.credential.kind,
    model: agent.provider.model,
    capabilities,
  };
  const memory = opts.memoryPreamble ? await opts.memoryPreamble(agent.id) : '';
  const platformContext = await ctx.systemContext?.();
  const system = composeSystem(
    agent.systemPrompt,
    [opts.systemSuffix, platformContext?.prompt].filter(Boolean).join('\n\n'),
    memory,
    opts.surface,
    search.enabled ? NATIVE_SEARCH_SYSTEM_NOTE : undefined,
  );

  // Provenance for every tool call this run makes. The caller's context is not
  // mutated: it is shared across runs, and a run's identity is its own.
  // Provenance rides along: a gated call records the job it belongs to on the
  // action, which is how the decision later finds the run that is suspended.
  // The surface rides along too: a delegated run reaches the same screen as the
  // run that asked for it, so the delegate must be told about that screen.
  /** An action a tool reported the run must wait on, without gating itself. */
  let suspendedBy: string | undefined;
  const toolCtx: ToolContext = {
    ...ctx,
    suspend: (actionId: string) => { suspendedBy = actionId; },
    ...(platformContext ? { timezone: platformContext.timezone } : {}),
    conversationId,
    agentId: agent.id,
    sessionTools: (ctx.delegationDepth ?? 0) === 0 ? registry.list().filter((t) => t.tier === 'session' && allowedTools.has(t.name)).map((t) => t.name) : [],
    ...(opts.surface ? { surface: opts.surface } : {}),
    // So `web.status` can answer "can I search right now?" truthfully for *this*
    // agent. Without it the plugin would report the Tavily key's state to an
    // agent whose searches never touch Tavily.
    ...(search.enabled
      ? { nativeSearch: { provider: snapshot.provider, maxUses: search.maxUses } }
      : {}),
  };

  // Attachments: cap first, hydrate second, persist third. The caps fail closed
  // before anything is written, so an over-limit message leaves no half-state.
  const attachments = opts.attachments ?? [];
  assertAttachmentCount(attachments);

  // Observations the run has finished with are reduced to a line before the
  // history is replayed: a browser session is mostly page trees it already
  // acted on, and carrying all of them is what ends the conversation early.
  // The stored transcript is untouched (`compactObservations`).
  const history = compactObservations(
    opts.transcript ? await opts.transcript.load() : await loadMessages(pool, conversationId),
  );
  // Stored history carries artifact_ref blocks; the provider needs the bytes.
  const replayed = await hydrateMessages(history, opts.loadArtifact);

  const userBlocks: ContentBlock[] = [
    { type: 'text', text: openingText },
    ...toArtifactRefBlocks(attachments),
  ];
  const sentUserBlocks = await hydrateContent(userBlocks, opts.loadArtifact, {
    enforceCaps: true,
  });
  // What is persisted is the reference, never the base64.
  // The library learns of the use in the same statement that writes the
  // reference: a file the owner sent here, or one first saved elsewhere and
  // sent again. One statement, so the two can never disagree.
  // A run resumed on an approved action carries that action's result in this
  // turn; when the tool saves files, they are recorded as produced here, the
  // same as an immediate result would have been.
  const resumedProduced: ArtifactUse[] = resume?.state === 'succeeded' && resume.tool && registry.lookup(resume.tool)?.producesArtifacts
    ? producedArtifactIds(resume.result).map((id) => ({ artifactId: id, kind: 'produced' as const, agentId: agent.id }))
    : [];
  // A resumed run's opening turn is the decided approval coming back, not the
  // owner speaking: it is stamped as such so no transcript draws it as theirs.
  const openingSpeaker =
    opts.transcript?.openingSpeaker ?? opts.openingSpeaker ?? (resume ? APPROVAL_RESUME_SPEAKER : undefined);
  await persistMessage(pool, conversationId, 'user', userBlocks, openingSpeaker, [
    ...attachments.map((a) => ({ artifactId: a.artifactId, kind: 'uploaded' as const, agentId: null })),
    ...resumedProduced,
  ]);
  // Degrade what the provider cannot carry into a placeholder the model can
  // read and talk about. Only what is *sent* changes: the persisted turn above
  // still holds the artifact reference, so the same history sent to a provider
  // that accepts documents tomorrow still carries the real file.
  const messages: NeutralMessage[] = degradeMessages(
    [...replayed, { role: 'user', content: sentUserBlocks }],
    capabilities,
  );
  const ephemeralImages = new Set<ContentBlock>();

  await appendEvent(
    pool,
    resume ? 'run.resumed' : 'run.started',
    {
      agentId: agent.id,
      tools: tools.map(t => t.name),
      maxTurns: agent.maxTurns,
      // The per-run snapshot: which company this run's data went to, on which
      // model, under which credential. Written before the first call, so it is
      // on record even if the call never comes back.
      provider: snapshot.provider,
      credentialKind: snapshot.credentialKind,
      ...(snapshot.accountId ? { accountId: snapshot.accountId } : {}),
      model: snapshot.model,
      capabilities: snapshot.capabilities,
      // Which backend honours this run's web grant, and why. On record before
      // the first call, like the rest of the snapshot.
      webSearch: { native: search.enabled, reason: search.reason, maxUses: search.maxUses },
      // The profile's *id*, not the profile: the event log records where the
      // run came from, and the capability facts are already in the prompt.
      ...(opts.surface ? { surface: opts.surface.id } : {}),
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(resume ? { actionId: resume.actionId, approvalState: resume.state } : {}),
    },
    conversationId,
  );

  const usage: Usage = { input: 0, output: 0 };
  let turns = 0;
  let stopped: RunResult['stopped'] = 'max_turns';
  /**
   * Everything the model said this run, in order. Not the last thing it said:
   * a run that drafts a reply, calls a tool and then adds a closing line said
   * both, and the owner is owed both. See `joinSpoken`.
   */
  const spoken: SpokenBlock[] = [];
  /** The action this run is waiting on, once one exists. */
  let pendingActionId: string | undefined;
  // Run-local: only a successful declared question tool can close dispatch.
  // The next owner turn starts with a fresh boundary, not a permanent grant.
  let waitingForOwner = false;

  while (turns < agent.maxTurns) {
    ctx.signal?.throwIfAborted();
    turns++;
    const res = await provider.complete({
      system: waitingForOwner ? `${system}\n\nYou have asked the owner a question. Finish by stating that question and wait for their answer. Do not call more tools or claim the pending work is done.` : system,
      messages: opts.transcript?.bound ? opts.transcript.bound(messages) : messages,
      tools: waitingForOwner ? [] : tools,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      ...(search.enabled && !waitingForOwner ? { nativeSearch: { maxUses: search.maxUses } } : {}),
      ...(agent.thinking ? { thinking: agent.thinking } : {}),
      ...(opts.onDelta ? { onDelta: opts.onDelta } : {}),
    });
    ctx.signal?.throwIfAborted();
    usage.input += res.usage.input;
    usage.output += res.usage.output;
    if (res.usage.webSearches) {
      usage.webSearches = (usage.webSearches ?? 0) + res.usage.webSearches;
    }
    // The concrete model, as the endpoint reports it — an alias resolving to a
    // dated snapshot is exactly what the pin cannot tell you.
    if (res.model) snapshot.servedModel = res.model;

    const assistantContent = res.content;
    // What is *sent back* keeps the provider's own blocks — a paused turn is
    // only continuable with them. What is *stored* does not: see `persistable`.
    messages.push({ role: 'assistant', content: assistantContent });
    await persistMessage(pool, conversationId, 'assistant', persistable(assistantContent), opts.transcript?.speaker);

    // The audit line for a search nobody dispatched. Written before the run can
    // end, and before the next request, so the order in the log is the order it
    // happened in.
    if (res.searches && res.searches.length > 0) {
      const events: NativeSearchEvent[] = res.searches.map((record) => ({
        ...record,
        agentId: agent.id,
        conversationId,
        provider: snapshot.provider,
      }));
      await appendEvent(pool, 'web.searched', { native: true, searches: events }, conversationId);
      try {
        await opts.onNativeSearch?.(events);
      } catch {
        // An audit sink that throws does not fail a turn the owner is waiting
        // on — the same rule `recordFetch` applies to its own writes.
      }
    }

    const toolUses = assistantContent.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
    );

    const turnText = textOf(assistantContent);
    if (turnText) {
      spoken.push({ text: turnText, beforeToolCall: toolUses.length > 0 });
      await opts.onText?.(turnText);
    }

    // Not an ending: the API stopped a long server-tool turn part-way and wants
    // the same turn continued. No user message, no tool results — the assistant
    // content is already back on `messages`, provider blocks and all.
    if (res.stopReason === 'pause_turn') continue;

    if (res.stopReason !== 'tool_use' || toolUses.length === 0) {
      stopped = res.stopReason === 'max_tokens' ? 'max_tokens' : 'end_turn';
      break;
    }

    const results: ContentBlock[] = [];
    const images: ContentBlock[] = [];
    /** Files the tools of this turn saved, recorded with the results they came in. */
    const produced: ArtifactUse[] = [];
    let skipReason: string | undefined;
    for (const call of toolUses) {
      if (ctx.signal?.aborted || waitingForOwner || skipReason || pendingActionId) {
        results.push({ type: 'tool_result', tool_use_id: call.id, is_error: true,
          content: `not-executed: ${ctx.signal?.aborted ? 'the owner cancelled this run' : waitingForOwner ? 'waiting for the owner to answer the question; finish your reply and do not call more tools' : skipReason ?? 'waiting for owner approval'}` });
        continue;
      }
      opts.onToolCall?.(call.name, call.input);
      await appendEvent(
        pool,
        'tool.called',
        { name: call.name, input: call.input },
        conversationId,
      );

      // Tool definitions constrain the model's vocabulary, not its authority.
      // Recheck every returned call, including calls to installed but hidden tools.
      const outcome = ctx.signal?.aborted
        ? { ok: false as const, reason: 'cancelled' as const, message: 'Cancelled before dispatch; no action was taken.' }
        : allowedTools.has(call.name)
        ? await registry.invoke(call.name, call.input, { ...toolCtx, toolUseId: call.id })
        : { ok: false as const, reason: registry.has(call.name) ? 'tool-not-granted' as const : 'unknown-tool' as const,
            message: `tool ${call.name} is not granted to this run` };
      if (outcome.ok) {
        if (registry.waitsForOwner(call.name)) waitingForOwner = true;
        // A tool that declares it saves files, and names them in its output,
        // has each one recorded as produced here by this agent — with the
        // result row, in one statement. A tool that merely returns files does not.
        if (registry.lookup(call.name)?.producesArtifacts) {
          for (const id of producedArtifactIds(outcome.output)) produced.push({ artifactId: id, kind: 'produced', agentId: agent.id });
        }
        // The tool finished, but it left the run waiting on a decision the
        // owner has to make elsewhere: nothing more is dispatched this turn,
        // and the run ends resumable on that action.
        if (suspendedBy !== undefined && pendingActionId === undefined) {
          pendingActionId = suspendedBy;
          opts.onApprovalRequired?.(suspendedBy, 'a member of the group is waiting for the owner');
        }
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(outcome.output ?? null),
        });
        await appendEvent(
          pool,
          'tool.result',
          { name: call.name, ok: true },
          conversationId,
        );
        if (!ctx.signal?.aborted) {
          try {
            const picture = await registry.image(call.name, outcome.output, toolCtx);
            if (picture && capabilities.multimodalImage) images.push({ type: 'image', ...picture });
          } catch { /* Observation loss must never turn a completed action into a retry. */ }
        }
      } else if (outcome.reason === 'approval-required') {
        // Not a refusal: the call was recorded as an action and the owner has
        // been asked. The tool_use is answered so the transcript stays valid,
        // and it is answered *without* `is_error` — nothing went wrong.
        //
        // Every remaining call in this turn is still answered (the API requires
        // one result per tool_use), and the run then stops: it is resumable
        // from durable state alone, with no worker and no transaction held.
        if (pendingActionId === undefined) pendingActionId = outcome.actionId;
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: awaitingApprovalText(outcome.actionId),
        });
        opts.onApprovalRequired?.(outcome.actionId, outcome.preview);
        await appendEvent(
          pool,
          'tool.result',
          {
            name: call.name,
            ok: false,
            reason: outcome.reason,
            actionId: outcome.actionId,
          },
          conversationId,
        );
      } else {
        if (registry.isSequential(call.name)) skipReason = 'an earlier sequential action failed; observe before continuing, never blindly retry a submission';
        // The model gets to see refusals, verbatim reason included.
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: `${outcome.reason}: ${outcome.message}`,
          is_error: true,
        });
        await appendEvent(
          pool,
          'tool.result',
          { name: call.name, ok: false, reason: outcome.reason },
          conversationId,
        );
      }
    }

    messages.push({ role: 'user', content: results });
    await persistMessage(pool, conversationId, 'user', results, opts.transcript?.speaker, produced);
    // Ephemeral observations: only the latest picture is sent, never base64 in
    // durable transcripts or stale screenshots repeated on every later turn.
    for (const message of messages) message.content = message.content.filter((b) => !ephemeralImages.has(b));
    if (images.length > 0) {
      const latest = images[images.length - 1]!;
      ephemeralImages.add(latest);
      messages[messages.length - 1]!.content = [...results, latest];
    }
    ctx.signal?.throwIfAborted();

    if (pendingActionId !== undefined) {
      stopped = 'awaiting-approval';
      break;
    }
  }

  await appendEvent(
    pool,
    'run.finished',
    {
      turns,
      stopped,
      usage,
      provider: snapshot.provider,
      model: snapshot.model,
      servedModel: snapshot.servedModel ?? null,
      ...(snapshot.accountId ? { accountId: snapshot.accountId } : {}),
      credentialKind: snapshot.credentialKind,
      // The profile's *id*, not the profile: the event log records where the
      // run came from, and the capability facts are already in the prompt.
      ...(opts.surface ? { surface: opts.surface.id } : {}),
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(pendingActionId ? { actionId: pendingActionId } : {}),
    },
    conversationId,
  );

  return {
    text: joinSpoken(spoken),
    turns,
    stopped,
    usage,
    snapshot,
    ...(pendingActionId ? { pendingActionId } : {}),
  };
}
