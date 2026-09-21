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
import { forgetProjectedSizes } from './context-budget.js';
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

/* ------------------------------------------------------------------ *
 * The budget follows the model, and is measured on what is sent
 * ------------------------------------------------------------------ */

describe('the size rule against a projection', () => {
  it('reads the projected tokens when there are any, not the stored rows', () => {
    // 300k characters of stored page trees that reduce to 10k tokens when sent
    // is a conversation that has outgrown nothing.
    const limits = { maxChars: 80_000, maxTokens: 100_000 };
    expect(conversationExpiry(vitals({ chars: 300_000, projectedTokens: 10_000 }), NOW, limits)).toBeNull();
    expect(conversationExpiry(vitals({ chars: 300_000, projectedTokens: 120_000 }), NOW, limits)).toBe('size');
  });

  it('falls back to the stored characters when nobody has projected it', () => {
    expect(conversationExpiry(vitals({ chars: 95_221 }), NOW)).toBe('size');
  });
});

/**
 * A pool that answers the three questions `conversationForTurn` now asks: the
 * vitals, the model binding, and the stored turns.
 */
function modelPool(over: {
  chars?: number;
  model?: string;
  kind?: string;
  override?: number | null;
  rows?: Array<{ role: string; content: unknown }>;
} = {}): Queryable & { lines: string[] } {
  const v = vitals({ chars: over.chars ?? 95_221, messages: 65 });
  return {
    lines: [],
    query: vi.fn(async (sql: string): Promise<{ rows: Row[] }> => {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (text.startsWith('select coalesce(count(m.id), 0) as messages')) {
        return { rows: [{ messages: v.messages, last_at: v.lastActivityAt, chars: v.chars }] };
      }
      if (text.startsWith('select b.model as model')) {
        return over.model === undefined
          ? { rows: [] }
          : { rows: [{ model: over.model, kind: over.kind ?? 'anthropic', override: over.override ?? null }] };
      }
      if (text.startsWith('select default_model as model')) return { rows: [] };
      if (text.startsWith('select role, content from core.messages')) return { rows: over.rows ?? [] };
      if (text.startsWith('update core.offers')) return { rows: [] };
      throw new Error(`unexpected sql: ${text}`);
    }),
  } as unknown as Queryable & { lines: string[] };
}

describe('the size limit a conversation is held to', () => {
  const start = vi.fn(async () => 'fresh');

  it('is the bound model\'s window, so a big model keeps a long transcript', async () => {
    // 95k characters ended a conversation when the cap was flat. Against a
    // 200k-token window it is a fraction of the budget and nothing happens.
    const out = await conversationForTurn(modelPool({ model: 'claude-opus-5' }), {
      current: 'old', start, now: NOW,
    });
    expect(out.boundary).toBeUndefined();
  });

  it('still ends one that is over even that', async () => {
    const out = await conversationForTurn(
      modelPool({ model: 'claude-opus-5', chars: 900_000, rows: [{ role: 'user', content: [{ type: 'text', text: 'z'.repeat(900_000) }] }] }),
      { current: 'old', start, now: NOW },
    );
    expect(out.boundary?.reason).toBe('size');
  });

  it('keeps the old behaviour when nothing is known about the model', async () => {
    const out = await conversationForTurn(
      modelPool({ rows: [{ role: 'user', content: [{ type: 'text', text: 'z'.repeat(95_000) }] }] }),
      { current: 'old', start, now: NOW },
    );
    expect(out.boundary?.reason).toBe('size');
  });

  it('honours a small window the owner declared, rather than the legacy floor', async () => {
    // 8,000 tokens is 4,000 of transcript. A 60k-character conversation is far
    // past that, even though it is under the constant that used to be a floor.
    const out = await conversationForTurn(
      modelPool({ model: 'llama3', kind: 'openai-compatible', override: 8_000, chars: 60_000,
        rows: [{ role: 'user', content: [{ type: 'text', text: 'z'.repeat(60_000) }] }] }),
      { current: 'old', start, now: NOW },
    );
    expect(out.boundary?.reason).toBe('size');
  });

  it('charges CJK what it costs: the same length in Japanese does not fit', async () => {
    // 120,000 characters is 33k tokens of English and 120k tokens of Japanese.
    // Against a 200k-token window — 100k of transcript — one fits and one does
    // not, and a character count cannot tell them apart.
    const japanese = '銀行残高'.repeat(30_000);
    const english = 'a'.repeat(japanese.length);
    const over = await conversationForTurn(
      modelPool({ model: 'claude-opus-5', chars: japanese.length,
        rows: [{ role: 'user', content: [{ type: 'text', text: japanese }] }] }),
      { current: 'old', start, now: NOW },
    );
    expect(over.boundary?.reason).toBe('size');

    forgetProjectedSizes();
    const under = await conversationForTurn(
      modelPool({ model: 'claude-opus-5', chars: english.length,
        rows: [{ role: 'user', content: [{ type: 'text', text: english }] }] }),
      { current: 'old', start, now: NOW },
    );
    expect(under.boundary).toBeUndefined();
  });

  it('counts the projection: page trees nobody sends do not end a conversation', async () => {
    // Twelve browser steps: 300k stored, a tenth of that once the spent
    // observations are a line each. Under the old count this rolled over and
    // the agent lost its task mid-session.
    const tree = 'y'.repeat(20_000);
    const rows = Array.from({ length: 12 }, (_, i) => [
      { role: 'assistant', content: [{ type: 'tool_use', id: `c${i}`, name: 'browser.act', input: { action: 'click' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `c${i}`, content: JSON.stringify({ observation: { id: `o${i}`, url: `https://bank/${i}`, title: `P${i}`, tree } }) }] },
    ]).flat();
    const out = await conversationForTurn(modelPool({ chars: 300_000, rows }), {
      current: 'old', start, now: NOW,
    });
    expect(out.boundary).toBeUndefined();
  });

  it('measures a conversation over the precheck once, not on every turn', async () => {
    // A browser conversation sits above the character precheck for ever, and
    // the projection is a read of the whole transcript. It is paid once per
    // version of it.
    const tree = 'y'.repeat(20_000);
    const rows = Array.from({ length: 12 }, (_, i) => [
      { role: 'assistant', content: [{ type: 'tool_use', id: `c${i}`, name: 'browser.act', input: { action: 'click' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: `c${i}`, content: JSON.stringify({ observation: { id: `o${i}`, url: `https://bank/${i}`, title: `P${i}`, tree } }) }] },
    ]).flat();
    forgetProjectedSizes();
    const pool = modelPool({ model: 'claude-opus-5', chars: 300_000, rows });
    await conversationForTurn(pool, { current: 'cached-one', start, now: NOW });
    await conversationForTurn(pool, { current: 'cached-one', start, now: NOW });
    const reads = (pool.query as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter(([sql]) => String(sql).replace(/\s+/g, ' ').trim().startsWith('select role, content from core.messages'));
    expect(reads).toHaveLength(1);
  });

  it('says in the log what ended, why, and against what', async () => {
    const lines: string[] = [];
    const out = await conversationForTurn(
      modelPool({ model: 'claude-opus-5', chars: 900_000, rows: [{ role: 'user', content: [{ type: 'text', text: 'z'.repeat(900_000) }] }] }),
      { current: 'old', start, now: NOW, log: (line) => lines.push(line) },
    );
    expect(out.boundary?.reason).toBe('size');
    const line = lines.find((l) => l.includes('ended'))!;
    expect(line).toContain('size');
    expect(line).toContain('stored chars');
    expect(line).toContain('projected tokens');
    expect(line).toContain('limit');
    expect(line).toContain('binding');
    expect(line).toContain('claude-opus-5');
    expect(line.split('\n')).toHaveLength(1);
  });
});
