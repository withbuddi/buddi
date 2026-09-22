/**
 * Threads and the Sent folder, end to end (docs/email.md §13.3).
 *
 * Skipped unless DATABASE_URL is set. It never touches the developer's data:
 * the suite creates its own database, migrates core plus this plugin into it,
 * and drops it at the end. No socket is opened to any mailbox and no model is
 * called — everything here is the source, the schema and two tools.
 *
 * What it is here to hold:
 *
 *  - the **backfill** builds the conversations that are already stored, with
 *    the state the newest message implies;
 *  - **discovery** finds the Sent folder from what the server says, not from
 *    what it is called;
 *  - a message in **Sent is the owner's**: it starts no run, it wakes nobody,
 *    and it leaves the conversation waiting on the other party;
 *  - a reply coming **back** flips it again — unless the owner muted it, and
 *    then nothing does;
 *  - "has the owner written back" is answered from his own mail;
 *  - the two thread tools, and the thread in the triage prompt.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, runMigrations } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { ensureGmailAccount, GMAIL_SECRET_NAME } from './config.js';
import { FakeImapServer, fakeMessage } from './imap/fake.js';
import { manifest } from './index.js';
import { ownerHasRepliedTo, ownerReplies } from './policies/learn.js';
import { createInboxPollSource } from './sources/inbox-poll.js';
import { listThreads, muteThread, readThread } from './tools/threads.js';
import type { SourceContext, ToolContext } from './types.js';

const FULL_SYNC = 10_000;
const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_email_threads_test_${process.pid}`;
const ENV = { GMAIL_USER: 'owner@example.test', [GMAIL_SECRET_NAME]: 'app-password' };
const NOW = new Date('2026-09-21T12:00:00Z');

suite('email threads (postgres + fake imap)', () => {
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
      'truncate email.events, email.policies, email.threads, email.drafts, email.triage, ' +
        'email.messages, email.folders, email.accounts cascade',
    );
    const account = await ensureGmailAccount(pool, ENV);
    accountId = account!.id;
  });

  function sourceContext(): SourceContext & {
    runs: Array<{ agentId: string; prompt: string; dedupKey: string }>;
  } {
    const runs: Array<{ agentId: string; prompt: string; dedupKey: string }> = [];
    return {
      db: pool,
      now: () => NOW,
      timezone: 'UTC',
      runs,
      log: () => {},
      async enqueueRun(input) {
        runs.push({ agentId: input.agentId, prompt: input.prompt, dedupKey: input.dedupKey });
      },
    };
  }

  function toolContext(): ToolContext {
    return {
      db: pool,
      ownerId: 'owner',
      now: () => NOW,
      timezone: 'UTC',
      agentId: 'mail-triage',
    } as unknown as ToolContext;
  }

  /** A server with an inbox and a Sent folder the server itself labels. */
  function serverWithSent(): FakeImapServer {
    const server = new FakeImapServer();
    server.mailbox('INBOX');
    server.mailbox('[Gmail]/Sent Mail').specialUse = '\\Sent';
    return server;
  }

  function source(server: FakeImapServer) {
    return createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC });
  }

  async function threads(): Promise<
    Array<{ id: string; subject: string; state: string; n: number; last: string }>
  > {
    const { rows } = await pool.query(
      `select id, subject, state, message_count, last_direction from email.threads
        order by last_at asc nulls first`,
    );
    return rows.map((r: Record<string, unknown>) => ({
      id: String(r.id),
      subject: String(r.subject),
      state: String(r.state),
      n: Number(r.message_count),
      last: String(r.last_direction),
    }));
  }

  // -------------------------------------------------------------- backfill
  describe('the backfill', () => {
    /**
     * Two conversations already in the database, written the way earlier
     * builds wrote them: no thread, no direction, one of them containing a
     * reply the owner sent from somewhere else entirely.
     */
    async function fixture(): Promise<void> {
      const { rows } = await pool.query(
        `insert into email.folders (account_id, name, kind, synced)
         values ($1, 'INBOX', 'inbox', true) returning id`,
        [accountId],
      );
      const folderId = String(rows[0].id);
      const write = async (over: {
        uid: number;
        from: string;
        to: string;
        subject: string;
        threadKey: string;
        at: string;
      }): Promise<void> => {
        await pool.query(
          `insert into email.messages
             (account_id, folder_id, uidvalidity, uid, message_id, thread_key, from_addr, to_addrs,
              subject, date, snippet, body_text, triage_enqueued_at)
           values ($1, $2, 1, $3, $4, $5, $6, $7::jsonb, $8, $9, '', '', now())`,
          [
            accountId,
            folderId,
            over.uid,
            `<m${over.uid}@example.test>`,
            over.threadKey,
            over.from,
            JSON.stringify([over.to]),
            over.subject,
            over.at,
          ],
        );
      };
      // A conversation with a client, answered by the owner — from his phone,
      // so nothing buddi did records the reply.
      await write({ uid: 1, from: 'Client <client@work.test>', to: 'owner@example.test', subject: 'The quote', threadKey: '<t1@work.test>', at: '2026-09-18T09:00:00Z' });
      await write({ uid: 2, from: 'Owner <owner@example.test>', to: 'client@work.test', subject: 'Re: The quote', threadKey: '<t1@work.test>', at: '2026-09-18T18:00:00Z' });
      // A newsletter, months old, with an ignore rule about its sender.
      await write({ uid: 3, from: 'news@shop.test', to: 'owner@example.test', subject: 'Weekend sale', threadKey: '<t2@shop.test>', at: '2026-05-01T09:00:00Z' });
      await pool.query(
        `insert into email.policies (account_id, scope, matcher, action, params, origin, proposed)
         values ($1, 'sender', 'news@shop.test', 'ignore', '{}'::jsonb, 'learned', true)`,
        [accountId],
      );
      // The state the database was in before this migration existed.
      await pool.query(`update email.messages set thread_id = null, direction = 'in'`);
      await pool.query(`delete from email.threads`);
    }

    it('builds one thread per conversation, with the state the last message implies', async () => {
      await fixture();
      const { rows } = await pool.query(`select email.backfill_threads($1) as n`, [NOW]);
      expect(Number(rows[0].n)).toBe(2);

      const built = await threads();
      expect(built).toEqual([
        // A single old newsletter from a sender there is an ignore rule about:
        // nothing is expected back, so it is closed rather than waiting.
        { id: expect.any(String), subject: 'Weekend sale', state: 'closed', n: 1, last: 'in' },
        // The owner wrote last, and the Sent-folder rule says so even though
        // the reply was found in the inbox's own history.
        { id: expect.any(String), subject: 'The quote', state: 'waiting-on-them', n: 2, last: 'out' },
      ]);
    });

    it('marks the owner\'s own messages as outbound, and points every message at its thread', async () => {
      await fixture();
      await pool.query(`select email.backfill_threads($1)`, [NOW]);
      const { rows } = await pool.query(
        `select uid, direction, thread_id is not null as threaded from email.messages order by uid`,
      );
      expect(rows.map((r: Record<string, unknown>) => [Number(r.uid), r.direction, r.threaded])).toEqual([
        [1, 'in', true],
        [2, 'out', true],
        [3, 'in', true],
      ]);
    });

    it('runs again without writing anything twice', async () => {
      await fixture();
      await pool.query(`select email.backfill_threads($1)`, [NOW]);
      const { rows } = await pool.query(`select email.backfill_threads($1) as n`, [NOW]);
      expect(Number(rows[0].n)).toBe(0);
      expect(await threads()).toHaveLength(2);
    });
  });

  // ------------------------------------------------------------- discovery
  describe('folder discovery', () => {
    it('finds the Sent folder from what the server says, and syncs two folders', async () => {
      const server = serverWithSent();
      server.mailbox('[Gmail]/All Mail').specialUse = '\\All';
      server.mailbox('Projects');
      await source(server).poll(sourceContext());

      const { rows } = await pool.query(
        `select name, kind, synced from email.folders where account_id = $1 order by name`,
        [accountId],
      );
      expect(rows).toEqual([
        { name: '[Gmail]/All Mail', kind: 'other', synced: false },
        { name: '[Gmail]/Sent Mail', kind: 'sent', synced: true },
        { name: 'INBOX', kind: 'inbox', synced: true },
        { name: 'Projects', kind: 'other', synced: false },
      ]);
    });

    it('lists the folders once and not on every poll', async () => {
      const server = serverWithSent();
      const s = source(server);
      await s.poll(sourceContext());
      await s.poll(sourceContext());
      expect(server.lists).toBe(1);
    });

    it('keeps polling the inbox when the account has no Sent folder at all', async () => {
      const server = new FakeImapServer();
      server.add('INBOX', fakeMessage({ messageId: '<a@x>', subject: 'Only mail' }));
      const ctx = sourceContext();
      await source(server).poll(ctx);
      expect(ctx.runs).toHaveLength(1);
      const { rows } = await pool.query(`select count(*)::int as n from email.threads`);
      expect(rows[0].n).toBe(1);
    });
  });

  // ------------------------------------------------------- ingest and state
  describe('a conversation as it moves', () => {
    const KEY = '<t-live@work.test>';

    function inbound(uid: number, at: string, subject = 'The quote') {
      return fakeMessage({
        uid,
        messageId: `<in-${uid}@work.test>`,
        references: [KEY],
        from: 'Client <client@work.test>',
        to: ['owner@example.test'],
        subject,
        bodyText: 'Could you confirm the quote?',
        date: new Date(at),
      });
    }

    function outbound(uid: number, at: string) {
      return fakeMessage({
        uid,
        messageId: `<out-${uid}@example.test>`,
        references: [KEY],
        from: 'Owner <owner@example.test>',
        to: ['client@work.test'],
        subject: 'Re: The quote',
        bodyText: 'Confirmed — the quote stands.',
        date: new Date(at),
      });
    }

    it('starts a run for what arrives and leaves the conversation waiting on the owner', async () => {
      const server = serverWithSent();
      server.add('INBOX', inbound(1, '2026-09-20T09:00:00Z'));
      const ctx = sourceContext();
      await source(server).poll(ctx);

      expect(ctx.runs).toHaveLength(1);
      expect(await threads()).toEqual([
        { id: expect.any(String), subject: 'The quote', state: 'waiting-on-me', n: 1, last: 'in' },
      ]);
    });

    it('takes the owner\'s own reply from Sent: no run, no gate, waiting on them', async () => {
      const server = serverWithSent();
      server.add('INBOX', inbound(1, '2026-09-20T09:00:00Z'));
      const first = sourceContext();
      await source(server).poll(first);

      server.add('[Gmail]/Sent Mail', outbound(1, '2026-09-20T18:00:00Z'));
      const second = sourceContext();
      await source(server).poll(second);

      // Nothing was woken by the owner's own message.
      expect(second.runs).toHaveLength(0);
      expect(await threads()).toEqual([
        { id: expect.any(String), subject: 'The quote', state: 'waiting-on-them', n: 2, last: 'out' },
      ]);
      // And it is stamped as it lands, so no later poll can pick it up.
      const { rows } = await pool.query(
        `select direction, triage_enqueued_at is not null as stamped from email.messages
          where direction = 'out'`,
      );
      expect(rows).toEqual([{ direction: 'out', stamped: true }]);
      // No event either: the gate never saw it.
      const { rows: events } = await pool.query(`select count(*)::int as n from email.events`);
      expect(events[0].n).toBe(1);
    });

    it('flips back to waiting on the owner when they write again', async () => {
      const server = serverWithSent();
      server.add('INBOX', inbound(1, '2026-09-20T09:00:00Z'));
      await source(server).poll(sourceContext());
      server.add('[Gmail]/Sent Mail', outbound(1, '2026-09-20T18:00:00Z'));
      await source(server).poll(sourceContext());
      server.add('INBOX', inbound(2, '2026-09-21T08:00:00Z'));
      const ctx = sourceContext();
      await source(server).poll(ctx);

      expect(ctx.runs).toHaveLength(1);
      expect(await threads()).toEqual([
        { id: expect.any(String), subject: 'The quote', state: 'waiting-on-me', n: 3, last: 'in' },
      ]);
    });

    it('leaves a muted conversation muted, however much arrives in it', async () => {
      const server = serverWithSent();
      server.add('INBOX', inbound(1, '2026-09-20T09:00:00Z'));
      await source(server).poll(sourceContext());

      const [thread] = await threads();
      const muted = await muteThread.execute({ thread: thread!.id }, toolContext()) as {
        thread: { state: string };
      };
      expect(muted.thread.state).toBe('muted');

      server.add('INBOX', inbound(2, '2026-09-21T08:00:00Z'));
      server.add('[Gmail]/Sent Mail', outbound(1, '2026-09-21T09:00:00Z'));
      await source(server).poll(sourceContext());

      const after = await threads();
      expect(after[0]).toMatchObject({ state: 'muted', n: 3 });
    });

    it('answers "has the owner written back" from Sent rather than from drafts', async () => {
      const server = serverWithSent();
      server.add('INBOX', inbound(1, '2026-09-20T09:00:00Z'));
      await source(server).poll(sourceContext());
      expect(await ownerHasRepliedTo(pool, accountId, 'client@work.test')).toBe(false);

      server.add('[Gmail]/Sent Mail', outbound(1, '2026-09-20T18:00:00Z'));
      await source(server).poll(sourceContext());
      expect(await ownerHasRepliedTo(pool, accountId, 'Client <CLIENT@work.test>')).toBe(true);

      // And how fast: nine hours, inside the thread.
      const replies = await ownerReplies(pool, accountId, 'client@work.test');
      expect(replies.count).toBe(1);
      expect(Math.round(replies.averageHours ?? 0)).toBe(9);
    });

    it('gives the triage run the conversation, its state and the owner\'s habit', async () => {
      const server = serverWithSent();
      server.add('INBOX', inbound(1, '2026-09-20T09:00:00Z'));
      await source(server).poll(sourceContext());
      server.add('[Gmail]/Sent Mail', outbound(1, '2026-09-20T18:00:00Z'));
      await source(server).poll(sourceContext());

      server.add('INBOX', inbound(2, '2026-09-21T08:00:00Z', 'Re: The quote'));
      const ctx = sourceContext();
      await source(server).poll(ctx);

      const prompt = ctx.runs[0]!.prompt;
      expect(prompt).toContain('part of a conversation');
      // The state as it stands *with* this message in it: it arrived, so the
      // owner is the one being waited on, and the run is told that rather
      // than the state the conversation had a minute ago.
      expect(prompt).toContain('of 3 messages, currently waiting-on-me');
      // The owner's own turn is in it, named as his.
      expect(prompt).toContain('the owner (owner@example.test)');
      expect(prompt).toContain('Confirmed — the quote stands.');
      expect(prompt).toContain('The owner has written back 1 time');
    });
  });

  // ----------------------------------------------------------------- tools
  describe('the thread tools', () => {
    async function conversation(): Promise<string> {
      const server = serverWithSent();
      server.add(
        'INBOX',
        fakeMessage({
          messageId: '<c1@work.test>',
          from: 'client@work.test',
          to: ['owner@example.test'],
          subject: 'The quote',
          bodyText: 'Could you confirm?',
          date: new Date('2026-09-20T09:00:00Z'),
        }),
      );
      server.add(
        '[Gmail]/Sent Mail',
        fakeMessage({
          messageId: '<c2@example.test>',
          references: ['<c1@work.test>'],
          from: 'owner@example.test',
          to: ['client@work.test'],
          subject: 'Re: The quote',
          bodyText: 'Confirmed.',
          date: new Date('2026-09-20T18:00:00Z'),
        }),
      );
      await source(server).poll(sourceContext());
      const [thread] = await threads();
      return thread!.id;
    }

    it('lists conversations, filtered by state and by who is in them', async () => {
      const id = await conversation();
      const all = (await listThreads.execute({}, toolContext())) as {
        count: number;
        threads: Array<Record<string, unknown>>;
      };
      expect(all.count).toBe(1);
      expect(all.threads[0]).toMatchObject({
        id,
        subject: 'The quote',
        state: 'waiting-on-them',
        messageCount: 2,
        lastDirection: 'out',
      });
      expect(all.threads[0]!.participants).toEqual(
        expect.arrayContaining(['client@work.test', 'owner@example.test']),
      );

      const waiting = (await listThreads.execute({ state: 'waiting-on-me' }, toolContext())) as {
        count: number;
      };
      expect(waiting.count).toBe(0);

      const byPerson = (await listThreads.execute(
        { participant: 'Client <CLIENT@work.test>' },
        toolContext(),
      )) as { count: number };
      expect(byPerson.count).toBe(1);
      const stranger = (await listThreads.execute(
        { participant: 'nobody@elsewhere.test' },
        toolContext(),
      )) as { count: number };
      expect(stranger.count).toBe(0);
    });

    it('reads one conversation in order, saying which way each message went', async () => {
      const id = await conversation();
      const read = (await readThread.execute({ thread: id }, toolContext())) as {
        state: string;
        messages: Array<{ direction: string; who: string; bodyText: string | null }>;
      };
      expect(read.state).toBe('waiting-on-them');
      expect(read.messages.map((m) => [m.direction, m.who])).toEqual([
        ['in', 'client@work.test'],
        ['out', 'the owner'],
      ]);
      expect(read.messages[1]!.bodyText).toBe('Confirmed.');
    });

    it('refuses a conversation that is not in the mailbox that was named', async () => {
      const id = await conversation();
      await expect(
        readThread.execute({ thread: id, account: 'owner@example.test' }, toolContext()),
      ).resolves.toMatchObject({ id });
      await expect(
        readThread.execute({ thread: '00000000-0000-0000-0000-000000000000' }, toolContext()),
      ).rejects.toThrow(/unknown conversation/);
    });

    it('previews a mute in the words the owner is agreeing to', async () => {
      const id = await conversation();
      const described = await muteThread.describe({ thread: id }, toolContext());
      expect(described.preview).toContain('Mute the conversation "The quote"');
      expect(described.preview).toContain('client@work.test');
      expect(described.envelope).toMatchObject({ threadId: id, previousState: 'waiting-on-them' });
    });
  });
});
