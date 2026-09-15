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
}

export interface AgentsResponse {
  agents: ChatAgent[];
  defaultAgentId: string;
}

export type ChatBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; name: string; ok: boolean; output: unknown; error?: unknown }
  | { type: 'attachment'; artifactId: string; filename: string; mime: string; kind: string };

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

export interface ChatConversation {
  conversationId: string;
  agentId: string;
  messages: ChatMessage[];
  /** Still on the table in this conversation. Usually empty. */
  offers?: ChatOffer[];
}

export interface ConversationListItem {
  id: string;
  agentId: string;
  createdAt: string;
  lastMessageAt: string | null;
  opening: string | null;
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
  | 'ping';

export interface ChatEvent {
  /** The stream id, echoed back as `Last-Event-ID` on a reconnect. */
  id: string | null;
  name: ChatEventName;
  data: Record<string, unknown>;
}
