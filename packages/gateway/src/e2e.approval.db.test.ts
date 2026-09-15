/**
 * The whole path, end to end, with nothing real but Postgres.
 *
 * Mail arrives -> a source enqueues a run -> a queue worker runs @postman ->
 * the agent drafts a reply and proposes a send -> the send is gated, so the job
 * suspends and the owner is asked in Telegram with buttons bound to that one
 * action -> the owner taps Approve -> the Executor sends through SMTP with the
 * action id as its idempotency key -> the job resumes -> the run reports -> the
 * report reaches the owner.
 *
 * Every boundary the architecture cares about is crossed here exactly once, and
 * every one of them is faked at the edge rather than stubbed in the middle: a
 * fake IMAP server, a fake SMTP sink, a scripted provider and a fake Bot API.
 * The database is real and thrown away; skipped unless DATABASE_URL is set.
 */
import {
  createPool,
  ensureOwner,
  enqueue,
  getJob,
  listJobs,
  pairSurfaceIdentity,
  resumeJob,
  runSources,
  runWorker,
  ToolRegistry,
  runMigrations,
  type Job,
  type ToolContext,
} from '@buddi/core';
import type { CompletionResponse, RuntimeProvider } from '@buddi/runtime';
import { manifest as artifactsManifest } from '@buddi/tool-artifacts';
import { createReminderManifest, createScheduleManifest } from './missions/reminders.js';
import {
  createEmailManifest,
  ensureGmailAccount,
  FakeImapServer,
  FakeSmtpServer,
  fakeMessage,
  GMAIL_SECRET_NAME,
  triageDedupKey,
} from '@buddi/tool-email';
import { manifest as financeManifest } from '@buddi/tool-finance';
import { manifest as memoryManifest } from '@buddi/tool-memory';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadGatewayCatalog } from './agents/catalog.js';
import { createDelegationManifest } from './agents/delegation.js';
import { createCanvasManifest } from './agents/canvas.js';
import { createOwnerManifest } from './agents/owner-tools.js';
import { createPlatformManifest } from './agents/platform.js';
import { AGENT_RUN_JOB_KIND, createAgentRunHandler } from './missions/agent-run.js';
import { approvalCallbackData, TelegramApprovals } from './telegram/approvals.js';
import { SURFACE } from './telegram/surface.js';
import { testDatabaseUrl } from '@buddi/core/testing';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_e2e_test_${process.pid}`;

/** The owner's Telegram identity, paired the way `.env` would pair it. */
const OWNER_USER_ID = '4242';
const OWNER_CHAT_ID = '4242';

const ENV = {
  GMAIL_USER: 'owner@example.test',
  [GMAIL_SECRET_NAME]: 'app-password',
  BUDDI_TZ: 'UTC',
  // A first contact plants the cursor at UIDNEXT-1 and reads no history, so
  // the one message this end-to-end seeds would otherwise be "before we
  // started". The backfill is how the real installation would be told to
  // pick up the newest few, and it is what makes the fixture arrive.
  EMAIL_BACKFILL: '20',
} as NodeJS.ProcessEnv;

const NOW = new Date('2026-09-13T09:15:00Z');

/* ------------------------------------------------------------------ *
 * A fake Bot API: three methods, every call recorded.
 * ------------------------------------------------------------------ */

interface SentMessage {
  chatId: string;
  text: string;
  replyMarkup?: unknown;
}

class FakeTelegram {
  readonly sent: SentMessage[] = [];
  readonly edits: Array<{ messageId: number; text: string }> = [];
  readonly answers: Array<{ id: string; text?: string }> = [];
  #messageId = 100;

  async sendMessage(
    chatId: string,
    text: string,
    opts?: { replyMarkup?: unknown },
  ): Promise<number> {
    this.sent.push({ chatId, text, ...(opts?.replyMarkup ? { replyMarkup: opts.replyMarkup } : {}) });
    this.#messageId += 1;
    return this.#messageId;
  }

  async editMessageText(
    _chatId: string,
    messageId: number,
    text: string,
  ): Promise<void> {
    this.edits.push({ messageId, text });
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    this.answers.push({ id, ...(text === undefined ? {} : { text }) });
  }
}

/* ------------------------------------------------------------------ *
 * The scripted provider: draft, propose the send, then report.
 * ------------------------------------------------------------------ */

function toolUse(name: string, input: unknown, id: string): CompletionResponse {
  return {
    content: [{ type: 'tool_use', id, name, input }],
    stopReason: 'tool_use',
    usage: { input: 10, output: 10 },
    model: 'claude-test',
  };
}

function endTurn(text: string): CompletionResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { input: 5, output: 5 },
    model: 'claude-test',
  };
}

/**
 * The model, written down.
 *
 * It reads nothing it was not handed: the draft id comes back to it in a
 * tool_result, and it recognizes the resumed run by the deferred tool result
 * the runtime opens it with — exactly what a real model would see.
 */
function scriptedProvider(messageRowId: string, calls: string[]): RuntimeProvider {
  let draftId: string | undefined;
  let reported = false;
  return {
    async complete(req): Promise<CompletionResponse> {
      let resumed = false;
      for (const message of req.messages) {
        for (const block of message.content as Array<Record<string, any>>) {
          if (block.type === 'text' && String(block.text).startsWith('tool result (deferred)')) {
            resumed = true;
          }
          if (block.type === 'tool_result' && typeof block.content === 'string') {
            try {
              const parsed = JSON.parse(block.content);
              if (parsed && typeof parsed.id === 'string' && parsed.sent === false) {
                draftId = parsed.id;
              }
            } catch {
              /* not JSON: the awaiting-approval note, for one */
            }
          }
        }
      }

      if (resumed) {
        if (!reported) {
          reported = true;
          calls.push('mission.report');
          return toolUse(
            'mission.report',
            {
              urgency: 'urgent',
              text: 'The bank says your direct debit was returned. I replied to them with your approval.',
            },
            'tu-report',
          );
        }
        return endTurn('Reported.');
      }

      if (!draftId) {
        calls.push('email.draft_reply');
        return toolUse(
          'email.draft_reply',
          { inReplyTo: messageRowId, bodyText: 'Thanks — I am looking into the returned debit today.' },
          'tu-draft',
        );
      }
      calls.push('email.send');
      return toolUse('email.send', { draftId }, 'tu-send');
    },
  };
}

/* ------------------------------------------------------------------ *
 * The suite
 * ------------------------------------------------------------------ */

suite('end to end: mail in, approved send out', () => {
  let admin: Pool;
  let pool: Pool;
  const imap = new FakeImapServer();
  const smtp = new FakeSmtpServer();
  const emailManifest = createEmailManifest({
    connect: imap.factory(),
    send: smtp.factory(),
    env: ENV,
  });

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    // Core plus every plugin the catalog needs a schema for.
    await runMigrations(pool, [emailManifest, memoryManifest, financeManifest, artifactsManifest]);
    await ensureOwner(pool, 'owner');
    await pairSurfaceIdentity(pool, {
      surface: SURFACE,
      externalUserId: OWNER_USER_ID,
      externalChatId: OWNER_CHAT_ID,
      pairedVia: 'env',
    });
    await ensureGmailAccount(pool, ENV);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  it('mail arrives, @postman proposes a send, the owner approves, the run finishes', async () => {
    /* ---- 1. the world changes: a message lands in the mailbox ---- */
    imap.add(
      'INBOX',
      fakeMessage({
        messageId: '<debit-returned@bank.test>',
        from: 'noreply@bank.test',
        to: [ENV.GMAIL_USER as string],
        subject: 'Your direct debit was returned',
        bodyText: 'We were unable to collect GBP 84.20 on 12 September.',
      }),
    );

    /* ---- 2. the source poll enqueues an agent-run ---- */
    const registry = new ToolRegistry();
    registry.register(financeManifest);
    registry.register(emailManifest);
    registry.register(memoryManifest);
    registry.register(artifactsManifest);
    registry.register(createReminderManifest());
    registry.register(createScheduleManifest());
    registry.register(createCanvasManifest());
    registry.register(createOwnerManifest(registry));
    registry.register(createPlatformManifest(registry));
    registry.register(createDelegationManifest(registry));
    const catalog = loadGatewayCatalog({ env: ENV, registry });
    // The agent a source names is the one the owner types as @postman.
    expect(catalog.resolve('mail-triage').handle).toBe('postman');

    const outcomes = await runSources(pool, registry.manifests(), {
      now: NOW,
      timezone: 'UTC',
      log: () => {},
      enqueueRun: async (input) => {
        await enqueue(pool, {
          kind: AGENT_RUN_JOB_KIND,
          payload: { agentId: input.agentId, prompt: input.prompt },
          dedupKey: input.dedupKey,
        });
      },
    });
    expect(outcomes.find((o) => o.sourceId === 'email.inbox-poll')).toMatchObject({ ran: true });

    const { rows: messageRows } = await pool.query<{ id: string }>(
      `select id::text from email.messages`,
    );
    expect(messageRows).toHaveLength(1);
    const messageRowId = messageRows[0]!.id;

    const queued = await listJobs(pool, { kind: AGENT_RUN_JOB_KIND });
    expect(queued).toHaveLength(1);
    const job = queued[0] as Job;
    expect(job.dedupKey).toBe(triageDedupKey(messageRowId));
    expect(job.state).toBe('pending');

    // A second poll of the same mailbox must not queue the run twice.
    await runSources(pool, registry.manifests(), {
      now: new Date(NOW.getTime() + 10 * 60_000),
      timezone: 'UTC',
      log: () => {},
      enqueueRun: async (input) => {
        await enqueue(pool, {
          kind: AGENT_RUN_JOB_KIND,
          payload: { agentId: input.agentId, prompt: input.prompt },
          dedupKey: input.dedupKey,
        });
      },
    });
    expect(await listJobs(pool, { kind: AGENT_RUN_JOB_KIND })).toHaveLength(1);

    /* ---- 3. the worker runs @postman ---- */
    const telegram = new FakeTelegram();
    const ctx: ToolContext = { db: pool, ownerId: 'owner', now: () => NOW, timezone: 'UTC' };
    const approvals = new TelegramApprovals({
      api: telegram,
      pool,
      registry,
      ctx,
      timezone: 'UTC',
      jobs: { resumeJob },
      log: () => {},
      now: () => NOW,
    });

    const delivered: string[] = [];
    const calls: string[] = [];
    const handler = createAgentRunHandler({
      pool,
      registry,
      catalog,
      provider: scriptedProvider(messageRowId, calls),
      ctx,
      now: () => NOW,
      deliver: async (text) => {
        await telegram.sendMessage(OWNER_CHAT_ID, text);
        delivered.push(text);
        return OWNER_CHAT_ID;
      },
      askApproval: async (action) => {
        await approvals.request(OWNER_CHAT_ID, action);
      },
      log: () => {},
    });

    const worker = runWorker({
      pool,
      worker: 'e2e',
      kinds: [AGENT_RUN_JOB_KIND],
      handlers: { [AGENT_RUN_JOB_KIND]: handler },
      now: () => new Date(),
      pollMs: 5,
      leaseMs: 30_000,
      onError: (err) => console.error(err),
    });

    try {
      /* ---- 4. the send is gated: the job suspends, the owner is asked ---- */
      await waitFor(async () => (await getJob(pool, job.id))?.state === 'suspended');
      expect(calls).toEqual(['email.draft_reply', 'email.send']);

      const suspended = await getJob(pool, job.id);
      const { rows: actionRows } = await pool.query(
        `select id::text as id, tool, job_id::text as job_id, preview from core.actions`,
      );
      expect(actionRows).toHaveLength(1);
      const actionId = actionRows[0].id as string;
      expect(actionRows[0].tool).toBe('email.send');
      // The action knows which run is waiting on it. That link is the only way
      // a tap in a chat finds a job parked in a table.
      expect(actionRows[0].job_id).toBe(job.id);
      expect(suspended?.suspendedReason).toBe(`awaiting-approval:${actionId}`);
      expect((suspended?.payload as any).awaiting).toMatchObject({ actionId });

      // The request reached the owner, with buttons bound to that one action.
      const request = telegram.sent.find((m) => m.text.startsWith('Approval needed'));
      expect(request).toBeDefined();
      expect(request?.chatId).toBe(OWNER_CHAT_ID);
      // The preview is the tool's own, rendered from the envelope: every
      // recipient, the subject and the body hash.
      expect(request?.text).toContain('noreply@bank.test');
      expect(request?.text).toContain('body sha256:');
      expect(JSON.stringify(request?.replyMarkup)).toContain(
        approvalCallbackData(actionId, 'approve'),
      );
      // Nothing has been sent, and nothing has been delivered to the owner.
      expect(smtp.sent).toHaveLength(0);
      expect(delivered).toHaveLength(0);

      /* ---- 5. the owner taps Approve ---- */
      await approvals.handleCallback(approveTap(actionId, 1));

      // The effect went out through SMTP, exactly once, with what was approved.
      expect(smtp.sent).toHaveLength(1);
      expect(smtp.sent[0]?.to).toEqual(['noreply@bank.test']);
      expect(smtp.sent[0]?.text).toContain('returned debit');

      // The ledger: one attempt, succeeded, carrying the envelope hash.
      const { rows: attempts } = await pool.query(
        `select attempt, state, envelope_hash, error from core.effect_attempts where action_id = $1`,
        [actionId],
      );
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({ attempt: 1, state: 'succeeded', error: null });
      expect(String(attempts[0].envelope_hash)).toMatch(/^[0-9a-f]{64}$/);

      // `ctx.actionId` reached the tool: the draft is claimed by this action.
      const { rows: drafts } = await pool.query(
        `select sent_action_id::text as sent_action_id, sent_message_id, sent_at, send_error
           from email.drafts`,
      );
      expect(drafts).toHaveLength(1);
      expect(drafts[0].sent_action_id).toBe(actionId);
      expect(drafts[0].sent_message_id).toBeTruthy();
      expect(drafts[0].send_error).toBeNull();

      /* ---- 6. the job resumed and the run finished by reporting ---- */
      await waitFor(async () => (await getJob(pool, job.id))?.state === 'succeeded');
      expect(calls).toEqual(['email.draft_reply', 'email.send', 'mission.report']);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toContain('direct debit was returned');

      const finished = await getJob(pool, job.id);
      expect(finished?.result).toMatchObject({ decision: 'report', delivered: true });
      // The resumed run continued in the conversation it suspended in.
      expect((finished?.payload as any).awaiting.conversationId).toBe(
        (finished?.result as any).conversationId,
      );

      /* ---- 7. a second tap changes nothing ---- */
      const before = smtp.sent.length;
      await approvals.handleCallback(approveTap(actionId, 2));
      expect(smtp.sent).toHaveLength(before);
      const answer = telegram.answers[telegram.answers.length - 1];
      expect(answer?.text).toMatch(/already/i);
      const { rows: after } = await pool.query(
        `select count(*)::int as n from core.effect_attempts where action_id = $1`,
        [actionId],
      );
      expect(after[0].n).toBe(1);
    } finally {
      await worker.stop();
    }
  }, 60_000);
});

/** One inline-keyboard tap from the paired owner. */
function approveTap(actionId: string, n: number): any {
  return {
    id: `cb-${n}`,
    from: { id: Number(OWNER_USER_ID) },
    message: { message_id: 101, chat: { id: Number(OWNER_CHAT_ID) } },
    data: approvalCallbackData(actionId, 'approve'),
  };
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
