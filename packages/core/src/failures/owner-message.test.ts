/**
 * What the owner is told when a turn fails.
 *
 * The load-bearing assertion in this file is the negative one: **nothing the
 * owner reads contains the raw error**. Everything else — which sentence, which
 * class, whether a retry is offered — follows from the same classifier the
 * durable queue uses, so the message and the decision can never disagree.
 */
import { describe, expect, it } from 'vitest';
import {
  credentialEnvVar,
  describeFailure,
  renderFailure,
  RETRY_OFFER_LABEL,
} from './owner-message.js';

/** The error the owner actually hit, in the shape the adapter produces. */
function transportError(): Error {
  const wire = new TypeError('fetch failed', {
    cause: Object.assign(new Error('The session has been destroyed'), {
      code: 'ERR_HTTP2_INVALID_SESSION',
    }),
  });
  return Object.assign(new Error('fetch failed', { cause: wire }), {
    name: 'ProviderError',
    status: 0,
    type: 'transport_error',
  });
}

function httpError(status: number, type = 'http_error'): Error {
  return Object.assign(new Error(`${status} refused`), {
    name: 'ProviderError',
    status,
    type,
  });
}

/** Everything a surface may show. Nothing else is ever put in front of a person. */
const shown = (err: unknown): string => renderFailure(err).text;

describe('the raw error never reaches the owner', () => {
  const leaks = [
    'fetch failed',
    'undici',
    'ECONNRESET',
    'ERR_HTTP2_INVALID_SESSION',
    'TypeError',
    'ProviderError',
    'at Object.',
  ];

  for (const err of [
    transportError(),
    httpError(400, 'invalid_request_error'),
    httpError(401, 'authentication_error'),
    httpError(503),
    new Error('something nobody has ever seen before'),
    Object.assign(new Error('bad shape'), { name: 'ZodError' }),
  ]) {
    it(`says nothing internal for: ${(err as Error).message}`, () => {
      const text = shown(err);
      for (const leak of leaks) expect(text).not.toContain(leak);
      expect(text).not.toMatch(/[a-z]+\.[a-z_]+\(/); // no tool names
    });
  }

  it('keeps the whole chain on `detail`, for the log', () => {
    const described = describeFailure(transportError());
    expect(described.detail).toContain('fetch failed');
    expect(described.detail).toContain('ERR_HTTP2_INVALID_SESSION');
    expect(described.text).not.toContain('ERR_HTTP2_INVALID_SESSION');
  });
});

describe('transient', () => {
  it('says it could not reach the model, and that trying again usually works', () => {
    const out = describeFailure(transportError());
    expect(out.class).toBe('transient');
    expect(out.text).toContain("couldn't reach the model");
    expect(out.text).toContain('trying again usually works');
    expect(out.retryable).toBe(true);
  });

  it('treats an overloaded provider the same way', () => {
    expect(describeFailure(httpError(529, 'overloaded_error')).class).toBe('transient');
    expect(describeFailure(httpError(429, 'rate_limit_error')).retryable).toBe(true);
    expect(describeFailure(httpError(503)).retryable).toBe(true);
  });
});

describe('permanent', () => {
  it('never offers a retry, because the second attempt fails identically', () => {
    for (const err of [httpError(400, 'invalid_request_error'), httpError(404, 'not_found_error')]) {
      const out = describeFailure(err);
      expect(out.class).toBe('permanent');
      expect(out.retryable).toBe(false);
      expect(out.text).toContain('trying again would fail');
    }
  });

  it('names the environment variable and how to set it', () => {
    const missing = new Error(
      'agent "mail-triage" (@postman) cannot run [missing-credential]: ' +
        'environment variable ANTHROPIC_API_KEY is not set',
    );
    const out = describeFailure(missing, { agentName: '@postman' });
    expect(out.class).toBe('permanent');
    expect(out.retryable).toBe(false);
    expect(out.text).toContain('ANTHROPIC_API_KEY');
    expect(out.text).toContain('.env');
    expect(out.text).toContain('restart buddi');
    expect(out.text).toContain('@postman');
  });

  it('gives the subscription token its own instruction', () => {
    const out = describeFailure(
      new Error('[empty-credential]: environment variable CLAUDE_CODE_OAUTH_TOKEN is empty'),
    );
    expect(out.text).toContain('claude setup-token');
  });

  it('says a refused key is a key to replace, when it cannot name one', () => {
    const out = describeFailure(httpError(401, 'authentication_error'));
    expect(out.text).toContain('refused the credential');
    expect(out.text).toContain('expired');
    expect(out.retryable).toBe(false);
  });
});

describe('unknown', () => {
  it('apologises, keeps the detail for the log, and still offers a way forward', () => {
    const out = describeFailure(new Error('an entirely novel disaster'));
    expect(out.class).toBe('unknown');
    expect(out.text).toContain('Sorry');
    expect(out.text).not.toContain('novel disaster');
    expect(out.detail).toContain('novel disaster');
    expect(out.retryable).toBe(true);
  });
});

describe('renderFailure — a turn that had already done something', () => {
  it('offers the retry when nothing ran', () => {
    const out = renderFailure(transportError(), { toolsCalled: 0 });
    expect(out.offerRetry).toBe(true);
    expect(out.text).not.toContain('already got through');
  });

  it('withholds it, and says why, when a tool had already run', () => {
    const out = renderFailure(transportError(), { toolsCalled: 4 });
    expect(out.offerRetry).toBe(false);
    expect(out.text).toContain('4 steps');
    expect(out.text).toContain('repeat work');
  });

  it('counts one step as one step', () => {
    expect(renderFailure(transportError(), { toolsCalled: 1 }).text).toContain('one step');
  });

  it('never offers it for a permanent failure, tools or no tools', () => {
    expect(renderFailure(httpError(400, 'invalid_request_error'), { toolsCalled: 0 }).offerRetry)
      .toBe(false);
    expect(renderFailure(httpError(400, 'invalid_request_error'), { toolsCalled: 3 }).offerRetry)
      .toBe(false);
  });

  it('has a label short enough for a button', () => {
    expect(RETRY_OFFER_LABEL.length).toBeLessThanOrEqual(28);
  });
});

describe('credentialEnvVar', () => {
  it('reads the variable out of the sentence resolveProvider writes', () => {
    expect(credentialEnvVar(new Error('environment variable OPENAI_API_KEY is not set'))).toBe(
      'OPENAI_API_KEY',
    );
    expect(credentialEnvVar(new Error('environment variable X_TOKEN is empty'))).toBe('X_TOKEN');
    expect(credentialEnvVar(new Error('nothing about credentials'))).toBeUndefined();
  });
});
