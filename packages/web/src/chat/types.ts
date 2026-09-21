/**
 * The chat API's shapes, exactly as `packages/gateway/src/web/chat.ts` returns
 * them. Written down here so a change on either side is a type error rather
 * than an empty panel.
 */

/** Why an agent is listed but cannot run: a plugin it was granted is absent. */
export interface AgentHoldBack {
  reason: 'missing-plugin';
  /** The tool families nothing here provides, in declaration order. */
  families: string[];
  /** One sentence, the server's own words, printed verbatim. */
  message: string;
}

export interface ChatAgent {
  id: string;
  handle: string;
  name: string;
  description: string;
  available: boolean;
  unavailableReason?: string;
  /**
   * Set when a tool family the agent was granted comes from a plugin this
   * installation does not have. Greyed exactly like an agent with no account;
   * the door it links to is Settings → Plugins rather than Model accounts.
   */
  heldBack?: AgentHoldBack;
  roles: string[];
  provider: string;
  model: string;
  /**
   * Which end of the rail this agent is pinned to, or null for the ordinary
   * colleagues in between. The server resolves it from roles, so the page
   * anchors the front desk and the maker without learning either one's name.
   */
  anchor?: 'top' | 'bottom' | null;
  /**
   * The agent's own opening, from its file: one sentence about what it does,
   * and up to three example requests. A starter may carry `{{default}}`,
   * which the page resolves to the default agent's name.
   */
  intro?: string;
  starters?: string[];
  /** Reasoning before the answer: on, off, or null for the model's default. */
  thinking?: 'on' | 'off' | null;
  /** The face to draw, when the agent file names one. */
  avatar?: { kind: 'emoji'; value: string } | { kind: 'image'; url: string };
  /** `#rrggbb`, the agent's own colour. */
  accent?: string;
}

export interface AgentsResponse {
  agents: ChatAgent[];
  defaultAgentId: string;
}

export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; name: string; ok: boolean; output: unknown; error?: unknown; approval?: { id: string; state: string } }
  | { type: 'attachment'; artifactId: string; filename: string | null; mime: string; kind: string; sizeBytes: number | null }
  | { type: 'thinking'; text: string }
  /** A gated action the owner decided, come back into the thread as its result. */
  | { type: 'approval_result'; actionId: string; name: string; state: string; output: unknown };

export interface ChatMessage {
  id: string;
  role: string;
  at: string;
  blocks: ChatBlock[];
  /**
   * Who spoke, in a group: 'owner', an agent id, or 'room' — and
   * 'approval:resume' on the turn that carries a decided action's result,
   * which is nobody speaking at all.
   */
  speaker?: string;
}

/**
 * How the server stamps a turn the owner started by taking an offer:
 * `offer:<label>`. The message itself carries the prompt the agent wrote — the
 * words the model was given — and the label is what the owner clicked.
 */
export const OFFER_TURN_SPEAKER_PREFIX = 'offer:';

/** The chip's label behind such a stamp, or null for an ordinary turn. */
export function offerTurnLabel(speaker: string | null | undefined): string | null {
  if (typeof speaker !== 'string' || !speaker.startsWith(OFFER_TURN_SPEAKER_PREFIX)) return null;
  const label = speaker.slice(OFFER_TURN_SPEAKER_PREFIX.length).trim();
  return label === '' ? null : label;
}

/** A group of agents that share one conversation (docs/groups.md). */
export interface GroupView {
  id: string;
  name: string;
  coordinator: string;
  members: string[];
  contextCapChars: number;
  createdAt: string;
}

/**
 * One action the last turn offered: a label to click and the sentence it will
 * ask. The same `core.offers` row Telegram draws as a button.
 */
export interface ChatOffer {
  id: string;
  label: string;
  prompt: string;
  expiresAt: string;
}

export interface ChatQuestionOption {
  id: string;
  label: string;
  hint: string | null;
  recommended: boolean;
}

export interface ChatQuestion {
  id: string;
  question: string;
  options: ChatQuestionOption[];
  allowOther: boolean;
  expiresAt: string;
}

/**
 * What would end this conversation, and how close it is — sent with the
 * transcript so the header can say "fresh" or "about to roll over" without the
 * page hard-coding limits the server owns.
 */
export interface ChatLifetime {
  messages: number;
  lastActivityAt: string | null;
  chars: number;
  idleTimeoutMs: number;
  maxChars: number;
}

export interface ChatConversation {
  conversationId: string;
  agentId: string;
  /** Set when this conversation belongs to a group. */
  groupId?: string;
  /** When the conversation row was created. */
  startedAt?: string;
  lifetime?: ChatLifetime;
  messages: ChatMessage[];
  /** Still on the table in this conversation. Usually empty. */
  offers?: ChatOffer[];
  /** A durable input request. It supplies information and never grants permission. */
  question?: ChatQuestion | null;
  /**
   * What a browser session in the *previous* conversation learned — the task,
   * the pages it visited and the agent's last words — written into this one
   * when the rollover created it. Drawn as a grey note above the transcript,
   * never as a bubble: nobody in this conversation said it.
   */
  carriedOver?: string;
  /**
   * Every run this conversation has had, open ones included: a run with no
   * `finishedAt` is still going. What the server already sends
   * (`packages/gateway/src/web/chat.ts`), written down here because first run
   * reads it to tell "slow" from "never".
   */
  runs?: ChatRun[];
}

/** One run of the agent in this conversation. */
export interface ChatRun {
  runId: string | null;
  surface: string | null;
  startedAt: string | null;
  /** Null while the run is alive. */
  finishedAt: string | null;
  turns: number | null;
  stopped: string | null;
  usage: { input: number; output: number };
  actionId: string | null;
  resumed: boolean;
}

export interface ConversationListItem {
  id: string;
  agentId?: string;
  createdAt?: string;
  startedAt?: string | null;
  lastMessageAt: string | null;
  opening?: string | null;
  preview?: string;
  messageCount: number;
}

export interface UploadedAttachment {
  artifactId: string;
  filename: string;
  mime: string;
  kind: string;
  sizeBytes: number;
}

/** The SSE event names the run stream emits. */
export type ChatEventName =
  | 'run.started'
  | 'tool.called'
  | 'tool.result'
  | 'message.appended'
  | 'awaiting-approval'
  | 'run.finished'
  // The answer as it is written: a piece, a turn settling into the
  // transcript, or what was written before this page connected.
  | 'live'
  | 'live.settle'
  | 'live.snapshot'
  // The attention stream's only frame: "some agent's claim on you may have
  // changed, ask again". It carries no payload on purpose.
  | 'attention'
  | 'ping';

export interface ChatEvent {
  /** The stream id, echoed back as `Last-Event-ID` on a reconnect. */
  id: string | null;
  name: ChatEventName;
  data: Record<string, unknown>;
}
