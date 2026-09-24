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
import {
  createPool,
  findingsOf,
  openFindings,
  pendingDigestItems,
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
import { MAX_DATE_FINDINGS, MAX_WAITING_FINDINGS, dateStated, waitingOnMe } from './index.js';
import { createPluginHost, hostBindingOf } from '@buddi/core';

/** The context core hands the email plugin: these facts, with its `ctx.buddi` built over them. */
function hosted<C>(facts: C): C {
  // Built over the context it returns, so a test that changes a field on it
  // afterwards changes what the host reads, as core's per-call host would.
  const ctx = { ...facts } as C & { buddi?: unknown };
  ctx.buddi = createPluginHost(hostBindingOf(manifest), ctx as never);
  return ctx;
}

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

  /**
   * What a sentinel raises this tick. Both watchers report more than they
   * raise — the keys past their cap are still true and must not be resolved —
   * so a test that is about the findings unwraps them here.
   */
  async function raise(sentinel: Sentinel, context: SentinelContext): Promise<Finding[]> {
    return findingsOf(await sentinel.run(context));
  }

  function ctx(over: Partial<SentinelContext> = {}): SentinelContext {
    return hosted({
      db: pool,
      ownerId: 'owner',
      now: () => NOW,
      timezone: 'UTC',
      agentForRole: () => undefined,
      ...over,
    } as SentinelContext);
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
      const findings = await raise(waitingOnMe, ctx());
      expect(findings).toHaveLength(1);
      const finding = findings[0]!;
      expect(finding.key).toBe(`email.waiting-on-me:${threadId}:${messageId}`);
      // Every sender-controlled word in the title is fenced as data: the
      // address and the subject both came out of the message.
      expect(finding.title).toBe(
        `${quoted('agent@letting.test')} has been waiting 3 days on ${quoted('The lease')}`,
      );
      expect(finding.severity).toBe('info');
      expect(finding.detail).toContain('Could you confirm?');
      expect(finding.agentId).toBeUndefined();
    });

    it('says nothing inside the window, and says something once it is past', async () => {
      await waitingThread({ ageDays: 1 });
      expect(await raise(waitingOnMe, ctx())).toEqual([]);
      // The owner widening the window silences a thread that was reported.
      await waitingThread({ ageDays: 3, uid: 200, subject: 'The survey' });
      expect(await raise(waitingOnMe, ctx())).toHaveLength(1);
      await setWatcherSettings(pool, { waitingDays: 5 }, NOW);
      expect(await raise(waitingOnMe, ctx())).toEqual([]);
    });

    it('is urgent once a week has gone by', async () => {
      await waitingThread({ ageDays: 8 });
      const findings = await raise(waitingOnMe, ctx());
      expect(findings.map((f) => [f.severity, f.title])).toEqual([
        [
          'urgent',
          `${quoted('agent@letting.test')} has been waiting 8 days on ${quoted('The lease')}`,
        ],
      ]);
    });

    it('says nothing about somebody the owner has never written to', async () => {
      await waitingThread({ ageDays: 5, replied: false });
      expect(await raise(waitingOnMe, ctx())).toEqual([]);
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
      expect(await raise(waitingOnMe, ctx())).toHaveLength(1);
    });

    it('says nothing about a mailbox the owner switched off', async () => {
      // A disabled account keeps its mail and is not polled; its threads are
      // not something to be nagged about, and `email.waiting_on_me` counts
      // them for nothing either — one query, one scope, both of them.
      await waitingThread({ ageDays: 5 });
      expect(await raise(waitingOnMe, ctx())).toHaveLength(1);
      await pool.query(`update email.accounts set enabled = false where id = $1`, [accountId]);
      const report = await waitingOnMe.run(ctx());
      expect(findingsOf(report)).toEqual([]);
      expect([...stillTrueKeys(report)]).toEqual([]);
    });

    it('respects a muted conversation', async () => {
      const { threadId } = await waitingThread({ ageDays: 5 });
      await setThreadState(pool, threadId, 'muted');
      expect(await raise(waitingOnMe, ctx())).toEqual([]);
    });

    it('respects an ignore policy on the sender, and on their domain', async () => {
      await waitingThread({ ageDays: 5 });
      await ignorePolicy('agent@letting.test');
      expect(await raise(waitingOnMe, ctx())).toEqual([]);

      await pool.query(`delete from email.policies`);
      expect(await raise(waitingOnMe, ctx())).toHaveLength(1);
      await ignorePolicy('letting.test', 'domain');
      expect(await raise(waitingOnMe, ctx())).toEqual([]);
    });

    it('ignores a policy that is only proposed', async () => {
      await waitingThread({ ageDays: 5 });
      await pool.query(
        `insert into email.policies (account_id, scope, matcher, action, params, origin, proposed)
         values ($1, 'sender', 'agent@letting.test', 'ignore', '{}'::jsonb, 'learned', true)`,
        [accountId],
      );
      expect(await raise(waitingOnMe, ctx())).toHaveLength(1);
    });

    it('returns the same key on every run, and a new one when they write again', async () => {
      const first = await waitingThread({ ageDays: 3 });
      const a = await raise(waitingOnMe, ctx());
      const b = await raise(waitingOnMe, ctx());
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
      const c = await raise(waitingOnMe, ctx());
      expect(c).toHaveLength(1);
      expect(c[0]!.key).toBe(`email.waiting-on-me:${first.threadId}:${second.messageId}`);
    });

    it('addresses the finding by role when somebody holds one', async () => {
      await waitingThread({ ageDays: 3 });
      const mail = await raise(waitingOnMe, ctx({ agentForRole: (role) => (role === 'mail' ? 'mailer' : undefined) }));
      expect(mail[0]!.agentId).toBe('mailer');
      const triage = await raise(waitingOnMe, 
        ctx({ agentForRole: (role) => (role === 'triage' ? 'mail-triage' : undefined) }),
      );
      expect(triage[0]!.agentId).toBe('mail-triage');
    });

    it('says nothing about a conversation that went stale a month ago', async () => {
      // Migration 007 seeds every inbound-last thread as `waiting-on-me`, so a
      // real mailbox arrives with years of these. A month is the ceiling: past
      // it, an unanswered thread is history and not an alarm.
      await waitingThread({ ageDays: 45, uid: 600 });
      expect(await raise(waitingOnMe, ctx())).toEqual([]);
      // The near edge is still reported.
      await waitingThread({ ageDays: 29, uid: 601, subject: 'The survey' });
      expect(await raise(waitingOnMe, ctx())).toHaveLength(1);
    });

    it('reports the newest waiting threads first', async () => {
      await waitingThread({ ageDays: 20, uid: 610, subject: 'Older' });
      await waitingThread({ ageDays: 4, uid: 611, subject: 'Newer' });
      const titles = (await raise(waitingOnMe, ctx())).map((f) => f.title);
      expect(titles[0]).toContain('Newer');
      expect(titles[1]).toContain('Older');
    });

    it('does not resolve the threads its cap left out', async () => {
      // Twenty-five qualifying threads against a cap of twenty. The five that
      // are not raised are still true, and a tick that let core resolve them
      // would hand them back as news on the next one, forever.
      for (let i = 0; i < 25; i++) {
        await waitingThread({ ageDays: 2 + i, uid: 700 + i, subject: `Matter ${i}` });
      }
      const result = await waitingOnMe.run(ctx());
      expect(findingsOf(result)).toHaveLength(MAX_WAITING_FINDINGS);
      expect(new Set(stillTrueKeys(result)).size).toBe(25);

      const manifests = [{ ...manifest, sentinels: [waitingOnMe] }];
      const first = await runSentinels(pool, manifests, NOW, 'UTC');
      expect(first[0]).toMatchObject({ findings: 20, resolved: 0 });
      const second = await runSentinels(pool, manifests, new Date(NOW.getTime() + 13 * 3_600_000), 'UTC');
      expect(second[0]).toMatchObject({ findings: 20, resolved: 0 });
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

  // ---------------------------------------------------------- the switch
  describe('a watcher switched off and back on', () => {
    it('replays nothing, and reports only what is still true', async () => {
      const manifests = [{ ...manifest, sentinels: [waitingOnMe] }];
      const answered = await waitingThread({ ageDays: 3, uid: 800, subject: 'Answered later' });
      await waitingThread({ ageDays: 5, uid: 801, subject: 'Left to go stale' });

      const first = await runSentinels(pool, manifests, NOW, 'UTC');
      expect(first[0]).toMatchObject({ findings: 2, fired: 2, resolved: 0 });
      expect(await pendingDigestItems(pool)).toHaveLength(2);

      // Off for four weeks. Nothing runs and nothing resolves.
      await setSentinelEnabled(pool, 'email.waiting-on-me', false, NOW);
      const later = new Date(NOW.getTime() + 27 * 86_400_000);
      const off = await runSentinels(pool, manifests, new Date(NOW.getTime() + 86_400_000), 'UTC');
      expect(off[0]).toMatchObject({ ran: false, disabled: true });

      // While it was off: one thread was answered, one went stale past the
      // ceiling, and a new conversation started waiting.
      await setThreadState(pool, answered.threadId, 'waiting-on-them');
      await write({
        uid: 802,
        from: 'agent@letting.test',
        to: 'owner@example.test',
        subject: 'Started while it was off',
        threadKey: '<thread-802@letting.test>',
        at: new Date(later.getTime() - 3 * 86_400_000),
        body: 'Any news?',
        scanned: true,
      });

      await setSentinelEnabled(pool, 'email.waiting-on-me', true, later);
      const back = await runSentinels(pool, manifests, later, 'UTC');
      // One fact, and it is the one that is true now: the answered thread is
      // not news and the stale one is not either. Both resolve quietly.
      expect(back[0]).toMatchObject({ findings: 1, fired: 1, resolved: 2 });
      const open = await openFindings(pool, 'email.waiting-on-me');
      expect(open).toHaveLength(1);
      expect(open[0]!.title).toContain('Started while it was off');
      // And the two resolved facts are gone from the queue the recap reads,
      // rather than waiting there to be read out as though they still held.
      const pending = await pendingDigestItems(pool);
      expect(pending.map((i) => i.findingKey)).toEqual([open[0]!.key]);
    });

    it('does not replay a fact that had already resolved before it was switched off', async () => {
      const manifests = [{ ...manifest, sentinels: [waitingOnMe] }];
      const thread = await waitingThread({ ageDays: 3, uid: 810, subject: 'Answered in time' });
      const raised = await runSentinels(pool, manifests, NOW, 'UTC');
      expect(raised[0]).toMatchObject({ findings: 1, fired: 1 });
      const key = (await openFindings(pool, 'email.waiting-on-me'))[0]!.key;

      // Answered, and the next tick resolves it — all while the watcher is on.
      await setThreadState(pool, thread.threadId, 'waiting-on-them');
      const resolvedTick = await runSentinels(
        pool,
        manifests,
        new Date(NOW.getTime() + 13 * 3_600_000),
        'UTC',
      );
      expect(resolvedTick[0]).toMatchObject({ findings: 0, resolved: 1 });
      expect(await pendingDigestItems(pool)).toHaveLength(0);

      // Off, then on three days later.
      await setSentinelEnabled(pool, 'email.waiting-on-me', false, new Date(NOW.getTime() + 14 * 3_600_000));
      const later = new Date(NOW.getTime() + 3 * 86_400_000);
      await setSentinelEnabled(pool, 'email.waiting-on-me', true, later);
      const back = await runSentinels(pool, manifests, later, 'UTC');

      // Nothing was said, and the old fact is still resolved: a finding that
      // was over before the switch was touched is not news afterwards.
      expect(back[0]).toMatchObject({ ran: true, findings: 0, fired: 0, resolved: 0 });
      expect(await pendingDigestItems(pool)).toEqual([]);
      const { rows } = await pool.query(
        `select resolved_at is not null as resolved from core.sentinel_findings where key = $1`,
        [key],
      );
      expect(rows).toEqual([{ resolved: true }]);
    });

    it('never makes a finding for a fact that arose and ceased while it was off', async () => {
      const manifests = [{ ...manifest, sentinels: [waitingOnMe] }];
      await setSentinelEnabled(pool, 'email.waiting-on-me', false, NOW);

      // Nobody is looking: a conversation starts waiting, and is answered.
      const unseen = await waitingThread({ ageDays: 3, uid: 820, subject: 'Came and went' });
      await runSentinels(pool, manifests, new Date(NOW.getTime() + 86_400_000), 'UTC');
      await setThreadState(pool, unseen.threadId, 'waiting-on-them');

      const later = new Date(NOW.getTime() + 2 * 86_400_000);
      await setSentinelEnabled(pool, 'email.waiting-on-me', true, later);
      const back = await runSentinels(pool, manifests, later, 'UTC');

      expect(back[0]).toMatchObject({ ran: true, findings: 0, fired: 0, resolved: 0 });
      const { rows } = await pool.query(
        `select count(*)::int as n from core.sentinel_findings where key like $1`,
        [`email.waiting-on-me:${unseen.threadId}:%`],
      );
      // It never existed as a finding, so there is nothing to replay and
      // nothing to resolve: the owner hears about what is true, not about
      // what happened to be true while he was not being told.
      expect(rows[0].n).toBe(0);
      expect(await pendingDigestItems(pool)).toEqual([]);
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
      const findings = await raise(dateStated, ctx());
      expect(findings).toHaveLength(1);
      expect(findings[0]!.key).toBe(`email.date-stated:${messageId}:2026-09-30`);
      expect(findings[0]!.title).toBe(
        `A date is stated: 2026-09-30, in ${quoted('Insurance renewal')}`,
      );
      expect(findings[0]!.severity).toBe('info');
      expect(findings[0]!.detail).toContain(`wrote ${quoted('30 September')}`);
      expect(findings[0]!.data).toMatchObject({ threadId, suggestedAction: 'set-a-reminder' });

      const { rows } = await pool.query(
        `select to_char(on_date, 'YYYY-MM-DD') as day, phrase, confidence, dates_scanned_at is not null as scanned
           from email.dates d join email.messages m on m.id = d.message_id`,
      );
      expect(rows).toEqual([
        // The keyword raised the confidence; the phrase is the date itself.
        // `confidence` is `numeric(3,2)`, which pg hands back as a string —
        // exactly the point of the column type: two decimals, no float drift.
        { day: '2026-09-30', phrase: '30 September', confidence: '0.80', scanned: true },
      ]);
    });

    it('reads the message once, and repeats itself without new rows', async () => {
      await stating('Deadline 30 September.');
      const first = await raise(dateStated, ctx());
      const second = await raise(dateStated, ctx());
      expect(second.map((f) => f.key)).toEqual(first.map((f) => f.key));
      const { rows } = await pool.query(`select count(*)::int as n from email.dates`);
      expect(rows[0].n).toBe(1);
    });

    it('qualifies at a threshold it exactly equals', async () => {
      // `22/09` with nothing beside it scores 0.45 — and 0.45 is a threshold
      // the settings page lets the owner pick. Stored as `real`, it came back
      // as 0.44999998807907104 and lost to its own equal.
      await stating('Anyway, 22/09 then.', { uid: 420 });
      await setWatcherSettings(pool, { dateConfidence: 0.45 }, NOW);
      expect(await raise(dateStated, ctx())).toHaveLength(1);
    });

    it("says nothing below the owner's threshold", async () => {
      await stating('Anyway, 10/2 then.');
      expect(await raise(dateStated, ctx())).toEqual([]);
      // The reading is still stored: it is evidence, not a finding.
      const { rows } = await pool.query(`select confidence from email.dates`);
      expect(Number(rows[0].confidence)).toBeCloseTo(0.3, 5);

      await setWatcherSettings(pool, { dateConfidence: 0.2 }, NOW);
      expect(await raise(dateStated, ctx())).toHaveLength(1);
    });

    it('raises nothing for a date already gone by, or one beyond the fortnight', async () => {
      await stating('The deadline was 15 September.', { uid: 401 });
      await stating('The deadline is 30 October.', { uid: 402 });
      expect(await raise(dateStated, ctx())).toEqual([]);
    });

    it('reads a backlog message whose date has since come close', async () => {
      // The catch-up case the sweep exists for: a message from six weeks ago,
      // read for the first time now. Its date was 49 days out when it was
      // written and is four days out today — a window measured from the
      // message would drop it, and the stamp would mean nothing ever looked
      // again.
      const { messageId } = await stating('The deadline is 25 September.', {
        uid: 410,
        at: daysBefore(45),
      });
      const findings = await raise(dateStated, ctx());
      expect(findings.map((f) => f.key)).toEqual([`email.date-stated:${messageId}:2026-09-25`]);
    });

    it('keeps a date announced a month ahead, and raises it once it is close', async () => {
      const { messageId } = await stating('The deadline is 30 October.', { uid: 411 });
      // Nothing to say today: it is outside the fortnight.
      expect(await raise(dateStated, ctx())).toEqual([]);
      // But it was read and kept, which is what makes the next line possible.
      const { rows } = await pool.query(
        `select to_char(on_date, 'YYYY-MM-DD') as day from email.dates`,
      );
      expect(rows).toEqual([{ day: '2026-10-30' }]);

      const october = new Date('2026-10-20T12:00:00Z');
      const findings = await raise(dateStated, ctx({ now: () => october }));
      expect(findings.map((f) => f.key)).toEqual([`email.date-stated:${messageId}:2026-10-30`]);
    });

    it('names the dates its cap left out rather than letting them resolve', async () => {
      for (let i = 0; i < 25; i++) {
        await stating(`The deadline is 30 September, ref ${i}.`, { uid: 900 + i });
      }
      const result = await dateStated.run(ctx());
      expect(findingsOf(result)).toHaveLength(MAX_DATE_FINDINGS);
      expect(new Set(stillTrueKeys(result)).size).toBe(25);

      const manifests = [{ ...manifest, sentinels: [dateStated] }];
      await runSentinels(pool, manifests, NOW, 'UTC');
      const second = await runSentinels(pool, manifests, new Date(NOW.getTime() + 2 * 3_600_000), 'UTC');
      expect(second[0]).toMatchObject({ resolved: 0 });
    });

    it('skips a message from a sender the owner silenced, without reading it', async () => {
      await ignorePolicy('billing@insurer.test');
      await stating('Your policy is due 30 September.');
      expect(await raise(dateStated, ctx())).toEqual([]);
      const { rows } = await pool.query(
        `select (select count(*)::int from email.dates) as dates,
                (select count(*)::int from email.messages where dates_scanned_at is null) as unscanned`,
      );
      expect(rows[0]).toEqual({ dates: 0, unscanned: 0 });
    });

    it('silences a stored reading when a policy arrives after the scan', async () => {
      await stating('Your policy is due 30 September.');
      expect(await raise(dateStated, ctx())).toHaveLength(1);
      await ignorePolicy('insurer.test', 'domain');
      expect(await raise(dateStated, ctx())).toEqual([]);
    });

    it('says nothing about a muted conversation', async () => {
      const { threadId } = await stating('Your policy is due 30 September.');
      await setThreadState(pool, threadId, 'muted');
      expect(await raise(dateStated, ctx())).toEqual([]);
    });

    it('says nothing when a reminder for that day on that thread already exists', async () => {
      const { threadId } = await stating('Your policy is due 30 September.');
      expect(await raise(dateStated, ctx())).toHaveLength(1);

      await pool.query(
        `insert into core.reminders (agent_id, due_at, text, context, state)
         values ('mail-triage', $1, 'check the renewal', $2::jsonb, 'pending')`,
        ['2026-09-30T08:00:00Z', JSON.stringify({ threadId })],
      );
      expect(await raise(dateStated, ctx())).toEqual([]);
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
      expect(await raise(dateStated, ctx())).toHaveLength(1);
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
      expect(await raise(dateStated, ctx())).toEqual([]);
      const { rows } = await pool.query(`select count(*)::int as n from email.dates`);
      expect(rows[0].n).toBe(0);
    });

    it('addresses the finding by role', async () => {
      await stating('Your policy is due 30 September.');
      const findings = await raise(dateStated, 
        ctx({ agentForRole: (role) => (role === 'mail' ? 'mailer' : undefined) }),
      );
      expect(findings[0]!.agentId).toBe('mailer');
    });
  });
});
