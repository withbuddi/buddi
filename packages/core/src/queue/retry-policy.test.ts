/**
 * The retry policy: how long unattended work keeps trying, and which failures
 * deserve any of that time at all.
 *
 * These are the two halves of the September 14 incident. A transport error got
 * six minutes and the mail was lost; a rejected tool schema, on the same day,
 * failed identically on every attempt and must not now be handed six hours.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  decideRetry,
  INTERACTIVE_RETRY_PROFILE,
  isUnattendedKind,
  retryDelayMs,
  retryProfileFor,
  UNATTENDED_RETRY_PROFILE,
} from './retry-policy.js';

const NOW = new Date('2026-09-14T17:31:00Z');

/** The shape a provider error arrives with. Never imported: core cannot. */
function providerError(status: number, type: string, message = 'boom'): Error {
  return Object.assign(new Error(message), { status, type, name: 'ProviderError' });
}

describe('classifyFailure', () => {
  it('reads a transport failure as transient — this is what killed the triage runs', () => {
    expect(classifyFailure(providerError(0, 'transport_error', 'fetch failed')).class).toBe(
      'transient',
    );
    // Even with no typed error at all: the bare message is the last resort.
    expect(classifyFailure(new Error('fetch failed')).class).toBe('transient');
  });

  it('reads rate limits, overload and 5xx as transient', () => {
    for (const status of [429, 500, 502, 503, 529]) {
      expect(classifyFailure(providerError(status, 'http_error')).class).toBe('transient');
    }
    expect(classifyFailure(providerError(0, 'rate_limit_error')).class).toBe('transient');
  });

  it('reads socket and database connection codes as transient', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', '57P01', '08006']) {
      expect(classifyFailure(Object.assign(new Error('x'), { code })).class).toBe('transient');
    }
  });

  it('reads a rejected schema as permanent — it will fail the same way for ever', () => {
    const schemaBug = providerError(
      400,
      'invalid_request_error',
      'tools.0.custom.input_schema: does not match the expected shape',
    );
    const verdict = classifyFailure(schemaBug);
    expect(verdict.class).toBe('permanent');
    expect(verdict.reason).toContain('invalid_request_error');
  });

  it('reads auth, permission and other 4xx as permanent', () => {
    expect(classifyFailure(providerError(401, 'authentication_error')).class).toBe('permanent');
    expect(classifyFailure(providerError(403, 'permission_error')).class).toBe('permanent');
    expect(classifyFailure(providerError(404, 'not_found_error')).class).toBe('permanent');
    expect(classifyFailure(providerError(413, 'request_too_large')).class).toBe('permanent');
  });

  it('reads our own bugs as permanent', () => {
    expect(classifyFailure(new TypeError('x is not a function')).class).toBe('permanent');
    expect(classifyFailure(Object.assign(new Error('bad'), { name: 'ZodError' })).class).toBe(
      'permanent',
    );
  });

  it('calls an unrecognised failure unknown rather than guessing either way', () => {
    expect(classifyFailure(new Error('something nobody has seen before')).class).toBe('unknown');
  });

  it('lets a typed error outrank a misleading message', () => {
    // A 400 whose text happens to mention the network is still a 400.
    expect(
      classifyFailure(providerError(400, 'invalid_request_error', 'connection reset is not why'))
        .class,
    ).toBe('permanent');
  });
});

describe('profiles', () => {
  it('gives unattended kinds hours and interactive ones minutes', () => {
    expect(isUnattendedKind('agent-run')).toBe(true);
    expect(isUnattendedKind('mission-run')).toBe(true);
    expect(isUnattendedKind('telegram-turn')).toBe(false);

    expect(retryProfileFor('agent-run')).toBe(UNATTENDED_RETRY_PROFILE);
    expect(retryProfileFor('telegram-turn')).toBe(INTERACTIVE_RETRY_PROFILE);

    // The whole point: the background horizon is hours, the foreground is not.
    expect(UNATTENDED_RETRY_PROFILE.maxLifetimeMs).toBeGreaterThanOrEqual(6 * 3_600_000);
    expect(INTERACTIVE_RETRY_PROFILE.maxLifetimeMs).toBeLessThanOrEqual(15 * 60_000);
    expect(INTERACTIVE_RETRY_PROFILE.maxAttempts).toBe(3);
  });

  it('escalates and never resets', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) =>
      retryDelayMs(UNATTENDED_RETRY_PROFILE, n),
    );
    for (let i = 1; i < delays.length; i += 1) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1] as number);
    }
    expect(delays[0]).toBe(60_000);
    expect(delays.at(-1)).toBe(3_600_000);
  });
});

describe('decideRetry', () => {
  const dead = (over: Partial<Parameters<typeof decideRetry>[0]> = {}): ReturnType<
    typeof decideRetry
  > =>
    decideRetry({
      kind: 'agent-run',
      attempts: 1,
      maxAttempts: UNATTENDED_RETRY_PROFILE.maxAttempts,
      createdAt: new Date(NOW.getTime() - 60_000),
      now: NOW,
      error: new Error('fetch failed'),
      ...over,
    });

  it('keeps an unattended job trying after the sixth minute, which is where it used to die', () => {
    const afterSixMinutes = dead({
      attempts: 3,
      createdAt: new Date(NOW.getTime() - 6 * 60_000),
    });
    expect(afterSixMinutes.retry).toBe(true);
    expect(afterSixMinutes.backoffMs).toBe(900_000);
  });

  it('still fails an interactive job fast', () => {
    const interactive = dead({ kind: 'telegram-turn', attempts: 3, maxAttempts: 3 });
    expect(interactive.retry).toBe(false);
    expect(interactive.reason).toContain('gave up after 3 attempts');
  });

  it('never retries a permanent failure, however much horizon is left', () => {
    const schemaBug = dead({
      attempts: 1,
      error: Object.assign(new Error('bad schema'), {
        status: 400,
        type: 'invalid_request_error',
      }),
    });
    expect(schemaBug.retry).toBe(false);
    expect(schemaBug.failureClass).toBe('permanent');
  });

  it('stops at the attempt cap', () => {
    expect(dead({ attempts: 8 }).retry).toBe(false);
  });

  it('retries an unrecognised failure, but only on the short horizon', () => {
    const unknown = { error: new Error('something nobody has seen before') };
    expect(dead({ attempts: 1, ...unknown }).retry).toBe(true);
    // Three attempts, not eight, even though this is unattended work.
    expect(dead({ attempts: 3, ...unknown }).retry).toBe(false);
    // And no six-hour window: twenty minutes in, it is over.
    expect(
      dead({ attempts: 1, createdAt: new Date(NOW.getTime() - 20 * 60_000), ...unknown }).retry,
    ).toBe(false);
    // Where the same job with a recognised transport failure is still going.
    expect(dead({ attempts: 1, createdAt: new Date(NOW.getTime() - 20 * 60_000) }).retry).toBe(true);
  });

  it('stops at the lifetime, and does not schedule a wake-up past it', () => {
    const old = dead({ attempts: 2, createdAt: new Date(NOW.getTime() - 6 * 3_600_000) });
    expect(old.retry).toBe(false);
    expect(old.reason).toContain('360 minutes');

    // 5h50m in: the next wait is an hour, which would land past the bound.
    const nearly = dead({ attempts: 5, createdAt: new Date(NOW.getTime() - 5.9 * 3_600_000) });
    expect(nearly.retry).toBe(false);
  });

  it('bounds the total: the curve plus the cap cannot exceed the lifetime', () => {
    let at = 0;
    let attempts = 1;
    while (attempts < UNATTENDED_RETRY_PROFILE.maxAttempts) {
      const decision = decideRetry({
        kind: 'agent-run',
        attempts,
        maxAttempts: UNATTENDED_RETRY_PROFILE.maxAttempts,
        createdAt: NOW,
        now: new Date(NOW.getTime() + at),
        error: new Error('fetch failed'),
      });
      if (!decision.retry) break;
      at += decision.backoffMs as number;
      attempts += 1;
    }
    expect(at).toBeLessThan(UNATTENDED_RETRY_PROFILE.maxLifetimeMs);
    expect(at).toBeGreaterThan(3 * 3_600_000);
  });
});
