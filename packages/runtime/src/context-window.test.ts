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
  contextWindowInfo,
  contextWindowTokens,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  estimateTokens,
  reportedContextWindow,
  transcriptBudgetChars,
  transcriptTokenBudget,
  transcriptTokensForModel,
  TRANSCRIPT_WINDOW_SHARE,
} from './context-window.js';

describe('the window of a model we bind', () => {
  it('knows the Claude 5 family and 4.x, a million from Opus 4.6 on', () => {
    expect(contextWindowTokens('claude-opus-5', 'anthropic')).toBe(1_000_000);
    expect(contextWindowTokens('claude-opus-5-5', 'anthropic')).toBe(1_000_000);
    expect(contextWindowTokens('claude-sonnet-5', 'anthropic')).toBe(1_000_000);
    expect(contextWindowTokens('claude-sonnet-5-5', 'anthropic')).toBe(1_000_000);
    expect(contextWindowTokens('claude-haiku-5-5', 'anthropic')).toBe(1_000_000);
    expect(contextWindowTokens('claude-opus-4-6', 'anthropic')).toBe(1_000_000);
    expect(contextWindowTokens('claude-sonnet-4-6', 'anthropic')).toBe(1_000_000);
    expect(contextWindowTokens('claude-opus-4-5-20251101', 'anthropic')).toBe(200_000);
    expect(contextWindowTokens('claude-haiku-4-5-20251001', 'anthropic')).toBe(200_000);
    expect(contextWindowTokens('claude-sonnet-4-5-20250929', 'anthropic')).toBe(200_000);
    expect(contextWindowTokens('claude-opus-4-1', 'anthropic')).toBe(200_000);
    // A dotted version, as some hosts spell it, is the same model.
    expect(contextWindowTokens('claude-opus-5.5', 'anthropic')).toBe(1_000_000);
  });

  it('reads the ids Bedrock, Vertex and OpenRouter give Claude', () => {
    expect(contextWindowTokens('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe(200_000);
    expect(contextWindowTokens('anthropic.claude-opus-4-6-v1:0', 'openai-compatible')).toBe(1_000_000);
    expect(contextWindowTokens('claude-opus-4-1@20250805', 'openai-compatible')).toBe(200_000);
    expect(contextWindowTokens('openrouter/anthropic/claude-sonnet-5', 'openai-compatible')).toBe(1_000_000);
    // OpenRouter's routing variants are the same model, routed differently.
    expect(contextWindowTokens('openrouter/anthropic/claude-sonnet-5:nitro', 'openai-compatible')).toBe(1_000_000);
    expect(contextWindowTokens('anthropic/claude-sonnet-4:floor', 'openai-compatible')).toBe(200_000);
    // An Ollama tag is not one of them.
    expect(contextWindowTokens('qwen3:32b', 'openai-compatible')).toBe(32_000);
  });

  it('reads the long-context suffix, which is the same model with more room', () => {
    expect(contextWindowTokens('claude-opus-5[1m]', 'anthropic')).toBe(1_000_000);
    expect(contextWindowTokens('claude-sonnet-4-5-1m', 'anthropic')).toBe(1_000_000);
  });

  it('knows the GPT families and the o-series, the variants with their own windows included', () => {
    expect(contextWindowTokens('gpt-5', 'openai')).toBe(400_000);
    expect(contextWindowTokens('gpt-5-mini', 'openai')).toBe(400_000);
    expect(contextWindowTokens('gpt-5.4-codex', 'openai')).toBe(400_000);
    expect(contextWindowTokens('gpt-5-chat-latest', 'openai')).toBe(128_000);
    expect(contextWindowTokens('gpt-6-astra', 'openai')).toBe(1_050_000);
    expect(contextWindowTokens('gpt-6', 'openai')).toBe(1_050_000);
    expect(contextWindowTokens('gpt-4.1', 'openai')).toBe(1_047_576);
    expect(contextWindowTokens('gpt-4', 'openai')).toBe(8192);
    expect(contextWindowTokens('gpt-3.5-turbo', 'openai')).toBe(16_385);
    expect(contextWindowTokens('o3', 'openai')).toBe(200_000);
    expect(contextWindowTokens('o4-mini', 'openai')).toBe(200_000);
    expect(contextWindowTokens('o1-mini', 'openai')).toBe(128_000);
    expect(contextWindowTokens('o1-preview', 'openai')).toBe(128_000);
    expect(contextWindowTokens('gpt-4o', 'openai')).toBe(128_000);
  });

  it('knows Gemini by family, bare or with Google\'s models/ prefix, and keeps gemma apart', () => {
    expect(contextWindowTokens('gemini-3.1-pro-preview', 'openai-compatible')).toBe(1_048_576);
    expect(contextWindowTokens('models/gemini-2.5-flash', 'openai-compatible')).toBe(1_048_576);
    expect(contextWindowTokens('gemini-2.5-pro')).toBe(1_048_576);
    expect(contextWindowTokens('gemini-flash-latest')).toBe(1_048_576);
    expect(contextWindowTokens('gemini-4-pro')).toBe(1_048_576);
    expect(contextWindowTokens('gemma3:4b', 'openai-compatible')).toBe(128_000);
  });

  it('gives an unlisted name of a known family the default, not the family\'s window', () => {
    expect(contextWindowInfo('claude-x', 'anthropic')).toEqual({ tokens: DEFAULT_CONTEXT_WINDOW_TOKENS, source: 'default' });
    expect(contextWindowInfo('gemini-exp-1206')).toEqual({ tokens: DEFAULT_CONTEXT_WINDOW_TOKENS, source: 'default' });
    expect(contextWindowInfo('gemini-2.5-flash-image', 'openai-compatible')).toEqual({ tokens: DEFAULT_CONTEXT_WINDOW_TOKENS, source: 'default' });
  });

  it('asks the local table first on a local or compatible host, then the known models', () => {
    expect(contextWindowInfo('gemma3', 'openai-compatible')).toEqual({ tokens: 128_000, source: 'table' });
    expect(contextWindowInfo('qwen3:14b')).toEqual({ tokens: 32_000, source: 'table' });
    expect(contextWindowInfo('qwen3:14b', 'anthropic')).toEqual({ tokens: DEFAULT_CONTEXT_WINDOW_TOKENS, source: 'default' });
  });

  it('knows common local models by name prefix, tag and all', () => {
    expect(contextWindowTokens('llama3.1:8b', 'ollama')).toBe(128_000);
    expect(contextWindowTokens('qwen3:14b', 'ollama')).toBe(32_000);
    expect(contextWindowTokens('mistral:7b', 'ollama')).toBe(32_000);
  });

  it('reads the name when the host is not said, and ignores routing prefixes', () => {
    expect(contextWindowTokens('us.anthropic.claude-sonnet-5')).toBe(1_000_000);
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

describe('where the window came from', () => {
  it('says owner, table or default', () => {
    expect(contextWindowInfo('qwen3:14b', 'ollama', 262_144)).toEqual({ tokens: 262_144, source: 'owner' });
    expect(contextWindowInfo('qwen3:14b', 'ollama', 12)).toEqual({ tokens: 32_000, source: 'table' });
    expect(contextWindowInfo('claude-sonnet-5', 'anthropic')).toEqual({ tokens: 1_000_000, source: 'table' });
    expect(contextWindowInfo('claude-opus-4-5[1m]', 'anthropic')).toEqual({ tokens: 1_000_000, source: 'table' });
    expect(contextWindowInfo('some-model-nobody-has-heard-of')).toEqual({ tokens: DEFAULT_CONTEXT_WINDOW_TOKENS, source: 'default' });
    expect(contextWindowInfo('')).toEqual({ tokens: DEFAULT_CONTEXT_WINDOW_TOKENS, source: 'default' });
  });
});

describe('the window a provider reported, found for the bound model', () => {
  const map = { 'claude-sonnet-4-5': 200_000, 'claude-opus-5': 1_000_000, 'gemini-2.5-pro': 1_048_576, junk: 5 };

  it('finds an exact key first', () => {
    expect(reportedContextWindow({ ...map, 'us.anthropic.claude-sonnet-4-5': 300_000 }, 'us.anthropic.claude-sonnet-4-5')).toBe(300_000);
    expect(reportedContextWindow(map, 'claude-opus-5')).toBe(1_000_000);
  });

  it('finds a routed or suffixed binding by its normalised id', () => {
    expect(reportedContextWindow(map, 'us.anthropic.claude-sonnet-4-5')).toBe(200_000);
    expect(reportedContextWindow(map, 'models/gemini-2.5-pro')).toBe(1_048_576);
    expect(reportedContextWindow(map, 'Claude-Opus-5')).toBe(1_000_000);
    // A [1m] binding's own row is the provider's; the base model's row is not
    // its window, so the table answers (a million, as a known model).
    expect(reportedContextWindow({ 'claude-sonnet-4-5[1m]': 600_000 }, 'us.anthropic.claude-sonnet-4-5[1m]')).toBe(600_000);
    expect(reportedContextWindow(map, 'claude-sonnet-4-5[1m]')).toBeUndefined();
    expect(contextWindowInfo('claude-sonnet-4-5[1m]', 'anthropic')).toEqual({ tokens: 1_000_000, source: 'table' });
    // Another host's suffixed id finds its base row.
    expect(reportedContextWindow({ 'qwen3-coder': 262_144 }, 'qwen3-coder-1m')).toBe(262_144);
    expect(reportedContextWindow({ 'anthropic/claude-sonnet-5': 1_000_000 }, 'anthropic/claude-sonnet-5:nitro')).toBe(1_000_000);
    // An Ollama tag is a model of its own, not a routing variant.
    expect(reportedContextWindow({ qwen3: 131_072 }, 'qwen3:thinking')).toBeUndefined();
  });

  it('answers nothing for an unknown model or an unusable number', () => {
    expect(reportedContextWindow(map, 'claude-haiku-5')).toBeUndefined();
    expect(reportedContextWindow(map, 'junk')).toBeUndefined();
    expect(reportedContextWindow(null, 'claude-opus-5')).toBeUndefined();
    expect(reportedContextWindow(map, '')).toBeUndefined();
  });
});

describe('the transcript budget that window buys', () => {
  it('is the stated share of the window, in tokens', () => {
    expect(transcriptTokenBudget(200_000)).toBe(Math.floor(200_000 * TRANSCRIPT_WINDOW_SHARE));
    expect(transcriptTokenBudget(200_000)).toBe(100_000);
  });

  it('leaves room to answer in: never the whole window', () => {
    expect(transcriptTokenBudget(200_000)).toBeLessThan(200_000);
  });

  it('scales with the model, which is the whole point', () => {
    const small = transcriptTokensForModel('gpt-4o', 'openai');
    const large = transcriptTokensForModel('claude-opus-5[1m]', 'anthropic');
    expect(large).toBeGreaterThan(small * 5);
  });

  it('never returns zero for a nonsense window', () => {
    expect(transcriptTokenBudget(0)).toBe(transcriptTokenBudget(DEFAULT_CONTEXT_WINDOW_TOKENS));
    expect(transcriptTokenBudget(Number.NaN)).toBeGreaterThan(0);
  });

  it('expresses the same budget in prose characters, for the cheap precheck', () => {
    expect(transcriptBudgetChars(200_000)).toBe(Math.floor(100_000 * CHARS_PER_TOKEN));
  });
});

describe('what a transcript costs, estimated', () => {
  it('counts English prose at the assumed characters per token', () => {
    const prose = 'the quick brown fox jumps over the lazy dog. '.repeat(20);
    expect(estimateTokens(prose)).toBe(Math.ceil(prose.length / CHARS_PER_TOKEN));
  });

  it('counts CJK at one token a character, because that is what it costs', () => {
    // The bug this closes: 200k characters of Japanese claiming the room of
    // 55k tokens, and filling the window three and a half times over.
    const japanese = '今日は銀行の残高を確認してください。'.repeat(50);
    expect(estimateTokens(japanese)).toBeGreaterThanOrEqual(japanese.length);
    expect(estimateTokens(japanese)).toBeGreaterThan(estimateTokens('a'.repeat(japanese.length)) * 3);
  });

  it('is never below what the same text costs as prose, for dense JSON', () => {
    // ASCII JSON still tokenises worse than 3.6 characters a token; that
    // residual is what the 50% reserve is for, not this estimate.
    const json = JSON.stringify({ observation: { id: 'a1b2', targets: Array.from({ length: 40 }, (_, i) => ({ ref: `t${i}`, name: `field_${i}` })) } });
    expect(estimateTokens(json)).toBe(Math.ceil(json.length / CHARS_PER_TOKEN));
    expect(estimateTokens(json)).toBeGreaterThan(0);
  });

  it('charges an emoji more than a letter, and empty text nothing', () => {
    expect(estimateTokens('🙂')).toBeGreaterThanOrEqual(2);
    expect(estimateTokens('')).toBe(0);
  });
});
