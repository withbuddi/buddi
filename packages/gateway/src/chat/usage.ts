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
export const PRICES: readonly { prefix: string; input: number; output: number }[] = [
  { prefix: 'claude-fable-5', input: 10, output: 50 },
  { prefix: 'claude-mythos-5', input: 10, output: 50 },
  { prefix: 'claude-opus-5', input: 5, output: 25 },
  { prefix: 'claude-opus-4-8', input: 5, output: 25 },
  { prefix: 'claude-opus-4-7', input: 5, output: 25 },
  { prefix: 'claude-opus-4-6', input: 5, output: 25 },
  { prefix: 'claude-sonnet-5', input: 2, output: 10 },
  { prefix: 'claude-sonnet-4-6', input: 3, output: 15 },
  { prefix: 'claude-haiku-4-5', input: 1, output: 5 },
  { prefix: 'gpt-5-mini', input: 0.25, output: 2 },
  { prefix: 'gpt-5', input: 1.25, output: 10 },
  { prefix: 'gpt-4.1-mini', input: 0.4, output: 1.6 },
  { prefix: 'gpt-4.1', input: 2, output: 8 },
  { prefix: 'gpt-4o-mini', input: 0.15, output: 0.6 },
  { prefix: 'gpt-4o', input: 2.5, output: 10 },
];

/** Estimated dollars for one model's tokens, or nothing when unpriced. */
export function estimateCost(model: string, usage: Usage): number | undefined {
  const id = model.toLowerCase();
  const matches = PRICES.filter((p) => id.startsWith(p.prefix)).sort(
    (a, b) => b.prefix.length - a.prefix.length,
  );
  const price = matches[0];
  if (!price) return undefined;
  return (usage.input * price.input + usage.output * price.output) / 1_000_000;
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

/** Thousands separators, because six-digit token counts are unreadable without. */
export function formatTokens(count: number): string {
  return count.toLocaleString('en-US');
}

/** One model's running totals for this session. */
export interface ModelUsage {
  model: string;
  input: number;
  output: number;
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
        webSearches: (sum.webSearches ?? 0) + m.webSearches,
      }),
      { input: 0, output: 0, webSearches: 0 } as Usage,
    );
  }

  record(model: string, usage: Usage, turns: number, tools: number): void {
    const existing = this.#byModel.get(model) ?? {
      model,
      input: 0,
      output: 0,
      runs: 0,
      webSearches: 0,
    };
    existing.input += usage.input;
    existing.output += usage.output;
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
          `in ${formatTokens(m.input)} / out ${formatTokens(m.output)}` +
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
      }, in ${formatTokens(total.input)} / out ${formatTokens(total.output)}`,
      `  estimated cost ${formatCost(known)}${unpriced ? ' plus the unpriced models above' : ''}` +
        `${(total.webSearches ?? 0) > 0 ? `, plus ${formatWebSearches(total.webSearches ?? 0)} metered separately` : ''}`,
      '  Estimates from a local price table — check your provider dashboard for the bill.',
    ].join('\n');
  }
}
