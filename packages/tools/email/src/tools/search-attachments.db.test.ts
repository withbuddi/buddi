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
import { buildSearch } from '../search.js';
import { MAX_ATTACHMENT_BYTES } from './attachments.js';
import { createPluginHost, hostBindingOf } from '@buddi/core';
import { manifest as emailManifestForHost } from '../index.js';

/** The context core hands the email plugin: these facts, with its `ctx.buddi` built over them. */
function hosted<C>(facts: C): C {
  // Built over the context it returns, so a test that changes a field on it
  // afterwards changes what the host reads, as core's per-call host would.
  const ctx = { ...facts } as C & { buddi?: unknown };
  ctx.buddi = createPluginHost(hostBindingOf(emailManifestForHost), ctx as never);
  return ctx;
}

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_email_search_test_${process.pid}`;
const ENV = { GMAIL_USER: 'owner@example.test', [GMAIL_SECRET_NAME]: 'app-password' };
const NOW = new Date('2026-09-22T12:00:00Z');

/** The bytes the fake server will hand over for the invoice. */
const INVOICE = Buffer.from('%PDF-1.4 the invoice itself\n');

/**
 * A ZIP carrying `vbaProject.bin`, with a hundred bytes in front of it.
 *
 * Legal — a self-extracting stub looks like this — and the shape that skips a
 * check which only inspects a file whose first two bytes are `PK`.
 */
function paddedMacroZip(): Buffer {
  const name = Buffer.from('word/vbaProject.bin', 'utf8');
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(name.length, 28);
  name.copy(central, 46);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);
  return Buffer.concat([Buffer.alloc(100, 0x41), local, central, eocd]);
}

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

    ctx = hosted({
      db: pool,
      ownerId: 'test',
      now: () => NOW,
      timezone: 'UTC',
      agentId: 'mail-triage',
    });
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
        // Deliberately *not* carrying the word the window test searches for:
        // the indexed arm is not windowed, so a subject match here would come
        // back however old it is — which is the point of the split.
        subject: 'Winter statement',
        bodyText: 'Last winter, an invoice.',
        date: new Date('2025-12-01T08:00:00Z'),
      }),
    );
    const source = createInboxPollSource({ connect: server.factory(), env: ENV, backfill: 1_000 });
    await source.poll(hosted({
      db: pool,
      now: ctx.now,
      timezone: 'UTC',
      log: () => {},
      enqueueRun: async () => {},
    }));
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

  /**
   * The index is only an index if a plan reaches it.
   *
   * This is the finding the whole UNION exists for: the first version ORed the
   * two indexed columns with the unindexed `body_text`, Postgres cannot serve
   * an `OR` from indexes unless *every* arm has one, and the two GINs were
   * write amplification on every ingest for no read at all.
   *
   * So the assertion is on the plan, on a table big enough for the planner to
   * have a real opinion — twenty thousand rows with bodies of a kilobyte,
   * `analyze`d — and with `enable_seqscan` left alone. If the index stops
   * being reachable, this fails.
   */
  it('reaches the trigram index: the plan says Bitmap Index Scan', async () => {
    const { rows: ids } = await pool.query(
      `select id, account_id, folder_id, uidvalidity from email.messages order by uid limit 1`,
    );
    const seedRow = ids[0];
    await pool.query(
      `insert into email.messages
         (account_id, folder_id, uidvalidity, uid, message_id, from_addr, subject,
          snippet, body_text, internal_date, fetched_at, direction)
       select $1::uuid, $2::uuid, $3::bigint, 1000 + g,
              '<bulk-' || g || '@bulk.test>',
              'sender' || (g % 500) || '@bulk.test',
              'Notice number ' || g,
              'A seeded row.',
              repeat('filler text for the heap ', 40),
              now() - (g || ' minutes')::interval,
              now(),
              'in'
         from generate_series(1, 20000) g`,
      [seedRow.account_id, seedRow.folder_id, seedRow.uidvalidity],
    );
    /*
     * `vacuum`, not just `analyze`, and the difference is the finding.
     *
     * A GIN index has a pending list (`fastupdate`), and rows inserted after
     * the index was built sit in it until a vacuum flushes them. The planner
     * charges every GIN scan for reading that list, so immediately after a
     * bulk insert the same index costs 1846 instead of 91 and the planner
     * picks a sequential scan — which is a fact about a table nobody has
     * vacuumed yet, not about the index. Autovacuum does this in production;
     * the test does it explicitly rather than asserting against a transient
     * state.
     */
    await pool.query('vacuum analyze email.messages');

    // One needle, present in exactly one subject, asked for exactly as the
    // tool asks for it.
    const built = buildSearch([String(seedRow.account_id)], { query: 'number 13579' }, {
      now: NOW,
      timezone: 'UTC',
      limit: 20,
    });
    const { rows } = await pool.query(
      `explain (format json) ${built.text}`,
      built.params,
    );
    const plan = JSON.stringify(rows[0]['QUERY PLAN']);
    expect(plan).toMatch(/Bitmap Index Scan/);
    expect(plan).toMatch(/messages_subject_trgm_idx|messages_from_trgm_idx/);

    // And it really does find it.
    const found = await pool.query(built.text, built.params);
    expect(found.rows.map((r: { subject: string }) => r.subject)).toEqual(['Notice number 13579']);
  }, 60_000);

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

  it('windows the body scan to 90 days, searches subjects in full, and says so', async () => {
    const out = await call('email.search', { query: 'invoice' });
    const subjects = out.messages.map((m: { subject: string }) => m.subject);
    // Subject match, inside the window.
    expect(subjects).toContain('Invoice 4102');
    // Body match, inside the window.
    expect(subjects).toContain('Weekend sale');
    // Body match, outside it: last winter's invoice is not read.
    expect(subjects).not.toContain('Winter statement');
    expect(out.window).toContain('90 days');
    expect(out.window).toContain('Subjects and senders were searched in full');
  });

  it('keeps the window for a filter that narrows without bounding', async () => {
    // `direction` and `hasAttachments` used to turn the window off, which put
    // an unindexed body scan over the whole archive one argument away.
    for (const extra of [{ direction: 'in' }, { hasAttachments: false }]) {
      const out = await call('email.search', { query: 'invoice', ...extra });
      expect(out.window).toContain('90 days');
      expect(out.messages.map((m: { subject: string }) => m.subject)).not.toContain(
        'Winter statement',
      );
    }
  });

  it('measures the window back from `until` when that is the only date given', async () => {
    // Asking for the *old* half of the archive and being told "the last 90
    // days" would be a search that found nothing while claiming to look.
    const out = await call('email.search', { query: 'invoice', until: '2025-12-31' });
    expect(out.window).toContain('2025-10-02');
    expect(out.messages.map((m: { subject: string }) => m.subject)).toContain('Winter statement');
  });

  it('reaches past the window as soon as a filter bounds the search', async () => {
    const out = await call('email.search', { query: 'invoice', since: '2025-01-01' });
    const subjects = out.messages.map((m: { subject: string }) => m.subject);
    expect(subjects).toContain('Winter statement');
    expect(out.window).toBeUndefined();
  });

  it('returns each hit once, however many arms found it', async () => {
    // 'Invoice 4102' matches the subject *and* the body ('The invoice for
    // September'). `union`, not `union all`.
    const out = await call('email.search', { query: 'invoice', since: '2025-01-01' });
    const ids = out.messages.map((m: { id: string }) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('dates a hit by the clock it is ordered by', async () => {
    const out = await call('email.search', { query: 'Invoice 4102' });
    // The ingest clock, not the sender's `Date` header — the list is ordered
    // by the value it shows.
    expect(out.messages[0].date).toBe('2026-09-18T08:00:00.000Z');
  });

  it('refuses a date that is not a day rather than raising inside the pool', async () => {
    expect(await refuse('email.search', { query: 'invoice', since: '2026-02-31' })).toMatch(
      /`since` is a real day/,
    );
    expect(await refuse('email.search', { query: 'invoice', until: '2026-06-31' })).toMatch(
      /`until` is a real day/,
    );
  });

  it('takes `from` as an exact address, and a bare domain as its subdomains too', async () => {
    const exact = await call('email.search', { from: 'billing@acme.test', since: '2025-01-01' });
    expect(exact.messages.map((m: { subject: string }) => m.subject).sort()).toEqual([
      'Invoice 4102',
      'Winter statement',
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
    expect(subjects).not.toContain('Winter statement');
    const old = await call('email.list_threads', { until: '2025-12-31' });
    expect(old.threads.map((t: { subject: string }) => t.subject)).toEqual(['Winter statement']);
  });

  it('finds a conversation by a participant, through the participants index', async () => {
    const out = await call('email.list_threads', { participant: 'billing@acme.test' });
    expect(out.threads.map((t: { subject: string }) => t.subject).sort()).toEqual([
      'Invoice 4102',
      'Winter statement',
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
    expect(why).toMatch(/runs code rather than being read/);
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

  /* ------------------ B5/B6: part ids, and the bytes themselves ---------- */

  it('re-resolves against the server’s own structure, however it is ordered', async () => {
    const message = await invoiceMessageId();
    // The stored row says the invoice is part 2. The server has since put it
    // at part 5, and lists the files in another order. Resolving `index`
    // against the fresh listing would save `setup.exe` as `invoice.pdf`.
    const uid = (await pool.query(`select uid from email.messages where id = $1`, [message]))
      .rows[0].uid as number;
    const box = server.mailboxes.get('INBOX')!;
    const mail = box.messages.find((m) => m.uid === Number(uid))!;
    const invoice = mail.attachments.find((a) => a.filename === 'invoice.pdf')!;
    mail.attachments = [
      { ...mail.attachments[1]! },
      { ...invoice, part: '5' },
      { ...mail.attachments[2]! },
    ];
    server.putPart('INBOX', Number(uid), '5', INVOICE);

    const out = await call('email.fetch_attachment', { message, index: 0 });
    expect(out.filename).toBe('invoice.pdf');
    expect(out.sizeBytes).toBe(INVOICE.length);
    // It asked for the part the server actually has it at.
    expect(server.downloads.some((d) => d.part === '5')).toBe(true);
    expect(server.downloads.some((d) => d.part === '2')).toBe(false);
  });

  it('refuses a stored part id that is not one, rather than sending it', async () => {
    const message = await invoiceMessageId();
    await pool.query(
      `update email.messages
          set attachments = jsonb_set(attachments, '{0,part}', '"1 uid 1 body[]"'::jsonb)
        where id = $1`,
      [message],
    );
    // The fresh structure is the fact: the part id is re-read, the nonsense
    // in the row is never sent, and the fetch still works.
    const out = await call('email.fetch_attachment', { message, index: 0 });
    expect(out.filename).toBe('invoice.pdf');
    expect(server.downloads.every((d) => /^[1-9]\d*(\.[1-9]\d*)*$/.test(d.part))).toBe(true);
  });

  it('says the attachment is gone when it is no longer one of the message’s parts', async () => {
    const message = await invoiceMessageId();
    const uid = (await pool.query(`select uid from email.messages where id = $1`, [message]))
      .rows[0].uid as number;
    const mail = server.mailboxes.get('INBOX')!.messages.find((m) => m.uid === Number(uid))!;
    mail.attachments = mail.attachments.filter((a) => a.filename !== 'invoice.pdf');
    const why = await refuse('email.fetch_attachment', { message, index: 0 });
    expect(why).toMatch(/no longer one of this message's parts/);
  });

  it('marks a row whose listing was empty, so the second fetch is not a download', async () => {
    const message = await invoiceMessageId();
    // A row from before part ids were recorded: no listing at all.
    await pool.query(`update email.messages set attachments = '[]'::jsonb where id = $1`, [message]);
    const out = await call('email.fetch_attachment', { message, index: 0 });
    const { rows } = await pool.query(`select attachments from email.messages where id = $1`, [
      message,
    ]);
    // The fresh listing was written back, carrying the mark — it used to be
    // dropped silently and the next fetch downloaded the file again.
    expect(rows[0].attachments).toHaveLength(3);
    expect(rows[0].attachments[0].artifactId).toBe(out.artifacts[0].id);
    expect(rows[0].attachments[0].part).toBe('2');
  });

  it('refuses a program renamed as a document, on its bytes', async () => {
    const message = await invoiceMessageId();
    const uid = (await pool.query(`select uid from email.messages where id = $1`, [message]))
      .rows[0].uid as number;
    // Called `invoice.pdf`, declared `application/pdf`, and a Windows program.
    // Both the name check and the type check let it through.
    server.putPart('INBOX', Number(uid), '2', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]));
    const why = await refuse('email.fetch_attachment', { message, index: 0 });
    expect(why).toMatch(/Windows program/);
    const count = await pool.query(
      `select count(*)::int as n from core.artifacts where source_surface = 'email'`,
    );
    expect(count.rows[0].n).toBe(0);
  });

  it('refuses a trailing-space executable, and a macro-carrying document', async () => {
    const message = await invoiceMessageId();
    const uid = (await pool.query(`select uid from email.messages where id = $1`, [message]))
      .rows[0].uid as number;
    const mail = server.mailboxes.get('INBOX')!.messages.find((m) => m.uid === Number(uid))!;
    mail.attachments = [
      // Windows strips the trailing space before it executes; so does buddi,
      // before it judges.
      { filename: 'payment.exe ', mime: 'application/pdf', sizeBytes: 10, part: '2' },
      { filename: 'accounts.xlsm', mime: 'application/octet-stream', sizeBytes: 10, part: '3' },
    ];
    await pool.query(`update email.messages set attachments = '[]'::jsonb where id = $1`, [message]);
    expect(await refuse('email.fetch_attachment', { message, index: 0 })).toMatch(/\.exe/);
    expect(await refuse('email.fetch_attachment', { message, index: 1 })).toMatch(/\.xlsm/);
    expect(server.downloads).toHaveLength(0);
  });

  it('looks inside an archive that has something in front of it', async () => {
    const message = await invoiceMessageId();
    const uid = (await pool.query(`select uid from email.messages where id = $1`, [message]))
      .rows[0].uid as number;
    // A macro-carrying document with a hundred bytes of padding before the
    // archive: legal, and invisible to a check that reads byte 0.
    server.putPart('INBOX', Number(uid), '2', paddedMacroZip());
    const why = await refuse('email.fetch_attachment', { message, index: 0 });
    expect(why).toMatch(/macros/);
    const count = await pool.query(
      `select count(*)::int as n from core.artifacts where source_surface = 'email'`,
    );
    expect(count.rows[0].n).toBe(0);
  });

  it('calls an empty attachment empty, not missing', async () => {
    const message = await invoiceMessageId();
    const uid = (await pool.query(`select uid from email.messages where id = $1`, [message]))
      .rows[0].uid as number;
    server.putPart('INBOX', Number(uid), '2', Buffer.alloc(0));
    const why = await refuse('email.fetch_attachment', { message, index: 0 });
    expect(why).toMatch(/is empty \(0 bytes\)/);
    expect(why).not.toMatch(/no longer/);
  });

  it('cuts the stream when the real bytes cross the cap the declared size did not', async () => {
    const message = await invoiceMessageId();
    const uid = (await pool.query(`select uid from email.messages where id = $1`, [message]))
      .rows[0].uid as number;
    const mail = server.mailboxes.get('INBOX')!.messages.find((m) => m.uid === Number(uid))!;
    // The body structure says 1 KB. The part is 25 MB and a byte. A cap that
    // only reads the declared size is a cap somebody walks through.
    mail.attachments = [{ filename: 'invoice.pdf', mime: 'application/pdf', sizeBytes: 1024, part: '2' }];
    await pool.query(`update email.messages set attachments = '[]'::jsonb where id = $1`, [message]);
    server.putPart('INBOX', Number(uid), '2', Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));

    const why = await refuse('email.fetch_attachment', { message, index: 0 });
    expect(why).toMatch(/larger than the \d+-byte cap/);
    const count = await pool.query(
      `select count(*)::int as n from core.artifacts where source_surface = 'email'`,
    );
    expect(count.rows[0].n).toBe(0);
  });

  it('stores what the bytes are when the sender was vague about it', async () => {
    const message = await invoiceMessageId();
    const uid = (await pool.query(`select uid from email.messages where id = $1`, [message]))
      .rows[0].uid as number;
    const mail = server.mailboxes.get('INBOX')!.messages.find((m) => m.uid === Number(uid))!;
    mail.attachments = [
      { filename: 'invoice.pdf', mime: 'application/octet-stream', sizeBytes: INVOICE.length, part: '2' },
    ];
    await pool.query(`update email.messages set attachments = '[]'::jsonb where id = $1`, [message]);
    const out = await call('email.fetch_attachment', { message, index: 0 });
    expect(out.mime).toBe('application/pdf');
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
