/**
 * The cause chain — the thing that was missing on the day this was written.
 *
 * The shape under test is the real one: Node's `fetch` rejects with a
 * `TypeError` whose message is `fetch failed` and whose `cause` is the error
 * that actually happened. Every assertion here is about getting to that second
 * error, and about the walk being safe to run from a `catch` block on anything.
 */
import { describe, expect, it } from 'vitest';
import { causeChain, describeCause, errorCodes, rootMessage } from './cause.js';

/** What Node really throws when a pooled HTTP/2 session has been destroyed. */
function wedgedFetchError(): Error {
  const inner = Object.assign(new Error('The session has been destroyed'), {
    code: 'ERR_HTTP2_INVALID_SESSION',
  });
  return new TypeError('fetch failed', { cause: inner });
}

describe('causeChain', () => {
  it('walks past the wrapper to the error that actually happened', () => {
    const chain = causeChain(wedgedFetchError());
    expect(chain).toHaveLength(2);
    expect(chain[0]).toMatchObject({ name: 'TypeError', message: 'fetch failed' });
    expect(chain[1]).toMatchObject({
      message: 'The session has been destroyed',
      code: 'ERR_HTTP2_INVALID_SESSION',
    });
  });

  it('keeps the socket fields a person would search for', () => {
    const inner = Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
      errno: -54,
      syscall: 'read',
      address: '2607:6bc0::10',
      port: 443,
    });
    const chain = causeChain(new TypeError('fetch failed', { cause: inner }));
    expect(chain[1]).toEqual({
      name: 'Error',
      message: 'read ECONNRESET',
      code: 'ECONNRESET',
      errno: -54,
      syscall: 'read',
      address: '2607:6bc0::10',
      port: 443,
    });
  });

  it('includes the members of an AggregateError', () => {
    // What a host with both an A and an AAAA record fails as.
    const aggregate = new AggregateError(
      [
        Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('connect EHOSTUNREACH'), { code: 'EHOSTUNREACH' }),
      ],
      'all attempts failed',
    );
    expect(errorCodes(new TypeError('fetch failed', { cause: aggregate }))).toEqual([
      'ECONNREFUSED',
      'EHOSTUNREACH',
    ]);
  });

  it('terminates on a cycle instead of hanging the process', () => {
    const a = new Error('a');
    const b = new Error('b');
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;
    expect(causeChain(a)).toHaveLength(2);
  });

  it('terminates on a chain longer than the cap', () => {
    let err = new Error('bottom');
    for (let i = 0; i < 50; i += 1) err = new Error(`level ${i}`, { cause: err });
    expect(causeChain(err).length).toBeLessThanOrEqual(8);
    expect(causeChain(err, 3)).toHaveLength(3);
  });

  it('survives being handed something that is not an error at all', () => {
    expect(() => causeChain('just a string')).not.toThrow();
    expect(() => causeChain(null)).not.toThrow();
    expect(() => causeChain(undefined)).not.toThrow();
    expect(describeCause('just a string')).toContain('just a string');
  });
});

describe('describeCause', () => {
  it('is the one line the log was missing', () => {
    expect(describeCause(wedgedFetchError())).toBe(
      'TypeError: fetch failed <- Error: The session has been destroyed [ERR_HTTP2_INVALID_SESSION]',
    );
  });
});

describe('rootMessage', () => {
  it('is the innermost sentence, not the wrapper', () => {
    expect(rootMessage(wedgedFetchError())).toBe('The session has been destroyed');
  });
});
