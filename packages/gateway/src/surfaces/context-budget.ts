/**
 * What this conversation's transcript may grow to, and what it actually costs.
 *
 * Two questions the lifetime rule used to answer with one constant:
 *
 *  1. **How much room is there?** A property of the model the conversation's
 *    agent is bound to, not of this file: `core.agent_provider_accounts` says
 *    which model and which account, `core.provider_accounts` says whose it is
 *    and — in `context_window_tokens` — what the owner says it holds, which is
 *    the only truth available for a locally served model whose window is
 *    whatever `num_ctx` the host was started with. The override lives on the
 *    *account* because two OpenAI-compatible accounts are two endpoints: an 8k
 *    laptop model and a 256k hosted one can both be "openai-compatible", and
 *    one number for both would overflow the small one every time.
 *
 *    An agent with no binding is not unbudgeted: it runs on the installation's
 *    default account, so that account's model is what it is sized against. The
 *    legacy 80k constant is reached only when there is no model and no
 *    override to be had at all — an installation with no accounts yet, or a
 *    database that will not answer. It is the compatibility fallback, and
 *    **not** a floor under a known model: an owner who says 8,000 tokens means
 *    it, and raising that to 80,000 characters would put the history alone
 *    several times over the whole window.
 *
 *  2. **How much is it using?** Not the stored transcript — the *projected*
 *    one, in tokens. A browser session's page trees are reduced to a line each
 *    before they are sent (`compactObservations`), so a conversation whose
 *    stored rows are 300k characters may cost the model 10k tokens. Rolling it
 *    over on the stored number would throw away a live task to save room that
 *    was never being spent.
 *
 *    That projection costs a read of the whole transcript, and once a browser
 *    conversation is past the character precheck it would be paid on every
 *    turn for ever. So it is cached per conversation against the vitals that
 *    produced it: the same conversation, unchanged, is measured once.
 *
 * Total by construction: every failure here degrades to the old constant and
 * the stored count. A machine that cannot size a transcript must still answer.
 */
import type { Queryable } from '@buddi/core';
import {
  CHARS_PER_TOKEN,
  compactObservations,
  contextWindowTokens,
  estimateTokens,
  loadMessages,
  transcriptBudgetChars,
  transcriptTokenBudget,
  type ContextProvider,
} from '@buddi/runtime';
import { MAX_TRANSCRIPT_CHARS, type ConversationVitals } from './conversation-lifetime.js';

/** Which provider family an account's `kind` column names. */
function providerOf(kind: unknown): ContextProvider | undefined {
  return kind === 'anthropic' || kind === 'openai' || kind === 'openai-compatible' ? kind : undefined;
}

export interface TranscriptBudget {
  /** Tokens of projected transcript this conversation may carry. The rule. */
  maxTokens: number;
  /**
   * The same budget in characters of *prose*, for the dashboard's transcript
   * meter. Not a decision: a transcript of CJK reaches its token budget at a
   * third of this.
   */
  maxChars: number;
  /**
   * The cheap `sum(length(content))` gate: below this, no transcript can
   * possibly be over budget, because no character costs more than one token.
   * Above it, the projection is measured properly. Deliberately pessimistic —
   * a precheck that let a Japanese conversation through unmeasured is exactly
   * the bug the token estimate exists to close.
   */
  precheckChars: number;
  /** The model it was computed for, for the log line. Empty when unknown. */
  model: string;
  /** Zero when nothing was known and the compatibility fallback was used. */
  windowTokens: number;
  /** Where the model came from, for the log line. */
  source: 'binding' | 'installation-default' | 'fallback';
}

/**
 * The compatibility fallback: what every conversation had before a model had
 * anything to do with it. Reached only when nothing is known.
 *
 * A function, not a constant: this module and `conversation-lifetime` import
 * each other (the rule needs the budget; the budget needs the rule's floor),
 * and a constant computed while that cycle is still being evaluated reads the
 * floor before it exists.
 */
function fallbackBudget(): TranscriptBudget {
  return {
    maxTokens: Math.floor(MAX_TRANSCRIPT_CHARS / CHARS_PER_TOKEN),
    maxChars: MAX_TRANSCRIPT_CHARS,
    precheckChars: MAX_TRANSCRIPT_CHARS,
    model: '',
    windowTokens: 0,
    source: 'fallback',
  };
}

function budgetFor(row: Record<string, unknown>, source: TranscriptBudget['source']): TranscriptBudget {
  const model = typeof row.model === 'string' ? row.model : '';
  const raw = row.override;
  const override = raw === null || raw === undefined ? null : Number(raw);
  const windowTokens = contextWindowTokens(model, providerOf(row.kind), override);
  const maxTokens = transcriptTokenBudget(windowTokens);
  return {
    maxTokens,
    maxChars: transcriptBudgetChars(windowTokens),
    precheckChars: maxTokens,
    model,
    windowTokens,
    source,
  };
}

/**
 * The size limit for one conversation, from the model its agent will run on.
 */
export async function transcriptBudget(pool: Queryable, conversationId: string): Promise<TranscriptBudget> {
  const { rows } = await pool.query(
    `select b.model as model, a.kind as kind, a.context_window_tokens as override
       from core.conversations c
       join core.agent_provider_accounts b on b.agent_id = c.agent_id
       left join core.provider_accounts a on a.id = b.account_id
      where c.id = $1::uuid`,
    [conversationId],
  );
  const bound = rows[0];
  if (bound && typeof bound.model === 'string' && bound.model !== '') return budgetFor(bound, 'binding');

  // No binding: the run resolves this agent against the installation's default
  // account — the first enabled one, which is the order everything else reads
  // them in — so that is the window it will actually be given.
  const { rows: defaults } = await pool.query(
    `select default_model as model, kind, context_window_tokens as override
       from core.provider_accounts
      where enabled and not deleting
      order by created_at, id
      limit 1`,
  );
  const fallbackAccount = defaults[0];
  if (fallbackAccount && typeof fallbackAccount.model === 'string' && fallbackAccount.model !== '') {
    return budgetFor(fallbackAccount, 'installation-default');
  }
  return fallbackBudget();
}

/* ------------------------------------------------------------------ *
 * What it costs, measured once per version of the transcript
 * ------------------------------------------------------------------ */

/** The vitals, as a value that changes whenever anything is written. */
function signatureOf(vitals: ConversationVitals): string {
  return `${vitals.messages}:${vitals.chars}:${vitals.lastActivityAt?.getTime() ?? 0}`;
}

const measured = new Map<string, { signature: string; tokens: number }>();
/** Enough for any plausible number of live conversations; oldest goes first. */
const MEASURED_MAX = 256;

/** For tests: a fresh process is the only other way to clear this. */
export function forgetProjectedSizes(): void {
  measured.clear();
}

/**
 * What this conversation costs the model: the stored turns as they would be
 * sent, with spent observations already reduced to a line, estimated in
 * tokens.
 *
 * `vitals` is the cache key, not an input to the measurement: the same
 * conversation with nothing added to it is measured once, however many turns
 * are taken in it.
 */
export async function projectedTranscriptTokens(
  pool: Queryable,
  conversationId: string,
  vitals?: ConversationVitals,
): Promise<number> {
  const signature = vitals ? signatureOf(vitals) : null;
  if (signature !== null) {
    const hit = measured.get(conversationId);
    if (hit && hit.signature === signature) return hit.tokens;
  }
  const messages = compactObservations(await loadMessages(pool, conversationId));
  const tokens = messages.reduce((sum, message) => sum + estimateTokens(JSON.stringify(message.content)), 0);
  if (signature !== null) {
    // Insertion order is age order; drop the oldest rather than grow for ever.
    if (measured.size >= MEASURED_MAX) {
      const oldest = measured.keys().next();
      if (!oldest.done) measured.delete(oldest.value);
    }
    measured.delete(conversationId);
    measured.set(conversationId, { signature, tokens });
  }
  return tokens;
}
