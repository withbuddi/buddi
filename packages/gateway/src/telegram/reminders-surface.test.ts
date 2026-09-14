/**
 * `/reminders` and its cancel buttons.
 *
 * The owner's half of a capability the agents gained: they can put something on
 * the clock, so the owner must be able to see all of it and take any of it off
 * from the surface they actually use. The rules are the ones every other
 * callback follows — the id is bound into `callback_data`, the sender is
 * re-authenticated against core on every tap, and a stranger learns nothing.
 *
 * No network and no database: a fake Bot API and an in-memory `Queryable`.
 */
import { UnknownAgentError, type Queryable, type Reminder } from '@buddi/core';
import { describe, expect, it, vi } from 'vitest';
import { TelegramApi, type FetchLike, type TelegramUpdate } from './api.js';
import {
  NO_REMINDERS_TEXT,
  REMINDER_CANCELLED_TEXT,
  REMINDER_GONE_TEXT,
  SURFACE,
  TelegramSurface,
  callbackKind,
  parseReminderCallback,
  reminderCallbackData,
  remindersKeyboard,
  remindersText,
} from './surface.js';
import type { AgentCatalog, CatalogAgent } from './types.js';

const OWNER_USER = '4242';
const OWNER_CHAT = '4242';
const TZ = 'America/New_York';
const ID_ONE = '11111111-1111-4111-8111-111111111111';
const ID_TWO = '22222222-2222-4222-8222-222222222222';

function reminder(id: string, agentId: string, dueIso: string, text: string): Reminder {
  return {
    id,
    agentId,
    conversationId: null,
    dueAt: new Date(dueIso),
    text,
    context: null,
    state: 'pending',
    createdAt: new Date('2026-09-14T12:00:00Z'),
    firedAt: null,
    cancelledAt: null,
    cancelReason: null,
  };
}

/* ---------------- in-memory core tables ---------------- */

class FakeDb implements Queryable {
  paired = true;
  reminders: Reminder[] = [];
  events: { kind: string; payload: any }[] = [];

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();

    if (text.startsWith('select id, owner_id, surface, external_user_id, external_chat_id')) {
      if (!this.paired || params[1] !== OWNER_USER) return { rows: [] };
      return {
        rows: [
          {
            id: 'sid-1',
            owner_id: 'owner',
            surface: SURFACE,
            external_user_id: OWNER_USER,
            external_chat_id: OWNER_CHAT,
          },
        ],
      };
    }

    if (text.includes('from core.reminders')) {
      const [agentId, state] = params;
      let rows = this.reminders;
      if (agentId !== null && agentId !== undefined) rows = rows.filter((r) => r.agentId === agentId);
      if (state) rows = rows.filter((r) => r.state === state);
      return {
        rows: [...rows]
          .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
          .map((r) => ({
            id: r.id,
            agent_id: r.agentId,
            conversation_id: null,
            due_at: r.dueAt,
            text: r.text,
            context: null,
            state: r.state,
            created_at: r.createdAt,
            fired_at: null,
            cancelled_at: r.cancelledAt,
            cancel_reason: r.cancelReason,
          })),
      };
    }

    if (text.startsWith('update core.reminders')) {
      const row = this.reminders.find((r) => r.id === params[0] && r.state === 'pending');
      if (!row) return { rows: [] };
      row.state = 'cancelled';
      row.cancelReason = params[1];
      return {
        rows: [
          {
            id: row.id,
            agent_id: row.agentId,
            conversation_id: null,
            due_at: row.dueAt,
            text: row.text,
            context: null,
            state: row.state,
            created_at: row.createdAt,
            fired_at: null,
            cancelled_at: new Date(),
            cancel_reason: row.cancelReason,
          },
        ],
      };
    }

    if (text.startsWith('insert into core.events')) {
      this.events.push({ kind: params[0], payload: JSON.parse(params[1]) });
      return { rows: [] };
    }

    throw new Error(`FakeDb: unexpected sql: ${text}`);
  }
}

/* ---------------- fake Bot API ---------------- */

type Sent = { method: string; body: any };

function fakeApi(): { api: TelegramApi; sent: Sent[] } {
  const sent: Sent[] = [];
  let nextMessageId = 100;
  const fetchLike: FetchLike = async (url, init) => {
    const method = url.split('/').pop() as string;
    sent.push({ method, body: JSON.parse(init?.body ?? '{}') });
    const result =
      method === 'sendMessage' ? { message_id: nextMessageId++ } : method === 'getUpdates' ? [] : true;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result }) };
  };
  return { api: new TelegramApi({ token: 't', fetch: fetchLike }), sent };
}

/* ---------------- fake catalog ---------------- */

const AGENTS = [
  { id: 'finance-advisor', handle: 'ledger', name: 'Finance Advisor' },
  { id: 'credit-coach', handle: 'credo', name: 'Credit Coach' },
];

function fakeCatalog(): AgentCatalog {
  const agents = AGENTS.map(
    (a) =>
      ({
        ...a,
        description: 'test',
        isDefault: a.id === 'finance-advisor',
      }) as unknown as CatalogAgent,
  );
  const byDefault = agents[0] as CatalogAgent;
  return {
    get: (id) => agents.find((a) => a.id === id),
    byHandle: (handle) => agents.find((a) => a.handle === handle.replace(/^@/, '')),
    list: () => agents.map((a) => ({ ...a })) as any,
    defaultAgent: () => byDefault,
    resolve: (id) => {
      if (id === undefined) return byDefault;
      const found = agents.find((a) => a.id === id);
      if (!found) throw new UnknownAgentError(id, agents.map((a) => a.id));
      return found;
    },
  };
}

function surfaceWith(db: FakeDb) {
  const { api, sent } = fakeApi();
  const surface = new TelegramSurface({
    api,
    pool: db,
    catalog: fakeCatalog(),
    timezone: TZ,
    run: vi.fn(async () => 'reply'),
    log: () => {},
    typingIntervalMs: 60_000,
  } as any);
  return { surface, sent };
}

const tap = (id: string, fromId = Number(OWNER_USER)): NonNullable<TelegramUpdate['callback_query']> =>
  ({
    id: 'cb-1',
    from: { id: fromId, is_bot: false, first_name: 'Owner' },
    message: { message_id: 55, chat: { id: Number(OWNER_CHAT), type: 'private' }, date: 0 },
    data: reminderCallbackData(id),
  }) as unknown as NonNullable<TelegramUpdate['callback_query']>;

/* ---------------- the tests ---------------- */

describe('the reminder callback payload', () => {
  it('carries the id and is owned by its own prefix', () => {
    expect(reminderCallbackData(ID_ONE)).toBe(`rem:${ID_ONE}:cancel`);
    expect(parseReminderCallback(reminderCallbackData(ID_ONE))).toBe(ID_ONE);
    expect(callbackKind(reminderCallbackData(ID_ONE))).toBe('reminder');
    // The other two prefixes keep what is theirs.
    expect(callbackKind('use:finance-advisor')).toBe('agent');
    expect(callbackKind(`apr:${ID_ONE}:approve`)).toBe('approval');
  });

  it('refuses anything that is not a uuid tap', () => {
    expect(parseReminderCallback('rem:not-a-uuid:cancel')).toBeUndefined();
    expect(parseReminderCallback(`rem:${ID_ONE}:fire`)).toBeUndefined();
    expect(parseReminderCallback(undefined)).toBeUndefined();
  });
});

describe('/reminders', () => {
  it('lists every pending one with the agent that set it, and a button each', async () => {
    const db = new FakeDb();
    db.reminders = [
      reminder(ID_ONE, 'finance-advisor', '2026-09-20T13:00:00Z', 'check the card payment'),
      reminder(ID_TWO, 'credit-coach', '2026-09-22T13:00:00Z', 'pay down before it closes'),
    ];
    const { surface, sent } = surfaceWith(db);
    await surface.handleReminders(OWNER_CHAT);

    const message = sent.find((s) => s.method === 'sendMessage');
    expect(message?.body.text).toContain('check the card payment');
    expect(message?.body.text).toContain('set by Ledger');
    expect(message?.body.text).toContain('set by Credo');
    // Local time, not UTC: 13:00Z is 09:00 in New York.
    expect(message?.body.text).toContain('09:00');
    expect(message?.body.reply_markup.inline_keyboard).toHaveLength(2);
    expect(message?.body.reply_markup.inline_keyboard[0][0].callback_data).toBe(
      reminderCallbackData(ID_ONE),
    );
  });

  it('says so plainly when nothing is on the clock, with no keyboard', async () => {
    const db = new FakeDb();
    const { surface, sent } = surfaceWith(db);
    await surface.handleReminders(OWNER_CHAT);
    const message = sent.find((s) => s.method === 'sendMessage');
    expect(message?.body.text).toBe(NO_REMINDERS_TEXT);
    expect(message?.body.reply_markup).toBeUndefined();
  });

  it('renders the same text and keyboard as pure functions', () => {
    const rows = [reminder(ID_ONE, 'finance-advisor', '2026-09-20T13:00:00Z', 'check the card')];
    expect(remindersText(rows, TZ)).toContain('finance-advisor');
    expect(remindersText([], TZ)).toBe(NO_REMINDERS_TEXT);
    expect(remindersKeyboard(rows, TZ).inline_keyboard[0]?.[0]?.callback_data).toBe(
      reminderCallbackData(ID_ONE),
    );
  });
});

describe('a tap on Cancel', () => {
  it('cancels it for the owner and redraws the list', async () => {
    const db = new FakeDb();
    db.reminders = [
      reminder(ID_ONE, 'finance-advisor', '2026-09-20T13:00:00Z', 'check the card payment'),
      reminder(ID_TWO, 'credit-coach', '2026-09-22T13:00:00Z', 'pay down before it closes'),
    ];
    const { surface, sent } = surfaceWith(db);
    await surface.handleReminderCallback(tap(ID_ONE));

    expect(db.reminders[0]?.state).toBe('cancelled');
    expect(db.reminders[0]?.cancelReason).toContain('owner');
    expect(sent.find((s) => s.method === 'answerCallbackQuery')?.body.text).toBe(
      REMINDER_CANCELLED_TEXT,
    );
    const edit = sent.find((s) => s.method === 'editMessageText');
    expect(edit?.body.text).not.toContain('check the card payment');
    expect(edit?.body.text).toContain('pay down before it closes');
    expect(edit?.body.reply_markup.inline_keyboard).toHaveLength(1);
  });

  it('says a reminder that is no longer pending is gone, and changes nothing', async () => {
    const db = new FakeDb();
    const row = reminder(ID_ONE, 'finance-advisor', '2026-09-20T13:00:00Z', 'already fired');
    row.state = 'fired';
    db.reminders = [row];
    const { surface, sent } = surfaceWith(db);
    await surface.handleReminderCallback(tap(ID_ONE));
    expect(sent.find((s) => s.method === 'answerCallbackQuery')?.body.text).toBe(REMINDER_GONE_TEXT);
    expect(db.reminders[0]?.state).toBe('fired');
  });

  it('refuses a stranger: nothing cancelled, nothing said, one rejection recorded', async () => {
    const db = new FakeDb();
    db.reminders = [reminder(ID_ONE, 'finance-advisor', '2026-09-20T13:00:00Z', 'check the card')];
    const { surface, sent } = surfaceWith(db);
    await surface.handleReminderCallback(tap(ID_ONE, 9999));

    expect(db.reminders[0]?.state).toBe('pending');
    const answer = sent.find((s) => s.method === 'answerCallbackQuery');
    expect(answer?.body.text).toBeUndefined();
    expect(sent.some((s) => s.method === 'editMessageText')).toBe(false);
    expect(db.events).toHaveLength(1);
    expect(db.events[0]).toMatchObject({
      kind: 'surface.rejected',
      payload: { kind: 'callback', reason: 'unpaired', reminderId: ID_ONE },
    });
  });

  it('routes a reminder tap through the prefix dispatcher, with no approvals wired', async () => {
    const db = new FakeDb();
    db.reminders = [reminder(ID_ONE, 'finance-advisor', '2026-09-20T13:00:00Z', 'check the card')];
    const { surface } = surfaceWith(db);
    await surface.dispatch({ update_id: 1, callback_query: tap(ID_ONE) } as TelegramUpdate);
    // Serialized on the chat's own chain: let it drain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(db.reminders[0]?.state).toBe('cancelled');
  });
});
