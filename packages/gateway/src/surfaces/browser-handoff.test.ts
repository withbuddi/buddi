/**
 * The rollover after a browser session is not amnesia.
 *
 * Three facts, and they are the whole feature: the fresh conversation carries
 * the note, the note carries no page content, and the model actually gets it.
 */
import { describe, expect, it } from 'vitest';
import { loadMessages } from '@buddi/runtime';
import { readChatTranscript } from '../web/chat.js';
import {
  CARRIED_OVER_PREFIX,
  CARRIED_OVER_SPEAKER,
  carryConversationContext,
  carryOverNote,
  readCarryOver,
} from './browser-handoff.js';

const OLD = '11111111-1111-1111-1111-111111111111';
const NEW = '22222222-2222-2222-2222-222222222222';

/** What a browser session leaves in a transcript: the task, the calls, the
 * observations (trees and all) and the agent's answer. */
const PAGE_TEXT = 'Available balance $4,213.55 — Free checking ••1234';
function session(): Array<{ role: string; content: unknown; speaker: string | null }> {
  return [
    { role: 'user', speaker: null, content: [{ type: 'text', text: 'Check my PNC balance and tell me if rent clears.' }] },
    { role: 'assistant', speaker: null, content: [{ type: 'tool_use', id: 'call-1', name: 'browser.act', input: { action: 'navigate', url: 'https://www.pnc.com/' } }] },
    { role: 'user', speaker: null, content: [{ type: 'tool_result', tool_use_id: 'call-1', content: JSON.stringify({ completed: true, observation: { id: 'o1', url: 'https://www.pnc.com/signin', title: 'PNC — Sign in', tree: PAGE_TEXT } }) }] },
    { role: 'assistant', speaker: null, content: [{ type: 'tool_use', id: 'call-2', name: 'browser.act', input: { action: 'click' } }] },
    { role: 'user', speaker: null, content: [{ type: 'tool_result', tool_use_id: 'call-2', content: JSON.stringify({ completed: true, observation: { id: 'o2', url: 'https://www.pnc.com/accounts', title: 'Account summary', tree: PAGE_TEXT } }) }] },
    { role: 'assistant', speaker: null, content: [{ type: 'text', text: 'Your checking shows $4,213.55, so the £1,400 rent clears on Friday.' }] },
  ];
}

/** A pool over rows in memory that honours the one filter these readers use. */
function pool(rows: Array<{ role: string; content: unknown; speaker: string | null }>) {
  const stored = rows.map((row, index) => ({ id: `m${index}`, conversation_id: OLD, created_at: new Date(2026, 0, 1, 9, index), ...row }));
  const query = async (sql: string, params: unknown[] = []) => {
    if (/from core\.conversations/.test(sql)) {
      return { rows: [{ id: OLD, agent_id: 'ada', group_id: null, created_at: new Date(2026, 0, 1) }, { id: NEW, agent_id: 'ada', group_id: null, created_at: new Date(2026, 0, 1) }] };
    }
    if (/^\s*insert into core\.messages/.test(sql)) {
      const [conversationId, role, content, speaker] = params as [string, string, string, string | undefined];
      stored.push({ id: `m${stored.length}`, conversation_id: conversationId, created_at: new Date(2026, 0, 1, 10), role, content: JSON.parse(content), speaker: speaker ?? null });
      return { rows: [{ id: `m${stored.length - 1}` }] };
    }
    if (/from core\.messages/.test(sql)) {
      const conversationId = typeof params[0] === 'string' ? params[0] : OLD;
      const hidden = sql.includes('speaker is distinct from') ? params.slice(1).filter((p): p is string => typeof p === 'string') : [];
      return { rows: stored.filter(m => m.conversation_id === conversationId && !(m.speaker !== null && hidden.includes(m.speaker))) };
    }
    return { rows: [] };
  };
  return { stored, pool: { query } as never };
}

describe('a browser session that ended with the conversation', () => {
  const input = { agentId: 'ada', previousConversationId: OLD, conversationId: NEW, reason: 'idle' as const };

  it('is read out of the old transcript: the task, the pages, the last answer', () => {
    const handoff = readCarryOver(session())!;
    expect(handoff.task).toBe('Check my PNC balance and tell me if rent clears.');
    expect(handoff.pages).toEqual([
      { url: 'https://www.pnc.com/signin', title: 'PNC — Sign in' },
      { url: 'https://www.pnc.com/accounts', title: 'Account summary' },
    ]);
    expect(handoff.lastAgentMessage).toContain('$4,213.55');
  });

  it('carries the note into the fresh conversation, as nobody speaking', async () => {
    const db = pool(session());
    const text = await carryConversationContext(db.pool, input);
    expect(text).toContain(CARRIED_OVER_PREFIX);
    const carried = db.stored.filter(m => m.conversation_id === NEW);
    expect(carried).toHaveLength(1);
    expect(carried[0]!.role).toBe('user');
    expect(carried[0]!.speaker).toBe(CARRIED_OVER_SPEAKER);
  });

  it('carries URLs and titles, never a word of what the pages said', () => {
    const note = carryOverNote(readCarryOver(session())!, 'idle');
    expect(note).toContain('https://www.pnc.com/accounts');
    expect(note).toContain('Account summary');
    expect(note).not.toContain(PAGE_TEXT);
    expect(note.split(/\s+/).length).toBeLessThan(250);
  });

  it('writes nothing when the old conversation never drove a browser', async () => {
    const db = pool([{ role: 'user', speaker: null, content: [{ type: 'text', text: 'Morning' }] }]);
    expect(await carryConversationContext(db.pool, input)).toBeNull();
    expect(db.stored.filter(m => m.conversation_id === NEW)).toHaveLength(0);
  });

  it('refuses to carry anything across agents', async () => {
    const db = pool(session());
    expect(await carryConversationContext(db.pool, { ...input, agentId: 'someone-else' })).toBeNull();
  });

  it('is in the model context of the fresh conversation, and not in its transcript', async () => {
    const db = pool(session());
    await carryConversationContext(db.pool, input);

    const history = await loadMessages(db.pool, NEW);
    expect(history).toHaveLength(1);
    expect(JSON.stringify(history[0]!.content)).toContain('Account summary');

    const transcript = await readChatTranscript(db.pool, NEW);
    expect(transcript!.messages).toHaveLength(0);
    expect(transcript!.carriedOver).toContain(CARRIED_OVER_PREFIX);
    expect(transcript!.carriedOver).toContain('https://www.pnc.com/accounts');
    expect(transcript!.carriedOver).not.toContain(PAGE_TEXT);
  });
});

/**
 * A size rollover cuts a conversation in the middle of work — that is what "it
 * grew long" means — so it carries the same note whether or not a browser was
 * ever involved.
 */
describe('a conversation that ended because it had grown long', () => {
  const input = { agentId: 'ada', previousConversationId: OLD, conversationId: NEW, reason: 'size' as const };

  /** A long working conversation with no browser in it at all. */
  function work(): Array<{ role: string; content: unknown; speaker: string | null }> {
    return [
      { role: 'user', speaker: 'owner', content: [{ type: 'text', text: 'Reconcile September against the bank statement.' }] },
      { role: 'assistant', speaker: null, content: [{ type: 'text', text: 'Started — 40 of 61 rows matched.' }] },
      { role: 'user', speaker: 'owner', content: [{ type: 'text', text: 'Skip the Amazon ones for now.' }] },
      { role: 'assistant', speaker: null, content: [{ type: 'text', text: 'Skipped them; 12 rows left to match.' }] },
    ];
  }

  it('carries the task, the last thing asked and the agent\'s last words', () => {
    const carry = readCarryOver(work())!;
    expect(carry.task).toBe('Reconcile September against the bank statement.');
    expect(carry.lastOwnerMessage).toBe('Skip the Amazon ones for now.');
    expect(carry.lastAgentMessage).toContain('12 rows left');
    expect(carry.pages).toEqual([]);
  });

  it('writes that note into the fresh conversation, as nobody speaking', async () => {
    const db = pool(work());
    const text = await carryConversationContext(db.pool, input);
    expect(text).toContain(CARRIED_OVER_PREFIX);
    expect(text).toContain('had grown too long');
    expect(text).toContain('Reconcile September');
    expect(text).toContain('Skip the Amazon ones');
    expect(text).toContain('12 rows left');
    expect(text).not.toContain('Pages visited');
    const carried = db.stored.filter(m => m.conversation_id === NEW);
    expect(carried).toHaveLength(1);
    expect(carried[0]!.speaker).toBe(CARRIED_OVER_SPEAKER);
  });

  it('names the pages too when there were any, and still no page content', async () => {
    const db = pool(session());
    const text = (await carryConversationContext(db.pool, input))!;
    expect(text).toContain('Account summary');
    expect(text).toContain('https://www.pnc.com/accounts');
    expect(text).not.toContain(PAGE_TEXT);
  });

  it('stays small: it is replayed into every turn of the new conversation', async () => {
    const db = pool(work().map(m => ({ ...m, content: [{ type: 'text', text: 'w'.repeat(5_000) }] })));
    const text = (await carryConversationContext(db.pool, input))!;
    expect(text.length).toBeLessThan(2_000);
  });

  it('does not repeat the task as "the last thing you asked"', () => {
    const one = readCarryOver([{ role: 'user', speaker: 'owner', content: [{ type: 'text', text: 'Just this.' }] }])!;
    expect(one.task).toBe('Just this.');
    expect(one.lastOwnerMessage).toBe('');
  });

  it('never reads a carried note back as something the owner said', () => {
    const carried = { role: 'user', speaker: CARRIED_OVER_SPEAKER, content: [{ type: 'text', text: `${CARRIED_OVER_PREFIX} an older task` }] };
    const carry = readCarryOver([carried, ...work()])!;
    expect(carry.task).toBe('Reconcile September against the bank statement.');
  });

  it('writes nothing when there was nothing in the conversation at all', async () => {
    const db = pool([]);
    expect(await carryConversationContext(db.pool, input)).toBeNull();
  });

  it('an idle rollover of the same conversation still carries nothing', async () => {
    // Going to bed is not being cut off mid-task; today's behaviour stands.
    const db = pool(work());
    expect(await carryConversationContext(db.pool, { ...input, reason: 'idle' })).toBeNull();
  });
});
