import { expect, it } from 'vitest';
import { providerDiagnostic } from './provider-diagnostics.js';

it('does not infer subscription exhaustion or reset time from a bare 429', () => {
  expect(providerDiagnostic({ status: 429, message: 'SECRET' })).toMatchObject({ state: 'rate-limited', httpStatus: 429, retryAt: null });
  expect(providerDiagnostic({ status: 429, type: 'insufficient_quota' }).state).toBe('quota-exhausted');
});
it.each([[401, 'authentication-error'], [403, 'access-denied'], [404, 'not-found'], [503, 'provider-unavailable'], [0, 'unavailable']])('classifies status %s without echoing the response', (status, state) => {
  const result = providerDiagnostic({ status, message: 'SECRET', type: 'SECRET', headers: { authorization: 'SECRET' } });
  expect(result.state).toBe(state);
  expect(JSON.stringify(result)).not.toContain('SECRET');
});
it('only exposes valid retry timestamps, not arbitrary strings or headers', () => {
  expect(providerDiagnostic({ status: 429, retryAt: '2026-09-19T04:00:00.000Z' }).retryAt).toBe('2026-09-19T04:00:00.000Z');
  expect(providerDiagnostic({ status: 429, retryAt: 'SECRET' }).retryAt).toBeNull();
  expect(providerDiagnostic(null).state).toBe('unavailable');
});
it('says a generic rate limit as a sentence about the key and the model', () => {
  const result = providerDiagnostic({ status: 429, message: 'SECRET' }, { provider: 'Anthropic', model: 'claude-sonnet-5' });
  expect(result.message).toBe('Anthropic says this key has reached its limit for claude-sonnet-5. Wait a little, or pick another model.');
  expect(result.message).not.toMatch(/response|establish/);
});
it('tells a free Google AI key on a Pro model to start on Flash, without echoing Google', () => {
  const body = 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro';
  const result = providerDiagnostic({ status: 429, type: 'http_error', message: body }, { provider: 'Google', model: 'gemini-3.1-pro', gemini: true });
  expect(result).toMatchObject({ state: 'rate-limited', httpStatus: 429 });
  expect(result.message).toBe('Google says this key has no allowance for gemini-3.1-pro. Your Google AI plan covers the Gemini app, not this key. The key’s Google Cloud project has no billing, so Pro models aren’t included: pick a Flash model, or enable billing on that project at aistudio.google.com.');
  expect(result.message).not.toContain('generate_content');
  // Flash on the same key is an ordinary limit.
  expect(providerDiagnostic({ status: 429, message: body }, { provider: 'Google', model: 'gemini-3.8-flash', gemini: true }).message).toMatch(/^Google says this key has reached its limit for gemini-3.8-flash/);
});
it('keeps every sentence short and free of engineer-speak', () => {
  for (const status of [401, 403, 404, 429, 503, 0]) {
    const { message } = providerDiagnostic({ status }, { provider: 'OpenAI', model: 'gpt-5' });
    expect(message).not.toMatch(/response|establish/i);
    expect(message.split(/(?<=\.)\s/).length).toBeLessThanOrEqual(2);
  }
});
