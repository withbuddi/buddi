import { describe, expect, it, vi } from 'vitest';
import { resolveProvider, type ProviderRef } from '@buddi/core';
import { ProviderError, createAnthropicProvider } from './anthropic.js';
import { createOpenAiProvider } from './openai.js';
import { headerWaitMs, nextMidnight, parseDuration, providerFromBaseUrl, readRateLimit } from './rate-limit.js';
import { HINTED_RETRIES, STATUS_WAIT_BUDGET_MS, statusRetryDelayMs } from './retry.js';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const bag = (h: Record<string, string>) => ({ get: (name: string) => h[name] ?? null });

/** Google's answer to the twenty-first free-tier request of the day, as its compatible address sends it. */
const GEMINI_DAILY = JSON.stringify([{
  error: {
    code: 429,
    message: 'You exceeded your current quota, please check your plan and billing details.\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-2.5-flash\nPlease retry in 20.632289s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaDimensions: { location: 'global', model: 'gemini-2.5-flash' }, quotaValue: '20' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '20s' },
    ],
  },
}]);

/** A per-minute burst on the same address. */
const GEMINI_MINUTE = JSON.stringify([{
  error: {
    code: 429,
    message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 10. Please retry in 20.6s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '10' }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '20.6s' },
    ],
  },
}]);

describe('reading a provider window', () => {
  it('parses the durations providers write', () => {
    expect(parseDuration('20s')).toBe(20_000);
    expect(parseDuration('20.632s')).toBe(20_632);
    expect(parseDuration('6m0s')).toBe(360_000);
    expect(parseDuration('1h2m3.5s')).toBe(3_723_500);
    expect(parseDuration('20ms')).toBe(20);
    expect(parseDuration('soon')).toBeUndefined();
  });

  it('reads Retry-After, retry-after-ms, OpenAI resets and Anthropic resets', () => {
    expect(headerWaitMs(bag({ 'retry-after': '7' }), NOW)).toBe(7000);
    expect(headerWaitMs(bag({ 'retry-after-ms': '1500', 'retry-after': '2' }), NOW)).toBe(1500);
    expect(headerWaitMs(bag({ 'retry-after': 'Thu, 01 Oct 2026 12:00:30 GMT' }), NOW)).toBe(30_000);
    expect(headerWaitMs(bag({ 'x-ratelimit-remaining-requests': '0', 'x-ratelimit-reset-requests': '6m0s', 'x-ratelimit-remaining-tokens': '1000', 'x-ratelimit-reset-tokens': '1s' }), NOW)).toBe(360_000);
    expect(headerWaitMs(bag({ 'anthropic-ratelimit-tokens-remaining': '0', 'anthropic-ratelimit-tokens-reset': '2026-10-01T12:00:45Z' }), NOW)).toBe(45_000);
    expect(headerWaitMs(bag({ 'x-ratelimit-remaining-requests': '5', 'x-ratelimit-reset-requests': '6m0s' }), NOW)).toBeUndefined();
  });

  it("knows a spent daily quota from Google's body, and when it resets", () => {
    const limit = readRateLimit({ status: 429, body: GEMINI_DAILY, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', now: NOW });
    expect(limit).toMatchObject({ scope: 'day', limit: 20, unit: 'requests', freeTier: true, provider: 'Gemini', model: 'gemini-2.5-flash' });
    // Midnight Pacific on 2 October 2026 (PDT, UTC-7) — not twenty seconds from now.
    expect(limit?.retryAt).toBe('2026-10-02T07:00:00.000Z');
  });

  it('reads a short burst from the body as a burst with its wait', () => {
    const limit = readRateLimit({ status: 429, body: GEMINI_MINUTE, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/', now: NOW });
    expect(limit).toMatchObject({ scope: 'burst', waitMs: 20_600, limit: 10, retryAt: '2026-10-01T12:00:20.600Z' });
  });

  it('reads the prose when the structured details are missing', () => {
    const body = JSON.stringify({ error: { message: 'Quota exceeded: limit: 20 per day (free_tier). Please retry in 3s.' } });
    expect(readRateLimit({ status: 429, body, now: NOW })).toMatchObject({ scope: 'day', limit: 20, freeTier: true });
  });

  it('says nothing for an outage with no window, and for other statuses', () => {
    expect(readRateLimit({ status: 503, body: 'down', now: NOW })).toBeNull();
    expect(readRateLimit({ status: 500, headers: bag({ 'retry-after': '5' }), now: NOW })).toBeNull();
    expect(readRateLimit({ status: 503, headers: bag({ 'retry-after': '5' }), now: NOW })).toMatchObject({ scope: 'burst', waitMs: 5000 });
  });

  it('names providers from their address', () => {
    expect(providerFromBaseUrl('https://api.openai.com/v1')).toBe('OpenAI');
    expect(providerFromBaseUrl('http://127.0.0.1:11434/v1')).toBe('Ollama');
    expect(providerFromBaseUrl('https://example.test/v1')).toBeUndefined();
  });

  it('finds the next midnight in a zone across a clock change', () => {
    // 1 Nov 2026 is the US fall-back day: the next Pacific midnight after 31 Oct noon is 1 Nov 07:00Z.
    expect(new Date(nextMidnight('America/Los_Angeles', Date.parse('2026-10-31T19:00:00Z'))).toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(new Date(nextMidnight('America/Los_Angeles', Date.parse('2026-11-01T19:00:00Z'))).toISOString()).toBe('2026-11-02T08:00:00.000Z');
  });
});

describe('the status retry plan', () => {
  const burst = (waitMs: number) => ({ scope: 'burst' as const, waitMs, retryAt: null });
  it('waits a hinted window at most twice', () => {
    expect(statusRetryDelayMs({ failures: 1, hintedRetries: 0, waitedMs: 0, limit: burst(20_000) })).toEqual({ delayMs: 20_000, hinted: true });
    expect(statusRetryDelayMs({ failures: 2, hintedRetries: HINTED_RETRIES, waitedMs: 40_000, limit: burst(1000) })).toBeUndefined();
  });
  it('never sleeps past the budget', () => {
    expect(statusRetryDelayMs({ failures: 1, hintedRetries: 0, waitedMs: 0, limit: burst(STATUS_WAIT_BUDGET_MS + 1) })).toBeUndefined();
    expect(statusRetryDelayMs({ failures: 2, hintedRetries: 1, waitedMs: 30_000, limit: burst(31_000) })).toBeUndefined();
  });
  it('never retries a spent daily quota, and keeps the curve for a silent refusal', () => {
    expect(statusRetryDelayMs({ failures: 1, hintedRetries: 0, waitedMs: 0, limit: { scope: 'day', waitMs: 1000, retryAt: null } })).toBeUndefined();
    expect(statusRetryDelayMs({ failures: 1, hintedRetries: 0, waitedMs: 0, limit: null })).toEqual({ delayMs: 500, hinted: false });
    expect(statusRetryDelayMs({ failures: 1, hintedRetries: 0, waitedMs: 0, limit: null, maxRetries: 0 })).toBeUndefined();
  });
});

const geminiRef: ProviderRef = { kind: 'openai', credential: { kind: 'api-key', env: 'K' }, model: 'gpt-5' };
function gemini() {
  const r = resolveProvider(geminiRef, { K: 'gm-secret' });
  if (!r.ok) throw new Error(r.problem.message);
  return { ...r.provider, model: 'gemini-2.5-flash', compatible: true, baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/' };
}
const ok = () => new Response(JSON.stringify({ model: 'gemini-2.5-flash', choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
const limited = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 429, headers: { 'content-type': 'application/json', ...headers } });
const request = { system: '', messages: [], tools: [], maxTokens: 50 };

describe('the adapters honour the window', () => {
  it('retries after a Retry-After header (Anthropic)', async () => {
    const r = resolveProvider({ kind: 'anthropic', credential: { kind: 'api-key', env: 'A' }, model: 'claude-sonnet-5' }, { A: 'sk-ant' });
    if (!r.ok) throw new Error(r.problem.message);
    const slept: number[] = [];
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow' } }), { status: 429, headers: { 'retry-after': '12' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} }), { status: 200 }));
    const provider = createAnthropicProvider(r.provider, { fetch: fetch as never, sleep: async (ms) => { slept.push(ms); } });
    await provider.complete(request);
    expect(slept).toEqual([12_000]);
  });

  it("retries after Google's body hint", async () => {
    const slept: number[] = [];
    const fetch = vi.fn().mockResolvedValueOnce(limited(GEMINI_MINUTE)).mockResolvedValueOnce(ok());
    const provider = createOpenAiProvider(gemini(), { fetch: fetch as never, sleep: async (ms) => { slept.push(ms); } });
    const res = await provider.complete(request);
    expect(res.stopReason).toBe('end_turn');
    expect(slept).toEqual([20_600]);
  });

  it('gives up with the window on the error when the budget cannot cover it', async () => {
    const fetch = vi.fn(async () => limited(JSON.stringify({ error: { message: 'busy' } }), { 'retry-after': '90' }));
    const slept: number[] = [];
    const provider = createOpenAiProvider(gemini(), { fetch: fetch as never, sleep: async (ms) => { slept.push(ms); }, now: () => NOW });
    const error = await provider.complete(request).catch((e: unknown) => e) as ProviderError;
    expect(error).toBeInstanceOf(ProviderError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
    expect(error.limit).toMatchObject({ scope: 'burst', waitMs: 90_000 });
    expect(error.retryAt).toBe('2026-10-01T12:01:30.000Z');
  });

  it('stops after two hinted waits', async () => {
    const fetch = vi.fn(async () => limited(GEMINI_MINUTE));
    const slept: number[] = [];
    const provider = createOpenAiProvider(gemini(), { fetch: fetch as never, sleep: async (ms) => { slept.push(ms); } });
    await expect(provider.complete(request)).rejects.toBeInstanceOf(ProviderError);
    expect(slept).toEqual([20_600, 20_600]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry a spent daily quota at all', async () => {
    const fetch = vi.fn(async () => limited(GEMINI_DAILY));
    const provider = createOpenAiProvider(gemini(), { fetch: fetch as never, sleep: async () => {}, now: () => NOW });
    const error = await provider.complete(request).catch((e: unknown) => e) as ProviderError;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(error.limit).toMatchObject({ scope: 'day', limit: 20, freeTier: true, provider: 'Gemini' });
    expect(error.retryAt).toBe('2026-10-02T07:00:00.000Z');
    expect(error.message).not.toContain('gm-secret');
  });
});
