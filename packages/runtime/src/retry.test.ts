import { describe, expect, it } from 'vitest';
import {
  isRetryableStatus,
  MAX_RETRY_AFTER_MS,
  MAX_TRANSPORT_ATTEMPTS,
  nextDelayMs,
  nextTransportDelayMs,
  RETRY_DELAYS_MS,
  retryAfterMs,
  TRANSPORT_RETRY_DELAYS_MS,
  TRANSPORT_RETRY_WINDOW_MS,
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

/**
 * The transport budget, and the promise that comes with it.
 *
 * Two things must stay true, and a test is the only way they do: it always
 * terminates, and the worst case is a number somebody is willing to wait.
 */
describe('the transport retry budget', () => {
  it('rides out longer than the four seconds that killed the owner\u2019s turn', () => {
    const total = TRANSPORT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
    expect(total).toBe(13_000);
    expect(total).toBeGreaterThan(RETRY_DELAYS_MS.reduce((a, b) => a + b, 0));
  });

  it('starts fast, because the common case is one dead connection', () => {
    expect(nextTransportDelayMs(1, 0)).toBeLessThanOrEqual(250);
  });

  it('terminates: the curve runs out', () => {
    let attempt = 1;
    let waited = 0;
    for (;;) {
      const delay = nextTransportDelayMs(attempt, waited);
      if (delay === undefined) break;
      waited += delay;
      attempt += 1;
      expect(attempt).toBeLessThanOrEqual(MAX_TRANSPORT_ATTEMPTS + 1);
    }
    // Six attempts in total: the first, then five retries.
    expect(attempt).toBe(MAX_TRANSPORT_ATTEMPTS);
    expect(MAX_TRANSPORT_ATTEMPTS).toBe(6);
  });

  it('terminates on the window too, when the attempts themselves are slow', () => {
    // Every attempt took four seconds to fail: the curve has delays left, and
    // the window stops it anyway. This is what bounds the worst case.
    expect(nextTransportDelayMs(1, 4_000)).toBe(250);
    expect(nextTransportDelayMs(3, 18_500)).toBeUndefined();
    expect(nextTransportDelayMs(2, TRANSPORT_RETRY_WINDOW_MS)).toBeUndefined();
  });

  it('never starts an attempt more than the window after the first', () => {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      for (const elapsed of [0, 1_000, 5_000, 12_000, 19_999, 20_000, 60_000]) {
        const delay = nextTransportDelayMs(attempt, elapsed);
        if (delay !== undefined) expect(elapsed + delay).toBeLessThanOrEqual(TRANSPORT_RETRY_WINDOW_MS);
      }
    }
  });
});
