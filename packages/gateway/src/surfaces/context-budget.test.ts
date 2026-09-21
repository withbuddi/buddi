/**
 * The size limit follows the model, and is measured on what is sent.
 *
 * Both halves fail closed: a database that cannot say which model this is, or
 * cannot read the transcript, leaves the conversation with exactly the limit
 * and the count it had before any of this existed.
 */
import { describe, expect, it } from 'vitest';
import type { Queryable } from '@buddi/core';
import { transcriptCharsForModel } from '@buddi/runtime';
import { MAX_TRANSCRIPT_CHARS } from './conversation-lifetime.js';
import { projectedTranscriptChars, transcriptBudget } from './context-budget.js';

const CONVERSATION = '11111111-1111-1111-1111-111111111111';

function bindingPool(row: Record<string, unknown> | null): Queryable {
  return {
    query: async (sql: string) => {
      if (/from core\.conversations/.test(sql)) return { rows: row ? [row] : [] };
      throw new Error(`unexpected sql: ${sql}`);
    },
  } as unknown as Queryable;
}

describe('what a conversation may grow to', () => {
  it('scales with the bound model: a big window buys a big transcript', async () => {
    const big = await transcriptBudget(bindingPool({ model: 'claude-opus-5[1m]', kind: 'anthropic', override: null }), CONVERSATION);
    const small = await transcriptBudget(bindingPool({ model: 'gpt-4o', kind: 'openai', override: null }), CONVERSATION);
    expect(big.maxChars).toBe(transcriptCharsForModel('claude-opus-5[1m]', 'anthropic'));
    expect(big.maxChars).toBeGreaterThan(small.maxChars * 5);
    expect(big.windowTokens).toBe(1_000_000);
  });

  it('never goes below the floor the old constant was', async () => {
    const tiny = await transcriptBudget(bindingPool({ model: 'phi4', kind: 'openai-compatible', override: 8_000 }), CONVERSATION);
    expect(tiny.maxChars).toBe(MAX_TRANSCRIPT_CHARS);
  });

  it('takes the owner override over the table', async () => {
    const budget = await transcriptBudget(bindingPool({ model: 'qwen3:14b', kind: 'openai-compatible', override: 262_144 }), CONVERSATION);
    expect(budget.windowTokens).toBe(262_144);
  });

  it('falls back to the floor when the agent has no account binding', async () => {
    expect((await transcriptBudget(bindingPool(null), CONVERSATION)).maxChars).toBe(MAX_TRANSCRIPT_CHARS);
  });
});

describe('what a conversation costs', () => {
  const TREE = 'x'.repeat(4_000);
  const steps = (n: number): Array<{ role: string; content: unknown }> =>
    Array.from({ length: n }, (_, i) => [
      { role: 'assistant', content: [{ type: 'tool_use', id: `c${i}`, name: 'browser.act', input: { action: 'click' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `c${i}`, content: JSON.stringify({ observation: { id: `o${i}`, url: `https://x/${i}`, title: `P${i}`, tree: TREE } }) }] },
    ]).flat();

  const messagePool = (rows: Array<{ role: string; content: unknown }>): Queryable => ({
    query: async () => ({ rows }),
  } as unknown as Queryable);

  it('counts the projection, not the rows: spent observations are already a line', async () => {
    const rows = steps(10);
    const stored = rows.reduce((sum, r) => sum + JSON.stringify(r.content).length, 0);
    const projected = await projectedTranscriptChars(messagePool(rows), CONVERSATION);
    expect(stored).toBeGreaterThan(40_000);
    expect(projected).toBeLessThan(stored / 3);
  });
});
