/**
 * Both mail metrics, measured the way core measures one: over postgres,
 * through `measureMetricResult`, which hands `measure` a context whose `db` is
 * the read-only pool — `begin isolation level repeatable read read only`, one
 * statement, `rollback`.
 *
 * The unit tests fake the rows; what only a database can settle is that these
 * statements survive that transaction at all. `email.waiting_on_me` runs the
 * watcher's own common-table expression, which is the longest read in this
 * plugin: if the read-only wrapper's pre-filter or Postgres itself refuses it,
 * it must be here and now, not six weeks into somebody's goal on a sentinel
 * tick nobody is watching.
 *
 * It never touches the developer's data: its own database, core's migrations
 * and this plugin's, dropped at the end. No socket is opened to any mailbox.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ToolRegistry, createPool, measureMetricResult, runMigrations } from '@buddi/core';
import type { ToolContext } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { ensureGmailAccount, GMAIL_SECRET_NAME } from './config.js';
import { manifest } from './index.js';
import { joinThread } from './threads.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_email_metrics_test_${process.pid}`;
const ENV = { GMAIL_USER: 'owner@example.test', [GMAIL_SECRET_NAME]: 'app-password' };
/** A Monday, noon UTC. Every age below is measured from it. */
const NOW = new Date('2026-09-21T12:00:00Z');

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

  /** The mailbox, its inbox and its sent folder. */
  async function mailbox(): Promise<void> {
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
    seen?: boolean;
    fetchedAt?: Date;
  }): Promise<void> {
    const direction = over.direction ?? 'in';
    const { rows } = await pool.query(
      `insert into email.messages
         (account_id, folder_id, uidvalidity, uid, message_id, thread_key, from_addr, to_addrs,
          subject, date, internal_date, fetched_at, snippet, body_text, direction, flags)
       values ($1, $2, 1, $3, $4, $5, $6, $7::jsonb, $8, $9, $9, $10, '', 'Could you confirm?', $11, $12::jsonb)
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
        over.fetchedAt ?? over.at,
        direction,
        JSON.stringify(over.seen ? ['\\Seen'] : []),
      ],
    );
    await joinThread(pool, {
      accountId,
      threadKey: over.threadKey,
      messageRowId: String(rows[0].id),
      subject: over.subject,
      participants: [over.from, over.to],
      at: over.at,
      folderId: direction === 'out' ? sentFolderId : folderId,
      uidValidity: 1,
      uid: over.uid,
      direction,
    });
  }

  it('is not measurable before there is a mailbox', async () => {
    expect(await measure('email.inbox_unread')).toMatchObject({
      ok: false,
      reason: 'not-measurable',
    });
    expect(await measure('email.waiting_on_me')).toMatchObject({
      ok: false,
      reason: 'not-measurable',
    });
  });

  it('counts unread inbound mail and what is waiting, under the read-only transaction', async () => {
    await mailbox();
    // The owner wrote to this sender before, which is what makes a wait a wait.
    await write({
      uid: 1,
      from: 'owner@example.test',
      to: 'agent@letting.test',
      subject: 'An older matter',
      threadKey: '<old@letting.test>',
      at: daysBefore(40),
      direction: 'out',
    });
    // Waiting three days, and unread.
    await write({
      uid: 2,
      from: 'agent@letting.test',
      to: 'owner@example.test',
      subject: 'The lease',
      threadKey: '<lease@letting.test>',
      at: daysBefore(3),
      fetchedAt: daysBefore(0.25),
    });
    // Unread, but too recent to be a wait.
    await write({
      uid: 3,
      from: 'newsletter@shop.test',
      to: 'owner@example.test',
      subject: 'This week',
      threadKey: '<shop@shop.test>',
      at: daysBefore(0.5),
      fetchedAt: daysBefore(0.25),
    });
    // Read, so it is not unread mail — and the owner's own message never is.
    await write({
      uid: 4,
      from: 'bank@bank.test',
      to: 'owner@example.test',
      subject: 'Statement',
      threadKey: '<bank@bank.test>',
      at: daysBefore(1),
      seen: true,
    });

    const unread = await measure('email.inbox_unread');
    expect(unread).toMatchObject({ ok: true });
    expect(unread.ok && unread.reading.value).toBe(2);
    // The last sync, not now: `fetched_at`, which the ingest writes.
    expect(unread.ok && unread.reading.asOf.toISOString()).toBe(daysBefore(0.25).toISOString());

    const waiting = await measure('email.waiting_on_me');
    expect(waiting.ok && waiting.reading.value).toBe(1);

    const narrowed = await measure('email.inbox_unread', { account: 'owner@example.test' });
    expect(narrowed.ok && narrowed.reading).toMatchObject({ value: 2, note: 'owner@example.test' });
  });

  it('keeps the plugin\'s own sentence as the note when a mailbox is named that is not here', async () => {
    await mailbox();
    const missing = await measure('email.inbox_unread', { account: 'someone@else.test' });
    expect(missing).toMatchObject({ ok: false, reason: 'threw' });
    expect(!missing.ok && missing.note).toContain('someone@else.test');
  });

  it('refuses a narrowing nobody declared', async () => {
    await mailbox();
    expect(await measure('email.waiting_on_me', { account: 'owner@example.test' })).toMatchObject({
      ok: false,
      reason: 'invalid-params',
    });
    expect(await measure('email.inbox_unread', { unreadOnly: true })).toMatchObject({
      ok: false,
      reason: 'invalid-params',
    });
  });
});
