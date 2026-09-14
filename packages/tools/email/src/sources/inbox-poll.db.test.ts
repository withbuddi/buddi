/**
 * The source contract, against a fake IMAP server and a throwaway database.
 *
 * Skipped unless DATABASE_URL is set. It never touches the developer's data:
 * the suite creates its own database, migrates core plus this plugin into it,
 * and drops it at the end. No socket is opened to any mailbox.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, runMigrations } from '@buddi/core';
import { ensureGmailAccount, GMAIL_SECRET_NAME } from '../config.js';
import { FakeImapServer, fakeMessage } from '../imap/fake.js';
import { manifest } from '../index.js';
import type { SourceContext } from '../types.js';
import { createInboxPollSource, MAX_PER_POLL, triageDedupKey } from './inbox-poll.js';

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_email_src_test_${process.pid}`;

const ENV = { GMAIL_USER: 'owner@example.test', [GMAIL_SECRET_NAME]: 'app-password' };

suite('email.inbox-poll (postgres + fake imap)', () => {
  let admin: Pool;
  let pool: Pool;
  let accountId: string;

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
    await pool.query('truncate email.drafts, email.triage, email.messages, email.mailboxes, email.accounts cascade');
    const account = await ensureGmailAccount(pool, ENV);
    accountId = account!.id;
  });

  /** A source context whose enqueued runs are collected rather than queued. */
  function contextFor(): SourceContext & { runs: Array<{ agentId: string; prompt: string; dedupKey: string }> } {
    const runs: Array<{ agentId: string; prompt: string; dedupKey: string }> = [];
    return {
      db: pool,
      now: () => new Date('2026-09-13T12:00:00Z'),
      timezone: 'UTC',
      runs,
      log: () => {},
      async enqueueRun(input) {
        runs.push({ agentId: input.agentId, prompt: input.prompt, dedupKey: input.dedupKey });
      },
    };
  }

  async function mailbox(): Promise<{ uidvalidity: number | null; last_uid: number }> {
    const { rows } = await pool.query(
      `select uidvalidity, last_uid from email.mailboxes where account_id = $1`,
      [accountId],
    );
    return {
      uidvalidity: rows[0].uidvalidity === null ? null : Number(rows[0].uidvalidity),
      last_uid: Number(rows[0].last_uid),
    };
  }

  async function messageCount(): Promise<number> {
    const { rows } = await pool.query(`select count(*)::int as n from email.messages`);
    return rows[0].n;
  }

  it('ingests new mail, advances the cursor, and starts one triage run per message', async () => {
    const server = new FakeImapServer();
    server.add('INBOX', fakeMessage({ subject: 'Rent due', messageId: '<a@x>' }));
    server.add('INBOX', fakeMessage({ subject: 'Payment failed', messageId: '<b@x>' }));
    const source = createInboxPollSource({ connect: server.factory(), env: ENV });

    const ctx = contextFor();
    await source.poll(ctx);

    expect(await messageCount()).toBe(2);
    expect(await mailbox()).toEqual({ uidvalidity: 1, last_uid: 2 });

    const { rows } = await pool.query(`select id from email.messages order by uid`);
    expect(ctx.runs).toHaveLength(2);
    expect(ctx.runs.map((r) => r.dedupKey)).toEqual(rows.map((r: any) => triageDedupKey(String(r.id))));
    expect(new Set(ctx.runs.map((r) => r.agentId))).toEqual(new Set(['mail-triage']));
    // The prompt is a structured summary, not the raw message.
    expect(ctx.runs[0]!.prompt).toContain('Subject: Rent due');
    expect(ctx.runs[0]!.prompt).toContain('Message id (for the tools):');
  });

  it('is a no-op on the second poll, and picks up only what is new', async () => {
    const server = new FakeImapServer();
    server.add('INBOX', fakeMessage({ messageId: '<a@x>' }));
    const source = createInboxPollSource({ connect: server.factory(), env: ENV });

    await source.poll(contextFor());
    const second = contextFor();
    await source.poll(second);

    expect(await messageCount()).toBe(1);
    expect(second.runs).toHaveLength(0);
    expect(server.fetches.at(-1)).toMatchObject({ sinceUid: 1 });

    server.add('INBOX', fakeMessage({ messageId: '<b@x>' }));
    const third = contextFor();
    await source.poll(third);
    expect(await messageCount()).toBe(2);
    expect(third.runs).toHaveLength(1);
  });

  it('never mutates flags: the fetch is a peek', async () => {
    const server = new FakeImapServer();
    server.add('INBOX', fakeMessage({ flags: [], messageId: '<a@x>' }));
    server.add('INBOX', fakeMessage({ flags: ['\\Seen'], messageId: '<b@x>' }));
    const source = createInboxPollSource({ connect: server.factory(), env: ENV });

    await source.poll(contextFor());

    expect(server.mailbox('INBOX').messages.map((m) => m.flags)).toEqual([[], ['\\Seen']]);
    const { rows } = await pool.query(`select flags from email.messages order by uid`);
    expect(rows.map((r: any) => r.flags)).toEqual([[], ['\\Seen']]);
  });

  it('caps a backlog at 50 per poll and drains it over several polls', async () => {
    const server = new FakeImapServer();
    for (let i = 1; i <= 60; i++) {
      server.add('INBOX', fakeMessage({ subject: `msg ${i}`, messageId: `<m${i}@x>` }));
    }
    const source = createInboxPollSource({ connect: server.factory(), env: ENV });

    const first = contextFor();
    await source.poll(first);
    expect(await messageCount()).toBe(MAX_PER_POLL);
    expect(first.runs).toHaveLength(MAX_PER_POLL);
    expect(await mailbox()).toEqual({ uidvalidity: 1, last_uid: 50 });

    const second = contextFor();
    await source.poll(second);
    expect(await messageCount()).toBe(60);
    expect(second.runs).toHaveLength(10);
    expect(await mailbox()).toEqual({ uidvalidity: 1, last_uid: 60 });
  });

  it('re-syncs from zero when UIDVALIDITY changes', async () => {
    const server = new FakeImapServer();
    server.add('INBOX', fakeMessage({ messageId: '<a@x>' }));
    server.add('INBOX', fakeMessage({ messageId: '<b@x>' }));
    const source = createInboxPollSource({ connect: server.factory(), env: ENV });

    await source.poll(contextFor());
    expect(await mailbox()).toEqual({ uidvalidity: 1, last_uid: 2 });

    // The mailbox was recreated upstream: same uids, a new generation.
    server.resetUidValidity('INBOX', 77);
    const logged: string[] = [];
    const ctx = contextFor();
    ctx.log = (line) => logged.push(line);
    await source.poll(ctx);

    expect(logged.join('\n')).toContain('UIDVALIDITY changed');
    expect(await mailbox()).toEqual({ uidvalidity: 77, last_uid: 2 });
    // The quad is the identity, so the same uids under a new generation are new
    // rows rather than a conflict — and they are triaged again, as they must be.
    expect(await messageCount()).toBe(4);
    expect(ctx.runs).toHaveLength(2);
  });

  it('commits rows and the cursor together: a failed batch leaves neither', async () => {
    const server = new FakeImapServer();
    server.add('INBOX', fakeMessage({ messageId: '<a@x>' }));
    // A message the schema refuses (from_addr is NOT NULL). The insert throws
    // mid-batch, so the transaction rolls back the good row with it.
    server.add('INBOX', fakeMessage({ messageId: '<b@x>', from: null as unknown as string }));
    const source = createInboxPollSource({ connect: server.factory(), env: ENV });

    await expect(source.poll(contextFor())).rejects.toThrow();
    expect(await messageCount()).toBe(0);
    // Not even the generation was recorded: the whole batch rolled back.
    expect(await mailbox()).toEqual({ uidvalidity: null, last_uid: 0 });
  });

  it('re-enqueues a message whose triage run was never created', async () => {
    const server = new FakeImapServer();
    server.add('INBOX', fakeMessage({ messageId: '<a@x>' }));
    const source = createInboxPollSource({ connect: server.factory(), env: ENV });

    const failing = contextFor();
    failing.enqueueRun = async () => {
      throw new Error('queue is down');
    };
    await expect(source.poll(failing)).rejects.toThrow('queue is down');
    // The mail is durable; only the run is missing.
    expect(await messageCount()).toBe(1);

    const retry = contextFor();
    await source.poll(retry);
    expect(retry.runs).toHaveLength(1);
    const { rows } = await pool.query(`select triage_enqueued_at from email.messages`);
    expect(rows[0].triage_enqueued_at).not.toBeNull();

    // And once stamped, it is never enqueued a third time.
    const again = contextFor();
    await source.poll(again);
    expect(again.runs).toHaveLength(0);
  });

  it('does nothing when no account is configured, and says so when the secret is missing', async () => {
    await pool.query('truncate email.accounts cascade');
    const server = new FakeImapServer();
    server.add('INBOX', fakeMessage({ messageId: '<a@x>' }));
    const source = createInboxPollSource({ connect: server.factory(), env: ENV });
    await source.poll(contextFor());
    expect(server.opens).toBe(0);

    await ensureGmailAccount(pool, ENV);
    const logged: string[] = [];
    const noSecret = createInboxPollSource({
      connect: server.factory(),
      env: { GMAIL_USER: 'owner@example.test' },
    });
    const ctx = contextFor();
    ctx.log = (line) => logged.push(line);
    await noSecret.poll(ctx);
    expect(logged.join('\n')).toContain('secret-missing');
    expect(await messageCount()).toBe(0);
  });
});
