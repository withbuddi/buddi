/**
 * The budget follows the model.
 *
 * What is pinned here is not the individual numbers — those move with the
 * models — but the three properties the lifetime rule depends on: a known
 * model is never sized as an unknown one, an unknown one is never given more
 * room than the smallest window we bind, and the owner's override wins over
 * both unless it is nonsense.
 */
import { describe, expect, it } from 'vitest';
import {
  CHARS_PER_TOKEN,
  contextWindowTokens,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  transcriptBudgetChars,
  transcriptCharsForModel,
  TRANSCRIPT_WINDOW_SHARE,
} from './context-window.js';

describe('the window of a model we bind', () => {
  it('knows the Claude 5 family and 4.x', () => {
    expect(contextWindowTokens('claude-opus-5', 'anthropic')).toBe(200_000);
    expect(contextWindowTokens('claude-sonnet-5', 'anthropic')).toBe(200_000);
    expect(contextWindowTokens('claude-haiku-5', 'anthropic')).toBe(200_000);
    expect(contextWindowTokens('claude-sonnet-4-5-20250929', 'anthropic')).toBe(200_000);
    expect(contextWindowTokens('claude-opus-4-1', 'anthropic')).toBe(200_000);
  });

  it('reads the long-context suffix, which is the same model with more room', () => {
    expect(contextWindowTokens('claude-opus-5[1m]', 'anthropic')).toBe(1_000_000);
    expect(contextWindowTokens('claude-sonnet-4-5-1m', 'anthropic')).toBe(1_000_000);
  });

  it('knows the GPT-5 family and the o-series', () => {
    expect(contextWindowTokens('gpt-5', 'openai')).toBe(400_000);
    expect(contextWindowTokens('gpt-5-mini', 'openai')).toBe(400_000);
    expect(contextWindowTokens('o3', 'openai')).toBe(200_000);
    expect(contextWindowTokens('o4-mini', 'openai')).toBe(200_000);
    expect(contextWindowTokens('gpt-4o', 'openai')).toBe(128_000);
  });

  it('knows common local models by name prefix, tag and all', () => {
    expect(contextWindowTokens('llama3.1:8b', 'ollama')).toBe(128_000);
    expect(contextWindowTokens('qwen3:14b', 'ollama')).toBe(32_000);
    expect(contextWindowTokens('mistral:7b', 'ollama')).toBe(32_000);
  });

  it('reads the name when the host is not said, and ignores routing prefixes', () => {
    expect(contextWindowTokens('us.anthropic.claude-sonnet-5')).toBe(200_000);
    expect(contextWindowTokens('openai/gpt-5')).toBe(400_000);
  });

  it('falls back to the smallest window we bind, never to nothing', () => {
    expect(contextWindowTokens('some-model-nobody-has-heard-of')).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(contextWindowTokens('')).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
    expect(contextWindowTokens('   ')).toBe(DEFAULT_CONTEXT_WINDOW_TOKENS);
  });

  it('lets the owner override it, but not with a number nobody could mean', () => {
    expect(contextWindowTokens('qwen3:14b', 'ollama', 262_144)).toBe(262_144);
    expect(contextWindowTokens('qwen3:14b', 'ollama', 12)).toBe(32_000);
    expect(contextWindowTokens('qwen3:14b', 'ollama', Number.NaN)).toBe(32_000);
    expect(contextWindowTokens('qwen3:14b', 'ollama', null)).toBe(32_000);
  });
});

describe('the transcript budget that window buys', () => {
  it('is the stated share of the window, in characters', () => {
    expect(transcriptBudgetChars(200_000)).toBe(Math.floor(200_000 * TRANSCRIPT_WINDOW_SHARE * CHARS_PER_TOKEN));
    expect(transcriptBudgetChars(200_000)).toBe(432_000);
  });

  it('leaves room to answer in: never the whole window', () => {
    expect(transcriptBudgetChars(200_000)).toBeLessThan(200_000 * CHARS_PER_TOKEN);
  });

  it('scales with the model, which is the whole point', () => {
    const small = transcriptCharsForModel('gpt-4o', 'openai');
    const large = transcriptCharsForModel('claude-opus-5[1m]', 'anthropic');
    expect(large).toBeGreaterThan(small * 5);
  });

  it('never returns zero for a nonsense window', () => {
    expect(transcriptBudgetChars(0)).toBe(transcriptBudgetChars(DEFAULT_CONTEXT_WINDOW_TOKENS));
    expect(transcriptBudgetChars(Number.NaN)).toBeGreaterThan(0);
  });
});
