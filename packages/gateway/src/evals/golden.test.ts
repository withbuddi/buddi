import { describe, expect, it } from 'vitest';
import {
  agentFor,
  casesFor,
  GOLDEN_CASES,
  OPENAI_AGENT,
  parseEvalArgs,
} from './golden.js';

describe('parseEvalArgs', () => {
  it('defaults to the anthropic set', () => {
    expect(parseEvalArgs([])).toEqual({ provider: 'anthropic', only: new Set() });
  });

  it('takes --provider in both spellings, and bare case ids', () => {
    expect(parseEvalArgs(['--provider', 'openai']).provider).toBe('openai');
    expect(parseEvalArgs(['--provider=openai']).provider).toBe('openai');
    expect([...parseEvalArgs(['--', 'no-tool-names-leak']).only]).toEqual([
      'no-tool-names-leak',
    ]);
  });

  it('refuses a provider this build has no adapter for', () => {
    expect(() => parseEvalArgs(['--provider', 'gemini'])).toThrow(/anthropic, openai/);
    expect(() => parseEvalArgs(['--wat'])).toThrow(/unknown option/);
  });
});

describe('selecting cases per provider', () => {
  it('runs the whole finance set on anthropic', () => {
    const { run, skipped } = casesFor('anthropic');
    expect(run.length).toBeGreaterThan(5);
    expect(run.every((c) => (c.providers ?? ['anthropic']).includes('anthropic'))).toBe(true);
    // The scout-only case is skipped here, and said so rather than counted.
    expect(skipped.map((s) => s.id)).toContain('scout-names-its-provider-and-its-limits');
  });

  it('skips every finance case on openai and says why', () => {
    const { run, skipped } = casesFor('openai');
    expect(run.length).toBeGreaterThan(0);
    expect(skipped.length).toBeGreaterThan(0);
    for (const entry of skipped) {
      expect(entry.why).toMatch(/finance tools/);
      expect(entry.why).toContain(OPENAI_AGENT);
    }
    // Nothing is both run and skipped, and nothing is dropped on the floor.
    expect(run.length + skipped.length).toBe(GOLDEN_CASES.length);
  });

  it('routes the cases that do run to the agent pinned to that provider', () => {
    const financeCase = GOLDEN_CASES.find((c) => c.id === 'no-tool-names-leak');
    expect(financeCase).toBeDefined();
    expect(agentFor(financeCase!, 'anthropic')).toBe('finance-advisor');
    expect(agentFor(financeCase!, 'openai')).toBe(OPENAI_AGENT);
  });

  it('gives every case a unique id', () => {
    expect(new Set(GOLDEN_CASES.map((c) => c.id)).size).toBe(GOLDEN_CASES.length);
  });
});
