/**
 * The two things about the page routes that are pure arithmetic: how many
 * writes a session gets, and how much the table of sessions is allowed to
 * remember. Both are bugs that only show up after months of uptime, which is
 * exactly when nobody is looking.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PAGE_ACT_RATE, PAGE_ACT_SESSIONS, actRateLimited, describeParams } from './pages.js';

describe('the act rate limit', () => {
  it('gives a session a minute\'s worth and then refuses', () => {
    const now = Date.now();
    const id = `session-${Math.random()}`;
    for (let i = 0; i < PAGE_ACT_RATE.perMinute; i += 1) {
      expect(actRateLimited(id, now)).toBe(false);
    }
    expect(actRateLimited(id, now)).toBe(true);
    // And the window moves: a minute later the budget is whole again.
    expect(actRateLimited(id, now + PAGE_ACT_RATE.windowMs + 1)).toBe(false);
  });

  it('forgets a session whose window has gone by, on the next call', () => {
    const now = Date.now();
    const quiet = `quiet-${Math.random()}`;
    actRateLimited(quiet, now);
    // Someone else writes, much later: the sweep drops the quiet session, so
    // its budget is not still being held a month from now.
    actRateLimited(`busy-${Math.random()}`, now + PAGE_ACT_RATE.windowMs * 10);
    for (let i = 0; i < PAGE_ACT_RATE.perMinute; i += 1) {
      expect(actRateLimited(quiet, now + PAGE_ACT_RATE.windowMs * 10)).toBe(false);
    }
  });

  it('remembers at most a bounded number of sessions', () => {
    const now = Date.now();
    // Every one of these is inside its window, so nothing is swept: the only
    // thing that can keep the table bounded is the eviction.
    const first = `flood-0-${Math.random()}`;
    actRateLimited(first, now);
    for (let i = 1; i < PAGE_ACT_SESSIONS + 50; i += 1) {
      actRateLimited(`flood-${i}-${Math.random()}`, now);
    }
    // The oldest writer was evicted, so it starts with a whole budget again —
    // which is the observable half of "the map does not grow for ever".
    for (let i = 0; i < PAGE_ACT_RATE.perMinute; i += 1) {
      expect(actRateLimited(first, now)).toBe(false);
    }
  });
});

describe('a query\'s parameters, as names and types', () => {
  it('reads them off the zod object without handing the schema out', () => {
    const schema = z
      .object({
        id: z.string(),
        limit: z.coerce.number().int().optional(),
        as: z.enum(['png', 'pdf']),
        all: z.enum(['true', 'false']).default('false'),
        since: z.string().transform((v) => v.trim()).nullable(),
      })
      .strict();
    expect(describeParams(schema)).toEqual({ id: 'string', limit: 'number?', as: 'png|pdf', all: 'true|false?', since: 'string' });
    expect(describeParams(z.object({}).strict())).toEqual({});
    expect(describeParams(z.string())).toEqual({});
  });
});
