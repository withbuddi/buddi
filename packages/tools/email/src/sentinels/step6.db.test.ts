/**
 * The four step-6 mail watchers on fixtures (docs/specs/email.md §7, §13.6).
 *
 * Skipped unless DATABASE_URL is set. It never touches the developer's data:
 * the suite creates its own database, migrates core plus this plugin into it,
 * and drops it at the end. No socket is opened to any mailbox and no model is
 * called — a sentinel is SQL and TypeScript, which is the whole point of it.
 *
 * It is a separate file from `sentinels.db.test.ts` rather than an addition to
 * it, because the two steps' fixtures are different shapes: step 4's suite is
 * about inbound mail that has gone unanswered, and three of the four watchers
 * here are about the owner's *own* mail and about bodies that have been read
 * and stamped.
 *
 * Every silence rule §7 names has a test of its own below, because a silence
 * rule that is only in a query is a rule nobody will notice breaking.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPool,
  findingsOf,
  runMigrations,
  runSentinels,
  setSentinelEnabled,
  stillTrueKeys,
  type Finding,
  type Sentinel,
  type SentinelContext,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { ensureGmailAccount, GMAIL_SECRET_NAME } from '../config.js';
import { manifest } from '../index.js';
import { quoted } from '../mail.js';
import { joinThread, setThreadState } from '../threads.js';
import { setWatcherSettings } from '../watchers.js';
import {
  promisedReply,
  receiptOrBill,
  suspiciousSender,
  unansweredByThem,
} from './index.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_email_step6_test_${process.pid}`;
const ENV = { GMAIL_USER: 'owner@example.test', [GMAIL_SECRET_NAME]: 'app-password' };
/** A Monday, noon UTC. Every age below is measured from it. */
const NOW = new Date('2026-09-21T12:00:00Z');

function daysBefore(n: number): Date {
  return new Date(NOW.getTime() - n * 86_400_000);
}

suite('email watchers, step 6 (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let accountId: string;
  let folderId: string;
  let sentFolderId: string;
  let uid = 1;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [manifest]);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
  });

  beforeEach(async () => {
    await pool.query(
      'truncate email.dates, email.receipts, email.suspicions, email.events, email.policies, ' +
        'email.threads, email.drafts, email.triage, email.messages, email.folders, ' +
        'email.accounts, email.settings cascade',
    );
    await pool.query(
      'truncate core.sentinel_findings, core.sentinel_runs, core.digest_items, core.reminders cascade',
    );
    uid = 1;
    const account = await ensureGmailAccount(pool, ENV);
    accountId = account!.id;
    const inbox = await pool.query(
      `insert into email.folders (account_id, name, kind, synced)
       values ($1, 'INBOX', 'inbox', true) returning id`,
      [accountId],
    );
    folderId = String(inbox.rows[0].id);
    const sent = await pool.query(
      `insert into email.folders (account_id, name, kind, synced)
       values ($1, '[Gmail]/Sent Mail', 'sent', true) returning id`,
      [accountId],
    );
    sentFolderId = String(sent.rows[0].id);
  });

  /** One message, threaded the way ingest threads it. */
  async function write(over: {
    from: string;
    to: string;
    subject: string;
    threadKey: string;
    at: Date;
    body?: string;
    cc?: string[];
    listId?: string | null;
    direction?: 'in' | 'out';
    /** Default true: only the two sweeping watchers want an unread body. */
    scanned?: boolean;
  }): Promise<{ messageId: string; threadId: string }> {
    const direction = over.direction ?? 'in';
    const scanned = over.scanned ?? true;
    const messageUid = uid++;
    const { rows } = await pool.query(
      `insert into email.messages
         (account_id, folder_id, uidvalidity, uid, message_id, thread_key, from_addr, to_addrs, cc,
          subject, date, internal_date, snippet, body_text, direction, list_id,
          triage_enqueued_at, dates_scanned_at, receipts_scanned_at, suspicion_scanned_at)
       values ($1, $2, 1, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $10, '', $11, $12, $13,
               now(), $14, $14, $14)
       returning id`,
      [
        accountId,
        direction === 'out' ? sentFolderId : folderId,
        messageUid,
        `<m${messageUid}@example.test>`,
        over.threadKey,
        over.from,
        JSON.stringify([over.to]),
        JSON.stringify(over.cc ?? []),
        over.subject,
        over.at,
        over.body ?? '',
        direction,
        over.listId ?? null,
        scanned ? NOW : null,
      ],
    );
    const messageId = String(rows[0].id);
    const thread = await joinThread(pool, {
      accountId,
      threadKey: over.threadKey,
      messageRowId: messageId,
      subject: over.subject,
      participants: [over.from, over.to, ...(over.cc ?? [])],
      at: over.at,
      folderId: direction === 'out' ? sentFolderId : folderId,
      uidValidity: 1,
      uid: messageUid,
      direction,
    });
    return { messageId, threadId: thread.id };
  }

  async function raise(sentinel: Sentinel, context: SentinelContext): Promise<Finding[]> {
    return findingsOf(await sentinel.run(context));
  }

  function ctx(over: Partial<SentinelContext> = {}): SentinelContext {
    return {
      db: pool,
      now: () => NOW,
      timezone: 'UTC',
      agentForRole: () => undefined,
      ...over,
    } as SentinelContext;
  }

  async function ignorePolicy(matcher: string, scope: 'sender' | 'domain' = 'sender'): Promise<void> {
    await pool.query(
      `insert into email.policies (account_id, scope, matcher, action, params, origin, proposed)
       values ($1, $2, $3, 'ignore', '{}'::jsonb, 'owner', false)`,
      [accountId, scope, matcher],
    );
  }

  /* ---------------------------------------------- all six are registered */

  it('ships all six of §7, each with an id core can switch', async () => {
    const ids = (manifest.sentinels ?? []).map((s) => s.id);
    expect(ids).toEqual([
      'email.waiting-on-me',
      'email.date-stated',
      'email.promised-reply',
      'email.receipt-or-bill',
      'email.suspicious-sender',
      'email.unanswered-by-them',
    ]);
  });

  /* -------------------------------------------------- email.promised-reply */

  describe('email.promised-reply', () => {
    /** The owner promising, with nothing sent since. */
    async function promised(
      over: { ageDays?: number; body?: string; to?: string; subject?: string } = {},
    ): Promise<{ messageId: string; threadId: string }> {
      return write({
        from: 'owner@example.test',
        to: over.to ?? 'client@work.test',
        subject: over.subject ?? 'The quote',
        threadKey: `<promise-${uid}@work.test>`,
        at: daysBefore(over.ageDays ?? 4),
        body: over.body ?? "Thanks for the call. I'll get back to you with the figures.",
        direction: 'out',
      });
    }

    it('reports a promise nothing has followed', async () => {
      const { threadId, messageId } = await promised();
      const findings = await raise(promisedReply, ctx());
      expect(findings).toHaveLength(1);
      expect(findings[0]!.key).toBe(`email.promised-reply:${threadId}:${messageId}`);
      expect(findings[0]!.severity).toBe('info');
      expect(findings[0]!.title).toContain(quoted('client@work.test'));
      expect(findings[0]!.detail).toContain(quoted("I'll get back to you"));
    });

    it('is urgent at a week', async () => {
      await promised({ ageDays: 9 });
      expect((await raise(promisedReply, ctx()))[0]!.severity).toBe('urgent');
    });

    it('says nothing inside the window, and nothing once the owner widens it', async () => {
      await promised({ ageDays: 1 });
      expect(await raise(promisedReply, ctx())).toEqual([]);
      await promised({ ageDays: 4, subject: 'The survey' });
      expect(await raise(promisedReply, ctx())).toHaveLength(1);
      await setWatcherSettings(pool, { promisedDays: 10 }, NOW);
      expect(await raise(promisedReply, ctx())).toEqual([]);
    });

    it('says nothing about a message that promised nothing', async () => {
      await promised({ body: 'Here are the figures. Let me check the rest.' });
      expect(await raise(promisedReply, ctx())).toEqual([]);
    });

    it('says nothing once anything of the owner’s has followed on the thread', async () => {
      const { threadId } = await promised();
      expect(await raise(promisedReply, ctx())).toHaveLength(1);
      await pool.query(
        `insert into email.messages
           (account_id, folder_id, uidvalidity, uid, message_id, thread_id, thread_key, from_addr,
            to_addrs, subject, internal_date, body_text, direction)
         values ($1, $2, 1, 9001, '<later@example.test>', $3, $4, 'owner@example.test',
                 $5::jsonb, 'Re: The quote', $6, 'Here they are.', 'out')`,
        [
          accountId,
          sentFolderId,
          threadId,
          `<promise-1@work.test>`,
          JSON.stringify(['client@work.test']),
          daysBefore(1),
        ],
      );
      expect(await raise(promisedReply, ctx())).toEqual([]);
    });

    it('says nothing about a promise a month old', async () => {
      await promised({ ageDays: 45 });
      expect(await raise(promisedReply, ctx())).toEqual([]);
    });

    it('respects a muted conversation', async () => {
      const { threadId } = await promised();
      await setThreadState(pool, threadId, 'muted');
      expect(await raise(promisedReply, ctx())).toEqual([]);
    });

    it('respects an ignore policy on the recipient, and on their domain', async () => {
      await promised();
      await ignorePolicy('client@work.test');
      expect(await raise(promisedReply, ctx())).toEqual([]);
      await pool.query('delete from email.policies');
      expect(await raise(promisedReply, ctx())).toHaveLength(1);
      await ignorePolicy('work.test', 'domain');
      expect(await raise(promisedReply, ctx())).toEqual([]);
    });

    it('reports a live draft that has sat unsent, and not a finished one', async () => {
      const { threadId } = await write({
        from: 'client@work.test',
        to: 'owner@example.test',
        subject: 'The quote',
        threadKey: '<draft-thread@work.test>',
        at: daysBefore(10),
        body: 'Could you send the quote?',
      });
      const draft = await pool.query(
        `insert into email.drafts
           (account_id, thread_id, to_addrs, subject, body_text, status, created_by_agent, updated_at)
         values ($1, $2, $3::jsonb, 'Re: The quote', 'Here it is.', 'draft', 'mailer', $4)
         returning id`,
        [accountId, threadId, JSON.stringify(['client@work.test']), daysBefore(8)],
      );
      const draftId = String(draft.rows[0].id);

      const findings = await raise(promisedReply, ctx());
      expect(findings.map((f) => f.key)).toEqual([
        `email.promised-reply:${threadId}:draft:${draftId}`,
      ]);
      expect(findings[0]!.severity).toBe('urgent');
      expect(findings[0]!.detail).toContain('email.read_draft');

      // Every end of the lifecycle is an end: nothing is owed any more.
      for (const status of ['sent', 'discarded', 'lapsed']) {
        await pool.query(`update email.drafts set status = $1 where id = $2::uuid`, [
          status,
          draftId,
        ]);
        expect(await raise(promisedReply, ctx())).toEqual([]);
      }
      // And a draft already claimed by a dispatch is on the wire, not forgotten.
      await pool.query(
        `update email.drafts set status = 'draft', sent_action_id = gen_random_uuid() where id = $1::uuid`,
        [draftId],
      );
      expect(await raise(promisedReply, ctx())).toEqual([]);
    });

    it('addresses the finding by role', async () => {
      await promised();
      const findings = await raise(
        promisedReply,
        ctx({ agentForRole: (role) => (role === 'mail' ? 'mailer' : undefined) }),
      );
      expect(findings[0]!.agentId).toBe('mailer');
    });
  });

  /* ------------------------------------------------- email.receipt-or-bill */

  describe('email.receipt-or-bill', () => {
    async function arriving(
      over: { subject?: string; from?: string; body?: string; ageDays?: number } = {},
    ): Promise<{ messageId: string; threadId: string }> {
      return write({
        from: over.from ?? 'billing@insurer.test',
        to: 'owner@example.test',
        subject: over.subject ?? 'Invoice 2026-114',
        threadKey: `<receipt-${uid}@insurer.test>`,
        at: daysBefore(over.ageDays ?? 2),
        body: over.body ?? 'Thank you.\nTotal: €120,50\nPayable on receipt.',
        scanned: false,
      });
    }

    it('reads an unscanned message, stores the reading, and raises one finding', async () => {
      const { messageId, threadId } = await arriving();
      const findings = await raise(receiptOrBill, ctx());
      expect(findings).toHaveLength(1);
      expect(findings[0]!.key).toBe(`email.receipt-or-bill:${messageId}`);
      expect(findings[0]!.severity).toBe('info');
      expect(findings[0]!.title).toContain('€120.50');
      expect(findings[0]!.data).toMatchObject({
        threadId,
        amount: 120.5,
        currency: 'EUR',
        suggestedActions: ['hand-to-overview', 'record'],
      });

      const { rows } = await pool.query(
        `select r.confidence, r.amount, r.currency, m.receipts_scanned_at is not null as scanned
           from email.receipts r join email.messages m on m.id = r.message_id`,
      );
      expect(rows).toEqual([
        { confidence: '0.95', amount: '120.50', currency: 'EUR', scanned: true },
      ]);
    });

    it('reads the message once, and repeats itself without new rows', async () => {
      await arriving();
      const first = await raise(receiptOrBill, ctx());
      const second = await raise(receiptOrBill, ctx());
      expect(second.map((f) => f.key)).toEqual(first.map((f) => f.key));
      const { rows } = await pool.query(`select count(*)::int as n from email.receipts`);
      expect(rows[0].n).toBe(1);
    });

    it("keeps a reading below the owner's threshold without saying anything", async () => {
      await arriving({ subject: 'Your order has shipped', body: 'On its way.' });
      expect(await raise(receiptOrBill, ctx())).toEqual([]);
      const { rows } = await pool.query(`select confidence from email.receipts`);
      expect(rows[0].confidence).toBe('0.60');
      await setWatcherSettings(pool, { receiptConfidence: 0.5 }, NOW);
      expect(await raise(receiptOrBill, ctx())).toHaveLength(1);
    });

    it('says nothing about a receipt older than the fortnight', async () => {
      await arriving({ ageDays: 20 });
      expect(await raise(receiptOrBill, ctx())).toEqual([]);
      // It was still read and kept: the window is the alerting one, not the
      // reading one, exactly as it is for dates.
      const { rows } = await pool.query(`select count(*)::int as n from email.receipts`);
      expect(rows[0].n).toBe(1);
    });

    it('stamps a silenced sender without reading them', async () => {
      await ignorePolicy('billing@insurer.test');
      await arriving();
      expect(await raise(receiptOrBill, ctx())).toEqual([]);
      const { rows } = await pool.query(
        `select (select count(*)::int from email.receipts) as receipts,
                (select count(*)::int from email.messages where receipts_scanned_at is null) as unscanned`,
      );
      expect(rows[0]).toEqual({ receipts: 0, unscanned: 0 });
    });

    it('silences a stored reading when a policy arrives after the scan', async () => {
      await arriving();
      expect(await raise(receiptOrBill, ctx())).toHaveLength(1);
      await ignorePolicy('insurer.test', 'domain');
      expect(await raise(receiptOrBill, ctx())).toEqual([]);
    });

    it('says nothing about a muted conversation', async () => {
      const { threadId } = await arriving();
      await setThreadState(pool, threadId, 'muted');
      expect(await raise(receiptOrBill, ctx())).toEqual([]);
    });

    it("never reads the owner's own mail for receipts", async () => {
      await write({
        from: 'owner@example.test',
        to: 'shop@work.test',
        subject: 'Invoice 2026-114',
        threadKey: '<mine@example.test>',
        at: daysBefore(1),
        body: 'Total: €120,50',
        direction: 'out',
        scanned: false,
      });
      expect(await raise(receiptOrBill, ctx())).toEqual([]);
      const { rows } = await pool.query(`select count(*)::int as n from email.receipts`);
      expect(rows[0].n).toBe(0);
    });

    it('hands it to whoever holds overview, and to mail when nobody does', async () => {
      await arriving();
      const overview = await raise(
        receiptOrBill,
        ctx({ agentForRole: (role) => (role === 'overview' ? 'keeper' : 'mailer') }),
      );
      expect(overview[0]!.agentId).toBe('keeper');
      const fallback = await raise(
        receiptOrBill,
        ctx({ agentForRole: (role) => (role === 'mail' ? 'mailer' : undefined) }),
      );
      expect(fallback[0]!.agentId).toBe('mailer');
    });
  });

  /* ---------------------------------------------- email.suspicious-sender */

  describe('email.suspicious-sender', () => {
    /** The owner has written to Ana Ríos at the company she actually works for. */
    async function knowsAna(): Promise<void> {
      await write({
        from: 'owner@example.test',
        to: '"Ana Ríos" <ana.rios@supplier.test>',
        subject: 'The order',
        threadKey: '<known-ana@supplier.test>',
        at: daysBefore(20),
        body: 'Thanks.',
        direction: 'out',
      });
    }

    async function fromImpostor(
      over: { from?: string; body?: string; ageDays?: number } = {},
    ): Promise<{ messageId: string; threadId: string }> {
      return write({
        from: over.from ?? '"Ana Rios" <a.rios@supplier-invoices.test>',
        to: 'owner@example.test',
        subject: 'Urgent request',
        threadKey: `<impostor-${uid}@supplier-invoices.test>`,
        at: daysBefore(over.ageDays ?? 1),
        body: over.body ?? 'Are you at your desk?\nI need this done today.',
        scanned: false,
      });
    }

    it('wakes somebody about a name worn by another address', async () => {
      await knowsAna();
      const { messageId } = await fromImpostor();
      const findings = await raise(suspiciousSender, ctx());
      expect(findings).toHaveLength(1);
      expect(findings[0]!.key).toBe(`email.suspicious-sender:${messageId}`);
      expect(findings[0]!.severity).toBe('urgent');
      expect(findings[0]!.data).toMatchObject({ tests: ['look-alike'] });
      expect(findings[0]!.detail).toContain('Do not reply to it');
    });

    it('says nothing about the same person at a domain the owner writes to', async () => {
      await knowsAna();
      await fromImpostor({ from: '"Ana Ríos" <ana@supplier.test>' });
      expect(await raise(suspiciousSender, ctx())).toEqual([]);
    });

    it('says nothing about the very address the owner writes to', async () => {
      await knowsAna();
      await fromImpostor({ from: '"Ana Ríos" <ana.rios@supplier.test>' });
      expect(await raise(suspiciousSender, ctx())).toEqual([]);
    });

    it('notes an ask, and wakes somebody once it is urgent as well', async () => {
      const { messageId } = await fromImpostor({
        from: '"Payments" <billing@unknown.test>',
        body: 'We have a new IBAN, please use it for the wire transfer.',
      });
      const noted = await raise(suspiciousSender, ctx());
      expect(noted).toHaveLength(1);
      expect(noted[0]!.severity).toBe('info');
      expect(noted[0]!.data).toMatchObject({ tests: ['ask'], confidence: 0.7 });

      await pool.query(
        `update email.suspicions set confidence = 0.95, urgent = true where message_id = $1::uuid`,
        [messageId],
      );
      expect((await raise(suspiciousSender, ctx()))[0]!.severity).toBe('urgent');
    });

    it('names a message that fails both tests once, and says so', async () => {
      await knowsAna();
      await fromImpostor({ body: 'Please make an urgent wire transfer today.' });
      const findings = await raise(suspiciousSender, ctx());
      expect(findings).toHaveLength(1);
      expect(findings[0]!.data).toMatchObject({ tests: ['look-alike', 'ask'] });
      expect(findings[0]!.severity).toBe('urgent');
    });

    it('is NOT silenced by an ignore policy on the impostor, which is the point', async () => {
      await knowsAna();
      await fromImpostor();
      await ignorePolicy('supplier-invoices.test', 'domain');
      await ignorePolicy('a.rios@supplier-invoices.test');
      expect(await raise(suspiciousSender, ctx())).toHaveLength(1);
      // And the body of a silenced sender is still read, unlike every other
      // watcher's: the sweep does not skip it.
      const { rows } = await pool.query(
        `select count(*)::int as n from email.messages where suspicion_scanned_at is null`,
      );
      expect(rows[0].n).toBe(0);
    });

    it('is silenced by a muted conversation, and only by that', async () => {
      await knowsAna();
      const { threadId } = await fromImpostor();
      expect(await raise(suspiciousSender, ctx())).toHaveLength(1);
      await setThreadState(pool, threadId, 'muted');
      expect(await raise(suspiciousSender, ctx())).toEqual([]);
    });

    it('says nothing about a week-old fraud nobody fell for', async () => {
      await knowsAna();
      await fromImpostor({ ageDays: 10 });
      expect(await raise(suspiciousSender, ctx())).toEqual([]);
    });

    it('addresses the finding by role', async () => {
      await knowsAna();
      await fromImpostor();
      const findings = await raise(
        suspiciousSender,
        ctx({ agentForRole: (role) => (role === 'mail' ? 'mailer' : undefined) }),
      );
      expect(findings[0]!.agentId).toBe('mailer');
    });
  });

  /* -------------------------------------------- email.unanswered-by-them */

  describe('email.unanswered-by-them', () => {
    async function asked(
      over: {
        ageDays?: number;
        body?: string;
        to?: string;
        subject?: string;
        listId?: string | null;
      } = {},
    ): Promise<{ messageId: string; threadId: string }> {
      return write({
        from: 'owner@example.test',
        to: over.to ?? 'surveyor@work.test',
        subject: over.subject ?? 'The survey',
        threadKey: `<asked-${uid}@work.test>`,
        at: daysBefore(over.ageDays ?? 7),
        body: over.body ?? 'Hello. Could you send the report this week?',
        direction: 'out',
        ...(over.listId === undefined ? {} : { listId: over.listId }),
      });
    }

    async function theyReply(threadKey: string, threadId: string, at: Date): Promise<void> {
      await pool.query(
        `insert into email.messages
           (account_id, folder_id, uidvalidity, uid, message_id, thread_id, thread_key, from_addr,
            to_addrs, subject, internal_date, body_text, direction)
         values ($1, $2, 1, $3, $4, $5, $6, 'surveyor@work.test', $7::jsonb, 'Re: The survey',
                 $8, 'Here it is.', 'in')`,
        [
          accountId,
          folderId,
          uid++,
          `<reply-${uid}@work.test>`,
          threadId,
          threadKey,
          JSON.stringify(['owner@example.test']),
          at,
        ],
      );
    }

    it('reports a question nobody answered, once, as a notice', async () => {
      const { threadId, messageId } = await asked();
      const findings = await raise(unansweredByThem, ctx());
      expect(findings).toHaveLength(1);
      expect(findings[0]!.key).toBe(`email.unanswered-by-them:${threadId}:${messageId}`);
      expect(findings[0]!.severity).toBe('info');
      expect(findings[0]!.detail).toContain(quoted('Could you send the report this week?'));
      expect(findings[0]!.detail).toContain('Never send it.');
    });

    it('says nothing inside the window, and nothing once the owner widens it', async () => {
      await asked({ ageDays: 2 });
      expect(await raise(unansweredByThem, ctx())).toEqual([]);
      await asked({ ageDays: 7, subject: 'The lease' });
      expect(await raise(unansweredByThem, ctx())).toHaveLength(1);
      await setWatcherSettings(pool, { nudgeDays: 14 }, NOW);
      expect(await raise(unansweredByThem, ctx())).toEqual([]);
    });

    it('says nothing about a message that asked nothing', async () => {
      await asked({ body: 'Here are the figures for September. Thanks in advance.' });
      expect(await raise(unansweredByThem, ctx())).toEqual([]);
    });

    it('says nothing once they have answered', async () => {
      const { threadId } = await asked();
      expect(await raise(unansweredByThem, ctx())).toHaveLength(1);
      await theyReply(`<asked-1@work.test>`, threadId, daysBefore(3));
      expect(await raise(unansweredByThem, ctx())).toEqual([]);
    });

    it('says nothing once the owner has already been back in touch', async () => {
      const { threadId } = await asked();
      await pool.query(
        `insert into email.messages
           (account_id, folder_id, uidvalidity, uid, message_id, thread_id, thread_key, from_addr,
            to_addrs, subject, internal_date, body_text, direction)
         values ($1, $2, 1, 9100, '<nudged@example.test>', $3, '<asked-1@work.test>',
                 'owner@example.test', $4::jsonb, 'Re: The survey', $5, 'Any news?', 'out')`,
        [accountId, sentFolderId, threadId, JSON.stringify(['surveyor@work.test']), daysBefore(2)],
      );
      expect(await raise(unansweredByThem, ctx())).toEqual([]);
    });

    it('says nothing when the owner was the one replying', async () => {
      // Their message came first: this conversation is theirs, and his silence
      // afterwards is what `email.waiting-on-me` is about, from the other side.
      const inbound = await write({
        from: 'surveyor@work.test',
        to: 'owner@example.test',
        subject: 'The survey',
        threadKey: '<theirs@work.test>',
        at: daysBefore(12),
        body: 'Here is the draft.',
      });
      await pool.query(
        `insert into email.messages
           (account_id, folder_id, uidvalidity, uid, message_id, thread_id, thread_key, from_addr,
            to_addrs, subject, internal_date, body_text, direction)
         values ($1, $2, 1, 9200, '<myreply@example.test>', $3, '<theirs@work.test>',
                 'owner@example.test', $4::jsonb, 'Re: The survey', $5,
                 'Could you send the final one?', 'out')`,
        [
          accountId,
          sentFolderId,
          inbound.threadId,
          JSON.stringify(['surveyor@work.test']),
          daysBefore(7),
        ],
      );
      expect(await raise(unansweredByThem, ctx())).toEqual([]);
    });

    it('says nothing to a machine, or on a mailing list', async () => {
      await asked({ to: 'no-reply@work.test' });
      expect(await raise(unansweredByThem, ctx())).toEqual([]);
      await asked({ subject: 'The list', listId: '<announce.work.test>' });
      expect(await raise(unansweredByThem, ctx())).toEqual([]);
    });

    it('respects a muted conversation', async () => {
      const { threadId } = await asked();
      await setThreadState(pool, threadId, 'muted');
      expect(await raise(unansweredByThem, ctx())).toEqual([]);
    });

    it('respects an ignore policy on the recipient, and on their domain', async () => {
      await asked();
      await ignorePolicy('surveyor@work.test');
      expect(await raise(unansweredByThem, ctx())).toEqual([]);
      await pool.query('delete from email.policies');
      expect(await raise(unansweredByThem, ctx())).toHaveLength(1);
      await ignorePolicy('work.test', 'domain');
      expect(await raise(unansweredByThem, ctx())).toEqual([]);
    });

    it('says nothing about a question a month old', async () => {
      await asked({ ageDays: 45 });
      expect(await raise(unansweredByThem, ctx())).toEqual([]);
    });
  });

  /* ------------------------------------------------- through core, switched */

  describe('through core', () => {
    it('goes to the digest once, and resolves nothing it did not raise', async () => {
      await write({
        from: 'owner@example.test',
        to: 'client@work.test',
        subject: 'The quote',
        threadKey: '<core-promise@work.test>',
        at: daysBefore(4),
        body: "I'll send the figures tomorrow.",
        direction: 'out',
      });
      const manifests = [{ ...manifest, sentinels: [promisedReply] }];
      const first = await runSentinels(pool, manifests, NOW, 'UTC');
      expect(first[0]).toMatchObject({ sentinelId: 'email.promised-reply', findings: 1, fired: 1 });
      const later = new Date(NOW.getTime() + 13 * 3_600_000);
      const second = await runSentinels(pool, manifests, later, 'UTC');
      expect(second[0]).toMatchObject({ findings: 1, fired: 0, resolved: 0 });
    });

    it('does not run, and resolves nothing, while its switch is off', async () => {
      await write({
        from: 'owner@example.test',
        to: 'client@work.test',
        subject: 'The quote',
        threadKey: '<switch-promise@work.test>',
        at: daysBefore(4),
        body: "I'll send the figures tomorrow.",
        direction: 'out',
      });
      const manifests = [{ ...manifest, sentinels: [promisedReply] }];
      await runSentinels(pool, manifests, NOW, 'UTC');
      await setSentinelEnabled(pool, 'email.promised-reply', false, NOW);
      const off = await runSentinels(pool, manifests, new Date(NOW.getTime() + 86_400_000), 'UTC');
      expect(off[0]).toMatchObject({ ran: false, disabled: true });
    });

    it('names every receipt its cap left out rather than letting them resolve', async () => {
      for (let i = 0; i < 25; i++) {
        await write({
          from: `billing${i}@insurer.test`,
          to: 'owner@example.test',
          subject: `Invoice 2026-${i}`,
          threadKey: `<cap-${i}@insurer.test>`,
          at: daysBefore(1),
          body: 'Total: €10,00',
          scanned: false,
        });
      }
      const result = await receiptOrBill.run(ctx());
      expect(findingsOf(result)).toHaveLength(20);
      expect(new Set(stillTrueKeys(result)).size).toBe(25);
    });
  });
});
