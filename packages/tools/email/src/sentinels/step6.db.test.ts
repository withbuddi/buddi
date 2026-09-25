/**
 * The four step-6 mail watchers on fixtures (docs/email.md §7).
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
import type { BuddiHost } from '@buddi/core/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPool,
  findingsOf,
  openFindings,
  runMigrations,
  runSentinels,
  setSentinelEnabled,
  stillTrueKeys,
  type Finding,
  type Sentinel,
  type CoreSentinelContext,
} from '@buddi/core/testing';
import { testDatabaseUrl } from '@buddi/core/testing';
import { ensureGmailAccount, GMAIL_SECRET_NAME } from '../config.js';
import { manifest } from '../index.js';
import { quoted } from '../mail.js';
import { joinThread, setThreadState } from '../threads.js';
import { nameKey, discriminatingName } from '../phrases.js';
import { setWatcherSettings } from '../watchers.js';
import {
  promisedReply,
  receiptOrBill,
  suspiciousSender,
  unansweredByThem,
} from './index.js';
import { createPluginHost, hostBindingOf } from '@buddi/core/testing';

/** The context core hands the email plugin: these facts, with its `ctx.buddi` built over them. */
function hosted<C>(facts: C): C & { buddi: BuddiHost } {
  // Built over the context it returns, so a test that changes a field on it
  // afterwards changes what the host reads, as core's per-call host would.
  const ctx = { ...facts } as C & { buddi: BuddiHost };
  ctx.buddi = createPluginHost(hostBindingOf(manifest), ctx as never);
  return ctx;
}

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
    /** Chosen only where the ordering of two messages is what is under test. */
    uid?: number;
    fetchedAt?: Date;
  }): Promise<{ messageId: string; threadId: string }> {
    const direction = over.direction ?? 'in';
    const scanned = over.scanned ?? true;
    const messageUid = over.uid ?? uid++;
    const { rows } = await pool.query(
      `insert into email.messages
         (account_id, folder_id, uidvalidity, uid, message_id, thread_key, from_addr, to_addrs, cc,
          subject, date, internal_date, snippet, body_text, direction, list_id,
          triage_enqueued_at, dates_scanned_at, receipts_scanned_at, suspicion_scanned_at,
          fetched_at)
       values ($1, $2, 1, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $10, '', $11, $12, $13,
               now(), $14, $14, $14, coalesce($15::timestamptz, now()))
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
        over.fetchedAt ?? null,
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

  async function raise(sentinel: Sentinel, context: CoreSentinelContext): Promise<Finding[]> {
    return findingsOf(await sentinel.run(context));
  }

  function ctx(over: Partial<CoreSentinelContext> = {}): CoreSentinelContext {
    return hosted({
      db: pool,
      ownerId: 'owner',
      now: () => NOW,
      timezone: 'UTC',
      agentForRole: () => undefined,
      ...over,
    } as CoreSentinelContext);
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

    it('still reports at a setting of 30 and of 31, rather than going silent', async () => {
      /*
       * The bug: the setting went to 60 and the history window was pinned at
       * 30, so `promisedDays = 31` reported nothing at all — a number the
       * settings page offers, saved without complaint, switching the watcher
       * off. The window is computed from the setting now.
       */
      await promised({ ageDays: 33, subject: 'Thirty-three days' });
      await setWatcherSettings(pool, { promisedDays: 30 }, NOW);
      expect(await raise(promisedReply, ctx())).toHaveLength(1);
      await setWatcherSettings(pool, { promisedDays: 31 }, NOW);
      expect(await raise(promisedReply, ctx())).toHaveLength(1);
      // And the ceiling still exists: a week above the setting, no more.
      await setWatcherSettings(pool, { promisedDays: 1 }, NOW);
      expect(await raise(promisedReply, ctx())).toEqual([]);
    });

    it('raises the oldest urgent promises first, so drafts are never starved', async () => {
      // Twenty-five three-day notices, and one nine-day draft. The draft used
      // to be appended after the promises and never made the cap at all.
      for (let i = 0; i < 25; i++) await promised({ ageDays: 4, subject: `Matter ${i}` });
      const { threadId } = await write({
        from: 'client@work.test',
        to: 'owner@example.test',
        subject: 'The starved draft',
        threadKey: '<starved@work.test>',
        at: daysBefore(12),
        body: 'Could you send the quote?',
      });
      await pool.query(
        `insert into email.drafts
           (account_id, thread_id, to_addrs, subject, body_text, status, created_by_agent, updated_at)
         values ($1, $2, $3::jsonb, 'Re: the quote', 'Here it is.', 'draft', 'mailer', $4)`,
        [accountId, threadId, JSON.stringify(['client@work.test']), daysBefore(9)],
      );
      const result = await promisedReply.run(ctx());
      const findings = findingsOf(result);
      expect(findings).toHaveLength(20);
      expect(findings[0]!.severity).toBe('urgent');
      expect(findings[0]!.title).toContain('drafted and not sent');
      // And every truncated promise is still named, so none of them resolves.
      expect(new Set(stillTrueKeys(result)).size).toBe(26);
    });

    it('orders by the instant, so a newer draft is inside the cap', async () => {
      /*
       * Twenty-five promises all made *yesterday*, and a draft written an hour
       * ago. Every one of them floors to the same whole number of days, so the
       * old `ageDays` sort left the cap falling wherever the rows happened to
       * arrive — and the newest thing in the mailbox could be the one it cut.
       */
      for (let i = 0; i < 25; i++) {
        await write({
          from: 'owner@example.test',
          to: 'client@work.test',
          subject: `Matter ${i}`,
          threadKey: `<tie-${i}@work.test>`,
          at: new Date(NOW.getTime() - 4 * 86_400_000 - (i + 1) * 60_000),
          body: "I'll send the figures.",
          direction: 'out',
        });
      }
      const { threadId } = await write({
        from: 'client@work.test',
        to: 'owner@example.test',
        subject: 'The newest thing here',
        threadKey: '<tie-draft@work.test>',
        at: daysBefore(5),
        body: 'Could you send the quote?',
      });
      const draft = await pool.query(
        `insert into email.drafts
           (account_id, thread_id, to_addrs, subject, body_text, status, created_by_agent, updated_at)
         values ($1, $2, $3::jsonb, 'Re: the quote', 'Here it is.', 'draft', 'mailer', $4)
         returning id`,
        [
          accountId,
          threadId,
          JSON.stringify(['client@work.test']),
          new Date(NOW.getTime() - 4 * 86_400_000 + 3_600_000),
        ],
      );
      const findings = await raise(promisedReply, ctx());
      expect(findings).toHaveLength(20);
      // Same severity, same floored age as the promises — and first, because
      // it is newer by the clock.
      expect(findings[0]!.key).toBe(
        `email.promised-reply:${threadId}:draft:${String(draft.rows[0].id)}`,
      );
    });

    it('does not report a promise a same-second reply may have followed', async () => {
      /*
       * INTERNALDATE has second resolution, and `messages.id` is a random
       * uuid: the tie-break used to be a coin. Same folder, same second, and
       * the UID — which the server assigns in arrival order — settles it.
       */
      const at = daysBefore(6);
      const { threadId } = await write({
        from: 'owner@example.test',
        to: 'client@work.test',
        subject: 'The quote',
        threadKey: '<same-second@work.test>',
        at,
        body: "I'll send the figures tomorrow.",
        direction: 'out',
        uid: 500,
      });
      expect(await raise(promisedReply, ctx())).toHaveLength(1);

      // A second outbound message, the same second, with a higher UID: the
      // server saw it after, so the promise was kept.
      await pool.query(
        `insert into email.messages
           (account_id, folder_id, uidvalidity, uid, message_id, thread_id, thread_key, from_addr,
            to_addrs, subject, internal_date, fetched_at, body_text, direction)
         values ($1, $2, 1, 501, '<after@example.test>', $3, '<same-second@work.test>',
                 'owner@example.test', $4::jsonb, 'Re: The quote', $5, $5, 'Here they are.', 'out')`,
        [accountId, sentFolderId, threadId, JSON.stringify(['client@work.test']), at],
      );
      expect(await raise(promisedReply, ctx())).toEqual([]);
    });

    it('stays quiet when the same second is in two folders and cannot be read', async () => {
      /*
       * INBOX and Sent number their messages independently, so a UID says
       * nothing across them. With `fetched_at` equal too, nothing in this
       * database can separate the two — and the tie resolves as "it followed",
       * which silences the watcher rather than making it speak on a coin-flip.
       */
      const at = daysBefore(6);
      const { threadId } = await write({
        from: 'owner@example.test',
        to: 'client@work.test',
        subject: 'The quote',
        threadKey: '<cross-folder@work.test>',
        at,
        body: "I'll send the figures tomorrow.",
        direction: 'out',
        uid: 600,
        fetchedAt: at,
      });
      expect(await raise(promisedReply, ctx())).toHaveLength(1);

      // The owner's own message, the same second, filed in INBOX — a UID of
      // 1, which under a naive (instant, uid) rule would read as "before".
      await pool.query(
        `insert into email.messages
           (account_id, folder_id, uidvalidity, uid, message_id, thread_id, thread_key, from_addr,
            to_addrs, subject, internal_date, fetched_at, body_text, direction)
         values ($1, $2, 1, 1, '<crossed@example.test>', $3, '<cross-folder@work.test>',
                 'owner@example.test', $4::jsonb, 'Re: The quote', $5, $5, 'Here they are.', 'out')`,
        [accountId, folderId, threadId, JSON.stringify(['client@work.test']), at],
      );
      expect(await raise(promisedReply, ctx())).toEqual([]);
    });

    it('chases a draft that has no conversation yet', async () => {
      // `drafts.thread_id` is nullable; an inner join dropped exactly the
      // newest drafts, which is the wrong half to lose.
      const draft = await pool.query(
        `insert into email.drafts
           (account_id, to_addrs, subject, body_text, status, created_by_agent, updated_at)
         values ($1, $2::jsonb, 'A new message', 'Here it is.', 'draft', 'mailer', $3)
         returning id`,
        [accountId, JSON.stringify(['client@work.test']), daysBefore(8)],
      );
      const findings = await raise(promisedReply, ctx());
      expect(findings.map((f) => f.key)).toEqual([
        `email.promised-reply:none:draft:${String(draft.rows[0].id)}`,
      ]);
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
      // ids and numbers: the currency lives in the prose, not in `data`.
      expect(findings[0]!.data).toEqual({
        messageId,
        threadId,
        confidence: 0.95,
        amount: 120.5,
      });
      expect(findings[0]!.detail).toContain('€120.50');
      expect(findings[0]!.detail).toContain('hand it to whoever keeps the overview');

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

    it('stamps mail older than the fortnight without reading it', async () => {
      /*
       * The catch-up used to read every unscanned inbound message ever, oldest
       * first: on a mailbox taking in more than a batch an hour, the sweep
       * walks a decade of backlog for ever and this watcher is silent about
       * exactly the fortnight it exists for. Out-of-window mail is stamped in
       * one statement instead — it could never have raised a finding.
       */
      await arriving({ ageDays: 20 });
      expect(await raise(receiptOrBill, ctx())).toEqual([]);
      const { rows } = await pool.query(
        `select (select count(*)::int from email.receipts) as receipts,
                (select count(*)::int from email.messages where receipts_scanned_at is null) as unscanned`,
      );
      expect(rows[0]).toEqual({ receipts: 0, unscanned: 0 });
    });

    it('leaves a silenced sender unread and unstamped, so revoking the rule re-reads them', async () => {
      /*
       * A stamp is permanent and an `ignore` policy is not — the Learned list
       * revokes rules in one tap. Stamping a skipped message meant the owner
       * changing his mind changed nothing, for ever. The sweep's own query
       * excludes the sender instead, so the message takes no slot in the batch
       * and is read the moment the rule goes.
       */
      await ignorePolicy('billing@insurer.test');
      await arriving();
      expect(await raise(receiptOrBill, ctx())).toEqual([]);
      const before = await pool.query(
        `select (select count(*)::int from email.receipts) as receipts,
                (select count(*)::int from email.messages where receipts_scanned_at is null) as unscanned`,
      );
      expect(before.rows[0]).toEqual({ receipts: 0, unscanned: 1 });

      await pool.query('delete from email.policies');
      expect(await raise(receiptOrBill, ctx())).toHaveLength(1);
    });

    it('leaves a silenced sender unstamped even once the mail is old', async () => {
      /*
       * The bulk stamp runs every hour, and a stamp is permanent. Blind to the
       * policy, whether a silenced sender's mail could ever be read again
       * would depend on whether that statement happened to run before the
       * owner changed his mind about the rule.
       */
      await ignorePolicy('billing@insurer.test');
      await arriving({ ageDays: 40 });
      expect(await raise(receiptOrBill, ctx())).toEqual([]);
      const still = await pool.query(
        `select count(*)::int as n from email.messages where receipts_scanned_at is null`,
      );
      expect(still.rows[0].n).toBe(1);

      // Revoke it, and the next tick stamps it like everything else — it is
      // out of the window, so there is nothing to read, only to settle.
      await pool.query('delete from email.policies');
      expect(await raise(receiptOrBill, ctx())).toEqual([]);
      const settled = await pool.query(
        `select count(*)::int as n from email.messages where receipts_scanned_at is null`,
      );
      expect(settled.rows[0].n).toBe(0);
    });

    it('never stamps a message whose reading could not be stored', async () => {
      /*
       * The one state from which the fact can never be recovered: stamped as
       * read with nothing stored. The reading and the stamp are one statement
       * now, so a failed insert leaves the message to be read again.
       */
      await arriving();
      await pool.query(
        `alter table email.receipts add constraint tmp_refuse check (confidence < 0) not valid`,
      );
      expect(await raise(receiptOrBill, ctx())).toEqual([]);
      const { rows } = await pool.query(
        `select (select count(*)::int from email.receipts) as receipts,
                (select count(*)::int from email.messages where receipts_scanned_at is null) as unscanned`,
      );
      expect(rows[0]).toEqual({ receipts: 0, unscanned: 1 });

      await pool.query(`alter table email.receipts drop constraint tmp_refuse`);
      expect(await raise(receiptOrBill, ctx())).toHaveLength(1);
    });

    it('reads a total the column cannot hold as no total at all', async () => {
      // An order number read as money would make the insert throw, which under
      // the transactional stamp costs the message its whole reading.
      await arriving({ body: 'Invoice total €99999999999999999999,00' });
      const findings = await raise(receiptOrBill, ctx());
      expect(findings).toHaveLength(1);
      expect(findings[0]!.data).toMatchObject({ amount: null });
      expect(findings[0]!.title).toBe(`A receipt or bill arrived: ${quoted('Invoice 2026-114')}`);
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
      expect(Object.keys(findings[0]!.data as object).sort()).toEqual([
        'confidence',
        'messageId',
        'threadId',
      ]);
      expect(findings[0]!.detail).toContain('display name');
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
      expect(noted[0]!.data).toMatchObject({ confidence: 0.7 });
      expect(noted[0]!.detail).toContain('asks for a transfer');

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
      expect(findings[0]!.detail).toContain('display name');
      expect(findings[0]!.detail).toContain('asks for a transfer');
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

    /**
     * The two halves of this test are written twice — once in SQL and once in
     * TypeScript — and a pair that disagreed would mean a name that evades the
     * test silently rather than mismatching loudly. The comments in
     * `phrases.ts` and in `011_receipts.sql` both claim this suite holds them
     * together; this is that suite.
     */
    describe('the name key is one algorithm in two languages', () => {
      const NAMES = [
        '',
        'x',
        'Ana Rios',
        '"Ana Ríos"',
        'Ri\u0301os',
        'MEYER, Jean-Paul',
        'Jean-Paul Meyer',
        "O'Neil, Ana",
        'L\u2019Or\u00e9al',
        'S\u00f8ren Kj\u00e6r',
        'Soren Kjaer',
        'Stra\u00dfe',
        '\u0410na Ri\u043es',
        'SUPPORT',
        'Service Client',
        '   ',
        '\u0141ukasz \u0110uri\u0107',
      ];

      it.each(NAMES)('agrees with email.name_key on %j', async (name) => {
        const { rows } = await pool.query<{ key: string; ok: boolean }>(
          `select email.name_key($1) as key, email.discriminating_name($1) as ok`,
          [name],
        );
        expect(rows[0]!.key).toBe(nameKey(name));
        expect(rows[0]!.ok).toBe(discriminatingName(name));
      });
    });

    it('says nothing about a display name that identifies nobody', async () => {
      // The owner writes to his bank's support desk. Every other support desk
      // on earth then wears "a name you know" at "another address".
      await write({
        from: 'owner@example.test',
        to: '"Support" <support@bank.test>',
        subject: 'A question',
        threadKey: '<support-bank@bank.test>',
        at: daysBefore(20),
        body: 'Thanks.',
        direction: 'out',
      });
      await fromImpostor({ from: '"Support" <support@shop.test>' });
      expect(await raise(suspiciousSender, ctx())).toEqual([]);
    });

    it('sees through an accent and a homoglyph', async () => {
      await write({
        from: 'owner@example.test',
        to: '"S\u00f8ren Kj\u00e6r" <soren@supplier.test>',
        subject: 'The order',
        threadKey: '<known-soren@supplier.test>',
        at: daysBefore(20),
        body: 'Thanks.',
        direction: 'out',
      });
      // Written without the Scandinavian letters, at a domain he never writes to.
      await fromImpostor({ from: '"Soren Kjaer" <s.kjaer@supplier-invoices.test>' });
      expect(await raise(suspiciousSender, ctx())).toHaveLength(1);
    });

    it("never turns the owner's own name at his own alias into a fraud", async () => {
      await pool.query(`update email.accounts set aliases = $2 where id = $1::uuid`, [
        accountId,
        ['owner+work@example.test'],
      ]);
      // He writes to himself, under his own name.
      await write({
        from: 'owner@example.test',
        to: '"Amen Owner" <owner+work@example.test>',
        subject: 'A note to self',
        threadKey: '<self@example.test>',
        at: daysBefore(20),
        body: 'Remember this.',
        direction: 'out',
      });
      // And anybody else called that, at any address, is now a look-alike —
      // which is a warning about himself.
      await fromImpostor({ from: '"Amen Owner" <amen@elsewhere.test>' });
      expect(await raise(suspiciousSender, ctx())).toEqual([]);
    });

    it('forgets a name he has not written to in two years', async () => {
      await write({
        from: 'owner@example.test',
        to: '"Ana Rios" <ana.rios@old.test>',
        subject: 'Long ago',
        threadKey: '<ancient@old.test>',
        at: daysBefore(900),
        body: 'Thanks.',
        direction: 'out',
      });
      await fromImpostor({ from: '"Ana Rios" <a.rios@supplier-invoices.test>' });
      expect(await raise(suspiciousSender, ctx())).toEqual([]);
    });

    it('never stamps a body whose reading could not be stored', async () => {
      await fromImpostor({ body: 'Please make an urgent wire transfer today.' });
      await pool.query(
        `alter table email.suspicions add constraint tmp_refuse check (confidence < 0) not valid`,
      );
      expect(await raise(suspiciousSender, ctx())).toEqual([]);
      const blocked = await pool.query(
        `select count(*)::int as n from email.messages where suspicion_scanned_at is null`,
      );
      expect(blocked.rows[0].n).toBe(1);
      await pool.query(`alter table email.suspicions drop constraint tmp_refuse`);
      expect(await raise(suspiciousSender, ctx())).toHaveLength(1);
    });

    it('stamps mail older than the window without reading it', async () => {
      await fromImpostor({ ageDays: 20, body: 'Please buy two gift cards immediately.' });
      expect(await raise(suspiciousSender, ctx())).toEqual([]);
      const { rows } = await pool.query(
        `select (select count(*)::int from email.suspicions) as asks,
                (select count(*)::int from email.messages where suspicion_scanned_at is null) as unscanned`,
      );
      expect(rows[0]).toEqual({ asks: 0, unscanned: 0 });
    });

    it('leaves a real password-reset mail a notice, not a wake', async () => {
      // The failure this watcher could not afford: the owner resets his own
      // password and is woken about it hourly for a week, by the one watcher
      // an ignore policy may not silence.
      await fromImpostor({
        from: '"Accounts" <no-reply@bank.test>',
        body: 'You asked to reset your password. If this was not you, contact us immediately.',
      });
      const findings = await raise(suspiciousSender, ctx());
      expect(findings).toHaveLength(1);
      expect(findings[0]!.severity).toBe('info');
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
      expect(Object.keys(findings[0]!.data as object).sort()).toEqual([
        'ageDays',
        'messageId',
        'threadId',
      ]);
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

    it('still reports at a setting of 30 and of 31, rather than going silent', async () => {
      await asked({ ageDays: 33, subject: 'Thirty-three days' });
      await setWatcherSettings(pool, { nudgeDays: 30 }, NOW);
      expect(await raise(unansweredByThem, ctx())).toHaveLength(1);
      await setWatcherSettings(pool, { nudgeDays: 31 }, NOW);
      expect(await raise(unansweredByThem, ctx())).toHaveLength(1);
      // And the ceiling still exists: a small setting keeps the thirty-day
      // floor, and a question older than that is history rather than a nudge.
      await setWatcherSettings(pool, { nudgeDays: 1 }, NOW);
      expect(await raise(unansweredByThem, ctx())).toEqual([]);
    });

    it('reports a question to B on a thread C started', async () => {
      /*
       * "Not a reply to *their* message" used to be "not a reply to anybody":
       * an introduction from C, then the owner's original question to B, and
       * the finding was silently dropped. A three-party thread is the ordinary
       * shape of work.
       */
      const intro = await write({
        from: 'carla@intro.test',
        to: 'owner@example.test',
        subject: 'Introducing you two',
        threadKey: '<three-party@intro.test>',
        at: daysBefore(20),
        body: 'Meet Bruno.',
      });
      const { rows } = await pool.query(
        `insert into email.messages
           (account_id, folder_id, uidvalidity, uid, message_id, thread_id, thread_key, from_addr,
            to_addrs, subject, internal_date, body_text, direction)
         values ($1, $2, 1, 9300, '<toB@example.test>', $3, '<three-party@intro.test>',
                 'owner@example.test', $4::jsonb, 'Re: Introducing you two', $5,
                 'Bruno, could you send me the deck?', 'out')
         returning id`,
        [
          accountId,
          sentFolderId,
          intro.threadId,
          JSON.stringify(['bruno@work.test']),
          daysBefore(8),
        ],
      );
      const findings = await raise(unansweredByThem, ctx());
      expect(findings.map((f) => f.key)).toEqual([
        `email.unanswered-by-them:${intro.threadId}:${String(rows[0].id)}`,
      ]);
      expect(findings[0]!.title).toContain(quoted('bruno@work.test'));
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
      const manifests = [{ ...manifest, sentinels: [receiptOrBill] }];
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

      /*
       * Open all twenty-five *first*, so what follows is a statement about
       * resolution rather than about findings that were never raised. A cap of
       * twenty can only fail to resolve five facts if those five exist, and
       * the assertion that matters — "the tail is not resolved" — is empty
       * against a store where the tail was never opened.
       */
      const openAll = { ...receiptOrBill, run: receiptOrBill.run };
      const everything = await openAll.run(ctx());
      expect(new Set(stillTrueKeys(everything)).size).toBe(25);
      for (const key of stillTrueKeys(everything)) {
        await pool.query(
          `insert into core.sentinel_findings
             (key, sentinel_id, severity, title, detail, data, first_seen_at, last_seen_at)
           values ($1, 'email.receipt-or-bill', 'info', 'opened by hand', '', '{}'::jsonb, $2, $2)
           on conflict (key) do nothing`,
          [key, NOW],
        );
      }
      expect(await openFindings(pool, 'email.receipt-or-bill')).toHaveLength(25);

      // Now the capped run. It raises twenty and resolves none of the five.
      const capped = await runSentinels(pool, manifests, NOW, 'UTC');
      expect(capped[0]).toMatchObject({ findings: 20, resolved: 0 });
      expect(await openFindings(pool, 'email.receipt-or-bill')).toHaveLength(25);

      // And again, an hour later: still nothing resolved, still all open.
      const again = await runSentinels(pool, manifests, new Date(NOW.getTime() + 2 * 3_600_000), 'UTC');
      expect(again[0]).toMatchObject({ findings: 20, resolved: 0 });
      expect(await openFindings(pool, 'email.receipt-or-bill')).toHaveLength(25);
    });
  });
});
