/**
 * Reactions on Telegram, read as feedback (docs/telegram.md, "Reactions").
 *
 * The surface is real and so is the database; the Bot API is a recording
 * fake and the run is a stub that writes the turn the way the runtime does
 * (an assistant message and a `run.finished` event). Nothing reaches Telegram.
 *
 * Skipped unless DATABASE_URL is set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  completeOnboarding,
  createPool,
  ensureOwner,
  pairSurfaceIdentity,
  roleProblemMessage,
  runMigrations,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import type { TelegramApi, TelegramUpdate } from './api.js';
import { TelegramSurface } from './surface.js';
import { NOTE_ACK_EMOJI, WHAT_WAS_OFF_TEXT } from './reactions.js';
import type { AgentCatalog, CatalogAgent } from './types.js';
import { composeDigest, digestText } from '../agents/learning-digest.js';
import { readChatTranscript } from '../web/chat.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const name = `buddi_tg_reactions_${process.pid}`;

const AGENT_ID = 'ledger-agent';
const OWNER = 4242;
const STRANGER = 9999;

function fakeCatalog(): AgentCatalog {
  const one = {
    id: AGENT_ID, handle: 'ledger', name: 'Ledger', description: 't', isDefault: true, roles: [],
  } as unknown as CatalogAgent;
  return {
    get: (id: string) => (id === one.id ? one : undefined),
    byHandle: (handle: string) => (handle.replace(/^@/, '') === one.handle ? one : undefined),
    list: () => [one] as any,
    agentsWithRole: () => [],
    agentForRole: (role: string) => ({
      ok: false as const,
      problem: { code: 'no-agent-for-role' as const, role, message: roleProblemMessage(role) },
    }),
    defaultAgent: () => one,
    resolve: () => one,
  } as unknown as AgentCatalog;
}

type Call = { method: string; args: unknown[] };

function fakeApi(calls: Call[]): TelegramApi {
  let next = 100;
  const base: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    sendMessage: async (...args) => {
      calls.push({ method: 'sendMessage', args });
      return next++;
    },
  };
  return new Proxy(base, {
    get: (target, prop) => target[prop as string] ?? (async (...args: unknown[]) => {
      calls.push({ method: String(prop), args });
      return undefined;
    }),
  }) as unknown as TelegramApi;
}

let updateId = 1;
function reaction(messageId: number, emoji: string | null, from = OWNER): TelegramUpdate {
  return {
    update_id: updateId++,
    message_reaction: {
      chat: { id: from, type: 'private' },
      message_id: messageId,
      user: { id: from, first_name: 'Owner' },
      old_reaction: [],
      new_reaction: emoji ? [{ type: 'emoji', emoji }] : [],
    },
  };
}

function text(body: string, replyTo?: number): TelegramUpdate {
  return {
    update_id: updateId++,
    message: {
      message_id: 500 + updateId,
      from: { id: OWNER, first_name: 'Owner' },
      chat: { id: OWNER, type: 'private' },
      text: body,
      ...(replyTo === undefined ? {} : { reply_to_message: { message_id: replyTo } }),
    },
  };
}

suite('reactions on Telegram', () => {
  let admin: Pool;
  let pool: Pool;
  let calls: Call[];
  let runs: string[];
  let surface: TelegramSurface;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${name}`);
    await admin.query(`create database ${name}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${name}`;
    pool = createPool(url.toString());
    await runMigrations(pool, []);
    await ensureOwner(pool, 'owner');
    await completeOnboarding(pool, 'fixture');
    await pairSurfaceIdentity(pool, { surface: 'telegram', externalUserId: String(OWNER), externalChatId: String(OWNER), pairedVia: 'code' });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${name}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('truncate core.message_feedback, core.surface_sent_messages');
    await pool.query('truncate core.messages, core.events cascade');
    await pool.query('truncate core.conversations cascade');
    await pool.query('truncate core.surface_conversations');
    calls = [];
    runs = [];
    surface = new TelegramSurface({
      api: fakeApi(calls),
      pool,
      catalog: fakeCatalog(),
      timezone: 'UTC',
      typingIntervalMs: 60_000,
      log: () => {},
      run: async (req: { conversationId: string; text: string }) => {
        runs.push(req.text);
        await pool.query(
          `insert into core.messages (conversation_id, role, content) values ($1, 'user', $2::jsonb)`,
          [req.conversationId, JSON.stringify([{ type: 'text', text: req.text }])],
        );
        await pool.query(
          `insert into core.messages (conversation_id, role, content) values ($1, 'assistant', $2::jsonb)`,
          [req.conversationId, JSON.stringify([{ type: 'text', text: 'Here is the answer.' }])],
        );
        await pool.query(
          `insert into core.events (kind, conversation_id, payload) values ('run.finished', $1, '{"turns":1}'::jsonb)`,
          [req.conversationId],
        );
        return 'Here is the answer.';
      },
    } as any);
  });

  /** One turn; the id of the message the answer landed in. */
  async function turn(): Promise<number> {
    await surface.processUpdates([text('How much did I spend?')]);
    await surface.drain();
    const { rows } = await pool.query(`select external_message_id from core.surface_sent_messages order by created_at desc limit 1`);
    expect(rows).toHaveLength(1);
    return Number(rows[0].external_message_id);
  }

  async function feedbackRows() {
    const { rows } = await pool.query(`select * from core.message_feedback order by created_at`);
    return rows;
  }

  it("files the owner's 👍 against the message and the run behind it, and says nothing", async () => {
    const answered = await turn();
    const before = calls.length;
    await surface.processUpdates([reaction(answered, '👍')]);

    const [row] = await feedbackRows();
    const { rows: [assistant] } = await pool.query(`select id, conversation_id from core.messages where role = 'assistant'`);
    const { rows: [run] } = await pool.query(`select id from core.events where kind = 'run.finished'`);
    expect(row).toMatchObject({ value: 'up', emoji: '👍', agent_id: AGENT_ID, source: 'telegram', cleared_at: null });
    expect(String(row.message_id)).toBe(String(assistant.id));
    expect(String(row.run_event_id)).toBe(String(run.id));
    expect(calls.slice(before)).toEqual([]);
  });

  it('clears the feedback when the reaction is taken back', async () => {
    const answered = await turn();
    await surface.processUpdates([reaction(answered, '❤️')]);
    expect((await feedbackRows())[0].value).toBe('up');
    await surface.processUpdates([reaction(answered, null)]);
    expect((await feedbackRows())[0].cleared_at).not.toBeNull();
  });

  it("ignores a stranger's reaction", async () => {
    const answered = await turn();
    const before = calls.length;
    await surface.processUpdates([reaction(answered, '👍', STRANGER)]);
    expect(await feedbackRows()).toEqual([]);
    expect(calls.slice(before)).toEqual([]);
  });

  it('asks "What was off?" once on a 👎, and keeps the reply as its note', async () => {
    const answered = await turn();
    const before = calls.length;
    await surface.processUpdates([reaction(answered, '👎')]);
    const asked = calls.slice(before).filter((c) => c.method === 'sendMessage');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.args[1]).toBe(WHAT_WAS_OFF_TEXT);
    expect(asked[0]!.args[2]).toMatchObject({ replyTo: answered });

    // Changing their mind and back again never asks a second time.
    await surface.processUpdates([reaction(answered, '👍'), reaction(answered, null), reaction(answered, '👎')]);
    expect(calls.slice(before).filter((c) => c.method === 'sendMessage')).toHaveLength(1);

    const { rows: [fb] } = await pool.query(`select ask_message_id from core.message_feedback`);
    const runsBefore = runs.length;
    const afterAsk = calls.length;
    await surface.processUpdates([text('The total missed the card payments.', Number(fb.ask_message_id))]);
    await surface.drain();
    const [row] = await feedbackRows();
    expect(row).toMatchObject({ value: 'down', note: 'The total missed the card payments.' });
    // Not a turn, not a message: one quiet reaction.
    expect(runs.length).toBe(runsBefore);
    const replies = calls.slice(afterAsk);
    expect(replies.map((c) => c.method)).toEqual(['setMessageReaction']);
    expect(replies[0]!.args[2]).toBe(NOTE_ACK_EMOJI);
  });

  it('treats a Reply to anything else as an ordinary message', async () => {
    const answered = await turn();
    const runsBefore = runs.length;
    await surface.processUpdates([text('And last month?', answered)]);
    await surface.drain();
    expect(runs.length).toBe(runsBefore + 1);
  });

  it('feeds the weekly digest and the dashboard transcript', async () => {
    const answered = await turn();
    await surface.processUpdates([reaction(answered, '👎')]);
    const { rows: [fb] } = await pool.query(`select ask_message_id, conversation_id, message_id from core.message_feedback`);
    await surface.processUpdates([text('Wrong month.', Number(fb.ask_message_id))]);
    await surface.drain();

    const digest = await composeDigest(pool, { now: new Date(), manifests: [] });
    expect(digest.feedback?.byAgent[AGENT_ID]).toEqual({ up: 0, down: 1, neutral: 0 });
    expect(digest.feedback?.notes).toEqual([{ agentId: AGENT_ID, note: 'Wrong month.' }]);
    const said = digestText(digest, 'http://x/proposals');
    expect(said).toContain(`Your reactions: ${AGENT_ID} 1 👎.`);
    expect(said).toContain('Wrong month.');

    const transcript = await readChatTranscript(pool, String(fb.conversation_id));
    const message = transcript!.messages.find((m) => m.id === String(fb.message_id));
    expect(message?.feedback).toEqual({ value: 'down', emoji: '👎', source: 'telegram', note: 'Wrong month.' });
  });
});
