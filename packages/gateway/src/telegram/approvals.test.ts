/**
 * Telegram approvals.
 *
 * The pure half (parsing, keyboards, rendering) runs anywhere. The half that
 * matters most — who may decide, and what one tap actually does — runs against
 * a throwaway Postgres, because "the owner approved this" is a fact in core's
 * tables and faking it would be testing the fake.
 */
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  ToolRegistry,
  createAction,
  createPool,
  ensureOwner,
  getAction,
  migrate,
  pairSurfaceIdentity,
  type PluginManifest,
  type ToolContext,
} from '@buddi/core';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  TelegramApprovals,
  approvalCallbackData,
  approvalKeyboard,
  approvalRequestText,
  decidedText,
  parseApprovalCallback,
  pendingText,
  type CallbackQuery,
} from './approvals.js';
import { MAX_CALLBACK_DATA_BYTES } from './api.js';

const ACTION_ID = '33333333-3333-3333-3333-333333333333';

describe('approval callbacks (pure)', () => {
  it('round-trips an action id through callback_data, within Telegram’s limit', () => {
    const data = approvalCallbackData(ACTION_ID, 'approve');
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(MAX_CALLBACK_DATA_BYTES);
    expect(parseApprovalCallback(data)).toEqual({ actionId: ACTION_ID, decision: 'approved' });
    expect(parseApprovalCallback(approvalCallbackData(ACTION_ID, 'reject'))).toEqual({
      actionId: ACTION_ID,
      decision: 'rejected',
    });
  });

  it('parses nothing else — a plain "yes" is not an approval', () => {
    for (const data of [
      undefined,
      '',
      'yes',
      'approve',
      `apr:${ACTION_ID}`,
      `apr:${ACTION_ID}:maybe`,
      'apr:not-a-uuid:approve',
      `apr:${ACTION_ID}:approve extra`,
    ]) {
      expect(parseApprovalCallback(data)).toBeUndefined();
    }
  });

  it('builds one row of two buttons, each bound to this action', () => {
    const keyboard = approvalKeyboard(ACTION_ID);
    expect(keyboard.inline_keyboard).toHaveLength(1);
    expect(keyboard.inline_keyboard[0]?.map((b) => b.callback_data)).toEqual([
      `apr:${ACTION_ID}:approve`,
      `apr:${ACTION_ID}:reject`,
    ]);
  });
});

const sampleAction = {
  id: ACTION_ID,
  tool: 'mail.send',
  toolVersion: '1.0.0',
  agentId: 'mailer',
  conversationId: null,
  jobId: null,
  canonicalArgs: {},
  envelope: {},
  argsHash: 'h',
  preview: 'Send "Invoice" to a@b.c (bcc archive@example.com)',
  expiresAt: new Date('2026-09-14T12:00:00Z'),
  policyVersion: 1,
  createdAt: new Date('2026-09-13T12:00:00Z'),
  state: 'pending' as const,
  decidedBy: null,
  decidedVia: null,
  decidedAt: null,
  claimedBy: null,
  claimedAt: null,
  outcome: null,
  updatedAt: new Date('2026-09-13T12:00:00Z'),
};

describe('rendering', () => {
  it('shows the preview the tool rendered, and the action id', () => {
    const text = approvalRequestText(sampleAction, 'UTC');
    expect(text).toContain('mail.send');
    expect(text).toContain('bcc archive@example.com');
    expect(text).toContain(ACTION_ID);
  });

  it('says what happened once a decision lands', () => {
    expect(decidedText(sampleAction, 'rejected')).toContain('Rejected');
    expect(decidedText(sampleAction, 'succeeded')).toContain('Approved and done');
    expect(decidedText(sampleAction, 'unknown')).toContain('outcome unknown');
  });

  it('lists nothing as nothing', () => {
    expect(pendingText([], 'UTC')).toBe('Nothing is waiting for your approval.');
    expect(pendingText([sampleAction], 'UTC')).toContain('mail.send');
  });
});

/* ------------------------------------------------------------------ *
 * Against a real database
 * ------------------------------------------------------------------ */

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_tg_approvals_test_${process.pid}`;

const OWNER_USER = '4242';
const OWNER_CHAT = '4242';

suite('TelegramApprovals (postgres)', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await migrate(pool, { schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR });
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query('truncate core.actions cascade');
    await pool.query('truncate core.events cascade');
    await pool.query('truncate core.surface_identities cascade');
    await ensureOwner(pool, 'owner');
    await pairSurfaceIdentity(pool, {
      surface: 'telegram',
      externalUserId: OWNER_USER,
      externalChatId: OWNER_CHAT,
      pairedVia: 'env',
    });
  });

  /** The Bot API calls, recorded. */
  function fakeApi() {
    const sent: { chatId: string; text: string; markup?: unknown }[] = [];
    const edits: { messageId: number; text: string; markup?: unknown }[] = [];
    const answers: { id: string; text?: string }[] = [];
    return {
      sent,
      edits,
      answers,
      async sendMessage(chatId: string | number, text: string, opts: any = {}) {
        sent.push({ chatId: String(chatId), text, markup: opts.replyMarkup });
        return 900 + sent.length;
      },
      async editMessageText(_chat: string | number, messageId: number, text: string, opts: any = {}) {
        edits.push({ messageId, text, markup: opts.replyMarkup });
      },
      async answerCallbackQuery(id: string, text?: string) {
        answers.push({ id, ...(text ? { text } : {}) });
      },
    };
  }

  function registryWith(execute = vi.fn(async () => ({ messageId: 'mid-1' }))): ToolRegistry {
    const manifest: PluginManifest = {
      name: 'mail',
      version: '1.0.0',
      schema: 'mail',
      migrationsDir: '/tmp/mail',
      tools: [
        {
          name: 'mail.send',
          description: 'Send an email.',
          tier: 'gated',
          input: z.object({ to: z.string() }),
          execute: execute as never,
        },
      ],
    };
    const r = new ToolRegistry();
    r.register(manifest);
    return r;
  }

  const ctx = (): ToolContext => ({
    db: pool,
    ownerId: 'owner',
    now: () => new Date(),
    timezone: 'UTC',
  });

  function build(opts: { registry?: ToolRegistry; jobs?: any } = {}) {
    const api = fakeApi();
    const approvals = new TelegramApprovals({
      api,
      pool,
      registry: opts.registry ?? registryWith(),
      ctx: ctx(),
      timezone: 'UTC',
      ...(opts.jobs ? { jobs: opts.jobs } : {}),
      log: () => {},
    });
    return { api, approvals };
  }

  const pending = async (jobId?: string) =>
    createAction(pool, {
      tool: 'mail.send',
      toolVersion: '1.0.0',
      agentId: 'mailer',
      ...(jobId ? { jobId } : {}),
      canonicalArgs: { to: 'a@b.c' },
      envelope: { to: ['a@b.c'] },
      preview: 'Send to a@b.c',
    });

  const tap = (actionId: string, decision: 'approve' | 'reject', from = OWNER_USER): CallbackQuery => ({
    id: 'cb-1',
    from: { id: Number(from) },
    data: approvalCallbackData(actionId, decision),
    message: { message_id: 77, chat: { id: Number(OWNER_CHAT), type: 'private' } },
  });

  it('posts the request with buttons bound to the action', async () => {
    const { api, approvals } = build();
    const action = await pending();
    await approvals.request(OWNER_CHAT, action);
    expect(api.sent[0]?.text).toContain('Send to a@b.c');
    expect(api.sent[0]?.markup).toEqual(approvalKeyboard(action.id));
  });

  it('ignores a callback from anyone but the paired owner, and records it', async () => {
    const execute = vi.fn();
    const { api, approvals } = build({ registry: registryWith(execute) });
    const action = await pending();

    await approvals.handleCallback(tap(action.id, 'approve', '9999'));

    expect((await getAction(pool, action.id))?.state).toBe('pending');
    expect(execute).not.toHaveBeenCalled();
    // The spinner stops, and the stranger is told nothing at all.
    expect(api.answers).toEqual([{ id: 'cb-1' }]);
    expect(api.edits).toEqual([]);
    const { rows } = await pool.query(
      `select kind, payload from core.events where kind = 'surface.rejected'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ reason: 'unpaired', actionId: action.id });
  });

  it('ignores a callback from the owner id in a chat that is not theirs', async () => {
    const { api, approvals } = build();
    const action = await pending();
    await approvals.handleCallback({
      ...tap(action.id, 'approve'),
      message: { message_id: 77, chat: { id: 1234, type: 'private' } },
    });
    expect((await getAction(pool, action.id))?.state).toBe('pending');
    expect(api.edits).toEqual([]);
  });

  it('approves, executes through the Executor, and edits the message', async () => {
    const execute = vi.fn(async () => ({ messageId: 'mid-1' }));
    const { api, approvals } = build({ registry: registryWith(execute) });
    const action = await pending();

    await approvals.handleCallback(tap(action.id, 'approve'));

    expect(execute).toHaveBeenCalledTimes(1);
    expect((await getAction(pool, action.id))?.state).toBe('succeeded');
    expect(api.answers[0]?.text).toMatch(/Approved/);
    // The buttons are taken away, and the last edit says it is done.
    expect(api.edits.at(-1)?.text).toContain('Approved and done');
    expect(api.edits.at(-1)?.markup).toEqual({ inline_keyboard: [] });
  });

  it('rejects without executing anything', async () => {
    const execute = vi.fn();
    const { api, approvals } = build({ registry: registryWith(execute) });
    const action = await pending();

    await approvals.handleCallback(tap(action.id, 'reject'));

    expect(execute).not.toHaveBeenCalled();
    expect((await getAction(pool, action.id))?.state).toBe('rejected');
    expect(api.edits.at(-1)?.text).toContain('Rejected');
  });

  it('answers a second tap without doing the effect twice', async () => {
    const execute = vi.fn(async () => ({ messageId: 'mid-1' }));
    const { api, approvals } = build({ registry: registryWith(execute) });
    const action = await pending();

    await approvals.handleCallback(tap(action.id, 'approve'));
    await approvals.handleCallback(tap(action.id, 'approve'));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(api.answers.at(-1)?.text).toMatch(/already succeeded/);
  });

  it('wakes the suspended job through the queue interface', async () => {
    const resumeJob = vi.fn(async () => null);
    const jobId = '55555555-5555-5555-5555-555555555555';
    const { approvals } = build({ jobs: { resumeJob } });
    const action = await pending(jobId);

    await approvals.handleCallback(tap(action.id, 'approve'));

    expect(resumeJob).toHaveBeenCalledTimes(1);
    const [, calledJobId, opts] = resumeJob.mock.calls[0] as any[];
    expect(calledJobId).toBe(jobId);
    expect(opts.payloadPatch.approval).toMatchObject({
      actionId: action.id,
      state: 'succeeded',
    });
  });

  it('lists what is pending for /approvals', async () => {
    const { approvals } = build();
    expect(await approvals.pending()).toBe('Nothing is waiting for your approval.');
    const action = await pending();
    const text = await approvals.pending();
    expect(text).toContain('mail.send');
    expect(text).toContain(action.id);
  });
});
