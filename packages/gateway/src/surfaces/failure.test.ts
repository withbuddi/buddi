/**
 * What a surface says and offers when a turn dies.
 *
 * Three things are pinned here, and each of them is a thing that was wrong:
 * the owner never sees the raw error, the log always does, and the retry runs
 * the owner's own words — or is withheld, loudly, when running them again
 * could repeat work that already happened.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  CLI_SURFACE,
  OFFERS_PREAMBLE,
  SCHEDULED_SURFACE,
  TELEGRAM_SURFACE,
  WEB_SURFACE,
  type Queryable,
} from '@buddi/core';
import { failedTurnReply } from './failure.js';

/** One stored message, in the shape `core.messages` hands back. */
type StoredMessage = { role: string; content: unknown };

export type FakePool = Queryable & {
  /** `core.offers` rows written, in order. */
  inserted: Array<Record<string, unknown>>;
  /** `core.messages` rows, oldest first — the transcript. */
  messages: StoredMessage[];
};

/**
 * A pool that knows the three statements a failed turn makes: store the offer,
 * read the tail of the transcript, close it.
 *
 * Seeded with whatever the dead run had already written, because that is the
 * whole question `closeFailedTurn` answers — a turn ending on the owner's
 * message is hanging, one ending on an answer is not.
 */
function fakePool(seed: StoredMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]): FakePool {
  const inserted: Array<Record<string, unknown>> = [];
  const messages: StoredMessage[] = [...seed];
  return {
    inserted,
    messages,
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (text.startsWith('select role, content from core.messages')) {
        const last = messages[messages.length - 1];
        return { rows: last ? [last] : [] };
      }
      if (text.startsWith('insert into core.messages')) {
        messages.push({ role: String(params[1]), content: JSON.parse(String(params[2])) });
        return { rows: [] };
      }
      const row = {
        id: `offer-${inserted.length + 1}`,
        agent_id: params[0],
        conversation_id: params[1],
        label: params[2],
        prompt: params[3],
        created_at: params[4],
        expires_at: params[5],
        taken_at: null,
        taken_via: null,
        taken_job_id: null,
      };
      inserted.push(row);
      return { rows: [row] };
    }),
  } as unknown as FakePool;
}

const NOW = new Date('2026-09-15T17:37:00.000Z');

/** The error the owner actually hit, in the shape the adapter now throws. */
function transportError(): Error {
  return Object.assign(new Error('fetch failed'), {
    name: 'ProviderError',
    status: 0,
    type: 'transport_error',
    code: 'ERR_HTTP2_INVALID_SESSION',
    detail: 'fetch failed <- Error: The session has been destroyed [ERR_HTTP2_INVALID_SESSION]',
    cause: Object.assign(new Error('The session has been destroyed'), {
      code: 'ERR_HTTP2_INVALID_SESSION',
    }),
  });
}

function permanentError(): Error {
  return Object.assign(new Error('bad model'), {
    name: 'ProviderError',
    status: 400,
    type: 'invalid_request_error',
  });
}

const turn = (over: Record<string, unknown> = {}) => ({
  error: transportError(),
  profile: TELEGRAM_SURFACE,
  agentId: 'mail-triage',
  agentName: '@postman',
  conversationId: '11111111-1111-4111-8111-111111111111',
  prompt: 'Can you draft a response to Parfait Sedjro last mail of today?',
  toolsCalled: 0,
  now: NOW,
  ...over,
});

describe('a transient failure', () => {
  it('says something human, and never the raw error', async () => {
    const pool = fakePool();
    const out = await failedTurnReply(pool, turn());
    expect(out.rendered.text).toContain("couldn't reach the model");
    expect(out.rendered.text).not.toContain('fetch failed');
    expect(out.rendered.text).not.toContain('ERR_HTTP2_INVALID_SESSION');
  });

  it('puts the whole cause chain in the log, once', async () => {
    const lines: string[] = [];
    await failedTurnReply(fakePool(), turn({ log: (line: string) => lines.push(line) }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[transient]');
    expect(lines[0]).toContain('@postman');
    expect(lines[0]).toContain('ERR_HTTP2_INVALID_SESSION');
  });

  it('offers "Try again" as a button where the surface has buttons', async () => {
    const pool = fakePool();
    const out = await failedTurnReply(pool, turn());
    expect(out.rendered.controls).toHaveLength(1);
    expect(out.rendered.controls[0]?.label).toBe('Try again');
    // Buttons, so nothing is appended to the text.
    expect(out.rendered.text).not.toContain(OFFERS_PREAMBLE);
  });

  it('says it in words where the surface has none', async () => {
    const out = await failedTurnReply(fakePool(), turn({ profile: CLI_SURFACE }));
    expect(out.rendered.controls).toHaveLength(0);
    expect(out.rendered.text).toContain(OFFERS_PREAMBLE);
    expect(out.rendered.text).toContain('Try again');
  });

  it('draws a chip on the dashboard, from the profile and not the name', async () => {
    const out = await failedTurnReply(fakePool(), turn({ profile: WEB_SURFACE }));
    expect(out.rendered.controls).toHaveLength(1);
  });

  it('spells it out for a surface with nobody there, without inventing one', async () => {
    const out = await failedTurnReply(fakePool(), turn({ profile: SCHEDULED_SURFACE }));
    expect(out.rendered.controls).toHaveLength(0);
  });
});

describe('what a retry runs', () => {
  it('is the owner’s original message, verbatim', async () => {
    const pool = fakePool();
    const prompt = 'Can you draft a response to Parfait Sedjro last mail of today?';
    await failedTurnReply(pool, turn({ prompt }));
    expect(pool.inserted[0]?.prompt).toBe(prompt);
    expect(pool.inserted[0]?.agent_id).toBe('mail-triage');
  });

  it('is not truncated to the cap an agent-written offer lives under', async () => {
    const pool = fakePool();
    // A long message the owner really typed. Clipping it would mean the button
    // re-ran the first 500 characters of their question, which is not a retry.
    const prompt = `Please summarise this: ${'a'.repeat(3000)}`;
    await failedTurnReply(pool, turn({ prompt }));
    expect(pool.inserted[0]?.prompt).toBe(prompt);
    expect(String(pool.inserted[0]?.prompt)).not.toContain('…');
  });

  it('keeps the owner’s paragraph breaks rather than reflowing them', async () => {
    const pool = fakePool();
    const prompt = 'First thing.\n\nSecond thing.';
    await failedTurnReply(pool, turn({ prompt }));
    expect(pool.inserted[0]?.prompt).toBe(prompt);
  });
});

describe('when a retry is not offered', () => {
  it('never for a permanent failure, because it would fail identically', async () => {
    const pool = fakePool();
    const out = await failedTurnReply(pool, turn({ error: permanentError() }));
    expect(out.rendered.controls).toHaveLength(0);
    expect(out.offer).toBeUndefined();
    expect(pool.inserted).toHaveLength(0);
    expect(out.rendered.text).toContain('trying again would fail');
  });

  it('never when the failed turn had already called a tool', async () => {
    const pool = fakePool();
    // The owner's real failure: four mail searches, then the provider call.
    const out = await failedTurnReply(pool, turn({ toolsCalled: 4 }));
    expect(out.rendered.controls).toHaveLength(0);
    expect(pool.inserted).toHaveLength(0);
    expect(out.rendered.text).toContain('4 steps');
    expect(out.rendered.text).toContain('Tell me how you want to carry on');
  });

  it('never when there is no message to re-run', async () => {
    // A resumed approval, or the first-run greeting: no sentence of the
    // owner's behind it, so there is nothing a button could honestly repeat.
    const pool = fakePool();
    const out = await failedTurnReply(pool, turn({ prompt: undefined }));
    expect(pool.inserted).toHaveLength(0);
    expect(out.rendered.controls).toHaveLength(0);
  });
});

/*
 * The defect this half exists for: the owner's message is persisted before the
 * provider is called, so a dead run leaves a question in the transcript with
 * nothing after it — and the next run that works answers it. Live, that meant a
 * question about Parfait Sedjro asked at 17:32 was answered at 20:39, on top of
 * a question about somebody else.
 */
describe('closing the failed turn in the transcript', () => {
  const owner = { role: 'user', content: [{ type: 'text', text: 'draft a reply to Parfait Sedjro' }] };

  it('marks the owner’s unanswered message as a turn that failed', async () => {
    const pool = fakePool([owner]);
    const out = await failedTurnReply(pool, turn());
    expect(out.closure).toBe('closed');
    // His message is still there — deleting it would make the record lie the
    // other way — and it is followed by what actually happened.
    expect(pool.messages[0]).toBe(owner);
    const marker = pool.messages[1];
    expect(marker?.role).toBe('assistant');
    const text = String((marker?.content as any[])[0].text);
    expect(text).toContain('This turn failed before I could answer');
    expect(text).toContain('will not, unless you ask again');
    // A retry was offered, and the marker says so rather than guessing.
    expect(text).toContain('try it again');
  });

  it('says nothing about a retry when none was offered', async () => {
    const pool = fakePool([owner]);
    await failedTurnReply(pool, turn({ error: permanentError() }));
    const text = String((pool.messages[1]?.content as any[])[0].text);
    expect(text).not.toContain('try it again');
  });

  it('answers the tool calls the dead run left dangling', async () => {
    // The 17:33 turn: an assistant message with a tool_use, and a run that
    // never came back with the result. Sent as-is, the provider rejects it.
    const pool = fakePool([
      owner,
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_01', name: 'email.search', input: {} }] },
    ]);
    const out = await failedTurnReply(pool, turn());
    expect(out.closure).toBe('closed-with-tool-results');
    const results = pool.messages[2];
    expect(results?.role).toBe('user');
    expect((results?.content as any[])[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_01',
      is_error: true,
    });
    expect(pool.messages[3]?.role).toBe('assistant');
  });

  it('leaves an answered turn alone', async () => {
    // The run answered and then something after it threw. Nothing is hanging,
    // and a marker would be a failure report for a turn that worked.
    const pool = fakePool([owner, { role: 'assistant', content: [{ type: 'text', text: 'Here it is.' }] }]);
    const out = await failedTurnReply(pool, turn());
    expect(out.closure).toBe('answered');
    expect(pool.messages).toHaveLength(2);
  });

  it('closes nothing when the run died before it wrote anything', async () => {
    const pool = fakePool([]);
    const out = await failedTurnReply(pool, turn());
    expect(out.closure).toBe('empty');
    expect(pool.messages).toHaveLength(0);
  });

  it('does not touch a transcript it was not given', async () => {
    const pool = fakePool([owner]);
    const out = await failedTurnReply(pool, turn({ conversationId: undefined }));
    expect(out.closure).toBeUndefined();
    expect(pool.messages).toHaveLength(1);
  });
});

describe('storing the offer is never allowed to fail the message', () => {
  it('still says what happened when the database refuses', async () => {
    const pool = {
      query: vi.fn(async () => {
        throw new Error('database is down');
      }),
    } as unknown as Queryable;
    const lines: string[] = [];
    const out = await failedTurnReply(pool, turn({ log: (line: string) => lines.push(line) }));
    expect(out.rendered.text).toContain("couldn't reach the model");
    expect(out.rendered.controls).toHaveLength(0);
    expect(lines.some((line) => line.includes('database is down'))).toBe(true);
  });
});
