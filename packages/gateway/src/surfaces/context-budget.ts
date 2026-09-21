/**
 * What this conversation's transcript may grow to, and what it actually costs.
 *
 * Two questions the lifetime rule used to answer with one constant:
 *
 *  1. **How much room is there?** A property of the model the conversation's
 *    agent is bound to, not of this file: `core.agent_provider_accounts` says
 *    which model, `core.provider_accounts` says whose it is, and the runtime's
 *    table turns that into a window (`contextWindowTokens`). The owner may
 *    override the window per provider in `core.provider_settings`, which is
 *    where someone running a local host with a deliberately small `num_ctx`
 *    can say so. `MAX_TRANSCRIPT_CHARS` survives as the *floor*: a model this
 *    build has never heard of is still allowed the 80k it always had.
 *
 *  2. **How much is it using?** Not the stored transcript — the *projected*
 *    one. A browser session's page trees are reduced to a line each before
 *    they are sent (`compactObservations`), so a conversation whose stored
 *    rows are 300k characters may cost the model 40k. Rolling it over on the
 *    stored number would throw away a live task to save room that was never
 *    being spent. The stored count is still read first, because it is one
 *    cheap aggregate and it is what decides whether this second, heavier
 *    question is worth asking at all.
 *
 * Total by construction: every failure here degrades to the old constant and
 * the stored count. A machine that cannot size a transcript must still answer.
 */
import type { Queryable } from '@buddi/core';
import {
  compactObservations,
  contextWindowTokens,
  loadMessages,
  transcriptBudgetChars,
  type ContextProvider,
} from '@buddi/runtime';
import { MAX_TRANSCRIPT_CHARS } from './conversation-lifetime.js';

/** Which provider family an account's `kind` column names. */
function providerOf(kind: unknown): ContextProvider | undefined {
  return kind === 'anthropic' || kind === 'openai' || kind === 'openai-compatible' ? kind : undefined;
}

export interface TranscriptBudget {
  /** Characters of transcript this conversation may carry into a new turn. */
  maxChars: number;
  /** The model it was computed for, for the log line. */
  model: string;
  windowTokens: number;
}

/**
 * The size limit for one conversation, from the model its agent is bound to.
 *
 * An agent with no account binding (the environment's default model) and any
 * database trouble both land on the floor, which is exactly the behaviour
 * every conversation had before this existed.
 */
export async function transcriptBudget(pool: Queryable, conversationId: string): Promise<TranscriptBudget> {
  const floor: TranscriptBudget = { maxChars: MAX_TRANSCRIPT_CHARS, model: '', windowTokens: 0 };
  const { rows } = await pool.query(
    `select b.model as model, a.kind as kind, s.context_window_tokens as override
       from core.conversations c
       join core.agent_provider_accounts b on b.agent_id = c.agent_id
       left join core.provider_accounts a on a.id = b.account_id
       left join core.provider_settings s
         on s.provider = (case when a.kind = 'openai-compatible' then 'openai' else a.kind end)
      where c.id = $1::uuid`,
    [conversationId],
  );
  const row = rows[0];
  if (!row || typeof row.model !== 'string') return floor;
  const override = row.override === null || row.override === undefined ? null : Number(row.override);
  const windowTokens = contextWindowTokens(row.model, providerOf(row.kind), override);
  return {
    maxChars: Math.max(MAX_TRANSCRIPT_CHARS, transcriptBudgetChars(windowTokens)),
    model: row.model,
    windowTokens,
  };
}

/**
 * What this conversation costs the model: the stored turns as they would be
 * sent, with spent observations already reduced to a line.
 *
 * Measured the way `readVitals` measures the stored transcript — the JSON
 * length of each turn's content — so the two numbers mean the same thing and
 * can be compared against the same limit.
 */
export async function projectedTranscriptChars(pool: Queryable, conversationId: string): Promise<number> {
  const messages = compactObservations(await loadMessages(pool, conversationId));
  return messages.reduce((sum, message) => sum + JSON.stringify(message.content).length, 0);
}
