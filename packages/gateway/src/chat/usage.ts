/**
 * What this session cost, as far as anything local can honestly say.
 *
 * Prices are published per model and change; nothing here pretends otherwise.
 * The table is a *local estimate*, matched by prefix so a dated snapshot
 * (`claude-opus-4-8-something`) picks up its family's rate, and a model with
 * no entry reports its tokens and says the cost is unknown rather than
 * inventing a number the owner might act on.
 */
import type { Usage } from '@buddi/runtime';

/**
 * Dollars per million tokens, by model-id prefix. Longest prefix wins.
 *
 * Anthropic rows are the first-party API rates as published on 2026-06-24;
 * they move, and a partner endpoint (Bedrock, Vertex) bills its own. Anything
 * not listed here is reported as tokens with the cost left unknown.
 */
export const PRICES: readonly {
  prefix: string;
  input: number;
  output: number;
  /**
   * Cached-input rate, where the provider publishes one that is not the 0.1x
   * default. OpenAI's older families discount less (gpt-4.1 0.25x, gpt-4o 0.5x).
   */
  cacheRead?: number;
}[] = [
  { prefix: 'claude-fable-5', input: 10, output: 50 },
  { prefix: 'claude-mythos-5', input: 10, output: 50 },
  { prefix: 'claude-opus-5-5', input: 4, output: 20 },
  { prefix: 'claude-opus-5', input: 5, output: 25 },
  { prefix: 'claude-opus-4-8', input: 5, output: 25 },
  { prefix: 'claude-opus-4-7', input: 5, output: 25 },
  { prefix: 'claude-opus-4-6', input: 5, output: 25 },
  { prefix: 'claude-sonnet-5', input: 2, output: 10 },
  { prefix: 'claude-sonnet-4-6', input: 3, output: 15 },
  { prefix: 'claude-haiku-4-5', input: 1, output: 5 },
  { prefix: 'gpt-5-mini', input: 0.25, output: 2, cacheRead: 0.025 },
  { prefix: 'gpt-5', input: 1.25, output: 10, cacheRead: 0.125 },
  { prefix: 'gpt-4.1-mini', input: 0.4, output: 1.6, cacheRead: 0.1 },
  { prefix: 'gpt-4.1', input: 2, output: 8, cacheRead: 0.5 },
  { prefix: 'gpt-4o-mini', input: 0.15, output: 0.6, cacheRead: 0.075 },
  { prefix: 'gpt-4o', input: 2.5, output: 10, cacheRead: 1.25 },
  // Gemini: Google's paid-tier rates from ai.google.dev/gemini-api/docs/pricing
  // (page dated 2026-09-24). Pro rows are the prompts-up-to-200k rate; longer
  // prompts bill higher and are under-counted here. 3.6–3.8 Flash are at an
  // introductory rate that doubles on 2027-01-01.
  { prefix: 'gemini-3.1-pro', input: 2, output: 12, cacheRead: 0.2 },
  { prefix: 'gemini-2.5-pro', input: 1.25, output: 10, cacheRead: 0.125 },
  { prefix: 'gemini-3.8-flash', input: 0.75, output: 3.75, cacheRead: 0.075 },
  { prefix: 'gemini-3.7-flash', input: 0.75, output: 3.75, cacheRead: 0.075 },
  { prefix: 'gemini-3.6-flash', input: 0.75, output: 3.75, cacheRead: 0.075 },
  { prefix: 'gemini-3.5-flash-lite', input: 0.3, output: 2.5, cacheRead: 0.03 },
  { prefix: 'gemini-3.5-flash', input: 1.5, output: 9, cacheRead: 0.15 },
  { prefix: 'gemini-3.1-flash-lite', input: 0.25, output: 1.5, cacheRead: 0.025 },
  { prefix: 'gemini-2.5-flash-lite', input: 0.1, output: 0.4, cacheRead: 0.01 },
  { prefix: 'gemini-2.5-flash', input: 0.3, output: 2.5, cacheRead: 0.03 },
];

/** Cache reads cost a tenth of input unless the row says otherwise (Anthropic and gpt-5 both do). */
export const CACHE_READ_MULTIPLIER = 0.1;
/** Anthropic's 5-minute cache write costs a quarter more than plain input. Only Anthropic reports writes. */
export const CACHE_WRITE_MULTIPLIER = 1.25;

/** Estimated dollars for one model's tokens, or nothing when unpriced. */
export function estimateCost(model: string, usage: Usage): number | undefined {
  // Google's listing may name a model `models/gemini-…`; the price is the bare id's.
  const id = model.toLowerCase().replace(/^models\//, '');
  const matches = PRICES.filter((p) => id.startsWith(p.prefix)).sort(
    (a, b) => b.prefix.length - a.prefix.length,
  );
  const price = matches[0];
  if (!price) return undefined;
  const cacheRead = price.cacheRead ?? price.input * CACHE_READ_MULTIPLIER;
  const cacheWrite = price.input * CACHE_WRITE_MULTIPLIER;
  return (
    (usage.input * price.input +
      (usage.cacheRead ?? 0) * cacheRead +
      (usage.cacheWrite ?? 0) * cacheWrite +
      usage.output * price.output) /
    1_000_000
  );
}

/** `$0.0143`, or `$0.00` for something that rounds away. Never rounded to 0 tokens. */
export function formatCost(dollars: number): string {
  if (dollars >= 1) return `$${dollars.toFixed(2)}`;
  if (dollars >= 0.01) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(4)}`;
}

/** `3 web searches` — the provider's own, which no token count includes. */
export function formatWebSearches(count: number): string {
  return `${formatTokens(count)} web search${count === 1 ? '' : 'es'}`;
}

/**
 * `in 1,204 (cached 9,800) / out 318`. The cache parts appear only when they
 * moved; `input` never includes them (see `Usage.input`).
 */
export function formatInOut(usage: Pick<Usage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>): string {
  const parts = [
    ...(usage.cacheRead ? [`cached ${formatTokens(usage.cacheRead)}`] : []),
    ...(usage.cacheWrite ? [`cache write ${formatTokens(usage.cacheWrite)}`] : []),
  ];
  return `in ${formatTokens(usage.input)}${parts.length ? ` (${parts.join(', ')})` : ''} / out ${formatTokens(usage.output)}`;
}

/** Thousands separators, because six-digit token counts are unreadable without. */
export function formatTokens(count: number): string {
  return count.toLocaleString('en-US');
}

/** One model's running totals for this session. */
export interface ModelUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  runs: number;
  /**
   * Searches the provider ran on its own servers for this model.
   *
   * Counted beside the tokens and priced with neither, because it is a
   * different meter: under a subscription it comes out of the plan, and on an
   * API key it is billed per thousand requests, at a rate this table does not
   * carry. Reporting the count and declining to guess the cost is the same
   * honesty the unpriced-model row already practises.
   */
  webSearches: number;
}

/**
 * Per-model token totals. Per model rather than one grand total because a
 * session that talked to two agents on two providers has two prices, and one
 * number over both of them would be a fiction.
 */
export class UsageLedger {
  readonly #byModel = new Map<string, ModelUsage>();
  #turns = 0;
  #tools = 0;

  get turns(): number {
    return this.#turns;
  }

  get tools(): number {
    return this.#tools;
  }

  get models(): ModelUsage[] {
    return [...this.#byModel.values()];
  }

  get empty(): boolean {
    return this.#byModel.size === 0;
  }

  get totals(): Usage {
    return this.models.reduce(
      (sum, m) => ({
        input: sum.input + m.input,
        output: sum.output + m.output,
        cacheRead: (sum.cacheRead ?? 0) + m.cacheRead,
        cacheWrite: (sum.cacheWrite ?? 0) + m.cacheWrite,
        webSearches: (sum.webSearches ?? 0) + m.webSearches,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0 } as Usage,
    );
  }

  record(model: string, usage: Usage, turns: number, tools: number): void {
    const existing = this.#byModel.get(model) ?? {
      model,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      runs: 0,
      webSearches: 0,
    };
    existing.input += usage.input;
    existing.output += usage.output;
    existing.cacheRead += usage.cacheRead ?? 0;
    existing.cacheWrite += usage.cacheWrite ?? 0;
    existing.webSearches += usage.webSearches ?? 0;
    existing.runs += 1;
    this.#byModel.set(model, existing);
    this.#turns += turns;
    this.#tools += tools;
  }

  /** `/usage`, rendered. */
  text(): string {
    if (this.empty) return 'Nothing run yet this session.';
    const lines: string[] = [];
    let known = 0;
    let unpriced = false;
    for (const m of this.models) {
      const cost = estimateCost(m.model, m);
      if (cost === undefined) unpriced = true;
      else known += cost;
      lines.push(
        `  ${m.model} — ${m.runs} run${m.runs === 1 ? '' : 's'}, ` +
          formatInOut(m) +
          `${m.webSearches > 0 ? `, ${formatWebSearches(m.webSearches)}` : ''}` +
          `${cost === undefined ? ', cost unknown (no local price)' : `, about ${formatCost(cost)}`}`,
      );
    }
    const total = this.totals;
    return [
      'This session:',
      ...lines,
      `  ${this.#turns} turn${this.#turns === 1 ? '' : 's'}, ${this.#tools} tool call${
        this.#tools === 1 ? '' : 's'
      }, ${formatInOut(total)}`,
      `  estimated cost ${formatCost(known)}${unpriced ? ' plus the unpriced models above' : ''}` +
        `${(total.webSearches ?? 0) > 0 ? `, plus ${formatWebSearches(total.webSearches ?? 0)} metered separately` : ''}`,
      '  Estimates from a local price table — check your provider dashboard for the bill.',
    ].join('\n');
  }
}
