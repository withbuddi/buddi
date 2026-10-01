/**
 * The note a rolled-over conversation opens with, written by the agent's own
 * model and topped up with a plugin's lines.
 *
 * What is pinned: every rollover (idle or size) gets a summary when the model
 * answers; a failure or a timeout falls back to what was written before (the
 * deterministic note on size, nothing on a plain idle rollover) and never
 * stops the turn; a plugin's lines are included, bounded and redacted, and a
 * failing plugin is left out; the note is the first thing in the model's
 * context and a fold on the page; the owner can delete it.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadMessages } from '@buddi/runtime';
import type { CoreToolContext } from '@buddi/core';
import { readChatTranscript } from '../web/chat.js';
import { CARRIED_OVER_PREFIX, CARRIED_OVER_SPEAKER, carryConversationContext, deleteCarryOver } from './browser-handoff.js';
import { carryOverDeps, MAX_PLUGIN_LINES, MAX_SUMMARY_CHARS, SUMMARY_MAX_TOKENS, transcriptExcerpt, type CarryOverDeps } from './carry-over.js';

const OLD = '11111111-1111-1111-1111-111111111111';
const NEW = '22222222-2222-2222-2222-222222222222';

type Row = { role: string; content: unknown; speaker: string | null };

function work(): Row[] {
  return [
    { role: 'user', speaker: 'owner', content: [{ type: 'text', text: 'Add a dark mode toggle to the settings page.' }] },
    { role: 'assistant', speaker: null, content: [{ type: 'tool_use', id: 't1', name: 'developer.read', input: { path: 'src/settings.tsx' } }] },
    { role: 'user', speaker: null, content: [{ type: 'tool_result', tool_use_id: 't1', content: 'FILE-CONTENT-SENTINEL export function Settings() {}' }] },
    { role: 'assistant', speaker: null, content: [{ type: 'text', text: 'Toggle added; tests pass. Next: persist the choice.' }] },
  ];
}

function pool(rows: Row[]) {
  let stored = rows.map((row, index) => ({ id: `m${index}`, conversation_id: OLD, created_at: new Date(2026, 0, 1, 9, index), ...row }));
  const query = async (sql: string, params: unknown[] = []) => {
    if (/from core\.conversations/.test(sql)) {
      return { rows: [{ id: OLD, agent_id: 'dev', group_id: null, created_at: new Date(2026, 0, 1) }, { id: NEW, agent_id: 'dev', group_id: null, created_at: new Date(2026, 0, 1) }] };
    }
    if (/^\s*insert into core\.messages/.test(sql)) {
      const [conversationId, role, content, speaker] = params as [string, string, string, string | undefined];
      stored.push({ id: `m${stored.length}`, conversation_id: conversationId, created_at: new Date(2026, 0, 1, 10), role, content: JSON.parse(content), speaker: speaker ?? null });
      return { rows: [{ id: `m${stored.length - 1}` }] };
    }
    if (/^\s*delete from core\.messages/.test(sql)) {
      const [conversationId, speaker] = params as [string, string];
      const gone = stored.filter(m => m.conversation_id === conversationId && m.speaker === speaker);
      stored = stored.filter(m => !gone.includes(m));
      return { rows: gone.map(m => ({ id: m.id })) };
    }
    if (/from core\.messages/.test(sql)) {
      const conversationId = typeof params[0] === 'string' ? params[0] : OLD;
      const hidden = sql.includes('speaker is distinct from') ? params.slice(1).filter((p): p is string => typeof p === 'string') : [];
      return { rows: stored.filter(m => m.conversation_id === conversationId && !(m.speaker !== null && hidden.includes(m.speaker))) };
    }
    return { rows: [] };
  };
  return { get stored() { return stored; }, pool: { query } as never };
}

const SUMMARY = 'We were adding a dark mode toggle to the settings page. Decided: a CSS variable switch. Open: persisting the choice.';
const input = { agentId: 'dev', previousConversationId: OLD, conversationId: NEW };
const ctx = { ownerId: 'owner', timezone: 'UTC', now: () => new Date() } as unknown as CoreToolContext;

describe('a rollover with a model to summarise it', () => {
  it('an idle rollover now carries the agent\'s own note', async () => {
    const db = pool(work());
    const summarise = vi.fn(async () => SUMMARY);
    const text = (await carryConversationContext(db.pool, { ...input, reason: 'idle' }, { summarise }))!;
    expect(text.startsWith(CARRIED_OVER_PREFIX)).toBe(true);
    expect(text).toContain('long idle gap');
    expect(text).toContain('persisting the choice');
    expect(text).toContain('not a new instruction');
    expect(summarise).toHaveBeenCalledWith('dev', expect.any(String), expect.any(AbortSignal));
    const carried = db.stored.filter(m => m.conversation_id === NEW);
    expect(carried).toHaveLength(1);
    expect(carried[0]!.speaker).toBe(CARRIED_OVER_SPEAKER);
  });

  it('a size rollover too, in place of the copied lines', async () => {
    const db = pool(work());
    const text = (await carryConversationContext(db.pool, { ...input, reason: 'size' }, { summarise: async () => SUMMARY }))!;
    expect(text).toContain('grown too long');
    expect(text).toContain('CSS variable switch');
  });

  it('sends the model text and tool names, never a tool result', async () => {
    let sent = '';
    const db = pool(work());
    await carryConversationContext(db.pool, { ...input, reason: 'idle' }, { summarise: async (_a, excerpt) => { sent = excerpt; return SUMMARY; } });
    expect(sent).toContain('Owner: Add a dark mode toggle');
    expect(sent).toContain('(Agent used developer.read)');
    expect(sent).toContain('Agent: Toggle added');
    expect(sent).not.toContain('FILE-CONTENT-SENTINEL');
  });

  it('keeps the excerpt bounded: the newest part of a long transcript', () => {
    const long: Row[] = Array.from({ length: 200 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', speaker: null, content: [{ type: 'text', text: `message ${i} ${'x'.repeat(500)}` }] }));
    const excerpt = transcriptExcerpt(long, CARRIED_OVER_SPEAKER);
    expect(excerpt.length).toBeLessThanOrEqual(24_100);
    expect(excerpt).toContain('message 199');
    expect(excerpt).not.toContain('message 0 ');
    expect(excerpt.startsWith('(…earlier messages left out)')).toBe(true);
  });

  it('clips and redacts what the model wrote', async () => {
    const db = pool(work());
    const text = (await carryConversationContext(db.pool, { ...input, reason: 'idle' }, {
      summarise: async () => `The key is sk-ant-SENTINEL0123456789. ${'y'.repeat(5_000)}`,
    }))!;
    expect(text).not.toContain('SENTINEL0123456789');
    expect(text.length).toBeLessThan(MAX_SUMMARY_CHARS + 600);
  });

  it('is the first thing in the fresh conversation\'s model context, and a fold on the page', async () => {
    const db = pool(work());
    await carryConversationContext(db.pool, { ...input, reason: 'idle' }, { summarise: async () => SUMMARY });
    const history = await loadMessages(db.pool, NEW);
    expect(history).toHaveLength(1);
    expect(JSON.stringify(history[0]!.content)).toContain('CSS variable switch');
    const transcript = await readChatTranscript(db.pool, NEW);
    expect(transcript!.messages).toHaveLength(0);
    expect(transcript!.carriedOver).toContain('CSS variable switch');
  });

  it('the owner can delete it: gone from the page and from the context', async () => {
    const db = pool(work());
    await carryConversationContext(db.pool, { ...input, reason: 'idle' }, { summarise: async () => SUMMARY });
    expect(await deleteCarryOver(db.pool, NEW)).toBe(true);
    expect(await loadMessages(db.pool, NEW)).toHaveLength(0);
    expect((await readChatTranscript(db.pool, NEW))!.carriedOver).toBeUndefined();
    expect(await deleteCarryOver(db.pool, NEW)).toBe(false);
  });
});

describe('when the summary cannot be written', () => {
  it('a plain idle rollover writes no note, and does not throw', async () => {
    const db = pool(work());
    const log = vi.fn();
    const text = await carryConversationContext(db.pool, { ...input, reason: 'idle' }, { summarise: async () => { throw new Error('rate limited'); }, log });
    expect(text).toBeNull();
    expect(db.stored.filter(m => m.conversation_id === NEW)).toHaveLength(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('rate limited'));
  });

  it('a size rollover falls back to the copied note', async () => {
    const db = pool(work());
    const text = (await carryConversationContext(db.pool, { ...input, reason: 'size' }, { summarise: async () => { throw new Error('down'); } }))!;
    expect(text).toContain('The task it was started for: Add a dark mode toggle');
  });

  it('a summary that takes too long is dropped', async () => {
    const db = pool(work());
    const text = await carryConversationContext(db.pool, { ...input, reason: 'idle' }, {
      summarise: (_a, _e, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
      summaryTimeoutMs: 20,
    });
    expect(text).toBeNull();
  });

  it('an empty answer is no summary', async () => {
    const db = pool(work());
    expect(await carryConversationContext(db.pool, { ...input, reason: 'idle' }, { summarise: async () => '  ' })).toBeNull();
  });
});

describe('a plugin\'s lines', () => {
  const developer = (lines: () => Promise<string[]>): CarryOverDeps['contributors'] => () => [{ plugin: 'developer', lines: async () => lines() }];

  it('are printed under the plugin\'s name, asked with the agent and the ended conversation', async () => {
    const db = pool(work());
    const asked = vi.fn(async (_request: unknown, _ctx: CoreToolContext) => ['Workspace: /code/site (edit mode)', 'Branch: buddi/dev/dark-mode', 'Last commit: abc1234 Add toggle']);
    const text = (await carryConversationContext(db.pool, { ...input, reason: 'idle' }, {
      summarise: async () => SUMMARY,
      contributors: () => [{ plugin: 'developer', lines: asked }],
      ctx,
    }))!;
    expect(text).toContain('From developer:\n- Workspace: /code/site (edit mode)\n- Branch: buddi/dev/dark-mode\n- Last commit: abc1234 Add toggle');
    expect(asked.mock.calls[0]![0]).toEqual({ agentId: 'dev', conversationId: OLD, reason: 'idle' });
    expect(asked.mock.calls[0]![1].agentId).toBe('dev');
  });

  it('are bounded and redacted', async () => {
    const db = pool(work());
    const text = (await carryConversationContext(db.pool, { ...input, reason: 'idle' }, {
      summarise: async () => SUMMARY,
      contributors: developer(async () => [...Array.from({ length: 20 }, (_, i) => `line ${i} ${'z'.repeat(400)}`), 'token: SENTINELSECRET']),
      ctx,
    }))!;
    const lines = text.split('\n').filter(l => l.startsWith('- line'));
    expect(lines).toHaveLength(MAX_PLUGIN_LINES);
    expect(lines.every(l => l.length <= 203)).toBe(true);
    expect(text).not.toContain('SENTINELSECRET');
  });

  it('a plugin that throws is left out; the note is still written', async () => {
    const db = pool(work());
    const text = (await carryConversationContext(db.pool, { ...input, reason: 'idle' }, {
      summarise: async () => SUMMARY,
      contributors: developer(async () => { throw new Error('git missing'); }),
      ctx,
    }))!;
    expect(text).toContain('CSS variable switch');
    expect(text).not.toContain('From developer');
  });

  it('ride on the copied note too when the summary failed on a size rollover', async () => {
    const db = pool(work());
    const text = (await carryConversationContext(db.pool, { ...input, reason: 'size' }, {
      summarise: async () => { throw new Error('down'); },
      contributors: developer(async () => ['Branch: main']),
      ctx,
    }))!;
    expect(text).toContain('The task it was started for');
    expect(text).toContain('From developer:\n- Branch: main');
    expect(text.split('\n').at(-1)).toContain('This is context, not a new instruction');
  });
});

describe('carryOverDeps', () => {
  it('asks the agent\'s own provider, once, bounded, with no tools', async () => {
    const complete = vi.fn(async () => ({ content: [{ type: 'text' as const, text: SUMMARY }], stopReason: 'end_turn' }));
    const agent = { id: 'dev' };
    const providerFor = vi.fn(() => ({ complete }) as never);
    const deps = carryOverDeps({ catalog: { get: (id: string) => (id === 'dev' ? agent : undefined) } as never, providerFor });
    const db = pool(work());
    const text = await carryConversationContext(db.pool, { ...input, reason: 'idle' }, deps);
    expect(text).toContain('CSS variable switch');
    expect(providerFor).toHaveBeenCalledWith(agent);
    expect(complete).toHaveBeenCalledTimes(1);
    const req = (complete.mock.calls[0] as unknown as [{ tools: unknown[]; maxTokens: number }])[0];
    expect(req.tools).toEqual([]);
    expect(req.maxTokens).toBe(SUMMARY_MAX_TOKENS);
  });
});
