/**
 * Mail retention over a throwaway database.
 *
 * Skipped unless DATABASE_URL is set. It creates its own database, migrates
 * core plus this plugin into it, and drops it at the end — a purge test must
 * never be pointed at a real mailbox.
 *
 * What is asserted is exactly what the policy promises: only bodies past the
 * threshold go, the batch bounds one statement, headers and triage survive,
 * and a second pass is a no-op.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, runMigrations } from '@buddi/core';
import { ensureGmailAccount, GMAIL_SECRET_NAME } from '../config.js';
import { manifest } from '../index.js';
import {
  DEFAULT_RETENTION_DAYS,
  loadSettings,
  purgeBodies,
  purgeLogLine,
  setRetentionDays,
} from '../retention.js';
import type { SourceContext } from '../types.js';
import { createRetentionSource, RETENTION_EVERY_SECONDS, RETENTION_SOURCE_ID } from './retention.js';

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_email_retention_test_${process.pid}`;
const ENV = { GMAIL_USER: 'owner@example.test', [GMAIL_SECRET_NAME]: 'app-password' };
const NOW = new Date('2026-09-13T12:00:00Z');

suite('email.retention (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let accountId: string;
  let mailboxId: string;

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

  /** `n` messages, the i-th dated `ageDays[i]` days before NOW. */
  async function seed(ageDays: number[]): Promise<string[]> {
    await pool.query('truncate email.triage, email.messages, email.mailboxes, email.accounts cascade');
    await pool.query('delete from email.settings');
    const account = await ensureGmailAccount(pool, ENV);
    accountId = String(account?.id);
    const { rows } = await pool.query(
      `insert into email.mailboxes (account_id, name, uidvalidity, last_uid)
       values ($1, 'INBOX', 1, 0) returning id`,
      [accountId],
    );
    mailboxId = String(rows[0].id);

    const ids: string[] = [];
    for (const [i, age] of ageDays.entries()) {
      const date = new Date(NOW.getTime() - age * 86_400_000);
      const { rows: inserted } = await pool.query(
        `insert into email.messages
           (account_id, mailbox_id, uidvalidity, uid, message_id, from_addr, to_addrs, subject,
            date, snippet, body_text, has_attachments, attachments, flags)
         values ($1, $2, 1, $3, $4, 'sender@bank.test', '["owner@example.test"]'::jsonb, $5,
                 $6, $7, $8, false, '[]'::jsonb, '[]'::jsonb)
         returning id`,
        [
          accountId,
          mailboxId,
          i + 1,
          `<m${i}@bank.test>`,
          `Message ${i}`,
          date,
          `snippet ${i}`,
          `body ${i} — the whole text of the message`,
        ],
      );
      ids.push(String(inserted[0].id));
    }
    return ids;
  }

  const purgedCount = async (): Promise<number> => {
    const { rows } = await pool.query(
      `select count(*)::int as n from email.messages where body_purged_at is not null`,
    );
    return Number(rows[0].n);
  };

  beforeEach(async () => {
    await seed([200, 91, 90, 89, 1]);
  });

  it('purges only bodies past the threshold, and keeps headers, snippet and triage', async () => {
    const ids = await seed([200, 91, 1]);
    await pool.query(
      `insert into email.triage (message_id, processing_version, category, urgency, summary, action_needed)
       values ($1, 1, 'bank-notice', 'normal', 'An old notice.', null)`,
      [ids[0]],
    );

    const outcome = await purgeBodies(pool, NOW);
    expect(outcome.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(outcome.purged).toBe(2);

    const { rows } = await pool.query(
      `select id::text, subject, snippet, from_addr, body_text, body_purged_at
         from email.messages order by uid`,
    );
    // The two old ones: body gone, everything else intact.
    expect(rows[0].body_text).toBeNull();
    expect(rows[0].body_purged_at).toBeInstanceOf(Date);
    expect(rows[0].subject).toBe('Message 0');
    expect(rows[0].snippet).toBe('snippet 0');
    expect(rows[0].from_addr).toBe('sender@bank.test');
    expect(rows[1].body_text).toBeNull();
    // The recent one is untouched.
    expect(rows[2].body_text).toContain('the whole text');
    expect(rows[2].body_purged_at).toBeNull();

    // The triage decision outlives the body it was made from.
    const { rows: triage } = await pool.query(
      `select category, summary from email.triage where message_id = $1`,
      [ids[0]],
    );
    expect(triage[0]).toMatchObject({ category: 'bank-notice', summary: 'An old notice.' });
  });

  it('respects the boundary exactly: 90 days old stays, 91 goes', async () => {
    await purgeBodies(pool, NOW);
    const { rows } = await pool.query(
      `select uid, body_text is null as purged from email.messages order by uid`,
    );
    // Seeded ages: 200, 91, 90, 89, 1.
    expect(rows.map((r: any) => r.purged)).toEqual([true, true, false, false, false]);
  });

  it('purges in batches, and the pass drains the backlog', async () => {
    const one = await purgeBodies(pool, NOW, { batchSize: 1 });
    // Two rows are past the window; a batch of one takes three statements —
    // two that purge a row, and one that finds nothing left.
    expect(one.purged).toBe(2);
    expect(one.batches).toBe(3);
    expect(await purgedCount()).toBe(2);
  });

  it('is idempotent: a second pass purges nothing and rewrites nothing', async () => {
    const first = await purgeBodies(pool, NOW);
    expect(first.purged).toBe(2);
    const { rows: before } = await pool.query(
      `select body_purged_at from email.messages where body_purged_at is not null order by uid`,
    );

    // The same instant: nothing has aged past the window in between, so a
    // second pass must find nothing at all rather than re-stamping rows.
    const second = await purgeBodies(pool, NOW);
    expect(second.purged).toBe(0);

    const { rows: after } = await pool.query(
      `select body_purged_at from email.messages where body_purged_at is not null order by uid`,
    );
    expect(after.map((r: any) => r.body_purged_at.toISOString())).toEqual(
      before.map((r: any) => r.body_purged_at.toISOString()),
    );
  });

  it("follows the owner's setting rather than the default", async () => {
    await setRetentionDays(pool, 365, NOW);
    expect(await purgeBodies(pool, NOW)).toMatchObject({ purged: 0, retentionDays: 365 });

    await setRetentionDays(pool, 30, NOW);
    const outcome = await purgeBodies(pool, NOW);
    expect(outcome.retentionDays).toBe(30);
    // 200, 91, 90 and 89 days old are all past a 30-day window; 1 is not.
    expect(outcome.purged).toBe(4);
    expect((await loadSettings(pool)).retentionDays).toBe(30);
  });

  it('runs as a daily source that logs the count and enqueues nothing', async () => {
    const source = createRetentionSource();
    expect(source.id).toBe(RETENTION_SOURCE_ID);
    expect(source.every).toBe(RETENTION_EVERY_SECONDS);
    expect(source.every).toBe(86_400);

    const lines: string[] = [];
    let enqueued = 0;
    const ctx: SourceContext = {
      db: pool,
      now: () => NOW,
      timezone: 'UTC',
      log: (line) => lines.push(line),
      enqueueRun: async () => {
        enqueued += 1;
      },
    };
    await source.poll(ctx);

    expect(enqueued).toBe(0);
    expect(lines).toEqual(['email.retention: purged 2 bodies older than 90 days']);
    expect(await purgedCount()).toBe(2);

    // A second daily pass says so honestly rather than re-purging.
    await source.poll(ctx);
    expect(lines[1]).toBe('email.retention: purged 0 bodies older than 90 days');
  });

  it('renders the log line from the outcome', () => {
    expect(
      purgeLogLine({ purged: 7, retentionDays: 30, cutoff: NOW, batches: 1 }),
    ).toBe('email.retention: purged 7 bodies older than 30 days');
  });
});
