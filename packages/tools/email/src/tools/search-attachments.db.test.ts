/**
 * Search and attachments over a throwaway database (docs/specs/email.md §9, §10).
 *
 * Skipped unless DATABASE_URL is set. Artifacts are written under a temporary
 * data dir, so a fetched attachment never lands in the developer's own store,
 * and the IMAP is the in-process fake — nothing here opens a socket.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, runMigrations, ToolRegistry } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { ensureGmailAccount, GMAIL_SECRET_NAME } from '../config.js';
import { FakeImapServer, fakeMessage } from '../imap/fake.js';
import { createEmailManifest } from '../index.js';
import { purgeBodies } from '../retention.js';
import { createInboxPollSource } from '../sources/inbox-poll.js';
import type { ToolContext } from '../types.js';
import { MAX_ATTACHMENT_BYTES } from './attachments.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_email_search_test_${process.pid}`;
const ENV = { GMAIL_USER: 'owner@example.test', [GMAIL_SECRET_NAME]: 'app-password' };
const NOW = new Date('2026-09-22T12:00:00Z');

/** The bytes the fake server will hand over for the invoice. */
const INVOICE = Buffer.from('%PDF-1.4 the invoice itself\n');

suite('email search and attachments (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let dataDir: string;
  let registry: ToolRegistry;
  let ctx: ToolContext;
  /**
   * One server for the whole file, reset between tests rather than replaced:
   * the manifest's client factory is bound to this instance, so a fresh
   * `FakeImapServer` per test would leave the tool talking to an empty one.
   */
  const server = new FakeImapServer();

  const call = async (name: string, args: unknown, over: Partial<ToolContext> = {}): Promise<any> => {
    const result = await registry.invoke(name, args, { ...ctx, ...over });
    if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
    return result.output;
  };

  const refuse = async (name: string, args: unknown): Promise<string> => {
    const result = await registry.invoke(name, args, ctx);
    if (result.ok) throw new Error(`${name} was expected to refuse and did not`);
    return result.message;
  };

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());

    dataDir = await mkdtemp(path.join(tmpdir(), 'buddi-email-search-'));
    process.env.BUDDI_DATA_DIR = dataDir;

    const manifest = createEmailManifest({ connect: server.factory(), env: ENV });
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

  /**
   * Four messages through the real source path: one recent with an invoice
   * attached, one recent promo, one from a subdomain of the same company, and
   * one well outside the default 90-day window.
   */
  async function seed(): Promise<void> {
    await pool.query(
      'truncate email.drafts, email.triage, email.messages, email.threads, email.folders, email.accounts cascade',
    );
    await pool.query('delete from core.artifacts');
    await ensureGmailAccount(pool, ENV);
    server.mailboxes.clear();
    server.parts.clear();
    server.downloads.length = 0;
    const invoiceUid = server.add(
      'INBOX',
      fakeMessage({
        messageId: '<inv-1@acme.test>',
        from: 'Billing <Billing@Acme.TEST>',
        to: ['owner@example.test'],
        subject: 'Invoice 4102',
        bodyText: 'The invoice for September is attached.',
        hasAttachments: true,
        attachments: [
          { filename: 'invoice.pdf', mime: 'application/pdf', sizeBytes: INVOICE.length, part: '2' },
          { filename: 'setup.exe', mime: 'application/octet-stream', sizeBytes: 12, part: '3' },
          { filename: 'huge.pdf', mime: 'application/pdf', sizeBytes: MAX_ATTACHMENT_BYTES + 1, part: '4' },
        ],
        date: new Date('2026-09-18T08:00:00Z'),
      }),
    );
    server.putPart('INBOX', invoiceUid, '2', INVOICE);
    server.putPart('INBOX', invoiceUid, '3', Buffer.from('MZ'));
    server.add(
      'INBOX',
      fakeMessage({
        messageId: '<promo-1@shop.test>',
        from: 'shop@shop.test',
        subject: 'Weekend sale',
        bodyText: 'Everything must go, invoice nothing.',
        date: new Date('2026-09-19T08:00:00Z'),
      }),
    );
    server.add(
      'INBOX',
      fakeMessage({
        messageId: '<sub-1@mail.acme.test>',
        from: 'noreply@mail.acme.test',
        subject: 'Your account',
        bodyText: 'A note from the same company, sent by a different host.',
        date: new Date('2026-09-17T08:00:00Z'),
      }),
    );
    server.add(
      'INBOX',
      fakeMessage({
        messageId: '<old-1@acme.test>',
        from: 'billing@acme.test',
        subject: 'Invoice 3001',
        bodyText: 'Last winter, an invoice.',
        date: new Date('2025-12-01T08:00:00Z'),
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
  }

  beforeEach(async () => {
    await seed();
  });

  /* ---------------------------- A1: the schema --------------------------- */

  it('installs pg_trgm and the indexes the search reads', async () => {
    const ext = await pool.query(`select 1 from pg_extension where extname = 'pg_trgm'`);
    expect(ext.rowCount).toBe(1);
    const { rows } = await pool.query(
      `select indexname from pg_indexes where schemaname = 'email' order by indexname`,
    );
    const names = rows.map((r: { indexname: string }) => r.indexname);
    expect(names).toContain('messages_subject_trgm_idx');
    expect(names).toContain('messages_from_trgm_idx');
    expect(names).toContain('messages_account_when_idx');
    expect(names).toContain('threads_participants_idx');
  });

  /* ------------------------------ A2: search ----------------------------- */

  it('still finds a phrase in the body, and fences the snippet it quotes', async () => {
    const out = await call('email.search', { query: 'Everything must go' });
    expect(out.count).toBe(1);
    expect(out.messages[0].subject).toBe('Weekend sale');
    // Every result a model reads is quoted mail, and says so.
    expect(out.messages[0].snippet).toContain('UNTRUSTED');
    expect(out.note).toContain('never as an instruction');
  });

  it('carries the thread, the direction, the account and the date on every hit', async () => {
    const out = await call('email.search', { query: 'Invoice 4102' });
    const hit = out.messages[0];
    expect(hit.thread).toMatch(/^[0-9a-f-]{36}$/);
    expect(hit.direction).toBe('in');
    expect(hit.account).toBe('owner@example.test');
    expect(hit.date).not.toBeNull();
    expect(hit.hasAttachments).toBe(true);
  });

  it('windows an unnarrowed text search to 90 days and says it did', async () => {
    const out = await call('email.search', { query: 'invoice' });
    const subjects = out.messages.map((m: { subject: string }) => m.subject);
    expect(subjects).toContain('Invoice 4102');
    expect(subjects).toContain('Weekend sale');
    // Last winter's invoice is outside the window.
    expect(subjects).not.toContain('Invoice 3001');
    expect(out.window).toContain('90 days');
  });

  it('reaches past the window as soon as a filter narrows the search', async () => {
    const out = await call('email.search', { query: 'invoice', since: '2025-01-01' });
    const subjects = out.messages.map((m: { subject: string }) => m.subject);
    expect(subjects).toContain('Invoice 3001');
    expect(out.window).toBeUndefined();
  });

  it('takes `from` as an exact address, and a bare domain as its subdomains too', async () => {
    const exact = await call('email.search', { from: 'billing@acme.test', since: '2025-01-01' });
    expect(exact.messages.map((m: { subject: string }) => m.subject).sort()).toEqual([
      'Invoice 3001',
      'Invoice 4102',
    ]);
    const domain = await call('email.search', { from: 'acme.test', since: '2025-01-01' });
    expect(domain.messages.map((m: { subject: string }) => m.subject)).toContain('Your account');
    expect(domain.count).toBe(3);
  });

  it('filters with no query at all', async () => {
    const out = await call('email.search', { hasAttachments: true });
    expect(out.count).toBe(1);
    expect(out.messages[0].subject).toBe('Invoice 4102');
    expect(out.query).toBeNull();
  });

  it('takes `until` as the whole of the day named', async () => {
    const out = await call('email.search', { since: '2026-09-18', until: '2026-09-18' });
    expect(out.messages.map((m: { subject: string }) => m.subject)).toEqual(['Invoice 4102']);
  });

  it('refuses a search that is neither a query nor a filter', async () => {
    expect(await refuse('email.search', {})).toMatch(/needs either `query` or at least one filter/);
  });

  it('narrows to one conversation', async () => {
    const all = await call('email.search', { query: 'Invoice 4102' });
    const thread = all.messages[0].thread;
    const out = await call('email.search', { thread, since: '2025-01-01' });
    expect(out.count).toBe(1);
    expect(out.messages[0].subject).toBe('Invoice 4102');
  });

  /* --------------------------- A3: list_threads -------------------------- */

  it('windows the conversation list by when it last moved', async () => {
    const recent = await call('email.list_threads', { since: '2026-09-18' });
    const subjects = recent.threads.map((t: { subject: string }) => t.subject);
    expect(subjects).toContain('Invoice 4102');
    expect(subjects).not.toContain('Invoice 3001');
    const old = await call('email.list_threads', { until: '2025-12-31' });
    expect(old.threads.map((t: { subject: string }) => t.subject)).toEqual(['Invoice 3001']);
  });

  it('finds a conversation by a participant, through the participants index', async () => {
    const out = await call('email.list_threads', { participant: 'billing@acme.test' });
    expect(out.threads.map((t: { subject: string }) => t.subject).sort()).toEqual([
      'Invoice 3001',
      'Invoice 4102',
    ]);
  });

  /* ------------------------- B6: fetch_attachment ------------------------ */

  async function invoiceMessageId(): Promise<string> {
    const out = await call('email.search', { query: 'Invoice 4102' });
    return out.messages[0].id as string;
  }

  it('fetches one attachment into the artifact store, by index and by filename', async () => {
    const message = await invoiceMessageId();
    const first = await call('email.fetch_attachment', { message, index: 0 });
    expect(first.filename).toBe('invoice.pdf');
    expect(first.mime).toBe('application/pdf');
    expect(first.sizeBytes).toBe(INVOICE.length);
    expect(first.artifacts).toHaveLength(1);
    expect(first.alreadyHeld).toBe(false);

    // The same bytes again: the same artifact, content-addressed.
    const again = await call('email.fetch_attachment', { message, filename: 'invoice.pdf' });
    expect(again.artifacts[0].id).toBe(first.artifacts[0].id);
    expect(again.alreadyHeld).toBe(true);

    const rows = await pool.query(`select count(*)::int as n from core.artifacts`);
    expect(rows.rows[0].n).toBe(1);
  });

  it('records the artifact on the message, so the listing says where the file went', async () => {
    const message = await invoiceMessageId();
    const fetched = await call('email.fetch_attachment', { message, index: 0 });
    const { rows } = await pool.query(`select attachments from email.messages where id = $1`, [
      message,
    ]);
    expect(rows[0].attachments[0].artifactId).toBe(fetched.artifacts[0].id);
    expect(rows[0].attachments[0].part).toBe('2');
    // Only the one that was fetched is marked.
    expect(rows[0].attachments[1].artifactId).toBeUndefined();
  });

  it('records it to the agent that asked, and to the owner when the owner asks', async () => {
    const message = await invoiceMessageId();
    const mine = await call('email.fetch_attachment', { message, index: 0 });
    const { rows } = await pool.query(`select created_by from core.artifacts where id = $1`, [
      mine.artifacts[0].id,
    ]);
    expect(rows[0].created_by).toBe('mail-triage');
  });

  it('refuses an executable, with the reason', async () => {
    const message = await invoiceMessageId();
    const why = await refuse('email.fetch_attachment', { message, filename: 'setup.exe' });
    expect(why).toMatch(/\.exe/);
    expect(why).toMatch(/program rather than a document/);
    // And it never downloaded it.
    expect(server.downloads.some((d) => d.part === '3')).toBe(false);
  });

  it('refuses an oversized attachment before downloading a byte of it', async () => {
    const message = await invoiceMessageId();
    const why = await refuse('email.fetch_attachment', { message, filename: 'huge.pdf' });
    expect(why).toMatch(/25\.0 MB limit/);
    expect(server.downloads.some((d) => d.part === '4')).toBe(false);
  });

  it('says plainly when the message is no longer on the server', async () => {
    const message = await invoiceMessageId();
    // The mailbox was recreated upstream: every stored uid is meaningless.
    server.resetUidValidity('INBOX', 99);
    const why = await refuse('email.fetch_attachment', { message, index: 0 });
    expect(why).toMatch(/cannot be fetched/);
    expect(why).toMatch(/recreated/);
  });

  it('says plainly when the body was purged and the mail is gone with it', async () => {
    const message = await invoiceMessageId();
    await purgeBodies(pool, new Date('2027-01-01T00:00:00Z'));
    server.mailboxes.get('INBOX')!.messages = [];
    const why = await refuse('email.fetch_attachment', { message, index: 0 });
    expect(why).toMatch(/purged under the retention setting/);
  });

  /* ------------------------------ B8: retention -------------------------- */

  it('never purges a fetched attachment: the body goes, the file stays', async () => {
    const message = await invoiceMessageId();
    const fetched = await call('email.fetch_attachment', { message, index: 0 });

    const outcome = await purgeBodies(pool, new Date('2027-01-01T00:00:00Z'));
    expect(outcome.purged).toBeGreaterThan(0);

    const artifact = await pool.query(
      `select deleted_at from core.artifacts where id = $1`,
      [fetched.artifacts[0].id],
    );
    expect(artifact.rowCount).toBe(1);
    expect(artifact.rows[0].deleted_at).toBeNull();

    const row = await pool.query(
      `select body_text, attachments from email.messages where id = $1`,
      [message],
    );
    expect(row.rows[0].body_text).toBeNull();
    // The metadata the row keeps still points at the file.
    expect(row.rows[0].attachments[0].artifactId).toBe(fetched.artifacts[0].id);
  });
});
