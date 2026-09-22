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
import {
  createInboxPollSource,
  ImapTimeoutError,
  MAX_PER_POLL,
  triageDedupKey,
} from './inbox-poll.js';
import { testDatabaseUrl } from '@buddi/core/testing';

/**
 * A backfill large enough to reach UID 1, i.e. "sync the whole mailbox".
 *
 * The default is 0 — a first contact plants the cursor at UIDNEXT-1 and fetches
 * nothing — so every test about *ingest* has to say, explicitly, that it wants
 * history. That is the point: starting from now is the policy, and reading a
 * mailbox from the beginning is the opt-in.
 */
const FULL_SYNC = 10_000;

const databaseUrl = await testDatabaseUrl();
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
    await pool.query('truncate email.drafts, email.triage, email.messages, email.folders, email.accounts cascade');
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
      `select uidvalidity, last_uid from email.folders where account_id = $1`,
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
    const source = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC });

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
    const source = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC });

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
    const source = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC });

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
    const source = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC });

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

  it('re-syncs from zero when UIDVALIDITY changes and a full backfill is asked for', async () => {
    const server = new FakeImapServer();
    server.add('INBOX', fakeMessage({ messageId: '<a@x>' }));
    server.add('INBOX', fakeMessage({ messageId: '<b@x>' }));
    const source = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC });

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
    const source = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC });

    await expect(source.poll(contextFor())).rejects.toThrow();
    expect(await messageCount()).toBe(0);
    // The batch rolled back entirely, so the cursor did not move. The
    // generation *is* recorded: it was persisted on first contact, before any
    // fetch, and it is a fact about the mailbox rather than about this batch.
    expect(await mailbox()).toEqual({ uidvalidity: 1, last_uid: 0 });
  });

  it('starts at now on first contact: the cursor is UIDNEXT-1 and nothing is fetched', async () => {
    const server = new FakeImapServer();
    // A mailbox with history. None of it is ours to read.
    for (let i = 1; i <= 500; i++) {
      server.add('INBOX', fakeMessage({ subject: `old ${i}`, messageId: `<o${i}@x>` }));
    }
    const source = createInboxPollSource({ connect: server.factory(), env: ENV });

    const logged: string[] = [];
    const ctx = contextFor();
    ctx.log = (line) => logged.push(line);
    await source.poll(ctx);

    // UIDNEXT is 501, so the cursor is 500 and the history stays where it is.
    expect(await mailbox()).toEqual({ uidvalidity: 1, last_uid: 500 });
    expect(await messageCount()).toBe(0);
    expect(ctx.runs).toHaveLength(0);
    // Not a small fetch — *no* fetch. A first contact must not touch history.
    expect(server.fetches).toHaveLength(0);
    expect(logged.join('\n')).toContain('no history fetched');

    // And mail that arrives after the cursor was planted is new mail.
    server.add('INBOX', fakeMessage({ subject: 'arrived after', messageId: '<new@x>' }));
    const second = contextFor();
    await source.poll(second);
    expect(await messageCount()).toBe(1);
    expect(second.runs).toHaveLength(1);
    expect(await mailbox()).toEqual({ uidvalidity: 1, last_uid: 501 });
  });

  it('reads EMAIL_BACKFILL, and brings along exactly the newest N', async () => {
    const server = new FakeImapServer();
    for (let i = 1; i <= 500; i++) {
      server.add('INBOX', fakeMessage({ subject: `old ${i}`, messageId: `<o${i}@x>` }));
    }
    const source = createInboxPollSource({
      connect: server.factory(),
      env: { ...ENV, EMAIL_BACKFILL: '20' },
    });

    await source.poll(contextFor());

    expect(await messageCount()).toBe(20);
    expect(await mailbox()).toEqual({ uidvalidity: 1, last_uid: 500 });
    // The *newest* twenty, not the oldest: 481..500.
    const { rows } = await pool.query(`select subject from email.messages order by uid asc`);
    expect(rows[0].subject).toBe('old 481');
    expect(rows.at(-1).subject).toBe('old 500');
    expect(server.fetches[0]).toMatchObject({ sinceUid: 480 });
  });

  it('re-plants the cursor rather than re-reading history when UIDVALIDITY changes', async () => {
    const server = new FakeImapServer();
    for (let i = 1; i <= 100; i++) {
      server.add('INBOX', fakeMessage({ messageId: `<m${i}@x>` }));
    }
    const source = createInboxPollSource({ connect: server.factory(), env: ENV });
    await source.poll(contextFor());
    expect(await mailbox()).toEqual({ uidvalidity: 1, last_uid: 100 });

    server.resetUidValidity('INBOX', 77);
    const logged: string[] = [];
    const ctx = contextFor();
    ctx.log = (line) => logged.push(line);
    await source.poll(ctx);

    expect(logged.join('\n')).toContain('UIDVALIDITY changed');
    // A new generation is a new mailbox: start from now, not from message one.
    expect(await mailbox()).toEqual({ uidvalidity: 77, last_uid: 100 });
    expect(await messageCount()).toBe(0);
    expect(server.fetches).toHaveLength(0);
  });

  it('gives up on a hung IMAP call, records the error, and closes the connection', async () => {
    const server = new FakeImapServer();
    server.add('INBOX', fakeMessage({ messageId: '<a@x>' }));
    let closed = 0;
    // A server that accepts the connection and then never answers the SELECT —
    // the exact failure that used to hang the whole scheduler tick.
    const connect = async () => {
      const real = server.client();
      return {
        listMailboxes: real.listMailboxes.bind(real),
        open: () => new Promise<never>(() => {}),
        fetchSince: real.fetchSince.bind(real),
        close: async () => {
          closed += 1;
          await real.close();
        },
      };
    };

    const source = createInboxPollSource({ connect, env: ENV, timeoutMs: 25, backfill: FULL_SYNC });
    const logged: string[] = [];
    const ctx = contextFor();
    ctx.log = (line) => logged.push(line);

    await expect(source.poll(ctx)).rejects.toBeInstanceOf(ImapTimeoutError);
    expect(logged.join('\n')).toContain('imap select timed out after 25ms');
    // The connection is closed on the way out, every time.
    expect(closed).toBe(1);
    // Nothing was half-written: the next poll starts exactly where this did.
    expect(await mailbox()).toEqual({ uidvalidity: null, last_uid: 0 });
    expect(await messageCount()).toBe(0);
  });

  it('closes a connection that arrives after the connect deadline', async () => {
    const server = new FakeImapServer();
    let closed = 0;
    const connect = async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const real = server.client();
      return {
        listMailboxes: real.listMailboxes.bind(real),
        open: real.open.bind(real),
        fetchSince: real.fetchSince.bind(real),
        close: async () => {
          closed += 1;
          await real.close();
        },
      };
    };
    const source = createInboxPollSource({ connect, env: ENV, timeoutMs: 10 });
    await expect(source.poll(contextFor())).rejects.toBeInstanceOf(ImapTimeoutError);
    // The socket we stopped waiting for is not leaked. Waited for rather than
    // slept past: the connection this is about lands 40ms from now on an idle
    // machine and whenever the scheduler gets to it on a loaded one, and a
    // fixed sleep turns the second case into a failure that is not a bug.
    for (let i = 0; closed === 0 && i < 400; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(closed).toBe(1);
  });

  it('re-enqueues a message whose triage run was never created', async () => {
    const server = new FakeImapServer();
    server.add('INBOX', fakeMessage({ messageId: '<a@x>' }));
    const source = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC });

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
    const source = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC });
    await source.poll(contextFor());
    expect(server.opens).toBe(0);

    await ensureGmailAccount(pool, ENV);
    const logged: string[] = [];
    const noSecret = createInboxPollSource({
      connect: server.factory(),
      env: { GMAIL_USER: 'owner@example.test' },
      backfill: FULL_SYNC,
    });
    const ctx = contextFor();
    ctx.log = (line) => logged.push(line);
    await noSecret.poll(ctx);
    expect(logged.join('\n')).toContain('secret-missing');
    expect(await messageCount()).toBe(0);
  });
});
