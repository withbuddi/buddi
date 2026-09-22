/**
 * The draft lifecycle, against a real database (docs/specs/email.md §8).
 *
 * Four facts, and each of them is a thing that could quietly go wrong in a way
 * nobody would notice until a letter went out:
 *
 *  - a second `draft_reply` on a conversation **edits one draft** rather than
 *    stacking a second beside it (§12.4);
 *  - a draft the **owner** has edited is not overwritten by an agent, and the
 *    agent is told to read it first;
 *  - a draft that changed after a send was approved makes that approval
 *    **refused** — not failed, because nothing was dispatched;
 *  - a discarded or lapsed draft is refused at describe time, before anybody is
 *    asked to approve anything.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPool,
  decideApproval,
  executeApproved,
  getAction,
  runMigrations,
  ToolRegistry,
} from '@buddi/core';
import { ensureGmailAccount, GMAIL_SECRET_NAME } from '../config.js';
import { FakeImapServer, fakeMessage } from '../imap/fake.js';
import { createEmailManifest } from '../index.js';
import { FakeSmtpServer } from '../smtp/fake.js';
import { createInboxPollSource } from '../sources/inbox-poll.js';
import { createRetentionSource } from '../sources/retention.js';
import { lapseDueDrafts, liveDraftForThread, OWNER_EDITOR, updateDraftRow } from '../drafts.js';
import type { ToolContext } from '../types.js';
import { testDatabaseUrl } from '@buddi/core/testing';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_email_drafts_test_${process.pid}`;
const ENV = { GMAIL_USER: 'owner@example.test', [GMAIL_SECRET_NAME]: 'app-password' };
const NOW = new Date('2026-09-13T12:00:00Z');

suite('the draft lifecycle (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let dataDir: string;
  let smtp: FakeSmtpServer;
  let registry: ToolRegistry;
  let ctx: ToolContext;
  let messageId: string;

  const call = async (name: string, args: unknown, over: Partial<ToolContext> = {}): Promise<any> => {
    const result = await registry.invoke(name, args, { ...ctx, ...over });
    if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
    return result.output;
  };

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());

    dataDir = await mkdtemp(path.join(tmpdir(), 'buddi-email-drafts-'));
    process.env.BUDDI_DATA_DIR = dataDir;

    smtp = new FakeSmtpServer();
    const manifest = createEmailManifest({ send: smtp.factory(), env: ENV });
    await runMigrations(pool, [manifest]);
    registry = new ToolRegistry();
    registry.register(manifest);

    ctx = {
      db: pool,
      ownerId: 'test',
      now: () => NOW,
      timezone: 'UTC',
      agentId: 'mail-triage',
    };
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    delete process.env.BUDDI_DATA_DIR;
  });

  beforeEach(async () => {
    await pool.query(
      'truncate email.drafts, email.triage, email.messages, email.threads, email.folders, email.accounts cascade',
    );
    await pool.query('truncate core.actions cascade');
    await ensureGmailAccount(pool, ENV);
    const server = new FakeImapServer();
    server.add(
      'INBOX',
      fakeMessage({
        messageId: '<bank-1@bank.test>',
        from: 'alerts@bank.test',
        to: ['owner@example.test'],
        subject: 'Direct debit returned',
        bodyText: 'Your direct debit was returned unpaid.',
        flags: [],
        date: new Date('2026-09-12T08:00:00Z'),
      }),
    );
    const source = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: 1_000 });
    await source.poll({
      db: pool,
      now: ctx.now,
      timezone: 'UTC',
      log: () => {},
      enqueueRun: async () => {},
    });
    const { rows } = await pool.query(`select id from email.messages order by uid`);
    messageId = String(rows[0].id);
  });

  const countDrafts = async (): Promise<number> => {
    const { rows } = await pool.query(`select count(*)::int as n from email.drafts`);
    return rows[0].n as number;
  };

  describe('one conversation, one live draft', () => {
    it('updates the draft it already wrote instead of writing a second', async () => {
      const first = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'First try.' });
      expect(first.status).toBe('draft');
      expect(first.threadId).toBeTruthy();

      const second = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'Better.' });
      expect(second.id).toBe(first.id);
      expect(second.replaced).toBe(first.id);
      expect(second.bodyText).toBe('Better.');
      expect(await countDrafts()).toBe(1);
      // A new body is a new artifact version: the send envelope names it, and
      // that is what makes an approval over the old text refuse.
      expect(second.artifactId).not.toBe(first.artifactId);
    });

    it('always creates for a new message, which answers nothing', async () => {
      await call('email.draft_new', { to: 'a@x.test', subject: 'One', bodyText: 'Body one.' });
      await call('email.draft_new', { to: 'a@x.test', subject: 'Two', bodyText: 'Body two.' });
      expect(await countDrafts()).toBe(2);
    });

    it('will not write over what the owner edited, and says how to read it', async () => {
      const first = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'Agent words.' });
      await updateDraftRow({
        db: pool,
        draftId: first.id,
        to: first.to,
        cc: [],
        bcc: [],
        subject: first.subject,
        bodyText: 'The owner’s own words.',
        editedBy: OWNER_EDITOR,
        byOwner: true,
        now: NOW,
      });

      const again = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'Agent again.' });
      expect(again).toMatchObject({ wrote: false, ownerEdited: true, status: 'edited' });
      expect(again.bodyText).toBe('The owner’s own words.');
      expect(again.note).toContain('email.read_draft');
      // And the row is untouched.
      const live = await liveDraftForThread(pool, first.threadId as string);
      expect(live?.bodyText).toBe('The owner’s own words.');
      expect(live?.editedBy).toBe(OWNER_EDITOR);
    });

    it('reads a draft back through email.read_draft, by id or by thread', async () => {
      const first = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'Agent words.' });
      const byId = await call('email.read_draft', { draftId: first.id });
      expect(byId.draft).toMatchObject({ id: first.id, bodyText: 'Agent words.' });
      const byThread = await call('email.read_draft', { threadId: first.threadId });
      expect(byThread.draft.id).toBe(first.id);
    });
  });

  describe('a draft that moved under a standing approval', () => {
    /** Propose a send the way an agent does, and approve it. */
    const approvedSend = async (draftId: string): Promise<string> => {
      const proposal = await registry.invoke('email.send', { draftId }, ctx);
      if (proposal.ok || proposal.reason !== 'approval-required') {
        throw new Error('expected an approval request');
      }
      const decided = await decideApproval(pool, {
        actionId: proposal.actionId,
        decision: 'approved',
        by: 'owner',
        via: 'web',
        now: NOW,
      });
      expect(decided.ok).toBe(true);
      return proposal.actionId;
    };

    it('refuses the approval, says what changed, and sends nothing', async () => {
      const draft = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'Approved text.' });
      const actionId = await approvedSend(draft.id);

      // The owner edits it after approving — the exact race this exists for.
      await updateDraftRow({
        db: pool,
        draftId: draft.id,
        to: draft.to,
        cc: [],
        bcc: [],
        subject: draft.subject,
        bodyText: 'Completely different text.',
        editedBy: OWNER_EDITOR,
        byOwner: true,
        now: NOW,
      });

      const before = smtp.sent.length;
      const out = await executeApproved(pool, { actionId, registry, ctx, worker: 'w1', now: NOW });
      expect(out).toMatchObject({ ok: false, reason: 'effect-changed', state: 'refused' });
      expect(out.ok ? '' : out.message).toContain('has been edited since you approved it');
      expect(smtp.sent).toHaveLength(before);
      // Refused, not failed: nothing was dispatched, so nothing half-happened.
      expect((await getAction(pool, actionId))?.state).toBe('refused');
    });

    it('sends when nothing moved', async () => {
      const draft = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'Unchanged.' });
      const actionId = await approvedSend(draft.id);
      const before = smtp.sent.length;
      const out = await executeApproved(pool, { actionId, registry, ctx, worker: 'w1', now: NOW });
      expect(out.ok).toBe(true);
      expect(smtp.sent).toHaveLength(before + 1);
      const { rows } = await pool.query(`select status from email.drafts where id = $1`, [draft.id]);
      expect(rows[0].status).toBe('sent');
    });
  });

  describe('drafts that have ended', () => {
    it('refuses to describe a send for a discarded draft', async () => {
      const draft = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'Never mind.' });
      await pool.query(
        `update email.drafts set status = 'discarded', discarded_at = $2 where id = $1`,
        [draft.id, NOW],
      );
      const refused = await registry.invoke('email.send', { draftId: draft.id }, ctx);
      expect(refused).toMatchObject({ ok: false, reason: 'tool-error' });
      expect(refused.ok ? '' : refused.message).toContain('was discarded');
      // Refused before anybody was asked: no action was recorded at all.
      const { rows } = await pool.query(`select count(*)::int as n from core.actions`);
      expect(rows[0].n).toBe(0);
    });

    it('refuses to describe a send for a lapsed draft', async () => {
      const draft = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'Old news.' });
      await pool.query(`update email.drafts set status = 'lapsed', lapsed_at = $2 where id = $1`, [
        draft.id,
        NOW,
      ]);
      const refused = await registry.invoke('email.send', { draftId: draft.id }, ctx);
      expect(refused.ok ? '' : refused.message).toContain('lapsed');
    });
  });

  describe('the lapse sweep', () => {
    it('lapses a live draft nobody touched for a fortnight, and leaves a fresh one alone', async () => {
      const stale = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'A fortnight ago.' });
      await pool.query(`update email.drafts set updated_at = $2 where id = $1`, [
        stale.id,
        new Date(NOW.getTime() - 15 * 24 * 60 * 60 * 1000),
      ]);
      const fresh = await call('email.draft_new', { to: 'a@x.test', subject: 'New', bodyText: 'Fresh.' });

      const outcome = await lapseDueDrafts(pool, NOW);
      expect(outcome.lapsed).toBe(1);

      const { rows } = await pool.query(
        `select id, status from email.drafts where id = any($1::uuid[]) order by id`,
        [[stale.id, fresh.id]],
      );
      const byId = new Map(rows.map((r: any) => [String(r.id), r.status]));
      expect(byId.get(stale.id)).toBe('lapsed');
      expect(byId.get(fresh.id)).toBe('draft');
    });

    it('rides the daily housekeeping source, which wakes nobody', async () => {
      const stale = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'Stale.' });
      await pool.query(`update email.drafts set updated_at = $2 where id = $1`, [
        stale.id,
        new Date(NOW.getTime() - 20 * 24 * 60 * 60 * 1000),
      ]);
      const lines: string[] = [];
      let enqueued = 0;
      await createRetentionSource().poll({
        db: pool,
        now: () => NOW,
        timezone: 'UTC',
        log: (line) => lines.push(line),
        enqueueRun: async () => {
          enqueued += 1;
        },
      });
      expect(enqueued).toBe(0);
      expect(lines.some((line) => line.includes('1 draft lapsed'))).toBe(true);
    });
  });
});
