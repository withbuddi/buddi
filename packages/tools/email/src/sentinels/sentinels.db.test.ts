/**
 * The two mail watchers on fixtures (docs/specs/email.md §7, step 4).
 *
 * Skipped unless DATABASE_URL is set. It never touches the developer's data:
 * the suite creates its own database, migrates core plus this plugin into it,
 * and drops it at the end. No socket is opened to any mailbox and no model is
 * called — a sentinel is SQL and TypeScript, which is the whole point of it.
 *
 * What it is here to hold:
 *
 *  - `email.waiting-on-me` fires for a thread waiting longer than the setting,
 *    from somebody the owner has written to before;
 *  - it says nothing about a stranger, a muted thread, a silenced sender, or a
 *    thread inside the window;
 *  - the same fact is the same key on every run, and its severity is the age;
 *  - `email.date-stated` reads the messages nothing has read yet, stores what
 *    it found in `email.dates`, and raises one finding per message-date above
 *    the owner's threshold;
 *  - a reminder already set for that day on that conversation silences it, and
 *    so does an ignore policy on the sender.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, runMigrations, runSentinels, type SentinelContext } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { ensureGmailAccount, GMAIL_SECRET_NAME } from '../config.js';
import { manifest } from '../index.js';
import { joinThread, setThreadState } from '../threads.js';
import { setWatcherSettings } from '../watchers.js';
import { dateStated, waitingOnMe } from './index.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_email_watchers_test_${process.pid}`;
const ENV = { GMAIL_USER: 'owner@example.test', [GMAIL_SECRET_NAME]: 'app-password' };
/** A Monday, noon UTC. Every age below is measured from it. */
const NOW = new Date('2026-09-21T12:00:00Z');

function daysBefore(n: number): Date {
  return new Date(NOW.getTime() - n * 86_400_000);
}

suite('email watchers (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let accountId: string;
  let folderId: string;
  let sentFolderId: string;

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
      'truncate email.dates, email.events, email.policies, email.threads, email.drafts, ' +
        'email.triage, email.messages, email.folders, email.accounts, email.settings cascade',
    );
    await pool.query('truncate core.sentinel_findings, core.sentinel_runs, core.digest_items, core.reminders cascade');
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

  /** One message, threaded the way ingest threads it. Returns its row id. */
  async function write(over: {
    uid: number;
    from: string;
    to: string;
    subject: string;
    threadKey: string;
    at: Date;
    body?: string;
    direction?: 'in' | 'out';
    scanned?: boolean;
  }): Promise<{ messageId: string; threadId: string }> {
    const direction = over.direction ?? 'in';
    const { rows } = await pool.query(
      `insert into email.messages
         (account_id, folder_id, uidvalidity, uid, message_id, thread_key, from_addr, to_addrs,
          subject, date, internal_date, snippet, body_text, direction, triage_enqueued_at,
          dates_scanned_at)
       values ($1, $2, 1, $3, $4, $5, $6, $7::jsonb, $8, $9, $9, '', $10, $11, now(), $12)
       returning id`,
      [
        accountId,
        direction === 'out' ? sentFolderId : folderId,
        over.uid,
        `<m${over.uid}@example.test>`,
        over.threadKey,
        over.from,
        JSON.stringify([over.to]),
        over.subject,
        over.at,
        over.body ?? '',
        direction,
        over.scanned ? NOW : null,
      ],
    );
    const messageId = String(rows[0].id);
    const thread = await joinThread(pool, {
      accountId,
      threadKey: over.threadKey,
      messageRowId: messageId,
      subject: over.subject,
      participants: [over.from, over.to],
      at: over.at,
      folderId: direction === 'out' ? sentFolderId : folderId,
      uidValidity: 1,
      uid: over.uid,
      direction,
    });
    return { messageId, threadId: thread.id };
  }

  /**
   * A conversation waiting on the owner for `ageDays`, from somebody he has
   * written to before — the shape the watcher is about.
   */
  async function waitingThread(
    opts: { ageDays: number; from?: string; replied?: boolean; uid?: number; subject?: string } = { ageDays: 3 },
  ): Promise<{ messageId: string; threadId: string }> {
    const from = opts.from ?? 'agent@letting.test';
    const uid = opts.uid ?? 100;
    const key = `<thread-${uid}@letting.test>`;
    if (opts.replied !== false) {
      // The owner's own reply, in an older conversation: this is what "has
      // replied to them before" is read from.
      await write({
        uid: uid + 1000,
        from: 'owner@example.test',
        to: from,
        subject: 'An older matter',
        threadKey: `<old-${uid}@letting.test>`,
        at: daysBefore(40),
        direction: 'out',
        scanned: true,
      });
    }
    return write({
      uid,
      from,
      to: 'owner@example.test',
      subject: opts.subject ?? 'The lease',
      threadKey: key,
      at: daysBefore(opts.ageDays),
      body: 'Could you confirm?\nThanks.',
      scanned: true,
    });
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

  // ------------------------------------------------------ waiting-on-me
  describe('email.waiting-on-me', () => {
    it('reports a thread waiting longer than the setting', async () => {
      const { threadId, messageId } = await waitingThread({ ageDays: 3 });
      const findings = await waitingOnMe.run(ctx());
      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.key).toBe(`email.waiting-on-me:${threadId}:${messageId}`);
      expect(finding.title).toBe('agent@letting.test has been waiting 3 days on "The lease"');
      expect(finding.severity).toBe('info');
      expect(finding.detail).toContain('Could you confirm?');
      expect(finding.agentId).toBeUndefined();
    });

    it('says nothing inside the window, and says something once it is past', async () => {
      await waitingThread({ ageDays: 1 });
      expect(await waitingOnMe.run(ctx())).toEqual([]);
      // The owner widening the window silences a thread that was reported.
      await waitingThread({ ageDays: 3, uid: 200, subject: 'The survey' });
      expect(await waitingOnMe.run(ctx())).toHaveLength(1);
      await setWatcherSettings(pool, { waitingDays: 5 }, NOW);
      expect(await waitingOnMe.run(ctx())).toEqual([]);
    });

    it('is urgent once a week has gone by', async () => {
      await waitingThread({ ageDays: 8 });
      const findings = await waitingOnMe.run(ctx());
      expect(findings.map((f) => [f.severity, f.title])).toEqual([
        ['urgent', 'agent@letting.test has been waiting 8 days on "The lease"'],
      ]);
    });

    it('says nothing about somebody the owner has never written to', async () => {
      await waitingThread({ ageDays: 5, replied: false });
      expect(await waitingOnMe.run(ctx())).toEqual([]);
    });

    it('counts a reply the owner sent from any client, in that mailbox', async () => {
      const { threadId } = await waitingThread({ ageDays: 5, replied: false });
      // The owner's own message, out of the Sent folder, in this very thread.
      await write({
        uid: 300,
        from: 'owner@example.test',
        to: 'agent@letting.test',
        subject: 'Re: The lease',
        threadKey: '<thread-100@letting.test>',
        at: daysBefore(6),
        direction: 'out',
        scanned: true,
      });
      // Their message is still the newest one, so the thread still waits on him.
      await setThreadState(pool, threadId, 'waiting-on-me');
      expect(await waitingOnMe.run(ctx())).toHaveLength(1);
    });

    it('respects a muted conversation', async () => {
      const { threadId } = await waitingThread({ ageDays: 5 });
      await setThreadState(pool, threadId, 'muted');
      expect(await waitingOnMe.run(ctx())).toEqual([]);
    });

    it('respects an ignore policy on the sender, and on their domain', async () => {
      await waitingThread({ ageDays: 5 });
      await ignorePolicy('agent@letting.test');
      expect(await waitingOnMe.run(ctx())).toEqual([]);

      await pool.query(`delete from email.policies`);
      expect(await waitingOnMe.run(ctx())).toHaveLength(1);
      await ignorePolicy('letting.test', 'domain');
      expect(await waitingOnMe.run(ctx())).toEqual([]);
    });

    it('ignores a policy that is only proposed', async () => {
      await waitingThread({ ageDays: 5 });
      await pool.query(
        `insert into email.policies (account_id, scope, matcher, action, params, origin, proposed)
         values ($1, 'sender', 'agent@letting.test', 'ignore', '{}'::jsonb, 'learned', true)`,
        [accountId],
      );
      expect(await waitingOnMe.run(ctx())).toHaveLength(1);
    });

    it('returns the same key on every run, and a new one when they write again', async () => {
      const first = await waitingThread({ ageDays: 3 });
      const a = await waitingOnMe.run(ctx());
      const b = await waitingOnMe.run(ctx());
      expect(a.map((f) => f.key)).toEqual(b.map((f) => f.key));

      const second = await write({
        uid: 101,
        from: 'agent@letting.test',
        to: 'owner@example.test',
        subject: 'Re: The lease',
        threadKey: '<thread-100@letting.test>',
        at: daysBefore(2),
        scanned: true,
      });
      const c = await waitingOnMe.run(ctx());
      expect(c).toHaveLength(1);
      expect(c[0]!.key).toBe(`email.waiting-on-me:${first.threadId}:${second.messageId}`);
    });

    it('addresses the finding by role when somebody holds one', async () => {
      await waitingThread({ ageDays: 3 });
      const mail = await waitingOnMe.run(ctx({ agentForRole: (role) => (role === 'mail' ? 'mailer' : undefined) }));
      expect(mail[0]!.agentId).toBe('mailer');
      const triage = await waitingOnMe.run(
        ctx({ agentForRole: (role) => (role === 'triage' ? 'mail-triage' : undefined) }),
      );
      expect(triage[0]!.agentId).toBe('mail-triage');
    });

    it('goes to the digest through core, once', async () => {
      await waitingThread({ ageDays: 3 });
      const first = await runSentinels(pool, [{ ...manifest, sentinels: [waitingOnMe] }], NOW, 'UTC');
      expect(first[0]).toMatchObject({ sentinelId: 'email.waiting-on-me', findings: 1, fired: 1 });
      const { rows } = await pool.query(`select title from core.digest_items where consumed_at is null`);
      expect(rows).toHaveLength(1);

      // The same fact an hour later is not news twice.
      const later = new Date(NOW.getTime() + 13 * 3_600_000);
      const second = await runSentinels(pool, [{ ...manifest, sentinels: [waitingOnMe] }], later, 'UTC');
      expect(second[0]).toMatchObject({ findings: 1, fired: 0 });
    });
  });

  // ------------------------------------------------------- date-stated
  describe('email.date-stated', () => {
    /** An unread inbound message whose text states a date. */
    async function stating(
      body: string,
      over: { uid?: number; from?: string; subject?: string; at?: Date } = {},
    ): Promise<{ messageId: string; threadId: string }> {
      return write({
        uid: over.uid ?? 400,
        from: over.from ?? 'billing@insurer.test',
        to: 'owner@example.test',
        subject: over.subject ?? 'Insurance renewal',
        threadKey: `<dates-${over.uid ?? 400}@insurer.test>`,
        at: over.at ?? daysBefore(1),
        body,
        scanned: false,
      });
    }

    it('reads an unscanned message, stores the reading, and raises one finding', async () => {
      const { messageId, threadId } = await stating('Your policy is due 30 September. Please confirm.');
      const findings = await dateStated.run(ctx());
      expect(findings).toHaveLength(1);
      expect(findings[0]!.key).toBe(`email.date-stated:${messageId}:2026-09-30`);
      expect(findings[0]!.title).toBe('A date is stated: 2026-09-30, in "Insurance renewal"');
      expect(findings[0]!.severity).toBe('info');
      expect(findings[0]!.detail).toContain('wrote "30 September"');
      expect(findings[0]!.data).toMatchObject({ threadId, suggestedAction: 'set-a-reminder' });

      const { rows } = await pool.query(
        `select to_char(on_date, 'YYYY-MM-DD') as day, phrase, confidence, dates_scanned_at is not null as scanned
           from email.dates d join email.messages m on m.id = d.message_id`,
      );
      expect(rows).toEqual([
        // The keyword raised the confidence; the phrase is the date itself.
        { day: '2026-09-30', phrase: '30 September', confidence: 0.8, scanned: true },
      ]);
    });

    it('reads the message once, and repeats itself without new rows', async () => {
      await stating('Deadline 30 September.');
      const first = await dateStated.run(ctx());
      const second = await dateStated.run(ctx());
      expect(second.map((f) => f.key)).toEqual(first.map((f) => f.key));
      const { rows } = await pool.query(`select count(*)::int as n from email.dates`);
      expect(rows[0].n).toBe(1);
    });

    it("says nothing below the owner's threshold", async () => {
      await stating('Anyway, 10/2 then.');
      expect(await dateStated.run(ctx())).toEqual([]);
      // The reading is still stored: it is evidence, not a finding.
      const { rows } = await pool.query(`select confidence from email.dates`);
      expect(Number(rows[0].confidence)).toBeCloseTo(0.3, 5);

      await setWatcherSettings(pool, { dateConfidence: 0.2 }, NOW);
      expect(await dateStated.run(ctx())).toHaveLength(1);
    });

    it('raises nothing for a date already gone by, or one beyond the fortnight', async () => {
      await stating('The deadline was 15 September.', { uid: 401 });
      await stating('The deadline is 30 October.', { uid: 402 });
      expect(await dateStated.run(ctx())).toEqual([]);
    });

    it('skips a message from a sender the owner silenced, without reading it', async () => {
      await ignorePolicy('billing@insurer.test');
      await stating('Your policy is due 30 September.');
      expect(await dateStated.run(ctx())).toEqual([]);
      const { rows } = await pool.query(
        `select (select count(*)::int from email.dates) as dates,
                (select count(*)::int from email.messages where dates_scanned_at is null) as unscanned`,
      );
      expect(rows[0]).toEqual({ dates: 0, unscanned: 0 });
    });

    it('silences a stored reading when a policy arrives after the scan', async () => {
      await stating('Your policy is due 30 September.');
      expect(await dateStated.run(ctx())).toHaveLength(1);
      await ignorePolicy('insurer.test', 'domain');
      expect(await dateStated.run(ctx())).toEqual([]);
    });

    it('says nothing about a muted conversation', async () => {
      const { threadId } = await stating('Your policy is due 30 September.');
      await setThreadState(pool, threadId, 'muted');
      expect(await dateStated.run(ctx())).toEqual([]);
    });

    it('says nothing when a reminder for that day on that thread already exists', async () => {
      const { threadId } = await stating('Your policy is due 30 September.');
      expect(await dateStated.run(ctx())).toHaveLength(1);

      await pool.query(
        `insert into core.reminders (agent_id, due_at, text, context, state)
         values ('mail-triage', $1, 'check the renewal', $2::jsonb, 'pending')`,
        ['2026-09-30T08:00:00Z', JSON.stringify({ threadId })],
      );
      expect(await dateStated.run(ctx())).toEqual([]);
    });

    it('is not silenced by a reminder for another day, another thread, or a cancelled one', async () => {
      const { threadId } = await stating('Your policy is due 30 September.');
      await pool.query(
        `insert into core.reminders (agent_id, due_at, text, context, state)
         values ('mail-triage', '2026-09-29T08:00:00Z', 'wrong day', $1::jsonb, 'pending'),
                ('mail-triage', '2026-09-30T08:00:00Z', 'wrong thread', $2::jsonb, 'pending'),
                ('mail-triage', '2026-09-30T08:00:00Z', 'cancelled', $1::jsonb, 'cancelled')`,
        [JSON.stringify({ threadId }), JSON.stringify({ threadId: '00000000-0000-0000-0000-000000000001' })],
      );
      expect(await dateStated.run(ctx())).toHaveLength(1);
    });

    it("never reads the owner's own mail for dates", async () => {
      await write({
        uid: 500,
        from: 'owner@example.test',
        to: 'someone@work.test',
        subject: 'Re: the plan',
        threadKey: '<mine@example.test>',
        at: daysBefore(1),
        body: 'I will send it by 30 September, deadline noted.',
        direction: 'out',
        scanned: false,
      });
      expect(await dateStated.run(ctx())).toEqual([]);
      const { rows } = await pool.query(`select count(*)::int as n from email.dates`);
      expect(rows[0].n).toBe(0);
    });

    it('addresses the finding by role', async () => {
      await stating('Your policy is due 30 September.');
      const findings = await dateStated.run(
        ctx({ agentForRole: (role) => (role === 'mail' ? 'mailer' : undefined) }),
      );
      expect(findings[0]!.agentId).toBe('mailer');
    });
  });
});
