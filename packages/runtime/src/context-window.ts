/**
 * How much a model can hold, and how much of that a transcript may have.
 *
 * The conversation lifetime used to end a chat at a flat 80,000 characters —
 * roughly 20k tokens — whatever model the agent was bound to. That number was
 * chosen against one runaway mail thread, and it is the right order of
 * magnitude for *text*. It is the wrong order of magnitude for a browser
 * session: one observation is a page tree plus a screenshot reference, several
 * thousand characters, so a dozen steps end the conversation and the agent
 * loses the task it was in the middle of. Meanwhile the model it is talking to
 * has a 200k or 1M token window standing idle.
 *
 * So the budget is a property of the bound model, and it is counted in
 * **tokens**, not characters, because characters are not a currency any model
 * accepts:
 *
 *  - `estimateTokens` is the hybrid. Every non-ASCII character counts as a
 *    whole token, because CJK, Cyrillic, Greek and emoji tokenise at or near
 *    one token per character and a 3.6× conversion would let a Japanese
 *    transcript claim three and a half times the room it has. Everything else
 *    counts at `CHARS_PER_TOKEN` (3.6), which is about right for English prose
 *    and still optimistic for dense JSON, URLs and identifiers — the residual
 *    error there is what the reserve below is for.
 *  - `TRANSCRIPT_WINDOW_SHARE` (0.5) is the share of the window the *history*
 *    may take. The rest pays for the system prompt, the memory preamble, the
 *    tool schemas (which are large), the turn's own new input, and the answer
 *    itself with its thinking budget — and for the fact that the estimate
 *    above is an estimate. A history allowed the whole window leaves no room
 *    to reply in, and one allowed 60% of it left too little slack for a
 *    transcript that tokenises worse than prose.
 *
 * The table is a fallback, not a source of truth: no provider serves a context
 * window over the wire in a shape worth depending on, and a wrong entry here
 * costs an early rollover, never a failed call. An unknown model gets 128k,
 * the smallest window any model we bind still has, so a model this table has
 * never heard of is never given more room than it can hold.
 */

/** ASCII characters per token, assumed. Low on purpose: see the note above. */
export const CHARS_PER_TOKEN = 3.6;

/** The share of a model's window the stored transcript may occupy. */
export const TRANSCRIPT_WINDOW_SHARE = 0.5;

/** What a model this table does not know is assumed to hold. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;

/** Nobody's window is plausibly outside this. Guards an owner override. */
export const MIN_CONTEXT_WINDOW_TOKENS = 8_000;
export const MAX_CONTEXT_WINDOW_TOKENS = 2_000_000;

/** Which family of hosts a model name belongs to, when the caller knows. */
export type ContextProvider = 'anthropic' | 'openai' | 'openai-compatible' | 'ollama';

/**
 * Prefix, window. Order matters: the first prefix that matches wins, so a
 * longer, more specific prefix is listed before the family it belongs to.
 */
type Entry = readonly [prefix: string, tokens: number];

const ANTHROPIC: readonly Entry[] = [
  // Claude 5 family: Fable 5.1, Opus 5.5 and Sonnet 5 hold a million tokens; Opus 5 did not.
  ['claude-fable-5', 1_000_000],
  ['claude-mythos-5', 1_000_000],
  ['claude-opus-5-5', 1_000_000],
  ['claude-opus-5', 200_000],
  ['claude-sonnet-5', 1_000_000],
  ['claude-haiku-5', 200_000],
  // Claude 4.x.
  ['claude-opus-4', 200_000],
  ['claude-sonnet-4', 200_000],
  ['claude-haiku-4', 200_000],
  // 3.x, still bindable.
  ['claude-3-7-sonnet', 200_000],
  ['claude-3-5-haiku', 200_000],
  ['claude-3-5-sonnet', 200_000],
  ['claude-3-opus', 200_000],
  ['claude-3-haiku', 200_000],
  ['claude-', 200_000],
];

const OPENAI: readonly Entry[] = [
  ['gpt-5', 400_000],
  ['gpt-4.1', 1_000_000],
  ['gpt-4o', 128_000],
  ['o4-mini', 200_000],
  ['o3-mini', 200_000],
  ['o3', 200_000],
  ['o1', 200_000],
];

/**
 * Local models, by name prefix as Ollama tags them. These are the *served*
 * windows people actually run, not the architectural maximum: a host serves
 * far less than the paper says unless it was started otherwise, and claiming
 * the paper number here would let a transcript grow past what the host will
 * accept.
 */
const OLLAMA: readonly Entry[] = [
  ['llama3.3', 128_000],
  ['llama3.2', 128_000],
  ['llama3.1', 128_000],
  ['llama3', 8_000],
  ['qwen3', 32_000],
  ['qwen2.5', 32_000],
  ['deepseek-r1', 64_000],
  ['gemma3', 128_000],
  ['gemma2', 8_000],
  ['mistral-nemo', 128_000],
  ['mistral', 32_000],
  ['mixtral', 32_000],
  ['phi4', 16_000],
  ['phi3', 128_000],
];

/**
 * A model id, reduced to something the table can be asked about: lowercased,
 * with the routing prefixes hosts add (`us.anthropic.`, `anthropic/`, an
 * Ollama `:tag`) taken off, and Anthropic's dated suffix left in place because
 * the prefixes above stop short of it anyway.
 */
function normalise(model: string): string {
  let name = model.trim().toLowerCase();
  for (let i = 0; i < 3; i += 1) {
    const host = /^(us|eu|apac|anthropic|openai|openrouter|bedrock|vertex)[./]/.exec(name);
    if (!host) break;
    name = name.slice(host[0].length);
  }
  return name;
}

/**
 * Anthropic's long-context variants say so in the id: `claude-sonnet-4-5[1m]`
 * from this CLI, `-1m` or `:1m` elsewhere. They are the same model with a
 * bigger window, so the suffix is read before the family table.
 */
function longContextSuffix(model: string): boolean {
  return /(\[1m\]|[-:]1m\b)/.test(model);
}

/**
 * The context window of the model an agent is bound to, in tokens.
 *
 * Never throws and never returns zero: an unknown model, an empty name or an
 * out-of-range override all fall back to `DEFAULT_CONTEXT_WINDOW_TOKENS`. The
 * caller is deciding how long a transcript may get, and that decision must be
 * available even when nothing about the model is known.
 *
 * `override` is the owner's, per provider (`core.provider_settings`): someone
 * running a local host with a deliberately small or large `num_ctx` knows
 * better than this table ever will.
 */
export function contextWindowTokens(
  model: string,
  provider?: ContextProvider | undefined,
  override?: number | null | undefined,
): number {
  if (typeof override === 'number' && Number.isFinite(override)) {
    const rounded = Math.floor(override);
    if (rounded >= MIN_CONTEXT_WINDOW_TOKENS && rounded <= MAX_CONTEXT_WINDOW_TOKENS) return rounded;
  }
  const name = normalise(model ?? '');
  if (name === '') return DEFAULT_CONTEXT_WINDOW_TOKENS;
  if (longContextSuffix(name) && name.startsWith('claude-')) return 1_000_000;

  const tables: readonly (readonly Entry[])[] =
    provider === 'anthropic' ? [ANTHROPIC]
    : provider === 'openai' ? [OPENAI]
    : provider === 'ollama' || provider === 'openai-compatible' ? [OLLAMA, OPENAI, ANTHROPIC]
    // Unknown host: the name itself says whose it is, in every case we bind.
    : [ANTHROPIC, OPENAI, OLLAMA];

  for (const table of tables) {
    for (const [prefix, tokens] of table) {
      if (name.startsWith(prefix)) return tokens;
    }
  }
  return DEFAULT_CONTEXT_WINDOW_TOKENS;
}

/**
 * What a piece of transcript costs, in tokens.
 *
 * Hybrid and deliberately pessimistic where it is cheap to be: a non-ASCII
 * character is one token, an ASCII one is `1 / CHARS_PER_TOKEN`. A surrogate
 * pair (an emoji) counts as two, which is also what most tokenisers charge.
 *
 * This is an estimate, not a count. Nothing here calls a provider: the number
 * is wanted before a request exists, on every turn, for a decision whose cost
 * of being slightly wrong is one early rollover. `TRANSCRIPT_WINDOW_SHARE`
 * carries the error.
 */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let wide = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 127) wide += 1; else ascii += 1;
  }
  return Math.ceil(wide + ascii / CHARS_PER_TOKEN);
}

/**
 * The tokens of transcript a window affords: the conversation lifetime's real
 * size limit.
 */
export function transcriptTokenBudget(windowTokens: number): number {
  const tokens = Number.isFinite(windowTokens) && windowTokens > 0 ? windowTokens : DEFAULT_CONTEXT_WINDOW_TOKENS;
  return Math.floor(tokens * TRANSCRIPT_WINDOW_SHARE);
}

/**
 * The same budget expressed in characters, for the two places that can only
 * speak in characters: the cheap `sum(length(content))` precheck, and the
 * dashboard's transcript meter. Prose, at `CHARS_PER_TOKEN` — a transcript
 * that is mostly CJK will reach its token budget long before this many
 * characters, which is why the token budget is what actually decides.
 */
export function transcriptBudgetChars(windowTokens: number): number {
  return Math.floor(transcriptTokenBudget(windowTokens) * CHARS_PER_TOKEN);
}

/** The two steps together: model in, tokens of transcript out. */
export function transcriptTokensForModel(
  model: string,
  provider?: ContextProvider | undefined,
  override?: number | null | undefined,
): number {
  return transcriptTokenBudget(contextWindowTokens(model, provider, override));
}
