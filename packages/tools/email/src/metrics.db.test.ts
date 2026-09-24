/**
 * `email.waiting_on_me`, measured the way core measures a metric: over
 * postgres, through `measureMetricResult`, which hands `measure` a context
 * whose `db` is the read-only pool — `begin isolation level repeatable read
 * read only`, one statement, `rollback`.
 *
 * The unit tests fake the rows; what only a database can settle is that these
 * statements survive that transaction at all. This one runs the watcher's own
 * common-table expression, the longest read in the plugin: if the read-only
 * wrapper's pre-filter or Postgres itself refuses it, it must be here and now,
 * not six weeks into somebody's goal on a sentinel tick nobody is watching.
 *
 * It never touches the developer's data: its own database, core's migrations
 * and this plugin's, dropped at the end. No socket is opened to any mailbox.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry, createPool, measureMetricResult, runMigrations } from '@buddi/core/testing';
import type { ToolContext } from '@buddi/core/testing';
import { testDatabaseUrl } from '@buddi/core/testing';
import { ensureGmailAccount, GMAIL_SECRET_NAME, markAccountSynced } from './config.js';
import { manifest } from './index.js';
import { joinThread } from './threads.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_email_metrics_test_${process.pid}`;
const ENV = { GMAIL_USER: 'owner@example.test', [GMAIL_SECRET_NAME]: 'app-password' };
/** A Monday, noon UTC. Every age below is measured from it. */
const NOW = new Date('2026-09-21T12:00:00Z');
const SYNCED = new Date('2026-09-21T11:45:00Z');

function daysBefore(n: number): Date {
  return new Date(NOW.getTime() - n * 86_400_000);
}

suite('the email metrics (postgres, read-only)', () => {
  let admin: Pool;
  let pool: Pool;
  let accountId: string;
  let folderId: string;
  let sentFolderId: string;
  let ctx: ToolContext;
  const registry = new ToolRegistry();

  /** Exactly what the goal machinery does: the registry as the metric source. */
  const measure = (id: string, params: unknown = {}) =>
    measureMetricResult(registry, id, params, ctx);

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [manifest]);
    registry.register(manifest);
    ctx = {
      db: pool,
      ownerId: 'owner',
      now: () => NOW,
      timezone: 'UTC',
      agentId: 'mail',
    };
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
  });

  /** The owner's mailbox, its inbox and its sent folder. */
  async function mailbox(opts: { synced?: boolean } = {}): Promise<void> {
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
    // What the source does at the end of a pass that got all the way through.
    if (opts.synced !== false) await markAccountSynced(pool, accountId, SYNCED);
  }

  /** A second mailbox, with its own inbox, which a test may disable. */
  async function secondMailbox(opts: { enabled: boolean; synced?: boolean }): Promise<{
    accountId: string;
    folderId: string;
  }> {
    const { rows } = await pool.query(
      `insert into email.accounts (address, imap_host, imap_port, smtp_host, smtp_port,
                                   auth_mode, secret_name, enabled, added_via)
       values ('owner@work.test', 'imap.test', 993, 'smtp.test', 465, 'app-password', 'EMAIL_WORK', $1, 'page')
       returning id`,
      [opts.enabled],
    );
    const id = String(rows[0].id);
    const inbox = await pool.query(
      `insert into email.folders (account_id, name, kind, synced)
       values ($1, 'INBOX', 'inbox', true) returning id`,
      [id],
    );
    if (opts.synced !== false) await markAccountSynced(pool, id, SYNCED);
    return { accountId: id, folderId: String(inbox.rows[0].id) };
  }

  /** One message, threaded the way ingest threads it. */
  async function write(over: {
    uid: number;
    from: string;
    to: string;
    subject: string;
    threadKey: string;
    at: Date;
    direction?: 'in' | 'out';
    accountId?: string;
    folderId?: string;
  }): Promise<void> {
    const direction = over.direction ?? 'in';
    const account = over.accountId ?? accountId;
    const folder = over.folderId ?? (direction === 'out' ? sentFolderId : folderId);
    const { rows } = await pool.query(
      `insert into email.messages
         (account_id, folder_id, uidvalidity, uid, message_id, thread_key, from_addr, to_addrs,
          subject, date, internal_date, fetched_at, snippet, body_text, direction)
       values ($1, $2, 1, $3, $4, $5, $6, $7::jsonb, $8, $9, $9, $9, '', 'Could you confirm?', $10)
       returning id`,
      [
        account,
        folder,
        over.uid,
        `<m${over.uid}@example.test>`,
        over.threadKey,
        over.from,
        JSON.stringify([over.to]),
        over.subject,
        over.at,
        direction,
      ],
    );
    await joinThread(pool, {
      accountId: account,
      threadKey: over.threadKey,
      messageRowId: String(rows[0].id),
      subject: over.subject,
      participants: [over.from, over.to],
      at: over.at,
      folderId: folder,
      uidValidity: 1,
      uid: over.uid,
      direction,
    });
  }

  /**
   * A conversation waiting three days on the owner, in the mailbox given: his
   * own older reply to that sender, then their unanswered message.
   */
  async function waitingThread(
    opts: { uid: number; from: string; account?: { accountId: string; folderId: string } } ,
  ): Promise<void> {
    const where = opts.account
      ? { accountId: opts.account.accountId, folderId: opts.account.folderId }
      : {};
    await write({
      uid: opts.uid + 1000,
      from: 'owner@example.test',
      to: opts.from,
      subject: 'An older matter',
      threadKey: `<old-${opts.uid}@x.test>`,
      at: daysBefore(40),
      direction: 'out',
      ...(opts.account ? { accountId: opts.account.accountId, folderId: opts.account.folderId } : {}),
    });
    await write({
      uid: opts.uid,
      from: opts.from,
      to: 'owner@example.test',
      subject: 'The lease',
      threadKey: `<lease-${opts.uid}@x.test>`,
      at: daysBefore(3),
      ...where,
    });
  }

  it('is not measurable before there is a mailbox', async () => {
    expect(await measure('email.waiting_on_me')).toMatchObject({
      ok: false,
      reason: 'not-measurable',
    });
  });

  it('is not measurable while a mailbox in scope has never finished a poll', async () => {
    await mailbox({ synced: false });
    await waitingThread({ uid: 2, from: 'agent@letting.test' });
    expect(await measure('email.waiting_on_me')).toMatchObject({
      ok: false,
      reason: 'not-measurable',
    });
  });

  it('answers zero for a mailbox that synced and found nothing waiting', async () => {
    await mailbox();
    const reading = await measure('email.waiting_on_me');
    expect(reading).toMatchObject({ ok: true });
    expect(reading.ok && reading.reading.value).toBe(0);
    expect(reading.ok && reading.reading.asOf.toISOString()).toBe(SYNCED.toISOString());
  });

  it('counts what is waiting, under the read-only transaction, as of the last sync', async () => {
    await mailbox();
    await waitingThread({ uid: 2, from: 'agent@letting.test' });
    // A stranger the owner has never written to is not somebody he kept waiting.
    await write({
      uid: 5,
      from: 'newsletter@shop.test',
      to: 'owner@example.test',
      subject: 'This week',
      threadKey: '<shop@shop.test>',
      at: daysBefore(4),
    });

    const waiting = await measure('email.waiting_on_me');
    expect(waiting.ok && waiting.reading.value).toBe(1);
    expect(waiting.ok && waiting.reading.asOf.toISOString()).toBe(SYNCED.toISOString());
  });

  it('counts nothing in a mailbox that is switched off — the watcher does not either', async () => {
    await mailbox();
    const off = await secondMailbox({ enabled: false });
    await waitingThread({ uid: 7, from: 'landlord@work.test', account: off });
    expect((await measure('email.waiting_on_me')).ok && true).toBe(true);
    const waiting = await measure('email.waiting_on_me');
    expect(waiting.ok && waiting.reading.value).toBe(0);
  });

  it('is as fresh as the stalest mailbox in scope', async () => {
    await mailbox();
    const second = await secondMailbox({ enabled: true });
    const older = new Date('2026-09-19T08:00:00Z');
    await markAccountSynced(pool, second.accountId, older);
    const waiting = await measure('email.waiting_on_me');
    expect(waiting.ok && waiting.reading.asOf.toISOString()).toBe(older.toISOString());
    // ...and unknown wins over stale: a mailbox nobody has read makes the
    // whole count a number about only part of the mail.
    await pool.query(`update email.accounts set last_synced_at = null where id = $1`, [
      second.accountId,
    ]);
    expect(await measure('email.waiting_on_me')).toMatchObject({
      ok: false,
      reason: 'not-measurable',
    });
  });

  it('refuses a narrowing nobody declared', async () => {
    await mailbox();
    expect(await measure('email.waiting_on_me', { account: 'owner@example.test' })).toMatchObject({
      ok: false,
      reason: 'invalid-params',
    });
  });
});
