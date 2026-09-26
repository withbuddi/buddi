/**
 * Proposal cards on Telegram: the card, the bound callback, the decision path,
 * the channel drawing it. An in-memory `Queryable` stands in for the three
 * tables the path reads; the decision itself is a fake of the dashboard's.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Proposal, Queryable } from '@buddi/core';
import type { TelegramApi } from './api.js';
import {
  TelegramProposals,
  decidedProposalText,
  parseProposalCallback,
  proposalCallbackData,
  proposalCardText,
  proposalKeyboard,
  type DecideProposal,
} from './proposals.js';
import { createTelegramChannel } from './channel.js';

const ID = '0f0e0d0c-0000-4000-8000-000000000001';
const OWNER = '4242';

function proposal(over: Partial<Proposal> = {}): Proposal {
  return {
    id: ID,
    kind: 'skill',
    agent: 'ledger',
    payload: { name: 'Monthly close', when: 'At the start of each month', body: 'steps', why: 'You asked for it three times.' },
    provenance: { sources: [] } as unknown as Proposal['provenance'],
    untrusted: false,
    state: 'open',
    createdAt: '2026-09-26T08:00:00.000Z',
    decidedAt: null,
    reason: null,
    fingerprint: 'f',
    toldAt: null,
    ...over,
  };
}

function row(p: Proposal): Record<string, unknown> {
  return {
    id: p.id, kind: p.kind, agent: p.agent, payload: p.payload, provenance: p.provenance, untrusted: p.untrusted,
    state: p.state, created_at: p.createdAt, decided_at: p.decidedAt, reason: p.reason, fingerprint: p.fingerprint,
    told_at: p.toldAt,
  };
}

/** Three tables: the owner's identity, the proposals, the event log. */
class FakeDb implements Queryable {
  identities = [{ id: 'i1', owner_id: 'owner', surface: 'telegram', external_user_id: OWNER, external_chat_id: OWNER }];
  proposals = new Map<string, Proposal>([[ID, proposal()]]);
  events: { kind: string; payload: any }[] = [];
  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[] }> {
    if (sql.includes('from core.surface_identities')) {
      const rows = this.identities.filter((i) => i.surface === params[0] && (params[1] === undefined || i.external_user_id === params[1]));
      return { rows };
    }
    if (sql.includes('from core.proposals')) {
      const p = this.proposals.get(String(params[0]));
      return { rows: p ? [row(p)] : [] };
    }
    if (sql.includes('insert into core.events')) {
      this.events.push({ kind: String(params[0]), payload: JSON.parse(String(params[1])) });
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }
}

function fakeApi() {
  const calls: { method: string; args: any[] }[] = [];
  const record = (method: string) => async (...args: any[]) => {
    calls.push({ method, args });
    return method === 'sendMessage' ? 77 : undefined;
  };
  const api = {
    sendMessage: record('sendMessage'),
    editMessageText: record('editMessageText'),
    answerCallbackQuery: record('answerCallbackQuery'),
  } as unknown as Pick<TelegramApi, 'sendMessage' | 'editMessageText' | 'answerCallbackQuery'>;
  return { api, calls };
}

function tap(data: string, from = OWNER, chat = OWNER) {
  return { id: 'cb1', from: { id: Number(from) }, data, message: { message_id: 9, chat: { id: Number(chat), type: 'private' } } };
}

/** The dashboard's keep and discard, faked: moves the row once, refuses the second time. */
function decider(db: FakeDb): DecideProposal & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (id, verb) => {
    calls.push(`${id}:${verb}`);
    const p = db.proposals.get(id);
    if (!p || p.state !== 'open') return { ok: false, message: 'That proposal was already decided.' };
    db.proposals.set(id, { ...p, state: verb === 'keep' ? 'kept' : 'discarded' });
    return verb === 'keep' ? { ok: true, note: 'Written to ledger/skills/monthly-close.md.' } : { ok: true };
  }) as DecideProposal & { calls: string[] };
  fn.calls = calls;
  return fn;
}

describe('the card', () => {
  it('says who proposes what, why, and what keeping it does, in plain text', () => {
    const text = proposalCardText(proposal());
    expect(text).toBe([
      'ledger proposes a skill: Monthly close',
      '',
      'When: At the start of each month',
      '',
      'You asked for it three times.',
      '',
      'Kept, it becomes a skill ledger follows next time.',
      'The whole of it is on the dashboard, under Proposals.',
    ].join('\n'));
  });

  it('marks one made with untrusted text in view, and names a rule and a change', () => {
    expect(proposalCardText(proposal({ untrusted: true }))).toContain('It was made with untrusted text in view.');
    const rule = proposalCardText(proposal({ kind: 'policy', agent: 'mail', payload: { plugin: 'mail', action: 'archive', why: 'w' } }));
    expect(rule.split('\n')[0]).toBe('mail proposes a rule for mail: archive');
    expect(rule).toContain('Kept, mail applies it.');
    const change = proposalCardText(proposal({ kind: 'change', payload: { part: 'tools', proposed: 'a, b' } }));
    expect(change.split('\n')[0]).toBe('ledger proposes a change to its tools');
  });

  it('carries Keep and Discard bound to the proposal id, within 64 bytes', () => {
    expect(proposalKeyboard(ID)).toEqual({
      inline_keyboard: [[
        { text: 'Keep', callback_data: `prp:${ID}:keep` },
        { text: 'Discard', callback_data: `prp:${ID}:discard` },
      ]],
    });
    expect(Buffer.byteLength(proposalCallbackData(ID, 'discard'))).toBeLessThanOrEqual(64);
  });

  it('parses only a uuid and a known verb', () => {
    expect(parseProposalCallback(`prp:${ID}:keep`)).toEqual({ id: ID, verb: 'keep' });
    expect(parseProposalCallback(`prp:${ID.toUpperCase()}:DISCARD`)).toEqual({ id: ID, verb: 'discard' });
    expect(parseProposalCallback('prp:not-a-uuid:keep')).toBeUndefined();
    expect(parseProposalCallback(`prp:${ID}:yes`)).toBeUndefined();
    expect(parseProposalCallback('yes')).toBeUndefined();
  });

  it('posts nothing for a proposal no longer open', async () => {
    const db = new FakeDb();
    const { api, calls } = fakeApi();
    const cards = new TelegramProposals({ api, pool: db, decide: decider(db), log: () => {} });
    expect(await cards.request(OWNER, ID)).toBe(true);
    expect(calls[0]?.args[2]).toEqual({ replyMarkup: proposalKeyboard(ID) });
    db.proposals.set(ID, proposal({ state: 'kept' }));
    expect(await cards.request(OWNER, ID)).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('the tap', () => {
  it('keeps it for the owner, then shows the outcome without buttons', async () => {
    const db = new FakeDb();
    const { api, calls } = fakeApi();
    const decide = decider(db);
    await new TelegramProposals({ api, pool: db, decide, log: () => {} }).handleCallback(tap(`prp:${ID}:keep`));

    expect(decide.calls).toEqual([`${ID}:keep`]);
    expect(calls.find((c) => c.method === 'answerCallbackQuery')?.args).toEqual(['cb1', 'Kept.']);
    const edit = calls.find((c) => c.method === 'editMessageText');
    expect(edit?.args[1]).toBe(9);
    expect(edit?.args[2]).toBe(decidedProposalText(proposal({ state: 'kept' }), 'Kept. Written to ledger/skills/monthly-close.md.'));
    expect(edit?.args[3]).toEqual({ replyMarkup: { inline_keyboard: [] } });
  });

  it('discards it', async () => {
    const db = new FakeDb();
    const { api, calls } = fakeApi();
    await new TelegramProposals({ api, pool: db, decide: decider(db), log: () => {} }).handleCallback(tap(`prp:${ID}:discard`));
    expect(db.proposals.get(ID)?.state).toBe('discarded');
    expect(calls.find((c) => c.method === 'editMessageText')?.args[2]).toMatch(/\n\nDiscarded\.$/);
  });

  it('decides nothing for a stranger, records the refusal, and says nothing', async () => {
    const db = new FakeDb();
    const { api, calls } = fakeApi();
    const decide = decider(db);
    await new TelegramProposals({ api, pool: db, decide, log: () => {} }).handleCallback(tap(`prp:${ID}:keep`, '999', '999'));
    expect(decide.calls).toEqual([]);
    expect(db.events).toEqual([expect.objectContaining({ kind: 'surface.rejected' })]);
    expect(db.events[0]?.payload).toMatchObject({ reason: 'unpaired', proposalId: ID });
    expect(calls).toEqual([{ method: 'answerCallbackQuery', args: ['cb1'] }]);
  });

  it('decides nothing for the owner tapping from another chat', async () => {
    const db = new FakeDb();
    const { api } = fakeApi();
    const decide = decider(db);
    await new TelegramProposals({ api, pool: db, decide, log: () => {} }).handleCallback(tap(`prp:${ID}:keep`, OWNER, '555'));
    expect(decide.calls).toEqual([]);
    expect(db.events[0]?.payload.reason).toBe('chat-mismatch');
  });

  it('ignores a payload that is not a proposal tap', async () => {
    const db = new FakeDb();
    const { api, calls } = fakeApi();
    const decide = decider(db);
    await new TelegramProposals({ api, pool: db, decide, log: () => {} }).handleCallback(tap('yes'));
    expect(decide.calls).toEqual([]);
    expect(calls).toEqual([{ method: 'answerCallbackQuery', args: ['cb1'] }]);
  });

  it('says a second tap came too late, and the card loses its buttons', async () => {
    const db = new FakeDb();
    db.proposals.set(ID, proposal({ state: 'kept' }));
    const { api, calls } = fakeApi();
    await new TelegramProposals({ api, pool: db, decide: decider(db), log: () => {} }).handleCallback(tap(`prp:${ID}:discard`));
    expect(calls.find((c) => c.method === 'answerCallbackQuery')?.args).toEqual(['cb1', 'That proposal was already decided.']);
    expect(calls.find((c) => c.method === 'editMessageText')?.args[2]).toMatch(/\n\nAlready kept\.$/);
  });

  it('keeps the buttons when keeping was refused and the proposal is still open', async () => {
    const db = new FakeDb();
    const { api, calls } = fakeApi();
    const decide: DecideProposal = async () => ({ ok: false, message: 'This process cannot write skill files.' });
    await new TelegramProposals({ api, pool: db, decide, log: () => {} }).handleCallback(tap(`prp:${ID}:keep`));
    expect(calls.find((c) => c.method === 'answerCallbackQuery')?.args[1]).toBe('This process cannot write skill files.');
    expect(calls.some((c) => c.method === 'editMessageText')).toBe(false);
  });
});

describe('the Telegram channel draws proposal cards', () => {
  const base = { kind: 'plugin' as const, urgency: 'today' as const, title: 'Proposes a skill: Monthly close' };

  it('draws the card for a proposal sent alone', async () => {
    const db = new FakeDb();
    const request = vi.fn(async () => true);
    const sendText = vi.fn(async () => OWNER);
    const channel = createTelegramChannel({ pool: db, proposals: () => ({ request }), sendText: sendText as never });
    const answer = await channel.deliver({ ...base, id: 'n1', dedupeKey: `proposal:${ID}` });
    expect(answer).toEqual({ id: OWNER });
    expect(request).toHaveBeenCalledWith(OWNER, ID);
    expect(sendText).not.toHaveBeenCalled();
  });

  it('sends the end-of-day message, then a card for each proposal it gathered', async () => {
    const db = new FakeDb();
    const request = vi.fn(async () => true);
    const sendText = vi.fn(async () => OWNER);
    const channel = createTelegramChannel({ pool: db, proposals: () => ({ request }), sendText: sendText as never });
    await channel.deliver({
      id: 'today:2026-09-26',
      kind: 'recap',
      urgency: 'today',
      title: 'Today, 2 things:',
      text: '- ledger: Proposes a skill: Monthly close\n- watcher: Rent is due',
      parts: [
        { ...base, id: 'n1', agentId: 'ledger', dedupeKey: `proposal:${ID}` },
        { kind: 'watcher', urgency: 'today', title: 'Rent is due', id: 'n2' },
      ],
    });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(OWNER, ID);
  });

  it('falls back to text when no surface is running to draw cards', async () => {
    const db = new FakeDb();
    const sendText = vi.fn(async () => OWNER);
    const channel = createTelegramChannel({ pool: db, sendText: sendText as never });
    await channel.deliver({ ...base, id: 'n1', dedupeKey: `proposal:${ID}` });
    expect(sendText).toHaveBeenCalledWith('Proposes a skill: Monthly close', expect.anything());
  });
});
