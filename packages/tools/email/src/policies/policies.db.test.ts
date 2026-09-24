/**
 * Policies end to end, against a throwaway database and a fake IMAP server.
 *
 * Skipped unless DATABASE_URL is set. It never touches the developer's data:
 * the suite creates its own database, migrates core plus this plugin into it,
 * and drops it at the end. No socket is opened to any mailbox, and no model is
 * called — the gate is deterministic by construction, which is what lets the
 * measurement at the end of this file mean anything.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, runMigrations } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { ensureGmailAccount, GMAIL_SECRET_NAME } from '../config.js';
import { FakeImapServer, fakeMessage } from '../imap/fake.js';
import { manifest } from '../index.js';
import { createInboxPollSource } from '../sources/inbox-poll.js';
import { listPolicies, policyLists, revokeEmailPolicy, setPolicy, policiesView } from '../tools/policies.js';
import { policyLine } from '../pages/format.js';
import { triageRecord } from '../tools/triage.js';
import { PROCESSING_VERSION } from '../tools/shared.js';
import type { SourceContext, ToolContext } from '../types.js';
import { bulkPolicies, createPolicy, loadPolicies, seedLearnedIgnorePolicies } from './store.js';
import { adoptProposedPolicies, applyLearnedPolicy, revokeLearnedPolicy } from './learned.js';
import { getProposal, keepProposal, listOpenProposals, type Proposal as CoreProposal } from '@buddi/core';

const FULL_SYNC = 10_000;
const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_email_pol_test_${process.pid}`;
const ENV = { GMAIL_USER: 'owner@example.test', [GMAIL_SECRET_NAME]: 'app-password' };
const NOW = new Date('2026-09-21T12:00:00Z');

suite('email policies (postgres + fake imap)', () => {
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

  beforeEach(async () => {
    await pool.query(
      'truncate email.events, email.policies, email.drafts, email.triage, email.messages, email.folders, email.accounts cascade',
    );
    await pool.query('truncate core.proposals');
    const account = await ensureGmailAccount(pool, ENV);
    accountId = account!.id;
    const { rows } = await pool.query(
      `insert into email.folders (account_id, name) values ($1, 'INBOX') returning id`,
      [accountId],
    );
    mailboxId = String(rows[0].id);
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

  /**
   * One stored message, without going through IMAP: history, already handled.
   * The enqueue stamp is set, because an unstamped row is by definition one the
   * next poll owes a run — that is the source's recovery contract, not a fixture.
   */
  let uid = 1000;
  async function storeMessage(over: {
    from: string;
    subject?: string;
    at?: string;
    listId?: string | null;
  }): Promise<string> {
    uid += 1;
    const { rows } = await pool.query(
      `insert into email.messages
         (account_id, folder_id, uidvalidity, uid, message_id, thread_key, list_id, from_addr,
          to_addrs, subject, date, snippet, body_text, triage_enqueued_at)
       values ($1, $2, 1, $3, $4, $4, $5, $6, '["owner@example.test"]'::jsonb, $7, $8, '', '', now())
       returning id`,
      [
        accountId,
        mailboxId,
        uid,
        `<m${uid}@example.test>`,
        over.listId ?? null,
        over.from,
        over.subject ?? 'Subject',
        over.at ?? `2026-09-${String((uid % 20) + 1).padStart(2, '0')}T09:00:00Z`,
      ],
    );
    return String(rows[0].id);
  }

  async function verdict(messageId: string, category: string, urgency: string): Promise<void> {
    await pool.query(
      `insert into email.triage (message_id, processing_version, category, urgency, summary, decided_at)
       values ($1, $2, $3, $4, 'seeded', now())
       on conflict (message_id, processing_version) do update set category = excluded.category`,
      [messageId, PROCESSING_VERSION, category, urgency],
    );
  }

  async function sentDraftTo(address: string): Promise<void> {
    await pool.query(
      `insert into email.drafts (to_addrs, body_text, created_by_agent, sent_at)
       values ($1::jsonb, 'body', 'mail-triage', now())`,
      [JSON.stringify([address])],
    );
  }

  /* ---------------------------------------------------------------- backfill */

  describe('the backfill', () => {
    it('seeds one learned ignore per sender with three promo verdicts and no reply', async () => {
      for (let i = 0; i < 3; i += 1) {
        await verdict(await storeMessage({ from: 'news@shop.test' }), 'promo', 'low');
      }
      // Two is not a pattern.
      for (let i = 0; i < 2; i += 1) {
        await verdict(await storeMessage({ from: 'other@shop.test' }), 'promo', 'low');
      }
      // Three, but the owner writes back.
      for (let i = 0; i < 3; i += 1) {
        await verdict(await storeMessage({ from: 'friend@people.test' }), 'promo', 'low');
      }
      await sentDraftTo('friend@people.test');

      const written = await seedLearnedIgnorePolicies(pool, NOW);
      expect(written).toBe(1);

      const policies = await loadPolicies(pool, accountId);
      expect(policies).toHaveLength(1);
      expect(policies[0]).toMatchObject({
        scope: 'sender',
        matcher: 'news@shop.test',
        action: 'ignore',
        origin: 'learned',
        // Proposed, not applied: only INBOX is synced, so "never wrote back"
        // is an inference (docs/specs/email.md §3). The owner keeps it on the page.
        proposed: true,
      });
      // It says which verdicts it was learned from.
      expect(policies[0]!.createdFrom).toHaveLength(3);
      expect(policies[0]!.createdFrom[0]).toHaveProperty('messageId');
    });

    it('seeds a proposal, never a rule, from three low verdicts that are not promo', async () => {
      // The review's case: three `service-notice`/`personal` verdicts, all
      // low. The streak is real, so it is worth suggesting; it is not
      // marketing, and nothing here has read the owner's Sent folder, so it
      // decides nothing until they say so.
      for (const category of ['service-notice', 'personal', 'other']) {
        await verdict(await storeMessage({ from: 'quiet@service.test' }), category, 'low');
      }
      expect(await seedLearnedIgnorePolicies(pool, NOW)).toBe(1);

      const [policy] = await loadPolicies(pool, accountId);
      expect(policy).toMatchObject({
        scope: 'sender',
        matcher: 'quiet@service.test',
        action: 'ignore',
        origin: 'learned',
        proposed: true,
      });

      // And a proposal decides nothing: the next message still starts a run.
      const server = new FakeImapServer();
      server.add('INBOX', fakeMessage({ from: 'quiet@service.test', messageId: '<q1@x>' }));
      const ctx = sourceContext();
      await createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC }).poll(ctx);
      expect(ctx.runs).toHaveLength(1);
    });

    it('counts the run from the newest verdict back, so one dissent resets it', async () => {
      await verdict(await storeMessage({ from: 'mixed@shop.test', at: '2026-09-01T09:00:00Z' }), 'promo', 'low');
      await verdict(await storeMessage({ from: 'mixed@shop.test', at: '2026-09-02T09:00:00Z' }), 'promo', 'low');
      await verdict(await storeMessage({ from: 'mixed@shop.test', at: '2026-09-03T09:00:00Z' }), 'reply-needed', 'normal');
      await verdict(await storeMessage({ from: 'mixed@shop.test', at: '2026-09-04T09:00:00Z' }), 'promo', 'low');

      expect(await seedLearnedIgnorePolicies(pool, NOW)).toBe(0);
    });

    it('is idempotent — a second run writes nothing', async () => {
      for (let i = 0; i < 3; i += 1) {
        await verdict(await storeMessage({ from: 'news@shop.test' }), 'promo', 'low');
      }
      expect(await seedLearnedIgnorePolicies(pool, NOW)).toBe(1);
      expect(await seedLearnedIgnorePolicies(pool, NOW)).toBe(0);
    });
  });

  /* ------------------------------------------------------- the gate, in situ */

  describe('the gate in the poll', () => {
    async function pollWith(
      messages: Array<Parameters<typeof fakeMessage>[0]>,
    ): Promise<ReturnType<typeof sourceContext>> {
      const server = new FakeImapServer();
      for (const m of messages) server.add('INBOX', fakeMessage(m));
      const source = createInboxPollSource({
        connect: server.factory(),
        env: ENV,
        backfill: FULL_SYNC,
      });
      const ctx = sourceContext();
      await source.poll(ctx);
      return ctx;
    }

    it('starts no run for a matching sender, writes the triage row, and records an event', async () => {
      await createPolicy(
        pool,
        { accountId, scope: 'sender', matcher: 'news@shop.test', action: 'ignore', origin: 'owner' },
        NOW,
      );
      const ctx = await pollWith([
        { from: 'news@shop.test', subject: 'Half price', messageId: '<n1@x>' },
        { from: 'human@people.test', subject: 'Lunch?', messageId: '<n2@x>' },
      ]);

      expect(ctx.runs).toHaveLength(1);
      expect(ctx.runs[0]!.prompt).toContain('Lunch?');

      const { rows: triage } = await pool.query(
        `select t.category, t.urgency, t.summary from email.triage t
           join email.messages m on m.id = t.message_id where m.from_addr = 'news@shop.test'`,
      );
      expect(triage).toHaveLength(1);
      expect(triage[0]).toMatchObject({ category: 'promo', urgency: 'low' });
      expect(triage[0].summary).toMatch(/standing policy/);

      const { rows: events } = await pool.query(
        `select e.action, e.detail, e.policy_id, m.from_addr from email.events e
           join email.messages m on m.id = e.message_id order by m.uid`,
      );
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ action: 'ignore', from_addr: 'news@shop.test' });
      expect(events[0].policy_id).not.toBeNull();
      expect(events[1]).toMatchObject({ action: 'none', policy_id: null });

      // Both messages are stamped: the ignored one is *handled*, not pending.
      const { rows: pending } = await pool.query(
        `select count(*)::int as n from email.messages where triage_enqueued_at is null`,
      );
      expect(pending[0].n).toBe(0);
    });

    it('hands the run to the named agent', async () => {
      await createPolicy(
        pool,
        {
          accountId,
          scope: 'domain',
          matcher: 'bank.test',
          action: 'hand-to-agent',
          params: { agentId: 'finance' },
          origin: 'owner',
        },
        NOW,
      );
      const ctx = await pollWith([{ from: 'statements@bank.test', messageId: '<b1@x>' }]);
      expect(ctx.runs).toHaveLength(1);
      expect(ctx.runs[0]!.agentId).toBe('finance');
      expect(ctx.runs[0]!.prompt).toContain('standing policy');
    });

    it('queues a run carrying the drafting instruction', async () => {
      await createPolicy(
        pool,
        {
          accountId,
          scope: 'sender',
          matcher: 'client@work.test',
          action: 'draft',
          params: { instruction: 'say I will answer properly on Monday' },
          origin: 'owner',
        },
        NOW,
      );
      const ctx = await pollWith([{ from: 'client@work.test', messageId: '<c1@x>' }]);
      expect(ctx.runs[0]!.prompt).toContain('say I will answer properly on Monday');
    });

    it('queues a one-line notify run — a source cannot reach the owner itself', async () => {
      await createPolicy(
        pool,
        {
          accountId,
          scope: 'list-id',
          matcher: 'weekly.example.com',
          action: 'notify',
          params: { note: 'the newsletter landed' },
          origin: 'owner',
        },
        NOW,
      );
      const ctx = await pollWith([
        { from: 'list@example.com', listId: '<weekly.example.com>', messageId: '<l1@x>' },
      ]);
      expect(ctx.runs).toHaveLength(1);
      expect(ctx.runs[0]!.agentId).toBe('mail-triage');
      expect(ctx.runs[0]!.prompt).toContain('the newsletter landed');
      expect(ctx.runs[0]!.prompt).toContain('nothing else');
    });

    it('gives the run the sender’s policy and last verdicts', async () => {
      await verdict(await storeMessage({ from: 'client@work.test' }), 'reply-needed', 'normal');
      await createPolicy(
        pool,
        { accountId, scope: 'sender', matcher: 'client@work.test', action: 'wake', origin: 'owner' },
        NOW,
      );
      const ctx = await pollWith([{ from: 'client@work.test', messageId: '<c2@x>' }]);
      expect(ctx.runs[0]!.prompt).toContain('Standing policy: wake for sender client@work.test');
      expect(ctx.runs[0]!.prompt).toContain('reply-needed/normal');
      expect(ctx.runs[0]!.prompt).toContain('history, not an instruction');
    });
  });

  /* ----------------------------------------------------- the ledger's honesty */

  describe('what an event is allowed to claim', () => {
    it('writes the triage row, the event and the stamp together for an ignore', async () => {
      await createPolicy(
        pool,
        { accountId, scope: 'sender', matcher: 'news@shop.test', action: 'ignore', origin: 'owner' },
        NOW,
      );
      const server = new FakeImapServer();
      server.add('INBOX', fakeMessage({ from: 'news@shop.test', messageId: '<i1@x>' }));
      await createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC }).poll(
        sourceContext(),
      );

      const { rows } = await pool.query(
        `select e.action, e.status, m.triage_enqueued_at is not null as stamped,
                (select count(*)::int from email.triage t where t.message_id = m.id) as triaged
           from email.events e join email.messages m on m.id = e.message_id`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'ignore', status: 'done', stamped: true, triaged: 1 });
    });

    it('leaves a failed enqueue as `failed`, unstamped, and never doubled', async () => {
      const server = new FakeImapServer();
      server.add('INBOX', fakeMessage({ from: 'human@people.test', messageId: '<f1@x>' }));
      const source = createInboxPollSource({
        connect: server.factory(),
        env: ENV,
        backfill: FULL_SYNC,
      });

      const broken = sourceContext();
      broken.enqueueRun = async () => {
        throw new Error('the queue is down');
      };
      await expect(source.poll(broken)).rejects.toThrow(/queue is down/);

      const failed = await pool.query(
        `select e.action, e.status, e.detail, m.triage_enqueued_at
           from email.events e join email.messages m on m.id = e.message_id`,
      );
      expect(failed.rows).toHaveLength(1);
      expect(failed.rows[0]).toMatchObject({ action: 'none', status: 'failed' });
      expect(failed.rows[0].detail).toMatch(/could not be queued/);
      // Unstamped, so the message is still owed a run.
      expect(failed.rows[0].triage_enqueued_at).toBeNull();

      // The next poll picks the same message up again and updates that one
      // row rather than writing a second decision about one message.
      const again = sourceContext();
      const retry = new FakeImapServer();
      const retrySource = createInboxPollSource({
        connect: retry.factory(),
        env: ENV,
        backfill: FULL_SYNC,
      });
      await retrySource.poll(again);
      expect(again.runs).toHaveLength(1);

      const after = await pool.query(
        `select e.status, m.triage_enqueued_at is not null as stamped,
                count(*) over ()::int as events
           from email.events e join email.messages m on m.id = e.message_id`,
      );
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0]).toMatchObject({ status: 'done', stamped: true });
    });
  });

  /* ------------------------------------------------------------- the learning */

  describe('learning after three verdicts', () => {
    it('proposes an ignore once the third promo verdict is recorded, and applies nothing', async () => {
      const ids = [
        await storeMessage({ from: 'news@shop.test', at: '2026-09-01T09:00:00Z' }),
        await storeMessage({ from: 'news@shop.test', at: '2026-09-02T09:00:00Z' }),
        await storeMessage({ from: 'news@shop.test', at: '2026-09-03T09:00:00Z' }),
      ];
      const ctx = toolContext();
      await triageRecord.execute(
        { messageId: ids[0]!, category: 'promo', urgency: 'low', summary: 'ad' },
        ctx,
      );
      await triageRecord.execute(
        { messageId: ids[1]!, category: 'promo', urgency: 'low', summary: 'ad' },
        ctx,
      );
      expect(await loadPolicies(pool, accountId)).toHaveLength(0);

      const third = (await triageRecord.execute(
        { messageId: ids[2]!, category: 'promo', urgency: 'low', summary: 'ad' },
        ctx,
      )) as { learnedPolicy?: { action: string; proposed: boolean; proposal: string } };
      expect(third.learnedPolicy).toMatchObject({ action: 'ignore', proposed: true });

      // It is a card on the owner's inbox, not a row in this plugin: nothing
      // is written here until the owner keeps it.
      expect(await loadPolicies(pool, accountId)).toHaveLength(0);
      const open = await listOpenProposals(pool);
      expect(open).toHaveLength(1);
      const card = open[0]!;
      expect(card.id).toBe(third.learnedPolicy!.proposal);
      expect(card).toMatchObject({ kind: 'policy', agent: 'mail-triage', untrusted: true });
      expect(card.payload).toMatchObject({
        plugin: 'email',
        matcher: { sender: 'news@shop.test', account: 'owner@example.test', accountId },
        action: 'ignore',
        params: { category: 'promo', urgency: 'low' },
      });
      expect(card.payload.verdicts).toHaveLength(3);
      // Mail is untrusted: the messages are its sources, by subject and sender only.
      expect(card.provenance.sources).toHaveLength(3);
      expect(card.provenance.sources[0]).toMatchObject({ kind: 'mail', via: 'email.triage_record' });
      expect(card.provenance.sources[0]!.ref).toBe('"Subject" from news@shop.test');

      // A fourth verdict proposes nothing new: the same card is already waiting.
      const fourth = await storeMessage({ from: 'news@shop.test', at: '2026-09-04T09:00:00Z' });
      const again = (await triageRecord.execute(
        { messageId: fourth, category: 'promo', urgency: 'low', summary: 'ad' },
        ctx,
      )) as { learnedPolicy?: unknown };
      expect(again.learnedPolicy).toBeUndefined();
      expect(await listOpenProposals(pool)).toHaveLength(1);

      // Nothing applied itself: the fourth message from them still runs.
      const server = new FakeImapServer();
      server.add('INBOX', fakeMessage({ from: 'news@shop.test', messageId: '<n4@x>' }));
      const poll = sourceContext();
      await createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC }).poll(poll);
      expect(poll.runs).toHaveLength(1);
    });

    it('never counts another mailbox\u2019s verdicts', async () => {
      // Two promos here, one there. Neither account has three, and the
      // learning must not add them up: a work rule learned from personal mail
      // is a rule about mail that never arrived at work.
      const { rows } = await pool.query(
        `insert into email.accounts
           (address, imap_host, imap_port, smtp_host, smtp_port, auth_mode, secret_name, added_via)
         values ('other@example.test', 'imap.example.test', 993, 'smtp.example.test', 465,
                 'app-password', 'EMAIL_OTHER_EXAMPLE_TEST_00000000', 'page')
         returning id`,
      );
      const otherAccount = String(rows[0].id);
      const { rows: mb } = await pool.query(
        `insert into email.folders (account_id, name) values ($1, 'INBOX') returning id`,
        [otherAccount],
      );
      const otherMailbox = String(mb[0].id);

      const ctx = toolContext();
      for (const at of ['2026-09-01T09:00:00Z', '2026-09-02T09:00:00Z']) {
        const id = await storeMessage({ from: 'news@shop.test', at });
        await triageRecord.execute(
          { messageId: id, category: 'promo', urgency: 'low', summary: 'ad' },
          ctx,
        );
      }
      const { rows: far } = await pool.query(
        `insert into email.messages
           (account_id, folder_id, uidvalidity, uid, message_id, thread_key, from_addr,
            to_addrs, subject, date, snippet, body_text, triage_enqueued_at)
         values ($1, $2, 1, 9001, '<far@example.test>', '<far@example.test>', 'news@shop.test',
                 '["other@example.test"]'::jsonb, 'Subject', '2026-09-03T09:00:00Z', '', '', now())
         returning id`,
        [otherAccount, otherMailbox],
      );
      await triageRecord.execute(
        { messageId: String(far[0].id), category: 'promo', urgency: 'low', summary: 'ad' },
        ctx,
      );

      // Three promos from that sender exist on this installation; no account
      // has three, so nothing is learned anywhere.
      expect(await loadPolicies(pool, accountId)).toHaveLength(0);
      expect(await loadPolicies(pool, otherAccount)).toHaveLength(0);
      expect(await listOpenProposals(pool)).toHaveLength(0);
    });

    it('proposes nothing to silence a sender the owner has written to', async () => {
      await pool.query(
        `insert into email.messages
           (account_id, folder_id, uidvalidity, uid, message_id, thread_key, from_addr, to_addrs,
            subject, date, snippet, body_text, direction)
         values ($1, $2, 1, 7777, '<out@x>', '<out@x>', 'owner@example.test', '["news@shop.test"]'::jsonb,
                 'hi', '2026-08-01T09:00:00Z', '', '', 'out')`,
        [accountId, mailboxId],
      );
      const ctx = toolContext();
      for (let i = 0; i < 3; i += 1) {
        const id = await storeMessage({ from: 'news@shop.test', at: `2026-09-0${i + 1}T09:00:00Z` });
        await triageRecord.execute({ messageId: id, category: 'promo', urgency: 'low', summary: 'ad' }, ctx);
      }
      expect(await listOpenProposals(pool)).toHaveLength(0);
    });

    it('applies a kept card as a kept row the gate reads, and revokes it through the same plugin', async () => {
      const ctx = toolContext();
      for (let i = 0; i < 3; i += 1) {
        const id = await storeMessage({ from: 'news@shop.test', at: `2026-09-0${i + 1}T09:00:00Z` });
        await triageRecord.execute({ messageId: id, category: 'promo', urgency: 'low', summary: 'ad' }, ctx);
      }
      const [card] = await listOpenProposals(pool);
      const kept = (await keepProposal(pool, { id: card!.id, now: NOW })) as CoreProposal;
      const applied = await manifest.policies!.apply(kept, { db: pool, now: NOW });
      expect(applied).toMatchObject({ ok: true });
      const rules = await loadPolicies(pool, accountId);
      expect(rules).toHaveLength(1);
      expect(rules[0]).toMatchObject({ matcher: 'news@shop.test', action: 'ignore', origin: 'learned', proposed: false });
      expect(rules[0]!.createdFrom).toHaveLength(3);

      // Kept, it decides: the next message from them starts no run.
      const server = new FakeImapServer();
      server.add('INBOX', fakeMessage({ from: 'news@shop.test', messageId: '<k4@x>' }));
      const poll = sourceContext();
      await createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC }).poll(poll);
      expect(poll.runs).toHaveLength(0);
      // And the digest can say so: the gate acted once this week on a rule the owner kept.
      const week = new Date(NOW.getTime() - 7 * 24 * 60 * 60 * 1000);
      expect(await manifest.policies!.applied!({ db: pool, now: NOW }, week)).toBe(1);
      expect(await manifest.policies!.applied!({ db: pool, now: new Date(NOW.getTime() + 60_000) }, new Date(NOW.getTime() + 1))).toBe(0);

      // The plugin's revoke takes back exactly the rule this card became.
      expect(await revokeLearnedPolicy(kept, { db: pool, now: NOW })).toEqual({ note: 'Revoked the email rule about news@shop.test.' });
      expect(await loadPolicies(pool, accountId)).toHaveLength(0);
      expect(await revokeLearnedPolicy(kept, { db: pool, now: NOW })).toEqual({ note: 'Nothing to revoke: it was never kept.' });
    });

    it('lists a rule kept from Proposals first, saying when it was kept', async () => {
      const LATER = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);
      // An older rule the owner wrote, and one learned and added long ago.
      await createPolicy(pool, { accountId, scope: 'sender', matcher: 'mine@shop.test', action: 'ignore', origin: 'owner' }, new Date(NOW.getTime() - 60_000));
      await createPolicy(pool, { accountId, scope: 'sender', matcher: 'old@shop.test', action: 'ignore', origin: 'learned' }, NOW);
      const ctx = toolContext();
      for (let i = 0; i < 3; i += 1) {
        const id = await storeMessage({ from: 'news@shop.test', at: `2026-09-0${i + 1}T09:00:00Z` });
        await triageRecord.execute({ messageId: id, category: 'promo', urgency: 'low', summary: 'ad' }, ctx);
      }
      const [card] = await listOpenProposals(pool);
      const kept = (await keepProposal(pool, { id: card!.id, now: LATER })) as CoreProposal;
      await manifest.policies!.apply(kept, { db: pool, now: LATER });

      const { applied } = await policyLists(pool);
      expect(applied.map((p) => p.matcher)).toEqual(['news@shop.test', 'old@shop.test', 'mine@shop.test']);
      expect(applied[0]!.keptAt).toBe(LATER.toISOString());
      expect(applied[1]!.keptAt).toBeNull();
      const soon = new Date(LATER.getTime() + 7 * 60_000);
      expect(policyLine(applied[0]!, soon)).toMatch(/· kept 7 minutes ago$/);
      expect(policyLine(applied[1]!, soon)).not.toMatch(/kept/);
    });

    it('refuses to apply a card that is not an email rule it can write', async () => {
      const bogus = {
        id: 'x', kind: 'policy', agent: 'a', payload: { plugin: 'email', matcher: { sender: 'a@b.test', accountId }, action: 'archive' },
      } as unknown as CoreProposal;
      const refused = await applyLearnedPolicy(bogus, { db: pool, now: NOW });
      expect(refused.ok).toBe(false);
      expect(await applyLearnedPolicy({ ...bogus, payload: { plugin: 'finance' } } as CoreProposal, { db: pool, now: NOW }))
        .toMatchObject({ ok: false });
      expect(await loadPolicies(pool, accountId)).toHaveLength(0);
    });

    it('moves the old proposed rows into core once, and leaves kept rows alone', async () => {
      const ids = [
        await storeMessage({ from: 'old@shop.test', subject: 'Sale', at: '2026-09-01T09:00:00Z' }),
        await storeMessage({ from: 'old@shop.test', subject: 'Sale 2', at: '2026-09-02T09:00:00Z' }),
      ];
      await createPolicy(pool, {
        accountId, scope: 'sender', matcher: 'old@shop.test', action: 'ignore', origin: 'learned', proposed: true,
        params: { category: 'promo', urgency: 'low' },
        createdFrom: ids.map((messageId) => ({ messageId, processingVersion: PROCESSING_VERSION })),
      }, NOW);
      await createPolicy(pool, {
        accountId, scope: 'sender', matcher: 'kept@shop.test', action: 'ignore', origin: 'learned', proposed: false,
      }, NOW);

      expect(await adoptProposedPolicies({ db: pool, now: NOW })).toBe(1);
      const rows = await loadPolicies(pool, accountId);
      expect(rows.map((r) => [r.matcher, r.proposed])).toEqual([['kept@shop.test', false]]);
      const open = await listOpenProposals(pool);
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({ kind: 'policy', agent: 'email', untrusted: true });
      expect(open[0]!.payload).toMatchObject({ plugin: 'email', action: 'ignore', matcher: { sender: 'old@shop.test', accountId } });
      expect(open[0]!.provenance.sources.map((x) => x.ref)).toEqual(['"Sale" from old@shop.test', '"Sale 2" from old@shop.test']);

      // Idempotent: nothing is left to move, and the card is not doubled.
      expect(await adoptProposedPolicies({ db: pool, now: NOW })).toBe(0);
      expect(await listOpenProposals(pool)).toHaveLength(1);
      expect(await getProposal(pool, open[0]!.id)).not.toBeNull();
    });

    it('only proposes, never applies, when the pattern is not promo', async () => {
      const ctx = toolContext();
      for (let i = 0; i < 3; i += 1) {
        const id = await storeMessage({ from: 'colleague@work.test', at: `2026-09-0${i + 1}T09:00:00Z` });
        await triageRecord.execute(
          { messageId: id, category: 'reply-needed', urgency: 'normal', summary: 'asks' },
          ctx,
        );
      }
      expect(await loadPolicies(pool, accountId)).toHaveLength(0);
      const open = await listOpenProposals(pool);
      expect(open).toHaveLength(1);
      expect(open[0]!.payload).toMatchObject({ plugin: 'email', action: 'notify', matcher: { sender: 'colleague@work.test' } });

      // And a proposal decides nothing: the next message still starts a run.
      const server = new FakeImapServer();
      server.add('INBOX', fakeMessage({ from: 'colleague@work.test', messageId: '<z@x>' }));
      const src = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC });
      const poll = sourceContext();
      await src.poll(poll);
      expect(poll.runs).toHaveLength(1);
    });
  });

  /* ----------------------------------------------------------------- the tools */

  describe('the tools', () => {
    it('writes, lists and revokes a policy', async () => {
      const ctx = toolContext();
      const described = await setPolicy.describe(
        { scope: 'sender', matcher: 'News <News@Shop.test>', action: 'ignore' },
        ctx,
      );
      expect(described.envelope).toMatchObject({ matcher: 'news@shop.test', action: 'ignore' });
      expect(described.preview).toContain('news@shop.test');
      expect(described.preview).toContain('no triage run');

      const created = (await setPolicy.execute(
        { scope: 'sender', matcher: 'News <News@Shop.test>', action: 'ignore' },
        ctx,
      )) as { policy: { id: string; matcher: string } };
      expect(created.policy.matcher).toBe('news@shop.test');

      const listed = (await listPolicies.execute({}, ctx)) as {
        applied: Array<{ id: string }>;
        proposed: unknown[];
      };
      expect(listed.applied.map((p) => p.id)).toEqual([created.policy.id]);
      expect(listed.proposed).toHaveLength(0);

      const revokePreview = await revokeEmailPolicy.describe({ policyId: created.policy.id }, ctx);
      expect(revokePreview.preview).toContain('news@shop.test');
      await revokeEmailPolicy.execute({ policyId: created.policy.id }, ctx);

      const after = (await listPolicies.execute({}, ctx)) as { applied: unknown[] };
      expect(after.applied).toHaveLength(0);
    });

    it('refuses archive and label with "not yet"', async () => {
      const ctx = toolContext();
      await expect(
        setPolicy.execute({ scope: 'sender', matcher: 'a@b.test', action: 'archive' }, ctx),
      ).rejects.toThrow(/not yet/);
      await expect(
        setPolicy.execute({ scope: 'sender', matcher: 'a@b.test', action: 'label', label: 'Ads' }, ctx),
      ).rejects.toThrow(/not yet/);
      expect(await loadPolicies(pool, accountId)).toHaveLength(0);
    });

    it('replaces the live policy for the same matcher rather than duplicating it', async () => {
      const ctx = toolContext();
      await setPolicy.execute({ scope: 'sender', matcher: 'a@b.test', action: 'wake' }, ctx);
      await setPolicy.execute({ scope: 'sender', matcher: 'a@b.test', action: 'ignore' }, ctx);
      const live = await loadPolicies(pool, accountId);
      expect(live).toHaveLength(1);
      expect(live[0]!.action).toBe('ignore');
    });

    it('counts the runs each policy has saved, for the page', async () => {
      const policy = await createPolicy(
        pool,
        { accountId, scope: 'sender', matcher: 'news@shop.test', action: 'ignore', origin: 'owner' },
        NOW,
      );
      const server = new FakeImapServer();
      for (let i = 0; i < 4; i += 1) {
        server.add('INBOX', fakeMessage({ from: 'news@shop.test', messageId: `<s${i}@x>` }));
      }
      const src = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: FULL_SYNC });
      await src.poll(sourceContext());

      const view = await policiesView(pool);
      expect(view.applied).toHaveLength(1);
      expect(view.applied[0]).toMatchObject({ id: policy.id, runsSaved: 4, decisions: 4 });
      expect(view.proposed).toHaveLength(0);
    });
  });

  /*
   * Keeping and revoking a whole selection.
   *
   * The settings page can hold seventy-odd proposals, and the owner ticking
   * them made one decision — so it lands as one statement in one transaction,
   * and it touches the ids it was handed and no others. That last part is the
   * whole test: a bulk action that reached one row further than the selection
   * would be the page deciding something nobody chose.
   */
  describe('a whole selection at once', () => {
    async function three(): Promise<string[]> {
      const ids: string[] = [];
      for (const matcher of ['one@shop.test', 'two@shop.test', 'three@shop.test']) {
        const policy = await createPolicy(
          pool,
          { accountId, scope: 'sender', matcher, action: 'ignore', origin: 'learned', proposed: true },
          NOW,
        );
        ids.push(policy.id);
      }
      return ids;
    }

    it('keeps only the proposals named, and leaves the rest proposals', async () => {
      const [first, second, third] = await three();
      const result = await bulkPolicies(pool, 'keep', [first!, third!], NOW);
      expect(result).toEqual({ kept: 2, revoked: 0, missing: 0 });

      const view = await policiesView(pool);
      expect(view.applied.map((p) => p.matcher).sort()).toEqual(['one@shop.test', 'three@shop.test']);
      expect(view.proposed.map((p) => p.id)).toEqual([second]);
    });

    it('revokes only the rules named, and the others keep deciding', async () => {
      const [first, second, third] = await three();
      const result = await bulkPolicies(pool, 'revoke', [second!], NOW);
      expect(result).toEqual({ kept: 0, revoked: 1, missing: 0 });

      const live = (await loadPolicies(pool, accountId)).map((p) => p.id).sort();
      expect(live).toEqual([first, third].sort());
    });

    it('counts an id it could not touch as missing rather than failing the lot', async () => {
      const [first] = await three();
      await bulkPolicies(pool, 'revoke', [first!], NOW);
      // A revoked row is no longer something a keep can act on; the other id
      // is not a policy at all. Neither stops the one that is.
      const result = await bulkPolicies(
        pool,
        'keep',
        [first!, '00000000-0000-0000-0000-000000000000', (await three())[1]!],
        NOW,
      );
      expect(result).toMatchObject({ kept: 1, missing: 2 });
    });

    it('is idempotent, and does nothing for an empty selection', async () => {
      const [first] = await three();
      expect(await bulkPolicies(pool, 'revoke', [first!], NOW)).toMatchObject({ revoked: 1 });
      expect(await bulkPolicies(pool, 'revoke', [first!], NOW)).toMatchObject({ revoked: 1 });
      expect(await bulkPolicies(pool, 'keep', [], NOW)).toEqual({ kept: 0, revoked: 0, missing: 0 });
    });
  });

  /* ------------------------------------------------------------ the measurement */

  it('drops the run count on a day of synthetic headers', async () => {
    /*
     * docs/specs/email.md §12.6 — "model runs for mail drop by two thirds". This is
     * that measurement, on a synthetic day shaped like the one the review
     * described: about three quarters newsletters from a handful of repeat
     * senders, the rest genuine mail from people.
     */
    const newsletters = ['news@shop.test', 'deals@store.test', 'weekly@blog.test'];
    const people = ['jane@work.test', 'sam@work.test'];
    const day: Array<{ from: string; id: string }> = [];
    for (let i = 0; i < 30; i += 1) {
      day.push({ from: newsletters[i % newsletters.length]!, id: `<p${i}@x>` });
    }
    for (let i = 0; i < 10; i += 1) {
      day.push({ from: people[i % people.length]!, id: `<h${i}@x>` });
    }

    const before = new FakeImapServer();
    for (const m of day) before.add('INBOX', fakeMessage({ from: m.from, messageId: m.id }));
    const cold = sourceContext();
    await createInboxPollSource({
      connect: before.factory(),
      env: ENV,
      backfill: FULL_SYNC,
      limit: 50,
    }).poll(cold);
    expect(cold.runs).toHaveLength(40);

    // The same day again, once the three newsletters have been learned.
    await pool.query('truncate email.events, email.triage, email.messages cascade');
    // A fresh mailbox: same uids, same headers, nothing remembered but the rules.
    await pool.query('update email.folders set uidvalidity = null, last_uid = 0');
    for (const sender of newsletters) {
      await createPolicy(
        pool,
        { accountId, scope: 'sender', matcher: sender, action: 'ignore', origin: 'learned' },
        NOW,
      );
    }
    const after = new FakeImapServer();
    for (const m of day) after.add('INBOX', fakeMessage({ from: m.from, messageId: m.id }));
    const warm = sourceContext();
    await createInboxPollSource({
      connect: after.factory(),
      env: ENV,
      backfill: FULL_SYNC,
      limit: 50,
    }).poll(warm);

    expect(warm.runs).toHaveLength(10);
    expect(1 - warm.runs.length / cold.runs.length).toBeGreaterThanOrEqual(2 / 3);

    const { rows } = await pool.query(
      `select count(*)::int as n from email.events where action = 'ignore'`,
    );
    expect(rows[0].n).toBe(30);
  });
});
