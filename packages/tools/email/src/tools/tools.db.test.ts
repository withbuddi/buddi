/**
 * The email tools over a throwaway database, with a fake SMTP sink.
 *
 * Skipped unless DATABASE_URL is set. Artifacts are written under a temporary
 * data dir, so a draft never lands in the developer's own store.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, runMigrations, ToolRegistry } from '@buddi/core';
import { ensureGmailAccount, GMAIL_SECRET_NAME } from '../config.js';
import { FakeImapServer, fakeMessage } from '../imap/fake.js';
import { createEmailManifest } from '../index.js';
import { FakeSmtpServer } from '../smtp/fake.js';
import { purgeBodies } from '../retention.js';
import { createInboxPollSource } from '../sources/inbox-poll.js';
import type { GatedToolDefinition, ToolContext } from '../types.js';
import { sha256, type SendEnvelope, type SendInput, type SendResult } from './send.js';
import { CATEGORIES, PROCESSING_VERSION } from './shared.js';
import { testDatabaseUrl } from '@buddi/core/testing';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_email_tools_test_${process.pid}`;
const ENV = { GMAIL_USER: 'owner@example.test', [GMAIL_SECRET_NAME]: 'app-password' };

suite('email tools (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let dataDir: string;
  let smtp: FakeSmtpServer;
  let registry: ToolRegistry;
  let ctx: ToolContext;
  let sendTool: GatedToolDefinition<SendInput, SendResult, SendEnvelope>;

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

    dataDir = await mkdtemp(path.join(tmpdir(), 'buddi-email-'));
    process.env.BUDDI_DATA_DIR = dataDir;

    smtp = new FakeSmtpServer();
    const manifest = createEmailManifest({ send: smtp.factory(), env: ENV });
    await runMigrations(pool, [manifest]);

    registry = new ToolRegistry();
    registry.register(manifest);
    sendTool = manifest.tools.find((t) => t.name === 'email.send') as typeof sendTool;

    ctx = {
      db: pool,
      ownerId: 'test',
      now: () => new Date('2026-09-13T12:00:00Z'),
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

  /** Two ingested messages, through the real source path. */
  async function seed(): Promise<string[]> {
    await pool.query('truncate email.drafts, email.triage, email.messages, email.mailboxes, email.accounts cascade');
    await pool.query('delete from email.settings');
    await ensureGmailAccount(pool, ENV);
    const server = new FakeImapServer();
    server.add(
      'INBOX',
      fakeMessage({
        messageId: '<bank-1@bank.test>',
        from: 'Alerts <Alerts@Bank.TEST>',
        to: ['owner@example.test'],
        subject: 'Direct debit returned',
        bodyText: 'Your direct debit of 240.00 was returned unpaid on 12 September.',
        flags: [],
        hasAttachments: true,
        attachments: [{ filename: 'notice.pdf', mime: 'application/pdf', sizeBytes: 1024 }],
        date: new Date('2026-09-12T08:00:00Z'),
      }),
    );
    server.add(
      'INBOX',
      fakeMessage({
        messageId: '<promo-1@shop.test>',
        from: 'shop@shop.test',
        subject: 'Weekend sale',
        bodyText: 'Everything must go.',
        flags: ['\\Seen'],
        date: new Date('2026-09-13T08:00:00Z'),
      }),
    );
    // A message with an audience: the owner plus two more addressed, two more
    // copied, and one of the copies is the owner again under a plus-tag. It is
    // the shape every reply-all question is really about.
    server.add(
      'INBOX',
      fakeMessage({
        messageId: '<handover-1@client.test>',
        from: 'Dorothée <TDorothee@Client.TEST>',
        to: ['owner@example.test', 'successor@client.test', 'colleague@client.test'],
        cc: ['director@client.test', 'Owner+web@example.test'],
        subject: 'Handover of the website',
        bodyText: 'I am retiring. Rachid and Fiatyao take over from me.',
        flags: ['\\Seen'],
        date: new Date('2026-09-11T08:00:00Z'),
      }),
    );
    // `backfill` is explicit: a first contact starts at *now* by default and
    // fetches no history, so a fixture that seeds through a real poll has to
    // ask for the history it just wrote.
    const source = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: 1_000 });
    await source.poll({
      db: pool,
      now: ctx.now,
      timezone: 'UTC',
      log: () => {},
      enqueueRun: async () => {},
    });
    const { rows } = await pool.query(`select id from email.messages order by uid`);
    return rows.map((r: any) => String(r.id));
  }

  let ids: string[];
  beforeEach(async () => {
    ids = await seed();
  });

  it('lists recent mail, newest first, with unread and attachment flags', async () => {
    const listed = await call('email.list_recent', {});
    expect(listed.account).toBe('owner@example.test');
    expect(listed.messages.map((m: any) => m.subject)).toEqual([
      'Weekend sale',
      'Direct debit returned',
      'Handover of the website',
    ]);
    const bank = listed.messages[1];
    expect(bank).toMatchObject({ from: 'alerts@bank.test', unread: true, hasAttachments: true });
    expect(bank.snippet).toContain('returned unpaid');
    expect(bank.triage).toBeNull();

    const unread = await call('email.list_recent', { unreadOnly: true });
    expect(unread.messages.map((m: any) => m.subject)).toEqual(['Direct debit returned']);

    const since = await call('email.list_recent', { since: '2026-09-13' });
    expect(since.messages.map((m: any) => m.subject)).toEqual(['Weekend sale']);
  });

  it('reads one message in full, with its attachments listed', async () => {
    const message = await call('email.read', { id: ids[0] });
    expect(message.bodyText).toContain('240.00');
    expect(message.attachments).toEqual([
      { filename: 'notice.pdf', mime: 'application/pdf', sizeBytes: 1024 },
    ]);
    expect(message.unread).toBe(true);
    await expect(call('email.read', { id: '00000000-0000-4000-8000-000000000000' })).rejects.toThrow(
      /unknown message/,
    );
  });

  it('reads the settings, and lets the owner change the retention window', async () => {
    const initial = await call('email.get_settings', {});
    expect(initial).toMatchObject({ retentionDays: 90, default: 90, purgedMessages: 0 });

    const updated = await call('email.set_settings', { retentionDays: 30 });
    expect(updated.retentionDays).toBe(30);
    expect((await call('email.get_settings', {})).retentionDays).toBe(30);
    const { rows } = await pool.query(`select value from email.settings where key = 'retention_days'`);
    expect(rows[0].value).toBe(30);

    // The bounds are the tool's, not a suggestion.
    await expect(call('email.set_settings', { retentionDays: 0 })).rejects.toThrow(/invalid-args/);
    await expect(call('email.set_settings', { retentionDays: 99_999 })).rejects.toThrow(/invalid-args/);
    expect((await call('email.get_settings', {})).retentionDays).toBe(30);

    await call('email.set_settings', { retentionDays: 90 });
  });

  it('reads a purged message as headers, snippet and a retention note', async () => {
    // Age the bank notice past the window and run the daily pass over it.
    await pool.query(`update email.messages set date = $2 where id = $1`, [
      ids[0],
      new Date('2026-01-01T08:00:00Z'),
    ]);
    await call('email.triage_record', {
      messageId: ids[0],
      category: 'payment-failed',
      urgency: 'urgent',
      summary: 'A direct debit of 240.00 was returned unpaid.',
    });
    const outcome = await purgeBodies(pool, ctx.now());
    expect(outcome.purged).toBe(1);

    const message = await call('email.read', { id: ids[0] });
    expect(message.bodyText).toBeNull();
    expect(message.bodyPurged).toBe(true);
    expect(message.retentionDays).toBe(90);
    expect(message.note).toContain('purged');
    expect(message.note).toContain('90 days');
    // Everything that is kept forever is still there.
    expect(message.subject).toBe('Direct debit returned');
    expect(message.from).toBe('alerts@bank.test');
    expect(message.snippet).toContain('returned unpaid');
    expect(message.attachments).toHaveLength(1);
    expect(message.triage).toMatchObject({ category: 'payment-failed', urgency: 'urgent' });

    // A message inside the window is unaffected, and the count is reported.
    const fresh = await call('email.read', { id: ids[1] });
    expect(fresh.bodyPurged).toBe(false);
    expect(fresh.bodyText).toContain('Everything must go.');
    expect((await call('email.get_settings', {})).purgedMessages).toBe(1);
  });

  it('searches subject, sender and body, and treats wildcards literally', async () => {
    expect((await call('email.search', { query: 'returned unpaid' })).count).toBe(1);
    expect((await call('email.search', { query: 'bank.test' })).count).toBe(1);
    expect((await call('email.search', { query: 'WEEKEND' })).count).toBe(1);
    // A LIKE metacharacter is a character, not a widening wildcard.
    expect((await call('email.search', { query: '%%' })).count).toBe(0);
  });

  it('records a triage decision, versioned, and surfaces it in a listing', async () => {
    const decided = await call('email.triage_record', {
      messageId: ids[0],
      category: 'payment-failed',
      urgency: 'urgent',
      summary: 'A direct debit of 240.00 was returned unpaid.',
      actionNeeded: 'Cover the account before the retry.',
    });
    expect(decided).toMatchObject({
      processingVersion: PROCESSING_VERSION,
      category: 'payment-failed',
      urgency: 'urgent',
    });

    const listed = await call('email.list_recent', {});
    expect(listed.messages[1].triage).toMatchObject({ category: 'payment-failed', urgency: 'urgent' });

    // Re-deciding under the same policy version corrects the row rather than
    // adding a second decision for the same version.
    await call('email.triage_record', {
      messageId: ids[0],
      category: 'bank-notice',
      urgency: 'normal',
      summary: 'A bank notice.',
    });
    const { rows } = await pool.query(`select count(*)::int as n from email.triage where message_id = $1`, [ids[0]]);
    expect(rows[0].n).toBe(1);

    await expect(
      call('email.triage_record', {
        messageId: ids[0],
        category: 'nonsense',
        urgency: 'urgent',
        summary: 'x',
      }),
    ).rejects.toThrow(/invalid-args/);
  });

  it('records a relationship change as what it is, and lets a person be urgent', async () => {
    // The shape of the message that was missed: no amount, no deadline, no
    // exclamation mark, and the most important thing in the mailbox that day.
    const decided = await call('email.triage_record', {
      messageId: ids[0],
      category: 'relationship',
      urgency: 'urgent',
      summary: 'A client contact of many years says she has retired and names her successors.',
      actionNeeded: 'Reply to acknowledge and get the new contacts on record.',
    });
    expect(decided).toMatchObject({ category: 'relationship', urgency: 'urgent' });

    const read = await call('email.read', { id: ids[0] });
    expect(read.triage).toMatchObject({
      category: 'relationship',
      categoryLabel: 'relationship',
      urgency: 'urgent',
      policyVersion: PROCESSING_VERSION,
      currentPolicy: true,
    });
  });

  it('accepts every category the new taxonomy offers', async () => {
    for (const category of CATEGORIES) {
      const decided = await call('email.triage_record', {
        messageId: ids[0],
        category,
        urgency: 'normal',
        summary: `a ${category} message`,
      });
      expect(decided.category).toBe(category);
    }
  });

  it('reads a row written under the old policy back without breaking', async () => {
    // Exactly what 194 rows in the owner's installation look like: version 1,
    // a money-only category, decided before any of this existed. Nothing
    // rewrites them, so everything that reads them has to cope.
    await pool.query(
      `insert into email.triage
         (message_id, processing_version, category, urgency, summary, action_needed, decided_at)
       values ($1, 1, 'personal', 'low', 'an old verdict', null, now())`,
      [ids[1]],
    );
    const read = await call('email.read', { id: ids[1] });
    expect(read.triage).toMatchObject({
      category: 'personal',
      urgency: 'low',
      policyVersion: 1,
      currentPolicy: false,
    });

    const listed = await call('email.list_recent', {});
    const row = listed.messages.find((m: any) => m.id === ids[1]);
    expect(row.triage.summary).toBe('an old verdict');
  });

  it('reads back a category this build has never heard of, rather than failing', async () => {
    // Not reachable through the tool — zod refuses it — but reachable through
    // history, which is the case that matters. A view must render it.
    await pool.query(
      `insert into email.triage
         (message_id, processing_version, category, urgency, summary, decided_at)
       values ($1, 0, 'a-category-from-2029', 'low', 'from the future', now())`,
      [ids[1]],
    );
    const read = await call('email.read', { id: ids[1] });
    expect(read.triage).toMatchObject({
      category: 'a-category-from-2029',
      categoryLabel: 'a category from 2029',
      currentPolicy: false,
    });
  });

  it('a newer policy decision wins over the one it replaced, and neither is destroyed', async () => {
    await pool.query(
      `insert into email.triage
         (message_id, processing_version, category, urgency, summary, decided_at)
       values ($1, 1, 'personal', 'low', 'the verdict that missed it', now())`,
      [ids[1]],
    );
    await call('email.triage_record', {
      messageId: ids[1],
      category: 'relationship',
      urgency: 'urgent',
      summary: 'the verdict that catches it',
    });
    const read = await call('email.read', { id: ids[1] });
    expect(read.triage).toMatchObject({ category: 'relationship', urgency: 'urgent' });
    const { rows } = await pool.query(
      `select processing_version from email.triage where message_id = $1 order by processing_version`,
      [ids[1]],
    );
    expect(rows.map((r: any) => Number(r.processing_version))).toEqual([1, PROCESSING_VERSION]);
  });

  describe('email.sender_profile', () => {
    it('counts what has arrived from an address, and says nobody has written back', async () => {
      const profile = await call('email.sender_profile', { address: 'alerts@bank.test' });
      expect(profile).toMatchObject({
        address: 'alerts@bank.test',
        received: 1,
        ownerHasReplied: false,
        messagesSent: 0,
        firstContact: true,
      });
    });

    it('knows the owner has replied once a draft to that address has actually gone out', async () => {
      const draft = await call('email.draft_reply', {
        inReplyTo: ids[0],
        bodyText: 'Noted, thank you.',
      });
      // A saved draft is not a reply: the owner has not sent anything yet.
      let profile = await call('email.sender_profile', { address: 'alerts@bank.test' });
      expect(profile).toMatchObject({ ownerHasReplied: false, draftsWaiting: 1 });

      await pool.query(`update email.drafts set sent_at = now() where id = $1`, [draft.id]);
      profile = await call('email.sender_profile', { address: 'Alerts@BANK.test' });
      expect(profile).toMatchObject({ ownerHasReplied: true, messagesSent: 1 });
    });

    it('hands back how this sender was judged before', async () => {
      await call('email.triage_record', {
        messageId: ids[0],
        category: 'payment-failed',
        urgency: 'urgent',
        summary: 'a returned debit',
      });
      const profile = await call('email.sender_profile', { address: 'alerts@bank.test' });
      expect(profile.recentVerdicts[0]).toMatchObject({
        category: 'payment-failed',
        urgency: 'urgent',
      });
    });

    it('grants no trust: it is a read, it carries no authority, and it says so', async () => {
      // The whole risk of this tool is that "known sender" quietly becomes
      // "trusted sender". It is tier `auto` because it only counts rows, it
      // returns no capability of any kind, and the output states the limit in
      // words the model will read.
      const spec = registry.list().find((t) => t.name === 'email.sender_profile');
      expect(spec?.tier).toBe('auto');
      const profile = await call('email.sender_profile', { address: 'alerts@bank.test' });
      expect(profile.note).toMatch(/not a trusted one/i);
      expect(Object.keys(profile)).not.toContain('trusted');
      expect(Object.keys(profile)).not.toContain('verified');
      // Nothing about a known sender can move an urgency by itself: the tool
      // returns history, never a verdict.
      expect(Object.keys(profile)).not.toContain('urgency');
      expect(Object.keys(profile)).not.toContain('category');
    });

    it('says nothing at all about an address it has never seen', async () => {
      const profile = await call('email.sender_profile', { address: 'stranger@nowhere.test' });
      expect(profile).toMatchObject({ received: 0, ownerHasReplied: false, firstContact: true });
      expect(profile.recentVerdicts).toEqual([]);
    });
  });

  it('drafts a reply threaded to the original, saved as an artifact', async () => {
    const draft = await call('email.draft_reply', {
      inReplyTo: ids[0],
      bodyText: 'Thanks — I will cover the account today.',
    });
    expect(draft).toMatchObject({
      to: ['alerts@bank.test'],
      subject: 'Re: Direct debit returned',
      inReplyTo: ids[0],
      createdBy: 'mail-triage',
      sent: false,
    });
    expect(draft.artifactId).toBeTruthy();
    const { rows } = await pool.query(`select created_by, mime from core.artifacts where id = $1`, [
      draft.artifactId,
    ]);
    expect(rows[0]).toMatchObject({ created_by: 'mail-triage', mime: 'text/plain' });
  });

  describe("a reply's audience", () => {
    const handover = (): string => ids[2] as string;

    it('goes to the sender alone when nothing asks for more', async () => {
      const draft = await call('email.draft_reply', {
        inReplyTo: handover(),
        bodyText: 'Merci Dorothée.',
      });
      expect(draft.to).toEqual(['tdorothee@client.test']);
      expect(draft.cc).toEqual([]);
      expect(draft.bcc).toEqual([]);
      expect(draft.audience).toBe('sender');
      expect(draft.beyondSender).toEqual([]);
      expect(draft.audienceNote).toMatch(/tdorothee@client\.test alone/i);
    });

    it('states, on the narrow draft, who else was on the message and what is left to decide', async () => {
      // The failure this exists for: a sender-only draft of a message four
      // people read used to come back saying only "the sender alone", and the
      // turn ended with a question in prose. The result now carries the fact.
      const draft = await call('email.draft_reply', {
        inReplyTo: handover(),
        bodyText: 'Merci Dorothée.',
      });
      expect(draft.othersOnOriginal).toEqual([
        'successor@client.test',
        'colleague@client.test',
        'director@client.test',
      ]);
      expect(draft.ownerDecision).toMatchObject({ decision: 'reply-audience' });
      expect(draft.ownerDecision.others).toEqual(draft.othersOnOriginal);
      expect(draft.ownerDecision.options).toHaveLength(2);
      expect(draft.audienceNote).toContain('successor@client.test');
      expect(draft.audienceNote).toMatch(/3 other people/);
      expect(draft.audienceNote).toMatch(/owner's to decide/i);
      expect(draft.audienceNote).toMatch(/offering the owner what to do next/i);
      expect(draft.audienceNote).toMatch(/show the owner that draft/i);
    });

    it('leaves no decision when the message was only ever between the two of them', async () => {
      // The other failure: a button where there is no choice. The bank wrote to
      // the owner and nobody else, so nothing here says anything is pending.
      const draft = await call('email.draft_reply', {
        inReplyTo: ids[0],
        bodyText: 'Noted, thank you.',
      });
      expect(draft.othersOnOriginal).toEqual([]);
      expect(draft.ownerDecision).toBeUndefined();
      expect(draft.audienceNote).toMatch(/no audience choice/i);
    });

    it('leaves no decision once the wide shape has been taken', async () => {
      const draft = await call('email.draft_reply', {
        inReplyTo: handover(),
        bodyText: 'Merci à tous.',
        audience: 'everyone',
      });
      expect(draft.othersOnOriginal).toHaveLength(3);
      expect(draft.ownerDecision).toBeUndefined();
      expect(draft.audienceNote).toMatch(/3 people beyond the sender/);
    });

    it('reaches everyone the message did when it is asked for, To in To and Cc in Cc', async () => {
      const draft = await call('email.draft_reply', {
        inReplyTo: handover(),
        bodyText: 'Merci Dorothée, et bienvenue à vous deux.',
        audience: 'everyone',
      });
      expect(draft.to).toEqual([
        'tdorothee@client.test',
        'successor@client.test',
        'colleague@client.test',
      ]);
      expect(draft.cc).toEqual(['director@client.test']);
      expect(draft.beyondSender).toHaveLength(3);
      expect(draft.audienceNote).toMatch(/3 people beyond the sender/);
    });

    it("leaves the owner off, including the plus-addressed form of his own mailbox", async () => {
      const draft = await call('email.draft_reply', {
        inReplyTo: handover(),
        bodyText: 'Noted.',
        audience: 'everyone',
        alsoCc: ['OWNER@example.test'],
      });
      const everyone = [...draft.to, ...draft.cc, ...draft.bcc];
      expect(everyone.some((a: string) => a.startsWith('owner'))).toBe(false);
      expect(draft.excludedOwnAddresses).toEqual(['owner@example.test', 'owner+web@example.test']);
    });

    it('never carries a blind copy, and cannot be asked for one', async () => {
      const draft = await call('email.draft_reply', {
        inReplyTo: handover(),
        bodyText: 'Noted.',
        audience: 'everyone',
      });
      expect(draft.bcc).toEqual([]);
      // There is no argument for one: a blind recipient offered to the tool is
      // not a recipient, it is a key the schema does not have.
      const smuggled = await call('email.draft_reply', {
        inReplyTo: handover(),
        bodyText: 'Noted.',
        bcc: ['quiet@example.test'],
      });
      expect(smuggled.bcc).toEqual([]);
      expect([...smuggled.to, ...smuggled.cc]).not.toContain('quiet@example.test');
    });

    it('shows the owner a widened audience as a widening when he approves the send', async () => {
      const wide = await call('email.draft_reply', {
        inReplyTo: handover(),
        bodyText: 'Merci Dorothée, et bienvenue à vous deux.',
        audience: 'everyone',
      });
      const { envelope, preview } = await sendTool.describe({ draftId: wide.id }, ctx);
      expect(envelope.replyAudience).toMatchObject({
        sender: 'tdorothee@client.test',
        widened: true,
      });
      expect(envelope.replyAudience?.beyondSender).toEqual([
        'successor@client.test',
        'colleague@client.test',
        'director@client.test',
      ]);
      expect(preview).toContain('WIDER THAN A REPLY TO THE SENDER — 3 people');
      expect(preview).toContain('successor@client.test, colleague@client.test, director@client.test');
      expect(preview).toContain('recipients: 4 (bcc included)');
      // Every recipient is still there in full, line by line.
      expect(preview).toContain('To:      tdorothee@client.test, successor@client.test, colleague@client.test');
      expect(preview).toContain('Cc:      director@client.test');

      const narrow = await call('email.draft_reply', {
        inReplyTo: handover(),
        bodyText: 'Merci Dorothée.',
      });
      const sender = await sendTool.describe({ draftId: narrow.id }, ctx);
      expect(sender.envelope.replyAudience).toMatchObject({ widened: false, beyondSender: [] });
      expect(sender.preview).toContain('Audience: the sender alone');
    });
  });

  it('refuses to draft without provenance', async () => {
    await expect(
      call('email.draft_reply', { inReplyTo: ids[0], bodyText: 'hi' }, { agentId: undefined }),
    ).rejects.toThrow(/no agent id/);
  });

  it('drafts a new message, normalising every recipient list', async () => {
    const draft = await call('email.draft_new', {
      to: 'Someone <Someone@Example.TEST>',
      subject: 'Hello',
      bodyText: 'Body.',
      cc: ['cc@example.test'],
      bcc: ['Quiet <quiet@example.test>', 'quiet@example.test'],
    });
    expect(draft.to).toEqual(['someone@example.test']);
    expect(draft.bcc).toEqual(['quiet@example.test']);
  });

  describe('email.send (gated)', () => {
    it('refuses a changed draft before claiming or sending it', async () => {
      const draftId = await draft();
      const approvedEffect = await sendTool.describe({ draftId }, ctx);
      await pool.query('update email.drafts set body_text = $2 where id = $1', [draftId, 'different body']);
      await expect(sendTool.execute({ draftId }, { ...ctx, actionId: '66666666-6666-4666-8666-666666666666', approvedEffect }))
        .rejects.toThrow(/no longer matches/);
      expect(smtp.sent).toHaveLength(0);
      const { rows } = await pool.query('select sent_action_id from email.drafts where id = $1', [draftId]);
      expect(rows[0].sent_action_id).toBeNull();
    });

    async function draft(): Promise<string> {
      const created = await call('email.draft_reply', {
        inReplyTo: ids[0],
        bodyText: 'I will cover the account today.',
      });
      await pool.query(`update email.drafts set bcc = '["quiet@example.test"]'::jsonb where id = $1`, [
        created.id,
      ]);
      return created.id as string;
    }

    it('is gated, so the registry alone never executes it', async () => {
      expect(sendTool.tier).toBe('gated');
      const before = smtp.sent.length;
      const refused = await registry.invoke('email.send', { draftId: await draft() }, ctx);
      // Core turns a gated call into an immutable action and waits for the
      // owner; nothing reaches the wire from `invoke`, ever.
      expect(refused).toMatchObject({ ok: false, reason: 'approval-required' });
      expect(smtp.sent).toHaveLength(before);
    });

    it('is the only way out: nothing added for offered actions can send', async () => {
      // An offered action ("Draft a reply") leads, at most, to a draft. This is
      // the assertion that says so structurally rather than by inspection:
      // every tool this plugin ships is a read or a write over its own schema
      // except the gated ones, and only one of those reaches the network.
      //
      // The two policy tools are gated for a different reason: nothing leaves
      // this machine, but a standing rule decides every future message from a
      // sender with no model and no second chance to object, so the moment it
      // is *written* is the moment the owner has to agree to it.
      const gated = registry.list().filter((t) => t.tier !== 'auto');
      expect(new Set(gated.map((t) => t.name))).toEqual(
        new Set(['email.send', 'email.set_policy', 'email.revoke_policy']),
      );

      // And drafting, the thing a tapped action actually does, sends nothing.
      const before = smtp.sent.length;
      await call('email.draft_reply', { inReplyTo: ids[0], bodyText: 'Noted, thank you.' });
      expect(smtp.sent).toHaveLength(before);
    });

    it('describes the full envelope — every recipient, the body and its hash', async () => {
      const draftId = await draft();
      const { envelope, preview } = await sendTool.describe({ draftId }, ctx);

      expect(envelope.from).toBe('owner@example.test');
      expect(envelope.to).toEqual(['alerts@bank.test']);
      expect(envelope.bcc).toEqual(['quiet@example.test']);
      expect(envelope.subject).toBe('Re: Direct debit returned');
      expect(envelope.bodySha256).toBe(sha256('I will cover the account today.'));
      expect(envelope.inReplyTo).toBe('<bank-1@bank.test>');
      expect(envelope.references).toEqual(['<bank-1@bank.test>']);
      expect(envelope.attachments).toEqual([]);
      expect(envelope.artifactId).toBeTruthy();

      // The preview is rendered from the envelope: a blind recipient is never
      // hidden from the person approving the send.
      expect(preview).toContain('Bcc:     quiet@example.test');
      expect(preview).toContain(envelope.bodySha256);
      expect(preview).toContain('recipients: 2 (bcc included)');
    });

    it('sends exactly what was described, once per approved action', async () => {
      const draftId = await draft();
      const actionId = '11111111-1111-4111-8111-111111111111';
      const approvedEffect = await sendTool.describe({ draftId }, ctx);
      const result = await sendTool.execute({ draftId }, { ...ctx, actionId, approvedEffect });

      expect(result).toMatchObject({ draftId, actionId, replayed: false });
      expect(result.messageId).toMatch(/^<fake-/);
      expect(smtp.sent).toHaveLength(1);
      expect(smtp.sent[0]).toMatchObject({
        from: 'owner@example.test',
        to: ['alerts@bank.test'],
        bcc: ['quiet@example.test'],
        subject: 'Re: Direct debit returned',
        text: 'I will cover the account today.',
        inReplyTo: '<bank-1@bank.test>',
      });

      // The same approved action, executed again: the receipt, not a second mail.
      const replay = await sendTool.execute({ draftId }, { ...ctx, actionId });
      expect(replay).toMatchObject({ replayed: true, messageId: result.messageId });
      expect(smtp.sent).toHaveLength(1);
    });

    it('refuses a second action against an already-sent draft', async () => {
      const draftId = await draft();
      await sendTool.execute({ draftId }, { ...ctx, actionId: '22222222-2222-4222-8222-222222222222',
        approvedEffect: await sendTool.describe({ draftId }, ctx) });
      const before = smtp.sent.length;
      await expect(
        sendTool.execute({ draftId }, { ...ctx, actionId: '33333333-3333-4333-8333-333333333333' }),
      ).rejects.toThrow(/already sent/);
      expect(smtp.sent).toHaveLength(before);
    });

    it('refuses to send without an approved action id', async () => {
      const draftId = await draft();
      const before = smtp.sent.length;
      await expect(sendTool.execute({ draftId }, ctx)).rejects.toThrow(/no approved action id/);
      expect(smtp.sent).toHaveLength(before);
    });

    it('leaves a failed dispatch claimed and unknown, never silently retryable', async () => {
      const draftId = await draft();
      smtp.failWith = new Error('451 temporary failure');
      await expect(
        sendTool.execute({ draftId }, { ...ctx, actionId: '44444444-4444-4444-8444-444444444444',
          approvedEffect: await sendTool.describe({ draftId }, ctx) }),
      ).rejects.toThrow(/the attempt is unknown/);

      const { rows } = await pool.query(
        `select sent_action_id, sent_at, send_error from email.drafts where id = $1`,
        [draftId],
      );
      expect(String(rows[0].sent_action_id)).toBe('44444444-4444-4444-8444-444444444444');
      expect(rows[0].sent_at).toBeNull();
      expect(rows[0].send_error).toContain('451');
    });

    it('never claims a draft when the configuration is the problem', async () => {
      const draftId = await draft();
      const manifest = createEmailManifest({ send: smtp.factory(), env: { GMAIL_USER: 'owner@example.test' } });
      const tool = manifest.tools.find((t) => t.name === 'email.send') as typeof sendTool;
      await expect(
        tool.execute({ draftId }, { ...ctx, actionId: '55555555-5555-4555-8555-555555555555' }),
      ).rejects.toThrow(/secret-missing/);
      const { rows } = await pool.query(`select sent_action_id from email.drafts where id = $1`, [draftId]);
      expect(rows[0].sent_action_id).toBeNull();
    });
  });
});
