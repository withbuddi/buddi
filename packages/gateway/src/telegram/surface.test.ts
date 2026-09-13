/**
 * Telegram surface tests. No network, no database: a fake `fetch` answers the
 * Bot API and an in-memory `Queryable` stands in for core's tables.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Queryable } from '@buddi/core';
import { TelegramApi, splitMessage, type FetchLike, type TelegramUpdate } from './api.js';
import {
  HELP,
  PLACEHOLDER_TEXT,
  RECAP_MISSION_ID,
  RECAP_NOT_REGISTERED_TEXT,
  RECAP_UNAVAILABLE_TEXT,
  SURFACE,
  TelegramSurface,
  progressLine,
  toolLabel,
  type RunMission,
} from './surface.js';
import { OwnerNotPairedError, notifyOwner, ownerChatId } from './notify.js';

/* ---------------- in-memory core tables ---------------- */

class FakeDb implements Queryable {
  identities: { owner_id: string; surface: string; external_user_id: string; external_chat_id: string | null }[] = [];
  updates: { surface: string; update_id: string }[] = [];
  cursors = new Map<string, string>();
  conversations: { id: string; agent_id: string }[] = [];
  chatConversations = new Map<string, string>();
  events: { kind: string; payload: any }[] = [];

  async query(sql: string, params: any[] = []): Promise<{ rows: any[] }> {
    const text = sql.replace(/\s+/g, ' ').trim();

    if (text.startsWith('select id, owner_id, surface, external_user_id, external_chat_id')) {
      const rows = this.identities.filter((i) =>
        params.length === 2
          ? i.surface === params[0] && i.external_user_id === params[1]
          : i.surface === params[0],
      );
      return { rows: rows.map((r, n) => ({ id: `id-${n}`, ...r })) };
    }
    if (text.startsWith('insert into core.surface_updates')) {
      const seen = this.updates.some((u) => u.surface === params[0] && u.update_id === params[1]);
      if (seen) return { rows: [] };
      this.updates.push({ surface: params[0], update_id: params[1] });
      return { rows: [{ update_id: params[1] }] };
    }
    if (text.startsWith('insert into core.surface_cursors')) {
      this.cursors.set(params[0], params[1]);
      return { rows: [] };
    }
    if (text.startsWith('select cursor from core.surface_cursors')) {
      const cursor = this.cursors.get(params[0]);
      return { rows: cursor === undefined ? [] : [{ cursor }] };
    }
    if (text.startsWith('select conversation_id from core.surface_conversations')) {
      const id = this.chatConversations.get(params[1]);
      return { rows: id ? [{ conversation_id: id }] : [] };
    }
    if (text.startsWith('insert into core.surface_conversations')) {
      this.chatConversations.set(params[1], params[2]);
      return { rows: [] };
    }
    if (text.startsWith('insert into core.conversations')) {
      const id = `conv-${this.conversations.length + 1}`;
      this.conversations.push({ id, agent_id: params[0] });
      return { rows: [{ id }] };
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

function fakeApi(failOn?: (method: string) => boolean): {
  api: TelegramApi;
  sent: Sent[];
  updateQueue: TelegramUpdate[][];
} {
  const sent: Sent[] = [];
  const updateQueue: TelegramUpdate[][] = [];
  let nextMessageId = 100;
  const fetchLike: FetchLike = async (url, init) => {
    const method = url.split('/').pop() as string;
    const body = JSON.parse(init?.body ?? '{}');
    sent.push({ method, body });
    if (failOn?.(method)) {
      return {
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({ ok: false, description: 'message to edit not found' }),
      };
    }
    const result =
      method === 'getUpdates'
        ? (updateQueue.shift() ?? [])
        : method === 'sendMessage'
          ? { message_id: nextMessageId++ }
          : true;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result }),
    };
  };
  return { api: new TelegramApi({ token: 'test-token', fetch: fetchLike }), sent, updateQueue };
}

function message(updateId: number, userId: number, chatId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false, username: 'someone' },
      chat: { id: chatId, type: 'private' },
      text,
    },
  };
}

function surfaceWith(
  db: FakeDb,
  run = vi.fn(async () => 'reply'),
  extra: {
    failOn?: (method: string) => boolean;
    now?: () => number;
    runMission?: RunMission;
  } = {},
) {
  const { api, sent } = fakeApi(extra.failOn);
  const surface = new TelegramSurface({
    api,
    pool: db,
    agentId: 'finance-advisor',
    run,
    log: () => {},
    typingIntervalMs: 60_000,
    ...(extra.now ? { now: extra.now } : {}),
    ...(extra.runMission ? { runMission: extra.runMission } : {}),
  });
  return { surface, sent, run, api };
}

const OWNER = 4242;

/** Let queued microtasks (placeholder send, run start) settle. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function withOwner(db: FakeDb, chatId = OWNER): FakeDb {
  db.identities.push({
    owner_id: 'owner',
    surface: SURFACE,
    external_user_id: String(OWNER),
    external_chat_id: String(chatId),
  });
  return db;
}

/* ---------------- tests ---------------- */

describe('splitMessage', () => {
  it('leaves a short message alone', () => {
    expect(splitMessage('hello')).toEqual(['hello']);
  });

  it('splits at 4000 characters, on a line boundary when there is one', () => {
    const line = `${'x'.repeat(99)}\n`;
    const text = line.repeat(60); // 6000 chars
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4000);
    expect(chunks.join('\n').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
  });

  it('hard-cuts a single over-long line', () => {
    const chunks = splitMessage('y'.repeat(9000));
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(4000);
  });

  it('sends every chunk as its own plain-text message', async () => {
    const { api, sent } = fakeApi();
    await api.sendMessage(1, 'z'.repeat(9000));
    expect(sent.filter((s) => s.method === 'sendMessage')).toHaveLength(3);
    expect(sent[0]?.body.parse_mode).toBeUndefined();
  });
});

describe('TelegramSurface authorization', () => {
  it('ignores a non-owner message and records surface.rejected', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent, run } = surfaceWith(db);
    await surface.processUpdates([message(1, 9999, 9999, 'hello?')]);
    await surface.drain();

    expect(run).not.toHaveBeenCalled();
    expect(sent.filter((s) => s.method === 'sendMessage')).toHaveLength(0);
    expect(db.events).toHaveLength(1);
    expect(db.events[0]?.kind).toBe('surface.rejected');
    expect(db.events[0]?.payload).toMatchObject({
      reason: 'unpaired',
      externalUserId: '9999',
      updateId: '1',
    });
  });

  it('rejects the owner id speaking from another chat', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([message(2, OWNER, -100777, 'hi')]);
    await surface.drain();
    expect(sent.filter((s) => s.method === 'sendMessage')).toHaveLength(0);
    expect(db.events[0]?.payload).toMatchObject({ reason: 'chat-mismatch' });
  });

  it('rejects a group chat even from the owner', async () => {
    const db = withOwner(new FakeDb());
    const { surface, run } = surfaceWith(db);
    const update = message(3, OWNER, OWNER, 'hi');
    (update.message as any).chat.type = 'supergroup';
    await surface.processUpdates([update]);
    await surface.drain();
    expect(run).not.toHaveBeenCalled();
    expect(db.events[0]?.payload).toMatchObject({ reason: 'non-private-chat' });
  });
});

describe('TelegramSurface offline contract', () => {
  it('persists the update before advancing the offset', async () => {
    const db = withOwner(new FakeDb());
    const order: string[] = [];
    const spy = vi.spyOn(db, 'query');
    spy.mockImplementation(async function (this: any, sql: string, params?: any[]) {
      const text = sql.replace(/\s+/g, ' ').trim();
      if (text.startsWith('insert into core.surface_updates')) order.push('persist');
      if (text.startsWith('insert into core.surface_cursors')) order.push('advance');
      return FakeDb.prototype.query.call(db, sql, params);
    } as any);

    const { surface } = surfaceWith(db);
    await surface.processUpdates([message(10, OWNER, OWNER, 'hi')]);
    await surface.drain();

    expect(order).toEqual(['persist', 'advance']);
    expect(db.cursors.get(SURFACE)).toBe('11');
    expect(surface.offset).toBe(11);
  });

  it('does not advance the offset when persistence fails', async () => {
    const db = withOwner(new FakeDb());
    vi.spyOn(db, 'query').mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.replace(/\s+/g, ' ').trim().startsWith('insert into core.surface_updates')) {
        throw new Error('db down');
      }
      return FakeDb.prototype.query.call(db, sql, params);
    });
    const { surface } = surfaceWith(db);
    await expect(surface.processUpdates([message(20, OWNER, OWNER, 'hi')])).rejects.toThrow('db down');
    expect(db.cursors.get(SURFACE)).toBeUndefined();
    expect(surface.offset).toBeUndefined();
  });

  it('processes an update id exactly once', async () => {
    const db = withOwner(new FakeDb());
    const { surface, run } = surfaceWith(db);
    const update = message(30, OWNER, OWNER, 'what is my balance?');
    await surface.processUpdates([update]);
    await surface.drain();
    await surface.processUpdates([update, message(31, OWNER, OWNER, 'again')]);
    await surface.drain();

    expect(run).toHaveBeenCalledTimes(2);
    expect(db.updates.map((u) => u.update_id)).toEqual(['30', '31']);
    expect(surface.offset).toBe(32);
  });
});

describe('TelegramSurface conversation handling', () => {
  it('replies to /id with the numeric user and chat ids, without a run', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent, run } = surfaceWith(db);
    await surface.processUpdates([message(40, OWNER, OWNER, '/id')]);
    await surface.drain();

    const reply = sent.find((s) => s.method === 'sendMessage');
    expect(reply?.body.text).toBe(`Your Telegram user id: ${OWNER}\nThis chat id: ${OWNER}`);
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps one conversation per chat and starts a new one on /new', async () => {
    const db = withOwner(new FakeDb());
    const { surface, run } = surfaceWith(db);
    await surface.processUpdates([
      message(50, OWNER, OWNER, 'first'),
      message(51, OWNER, OWNER, 'second'),
    ]);
    await surface.drain();
    expect(run.mock.calls.map((c: any) => c[0].conversationId)).toEqual(['conv-1', 'conv-1']);

    await surface.processUpdates([message(52, OWNER, OWNER, '/new'), message(53, OWNER, OWNER, 'third')]);
    await surface.drain();
    expect(run.mock.calls.at(-1)?.[0].conversationId).toBe('conv-2');
  });

  it('maps /status onto the advisor status overview', async () => {
    const db = withOwner(new FakeDb());
    const { surface, run } = surfaceWith(db);
    await surface.processUpdates([message(60, OWNER, OWNER, '/status')]);
    await surface.drain();
    expect(run.mock.calls[0]?.[0].text).toBe('Status');
  });

  it('serializes runs per chat', async () => {
    const db = withOwner(new FakeDb());
    const order: string[] = [];
    let release: (() => void) | undefined;
    const run = vi.fn(async ({ text }: any) => {
      order.push(`start:${text}`);
      if (text === 'one') await new Promise<void>((r) => (release = r));
      order.push(`end:${text}`);
      return 'ok';
    });
    const { surface } = surfaceWith(db, run as any);
    const work = surface.processUpdates([
      message(70, OWNER, OWNER, 'one'),
      message(71, OWNER, OWNER, 'two'),
    ]);
    await work;
    await tick(); // the placeholder is posted before the run starts
    expect(order).toEqual(['start:one']);
    release?.();
    await surface.drain();
    expect(order).toEqual(['start:one', 'end:one', 'start:two', 'end:two']);
  });

  it('sends a typing action while the run is in progress', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([message(80, OWNER, OWNER, 'hello')]);
    await surface.drain();
    expect(sent.some((s) => s.method === 'sendChatAction' && s.body.action === 'typing')).toBe(true);
  });

  it('reports a failed run to the owner and logs surface.error', async () => {
    const db = withOwner(new FakeDb());
    const run = vi.fn(async () => {
      throw new Error('provider exploded');
    });
    const { surface, sent } = surfaceWith(db, run as any);
    await surface.processUpdates([message(90, OWNER, OWNER, 'hello')]);
    await surface.drain();
    const edit = sent.find((s) => s.method === 'editMessageText');
    expect(edit?.body.text).toContain('provider exploded');
    expect(db.events.map((e) => e.kind)).toContain('surface.error');
  });
});

describe('TelegramSurface progress bubble', () => {
  it('maps tool names to labels and falls back to the bare name', () => {
    expect(toolLabel('finance.list_accounts')).toBe('checking accounts');
    expect(toolLabel('finance.project_cashflow')).toBe('projecting cash flow');
    expect(toolLabel('finance.summary')).toBe('summarizing spending');
    expect(toolLabel('finance.list_liabilities')).toBe('checking debts');
    expect(toolLabel('finance.spending_baseline')).toBe('measuring typical spending');
    expect(toolLabel('finance.list_txns')).toBe('list txns');
    expect(toolLabel('other.thing_here')).toBe('other.thing here');
  });

  it('keeps the progress line under 200 characters', () => {
    const line = progressLine(Array.from({ length: 40 }, (_, n) => `label ${n}`));
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line.endsWith('…')).toBe(true);
  });

  it('sends the placeholder before the run starts', async () => {
    const db = withOwner(new FakeDb());
    let sentAtRun: Sent[] = [];
    let captured: Sent[] = [];
    const run = vi.fn(async () => {
      sentAtRun = [...captured];
      return 'reply';
    });
    const made = surfaceWith(db, run as any);
    captured = made.sent;
    await made.surface.processUpdates([message(100, OWNER, OWNER, 'hello')]);
    await made.surface.drain();

    expect(sentAtRun.filter((s) => s.method === 'sendMessage')).toHaveLength(1);
    expect(sentAtRun.find((s) => s.method === 'sendMessage')?.body.text).toBe(PLACEHOLDER_TEXT);
  });

  it('edits the placeholder with a progress line on a tool call', async () => {
    const db = withOwner(new FakeDb());
    const run = vi.fn(async ({ onToolCall }: any) => {
      onToolCall?.('finance.list_accounts', {});
      return 'reply';
    });
    const { surface, sent } = surfaceWith(db, run as any);
    await surface.processUpdates([message(101, OWNER, OWNER, 'hello')]);
    await surface.drain();

    const edits = sent.filter((s) => s.method === 'editMessageText');
    expect(edits[0]?.body.text).toBe('⏳ Working… (checking accounts)');
    expect(edits[0]?.body.message_id).toBe(100);
  });

  it('throttles edits to one per 1.5s', async () => {
    const db = withOwner(new FakeDb());
    let clock = 1_000;
    const run = vi.fn(async ({ onToolCall }: any) => {
      onToolCall?.('finance.list_accounts', {});
      clock += 100;
      onToolCall?.('finance.project_cashflow', {});
      return 'reply';
    });
    const { surface, sent } = surfaceWith(db, run as any, { now: () => clock });
    await surface.processUpdates([message(102, OWNER, OWNER, 'hello')]);
    await surface.drain();

    const edits = sent.filter((s) => s.method === 'editMessageText');
    // one progress edit (the second tool call is inside the throttle window),
    // plus the final answer edit.
    expect(edits).toHaveLength(2);
    expect(edits[0]?.body.text).toBe('⏳ Working… (checking accounts)');
    expect(edits[1]?.body.text).toBe('reply');
  });

  it('edits a progress line again once the throttle window has passed', async () => {
    const db = withOwner(new FakeDb());
    let clock = 1_000;
    const run = vi.fn(async ({ onToolCall }: any) => {
      onToolCall?.('finance.list_accounts', {});
      clock += 2_000;
      onToolCall?.('finance.project_cashflow', {});
      return 'reply';
    });
    const { surface, sent } = surfaceWith(db, run as any, { now: () => clock });
    await surface.processUpdates([message(103, OWNER, OWNER, 'hello')]);
    await surface.drain();

    const edits = sent.filter((s) => s.method === 'editMessageText').map((s) => s.body.text);
    expect(edits).toEqual([
      '⏳ Working… (checking accounts)',
      '⏳ Working… (checking accounts, projecting cash flow)',
      'reply',
    ]);
  });

  it('edits the placeholder into a short final answer', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db, vi.fn(async () => 'you have $12 left'));
    await surface.processUpdates([message(104, OWNER, OWNER, 'hello')]);
    await surface.drain();

    expect(sent.filter((s) => s.method === 'sendMessage')).toHaveLength(1); // placeholder only
    const edits = sent.filter((s) => s.method === 'editMessageText');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.body.text).toBe('you have $12 left');
    expect(sent.some((s) => s.method === 'deleteMessage')).toBe(false);
  });

  it('deletes the placeholder and sends chunks for a long answer', async () => {
    const db = withOwner(new FakeDb());
    const long = 'w'.repeat(9000);
    const { surface, sent } = surfaceWith(db, vi.fn(async () => long));
    await surface.processUpdates([message(105, OWNER, OWNER, 'hello')]);
    await surface.drain();

    const deletes = sent.filter((s) => s.method === 'deleteMessage');
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.body.message_id).toBe(100);
    expect(sent.filter((s) => s.method === 'editMessageText')).toHaveLength(0);
    // placeholder + three chunks
    expect(sent.filter((s) => s.method === 'sendMessage')).toHaveLength(4);
  });

  it('falls back to sendMessage when the final edit fails', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db, vi.fn(async () => 'the answer'), {
      failOn: (method) => method === 'editMessageText',
    });
    await surface.processUpdates([message(106, OWNER, OWNER, 'hello')]);
    await surface.drain();

    expect(sent.filter((s) => s.method === 'editMessageText')).toHaveLength(1);
    const sends = sent.filter((s) => s.method === 'sendMessage');
    expect(sends).toHaveLength(2);
    expect(sends[1]?.body.text).toBe('the answer');
  });

  it('does not post a placeholder for commands that do not run the agent', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([
      message(107, OWNER, OWNER, '/id'),
      message(108, OWNER, OWNER, '/new'),
      message(109, OWNER, OWNER, '/start'),
    ]);
    await surface.drain();

    expect(sent.filter((s) => s.method === 'sendMessage')).toHaveLength(3);
    expect(sent.some((s) => s.body.text === PLACEHOLDER_TEXT)).toBe(false);
    expect(sent.some((s) => s.method === 'editMessageText')).toBe(false);
  });
});

describe('TelegramSurface /recap', () => {
  it('runs the mission through the injected runMission and lands it in the bubble', async () => {
    const db = withOwner(new FakeDb());
    const runMission = vi.fn(async (_id: string, _chat: string, onToolCall?: any) => {
      onToolCall?.('finance.list_accounts', {});
      return { ok: true as const, text: 'cash is fine' };
    });
    const run = vi.fn(async () => 'reply');
    const { surface, sent } = surfaceWith(db, run, { runMission: runMission as any });
    await surface.processUpdates([message(120, OWNER, OWNER, '/recap')]);
    await surface.drain();

    expect(runMission).toHaveBeenCalledTimes(1);
    expect(runMission.mock.calls[0]?.[0]).toBe(RECAP_MISSION_ID);
    expect(runMission.mock.calls[0]?.[1]).toBe(String(OWNER));
    expect(run).not.toHaveBeenCalled();

    // placeholder -> progress line -> final answer, one bubble throughout
    const sends = sent.filter((s) => s.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body.text).toBe(PLACEHOLDER_TEXT);
    const edits = sent.filter((s) => s.method === 'editMessageText').map((s) => s.body.text);
    expect(edits).toEqual(['⏳ Working… (checking accounts)', 'cash is fine']);
  });

  it('says /recap needs buddi serve when no runner is wired', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([message(121, OWNER, OWNER, '/recap')]);
    await surface.drain();

    const sends = sent.filter((s) => s.method === 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(sends[0]?.body.text).toBe(RECAP_UNAVAILABLE_TEXT);
    expect(sends[0]?.body.text).toContain('buddi serve');
    expect(sent.some((s) => s.method === 'editMessageText')).toBe(false);
  });

  it('explains how to register the mission when it is unknown', async () => {
    const db = withOwner(new FakeDb());
    const runMission = vi.fn(async () => ({ ok: false as const, reason: 'unknown-mission' as const }));
    const { surface, sent } = surfaceWith(db, vi.fn(async () => 'reply'), {
      runMission: runMission as any,
    });
    await surface.processUpdates([message(122, OWNER, OWNER, '/recap')]);
    await surface.drain();

    const edits = sent.filter((s) => s.method === 'editMessageText');
    expect(edits).toHaveLength(1);
    expect(edits[0]?.body.text).toBe(RECAP_NOT_REGISTERED_TEXT);
    expect(edits[0]?.body.text).toContain('pnpm missions add-friday-recap');
  });

  it('reports a failing mission in the bubble', async () => {
    const db = withOwner(new FakeDb());
    const runMission = vi.fn(async () => {
      throw new Error('no provider');
    });
    const { surface, sent } = surfaceWith(db, vi.fn(async () => 'reply'), {
      runMission: runMission as any,
    });
    await surface.processUpdates([message(123, OWNER, OWNER, '/recap')]);
    await surface.drain();

    expect(sent.find((s) => s.method === 'editMessageText')?.body.text).toContain('no provider');
    expect(db.events.map((e) => e.kind)).toContain('surface.error');
  });

  it('answers /help with the same welcome text as /start', async () => {
    const db = withOwner(new FakeDb());
    const { surface, sent } = surfaceWith(db);
    await surface.processUpdates([
      message(124, OWNER, OWNER, '/start'),
      message(125, OWNER, OWNER, '/help'),
    ]);
    await surface.drain();

    const sends = sent.filter((s) => s.method === 'sendMessage').map((s) => s.body.text);
    expect(sends).toEqual([HELP, HELP]);
    expect(HELP).toContain('/recap');
  });
});

describe('notifyOwner', () => {
  it('sends to the paired owner chat', async () => {
    const db = withOwner(new FakeDb(), 777);
    const { api, sent } = fakeApi();
    expect(await ownerChatId(db)).toBe('777');
    const chat = await notifyOwner('recap ready', { pool: db, api });
    expect(chat).toBe('777');
    expect(sent[0]).toMatchObject({ method: 'sendMessage', body: { chat_id: '777', text: 'recap ready' } });
  });

  it('fails with a typed error when nothing is paired', async () => {
    const db = new FakeDb();
    const { api } = fakeApi();
    await expect(notifyOwner('recap', { pool: db, api })).rejects.toBeInstanceOf(OwnerNotPairedError);
  });
});
