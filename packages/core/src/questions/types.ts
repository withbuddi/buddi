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
  /**
   * What the card asks for beyond a question with choices: today only an
   * agent's `secret.request` (docs/owner-secrets.md §6) — the site and the
   * labels of the fields it saw, never a value. Null for a plain question.
   */
  request?: QuestionRequest | null;
}

/** One field a `secret.request` card asks the owner to type. A label, never a value. */
export interface SecretRequestField {
  label: string;
  kind: 'username' | 'password' | 'totp' | 'other';
  /** The page's field the agent saw it in, so Save and fill can fill it at once. */
  ref?: string;
  /** Set when the label looks like a card number, a CVV, an SSN or a one-time code: shown, and never filled by itself. */
  warning?: string;
}

/** The card a `secret.request` raises. */
export interface SecretRequestCard {
  kind: 'secret.request';
  /** The site as the owner reads it on the chip: `wikipedia.org`. */
  site: string;
  /** Where the values may go: exact origins and wildcard origins (`https://*.wikipedia.org`). */
  origins: string[];
  /** The page the agent had open when it asked, when it had one. */
  page?: { url: string; title?: string };
  fields: SecretRequestField[];
  reason?: string;
  /** The agent's name, as the card says it ("Scout never sees them"). */
  agentName?: string;
  /** One line per warned field, as the card prints it. */
  warnings?: string[];
  /**
   * Raised by the browser at a login wall rather than by the agent: its other
   * choices that still apply ("Use my Chrome"), drawn as secondary actions and
   * answered like any question option.
   */
  choices?: string[];
  /** The browser's own card stays (a code page): this card opens in place from its "Save a login for next time". */
  expand?: boolean;
}

export type QuestionRequest = SecretRequestCard;

export const QUESTION_COLUMNS =
  'id, agent_id, conversation_id, question, options, allow_other, created_at, expires_at, answered_at, answered_via, answer, request';

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
    request: row.request && typeof row.request === 'object' && !Array.isArray(row.request) ? (row.request as QuestionRequest) : null,
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
