export const QUESTION_TTL_MS = 30 * 60_000;
export const MAX_QUESTION_OPTIONS = 6;
export const MAX_QUESTION_LABEL = 48;

export interface QuestionOption {
  id: string;
  label: string;
  hint: string | null;
  recommended: boolean;
}

export interface Question {
  id: string;
  agentId: string;
  conversationId: string;
  question: string;
  options: QuestionOption[];
  allowOther: boolean;
  createdAt: string;
  expiresAt: string;
  answeredAt: string | null;
  answeredVia: string | null;
  answer: string | null;
}

export const QUESTION_COLUMNS =
  'id, agent_id, conversation_id, question, options, allow_other, created_at, expires_at, answered_at, answered_via, answer';

const iso = (value: unknown): string | null =>
  value == null ? null : value instanceof Date ? value.toISOString() : String(value);

export function toQuestion(row: Record<string, any>): Question {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    conversationId: String(row.conversation_id),
    question: String(row.question),
    options: Array.isArray(row.options) ? row.options : [],
    allowOther: row.allow_other !== false,
    createdAt: iso(row.created_at) ?? '',
    expiresAt: iso(row.expires_at) ?? '',
    answeredAt: iso(row.answered_at),
    answeredVia: row.answered_via ?? null,
    answer: row.answer ?? null,
  };
}

/**
 * The notification key a question carries when it is sent as a notification
 * (a mission's browser moment, docs/browser.md "Missions"): a channel that
 * draws buttons reads the question back from it and draws its options.
 */
export function questionKey(questionId: string): string {
  return `question:${questionId}`;
}

/** The question a notification key names, or undefined. */
export function questionIdOfKey(key: string | null | undefined): string | undefined {
  if (!key?.startsWith('question:')) return undefined;
  const id = key.slice('question:'.length).trim();
  return id === '' ? undefined : id;
}
