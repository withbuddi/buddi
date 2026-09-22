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
  createAction,
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
import { SEND_TOOL_VERSION } from './send.js';
import { ownerEditedNote } from './drafts.js';
import {
  claimDraftForSend,
  discardDraftRow,
  DraftWriteConflict,
  insertLiveDraft,
  lapseDueDrafts,
  liveDraftForThread,
  OWNER_EDITOR,
  updateDraftRow,
} from '../drafts.js';
import type { DraftRecord } from '../rows.js';
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
  let sendTool: { describe: (input: any, ctx: ToolContext) => Promise<any> };
  let manifestVersion: string;

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
    sendTool = manifest.tools.find((t) => t.name === 'email.send') as never;
    manifestVersion = manifest.version;

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

  const accountId = async (): Promise<string> => {
    const { rows } = await pool.query(`select id from email.accounts limit 1`);
    return String(rows[0].id);
  };

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

  /**
   * The races, written out in the order they actually interleave.
   *
   * Each of these is a sequence that a check-then-write cannot survive and a
   * guarded predicate can: the point is not that the second writer is refused,
   * but that it is refused *after* the first one has already landed, which is
   * the only ordering that ever loses anybody's words.
   */
  describe('two writers on one draft', () => {
    const ownerSave = (draftId: string, bodyText: string, expectedUpdatedAt?: string | null) =>
      updateDraftRow({
        db: pool,
        draftId,
        to: ['alerts@bank.test'],
        cc: [],
        bcc: [],
        subject: 'Re: Direct debit returned',
        bodyText,
        editedBy: OWNER_EDITOR,
        byOwner: true,
        ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
        now: new Date(NOW.getTime() + 1000),
      });

    it('refuses the agent even when the owner saved after the agent last looked', async () => {
      const first = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'Agent words.' });
      // The agent has read the row and found it un-edited. *Then* the owner saves.
      const seen = await liveDraftForThread(pool, first.threadId as string);
      expect(seen?.editedBy).toBeNull();
      await ownerSave(first.id, 'The owner’s own words.');

      // The write that follows that stale read must still lose.
      await expect(
        updateDraftRow({
          db: pool,
          draftId: first.id,
          to: first.to,
          cc: [],
          bcc: [],
          subject: first.subject,
          bodyText: 'Agent again.',
          editedBy: 'mail-triage',
          byOwner: false,
          now: NOW,
        }),
      ).rejects.toMatchObject({ reason: 'owner-edited' });

      const live = await liveDraftForThread(pool, first.threadId as string);
      expect(live?.bodyText).toBe('The owner’s own words.');
    });

    it('refuses an owner save made against a version an agent has already replaced', async () => {
      const first = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'First.' });
      const loaded = (await liveDraftForThread(pool, first.threadId as string)) as NonNullable<
        Awaited<ReturnType<typeof liveDraftForThread>>
      >;
      // The agent rewrites it while the owner has the editor open. A later
      // clock than the one the editor loaded, which is what a second write
      // always has in life and what this suite has to say explicitly.
      await updateDraftRow({
        db: pool,
        draftId: first.id,
        to: first.to,
        cc: [],
        bcc: [],
        subject: first.subject,
        bodyText: 'Second, by the agent.',
        editedBy: 'mail-triage',
        byOwner: false,
        now: new Date(NOW.getTime() + 500),
      });

      await expect(ownerSave(first.id, 'Stale text from an open page.', loaded.updatedAt)).rejects.toMatchObject({
        reason: 'stale',
      });
      const live = await liveDraftForThread(pool, first.threadId as string);
      expect(live?.bodyText).toBe('Second, by the agent.');
    });

    it('refuses the second of two agent rewrites that read the same version', async () => {
      const first = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'Original.' });
      // Both runs have read this draft and are about to rewrite it.
      const seen = (await liveDraftForThread(pool, first.threadId as string)) as NonNullable<
        Awaited<ReturnType<typeof liveDraftForThread>>
      >;

      const rewrite = (body: string, expectedArtifactId: string | null) =>
        updateDraftRow({
          db: pool,
          draftId: first.id,
          to: first.to,
          cc: [],
          bcc: [],
          subject: first.subject,
          bodyText: body,
          editedBy: 'mail-triage',
          byOwner: false,
          expectedArtifactId,
          now: new Date(NOW.getTime() + 1000),
        });

      const winner = await rewrite('The first agent’s words.', seen.artifactId);
      expect(winner.bodyText).toBe('The first agent’s words.');

      // The second run's write is against the version it read, which is gone.
      // Without the predicate it would silently replace work it never saw.
      await expect(rewrite('The second agent’s words.', seen.artifactId)).rejects.toMatchObject({
        reason: 'stale',
      });
      const live = await liveDraftForThread(pool, first.threadId as string);
      expect(live?.bodyText).toBe('The first agent’s words.');
    });

    it('tells the losing agent to read the draft before rewriting it', async () => {
      const first = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'Original.' });
      // Another run rewrites it between this run's read and its write.
      await updateDraftRow({
        db: pool,
        draftId: first.id,
        to: first.to,
        cc: [],
        bcc: [],
        subject: first.subject,
        bodyText: 'Somebody else got there first.',
        editedBy: 'other-agent',
        byOwner: false,
        now: new Date(NOW.getTime() + 1000),
      });

      // `draft_reply` reads the live draft and writes against what it read, so
      // driving it again is the whole interleaving.
      const again = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'Mine.' });
      expect(again.wrote).toBe(true);
      expect(again.bodyText).toBe('Mine.');

      // And when the version it read is already gone, it is refused rather than
      // overwriting — the same answer an owner edit gets.
      const stale = await liveDraftForThread(pool, first.threadId as string);
      await updateDraftRow({
        db: pool,
        draftId: first.id,
        to: first.to,
        cc: [],
        bcc: [],
        subject: first.subject,
        bodyText: 'And again.',
        editedBy: 'other-agent',
        byOwner: false,
        now: new Date(NOW.getTime() + 2000),
      });
      await expect(
        updateDraftRow({
          db: pool,
          draftId: first.id,
          to: first.to,
          cc: [],
          bcc: [],
          subject: first.subject,
          bodyText: 'Too late.',
          editedBy: 'mail-triage',
          byOwner: false,
          expectedArtifactId: stale?.artifactId ?? null,
          now: new Date(NOW.getTime() + 3000),
        }),
      ).rejects.toMatchObject({ reason: 'stale' });
      // The sentence the loser reads names the tool that shows it what is
      // there — and does not claim the owner wrote it when another agent did.
      const note = ownerEditedNote({ ...(stale as DraftRecord), editedBy: null });
      expect(note).toContain('email.read_draft');
      expect(note).toContain('another run');
    });

    it('keeps one live draft per conversation when two agents insert at once', async () => {
      const original = await pool.query(`select id, thread_id from email.messages where id = $1`, [messageId]);
      const threadId = String(original.rows[0].thread_id);
      const account = await accountId();
      const insert = (body: string) =>
        insertLiveDraft({
          db: pool,
          accountId: account,
          inReplyTo: messageId,
          threadId,
          to: ['alerts@bank.test'],
          cc: [],
          bcc: [],
          subject: 'Re: Direct debit returned',
          bodyText: body,
          agentId: 'mail-triage',
          now: NOW,
        });
      const [a, b] = await Promise.all([insert('One.'), insert('Two.')]);
      // Two calls, one row: the loser retried as an update of the winner.
      expect(a.id).toBe(b.id);
      const { rows } = await pool.query(
        `select count(*)::int as n from email.drafts where thread_id = $1 and status in ('draft','edited')`,
        [threadId],
      );
      expect(rows[0].n).toBe(1);
    });
  });

  describe('a dispatch already in flight', () => {
    const claim = (draftId: string, artifactId: string | null, actionId: string) =>
      claimDraftForSend({ db: pool, draftId, actionId, artifactId, now: NOW });

    it('refuses the claim when the owner saved after the executor re-described', async () => {
      const draft = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'Approved text.' });
      const approvedArtifact = draft.artifactId as string;
      // The save lands between the re-description and the claim — the window
      // `describe` cannot close, because `describe` reads and this writes.
      await updateDraftRow({
        db: pool,
        draftId: draft.id,
        to: draft.to,
        cc: [],
        bcc: [],
        subject: draft.subject,
        bodyText: 'Edited a second before the claim.',
        editedBy: OWNER_EDITOR,
        byOwner: true,
        now: NOW,
      });

      await expect(claim(draft.id, approvedArtifact, '11111111-1111-4111-8111-111111111111')).rejects.toThrow(
        /edited while you were deciding/,
      );
      const { rows } = await pool.query(`select sent_action_id from email.drafts where id = $1`, [draft.id]);
      expect(rows[0].sent_action_id).toBeNull();
    });

    it('refuses through the Executor, with nothing in the ledger, when the save lands after the re-description', async () => {
      /*
       * The same race as above, but driven end to end the way production does
       * it — `executeApproved`, not the store function — because that is the
       * path where the claim hook has to actually be reached. What this asserts
       * beyond "refused" is the **empty ledger**: an effect attempt says the
       * message may have gone out, and this one certainly did not.
       */
      const draft = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'Approved text.' });
      const proposal = await registry.invoke('email.send', { draftId: draft.id }, ctx);
      if (proposal.ok || proposal.reason !== 'approval-required') throw new Error('expected an approval');
      await decideApproval(pool, {
        actionId: proposal.actionId,
        decision: 'approved',
        by: 'owner',
        via: 'web',
        now: NOW,
      });

      // The owner saves. The body moves, and so does the artifact version the
      // approved envelope named.
      await updateDraftRow({
        db: pool,
        draftId: draft.id,
        to: draft.to,
        cc: [],
        bcc: [],
        subject: draft.subject,
        bodyText: 'Edited after approving.',
        editedBy: OWNER_EDITOR,
        byOwner: true,
        now: new Date(NOW.getTime() + 1000),
      });

      const before = smtp.sent.length;
      const out = await executeApproved(pool, {
        actionId: proposal.actionId,
        registry,
        ctx,
        worker: 'w1',
        now: NOW,
      });
      expect(out).toMatchObject({ ok: false, state: 'refused' });
      expect(smtp.sent).toHaveLength(before);
      expect(out.ok ? '' : out.message).toContain('edited');
      const { rows: ledger } = await pool.query(
        `select count(*)::int as n from core.effect_attempts where action_id = $1`,
        [proposal.actionId],
      );
      expect(ledger[0].n).toBe(0);
      // And the draft is still the owner's, unclaimed, for them to send again.
      const { rows } = await pool.query(
        `select sent_action_id, body_text from email.drafts where id = $1`,
        [draft.id],
      );
      expect(rows[0]).toMatchObject({ sent_action_id: null, body_text: 'Edited after approving.' });
    });

    it('refuses in the claim itself when the save lands after the re-description', async () => {
      /*
       * The window nothing else can close.
       *
       * The Executor re-describes and compares hashes, then claims. A save that
       * lands *between* those two — which is what a real clock makes possible —
       * passes the hash check, because the re-description happened before it.
       * Only the claim's own predicate can catch that, and only if the hook is
       * actually reached.
       *
       * The interleaving is forced by a `describe` that answers from before the
       * save and performs the save on its way out. Everything else — the claim,
       * the executor, the ledger — is the production path.
       */
      const draft = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'Approved text.' });
      const proposal = await registry.invoke('email.send', { draftId: draft.id }, ctx);
      if (proposal.ok || proposal.reason !== 'approval-required') throw new Error('expected an approval');
      await decideApproval(pool, {
        actionId: proposal.actionId,
        decision: 'approved',
        by: 'owner',
        via: 'web',
        now: NOW,
      });

      const real = registry.lookup('email.send') as NonNullable<ReturnType<ToolRegistry['lookup']>>;
      let saved = false;
      const interleaving = {
        lookup: () => ({
          ...real,
          describe: async (input: unknown, c: ToolContext) => {
            const described = await real.describe!(input, c);
            if (!saved) {
              saved = true;
              // The owner saves, now — after the envelope was read and before
              // the claim is taken.
              await updateDraftRow({
                db: pool,
                draftId: draft.id,
                to: draft.to,
                cc: [],
                bcc: [],
                subject: draft.subject,
                bodyText: 'Saved in the window.',
                editedBy: OWNER_EDITOR,
                byOwner: true,
                now: new Date(NOW.getTime() + 1000),
              });
            }
            return described;
          },
        }),
      };

      const before = smtp.sent.length;
      const out = await executeApproved(pool, {
        actionId: proposal.actionId,
        registry: interleaving as never,
        ctx,
        worker: 'w1',
        now: NOW,
      });
      expect(out).toMatchObject({ ok: false, state: 'refused' });
      // The owner's own sentence, not the generic hash one.
      expect(out.ok ? '' : out.message).toContain('has been edited since you approved it');
      expect(smtp.sent).toHaveLength(before);
      // The ledger is empty: nothing was attempted, so nothing may say it was.
      const { rows: ledger } = await pool.query(
        `select count(*)::int as n from core.effect_attempts where action_id = $1`,
        [proposal.actionId],
      );
      expect(ledger[0].n).toBe(0);
      const { rows } = await pool.query(`select sent_action_id from email.drafts where id = $1`, [draft.id]);
      expect(rows[0].sent_action_id).toBeNull();
    });

    it('refuses an owner save and an owner discard once the claim is held', async () => {
      const draft = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'On its way.' });
      await claim(draft.id, draft.artifactId as string, '22222222-2222-4222-8222-222222222222');

      await expect(
        updateDraftRow({
          db: pool,
          draftId: draft.id,
          to: draft.to,
          cc: [],
          bcc: [],
          subject: draft.subject,
          bodyText: 'Too late.',
          editedBy: OWNER_EDITOR,
          byOwner: true,
          now: NOW,
        }),
      ).rejects.toMatchObject({ reason: 'claimed' });
      expect(await discardDraftRow(pool, draft.id, NOW)).toBeNull();

      const { rows } = await pool.query(`select body_text, status from email.drafts where id = $1`, [draft.id]);
      expect(rows[0]).toMatchObject({ body_text: 'On its way.', status: 'draft' });
    });

    it('refuses a second claim from another action, and is idempotent for its own', async () => {
      const draft = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'Once.' });
      const mine = '33333333-3333-4333-8333-333333333333';
      await claim(draft.id, draft.artifactId as string, mine);
      // The same action asking again is the same hold, not a second send.
      const again = await claim(draft.id, draft.artifactId as string, mine);
      expect(again).not.toBe('replayed');
      await expect(
        claim(draft.id, draft.artifactId as string, '44444444-4444-4444-8444-444444444444'),
      ).rejects.toThrow(/already claimed/);
    });

    it('refuses a send for a draft that is already sent, before any approval exists', async () => {
      const draft = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'Sent already.' });
      await pool.query(
        `update email.drafts set status = 'sent', sent_at = $2, sent_action_id = $3 where id = $1`,
        [draft.id, NOW, '55555555-5555-4555-8555-555555555555'],
      );
      const refused = await registry.invoke('email.send', { draftId: draft.id }, ctx);
      expect(refused.ok ? '' : refused.message).toContain('was already sent');
      const { rows } = await pool.query(`select count(*)::int as n from core.actions`);
      expect(rows[0].n).toBe(0);
    });

    /**
     * A dispatch that never came back is the one state where "send it again"
     * is the wrong answer: the message may be on the wire right now. The old
     * route refused this before an approval card was ever drawn; the guard
     * lives in the tool now, so every caller gets it.
     */
    it('refuses a send for a draft a dispatch is holding and never confirmed', async () => {
      const draft = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'On the wire.' });
      await pool.query(`update email.drafts set sent_action_id = $2 where id = $1`, [
        draft.id,
        '66666666-6666-4666-8666-666666666666',
      ]);
      const refused = await registry.invoke('email.send', { draftId: draft.id }, ctx);
      expect(refused.ok ? '' : refused.message).toContain(
        'This draft was already dispatched and never confirmed. Check the mailbox before sending anything again.',
      );
      const { rows } = await pool.query(`select count(*)::int as n from core.actions`);
      expect(rows[0].n).toBe(0);
    });
  });

  describe('an approval that predates this build', () => {
    it('still executes: the envelope version did not move for a presentation change', async () => {
      // The alias became a control on the card. `toolVersion` lives inside the
      // envelope and the envelope is hashed, so bumping it would have refused
      // every send already waiting at the moment of the upgrade — each with
      // "the effect changed since its preview" about a change nobody made to
      // the mail. This is the fixture that keeps that from happening again.
      expect(SEND_TOOL_VERSION).toBe('0.3.0');

      const draft = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'From before.' });
      const described = await sendTool.describe({ draftId: draft.id }, ctx);
      expect(described.envelope.toolVersion).toBe('0.3.0');

      // An action recorded before this deploy: same envelope, and the preview
      // the old build rendered, which still carried the alias line.
      const action = await createAction(pool, {
        tool: 'email.send',
        toolVersion: manifestVersion,
        agentId: 'mail-triage',
        canonicalArgs: { draftId: draft.id },
        envelope: described.envelope,
        preview: 'Send mail as owner@example.test\n         or, if you choose it here, as someone-else@example.test',
        now: NOW,
      });
      await decideApproval(pool, {
        actionId: action.id,
        decision: 'approved',
        by: 'owner',
        via: 'cli',
        now: NOW,
      });

      const before = smtp.sent.length;
      const out = await executeApproved(pool, {
        actionId: action.id,
        registry,
        ctx,
        worker: 'w1',
        now: NOW,
      });
      expect(out.ok).toBe(true);
      expect(smtp.sent).toHaveLength(before + 1);
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

    it('leaves sent, discarded and lapsed drafts exactly as they are', async () => {
      const ancient = new Date(NOW.getTime() - 60 * 24 * 60 * 60 * 1000);
      const made: Array<{ id: string; status: string }> = [];
      for (const status of ['sent', 'discarded', 'lapsed'] as const) {
        const d = await call('email.draft_new', { to: 'a@x.test', subject: status, bodyText: 'Body.' });
        await pool.query(`update email.drafts set status = $2, updated_at = $3 where id = $1`, [
          d.id,
          status,
          ancient,
        ]);
        made.push({ id: d.id, status });
      }
      const outcome = await lapseDueDrafts(pool, NOW);
      expect(outcome.lapsed).toBe(0);
      for (const { id, status } of made) {
        const { rows } = await pool.query(`select status, lapsed_at from email.drafts where id = $1`, [id]);
        expect(rows[0].status).toBe(status);
        if (status !== 'lapsed') expect(rows[0].lapsed_at).toBeNull();
      }
    });

    it('leaves a draft a dispatch is holding, however old it is', async () => {
      const draft = await call('email.draft_reply', { inReplyTo: messageId, bodyText: 'In flight.' });
      await claimDraftForSend({
        db: pool,
        draftId: draft.id,
        actionId: '66666666-6666-4666-8666-666666666666',
        artifactId: draft.artifactId as string,
        now: NOW,
      });
      await pool.query(`update email.drafts set updated_at = $2 where id = $1`, [
        draft.id,
        new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000),
      ]);
      // `sent_action_id` with no `sent_at` is the one state here that means
      // "we do not know whether this went out". Lapsing it would file the only
      // visible trace of that away under "Older drafts".
      expect((await lapseDueDrafts(pool, NOW)).lapsed).toBe(0);
      const { rows } = await pool.query(`select status from email.drafts where id = $1`, [draft.id]);
      expect(rows[0].status).toBe('draft');
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
