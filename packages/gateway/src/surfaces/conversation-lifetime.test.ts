/**
 * The lifetime rule, without a database or a clock.
 *
 * The two numbers are the argument, so they are the thing pinned hardest: ten
 * minutes later is the same conversation, the next morning is not, and a
 * transcript that has grown past the budget ends whatever the clock says. The
 * live failure behind the second number is conversation `187f53bf`: 65
 * messages, 95k characters, and a 64,177-token turn to answer one question.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Queryable } from '@buddi/core';
import {
  boundaryNote,
  conversationExpiry,
  conversationForTurn,
  IDLE_TIMEOUT_MS,
  MAX_TRANSCRIPT_CHARS,
  readVitals,
  sinceText,
  type ConversationVitals,
} from './conversation-lifetime.js';

const NOW = new Date('2026-09-15T20:39:00.000Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

const vitals = (over: Partial<ConversationVitals> = {}): ConversationVitals => ({
  messages: 12,
  lastActivityAt: ago(10 * MINUTE),
  chars: 4_000,
  ...over,
});

describe('when a conversation is still live', () => {
  it('ten minutes later, which is finishing a thought', () => {
    expect(conversationExpiry(vitals(), NOW)).toBeNull();
  });

  it('two hours and fifty-nine minutes later', () => {
    expect(conversationExpiry(vitals({ lastActivityAt: ago(IDLE_TIMEOUT_MS - MINUTE) }), NOW)).toBeNull();
  });

  it('with a transcript just under the budget', () => {
    expect(conversationExpiry(vitals({ chars: MAX_TRANSCRIPT_CHARS }), NOW)).toBeNull();
  });

  it('when it is empty, whatever its age', () => {
    // `buddi chat` opens one on start and the dashboard's button makes one
    // before anything is typed. Rolling that over would mean a first message
    // that starts a second conversation.
    expect(conversationExpiry(vitals({ messages: 0, lastActivityAt: null, chars: 0 }), NOW)).toBeNull();
  });
});

describe('when a conversation has ended', () => {
  it('after the idle window — a message the next morning', () => {
    expect(conversationExpiry(vitals({ lastActivityAt: ago(14 * HOUR) }), NOW)).toBe('idle');
  });

  it('once the transcript has grown past its budget', () => {
    // The runaway, measured: 95,221 characters over 65 messages.
    expect(conversationExpiry(vitals({ messages: 65, chars: 95_221 }), NOW)).toBe('size');
  });

  it('idle wins over size, because it is the more honest reason', () => {
    expect(
      conversationExpiry(vitals({ lastActivityAt: ago(14 * HOUR), chars: 95_221 }), NOW),
    ).toBe('idle');
  });
});

describe('what the owner reads', () => {
  it('names how long it had been', () => {
    const note = boundaryNote('idle', vitals({ lastActivityAt: ago(14 * HOUR) }), NOW);
    expect(note).toBe(
      '(New conversation — we last spoke 14 hours ago. What I remember about you carries over.)',
    );
  });

  it('says plainly that the last one had grown, without a number nobody can use', () => {
    expect(boundaryNote('size', vitals({ chars: 95_221 }), NOW)).toBe(
      '(New conversation — the last one had grown long. What I remember about you carries over.)',
    );
  });

  it('is one plain-text line: it has to read the same on Telegram as at a prompt', () => {
    const note = boundaryNote('idle', vitals({ lastActivityAt: ago(14 * HOUR) }), NOW);
    expect(note).not.toMatch(/[*_`#|]/);
    expect(note.split('\n')).toHaveLength(1);
  });

  it('counts the gap in the coarsest honest unit', () => {
    expect(sinceText(ago(30 * 1000), NOW)).toBe('1 minute');
    expect(sinceText(ago(9 * MINUTE), NOW)).toBe('9 minutes');
    expect(sinceText(ago(1 * HOUR), NOW)).toBe('1 hour');
    expect(sinceText(ago(14 * HOUR), NOW)).toBe('14 hours');
    expect(sinceText(ago(50 * HOUR), NOW)).toBe('2 days');
  });
});

/* ------------------------------------------------------------------ *
 * The surface-facing half
 * ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

function fakePool(over: { vitals?: Partial<ConversationVitals>; fail?: boolean } = {}): Queryable & {
  withdrawn: string[];
} {
  const withdrawn: string[] = [];
  const v = vitals(over.vitals ?? {});
  return {
    withdrawn,
    query: vi.fn(async (sql: string, params: unknown[] = []): Promise<{ rows: Row[] }> => {
      if (over.fail) throw new Error('database is down');
      const text = sql.replace(/\s+/g, ' ').trim();
      if (text.startsWith('select coalesce(count(m.id), 0) as messages')) {
        return {
          rows: [{ messages: v.messages, last_at: v.lastActivityAt, chars: v.chars }],
        };
      }
      if (text.startsWith('update core.offers')) {
        withdrawn.push(String(params[0]));
        return { rows: [{ id: 'offer-1' }] };
      }
      throw new Error(`unexpected sql: ${text}`);
    }),
  } as unknown as Queryable & { withdrawn: string[] };
}

describe('the conversation a turn runs in', () => {
  const start = vi.fn(async () => 'fresh');

  it('is the one we were in, when it is still live', async () => {
    const pool = fakePool();
    const out = await conversationForTurn(pool, { current: 'old', start, now: NOW });
    expect(out.conversationId).toBe('old');
    expect(out.boundary).toBeUndefined();
  });

  it('is a new one when the old one had ended, and says so', async () => {
    const pool = fakePool({ vitals: { lastActivityAt: ago(14 * HOUR) } });
    const out = await conversationForTurn(pool, { current: 'old', start, now: NOW });
    expect(out.conversationId).toBe('fresh');
    expect(out.boundary?.reason).toBe('idle');
    expect(out.boundary?.previousConversationId).toBe('old');
    expect(out.boundary?.note).toContain('New conversation');
  });

  it('withdraws what the ended conversation still had on the table', async () => {
    // An offer belongs to the turn that made it; a boundary is the strongest
    // version of "the owner moved on". The tap then gets "that option has
    // expired" rather than a run against a thread nobody is in.
    const pool = fakePool({ vitals: { lastActivityAt: ago(14 * HOUR) } });
    await conversationForTurn(pool, { current: 'old', start, now: NOW });
    expect(pool.withdrawn).toEqual(['old']);
  });

  it('never cuts between a question and its answer', async () => {
    // The owner answering "what time tonight?" reaches the agent that asked,
    // in the conversation it asked in, whatever the size rule would say.
    const pool = fakePool({ vitals: { chars: 95_221 } });
    const out = await conversationForTurn(pool, {
      current: 'old',
      start,
      now: NOW,
      continuation: true,
    });
    expect(out.conversationId).toBe('old');
    expect(out.boundary).toBeUndefined();
  });

  it('starts one when there is none, and calls that no boundary', async () => {
    const pool = fakePool();
    const out = await conversationForTurn(pool, { start, now: NOW });
    expect(out.conversationId).toBe('fresh');
    expect(out.boundary).toBeUndefined();
  });

  it('carries on where it was when the database cannot answer', async () => {
    // A machine that cannot count a transcript must still answer the owner.
    const lines: string[] = [];
    const pool = fakePool({ fail: true });
    const out = await conversationForTurn(pool, {
      current: 'old',
      start,
      now: NOW,
      log: (line) => lines.push(line),
    });
    expect(out.conversationId).toBe('old');
    expect(lines.join('\n')).toContain('database is down');
  });

  it('honours limits a caller narrows, so a test never sleeps three hours', async () => {
    const pool = fakePool({ vitals: { lastActivityAt: ago(2 * MINUTE) } });
    const out = await conversationForTurn(pool, {
      current: 'old',
      start,
      now: NOW,
      idleMs: MINUTE,
    });
    expect(out.boundary?.reason).toBe('idle');
  });
});

describe('reading the vitals', () => {
  it('reports an unknown conversation as empty rather than throwing', async () => {
    const pool = { query: vi.fn(async () => ({ rows: [] })) } as unknown as Queryable;
    expect(await readVitals(pool, 'gone')).toEqual({
      messages: 0,
      lastActivityAt: null,
      chars: 0,
    });
  });
});
