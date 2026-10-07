/**
 * An agent's sign-in card on Telegram (docs/telegram.md, "Sign-in cards"):
 * Telegram is not a place to type a password, so the card collects nothing
 * there. The answer says to open the dashboard at the conversation, the one
 * button is Decline, and a tap on it reaches the agent as the card's outcome
 * (`{ declined: 'cancelled' }`), never as the word "Decline".
 *
 * No network and no database: a fake Bot API and an in-memory `Queryable`.
 */
import { roleProblemMessage, UnknownAgentError, type Queryable, type Question } from '@buddi/core';
import { describe, expect, it, vi } from 'vitest';
import { TelegramApi, type FetchLike, type TelegramUpdate } from './api.js';
import { questionCallbackData, questionKeyboard, SURFACE, TelegramSurface } from './surface.js';
import type { AgentCatalog, CatalogAgent } from './types.js';
import { DECLINE_LABEL, telegramSignInReply } from '../surfaces/secret-request.js';

const OWNER = '4242';
const QUESTION_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION = '44444444-4444-4444-8444-444444444444';

const card: Question = {
  id: QUESTION_ID,
  agentId: 'scout',
  conversationId: CONVERSATION,
  question: 'No saved sign-in for wikipedia.org',
  options: [{ id: 'option-1', label: DECLINE_LABEL, hint: null, recommended: false }],
  allowOther: false,
  createdAt: '2026-10-07T10:20:00Z',
  expiresAt: '2099-10-07T10:50:00Z',
  answeredAt: null,
  answeredVia: null,
  answer: null,
  request: {
    kind: 'secret.request',
    site: 'wikipedia.org',
    origins: ['https://en.wikipedia.org', 'https://wikipedia.org', 'https://*.wikipedia.org'],
    fields: [{ label: 'Username', kind: 'username', ref: 'e3' }, { label: 'Password', kind: 'password', ref: 'e4' }],
    agentName: 'Scout',
  },
};

const row = (q: Question, answered?: { at: Date; via: string; answer: string }): Record<string, unknown> => ({
  id: q.id, agent_id: q.agentId, conversation_id: q.conversationId, question: q.question, options: q.options,
  allow_other: q.allowOther, created_at: q.createdAt, expires_at: q.expiresAt,
  answered_at: answered?.at ?? null, answered_via: answered?.via ?? null, answer: answered?.answer ?? null, request: q.request,
});

/** Just enough of core: the pairing, the card, and a conversation to continue in. */
class FakeDb implements Queryable {
  answered: { at: Date; via: string; answer: string } | undefined;
  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();
    if (text.startsWith('select id, owner_id, surface, external_user_id, external_chat_id')) {
      return params[1] === OWNER ? { rows: [{ id: 'sid-1', owner_id: 'owner', surface: SURFACE, external_user_id: OWNER, external_chat_id: OWNER }] } : { rows: [] };
    }
    if (text.includes('from core.questions where id = $1')) return { rows: [row(card, this.answered)] };
    if (text.startsWith('update core.questions set answered_at')) {
      this.answered = { at: params[1], via: params[2], answer: params[3] };
      return { rows: [row(card, this.answered)] };
    }
    // No mission is parked on this card.
    if (text.startsWith('update core.jobs')) return { rows: [] };
    if (text.startsWith('insert into core.conversations')) return { rows: [{ id: CONVERSATION }] };
    if (text.includes('core.conversations') || text.includes('core.surface_conversations')) {
      return { rows: [{ id: CONVERSATION, conversation_id: CONVERSATION, agent_id: 'scout', created_at: new Date(), last_at: new Date(), messages: 1, chars: 10 }] };
    }
    return { rows: [] };
  }
}

function fakeApi(): { api: TelegramApi; sent: Array<{ method: string; body: any }> } {
  const sent: Array<{ method: string; body: any }> = [];
  let next = 100;
  const fetchLike: FetchLike = async (url, init) => {
    const method = url.split('/').pop() as string;
    sent.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
    const result = method === 'sendMessage' ? { message_id: next++ } : method === 'getUpdates' ? [] : true;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result }) };
  };
  return { api: new TelegramApi({ token: 't', fetch: fetchLike }), sent };
}

function catalog(): AgentCatalog {
  const agents = [{ id: 'scout', handle: 'scout', name: 'Scout', description: 't', isDefault: true, roles: [] }].map((a) => a as unknown as CatalogAgent);
  return {
    get: (id) => agents.find((a) => a.id === id),
    byHandle: (handle) => agents.find((a) => a.handle === handle.replace(/^@/, '')),
    list: () => agents.map((a) => ({ ...a })) as any,
    agentsWithRole: () => [],
    agentForRole: (role: string) => ({ ok: false, problem: { code: 'no-agent-for-role', role, message: roleProblemMessage(role) } }) as const,
    defaultAgent: () => agents[0] as CatalogAgent,
    resolve: (id) => {
      const found = id === undefined ? agents[0] : agents.find((a) => a.id === id);
      if (!found) throw new UnknownAgentError(String(id), agents.map((a) => a.id));
      return found as CatalogAgent;
    },
  };
}

describe('a sign-in card on Telegram', () => {
  it('says to open the dashboard at the conversation and asks for nothing here', () => {
    const reply = telegramSignInReply('I need your Wikipedia sign-in to add Lyon to your watchlist.', card.request!, `https://buddi.example/#/chat/scout/${CONVERSATION}`);
    expect(reply).toBe(`I need your Wikipedia sign-in to add Lyon to your watchlist.\n\nOpen the dashboard to save the sign-in for wikipedia.org: https://buddi.example/#/chat/scout/${CONVERSATION}`);
    expect(reply).not.toMatch(/password:|type it here|reply with/i);
  });

  it('draws Decline as its only button', () => {
    const keyboard = questionKeyboard(card);
    expect(keyboard.inline_keyboard.flat().map((button) => button.text)).toEqual([DECLINE_LABEL]);
    expect(keyboard.inline_keyboard.flat()[0]).toMatchObject({ callback_data: questionCallbackData(QUESTION_ID, 0) });
  });

  it('Decline reaches the agent as the card declined, not as the word', async () => {
    const db = new FakeDb();
    const { api } = fakeApi();
    const run = vi.fn(async () => 'Fine, I will leave the watchlist for now.');
    const surface = new TelegramSurface({ api, pool: db, catalog: catalog(), timezone: 'UTC', run, log: () => {}, typingIntervalMs: 60_000 } as any);
    await surface.handleQuestionCallback({
      id: 'cb-1',
      from: { id: Number(OWNER), is_bot: false, first_name: 'Owner' },
      message: { message_id: 55, chat: { id: Number(OWNER), type: 'private' }, date: 0 },
      data: questionCallbackData(QUESTION_ID, 0),
    } as unknown as NonNullable<TelegramUpdate['callback_query']>);
    expect(run).toHaveBeenCalledTimes(1);
    const turn = (run.mock.calls[0] as unknown as [{ text: string }])[0];
    expect(turn.text).toContain('tool result (deferred) for secret.request: {"declined":"cancelled"}');
    expect(turn.text).not.toBe(DECLINE_LABEL);
  });
});
