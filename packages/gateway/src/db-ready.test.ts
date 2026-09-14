import { describe, expect, it, vi } from 'vitest';
import {
  databaseUnreachableMessage,
  describeDatabaseError,
  hostPortOf,
  isConnectionError,
  LOG_EVERY_MS,
  retryDelayMs,
  waitForDatabase,
} from './db-ready.js';

const URL_55433 = 'postgres://buddi:buddi@localhost:55433/buddi';

/** What `pg` actually throws when the container is gone: empty outer message. */
function refused(url = 'localhost:55433'): AggregateError {
  const one = Object.assign(new Error(`connect ECONNREFUSED ::1:55433`), {
    code: 'ECONNREFUSED',
  });
  const two = Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:55433`), {
    code: 'ECONNREFUSED',
  });
  const agg = new AggregateError([one, two], '');
  return Object.assign(agg, { url });
}

describe('hostPortOf', () => {
  it('names the host and port the owner configured', () => {
    expect(hostPortOf(URL_55433)).toBe('localhost:55433');
  });

  it('falls back to the raw string, and to a phrase when there is none', () => {
    expect(hostPortOf('not a url')).toBe('not a url');
    expect(hostPortOf(undefined)).toBe('the configured database');
    expect(hostPortOf('')).toBe('the configured database');
  });
});

describe('isConnectionError', () => {
  it('sees the code inside an AggregateError', () => {
    expect(isConnectionError(refused())).toBe(true);
  });

  it('sees a code carried on a cause', () => {
    const err = new Error('query failed', { cause: Object.assign(new Error('x'), { code: 'ECONNREFUSED' }) });
    expect(isConnectionError(err)).toBe(true);
  });

  it('does not claim every failure is a connection failure', () => {
    expect(isConnectionError(new Error('relation "core.jobs" does not exist'))).toBe(false);
    expect(isConnectionError(undefined)).toBe(false);
  });
});

describe('describeDatabaseError', () => {
  it('turns the empty AggregateError into one actionable sentence', () => {
    const message = describeDatabaseError(refused(), URL_55433);
    expect(message).toBe(
      'database not reachable at localhost:55433 — is Docker running? try: buddi db up',
    );
    expect(message).not.toContain('AggregateError');
  });

  it('unwraps a bare ECONNREFUSED the same way', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:55433'), {
      code: 'ECONNREFUSED',
    });
    expect(describeDatabaseError(err, URL_55433)).toBe(databaseUnreachableMessage(URL_55433));
  });

  it('keeps a real error message instead of inventing one', () => {
    expect(describeDatabaseError(new Error('password authentication failed'), URL_55433)).toBe(
      'password authentication failed',
    );
  });

  it('digs a message out of an AggregateError that is not about connecting', () => {
    const agg = new AggregateError([new Error('SSL required')], '');
    expect(describeDatabaseError(agg, URL_55433)).toBe('SSL required');
  });

  it('never returns an empty string', () => {
    expect(describeDatabaseError(new AggregateError([], ''), URL_55433)).toBe(
      databaseUnreachableMessage(URL_55433),
    );
    expect(describeDatabaseError(null, URL_55433)).not.toBe('');
  });
});

describe('retryDelayMs', () => {
  it('backs off 5s, 10s, 20s, 40s and then caps at a minute', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map(retryDelayMs)).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000,
    ]);
  });
});

describe('waitForDatabase', () => {
  it('returns straight away when the database is already up', async () => {
    const log = vi.fn();
    const probe = vi.fn(async () => {});
    await expect(waitForDatabase({ probe, log, sleep: async () => {} })).resolves.toBe(0);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(log).not.toHaveBeenCalled();
  });

  it('retries with the backoff instead of exiting, and starts when Docker comes up', async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      const slept: number[] = [];
      const probe = vi.fn(async () => {
        attempts += 1;
        if (attempts <= 3) throw refused();
      });
      const log = vi.fn();
      const pending = waitForDatabase({
        databaseUrl: URL_55433,
        probe,
        log,
        // Fake timers drive the delay: the loop is asked to wait, the clock is
        // advanced, and nothing real ever sleeps.
        sleep: (ms: number) =>
          new Promise<void>((resolve) => {
            slept.push(ms);
            setTimeout(resolve, ms);
          }),
        now: () => Date.now(),
      });
      await vi.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000);
      await expect(pending).resolves.toBe(3);
      expect(slept).toEqual([5_000, 10_000, 20_000]);
      expect(probe).toHaveBeenCalledTimes(4);
      expect(log.mock.calls.at(-1)?.[0]).toContain('database reachable again after 3 attempt(s)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says the sentence at most once a minute', async () => {
    const log = vi.fn();
    let clock = 0;
    await expect(
      waitForDatabase({
        databaseUrl: URL_55433,
        probe: async () => {
          throw refused();
        },
        sleep: async (ms: number) => {
          clock += ms;
        },
        now: () => clock,
        log,
        maxAttempts: 6,
      }),
    ).rejects.toBeInstanceOf(AggregateError);
    // 5s + 10s + 20s + 40s: only the first attempt and the one past the minute
    // mark are allowed to speak.
    expect(log.mock.calls.length).toBeLessThanOrEqual(3);
    expect(log.mock.calls[0]?.[0]).toContain(
      'database not reachable at localhost:55433 — is Docker running? try: buddi db up',
    );
    expect(log.mock.calls[0]?.[0]).toContain('retrying in 5s');
    expect(LOG_EVERY_MS).toBe(60_000);
  });
});
