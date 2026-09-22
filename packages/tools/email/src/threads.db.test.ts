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
import { joinThread } from './threads.js';
import { policiesView } from './tools/policies.js';
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
      // A conversation with a client. The second row's From happens to be the
      // owner's own address, but it was written into INBOX — the only folder
      // ever polled before this migration — and the backfill trusts folder
      // provenance only, never a From header, so it stays inbound rather than
      // being guessed as the owner's reply.
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
        // Both rows came through INBOX, so both stay inbound: the backfill
        // does not infer "the owner wrote last" from a From header, even
        // though this row's From happens to be the owner's own address.
        { id: expect.any(String), subject: 'The quote', state: 'waiting-on-me', n: 2, last: 'in' },
      ]);
    });

    it('leaves direction exactly as the folder recorded it — nothing is guessed from From, and every message points at its thread', async () => {
      await fixture();
      await pool.query(`select email.backfill_threads($1)`, [NOW]);
      const { rows } = await pool.query(
        `select uid, direction, thread_id is not null as threaded from email.messages order by uid`,
      );
      expect(rows.map((r: Record<string, unknown>) => [Number(r.uid), r.direction, r.threaded])).toEqual([
        [1, 'in', true],
        [2, 'in', true],
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

    it('clamps hostile legacy Date headers to one day after fetched_at', async () => {
      await fixture();
      await pool.query(
        `update email.messages
            set date = case when uid = 1 then '2099-01-01'::timestamptz else null end,
                fetched_at = $1
          where thread_key = '<t1@work.test>'`,
        [NOW],
      );
      await pool.query(`select email.backfill_threads($1)`, [NOW]);
      const { rows } = await pool.query(
        `select last_at from email.threads where thread_key = '<t1@work.test>'`,
      );
      expect(new Date(rows[0].last_at).toISOString()).toBe('2026-09-22T12:00:00.000Z');
    });

    it('uses fetched_at exactly for a separate legacy thread with a null Date', async () => {
      await fixture();
      await pool.query(
        `insert into email.messages
           (account_id, folder_id, uidvalidity, uid, message_id, thread_key, from_addr, to_addrs,
            subject, date, internal_date, fetched_at, snippet, body_text, triage_enqueued_at)
         select $1, id, 1, 4, '<null-date@example.test>', '<null-date-thread@example.test>',
                'sender@example.test', '["owner@example.test"]'::jsonb, 'No date', null, null, $2, '', '', now()
           from email.folders where account_id = $1 and kind = 'inbox'`,
        [accountId, NOW],
      );
      await pool.query(`select email.backfill_threads($1)`, [NOW]);
      const { rows } = await pool.query(
        `select first_at, last_at from email.threads where thread_key = '<null-date-thread@example.test>'`,
      );
      expect(new Date(rows[0].first_at).toISOString()).toBe(NOW.toISOString());
      expect(new Date(rows[0].last_at).toISOString()).toBe(NOW.toISOString());
    });

    it('caps participants on backfill and records overflow from the uncapped distinct count', async () => {
      await fixture();
      const addresses = Array.from({ length: 60 }, (_, i) => `person-${i}@example.test`);
      await pool.query(
        `update email.messages set to_addrs = $1::jsonb where uid = 1`,
        [JSON.stringify(addresses)],
      );
      await pool.query(`select email.backfill_threads($1)`, [NOW]);
      const { rows } = await pool.query(
        `select jsonb_array_length(participants) as kept, participants_overflow
           from email.threads where thread_key = '<t1@work.test>'`,
      );
      expect(rows[0]).toEqual({ kept: 50, participants_overflow: 12 });
    });

    it('expands a global thread policy into one account-scoped copy per matching thread, and revokes the global row', async () => {
      // A second account with a thread that shares the exact same root
      // Message-ID as the first account's — a global policy naming that key
      // must not resolve to only one of the two, arbitrarily.
      const { rows: acct2 } = await pool.query(
        `insert into email.accounts
           (address, imap_host, imap_port, smtp_host, smtp_port, auth_mode, secret_name)
         values ('second@example.test', 'imap.example.test', 993, 'smtp.example.test', 465,
                 'app-password', 'SECOND_ACCOUNT_SECRET')
         returning id`,
      );
      const account2 = String(acct2[0].id);
      await pool.query(
        `insert into email.folders (account_id, name, kind, synced) values ($1, 'INBOX', 'inbox', true)`,
        [account2],
      );

      await fixture();
      // A global thread policy naming the key both accounts' threads share.
      const { rows: gp } = await pool.query(
        `insert into email.policies (account_id, scope, matcher, action, params, origin, proposed, created_at)
         values (null, 'thread', '<t1@work.test>', 'ignore', '{"sender":"client@work.test"}'::jsonb, 'owner', false, $1)
         returning id`,
        [new Date(NOW.getTime() - 86_400_000)],
      );
      const globalId = String(gp[0].id);
      const { rows: scopedRows } = await pool.query(
        `insert into email.policies
           (account_id, scope, matcher, action, params, origin, proposed, created_at)
         values ($1, 'thread', '<t1@work.test>', 'wake', '{}'::jsonb, 'owner', false, $2)
         returning id`,
        [accountId, new Date(NOW.getTime() - 2 * 86_400_000)],
      );
      const scopedId = String(scopedRows[0].id);
      await pool.query(
        `insert into email.messages
           (account_id, folder_id, uidvalidity, uid, message_id, thread_key, from_addr, to_addrs,
            subject, date, snippet, body_text, triage_enqueued_at)
         select $1, id, 1, 99, '<other@work.test>', '<t1@work.test>', 'client@work.test',
                '["second@example.test"]'::jsonb, 'Also the quote', '2026-09-01T09:00:00Z', '', '', now()
           from email.folders where account_id = $1`,
        [account2],
      );

      await pool.query(`select email.backfill_threads($1)`, [NOW]);
      await pool.query(
        `update email.threads set policy_id = $1 where account_id = $2 and thread_key = '<t1@work.test>'`,
        [scopedId, accountId],
      );
      const expanded = await pool.query(`select email.expand_global_thread_policies() as n`);
      expect(Number(expanded.rows[0].n)).toBe(2);

      const { rows: revoked } = await pool.query(
        `select revoked_at is not null as revoked from email.policies where id = $1`,
        [globalId],
      );
      expect(revoked[0].revoked).toBe(true);

      const { rows: live } = await pool.query(
        `select p.account_id, p.action, p.matcher = t.id::text as points_at_thread
           from email.policies p
           join email.threads t on t.thread_key = '<t1@work.test>' and t.account_id = p.account_id
          where p.scope = 'thread' and p.revoked_at is null
          order by p.account_id`,
      );
      expect(live).toHaveLength(2);
      expect(live.every((r: Record<string, unknown>) => r.points_at_thread)).toBe(true);
      expect(new Set(live.map((r: Record<string, unknown>) => String(r.account_id)))).toEqual(
        new Set([accountId, account2]),
      );
      expect(live.find((r: Record<string, unknown>) => String(r.account_id) === accountId)?.action).toBe('ignore');
      const { rows: repaired } = await pool.query(
        `select t.policy_id, p.action, old.revoked_at is not null as old_revoked
           from email.threads t
           left join email.policies p on p.id = t.policy_id
           join email.policies old on old.id = $1
          where t.account_id = $2 and t.thread_key = '<t1@work.test>'`,
        [scopedId, accountId],
      );
      expect(repaired[0]).toMatchObject({ action: 'ignore', old_revoked: true });
      expect(String(repaired[0].policy_id)).not.toBe(scopedId);
      const rerun = await pool.query(`select email.expand_global_thread_policies() as n`);
      expect(Number(rerun.rows[0].n)).toBe(0);
    });

    it('keeps an applied global decision ahead of a newer scoped proposal', async () => {
      await fixture();
      await pool.query(`select email.backfill_threads($1)`, [NOW]);
      await pool.query(
        `insert into email.policies
           (account_id, scope, matcher, action, params, origin, proposed, created_at)
         values
           (null, 'thread', '<t1@work.test>', 'ignore', '{}'::jsonb, 'owner', false, $2),
           ($1, 'thread', '<t1@work.test>', 'wake', '{}'::jsonb, 'learned', true, $3)`,
        [accountId, new Date(NOW.getTime() - 86_400_000), NOW],
      );

      await pool.query(`select email.expand_global_thread_policies()`);
      const { rows } = await pool.query(
        `select p.action, p.proposed, p.matcher = t.id::text as points_at_thread,
                t.policy_id = p.id as installed
           from email.threads t
           join email.policies p on p.account_id = t.account_id and p.matcher = t.id::text
          where t.account_id = $1 and t.thread_key = '<t1@work.test>' and p.revoked_at is null`,
        [accountId],
      );
      expect(rows).toEqual([
        { action: 'ignore', proposed: false, points_at_thread: true, installed: true },
      ]);
      // The proposal about this thread is revoked, not carried forward: an
      // applied decision holds the thread's one live slot, so there is nothing
      // left for the owner to keep (docs/specs/email.md §3). The fixture's
      // unrelated `sender` proposal is untouched, hence the scope filter.
      const { rows: proposal } = await pool.query(
        `select revoked_at is not null as revoked from email.policies
          where account_id = $1 and scope = 'thread' and proposed = true`,
        [accountId],
      );
      expect(proposal).toEqual([{ revoked: true }]);
    });

    it('clears a thread pointer when its revoked policy has no live replacement', async () => {
      await fixture();
      await pool.query(`select email.backfill_threads($1)`, [NOW]);
      const { rows: threadRows } = await pool.query(
        `select id from email.threads where account_id = $1 and thread_key = '<t1@work.test>'`,
        [accountId],
      );
      const threadId = String(threadRows[0].id);
      const { rows: policyRows } = await pool.query(
        `insert into email.policies
           (account_id, scope, matcher, action, params, origin, proposed, revoked_at)
         values ($1, 'thread', $2, 'wake', '{}'::jsonb, 'owner', false, $3)
         returning id`,
        [accountId, threadId, NOW],
      );
      await pool.query(`update email.threads set policy_id = $1 where id = $2`, [policyRows[0].id, threadId]);

      await pool.query(`select email.expand_global_thread_policies()`);
      const { rows } = await pool.query(`select policy_id from email.threads where id = $1`, [threadId]);
      expect(rows[0].policy_id).toBeNull();
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

    it('plants a newly discovered Sent folder at UIDNEXT-1 even with a large EMAIL_BACKFILL already in force for the inbox', async () => {
      // An installation that has been running a while: INBOX has a cursor
      // already, and this test's `source()` uses a full-history backfill
      // throughout, exactly the "large EMAIL_BACKFILL" upgrade case.
      const server = new FakeImapServer();
      server.add('INBOX', fakeMessage({ messageId: '<a@x>', subject: 'Only mail' }));
      await source(server).poll(sourceContext());
      const before = await pool.query(`select count(*)::int as n from email.messages`);

      // Sent is discovered on a later poll, arriving with years of history
      // already in it — mail buddi never sent and must not import.
      const sent = server.mailbox('[Gmail]/Sent Mail');
      sent.specialUse = '\\Sent';
      for (let i = 0; i < 5; i += 1) {
        server.add('[Gmail]/Sent Mail', fakeMessage({ messageId: `<old-${i}@x>`, subject: 'Old sent mail' }));
      }
      const ctx = sourceContext();
      await source(server).poll(ctx);

      // None of the five old Sent messages were imported.
      const after = await pool.query(`select count(*)::int as n from email.messages`);
      expect(after.rows[0].n).toBe(before.rows[0].n);
      expect(ctx.runs).toHaveLength(0);

      const { rows } = await pool.query(
        `select last_uid, uidvalidity is not null as has_generation from email.folders
          where account_id = $1 and name = '[Gmail]/Sent Mail'`,
        [accountId],
      );
      // The cursor sits at UIDNEXT-1 (5 messages already exist), not at 0.
      expect({ last_uid: Number(rows[0].last_uid), has_generation: rows[0].has_generation }).toEqual({
        last_uid: 5,
        has_generation: true,
      });
    });

    it('records the discovery boundary before INBOX work and fetches mail sent after it', async () => {
      const server = serverWithSent();
      const factory = async () => {
        const base = server.client();
        return {
          listMailboxes: () => base.listMailboxes(),
          fetchSince: (name: string, uid: number, limit: number) => base.fetchSince(name, uid, limit),
          close: () => base.close(),
          async open(name: string) {
            if (name === 'INBOX' && server.mailbox('[Gmail]/Sent Mail').messages.length === 0) {
              server.add('[Gmail]/Sent Mail', fakeMessage({ messageId: '<during-poll@x>', subject: 'Sent during poll' }));
            }
            return base.open(name);
          },
        };
      };
      const src = createInboxPollSource({ connect: factory, env: ENV, backfill: FULL_SYNC });
      await src.poll(sourceContext());
      expect(server.fetches.some((fetch) => fetch.mailbox === '[Gmail]/Sent Mail' && fetch.returned === 1)).toBe(true);
    });

    it('still polls INBOX when the first Sent open fails, then ingests mail above the discovery boundary', async () => {
      const server = serverWithSent();
      server.add('INBOX', fakeMessage({ messageId: '<inbox-survives@x>', subject: 'Inbox survives' }));
      let failSent = true;
      const logs: string[] = [];
      const factory = async () => {
        const base = server.client();
        return {
          listMailboxes: () => base.listMailboxes(),
          fetchSince: (name: string, uid: number, limit: number) => base.fetchSince(name, uid, limit),
          close: () => base.close(),
          async open(name: string) {
            if (name === '[Gmail]/Sent Mail' && failSent) {
              failSent = false;
              throw new Error('sent select failed');
            }
            return base.open(name);
          },
        };
      };
      const src = createInboxPollSource({ connect: factory, env: ENV, backfill: FULL_SYNC });
      const first = sourceContext();
      first.log = (line) => logs.push(line);
      await expect(src.poll(first)).rejects.toThrow('sent select failed');
      expect(first.runs).toHaveLength(1);
      expect(logs.some((line) => line.includes('INBOX'))).toBe(true);

      const { rows: boundary } = await pool.query(
        `select uidvalidity, last_uid from email.folders
          where account_id = $1 and name = '[Gmail]/Sent Mail'`,
        [accountId],
      );
      expect({ uidvalidity: Number(boundary[0].uidvalidity), last_uid: Number(boundary[0].last_uid) })
        .toEqual({ uidvalidity: 1, last_uid: 0 });

      server.add('[Gmail]/Sent Mail', fakeMessage({ messageId: '<after-discovery@x>', subject: 'After discovery' }));
      await src.poll(sourceContext());
      expect(server.fetches.some(
        (fetch) => fetch.mailbox === '[Gmail]/Sent Mail' && fetch.sinceUid === 0 && fetch.returned === 1,
      )).toBe(true);
      const { rows: sent } = await pool.query(
        `select direction from email.messages where message_id = '<after-discovery@x>'`,
      );
      expect(sent).toEqual([{ direction: 'out' }]);
    });

    it('still polls INBOX when planting a legacy cursorless Sent row fails', async () => {
      const server = serverWithSent();
      server.add('INBOX', fakeMessage({ messageId: '<inbox-after-plant-failure@x>', subject: 'Inbox survives plant' }));
      // Both rows, so this account counts as already discovered: discovery is
      // what fills a Sent row's cursor from LIST/STATUS, and a legacy row from
      // before Sent existed is exactly the one nothing has planted yet.
      await pool.query(
        `insert into email.folders (account_id, name, kind, synced)
         values ($1, 'INBOX', 'inbox', true)`,
        [accountId],
      );
      const { rows } = await pool.query(
        `insert into email.folders (account_id, name, kind, synced)
         values ($1, '[Gmail]/Sent Mail', 'sent', true) returning id`,
        [accountId],
      );
      const sentFolderId = String(rows[0].id);
      const failingDb = {
        async query(text: string, params: unknown[] = []) {
          if (/update email\.folders set uidvalidity/.test(text) && String(params[0]) === sentFolderId) {
            throw new Error('sent cursor plant failed');
          }
          return pool.query(text, params);
        },
        connect: () => pool.connect(),
      } as unknown as Pool;
      const ctx = sourceContext();
      ctx.db = failingDb;

      await expect(source(server).poll(ctx)).rejects.toThrow('sent cursor plant failed');
      expect(ctx.runs).toHaveLength(1);
      const { rows: inbox } = await pool.query(
        `select direction from email.messages where message_id = '<inbox-after-plant-failure@x>'`,
      );
      expect(inbox).toEqual([{ direction: 'in' }]);
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

      // Hostile Date headers do not alter reply timing; INTERNALDATE is nine
      // hours apart even when the sender claims 2099 and the reply claims 1900.
      await pool.query(
        `update email.messages
            set date = case direction when 'in' then '2099-01-01'::timestamptz
                                           else '1900-01-01'::timestamptz end`,
      );
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

  // --------------------------------------------------------- thread ordering
  describe('thread ordering (INTERNALDATE, not the Date header)', () => {
    /** A minimal message row, for tests that drive `joinThread` directly. */
    async function insertMessage(over: {
      folderId: string;
      uid: number;
      from: string;
      direction: 'in' | 'out';
      uidvalidity?: number;
    }): Promise<string> {
      const { rows } = await pool.query(
        `insert into email.messages (account_id, folder_id, uidvalidity, uid, from_addr, direction)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [accountId, over.folderId, over.uidvalidity ?? 1, over.uid, over.from, over.direction],
      );
      return String(rows[0].id);
    }

    async function twoFolders(): Promise<[string, string]> {
      const { rows } = await pool.query(
        `insert into email.folders (account_id, name, kind, synced)
         values ($1, 'FolderA', 'other', false), ($1, 'FolderB', 'other', false)
         returning id`,
        [accountId],
      );
      return [String(rows[0].id), String(rows[1].id)];
    }

    it('does not flip state for a message fetched late but dated older by INTERNALDATE', async () => {
      const server = serverWithSent();
      // Establish the folders and their cursors first — a newly discovered
      // Sent folder starts at UIDNEXT-1 regardless of backfill (its own
      // fix), so the reply below has to arrive *after* this poll to be seen.
      await source(server).poll(sourceContext());

      // The owner's reply lands first, with the later INTERNALDATE.
      server.add(
        '[Gmail]/Sent Mail',
        fakeMessage({
          messageId: '<out-1@x>',
          references: [],
          from: 'Owner <owner@example.test>',
          to: ['client@work.test'],
          date: new Date('2026-09-20T18:00:00Z'),
          internalDate: new Date('2026-09-20T18:00:00Z'),
        }),
      );
      await source(server).poll(sourceContext());
      expect(await threads()).toEqual([
        { id: expect.any(String), subject: 'Hello', state: 'waiting-on-them', n: 1, last: 'out' },
      ]);

      // A client message with the *same* thread key is fetched afterwards —
      // but its INTERNALDATE (when the server actually received it) is
      // before the reply's, e.g. a message the polling missed earlier. It
      // must not flip whose turn it is.
      server.add(
        'INBOX',
        fakeMessage({
          messageId: '<in-late@x>',
          references: ['<out-1@x>'],
          from: 'Client <client@work.test>',
          to: ['owner@example.test'],
          date: new Date('2026-09-20T09:00:00Z'),
          internalDate: new Date('2026-09-20T09:00:00Z'),
        }),
      );
      const ctx = sourceContext();
      await source(server).poll(ctx);

      // It still gets triaged — arriving mail always does — but it does not
      // change whose turn the *thread* is on: it is older by the clock that
      // matters, so the reply already there still stands as the last word.
      expect(ctx.runs).toHaveLength(1);
      expect(await threads()).toEqual([
        { id: expect.any(String), subject: 'Hello', state: 'waiting-on-them', n: 2, last: 'out' },
      ]);
    });

    it('is not fooled by a future-dated Date header, and clamps it in storage', async () => {
      const server = serverWithSent();
      const now = NOW; // 2026-09-21T12:00:00Z
      server.add(
        'INBOX',
        fakeMessage({
          messageId: '<future@x>',
          references: [],
          from: 'Client <client@work.test>',
          to: ['owner@example.test'],
          // A forged or clock-skewed header, decades out.
          date: new Date('2099-01-01T00:00:00Z'),
          // The server's own clock is sane; ordering follows this.
          internalDate: now,
        }),
      );
      const ctx = sourceContext();
      await source(server).poll(ctx);

      expect(ctx.runs).toHaveLength(1);
      expect(await threads()).toEqual([
        { id: expect.any(String), subject: 'Hello', state: 'waiting-on-me', n: 1, last: 'in' },
      ]);
      const { rows } = await pool.query(`select date from email.messages where message_id = '<future@x>'`);
      const stored = new Date(rows[0].date as string);
      // Pulled back to at most a day past the ingest clock, not stored verbatim.
      expect(stored.getTime()).toBeLessThanOrEqual(now.getTime() + 25 * 60 * 60 * 1000);
      expect(stored.getTime()).toBeGreaterThan(now.getTime());
    });

    it('falls back to the poll clock when the server gives no INTERNALDATE', async () => {
      const server = serverWithSent();
      server.add(
        'INBOX',
        fakeMessage({
          messageId: '<no-internal@x>',
          references: [],
          from: 'Client <client@work.test>',
          to: ['owner@example.test'],
          date: new Date('2026-09-18T09:00:00Z'),
          internalDate: null,
        }),
      );
      const ctx = sourceContext();
      await source(server).poll(ctx);

      expect(ctx.runs).toHaveLength(1);
      const built = await threads();
      expect(built).toEqual([
        { id: expect.any(String), subject: 'Hello', state: 'waiting-on-me', n: 1, last: 'in' },
      ]);
      const { rows } = await pool.query(`select last_at from email.threads`);
      // last_at was set from the poll's own clock (NOW), not left null and
      // not taken from the header date.
      expect(new Date(rows[0].last_at as string).toISOString()).toBe(NOW.toISOString());
    });

    it('breaks a tie on equal INTERNALDATE deterministically — folder then uid, never call order', async () => {
      const [folderA, folderB] = await twoFolders();
      const at = new Date('2026-09-20T09:00:00Z');

      // Same two facts — an inbound message in A, an outbound one in B, with
      // the identical clock value — joined in one order, then the other.
      const forwardId1 = await insertMessage({ folderId: folderA, uid: 5, from: 'client@work.test', direction: 'in' });
      await joinThread(pool, {
        accountId,
        threadKey: '<tie-1@work.test>',
        messageRowId: forwardId1,
        subject: 'Tie',
        participants: ['client@work.test'],
        at,
        folderId: folderA,
        uid: 5,
        direction: 'in',
      });
      const forwardId2 = await insertMessage({ folderId: folderB, uid: 3, from: 'owner@example.test', direction: 'out' });
      const forward = await joinThread(pool, {
        accountId,
        threadKey: '<tie-1@work.test>',
        messageRowId: forwardId2,
        subject: 'Tie',
        participants: ['owner@example.test'],
        at,
        folderId: folderB,
        uid: 3,
        direction: 'out',
      });

      const backwardId2 = await insertMessage({
        folderId: folderB,
        uid: 3,
        from: 'owner@example.test',
        direction: 'out',
        uidvalidity: 2,
      });
      await joinThread(pool, {
        accountId,
        threadKey: '<tie-2@work.test>',
        messageRowId: backwardId2,
        subject: 'Tie',
        participants: ['owner@example.test'],
        at,
        folderId: folderB,
        uid: 3,
        direction: 'out',
      });
      const backwardId1 = await insertMessage({
        folderId: folderA,
        uid: 5,
        from: 'client@work.test',
        direction: 'in',
        uidvalidity: 2,
      });
      const backward = await joinThread(pool, {
        accountId,
        threadKey: '<tie-2@work.test>',
        messageRowId: backwardId1,
        subject: 'Tie',
        participants: ['client@work.test'],
        at,
        folderId: folderA,
        uid: 5,
        direction: 'in',
      });

      // Same two messages, same clock, opposite call order — the same one
      // must win both times.
      expect(forward.lastDirection).toBe(backward.lastDirection);
    });

    it('uses UIDVALIDITY and then message id to break otherwise exact ties', async () => {
      const [folder] = await twoFolders();
      const at = new Date('2026-09-20T09:00:00Z');
      const older = await insertMessage({ folderId: folder, uid: 7, uidvalidity: 1, from: 'client@work.test', direction: 'in' });
      const newer = await insertMessage({ folderId: folder, uid: 7, uidvalidity: 2, from: 'owner@example.test', direction: 'out' });
      await joinThread(pool, { accountId, threadKey: '<generation-tie>', messageRowId: newer, subject: 'Tie', participants: [], at, folderId: folder, uidValidity: 2, uid: 7, direction: 'out' });
      const result = await joinThread(pool, { accountId, threadKey: '<generation-tie>', messageRowId: older, subject: 'Tie', participants: [], at, folderId: folder, uidValidity: 1, uid: 7, direction: 'in' });
      expect(result.lastDirection).toBe('out');

      const inboundId = await insertMessage({ folderId: folder, uid: 8, uidvalidity: 2, from: 'client@work.test', direction: 'in' });
      const outboundId = await insertMessage({ folderId: folder, uid: 9, uidvalidity: 2, from: 'owner@example.test', direction: 'out' });
      const sortedIds = [inboundId, outboundId].sort();
      const lowerId = sortedIds[0]!;
      const higherId = sortedIds[1]!;
      const directionById = new Map([
        [inboundId, 'in' as const],
        [outboundId, 'out' as const],
      ]);
      await joinThread(pool, { accountId, threadKey: '<row-id-tie>', messageRowId: higherId, subject: 'Tie', participants: [], at, folderId: folder, uidValidity: 2, uid: 10, direction: directionById.get(higherId)! });
      const exactTie = await joinThread(pool, { accountId, threadKey: '<row-id-tie>', messageRowId: lowerId, subject: 'Tie', participants: [], at, folderId: folder, uidValidity: 2, uid: 10, direction: directionById.get(lowerId)! });
      expect(exactTie.lastDirection).toBe(directionById.get(higherId));
      const { rows: rowTie } = await pool.query(
        `select last_message_id from email.threads where account_id = $1 and thread_key = '<row-id-tie>'`,
        [accountId],
      );
      expect(String(rowTie[0].last_message_id)).toBe(higherId);
    });

    it('caps participants and adds uncapped incoming participants to conflict overflow', async () => {
      const [folder] = await twoFolders();
      const id = await insertMessage({ folderId: folder, uid: 90, from: 'sender@example.test', direction: 'in' });
      const participants = Array.from({ length: 60 }, (_, i) => `person-${i}@example.test`);
      const first = await joinThread(pool, { accountId, threadKey: '<crowd>', messageRowId: id, subject: 'Crowd', participants: [...participants, participants[0]!], at: NOW, folderId: folder, uidValidity: 1, uid: 90, direction: 'in' });
      expect(first.participants).toHaveLength(50);
      expect(first.participantsOverflow).toBe(10);

      const secondId = await insertMessage({ folderId: folder, uid: 91, from: 'next@example.test', direction: 'in' });
      const newcomers = Array.from({ length: 60 }, (_, i) => `new-${i}@example.test`);
      const second = await joinThread(pool, { accountId, threadKey: '<crowd>', messageRowId: secondId, subject: 'Crowd', participants: newcomers, at: NOW, folderId: folder, uidValidity: 1, uid: 91, direction: 'in' });
      expect(second.participants).toHaveLength(50);
      expect(second.participantsOverflow).toBe(70);
    });
  });

  it('returns fifty thread choices for the requested account, independent of busier accounts', async () => {
    const { rows: second } = await pool.query(
      `insert into email.accounts
         (address, imap_host, imap_port, smtp_host, smtp_port, auth_mode, secret_name)
       values ('choice@example.test', 'imap.example.test', 993, 'smtp.example.test', 465, 'app-password', 'CHOICE_SECRET') returning id`,
    );
    const account2 = String(second[0].id);
    await pool.query(
      `insert into email.threads (account_id, thread_key, subject, last_at)
       select a, 'thread-' || n, 'subject-' || n, $3::timestamptz + n * interval '1 minute'
         from unnest(array[$1::uuid, $2::uuid]) a cross join generate_series(1, 60) n`,
      [accountId, account2, NOW],
    );
    const view = await policiesView(pool, account2);
    expect(view.threads).toHaveLength(50);
    expect(view.threads.every((thread) => thread.accountId === account2)).toBe(true);
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
      // The inbox message is discovered on a first poll — and a newly found
      // Sent folder plants its cursor at UIDNEXT-1 regardless of backfill, so
      // the reply below has to arrive on a *later* poll to be seen.
      await source(server).poll(sourceContext());
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
