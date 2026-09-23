import type { Queryable } from '../owner.js';
import {
  MAX_QUESTION_LABEL,
  MAX_QUESTION_OPTIONS,
  QUESTION_COLUMNS,
  QUESTION_TTL_MS,
  toQuestion,
  type Question,
  type QuestionOption,
} from './types.js';

export interface AskQuestionInput {
  agentId: string;
  conversationId: string;
  question: string;
  options: Array<Omit<QuestionOption, 'id'> & { id?: string }>;
  allowOther: boolean;
  now: Date;
}

function normalizeOptions(input: AskQuestionInput['options']): QuestionOption[] {
  const seen = new Set<string>();
  const out: QuestionOption[] = [];
  for (const [index, option] of input.entries()) {
    const label = option.label.trim().replace(/\s+/g, ' ').slice(0, MAX_QUESTION_LABEL);
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push({
      id: option.id?.trim() || `option-${index + 1}`,
      label,
      hint: option.hint?.trim() || null,
      recommended: option.recommended === true,
    });
    if (out.length >= MAX_QUESTION_OPTIONS) break;
  }
  if (out.filter((option) => option.recommended).length > 1) {
    let found = false;
    return out.map((option) => {
      if (!option.recommended || found) return { ...option, recommended: false };
      found = true;
      return option;
    });
  }
  return out;
}

export async function askQuestion(pool: Queryable, input: AskQuestionInput): Promise<Question> {
  const options = normalizeOptions(input.options);
  const expiresAt = new Date(input.now.getTime() + QUESTION_TTL_MS);
  await pool.query(
    `update core.questions
        set expires_at = $2, answered_at = $2, answered_via = 'replaced'
      where conversation_id = $1 and answered_at is null`,
    [input.conversationId, input.now],
  );
  const { rows } = await pool.query(
    `insert into core.questions
       (agent_id, conversation_id, question, options, allow_other, created_at, expires_at)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7)
     returning ${QUESTION_COLUMNS}`,
    [input.agentId, input.conversationId, input.question.trim(), JSON.stringify(options), input.allowOther, input.now, expiresAt],
  );
  return toQuestion(rows[0]);
}

export async function openQuestion(
  pool: Queryable,
  input: { conversationId: string; now: Date },
): Promise<Question | null> {
  const { rows } = await pool.query(
    `select ${QUESTION_COLUMNS} from core.questions
      where conversation_id = $1 and answered_at is null and expires_at > $2
      order by created_at desc limit 1`,
    [input.conversationId, input.now],
  );
  return rows[0] ? toQuestion(rows[0]) : null;
}

export async function getQuestion(pool: Queryable, id: string): Promise<Question | null> {
  const { rows } = await pool.query(`select ${QUESTION_COLUMNS} from core.questions where id = $1`, [id]);
  return rows[0] ? toQuestion(rows[0]) : null;
}

/**
 * What the agent reads when the owner skips a question instead of answering
 * it. Plain words, because it travels as the owner's next message: the agent
 * must go on without the answer, not ask again.
 */
export const SKIPPED_ANSWER = 'Skipped. Go on without an answer and use your own judgement.';

export async function answerQuestion(
  pool: Queryable,
  input: { id: string; answer: string; optionId?: string; skipped?: boolean; via: string; now: Date },
): Promise<{ ok: true; question: Question } | { ok: false; reason: 'unknown' | 'closed' | 'expired' | 'invalid-option' }> {
  // A skip is neither an option nor free text, so it is checked against
  // neither — it is always allowed while the question is open.
  const answer = input.skipped ? SKIPPED_ANSWER : input.answer.trim();
  const { rows: found } = await pool.query(`select ${QUESTION_COLUMNS} from core.questions where id = $1`, [input.id]);
  if (!found[0]) return { ok: false, reason: 'unknown' };
  const current = toQuestion(found[0]);
  if (current.answeredAt) return { ok: false, reason: 'closed' };
  if (Date.parse(current.expiresAt) <= input.now.getTime()) return { ok: false, reason: 'expired' };
  if (!input.skipped) {
    if (input.optionId && !current.options.some((option) => option.id === input.optionId && option.label === answer)) {
      return { ok: false, reason: 'invalid-option' };
    }
    if (!input.optionId && !current.allowOther) return { ok: false, reason: 'invalid-option' };
  }
  const { rows } = await pool.query(
    `update core.questions set answered_at = $2, answered_via = $3, answer = $4
      where id = $1 and answered_at is null and expires_at > $2
      returning ${QUESTION_COLUMNS}`,
    [input.id, input.now, input.via, answer],
  );
  return rows[0] ? { ok: true, question: toQuestion(rows[0]) } : { ok: false, reason: 'closed' };
}
