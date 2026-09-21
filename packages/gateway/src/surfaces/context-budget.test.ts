/**
 * The size limit follows the model, and is measured on what is sent.
 *
 * Both halves fail closed: a database that cannot say which model this is, or
 * cannot read the transcript, leaves the conversation with exactly the limit
 * and the count it had before any of this existed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Queryable } from '@buddi/core';
import { transcriptTokensForModel } from '@buddi/runtime';
import { MAX_TRANSCRIPT_CHARS, type ConversationVitals } from './conversation-lifetime.js';
import { forgetProjectedSizes, projectedTranscriptTokens, transcriptBudget } from './context-budget.js';

const CONVERSATION = '11111111-1111-1111-1111-111111111111';

type Account = { model: string; kind: string; override: number | null };

/**
 * A pool that answers the two questions the budget asks: this conversation's
 * binding, and the installation's default account.
 */
function accounts(over: { binding?: Account | null; installation?: Account | null } = {}): Queryable {
  return {
    query: async (sql: string) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (text.startsWith('select b.model as model')) return { rows: over.binding ? [over.binding] : [] };
      if (text.startsWith('select default_model as model')) return { rows: over.installation ? [over.installation] : [] };
      throw new Error(`unexpected sql: ${text}`);
    },
  } as unknown as Queryable;
}

describe('what a conversation may grow to', () => {
  it('scales with the bound model: a big window buys a big transcript', async () => {
    const big = await transcriptBudget(accounts({ binding: { model: 'claude-opus-5[1m]', kind: 'anthropic', override: null } }), CONVERSATION);
    const small = await transcriptBudget(accounts({ binding: { model: 'gpt-4o', kind: 'openai', override: null } }), CONVERSATION);
    expect(big.maxTokens).toBe(transcriptTokensForModel('claude-opus-5[1m]', 'anthropic'));
    expect(big.maxTokens).toBeGreaterThan(small.maxTokens * 5);
    expect(big.windowTokens).toBe(1_000_000);
    expect(big.source).toBe('binding');
  });

  it('means a small override: the legacy floor never raises a known window', async () => {
    // 8,000 tokens is 4,000 of transcript. Raising that to 80,000 characters
    // would put the history alone at five times the whole window.
    const tiny = await transcriptBudget(accounts({ binding: { model: 'llama3', kind: 'openai-compatible', override: 8_000 } }), CONVERSATION);
    expect(tiny.windowTokens).toBe(8_000);
    expect(tiny.maxTokens).toBe(4_000);
    expect(tiny.maxChars).toBeLessThan(MAX_TRANSCRIPT_CHARS);
  });

  it('gives two compatible accounts their own windows', async () => {
    // The same kind, the same model name, two machines: a laptop at 8k and a
    // hosted endpoint at 256k. One number for both would overflow the laptop.
    const laptop = await transcriptBudget(accounts({ binding: { model: 'qwen3:14b', kind: 'openai-compatible', override: 8_000 } }), CONVERSATION);
    const hosted = await transcriptBudget(accounts({ binding: { model: 'qwen3:14b', kind: 'openai-compatible', override: 262_144 } }), CONVERSATION);
    expect(laptop.windowTokens).toBe(8_000);
    expect(hosted.windowTokens).toBe(262_144);
    expect(hosted.maxTokens).toBeGreaterThan(laptop.maxTokens * 30);
  });

  it('sizes an unbound agent against the installation default it will run on', async () => {
    const large = await transcriptBudget(accounts({ binding: null, installation: { model: 'claude-opus-5', kind: 'anthropic', override: null } }), CONVERSATION);
    expect(large.source).toBe('installation-default');
    expect(large.windowTokens).toBe(200_000);

    const small = await transcriptBudget(accounts({ binding: null, installation: { model: 'llama3', kind: 'openai-compatible', override: 8_000 } }), CONVERSATION);
    expect(small.source).toBe('installation-default');
    expect(small.maxTokens).toBe(4_000);
  });

  it('falls back to what every conversation had, when there is no account at all', async () => {
    const budget = await transcriptBudget(accounts({ binding: null, installation: null }), CONVERSATION);
    expect(budget.source).toBe('fallback');
    expect(budget.maxChars).toBe(MAX_TRANSCRIPT_CHARS);
  });
});

describe('what a conversation costs', () => {
  const TREE = 'x'.repeat(4_000);
  const steps = (n: number): Array<{ role: string; content: unknown }> =>
    Array.from({ length: n }, (_, i) => [
      { role: 'assistant', content: [{ type: 'tool_use', id: `c${i}`, name: 'browser.act', input: { action: 'click' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `c${i}`, content: JSON.stringify({ observation: { id: `o${i}`, url: `https://x/${i}`, title: `P${i}`, tree: TREE } }) }] },
    ]).flat();

  const vitals = (over: Partial<ConversationVitals> = {}): ConversationVitals => ({
    messages: 20, lastActivityAt: new Date('2026-09-15T20:00:00Z'), chars: 300_000, ...over,
  });

  beforeEach(() => { forgetProjectedSizes(); });

  it('counts the projection, not the rows: spent observations are already a line', async () => {
    const rows = steps(10);
    const stored = rows.reduce((sum, r) => sum + JSON.stringify(r.content).length, 0);
    const pool = { query: vi.fn(async () => ({ rows })) } as unknown as Queryable;
    const tokens = await projectedTranscriptTokens(pool, CONVERSATION);
    expect(stored).toBeGreaterThan(40_000);
    expect(tokens).toBeLessThan(stored / 10);
  });

  it('measures one version of a transcript once, however many turns it takes', async () => {
    const rows = steps(4);
    const query = vi.fn(async () => ({ rows }));
    const pool = { query } as unknown as Queryable;
    const first = await projectedTranscriptTokens(pool, CONVERSATION, vitals());
    const second = await projectedTranscriptTokens(pool, CONVERSATION, vitals());
    expect(second).toBe(first);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('measures again as soon as anything is written', async () => {
    const rows = steps(4);
    const query = vi.fn(async () => ({ rows }));
    const pool = { query } as unknown as Queryable;
    await projectedTranscriptTokens(pool, CONVERSATION, vitals());
    await projectedTranscriptTokens(pool, CONVERSATION, vitals({ messages: 21, chars: 320_000 }));
    expect(query).toHaveBeenCalledTimes(2);
  });
});
