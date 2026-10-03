/**
 * Keep and Stop under "Still useful?" on Telegram: the channel draws them,
 * a tap is owner-only and idempotent, and the message is edited to say what
 * came of it.
 *
 * The DB suite is skipped unless DATABASE_URL is set.
 */
import {
  createPool,
  ensureOwner,
  getMission,
  getNotification,
  noteMissionRun,
  notifyOwner as coreNotify,
  pairSurfaceIdentity,
  runMigrations,
  stillUsefulKey,
  upsertMission,
  type DeliverableMessage,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TelegramApi, type FetchLike, type TelegramUpdate } from './api.js';
import { createTelegramChannel } from './channel.js';
import { callbackKind, TelegramSurface } from './surface.js';
import { parseStillUsefulCallback, stillUsefulCallbackData, stillUsefulKeyboard } from './still-useful.js';
import type { AgentCatalog } from './types.js';

const NOTE_ID = '33333333-3333-4333-8333-333333333333';
const OWNER = '4242';

describe('the still-useful callback payload', () => {
  it('binds the notification id and the choice under its own prefix', () => {
    expect(stillUsefulCallbackData(NOTE_ID, 'keep')).toBe(`stl:${NOTE_ID}:k`);
    expect(parseStillUsefulCallback(stillUsefulCallbackData(NOTE_ID, 'stop'))).toEqual({ notificationId: NOTE_ID, choice: 'stop' });
    expect(callbackKind(stillUsefulCallbackData(NOTE_ID, 'keep'))).toBe('still-useful');
    expect(parseStillUsefulCallback('stl:nope:k')).toBeUndefined();
    expect(parseStillUsefulCallback(`stl:${NOTE_ID}:x`)).toBeUndefined();
  });
});

describe('the Telegram channel', () => {
  const message = (over: Partial<DeliverableMessage> = {}): DeliverableMessage => ({
    id: NOTE_ID,
    kind: 'watcher',
    urgency: 'today',
    title: 'Still useful? Price watch',
    text: 'It has run 48 times in a row without anything to tell you. Keep it, or stop it.',
    action: 'Keep or stop it?',
    dedupeKey: stillUsefulKey('agent:researcher:price-watch'),
    ...over,
  });

  it('draws Keep and Stop instead of the spelled-out action', async () => {
    const sendText = vi.fn(async () => OWNER);
    const channel = createTelegramChannel({ pool: { query: async () => ({ rows: [] }) }, sendText });
    await channel.deliver(message());
    const [text, opts] = sendText.mock.calls[0] as unknown as [string, { replyMarkup?: unknown }];
    expect(text).not.toContain('Keep or stop it?');
    expect(text).toContain('Still useful? Price watch');
    expect(opts.replyMarkup).toEqual(stillUsefulKeyboard(NOTE_ID));
  });

  it('adds the card after an end-of-day message that gathered one', async () => {
    const sendText = vi.fn(async () => OWNER);
    const channel = createTelegramChannel({ pool: { query: async () => ({ rows: [] }) }, sendText });
    await channel.deliver({ id: 'today:2026-10-02', kind: 'watcher', urgency: 'today', title: 'Today', parts: [message()] });
    expect(sendText).toHaveBeenCalledTimes(2);
    const [, opts] = sendText.mock.calls[1] as unknown as [string, { replyMarkup?: unknown }];
    expect(opts.replyMarkup).toEqual(stillUsefulKeyboard(NOTE_ID));
  });

  it('leaves any other message as it was', async () => {
    const sendText = vi.fn(async () => OWNER);
    const channel = createTelegramChannel({ pool: { query: async () => ({ rows: [] }) }, sendText });
    await channel.deliver(message({ dedupeKey: 'something-else' }));
    const [text, opts] = sendText.mock.calls[0] as unknown as [string, { replyMarkup?: unknown }];
    expect(text).toContain('→ Keep or stop it?');
    expect(opts.replyMarkup).toBeUndefined();
  });
});

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const name = `buddi_tg_still_useful_${process.pid}`;

function fakeApi(): { api: TelegramApi; sent: { method: string; body: any }[] } {
  const sent: { method: string; body: any }[] = [];
  const fetchLike: FetchLike = async (url, init) => {
    const method = url.split('/').pop() as string;
    sent.push({ method, body: JSON.parse(String(init?.body ?? '{}')) });
    const result = method === 'sendMessage' ? { message_id: 1 } : true;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result }) };
  };
  return { api: new TelegramApi({ token: 't', fetch: fetchLike }), sent };
}

suite('Keep and Stop taps', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${name}`);
    await admin.query(`create database ${name}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${name}`;
    pool = createPool(url.toString());
    await runMigrations(pool, []);
    await ensureOwner(pool, 'owner');
    await pairSurfaceIdentity(pool, { surface: 'telegram', externalUserId: OWNER, externalChatId: OWNER, pairedVia: 'code' });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${name}`);
      await admin.end();
    }
  });

  async function asked(missionId: string): Promise<string> {
    await upsertMission(pool, { id: missionId, name: 'Price watch', agentId: 'researcher', prompt: 'p' });
    await noteMissionRun(pool, missionId, false, new Date(), 1);
    const result = await coreNotify(pool, { now: () => new Date() }, {
      kind: 'watcher',
      urgency: 'today',
      title: 'Still useful? Price watch',
      text: 'It has run 48 times in a row without anything to tell you.',
      action: 'Keep or stop it?',
      dedupeKey: stillUsefulKey(missionId),
    });
    return result.id;
  }

  function surface() {
    const { api, sent } = fakeApi();
    const s = new TelegramSurface({
      api,
      pool,
      catalog: { get: () => undefined, list: () => [] } as unknown as AgentCatalog,
      timezone: 'UTC',
      run: vi.fn(async () => 'reply'),
      log: () => {},
      typingIntervalMs: 60_000,
    } as any);
    return { s, sent };
  }

  const tap = (data: string, from = Number(OWNER)) =>
    ({
      id: 'cb-1',
      from: { id: from, is_bot: false, first_name: 'Owner' },
      message: { message_id: 77, chat: { id: Number(OWNER), type: 'private' } },
      data,
    }) as unknown as NonNullable<TelegramUpdate['callback_query']>;

  it('Keep starts the count again, edits the message and says "Already kept" on a second tap', async () => {
    const missionId = 'agent:researcher:keep-watch';
    const noteId = await asked(missionId);
    const { s, sent } = surface();
    await s.handleStillUsefulCallback(tap(stillUsefulCallbackData(noteId, 'keep')));
    const mission = await getMission(pool, missionId);
    expect(mission).toMatchObject({ enabled: true, quietRuns: 0, stillUsefulAskedAt: null });
    expect((await getNotification(pool, noteId))?.actedAt).not.toBeNull();
    const edit = sent.find((x) => x.method === 'editMessageText');
    expect(edit?.body.text).toContain('Still useful? Price watch');
    expect(edit?.body.text).toContain('Kept.');
    expect(edit?.body.reply_markup).toEqual({ inline_keyboard: [] });

    await s.handleStillUsefulCallback(tap(stillUsefulCallbackData(noteId, 'keep')));
    const answers = sent.filter((x) => x.method === 'answerCallbackQuery');
    expect(answers.at(-1)?.body.text).toBe('Already kept.');
  });

  it('Stop switches the mission off, once', async () => {
    const missionId = 'agent:researcher:stop-watch';
    const noteId = await asked(missionId);
    const { s, sent } = surface();
    await s.handleStillUsefulCallback(tap(stillUsefulCallbackData(noteId, 'stop')));
    expect((await getMission(pool, missionId))?.enabled).toBe(false);
    expect(sent.find((x) => x.method === 'editMessageText')?.body.text).toContain('Stopped.');
    await s.handleStillUsefulCallback(tap(stillUsefulCallbackData(noteId, 'keep')));
    expect(sent.filter((x) => x.method === 'answerCallbackQuery').at(-1)?.body.text).toBe('Already stopped.');
    expect((await getMission(pool, missionId))?.enabled).toBe(false);
  });

  it('ignores a tap from anyone but the owner', async () => {
    const missionId = 'agent:researcher:stranger-watch';
    const noteId = await asked(missionId);
    const { s, sent } = surface();
    await s.handleStillUsefulCallback(tap(stillUsefulCallbackData(noteId, 'stop'), 999));
    expect((await getMission(pool, missionId))?.enabled).toBe(true);
    expect(sent.some((x) => x.method === 'editMessageText')).toBe(false);
  });
});
