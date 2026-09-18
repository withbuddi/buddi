/**
 * Offered actions on Telegram: the buttons under a report, and what a tap does.
 *
 * The rules are the ones every other callback follows — the id is bound into
 * `callback_data`, the sender is re-authenticated against core on every tap,
 * a stranger learns nothing — plus the one that is specific to offers and
 * matters most: **a tap authorizes nothing.** It claims a row and starts an
 * ordinary agent run with the prompt the agent wrote. It cannot carry a prompt
 * of its own, it cannot send anything, and nothing about it shortens the path
 * an effect takes through the owner's approval.
 *
 * No network and no database: a fake Bot API and an in-memory `Queryable`.
 */
import {
  renderOffers,
  roleProblemMessage,
  TELEGRAM_SURFACE,
  UnknownAgentError,
  type Offer,
  type Queryable,
} from '@buddi/core';
import { describe, expect, it, vi } from 'vitest';
import { TelegramApi, type FetchLike, type TelegramUpdate } from './api.js';
import {
  callbackKind,
  offerCallbackData,
  offersKeyboard,
  OFFER_TAKEN_TEXT,
  parseOfferCallback,
  parseQuestionCallback,
  questionCallbackData,
  questionKeyboard,
  SURFACE,
  TelegramSurface,
} from './surface.js';
import type { AgentCatalog, CatalogAgent } from './types.js';

const OWNER_USER = '4242';
const OWNER_CHAT = '4242';
const STRANGER = '9999';
const TZ = 'America/New_York';
const ID_ONE = '11111111-1111-4111-8111-111111111111';
const ID_TWO = '22222222-2222-4222-8222-222222222222';

function offer(id: string, label: string, prompt: string): Offer {
  return {
    id,
    agentId: 'mail-triage',
    conversationId: null,
    label,
    prompt,
    createdAt: '2026-09-15T09:00:00.000Z',
    expiresAt: '2026-09-22T09:00:00.000Z',
    takenAt: null,
    takenVia: null,
    takenJobId: null,
  };
}

/* ---------------- in-memory core tables ---------------- */

class FakeDb implements Queryable {
  paired = true;
  offers: Offer[] = [];
  events: { kind: string; payload: any }[] = [];

  #row(o: Offer): Record<string, unknown> {
    return {
      id: o.id,
      agent_id: o.agentId,
      conversation_id: o.conversationId,
      label: o.label,
      prompt: o.prompt,
      created_at: o.createdAt,
      expires_at: o.expiresAt,
      taken_at: o.takenAt,
      taken_via: o.takenVia,
      taken_job_id: o.takenJobId,
    };
  }

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

    if (text.startsWith('update core.offers set taken_at')) {
      const row = this.offers.find((o) => o.id === params[0] && o.takenAt === null);
      if (!row) return { rows: [] };
      row.takenAt = (params[1] as Date).toISOString();
      row.takenVia = params[2];
      return { rows: [this.#row(row)] };
    }

    if (text.startsWith('update core.offers set taken_job_id')) {
      const row = this.offers.find((o) => o.id === params[0]);
      if (row) row.takenJobId = params[1];
      return { rows: [] };
    }

    if (text.startsWith('select id, agent_id, conversation_id, label, prompt')) {
      const row = this.offers.find((o) => o.id === params[0]);
      return { rows: row ? [this.#row(row)] : [] };
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
    sent.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
    const result =
      method === 'sendMessage' ? { message_id: nextMessageId++ } : method === 'getUpdates' ? [] : true;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result }) };
  };
  return { api: new TelegramApi({ token: 't', fetch: fetchLike }), sent };
}

function fakeCatalog(): AgentCatalog {
  const agents = [
    { id: 'mail-triage', handle: 'postman', name: 'Mail Triage', description: 't', isDefault: true, roles: [] },
  ].map((a) => a as unknown as CatalogAgent);
  const byDefault = agents[0] as CatalogAgent;
  return {
    get: (id) => agents.find((a) => a.id === id),
    byHandle: (handle) => agents.find((a) => a.handle === handle.replace(/^@/, '')),
    list: () => agents.map((a) => ({ ...a })) as any,
    agentsWithRole: () => [],
    agentForRole: (role: string) =>
      ({
        ok: false,
        problem: { code: 'no-agent-for-role', role, message: roleProblemMessage(role) },
      }) as const,
    defaultAgent: () => byDefault,
    resolve: (id) => {
      if (id === undefined) return byDefault;
      const found = agents.find((a) => a.id === id);
      if (!found) throw new UnknownAgentError(id, agents.map((a) => a.id));
      return found;
    },
  };
}

function surfaceWith(db: FakeDb, takeOffer?: (o: Offer) => Promise<string | undefined>) {
  const { api, sent } = fakeApi();
  const surface = new TelegramSurface({
    api,
    pool: db,
    catalog: fakeCatalog(),
    timezone: TZ,
    run: vi.fn(async () => 'reply'),
    log: () => {},
    typingIntervalMs: 60_000,
    ...(takeOffer ? { takeOffer } : {}),
  } as any);
  return { surface, sent };
}

const tap = (id: string, fromId = Number(OWNER_USER)): NonNullable<TelegramUpdate['callback_query']> =>
  ({
    id: 'cb-1',
    from: { id: fromId, is_bot: false, first_name: 'Owner' },
    message: { message_id: 55, chat: { id: Number(OWNER_CHAT), type: 'private' }, date: 0 },
    data: offerCallbackData(id),
  }) as unknown as NonNullable<TelegramUpdate['callback_query']>;

/* ---------------- the tests ---------------- */

describe('the offer callback payload', () => {
  it('carries the id and is owned by its own prefix', () => {
    expect(offerCallbackData(ID_ONE)).toBe(`off:${ID_ONE}`);
    expect(parseOfferCallback(offerCallbackData(ID_ONE))).toBe(ID_ONE);
    expect(callbackKind(offerCallbackData(ID_ONE))).toBe('offer');
    // The other three prefixes keep what is theirs.
    expect(callbackKind('use:mail-triage')).toBe('agent');
    expect(callbackKind(`rem:${ID_ONE}:cancel`)).toBe('reminder');
    expect(callbackKind(`apr:${ID_ONE}:approve`)).toBe('approval');
  });

  it('refuses anything that is not a uuid tap', () => {
    expect(parseOfferCallback('off:not-a-uuid')).toBeUndefined();
    expect(parseOfferCallback(`off:${ID_ONE}:extra`)).toBeUndefined();
    expect(parseOfferCallback(undefined)).toBeUndefined();
  });

  it('carries no prompt, so a tap can never steer the run', () => {
    // The whole payload is a prefix and an id. There is nowhere for text off
    // the wire to travel, which is why the prompt that runs is the stored one.
    expect(offerCallbackData(ID_ONE)).not.toMatch(/draft|reply|prompt/i);
    expect(Buffer.byteLength(offerCallbackData(ID_ONE))).toBeLessThanOrEqual(64);
  });
});

describe('the question callback payload', () => {
  it('binds a compact option index to one exact question id', () => {
    expect(questionCallbackData(ID_ONE, 1)).toBe(`q:${ID_ONE}:1`);
    expect(parseQuestionCallback(questionCallbackData(ID_ONE, 1))).toEqual({ id: ID_ONE, index: 1 });
    expect(callbackKind(questionCallbackData(ID_ONE, 1))).toBe('question');
    expect(parseQuestionCallback(`q:${ID_ONE}:99`)).toBeUndefined();
  });

  it('marks the recommendation without changing the answer label', () => {
    const keyboard = questionKeyboard({
      id: ID_ONE,
      agentId: 'ledger',
      conversationId: ID_TWO,
      question: 'Which account?',
      options: [
        { id: 'checking', label: 'Checking', hint: 'Best match', recommended: true },
        { id: 'savings', label: 'Savings', hint: null, recommended: false },
      ],
      allowOther: true,
      createdAt: '2026-09-17T20:00:00Z',
      expiresAt: '2026-09-17T20:30:00Z',
      answeredAt: null,
      answeredVia: null,
      answer: null,
    });
    expect(keyboard.inline_keyboard.map((row) => row[0]?.text)).toEqual(['★ Checking', 'Savings']);
  });
});

describe('the keyboard a report carries', () => {
  const offers = [
    offer(ID_ONE, 'Draft a reply', 'Draft a reply to Dorothée and show it to me.'),
    offer(ID_TWO, 'Remind me tomorrow', 'Remind me tomorrow about the CdC site.'),
  ];

  it('draws one button per offer, bound to its id', () => {
    const keyboard = offersKeyboard(offers);
    expect(keyboard.inline_keyboard).toEqual([
      [{ text: 'Draft a reply', callback_data: `off:${ID_ONE}` }],
      [{ text: 'Remind me tomorrow', callback_data: `off:${ID_TWO}` }],
    ]);
  });

  it('is what Telegram gets, because Telegram declares that it has buttons', () => {
    const rendered = renderOffers(TELEGRAM_SURFACE, 'Dorothée has retired.', offers);
    expect(rendered.controls).toHaveLength(2);
    // Not appended to the text: on this surface the owner taps, not reads.
    expect(rendered.text).toBe('Dorothée has retired.');
  });
});

describe('a tap on an offered action', () => {
  const seed = (db: FakeDb): void => {
    db.offers.push(offer(ID_ONE, 'Draft a reply', 'Draft a reply to Dorothée and show it to me.'));
  };

  it('claims the offer and starts a run with the prompt the agent wrote', async () => {
    const db = new FakeDb();
    seed(db);
    const started: Offer[] = [];
    const { surface, sent } = surfaceWith(db, async (o) => {
      started.push(o);
      return 'job-1';
    });

    await surface.handleOfferCallback(tap(ID_ONE));

    expect(started).toHaveLength(1);
    expect(started[0]?.agentId).toBe('mail-triage');
    expect(started[0]?.prompt).toBe('Draft a reply to Dorothée and show it to me.');
    expect(db.offers[0]?.takenAt).not.toBeNull();
    expect(db.offers[0]?.takenJobId).toBe('job-1');
    expect(sent.find((s) => s.method === 'answerCallbackQuery')?.body.text).toBe(OFFER_TAKEN_TEXT);
  });

  it('takes the keyboard away, so the same offer is not tappable twice', async () => {
    const db = new FakeDb();
    seed(db);
    const { surface, sent } = surfaceWith(db, async () => 'job-1');
    await surface.handleOfferCallback(tap(ID_ONE));
    const edit = sent.find((s) => s.method === 'editMessageReplyMarkup');
    expect(edit?.body.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it('starts exactly one run however many times it is tapped', async () => {
    const db = new FakeDb();
    seed(db);
    let runs = 0;
    const { surface } = surfaceWith(db, async () => {
      runs += 1;
      return `job-${runs}`;
    });
    await surface.handleOfferCallback(tap(ID_ONE));
    await surface.handleOfferCallback(tap(ID_ONE));
    await surface.handleOfferCallback(tap(ID_ONE));
    expect(runs).toBe(1);
  });

  it('tells a stranger nothing, starts nothing, and records the rejection', async () => {
    const db = new FakeDb();
    seed(db);
    let runs = 0;
    const { surface, sent } = surfaceWith(db, async () => {
      runs += 1;
      return 'job-1';
    });

    await surface.handleOfferCallback(tap(ID_ONE, Number(STRANGER)));

    expect(runs).toBe(0);
    expect(db.offers[0]?.takenAt).toBeNull();
    expect(db.events.map((e) => e.kind)).toContain('surface.rejected');
    // A stopped spinner and nothing else: no text, no hint that the id exists.
    expect(sent.find((s) => s.method === 'answerCallbackQuery')?.body.text).toBeUndefined();
  });

  it('answers honestly when no worker is wired, rather than pretending', async () => {
    const db = new FakeDb();
    seed(db);
    const { surface, sent } = surfaceWith(db);
    await surface.handleOfferCallback(tap(ID_ONE));
    // Claimed, answered, and no run — the same shape every other optional hook
    // on this surface has.
    expect(db.offers[0]?.takenAt).not.toBeNull();
    expect(db.offers[0]?.takenJobId).toBeNull();
    expect(sent.some((s) => s.method === 'answerCallbackQuery')).toBe(true);
  });

  it('refuses an id that names nothing', async () => {
    const db = new FakeDb();
    let runs = 0;
    const { surface } = surfaceWith(db, async () => {
      runs += 1;
      return 'job-1';
    });
    await surface.handleOfferCallback(tap(ID_TWO));
    expect(runs).toBe(0);
  });
});
