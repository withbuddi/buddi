import { describe, expect, it } from 'vitest';
import { UsageLedger, estimateCost, formatCost, formatTokens } from './usage.js';

describe('estimateCost', () => {
  it('prices the models this installation actually runs', () => {
    const million = { input: 1_000_000, output: 0 };
    expect(estimateCost('claude-sonnet-5', million)).toBe(2);
    expect(estimateCost('claude-opus-5', million)).toBe(5);
  });

  it('keeps an older snapshot in the family on its own rate', () => {
    expect(estimateCost('claude-sonnet-4-6', { input: 1_000_000, output: 0 })).toBe(3);
  });

  it('prefers the longest matching prefix, so mini is not billed as full', () => {
    const tokens = { input: 1_000_000, output: 0 };
    expect(estimateCost('gpt-5-mini', tokens)).toBe(0.25);
    expect(estimateCost('gpt-5', tokens)).toBe(1.25);
  });

  it('says nothing rather than inventing a price it does not have', () => {
    expect(estimateCost('some-local-llama', { input: 1_000, output: 1_000 })).toBeUndefined();
  });
});

describe('formatting', () => {
  it('keeps small amounts readable instead of rounding them to zero', () => {
    expect(formatCost(1.234)).toBe('$1.23');
    expect(formatCost(0.0423)).toBe('$0.042');
    expect(formatCost(0.00021)).toBe('$0.0002');
  });

  it('separates thousands', () => {
    expect(formatTokens(1204)).toBe('1,204');
  });
});

describe('UsageLedger', () => {
  it('starts empty and says so', () => {
    expect(new UsageLedger().text()).toContain('Nothing run yet');
  });

  it('totals tokens, turns and tool calls across runs', () => {
    const ledger = new UsageLedger();
    ledger.record('claude-sonnet-5', { input: 1000, output: 200 }, 2, 3);
    ledger.record('claude-sonnet-5', { input: 500, output: 100 }, 1, 0);
    // `webSearches` is always present and always counted, even at zero: it is
    // a meter, and a meter that only appears once it has moved is one nobody
    // thinks to look at.
    expect(ledger.totals).toEqual({ input: 1500, output: 300, webSearches: 0 });
    expect(ledger.turns).toBe(3);
    expect(ledger.tools).toBe(3);
    const text = ledger.text();
    expect(text).toContain('2 runs');
    expect(text).toContain('in 1,500 / out 300');
  });

  it('keeps two providers apart, because they have two prices', () => {
    const ledger = new UsageLedger();
    ledger.record('claude-sonnet-5', { input: 1000, output: 100 }, 1, 0);
    ledger.record('gpt-5', { input: 1000, output: 100 }, 1, 0);
    expect(ledger.models).toHaveLength(2);
  });

  it('flags the models it could not price rather than under-reporting', () => {
    const ledger = new UsageLedger();
    ledger.record('some-local-llama', { input: 10, output: 10 }, 1, 0);
    expect(ledger.text()).toContain('cost unknown');
    expect(ledger.text()).toContain('unpriced');
  });

  it('says out loud that the number is an estimate', () => {
    const ledger = new UsageLedger();
    ledger.record('gpt-5', { input: 10, output: 10 }, 1, 0);
    expect(ledger.text()).toContain('provider dashboard');
  });
});
