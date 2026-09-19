/**
 * The chat API's shapes, exactly as `packages/gateway/src/web/chat.ts` returns
 * them. Written down here so a change on either side is a type error rather
 * than an empty panel.
 */

export interface ChatAgent {
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
   * Which end of the rail this agent is pinned to, or null for the ordinary
   * colleagues in between. The server resolves it from roles, so the page
   * anchors the front desk and the maker without learning either one's name.
   */
  anchor?: 'top' | 'bottom' | null;
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
  | { type: 'thinking'; text: string };

export interface ChatMessage {
  id: string;
  role: string;
  at: string;
  blocks: ChatBlock[];
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
  /** When the conversation row was created. */
  startedAt?: string;
  lifetime?: ChatLifetime;
  messages: ChatMessage[];
  /** Still on the table in this conversation. Usually empty. */
  offers?: ChatOffer[];
  /** A durable input request. It supplies information and never grants permission. */
  question?: ChatQuestion | null;
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
