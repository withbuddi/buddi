import { describe, expect, it } from 'vitest';
import {
  isRetryableStatus,
  MAX_RETRY_AFTER_MS,
  nextDelayMs,
  RETRY_DELAYS_MS,
  retryAfterMs,
} from './retry.js';

const headers = (value?: string) => ({
  get: (name: string) => (name === 'retry-after' && value !== undefined ? value : null),
});

describe('the shared retry policy', () => {
  it('retries rate limits, overload and 5xx — and nothing else', () => {
    for (const status of [429, 500, 502, 529]) expect(isRetryableStatus(status)).toBe(true);
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });

  it('reads Retry-After as seconds or as an HTTP date', () => {
    expect(retryAfterMs(headers('7'))).toBe(7000);
    const now = Date.parse('2026-09-14T12:00:00Z');
    expect(retryAfterMs(headers('Mon, 14 Sep 2026 12:00:10 GMT'), now)).toBe(10_000);
    // A date already in the past means "now", not a negative sleep.
    expect(retryAfterMs(headers('Mon, 14 Sep 2026 11:59:00 GMT'), now)).toBe(0);
  });

  it('ignores a header it cannot use', () => {
    expect(retryAfterMs(headers())).toBeUndefined();
    expect(retryAfterMs(headers('soon'))).toBeUndefined();
    expect(retryAfterMs(undefined)).toBeUndefined();
  });

  it('caps a server asking us to wait out the owner', () => {
    expect(retryAfterMs(headers('3600'))).toBe(MAX_RETRY_AFTER_MS);
  });

  it('takes the server window when it is longer than the curve, the curve otherwise', () => {
    expect(nextDelayMs(1)).toBe(RETRY_DELAYS_MS[0]);
    expect(nextDelayMs(1, headers('7'))).toBe(7000);
    // A window shorter than our own backoff does not make us hammer sooner.
    expect(nextDelayMs(3, headers('1'))).toBe(RETRY_DELAYS_MS[2]);
  });
});
