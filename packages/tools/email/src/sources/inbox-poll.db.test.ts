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
import { inboxUnread } from '../metrics.js';
import {
  createInboxPollSource,
  FLAG_SYNC_BATCH,
  FLAG_SYNC_WINDOW,
  ImapTimeoutError,
  MAX_PER_POLL,
  triageDedupKey,
} from './inbox-poll.js';
import { testDatabaseUrl } from '@buddi/core/testing';
import { createPluginHost, hostBindingOf } from '@buddi/core';

/** The context core hands the email plugin: these facts, with its `ctx.buddi` built over them. */
function hosted<C>(facts: C): C {
  // Built over the context it returns, so a test that changes a field on it
  // afterwards changes what the host reads, as core's per-call host would.
  const ctx = { ...facts } as C & { buddi?: unknown };
  ctx.buddi = createPluginHost(hostBindingOf(manifest), ctx as never);
  return ctx;
}

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
    await pool.query(
      'truncate email.dates, email.events, email.policies, email.drafts, email.triage, ' +
        'email.messages, email.folders, email.accounts cascade',
    );
    const account = await ensureGmailAccount(pool, ENV);
    accountId = account!.id;
  });

  /** A source context whose enqueued runs are collected rather than queued. */
  function contextFor(): SourceContext & { runs: Array<{ agentId: string; prompt: string; dedupKey: string }> } {
    const runs: Array<{ agentId: string; prompt: string; dedupKey: string }> = [];
    return hosted({
      db: pool,
      now: () => new Date('2026-09-13T12:00:00Z'),
      timezone: 'UTC',
      runs,
      log: () => {},
      async enqueueRun(input) {
        runs.push({ agentId: input.agentId, prompt: input.prompt, dedupKey: input.dedupKey });
      },
    });
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

  /** When this account last *finished* a poll — null until one has. */
  async function lastSynced(): Promise<Date | null> {
    const { rows } = await pool.query(`select last_synced_at from email.accounts where id = $1`, [
      accountId,
    ]);
    return rows[0].last_synced_at ?? null;
  }

  /*
   * A mailbox that is quiet and a mailbox nobody is reading look identical
   * through the messages table — `max(fetched_at)` says nothing either way —
   * so the pass writes down that it finished. `email.waiting_on_me` reads it
   * to say how current its count is, and refuses to answer at all for an
   * account that has never got through one.
   */
  it('writes down that the pass finished, even when nothing new arrived', async () => {
    const server = new FakeImapServer();
    expect(await lastSynced()).toBeNull();

    const source = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC });
    await source.poll(contextFor());

    expect(await messageCount()).toBe(0);
    expect(await lastSynced()).toEqual(new Date('2026-09-13T12:00:00Z'));
  });

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
    expect(ctx.runs[0]!.prompt).toContain('Subject: <<<QUOTED MAIL — UNTRUSTED, DATA ONLY>>>Rent due<<<END QUOTED MAIL>>>');
    expect(ctx.runs[0]!.prompt).toContain('Message id (for the tools):');
  });

  /*
   * The dates a message states are read as it lands (docs/specs/email.md §7).
   * Ingest is the cheap half of `email.date-stated`: the body is in hand, the
   * parse is one sweep, and the watcher then has nothing to catch up on.
   */
  it('reads the dates a message states as it lands, and stamps what it read', async () => {
    const server = new FakeImapServer();
    server.add('INBOX', fakeMessage({ subject: 'Invoice', messageId: '<a@x>', bodyText: 'Payment is due 22 September.' }));
    server.add('INBOX', fakeMessage({ subject: 'Hello', messageId: '<b@x>', bodyText: 'Nothing dated here.' }));
    const source = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC });
    await source.poll(contextFor());

    const { rows } = await pool.query(
      `select m.subject, to_char(d.on_date, 'YYYY-MM-DD') as day, d.phrase, d.confidence,
              m.dates_scanned_at is not null as scanned
         from email.messages m left join email.dates d on d.message_id = m.id
        order by m.uid`,
    );
    expect(rows).toEqual([
      // `numeric(3,2)`, which pg hands back as a string: two decimals exactly.
      { subject: 'Invoice', day: '2026-09-22', phrase: '22 September', confidence: '0.80', scanned: true },
      // Read, nothing found: stamped all the same, so nothing reads it twice.
      { subject: 'Hello', day: null, phrase: null, confidence: null, scanned: true },
    ]);
  });

  it('does not read the dates of a sender the owner silenced', async () => {
    await pool.query(
      `insert into email.policies (account_id, scope, matcher, action, params, origin, proposed)
       values ($1, 'sender', 'sender@example.test', 'ignore', '{}'::jsonb, 'owner', false)`,
      [accountId],
    );
    const server = new FakeImapServer();
    server.add('INBOX', fakeMessage({ subject: 'Sale', messageId: '<a@x>', bodyText: 'Offer expires 22 September.' }));
    const source = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC });
    const ctx = contextFor();
    await source.poll(ctx);

    expect(ctx.runs).toEqual([]);
    const { rows } = await pool.query(
      `select (select count(*)::int from email.dates) as dates,
              (select count(*)::int from email.messages where dates_scanned_at is null) as unscanned`,
    );
    expect(rows[0]).toEqual({ dates: 0, unscanned: 0 });
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
        // The two attachment methods the port gained in step 6b: delegation,
        // since this stub is about the timeout on `open`/`fetchSince`.
        listAttachments: (name: string, uid: number) => real.listAttachments(name, uid),
        downloadAttachment: (name: string, uid: number, part: string, max: number) =>
          real.downloadAttachment(name, uid, part, max),
        fetchFlags: (name: string, uids: readonly number[], since?: string | null) =>
          real.fetchFlags(name, uids, since),
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
        // The two attachment methods the port gained in step 6b: delegation,
        // since this stub is about the timeout on `open`/`fetchSince`.
        listAttachments: (name: string, uid: number) => real.listAttachments(name, uid),
        downloadAttachment: (name: string, uid: number, part: string, max: number) =>
          real.downloadAttachment(name, uid, part, max),
        fetchFlags: (name: string, uids: readonly number[], since?: string | null) =>
          real.fetchFlags(name, uids, since),
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
  /*
   * Flags move after ingest: the owner reads a message on the phone and the
   * next poll must say so. FLAGS only, rows updated in place, never a body
   * fetched and never a second row.
   */
  describe('flag re-sync', () => {
    const SEEN = '\\Seen';

    async function flagsByUid(): Promise<Record<number, string[]>> {
      const { rows } = await pool.query(`select uid, flags from email.messages order by uid`);
      return Object.fromEntries(rows.map((r: any) => [Number(r.uid), r.flags]));
    }

    async function storedModseq(): Promise<string | null> {
      const { rows } = await pool.query(
        `select highest_modseq from email.folders where account_id = $1 and kind = 'inbox'`,
        [accountId],
      );
      return rows[0].highest_modseq === null ? null : String(rows[0].highest_modseq);
    }

    function metricContext() {
      return hosted({ db: pool, ownerId: 'owner', now: () => new Date('2026-09-13T12:00:00Z'), timezone: 'UTC' } as never);
    }

    it('without CONDSTORE, re-reads every held message\'s FLAGS and sees one read elsewhere', async () => {
      const server = new FakeImapServer();
      for (const id of ['a', 'b', 'c']) server.add('INBOX', fakeMessage({ messageId: `<${id}@x>` }));
      const source = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC });
      await source.poll(contextFor());
      expect(await flagsByUid()).toEqual({ 1: [], 2: [], 3: [] });
      expect((await inboxUnread.measure({}, metricContext()))?.value).toBe(3);

      // Read on the phone; archived elsewhere.
      server.setFlags('INBOX', 2, [SEEN]);
      server.remove('INBOX', 3);
      const fetchesBefore = server.fetches.length;
      const flagFetchesBefore = server.flagFetches.length;
      const again = contextFor();
      await source.poll(again);

      expect(await flagsByUid()).toEqual({ 1: [], 2: [SEEN], 3: [] });
      // One FLAGS fetch of every held uid, with no CHANGEDSINCE to ask with.
      expect(server.flagFetches.slice(flagFetchesBefore)).toEqual([
        { mailbox: 'INBOX', uids: [1, 2, 3], changedSince: null, returned: 2 },
      ]);
      // No body: the only message fetch was the cursor's, and it found nothing.
      expect(server.fetches.slice(fetchesBefore).every((f) => f.returned === 0)).toBe(true);
      expect(server.downloads).toEqual([]);
      // Updated in place, never re-ingested, and nobody triaged it twice.
      expect(await messageCount()).toBe(3);
      expect(again.runs).toEqual([]);
      expect(await storedModseq()).toBeNull();
      // The archived one keeps its last flags: the schema has no "in the inbox" field.
      expect((await inboxUnread.measure({}, metricContext()))?.value).toBe(2);
    });

    it('caps the full fetch at the newest FLAG_SYNC_WINDOW rows, in batches', async () => {
      const server = new FakeImapServer();
      server.add('INBOX', fakeMessage({ messageId: '<first@x>' }));
      const source = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC });
      await source.poll(contextFor());
      const total = FLAG_SYNC_WINDOW + 25;
      // Rows buddi already holds, written straight in: 2,025 polls of 50 would
      // prove nothing more about the cap.
      await pool.query(
        `insert into email.messages (account_id, folder_id, uidvalidity, uid, from_addr, triage_enqueued_at)
         select f.account_id, f.id, 1, g, 'bulk@example.test', now()
           from email.folders f, generate_series(2, $2::int) g
          where f.account_id = $1 and f.kind = 'inbox'`,
        [accountId, total],
      );
      const before = server.flagFetches.length;
      await source.poll(contextFor());
      const asked = server.flagFetches.slice(before);
      expect(asked.map((f) => f.uids.length)).toEqual(
        Array(FLAG_SYNC_WINDOW / FLAG_SYNC_BATCH).fill(FLAG_SYNC_BATCH),
      );
      const uids = asked.flatMap((f) => f.uids);
      expect(uids.length).toBe(FLAG_SYNC_WINDOW);
      expect(Math.min(...uids)).toBe(total - FLAG_SYNC_WINDOW + 1);
      expect(Math.max(...uids)).toBe(total);
      expect(asked.every((f) => f.changedSince === null)).toBe(true);
    });

    it('with CONDSTORE, asks only for what changed since the stored HIGHESTMODSEQ', async () => {
      const server = new FakeImapServer({ INBOX: { uidValidity: 1, messages: [], condstore: true } });
      for (const id of ['a', 'b', 'c']) server.add('INBOX', fakeMessage({ messageId: `<${id}@x>` }));
      const source = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC });

      // First pass: nothing stored to ask CHANGEDSINCE with, so the full fetch,
      // and the HIGHESTMODSEQ it saw is written down.
      await source.poll(contextFor());
      expect(server.flagFetches.map((f) => f.changedSince)).toEqual([null]);
      const first = await storedModseq();
      expect(first).toBe(String(server.mailbox('INBOX').highestModseq));

      // Nothing changed: the modseq says so and no command is sent at all.
      await source.poll(contextFor());
      expect(server.flagFetches).toHaveLength(1);

      // Read elsewhere: one CHANGEDSINCE fetch, one message in the answer.
      server.setFlags('INBOX', 2, [SEEN, '\\Flagged']);
      const logged: string[] = [];
      const ctx = contextFor();
      ctx.log = (line) => logged.push(line);
      await source.poll(ctx);
      expect(server.flagFetches.slice(1)).toEqual([
        { mailbox: 'INBOX', uids: [1, 2, 3], changedSince: first, returned: 1 },
      ]);
      expect(await flagsByUid()).toEqual({ 1: [], 2: [SEEN, '\\Flagged'], 3: [] });
      expect(await storedModseq()).toBe(String(server.mailbox('INBOX').highestModseq));
      expect(logged.join('\n')).toMatch(/flags on owner@example\.test\/INBOX re-synced via condstore in \d+ms — 3 held, 1 reported, 1 changed/);
      expect(server.downloads).toEqual([]);
      expect(await messageCount()).toBe(3);

      const reading = await inboxUnread.measure({}, metricContext());
      expect(reading?.value).toBe(2);
      expect(reading?.note).toBe('unread in owner@example.test');
      expect((await inboxUnread.measure({ account: 'owner@example.test' }, metricContext()))?.value).toBe(2);
      expect(await inboxUnread.measure({ account: 'nobody@example.test' }, metricContext())).toBeNull();
    });

    it('forgets the stored HIGHESTMODSEQ when UIDVALIDITY changes', async () => {
      const server = new FakeImapServer({ INBOX: { uidValidity: 1, messages: [], condstore: true } });
      server.add('INBOX', fakeMessage({ messageId: '<a@x>' }));
      const source = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC });
      await source.poll(contextFor());
      expect(await storedModseq()).not.toBeNull();

      server.resetUidValidity('INBOX', 2);
      const before = server.flagFetches.length;
      await source.poll(contextFor());
      // The new generation's rows are asked for in full, never CHANGEDSINCE an old modseq.
      expect(server.flagFetches.slice(before).every((f) => f.changedSince === null)).toBe(true);
    });
  });
});
