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
  appendRoomNote,
  conversationGroup,
  createGroupConversation,
  createGroupRequest,
  getGroup,
  getGroupRequest,
  latestGroupConversation,
  openGroupRequest,
  openGroupRequestForGroup,
  readGroupTurns,
  releaseGroupCall,
  reserveGroupCall,
  reserveMaintenanceCall,
  roomChars,
  setGroupRequestState,
  setGroupSummary,
  suspendedGroupRequest,
  decideApproval,
  type GroupContext,
  type GroupRequestRow,
  type GroupRow,
  getAction,
  getArtifact,
  listOpenOffers,
  openQuestion,
  askQuestion,
  answerQuestion,
  APPROVAL_RESUME_SPEAKER,
  OPENING_TURN_SPEAKER,
  ToolRegistry,
  type AgentAvailability,
  type AgentCatalog,
  type ArtifactRow,
  type CatalogAgent,
  type ToolContext,
} from '@buddi/core';
import {
  BudgetExhausted,
  DELEGATE_TOOL,
  GROUP_ASK_TOOL,
  MAX_ATTACHMENTS_PER_MESSAGE,
  boundProjection,
  budgetedProvider,
  createConversation,
  createGroupAskTool,
  projectTranscript,
  runAgent,
  type AttachmentRef,
  type RunAgentOptions,
  type RuntimeProvider,
} from '@buddi/runtime';
import { nativeSearchRecorder } from '@buddi/tool-web';
import { ownerRequestContext } from '../surfaces/owner-request.js';
import type { Pool } from 'pg';
import { FIRST_RUN_SUFFIX, shouldStartFirstRun } from '../agents/first-run.js';
import { ROLE_FRONT_DESK, ROLE_MAKER } from '../agents/roles.js';
import { listRecentConversations } from '../chat/conversations.js';
import {
  OFFER_POLICY_SUFFIX,
  OFFER_TOOLS,
  createOfferManifest,
  storeTurnOffers,
  withdrawTurnOffers,
  type OfferSink,
} from '../surfaces/offered-actions.js';
import {
  ASK_POLICY_SUFFIX,
  ASK_TOOLS,
  createAskManifest,
  type AskSink,
} from '../surfaces/pending-question.js';
import { failedTurnReply } from '../surfaces/failure.js';
import {
  IDLE_TIMEOUT_MS,
  MAX_TRANSCRIPT_CHARS,
  conversationForTurn,
  readVitals,
} from '../surfaces/conversation-lifetime.js';
import { QUESTION_ASKED, QUESTION_CLEARED, holdsQuestion } from './attention.js';
import { type ArtifactStore } from '../telegram/attachments.js';
import { LiveTurns } from './live.js';

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
  /**
   * Where this agent sits in the dashboard's agent rail: pinned to its head,
   * pinned to its foot, or `null` for the ordinary colleagues in between.
   *
   * Resolved here, from roles, rather than in the page — so `packages/web`
   * never learns an agent's name or id, and an installation that renames its
   * front desk, writes its own, or has none keeps the right rail either way.
   */
  anchor: AgentAnchor | null;
  /**
   * The agent's own opening: one sentence about what it does, and up to three
   * example requests. Both come from the agent file; a surface that has
   * neither falls back to `description`.
   */
  intro?: string;
  starters?: string[];
  /**
   * Reasoning before the answer: `on`, `off`, or null for the model's own
   * default. Sent with the roster because it is switched where the owner
   * talks, beside the model name, and the Agents page writes the same key.
   */
  thinking: 'on' | 'off' | null;
  /** The face to draw, if the file names one. An image is fetched from this origin only. */
  avatar?: { kind: 'emoji'; value: string } | { kind: 'image'; url: string };
  /** `#rrggbb`, the agent's own colour. */
  accent?: string;
}

/** An image name is a plain file name with a raster extension; anything else is drawn as text. */
export const AVATAR_IMAGE = /^[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/i;

export function avatarOf(id: string, value: string | undefined): ChatAgentView['avatar'] {
  if (!value) return undefined;
  if (AVATAR_IMAGE.test(value)) return { kind: 'image', url: `/api/agents/${encodeURIComponent(id)}/avatar` };
  return { kind: 'emoji', value: value.slice(0, 8) };
}

/** The two ends of the rail an agent can be pinned to. */
export type AgentAnchor = 'top' | 'bottom';

/**
 * Which roles pin an agent to which end, and why those two ends differ.
 *
 * The distinction is *what the agent acts on*. Almost every agent acts on the
 * owner's life — his money, his mail, his car — and those belong in the middle
 * of the rail, where the eye lands and where he reaches all day. Two do not:
 *
 *  - The **front desk** is where you go when you do not yet know who you need.
 *    That is the first question of any session, so it is the first face, above
 *    a line.
 *  - The **maker** configures the installation itself. It is the settings door,
 *    and a settings door belongs at the foot of a sidebar — reachable, out of
 *    the way, and not competing with the work for the middle of the rail.
 *
 * Keyed to roles, so "nobody claims it" is simply an end with nothing pinned to
 * it, and two claimants are both pinned rather than one silently winning. An
 * agent claiming both is a front desk first: it is the one you reach for.
 */
export const ANCHOR_ROLES: Readonly<Record<string, AgentAnchor>> = {
  [ROLE_FRONT_DESK]: 'top',
  [ROLE_MAKER]: 'bottom',
};

/**
 * Why this agent cannot take a turn, in one sentence the page can print.
 *
 * The same words the CLI uses when the owner switches to an agent with no
 * brain (`chat/session.ts`), so a refusal reads the same wherever it lands.
 * The *reason* is the account service's own (`ProviderAccounts.selection`):
 * nothing here second-guesses what is missing.
 */
export function unavailableMessage(agent: { name: string; availability: AgentAvailability }): string {
  return agent.availability.ok
    ? ''
    : `${agent.name} cannot run here: ${agent.availability.problem.message}`;
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
      model: modelOf(full),
      anchor: anchorOf(summary.roles),
      thinking: full?.thinking ?? null,
      ...(summary.intro === undefined ? {} : { intro: summary.intro }),
      ...(summary.starters === undefined || summary.starters.length === 0
        ? {}
        : { starters: [...summary.starters] }),
      ...(summary.avatar === undefined ? {} : { avatar: avatarOf(summary.id, summary.avatar) }),
      ...(summary.accent === undefined ? {} : { accent: summary.accent }),
    };
  });
  return { agents, defaultAgentId: catalog.defaultAgent().id };
}

/**
 * The model this agent actually runs on, or nothing.
 *
 * Where the installation has named accounts, an agent with none pinned falls
 * back to `providerFromEnv` — which answers with Anthropic's default model
 * whatever the owner has. That is how a fresh installation whose only account
 * was Ollama Cloud showed `claude-sonnet-5` under an agent it could not run at
 * all. The empty `accountId` is the accounts service saying "no binding";
 * `undefined` is an installation with no accounts, where the file's own pin is
 * the truth. So the first reports nothing, and the composer draws no pill
 * beside the sentence that already says an account is missing.
 */
function modelOf(agent: CatalogAgent | undefined): string {
  if (!agent) return '';
  if (agent.provider.accountId === '') return '';
  return agent.provider.model || agent.model || '';
}

/** Which end this agent's roles pin it to, or null for the middle. */
export function anchorOf(roles: readonly string[]): AgentAnchor | null {
  const claimed = roles.map((role) => ANCHOR_ROLES[role]).filter((end): end is AgentAnchor => !!end);
  if (claimed.includes('top')) return 'top';
  return claimed[0] ?? null;
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
  | { type: 'tool_result'; toolUseId: string; name: string; ok: boolean; output: unknown; error?: string; approval?: { id: string; state: string } }
  | { type: 'attachment'; artifactId: string; filename: string | null; mime: string; kind: string; sizeBytes: number | null }
  | { type: 'thinking'; text: string }
  /**
   * A gated action, decided and come back. The turn that carries it is a user
   * turn on the wire — the tool_use it answers was closed before the run
   * suspended — so it is named here for what it is, and no page has to decide
   * whether "tool result (deferred) for action …" is something the owner said.
   */
  | { type: 'approval_result'; actionId: string; name: string; state: string; output: unknown }
  | { type: 'unknown'; raw: unknown };

export interface ChatMessageView {
  id: string;
  role: string;
  at: string;
  blocks: ChatBlock[];
  /** Who spoke, in a group conversation: 'owner', an agent id, or 'room'. */
  speaker?: string;
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

/**
 * How much life this conversation has left in it.
 *
 * The rule that ends a conversation — three hours idle, or a transcript past
 * the budget — lives in `conversation-lifetime.ts` and is evaluated on the
 * server when a message arrives. The page cannot re-derive it without hard-
 * coding those two numbers, and a dashboard that says "fresh" about a thread
 * that is one message from rolling over would be worse than saying nothing. So
 * the limits are *sent*, and the header renders them.
 */
export interface ChatLifetimeView {
  /** Messages stored in this conversation. Zero means nothing was said yet. */
  messages: number;
  /** The last thing written in it. */
  lastActivityAt: string | null;
  /** Characters of stored transcript, against `maxChars`. */
  chars: number;
  idleTimeoutMs: number;
  maxChars: number;
}

export interface ChatTranscript {
  conversationId: string;
  agentId: string;
  /** Set when this conversation belongs to a group. */
  groupId?: string;
  startedAt: string;
  /** What would end this conversation, and how close it is. */
  lifetime: ChatLifetimeView;
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
  /** The exact structured question currently waiting in this conversation. */
  question: Awaited<ReturnType<typeof openQuestion>>;
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
    `select id, agent_id, group_id, created_at from core.conversations where id = $1::uuid`,
    [conversationId],
  );
  const conversation = head[0];
  if (!conversation) return null;

  /*
   * The turn first run sent on the owner's behalf is not in the transcript.
   *
   * It is a real message — the model was given it, and the assistant's first
   * words are an answer to it — but it was never the owner speaking, and a
   * thread that opens with an instruction to introduce oneself reads as if the
   * owner typed it. One `where`, in the reader, so every surface that draws a
   * conversation leaves it out and the runtime's own history is untouched.
   */
  const { rows: messages } = await pool.query(
    `select id, role, content, created_at, speaker from core.messages
      where conversation_id = $1::uuid and speaker is distinct from $2
      order by created_at asc, id asc`,
    [conversationId, OPENING_TURN_SPEAKER],
  );

  const parsed = messages.map((m) => ({
    id: String(m.id),
    role: String(m.role),
    at: new Date(m.created_at).toISOString(),
    raw: rawBlocks(m.content),
    speaker: typeof m.speaker === 'string' ? m.speaker : null,
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
  // Gates are persisted as provider-compatible text. Join their durable state
  // here so reloads and decisions from another surface show the same prompt.
  const { rows: actions } = await pool.query(
    `select a.id, a.tool, case when p.state = 'pending' and a.expires_at <= $2 then 'expired' else p.state end as state,
            p.outcome from core.actions a join core.approvals p on p.action_id = a.id
      where a.conversation_id = $1::uuid`, [conversationId, now],
  );
  const approvals = new Map<string, TranscriptApproval>(actions.map(a => [String(a.id), a as TranscriptApproval]));

  // Untaken, unexpired, this conversation's. A chip the owner clicks goes
  // through the same claim-once take the Telegram tap does.
  const [open, question] = await Promise.all([
    listOpenOffers(pool, { now, conversationId, limit: 10 }).catch(() => []),
    openQuestion(pool, { now, conversationId }).catch(() => null),
  ]);
  const vitals = await readVitals(pool, conversationId);

  return {
    lifetime: {
      messages: vitals.messages,
      lastActivityAt: vitals.lastActivityAt?.toISOString() ?? null,
      chars: vitals.chars,
      idleTimeoutMs: IDLE_TIMEOUT_MS,
      maxChars: MAX_TRANSCRIPT_CHARS,
    },
    offers: open.map((offer) => ({
      id: offer.id,
      label: offer.label,
      prompt: offer.prompt,
      expiresAt: offer.expiresAt,
    })),
    question,
    conversationId: String(conversation.id),
    agentId: String(conversation.agent_id),
    ...(conversation.group_id ? { groupId: String(conversation.group_id) } : {}),
    startedAt: new Date(conversation.created_at).toISOString(),
    messages: parsed.map((m) => ({
      id: m.id,
      role: m.role,
      at: m.at,
      blocks: m.speaker === APPROVAL_RESUME_SPEAKER
        ? approvalResultBlocks(m.raw, approvals)
        : m.raw.map((block) => toChatBlock(block, toolNames, artifacts, approvals))
            .map((block) => m.role === 'user' ? withoutLegacyNote(block) : block),
      ...(m.speaker ? { speaker: m.speaker } : {}),
    })),
    ...(await runsOf(pool, conversationId)),
  };
}

/** `tool result (deferred) for action <id>: <state>` — what the runtime writes. */
const RESUMED_APPROVAL = /^tool result \(deferred\) for action ([0-9a-f-]{36}): (\w+)/;

/**
 * The resumed turn, as what it is: one decided action, named and expandable.
 *
 * The text is the runtime's own wording (`approvalOutcomeText`), and the state
 * it quotes is a copy of a row this reader already holds — so the action is
 * looked up and the row wins, the same way a pending gate's chip does.
 */
function approvalResultBlocks(
  raw: Array<Record<string, any>>,
  approvals: Map<string, TranscriptApproval>,
): ChatBlock[] {
  const text = raw.find((block) => block.type === 'text')?.text;
  const match = typeof text === 'string' ? RESUMED_APPROVAL.exec(text) : null;
  if (!match) return raw.map((block) => toChatBlock(block, new Map(), new Map(), approvals));
  const action = approvals.get(match[1] as string);
  const state = action?.state ?? (match[2] as string);
  return [{
    type: 'approval_result',
    actionId: match[1] as string,
    name: action?.tool ?? '',
    state,
    output: state === 'succeeded'
      ? (action?.outcome as { result?: unknown } | null)?.result ?? resultOf(text as string)
      : action?.outcome ?? resultOf(text as string),
  }];
}

/** What the runtime wrote after `result:`, when the action row says nothing. */
function resultOf(text: string): unknown {
  const body = text.slice(text.indexOf('\n') + 1);
  return body.startsWith('result: ') ? maybeJson(body.slice('result: '.length)) : body.trim() || null;
}

/**
 * Conversations from before the note was generated at send time persisted it
 * in the owner's own text. Those rows are not rewritten; the sentence is
 * dropped on read, so an old thread shows a file where a file was sent.
 */
const LEGACY_NOTE = /\n*\[Attached file: [^\]]*artifact id [0-9a-f-]{36}\.[^\]]*\]/g;
function withoutLegacyNote(block: ChatBlock): ChatBlock {
  if (block.type !== 'text' || !block.text.includes('[Attached file:')) return block;
  return { type: 'text', text: block.text.replace(LEGACY_NOTE, '').trim() };
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

interface TranscriptApproval { id: string; tool: string; state: string; outcome: unknown }

function toChatBlock(
  block: Record<string, any>,
  toolNames: Map<string, string>,
  artifacts: Map<string, ArtifactRow>,
  approvals: Map<string, TranscriptApproval>,
): ChatBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: String(block.text ?? '') };
    case 'thinking':
      return { type: 'thinking', text: String(block.text ?? '') };
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
      const gateId = typeof content === 'string'
        ? /^awaiting owner approval \(action ([0-9a-f-]{36})\); this effect has not happened$/.exec(content)?.[1]
        : undefined;
      const action = gateId ? approvals.get(gateId) : undefined;
      if (action && action.tool === toolNames.get(toolUseId)) {
        const failed = ['rejected', 'expired', 'failed', 'unknown'].includes(action.state);
        return {
          type: 'tool_result', toolUseId, name: action.tool, ok: !failed,
          approval: { id: action.id, state: action.state },
          output: action.state === 'pending' ? output : action.state === 'succeeded'
            ? (action.outcome as { result?: unknown } | null)?.result ?? null
            : action.outcome ?? { state: action.state },
          ...(failed ? { error: `Action ${action.state}` } : {}),
        };
      }
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
      // The row is the truth when the artifact still exists; the reference
      // carries enough to name a file whose bytes are gone.
      return {
        type: 'attachment',
        artifactId,
        filename: row?.filename ?? (typeof block.filename === 'string' ? block.filename : null),
        mime: row?.mime ?? String(block.mime ?? 'application/octet-stream'),
        kind: row?.kind ?? String(block.kind ?? 'other'),
        sizeBytes: row?.sizeBytes ?? (typeof block.sizeBytes === 'number' ? block.sizeBytes : null),
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
  onConversationRollover?: import('../surfaces/browser-continuation.js').ConversationRolloverHook;
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
  /** What a group run remembers: shared plus the room's scope, never private. */
  groupMemoryPreamble?: ((groupId: string) => Promise<string>) | undefined;
  /** The coordinator's delegation allowlist: the room does not widen who may ask whom. */
  allowlistFor?: ((agentId: string) => string[]) | undefined;
  /** Refuse the turn with this sentence — the global pause, in practice. */
  gate?: (() => Promise<string | null>) | undefined;
  log?: ((line: string) => void) | undefined;
}

/** The queue a group's runs serialise on: the group, not any one of its conversations. */
function groupKey(groupId: string): string {
  return `group:${groupId}`;
}

/** A run inside a room: which group, which request, whose voice, and what opens it. */
interface RoomTurn {
  row: GroupRow;
  request: GroupRequestRow;
  role: 'coordinator' | 'member';
  openingSpeaker: string;
  opening: string;
  /** The conclusion: no tools, whatever the ledger says. */
  synthesis?: boolean;
  /** A member spoke through group.ask. */
  onContribution?: () => void;
  /** The agent running this turn said something (after any contribution). */
  onSpoke?: () => void;
}

export interface SendRequest {
  agentId: string;
  conversationId?: string | undefined;
  text: string;
  attachmentIds?: string[] | undefined;
  /**
   * The turn is first run's, not the owner's: the instruction that makes a
   * brand-new assistant introduce itself.
   *
   * The model is given it exactly like any other opening turn — it is the
   * prompt — and every transcript reader leaves it out, because the owner
   * never said it. The route above this is what decides a caller may set it,
   * and it may be claimed once per installation.
   */
  opening?: boolean | undefined;
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
  /** The answer being written, per conversation, for the stream to hand on. */
  readonly live = new LiveTurns();
  /** One send at a time per group decides its conversation and opens its request. */
  readonly #groupLocks = new Map<string, Promise<void>>();
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
    // No brain, no turn. An agent whose account is missing, disabled or
    // unconfigured cannot answer, and accepting the message anyway spends the
    // owner's typing on a run that fails somewhere they are not looking. The
    // page says the same sentence above its composer; this is what makes it
    // true rather than decorative.
    if (!agent.availability.ok) {
      return { ok: false, status: 409, error: unavailableMessage(agent) };
    }

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
      // A room is only ever spoken to as a room: through the group path, with
      // its budget, its projection and its memory scope. Never as its coordinator.
      if (await conversationGroup(this.#deps.pool, conversationId)) {
        return { ok: false, status: 409, error: 'that conversation belongs to a group; send to the group' };
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
        start: async (boundary) => {
          const next = await createConversation(this.#deps.pool, agent.id);
          if (boundary) await this.#deps.onConversationRollover?.(agent.id, boundary.previousConversationId, next, boundary.reason);
          return next;
        },
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

    // The owner is writing to this agent, so whatever it was holding out for is
    // answered — or abandoned, which amounts to the same claim being dropped.
    // Checked first so an ordinary turn does not append a "nothing changed" row
    // to the log every time anybody says anything.
    if (await holdsQuestion(this.#deps.pool, agent.id, this.#deps.now()).catch(() => false)) {
      await this.#event(conversationId, QUESTION_CLEARED, { agentId: agent.id });
    }

    const runId = randomUUID();
    const target = conversationId;
    const opening = request.opening === true;
    this.#enqueue(target, async () => { await this.#run({ agent, conversationId: target, runId, text, files, opening }); });
    return { ok: true, conversationId: target, runId, ...(boundary ? { boundary } : {}) };
  }

  /** Answer one exact structured question, then continue its conversation. */
  async answer(input: {
    id: string;
    answer: string;
    optionId?: string;
  }): Promise<SendResult> {
    const settled = await answerQuestion(this.#deps.pool, {
      ...input,
      via: 'web',
      now: this.#deps.now(),
    });
    if (!settled.ok) {
      const status = settled.reason === 'unknown' ? 404 : 409;
      return { ok: false, status, error: 'That question is no longer waiting for an answer.' };
    }
    const groupId = await conversationGroup(this.#deps.pool, settled.question.conversationId).catch(() => null);
    if (groupId) {
      const sent = await this.sendToGroup({ groupId, conversationId: settled.question.conversationId, text: input.answer });
      return sent.ok ? { ok: true, conversationId: sent.conversationId, runId: sent.runId } : sent;
    }
    return this.send({
      agentId: settled.question.agentId,
      conversationId: settled.question.conversationId,
      text: input.answer,
    });
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
  resumeHost(action: { agentId: string; conversationId: string | null }, resume: NonNullable<RunAgentOptions['resume']>): void {
    if (!action.conversationId) return;
    const agent = this.#deps.catalog.get(action.agentId);
    if (!agent) return;
    const conversationId = action.conversationId;
    void (async () => {
      // A group conversation resumes as a group request, on the group's own
      // queue: the member that stopped runs on with the outcome, then the
      // coordinator picks up.
      const groupId = await conversationGroup(this.#deps.pool, conversationId).catch(() => null);
      if (groupId) {
        this.#enqueue(groupKey(groupId), () => this.#resumeGroup(groupId, conversationId, agent, resume));
        return;
      }
      this.#enqueue(conversationId, async () => { await this.#run({ agent, conversationId, runId: randomUUID(), text: '', files: [], resume }); });
    })();
  }

  /* ------------------------------------------------------------------ *
   * Groups (docs/groups.md)
   * ------------------------------------------------------------------ */

  /**
   * One owner request to a group. The message goes to the members it names
   * with `@handle`, in order, or to the coordinator when it names none. Every
   * run of the request spends from one budget row.
   */
  async sendToGroup(request: { groupId: string; conversationId?: string | undefined; text: string; attachmentIds?: string[] | undefined }): Promise<
    | { ok: true; conversationId: string; runId: string; requestId: string; rolledOver?: boolean }
    | { ok: false; status: number; error: string }
  > {
    const pool = this.#deps.pool;
    let group = await getGroup(pool, request.groupId);
    if (!group) return { ok: false, status: 404, error: 'no such group' };
    const text = request.text.trim();
    if (text === '') return { ok: false, status: 400, error: '`text` must not be empty' };
    if (text.length > MAX_CHAT_MESSAGE_CHARS) return { ok: false, status: 413, error: `a message may be at most ${MAX_CHAT_MESSAGE_CHARS} characters` };
    const attachmentIds = request.attachmentIds ?? [];
    if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) return { ok: false, status: 400, error: `at most ${MAX_ATTACHMENTS_PER_MESSAGE} files may ride with one message` };
    const coordinator = this.#deps.catalog.get(group.coordinator);
    if (!coordinator) return { ok: false, status: 409, error: `the coordinator (${group.coordinator}) is not installed` };

    const files: ArtifactRow[] = [];
    for (const id of attachmentIds) {
      const row = await getArtifact(pool, id).catch(() => null);
      if (!row) return { ok: false, status: 404, error: `no such attachment: ${id}` };
      files.push(row);
    }

    // Deciding the conversation, rolling over and opening the request happen
    // under the group's lock, one send at a time; the row's index is the
    // durable version of the same rule.
    return this.#withGroupLock(group.id, async () => {
      const g = group as GroupRow;
      const open = await openGroupRequestForGroup(pool, g.id);
      if (open) return { ok: false as const, status: 409, error: open.state === 'suspended' ? 'The group is waiting for an approval. Decide it first.' : 'The group is still working on the last request.' };

      let conversationId = request.conversationId ?? (await latestGroupConversation(pool, g.id)) ?? undefined;
      if (conversationId !== undefined) {
        const owner = await conversationGroup(pool, conversationId);
        if (owner !== g.id) return { ok: false as const, status: 409, error: 'that conversation does not belong to this group' };
      }
      let rolledOver = false;
      let current = g;
      if (conversationId === undefined) {
        conversationId = await createGroupConversation(pool, g);
      } else if ((await roomChars(pool, conversationId)) > g.contextCapChars) {
        // Between requests only, never mid-exchange: the room has grown past
        // what every member can be sent, so it closes on a summary — and the
        // group is read again, so the new thread starts from that summary.
        await this.#rolloverGroup(g, conversationId, coordinator);
        current = (await getGroup(pool, g.id)) ?? g;
        conversationId = await createGroupConversation(pool, current);
        rolledOver = true;
      }

      let requestRow: GroupRequestRow;
      try {
        requestRow = await createGroupRequest(pool, { groupId: current.id, conversationId, text });
      } catch (err) {
        // The index says another request is open for this group.
        if ((err as { code?: string }).code === '23505') return { ok: false as const, status: 409, error: 'The group is still working on the last request.' };
        throw err;
      }
      const runId = randomUUID();
      const target = conversationId;
      const groupRow = current;
      this.#enqueue(groupKey(groupRow.id), () => this.#groupRequest({ group: groupRow, request: requestRow, conversationId: target, runId, text, files }));
      return { ok: true as const, conversationId, runId, requestId: requestRow.id, ...(rolledOver ? { rolledOver: true } : {}) };
    });
  }

  /** Serialise the sends of one group, the way runs are serialised per queue. */
  #withGroupLock<T>(groupId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#groupLocks.get(groupId) ?? Promise.resolve();
    const run = previous.then(work, work);
    this.#groupLocks.set(groupId, run.then(() => undefined, () => undefined));
    return run;
  }

  /** The members a message names with `@handle`, in the order named. */
  #mentioned(group: GroupRow, text: string): CatalogAgent[] {
    const out: CatalogAgent[] = [];
    for (const match of text.matchAll(/(^|[^\w@])@([a-z0-9][a-z0-9_-]*)/gi)) {
      const agent = this.#deps.catalog.byHandle(match[2]!.toLowerCase());
      if (agent && group.members.includes(agent.id) && !out.some((a) => a.id === agent.id)) out.push(agent);
    }
    return out;
  }

  /** Whole request: the runs it takes, and the row's state at the end. */
  async #groupRequest(turn: { group: GroupRow; request: GroupRequestRow; conversationId: string; runId: string; text: string; files: ArtifactRow[] }): Promise<void> {
    const { group, request, conversationId } = turn;
    const pool = this.#deps.pool;
    const coordinator = this.#deps.catalog.get(group.coordinator);
    if (!coordinator) return;
    const mentioned = this.#mentioned(group, turn.text).filter((agent) => agent.id !== group.coordinator);
    /** Whether anyone but the coordinator spoke: then the conclusion is its own call. */
    let contributions = 0;
    /** Whether the coordinator already concluded in prose after the last contribution. */
    let concluded = false;
    let outcome: 'done' | 'suspended' | 'failed' = 'done';
    try {
      if (mentioned.length > 0) {
        // The owner addressed members directly: each answers in turn, seeing
        // the ones before it; the coordinator concludes after.
        let first = true;
        for (const member of mentioned) {
          const result = await this.#run({
            agent: member, conversationId, runId: first ? turn.runId : randomUUID(), text: turn.text, files: first ? turn.files : [],
            group: { row: group, request, role: 'member', openingSpeaker: first ? 'owner' : 'room', opening: first ? turn.text : `@${member.handle}, the owner addressed you too. Your turn.` },
          });
          first = false;
          contributions += 1;
          if (result === 'suspended') { outcome = 'suspended'; break; }
          if (result === 'failed') { outcome = 'failed'; break; }
        }
      } else {
        const result = await this.#run({
          agent: coordinator, conversationId, runId: turn.runId, text: turn.text, files: turn.files,
          group: { row: group, request, role: 'coordinator', openingSpeaker: 'owner', opening: turn.text, onContribution: () => { contributions += 1; concluded = false; }, onSpoke: () => { concluded = true; } },
        });
        if (result === 'suspended') outcome = 'suspended';
        if (result === 'failed') outcome = 'failed';
      }
      // The conclusion: one call of the coordinator's, without tools, once
      // members have spoken. A request the coordinator answered alone, or
      // concluded itself after the last member spoke, needs no second answer.
      if (outcome === 'done' && contributions > 0 && !concluded && (await getGroupRequest(pool, request.id))?.state === 'running') {
        const result = await this.#run({
          agent: coordinator, conversationId, runId: randomUUID(), text: '', files: [],
          group: { row: group, request, role: 'coordinator', openingSpeaker: 'room', synthesis: true, opening: `Everyone asked has answered. Conclude now for the owner's request: "${turn.text}".` },
        });
        if (result === 'failed') outcome = 'failed';
      }
    } catch (err) {
      this.#log(`group ${group.id}: request ${request.id} failed: ${message(err)}`);
      outcome = 'failed';
    }
    // Only a running request finishes here: one that was suspended by the ask
    // tool, or stopped by the owner, keeps that state.
    if (outcome !== 'suspended') {
      await setGroupRequestState(pool, request.id, { state: outcome, from: ['running'], finishedAt: this.#deps.now() });
    }
  }

  /**
   * The member that was waiting runs on with the outcome; then the
   * coordinator continues. Only the request waiting on exactly this action,
   * by this agent, resumes — a stopped request, or a newer one, never does.
   */
  async #resumeGroup(groupId: string, conversationId: string, agent: CatalogAgent, resume: NonNullable<RunAgentOptions['resume']>): Promise<void> {
    const pool = this.#deps.pool;
    const group = await getGroup(pool, groupId);
    const request = group ? await suspendedGroupRequest(pool, conversationId, resume.actionId, agent.id) : null;
    if (!group || !request) {
      this.#log(`group ${groupId}: approval ${resume.actionId} has no request waiting on it; nothing resumes`);
      return;
    }
    if (!(await setGroupRequestState(pool, request.id, { state: 'running', from: ['suspended'], awaitingActionId: null, awaitingAgentId: null }))) return;
    const running = { ...request, state: 'running' as const };
    let contributions = 0;
    let concluded = false;
    const memberResult = await this.#run({
      agent, conversationId, runId: randomUUID(), text: '', files: [], resume,
      group: { row: group, request: running, role: agent.id === group.coordinator ? 'coordinator' : 'member', openingSpeaker: agent.id, opening: '', onContribution: () => { contributions += 1; concluded = false; } },
    });
    if (memberResult === 'suspended') return;
    let outcome: 'done' | 'failed' = memberResult === 'failed' ? 'failed' : 'done';
    if (agent.id !== group.coordinator && memberResult === 'ran') {
      const coordinator = this.#deps.catalog.get(group.coordinator);
      if (coordinator) {
        await appendRoomNote(pool, conversationId, `@${agent.handle} has finished the work it was waiting on. The coordinator continues.`);
        const result = await this.#run({
          agent: coordinator, conversationId, runId: randomUUID(), text: '', files: [],
          group: { row: group, request: running, role: 'coordinator', openingSpeaker: 'room', opening: `@${agent.handle} has finished. Continue the owner's request: "${request.text}". Bring in whoever is still needed, then stop; you will be asked to conclude.`, onContribution: () => { contributions += 1; concluded = false; }, onSpoke: () => { concluded = true; } },
        });
        if (result === 'suspended') return;
        if (result === 'failed') outcome = 'failed';
        else if (!concluded && (await getGroupRequest(pool, request.id))?.state === 'running') {
          const concluded = await this.#run({
            agent: coordinator, conversationId, runId: randomUUID(), text: '', files: [],
            group: { row: group, request: running, role: 'coordinator', openingSpeaker: 'room', synthesis: true, opening: `Everyone asked has answered. Conclude now for the owner's request: "${request.text}".` },
          });
          if (concluded === 'failed') outcome = 'failed';
        }
      }
    }
    await setGroupRequestState(pool, request.id, { state: outcome, from: ['running'], finishedAt: this.#deps.now() });
  }

  /**
   * The room closed: one maintenance call writes where it stopped, for the
   * next thread's first turn. Never taken from a request's twelve.
   */
  async #rolloverGroup(group: GroupRow, conversationId: string, coordinator: CatalogAgent): Promise<void> {
    const pool = this.#deps.pool;
    const last = await openGroupRequest(pool, conversationId) ?? null;
    const requestForBudget = last ?? (await createGroupRequest(pool, { groupId: group.id, conversationId, text: '(rollover summary)', budgetTotal: 0 }));
    try {
      const turns = await readGroupTurns(pool, conversationId);
      const handles = this.#handles();
      const history = boundProjection(projectTranscript({ turns, agentId: coordinator.id, handles }), group.contextCapChars);
      // One maintenance call, counted like any other dispatch: a retry the
      // adapter makes draws on the same single reservation and is refused.
      const maintenance = {
        reserve: async () => ((await reserveMaintenanceCall(pool, requestForBudget.id)) ? 'work' as const : 'spent' as const),
        release: async () => undefined,
      };
      const provider = budgetedProvider(this.#deps.providerFor(coordinator), maintenance, { canSynthesise: true });
      const res = await provider.complete({
        system: 'You are the coordinator of a group of agents. The conversation below is closing because it has grown long. Write a short summary of where it stopped: what was decided, what is still open, which questions are unanswered, and any artifact ids that matter. Plain prose, under 200 words. No tools.',
        messages: [...history, { role: 'user', content: [{ type: 'text', text: 'Summarise where this discussion stopped.' }] }],
        tools: [],
        maxTokens: 600,
      });
      const summary = res.content.filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text').map((b) => b.text).join('\n').trim();
      await setGroupSummary(pool, group.id, summary === '' ? null : summary);
    } catch (err) {
      if (!(err instanceof BudgetExhausted)) this.#log(`group ${group.id}: rollover summary failed: ${message(err)}`);
    } finally {
      if (!last) await setGroupRequestState(pool, requestForBudget.id, { state: 'done', from: ['running'], finishedAt: this.#deps.now() });
    }
  }

  #handles(): Map<string, string> {
    return new Map(this.#deps.catalog.list().map((agent) => [agent.id, agent.handle]));
  }

  /**
   * Stop the request a group conversation is in the middle of. A pending
   * approval it was waiting on is rejected here, so a late decision cannot
   * execute the effect or restart the request.
   */
  async stopGroupRequest(conversationId: string): Promise<boolean> {
    const pool = this.#deps.pool;
    const open = await openGroupRequest(pool, conversationId);
    if (!open) return false;
    const stopped = await setGroupRequestState(pool, open.id, { state: 'stopped', from: ['running', 'suspended'], finishedAt: this.#deps.now() });
    if (!stopped) return false;
    if (open.awaitingActionId) {
      await decideApproval(pool, { actionId: open.awaitingActionId, decision: 'rejected', by: this.#deps.ctx.ownerId, via: 'web', now: this.#deps.now() })
        .catch((err) => this.#log(`group ${open.groupId}: rejecting the pending approval on stop failed: ${message(err)}`));
    }
    this.cancel(conversationId);
    return true;
  }

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
    resume?: RunAgentOptions['resume'];
    /** Set for a run inside a room: which group, which request, and whose voice. */
    group?: RoomTurn;
    /** First run's opening turn: sent on the owner's behalf, never shown as theirs. */
    opening?: boolean;
  }): Promise<'ran' | 'suspended' | 'failed'> {
    const deps = this.#deps;
    const { agent, conversationId, runId } = turn;
    let toolsCalled = 0;

    const blocked = deps.gate ? await deps.gate() : null;
    if (blocked !== null) {
      await this.#failed(conversationId, runId, 'refused', blocked);
      return 'failed';
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
    // with the document it arrived on. Every file goes as a reference — name,
    // type, size, id — and the runtime writes the model's note from it at send
    // time. The transcript keeps the owner's words and the reference only, so
    // the page shows a file where a file was sent, not a sentence about one.
    const attachments: AttachmentRef[] = turn.files.map((row) => ({
      artifactId: row.id,
      mime: row.mime,
      kind: row.kind,
      filename: row.filename,
      sizeBytes: row.sizeBytes,
    }));
    const userMessage = turn.group ? turn.group.opening : turn.text;

    // "The owner said something, and it is in the transcript." Written before
    // the provider is called, so a page that connected mid-flight still sees
    // its own message appear.
    await this.#event(conversationId, 'chat.message.appended', { role: 'user', runId, ...(turn.group ? { agentId: agent.id } : {}) });

    let provider: RuntimeProvider;
    try {
      provider = deps.providerFor(agent);
    } catch (err) {
      // An agent whose credential is missing is a fact about the installation.
      // It is permanent by construction, so nothing is offered: the sentence
      // names the variable and what to do about it, and the log gets the rest.
      await this.#failedTurn({ err, agent, conversationId, runId, toolsCalled: 0 });
      return 'failed';
    }

    // A room: the budget wraps the provider, the transcript is the projection,
    // the coordinator gets the one tool that brings a member in, and memory is
    // the room's — shared plus group scope, never anyone's private notes.
    const room = turn.group ? this.#room(turn.group, agent, provider) : null;
    if (room) provider = room.provider;

    // `conversation.offer` is registered per run into a copy of the base
    // registry, the way the mission tools and `conversation.ask` are: nothing
    // outside an interactive turn can call it, and two conversations never
    // share a sink. The dashboard has buttons, so what it declares is drawn as
    // chips — by the profile, not by the surface's name.
    const offers: OfferSink = {};
    // `conversation.ask` is registered for the same reason it is on Telegram and
    // at the terminal: an agent that ends a turn needing an answer should say
    // so rather than leave a surface to guess from prose. What the dashboard
    // does with the declaration is different — it has no "whose turn is it"
    // problem, because the owner picks the agent — so it records the claim in
    // the event log, where the agent rail reads it as a badge.
    const ask: AskSink = {};
    const registry = new ToolRegistry();
    for (const manifest of deps.registry.manifests()) registry.register(manifest);
    registry.register(createOfferManifest(offers));
    registry.register(createAskManifest(ask));
    if (room?.askTool) registry.register({ name: 'group', version: '0.1.0', schema: 'group', migrationsDir: '', tools: [room.askTool] });

    // An offer belongs to the turn that made it; this turn retires the last
    // one's, so a chip cannot still fire after the conversation moved on.
    await withdrawTurnOffers(deps.pool, conversationId, deps.now(), this.#log);

    const base = agent.definition(deps.now(), deps.timezone);
    const baseCtx = turn.resume ? deps.ctx : ownerRequestContext(deps.ctx, turn.text, runId);
    const options: RunAgentOptions = {
      // In a room, delegation is the ask tool and nothing else: an agent
      // that could delegate would reach a non-member, off budget, off record.
      agent: {
        ...base,
        /*
         * The turn that introduces a new assistant is not a turn that asks.
         *
         * `conversation.ask` is granted by this surface rather than by any
         * agent file, and a model handed it on its very first breath uses it:
         * the owner met their assistant and was shown a form. It is back for
         * every turn after this one. Reasoning is off for the same reason — a
         * local model spending a minute thinking before "hello" is the whole
         * of the owner's first impression.
         */
        ...(turn.opening ? { thinking: 'off' as const } : {}),
        tools: [
          ...(room ? base.tools.filter((t) => t !== DELEGATE_TOOL) : base.tools),
          ...OFFER_TOOLS,
          ...(turn.opening ? [] : ASK_TOOLS),
          ...(room?.askTool ? [GROUP_ASK_TOOL] : []),
        ],
      },
      provider,
      registry,
      ctx: room ? { ...baseCtx, group: room.context } : baseCtx,
      pool: deps.pool,
      // The provider's own web search leaves the same audit row `web.search`
      // does; see @buddi/tool-web's native.ts.
      onNativeSearch: nativeSearchRecorder(deps.pool),
      conversationId,
      surface: WEB_SURFACE,
      runId,
      ...(turn.resume ? { resume: turn.resume } : { userMessage }),
      ...(turn.opening ? { openingSpeaker: OPENING_TURN_SPEAKER } : {}),
      systemSuffix: [OFFER_POLICY_SUFFIX, ASK_POLICY_SUFFIX, ...(systemSuffix ? [systemSuffix] : []), ...(room ? [room.policy] : [])].join(
        '\n\n',
      ),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(room ? { transcript: room.transcript } : {}),
      ...(room && deps.groupMemoryPreamble
        ? { memoryPreamble: () => deps.groupMemoryPreamble!(room.context.id) }
        : deps.memoryPreamble ? { memoryPreamble: deps.memoryPreamble } : {}),
      ...(deps.artifacts ? { loadArtifact: (id: string) => deps.artifacts!.load(id) } : {}),
      // Awaited: the runtime waits for this row before it writes anything
      // else, so "the assistant appended a message" is always ordered before
      // the `run.finished` of the turn that wrote it. Fired and forgotten, the
      // two inserts race on separate pool connections and the page can be told
      // the run is over before — or instead of — being told what it said.
      onText: async () => {
        turn.group?.onSpoke?.();
        await this.#event(conversationId, 'chat.message.appended', { role: 'assistant', runId, ...(room ? { agentId: agent.id } : {}) });
        // Told after the row landed, so a page that clears the live text on
        // settle finds the message already there when it refreshes.
        this.live.settle(conversationId, runId);
      },
      onDelta: (delta) => this.live.append(conversationId, runId, delta),
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
      async (signal) => runAgent({ ...options, ctx: { ...options.ctx, signal } }),
      () => {
        cancelled = true;
      },
      (err) => {
        failure = err;
      },
    );
    // However it ended, nothing stays half-written on anybody's screen.
    this.live.end(conversationId, runId);

    if (cancelled) {
      await this.#failed(
        conversationId,
        runId,
        'cancelled',
        'the turn was already sent, so whatever it wrote stays in the transcript',
      );
      return 'failed';
    }
    if (result === undefined) {
      // Out of budget is not a failure of the run: the room said what it could
      // and the coordinator was told to conclude. It ends the request honestly.
      if (failure instanceof BudgetExhausted) {
        // The ledger also answers "spent" while the request is paused or
        // stopped, so say which it was.
        const state = turn.group ? (await getGroupRequest(deps.pool, turn.group.request.id))?.state : undefined;
        const why = state === 'suspended'
          ? 'The group is waiting for your approval before it goes on.'
          : state === 'stopped'
            ? 'The request was stopped.'
            : 'The request budget is spent. The room stops here with what it has.';
        await this.#event(conversationId, 'chat.run.failed', { runId, stopped: state === 'suspended' ? 'awaiting-approval' : state === 'stopped' ? 'stopped' : 'budget', message: why });
        return 'ran';
      }
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
      return 'failed';
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

    // "This agent is holding a question." Recorded rather than kept in memory,
    // so the badge survives a reload and a restart — and cleared by the owner's
    // next message to this agent, or by the fifteen minutes a question lives.
    if (ask.asked) {
      const stored = await askQuestion(deps.pool, {
        agentId: agent.id,
        conversationId,
        question: ask.asked.question,
        options: ask.asked.options,
        allowOther: ask.asked.allowOther,
        now: deps.now(),
      }).catch((err) => {
        this.#log(`web chat: storing question failed: ${message(err)}`);
        return null;
      });
      await this.#event(conversationId, QUESTION_ASKED, {
        agentId: agent.id,
        runId,
        questionId: stored?.id ?? null,
      });
    }

    if (result.stopped === 'awaiting-approval' && result.pendingActionId) {
      // The run proposed a gated effect and stopped. Nothing is decided here:
      // the action exists, the page is told which one, and the decision goes
      // through the approval routes that already existed.
      const action = await getAction(deps.pool, result.pendingActionId).catch(() => null);
      await this.#event(conversationId, 'chat.awaiting-approval', {
        runId,
        actionId: result.pendingActionId,
        tool: action?.tool ?? null,
        ...(room ? { agentId: agent.id } : {}),
      });
      // A pending approval suspends the whole request; nothing else starts.
      if (turn.group) {
        await setGroupRequestState(deps.pool, turn.group.request.id, { state: 'suspended', from: ['running'], awaitingActionId: result.pendingActionId, awaitingAgentId: agent.id });
      }
      return 'suspended';
    }
    return 'ran';
  }

  /**
   * Everything a run inside a room needs, built from the group row and the
   * request row — trusted context, never something the model supplied.
   */
  #room(
    group: RoomTurn,
    agent: CatalogAgent,
    provider: RuntimeProvider,
  ): { provider: RuntimeProvider; context: GroupContext; transcript: NonNullable<RunAgentOptions['transcript']>; policy: string; askTool: ReturnType<typeof createGroupAskTool> | null } {
    const deps = this.#deps;
    const pool = deps.pool;
    const requestId = group.request.id;
    const context: GroupContext = {
      id: group.row.id,
      name: group.row.name,
      coordinator: group.row.coordinator,
      members: group.row.members,
      requestId,
    };
    const ledger = {
      reserve: () => reserveGroupCall(pool, requestId),
      release: () => releaseGroupCall(pool, requestId),
    };
    const handles = this.#handles();
    // Every call is made through a bounded projection: the room as this
    // agent may see it, clipped to what the group's cap allows.
    const cap = group.row.contextCapChars;
    const transcriptFor = (conversationId: string, agentId: string, openingSpeaker: string): NonNullable<RunAgentOptions['transcript']> => ({
      load: async () => boundProjection(projectTranscript({ turns: await readGroupTurns(pool, conversationId), agentId, handles }), cap),
      speaker: agentId,
      openingSpeaker,
      bound: (messages) => boundProjection(messages, cap),
    });
    const memberNames = group.row.members
      .map((id) => deps.catalog.get(id))
      .filter((a): a is CatalogAgent => Boolean(a))
      .map((a) => `@${a.handle} (${a.name})`)
      .join(', ');
    const remaining = Math.max(0, group.request.budgetTotal - 1 - group.request.budgetReserved);
    const summary = group.row.lastSummary && group.request.budgetReserved === 0 ? `\n\nWhere the previous thread of this group stopped:\n${group.row.lastSummary}` : '';
    const policy = group.role === 'coordinator'
      ? `You are the coordinator of the group "${group.row.name}". Members: ${memberNames}. The owner asked the group, and you answer for it. ` +
        `Bring a member in with ${GROUP_ASK_TOOL} only when it holds something you do not; each ask, and each of your own model calls, spends from a budget of ${group.request.budgetTotal} calls per request, ` +
        `of which about ${remaining} remain. When members have spoken, stop: a separate final call asks you to conclude, without tools, and there you credit each member by handle. ` +
        `If nobody needs asking, answer the owner yourself. Never claim a member said something it did not; what members said is in the room, attributed.` + summary
      : `You are a member of the group "${group.row.name}" (members: ${memberNames}; coordinator: @${deps.catalog.get(group.row.coordinator)?.handle ?? group.row.coordinator}). ` +
        `Answer for the room with what you find and stop; the coordinator brings the answer together. Do not address other members.` + summary;
    const askTool = group.role === 'coordinator' && !group.synthesis
      ? createGroupAskTool({
          catalog: () => ({ get: (id) => deps.catalog.get(id), byHandle: (h) => deps.catalog.byHandle(h) }),
          provider: (member) => budgetedProvider(deps.providerFor(member as CatalogAgent), ledger, { canSynthesise: false }),
          registry: deps.registry,
          transcript: async (conversationId, agentId) => transcriptFor(conversationId, agentId, group.row.coordinator),
          allowlistFor: (id) => deps.allowlistFor?.(id) ?? [],
          ...(deps.groupMemoryPreamble ? { memoryPreamble: () => deps.groupMemoryPreamble!(context.id) } : {}),
          onSuspended: async ({ agentId, actionId }) => {
            await setGroupRequestState(pool, requestId, { state: 'suspended', from: ['running'], awaitingActionId: actionId, awaitingAgentId: agentId });
            // The member paused inside the coordinator's tool call, so the
            // page is told here what `#run` would have told it.
            const action = await getAction(pool, actionId).catch(() => null);
            await this.#event(group.request.conversationId, 'chat.awaiting-approval', { runId: null, actionId, tool: action?.tool ?? null, agentId });
          },
          onMemberRun: async ({ agentId, result }) => {
            group.onContribution?.();
            await this.#event(group.request.conversationId, 'chat.message.appended', { role: 'assistant', agentId, runId: null, stopped: result.stopped });
          },
          pool,
        })
      : null;
    return {
      provider: budgetedProvider(provider, ledger, { canSynthesise: group.role === 'coordinator', ...(group.synthesis ? { forceSynthesis: true } : {}) }),
      context,
      transcript: transcriptFor(group.request.conversationId, agent.id, group.openingSpeaker),
      policy,
      askTool,
    };
  }

  /**
   * Abort cooperatively, then wait for the runtime to pair outstanding tool
   * calls with their results. A new message must not overtake those writes and
   * leave an invalid transcript. The cancel HTTP endpoint itself returns at
   * once; the run finishes when its cancelled work has settled.
   */
  async #cancellable<T>(
    conversationId: string,
    runId: string,
    work: (signal: AbortSignal) => Promise<T>,
    onCancel: () => void,
    onError: (err: unknown) => void,
  ): Promise<T | undefined> {
    const controller = new AbortController();
    this.#running.set(conversationId, { runId, cancel: () => {
      if (controller.signal.aborted) return;
      onCancel();
      controller.abort(new Error('The owner cancelled this run.'));
    } });
    try {
      return await work(controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) onError(err);
      return undefined;
    } finally {
      this.#running.delete(conversationId);
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
