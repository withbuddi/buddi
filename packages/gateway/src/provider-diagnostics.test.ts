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
