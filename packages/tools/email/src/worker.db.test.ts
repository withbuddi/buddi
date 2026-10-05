/**
 * The plugin's background hand, over a throwaway database and a fake mailbox:
 * the text clean-up of messages synced before pre.44, and the reading pane's
 * one fetch of an older message's HTML. No socket is opened to any mailbox.
 */
import type { BuddiHost, CoreToolContext } from '@buddi/core/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  configurePluginHost,
  createPluginHost,
  createPool,
  createVault,
  hostBindingOf,
  pageQueryContext,
  resetPluginHost,
  isolatedTestDatabaseUrl,
  runMigrations,
  type Vault,
} from '@buddi/core/testing';
import { secretNameFor, writeGmailAccount } from './config.js';
import { FakeImapServer, fakeMessage } from './imap/fake.js';
import { createEmailManifest, manifest as emailManifestForHost } from './index.js';
import { messageQuery } from './pages/queries.js';
import type { ImapClientFactory } from './ports.js';
import { createInboxPollSource } from './sources/inbox-poll.js';
import type { DbArea, DbTransaction } from '@buddi/core/plugin';
import { cleanOlderText, TEXT_CLEANUP_KEY } from './text-cleanup.js';
import { MailWorker } from './worker.js';

function hosted<C>(facts: C): C & { buddi: BuddiHost } {
  const ctx = { ...facts } as C & { buddi: BuddiHost };
  ctx.buddi = createPluginHost(hostBindingOf(emailManifestForHost), ctx as never);
  return ctx;
}

// An explicit DATABASE_URL only: the vault is never asked, port 55433 is
// refused, and BUDDI_VAULT=memory is required (the isolated global setup).
const databaseUrl = isolatedTestDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;
const TEST_DB = `buddi_email_worker_test_${process.pid}`;
const OWNER = 'owner@example.test';
const PAD = '&#8202;&zwnj;'.repeat(30);

suite('the mail worker, over postgres', () => {
  let admin: Pool;
  let pool: Pool;
  let dataDir: string;
  let imap: FakeImapServer;
  const env = { [secretNameFor(OWNER)]: 'app-password' };
  const connect: ImapClientFactory = async () => imap.client();
  const now = () => new Date('2026-10-05T12:00:00Z');
  const writable = () => hosted({ db: pool, now, timezone: 'UTC', log: () => {}, enqueueRun: async () => {} });
  /** The pane's read, as the query route makes it: read-only pool and a host built over it. */
  const open = async (worker: MailWorker, id: string): Promise<any> =>
    messageQuery(worker).produce({ id }, hosted(pageQueryContext({ db: pool, now, timezone: 'UTC', agentId: 'owner' } as unknown as CoreToolContext)));

  beforeAll(async () => {
    // The memory vault and a scratch data dir, before anything resolves: the
    // host reads the data dir from its configured env, not process.env.
    dataDir = await mkdtemp(path.join(tmpdir(), 'buddi-email-worker-'));
    configurePluginHost({
      vault: createVault({ env: { BUDDI_VAULT: 'memory' } as NodeJS.ProcessEnv }) as Vault,
      env: { ...env, BUDDI_VAULT: 'memory', BUDDI_DATA_DIR: dataDir },
    });
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    await runMigrations(pool, [createEmailManifest({ connect, env })]);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    resetPluginHost();
  });

  /** The plugin's own database area over the test pool, as core hands it. */
  const area = (): DbArea => writable().buddi.db;

  /**
   * Messages as a sync before pre.44 left them: no HTML kept, text as the old
   * regexes made it. `html: false` serves them as text-only mail; `keepHtml`
   * leaves `body_html` as the sync stored it.
   */
  async function seed(bodies: string[], opts: { html?: boolean; keepHtml?: boolean } = {}): Promise<string[]> {
    await pool.query('truncate email.drafts, email.triage, email.messages, email.threads, email.folders, email.accounts, email.settings cascade');
    imap = new FakeImapServer();
    bodies.forEach((bodyText, i) =>
      imap.add(
        'INBOX',
        fakeMessage({
          messageId: `<m${i}@news.test>`,
          subject: `Issue ${i}`,
          bodyText,
          ...(opts.html === false ? {} : { bodyHtml: `<p>Issue <b>${i}</b> &amp; more</p><img src="https://pics.test/${i}.png">` }),
          date: new Date(Date.UTC(2026, 8, 1 + i)),
        }),
      ),
    );
    await writeGmailAccount(pool, OWNER);
    await createInboxPollSource({ connect, env, backfill: 1_000 }).poll(writable());
    if (opts.keepHtml !== true) await pool.query(`update email.messages set body_html = null`);
    const { rows } = await pool.query(`select id::text as id from email.messages order by subject`);
    return rows.map((r) => String(r.id));
  }

  describe('the text clean-up', () => {
    it('rewrites only HTML-derived text that still carries entities or padding, in batches, and carries on after a restart', async () => {
      const ids = await seed([
        `Preview line${PAD} Q&#38;A with Ana &rsquo;24`,
        'Already clean text.',
        'Tickets &amp; more​‌',
        `${PAD}AT&T;`,
        'Caf&eacute; &#x2014; open',
        'A plain letter about HTML: write &copy; for ©.\n    indented on purpose',
        `Checked, no HTML part${PAD} &copy;`,
      ]);
      // Snippets as the old sync cut them: from the padded text.
      await pool.query(`update email.messages set snippet = left(body_text, 40)`);
      // Row 4's HTML part is kept (synced under pre.44); row 6 is known to have none.
      await pool.query(`update email.messages set body_html = '<p>Café</p>' where id = $1::uuid`, [ids[4]]);
      await pool.query(`update email.messages set body_html = '' where id = $1::uuid`, [ids[6]]);

      // One batch of two, then a "restart".
      const first = await cleanOlderText(area(), { batchSize: 2, maxBatches: 1, pause: async () => {} });
      expect(first).toMatchObject({ done: false, ran: true });
      const { rows: saved } = await pool.query(`select value from email.settings where key = $1`, [TEXT_CLEANUP_KEY]);
      expect(saved[0]?.value).toMatchObject({ done: false });

      const rest = await cleanOlderText(area(), { batchSize: 2, pause: async () => {} });
      expect(rest).toMatchObject({ done: true, ran: true, total: 4 });

      const { rows } = await pool.query(`select id::text as id, body_text, snippet from email.messages`);
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      expect(byId.get(ids[0]!)).toMatchObject({ body_text: 'Preview line Q&A with Ana ’24', snippet: 'Preview line Q&A with Ana ’24' });
      expect(byId.get(ids[1]!)).toMatchObject({ body_text: 'Already clean text.' });
      expect(byId.get(ids[2]!)).toMatchObject({ body_text: 'Tickets & more' });
      expect(byId.get(ids[3]!)).toMatchObject({ body_text: 'AT&T;' });
      expect(byId.get(ids[4]!)).toMatchObject({ body_text: 'Café — open' });
      // Plain-text mail is left exactly as written, entities, indentation and all.
      expect(byId.get(ids[5]!)).toMatchObject({ body_text: 'A plain letter about HTML: write &copy; for ©.\n    indented on purpose' });
      expect(byId.get(ids[6]!)).toMatchObject({ body_text: `Checked, no HTML part${PAD} &copy;` });
      for (const id of ids.slice(0, 5)) expect(String(byId.get(id)?.snippet)).not.toMatch(/&#|&zwnj;|​|‌| /);

      // Finished is finished: another start reads nothing.
      expect(await cleanOlderText(area(), { pause: async () => {} })).toMatchObject({ ran: false, done: true, cleaned: 0 });
    });

    /** The area, with a hook on each statement the pass runs inside its transaction. */
    function hooked(onQuery: (sql: string, run: () => Promise<any>) => Promise<any>): DbArea {
      const db = area();
      return {
        query: (sql: string, params?: unknown[]) => db.query(sql, params),
        transaction: <T>(fn: (tx: DbTransaction) => Promise<T>) =>
          db.transaction((tx) => fn({ query: (sql: string, params?: unknown[]) => onQuery(sql, () => tx.query(sql, params)) } as DbTransaction)),
      } as DbArea;
    }

    it('commits a batch and its cursor together, so a crash between them decodes nothing twice', async () => {
      const [id] = await seed([`Fish${PAD} &amp;copy; chips`]);
      const crashing = hooked(async (sql, run) => {
        if (sql.includes('insert into email.settings')) throw new Error('killed before the checkpoint');
        return run();
      });
      await expect(cleanOlderText(crashing, { pause: async () => {} })).rejects.toThrow('killed before the checkpoint');
      // Rolled back with the checkpoint: the body is as it was, nothing saved.
      const { rows: before } = await pool.query(`select body_text from email.messages where id = $1::uuid`, [id]);
      expect(before[0]?.body_text).toBe(`Fish${PAD} &amp;copy; chips`);
      const { rows: progress } = await pool.query(`select value from email.settings where key = $1`, [TEXT_CLEANUP_KEY]);
      expect(progress).toHaveLength(0);

      // The restart decodes it once: `&amp;copy;` is the text `&copy;`, never ©.
      expect(await cleanOlderText(area(), { pause: async () => {} })).toMatchObject({ done: true, total: 1 });
      const { rows: after } = await pool.query(`select body_text from email.messages where id = $1::uuid`, [id]);
      expect(after[0]?.body_text).toBe('Fish &copy; chips');
    });

    it('never restores a body retention purged while the batch was running', async () => {
      const [id] = await seed([`Old news${PAD} &amp; more`]);
      let purge: Promise<unknown> | undefined;
      const racing = hooked(async (sql, run) => {
        const result = await run();
        if (sql.trimStart().startsWith('select id::text') && purge === undefined) {
          // Retention purges the row from another connection, between the
          // pass's read and its write.
          purge = pool.query(
            `update email.messages set body_text = null, body_html = null, body_purged_at = now() where id = $1::uuid`,
            [id],
          );
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        return result;
      });
      await cleanOlderText(racing, { pause: async () => {} });
      await purge;
      const { rows } = await pool.query(`select body_text, body_purged_at from email.messages where id = $1::uuid`, [id]);
      expect(rows[0]?.body_text).toBeNull();
      expect(rows[0]?.body_purged_at).not.toBeNull();
    });

    it('starts once per plugin start, from the first poll, and logs one line at the end', async () => {
      await seed([`Hello${PAD} &amp; welcome`]);
      const lines: string[] = [];
      const worker = new MailWorker({ connect, env, cleanup: { pause: async () => {} } });
      const source = createInboxPollSource({ connect, env, backfill: 1_000, worker });
      const ctx = hosted({ db: pool, now, timezone: 'UTC', log: (line: string) => lines.push(line), enqueueRun: async () => {} });
      await source.poll(ctx);
      await source.poll(ctx);
      expect(await worker.cleanupSettled()).toMatchObject({ done: true, total: 1 });
      expect(lines.filter((l) => l.includes('mail: cleaned the text of'))).toEqual(['[email] mail: cleaned the text of 1 older message']);
      const { rows } = await pool.query(`select body_text from email.messages`);
      expect(rows[0]?.body_text).toBe('Hello & welcome');
    });
  });

  describe("the pane's HTML for an older message", () => {
    it('is fetched once, stored, and read from the store after that', async () => {
      const [id] = await seed(['Issue 0 & more']);
      const worker = new MailWorker({ connect, env, cleanup: { maxBatches: 0 } });
      worker.attach(writable());

      const first = await open(worker, id!);
      expect(first.html).toContain('Issue <b>0</b> &amp; more');
      // Remote pictures are kept as addresses, never fetched (the dashboard hides them behind Show images).
      expect(first.html).toContain('<img src="https://pics.test/0.png">');
      expect(imap.htmlFetches).toHaveLength(1);
      const { rows } = await pool.query(`select body_html from email.messages where id = $1::uuid`, [id]);
      expect(rows[0]?.body_html).toBe(first.html);

      const second = await open(worker, id!);
      expect(second.html).toBe(first.html);
      expect(imap.htmlFetches).toHaveLength(1);
    });

    it('gives up after the wait, draws the text, and does not try again within the hour', async () => {
      const [id] = await seed(['Issue 0 & more']);
      let clock = 1_000_000;
      const worker = new MailWorker({ connect, env, waitMs: 50, now: () => clock, cleanup: { maxBatches: 0 } });
      worker.attach(writable());
      imap.htmlDelayMs = 300;

      const slow = await open(worker, id!);
      expect(slow).toMatchObject({ html: null, text: 'Issue 0 & more' });
      expect(imap.htmlFetches).toHaveLength(1);

      // Opened again at once: no second fetch, and no wait.
      const started = Date.now();
      const again = await open(worker, id!);
      expect(again.text).toBe('Issue 0 & more');
      expect(Date.now() - started).toBeLessThan(250);
      expect(imap.htmlFetches).toHaveLength(1);

      // The slow fetch still stores what it got, and the next open reads it.
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect((await open(worker, id!)).html).toContain('Issue <b>0</b>');
      expect(imap.htmlFetches).toHaveLength(1);

      // A message that failed is tried again an hour later.
      await pool.query(`update email.messages set body_html = null`);
      imap.htmlDelayMs = 0;
      expect((await open(worker, id!)).html).toBeNull();
      clock += 61 * 60 * 1000;
      const later = await open(worker, id!);
      expect(later.html).toContain('Issue <b>0</b>');
      expect(imap.htmlFetches).toHaveLength(2);
    });

    it('stores text-only mail as "no HTML" at sync, and never asks the server for it', async () => {
      const [id] = await seed(['Just words.'], { html: false, keepHtml: true });
      const { rows } = await pool.query(`select body_html from email.messages where id = $1::uuid`, [id]);
      expect(rows[0]?.body_html).toBe('');
      const worker = new MailWorker({ connect, env, cleanup: { maxBatches: 0 } });
      worker.attach(writable());
      expect((await open(worker, id!)).html).toBeNull();
      expect(imap.htmlFetches).toHaveLength(0);
    });

    it('remembers an older message found to have no HTML part, across restarts', async () => {
      const [id] = await seed(['Just words.'], { html: false });
      const worker = new MailWorker({ connect, env, cleanup: { maxBatches: 0 } });
      worker.attach(writable());
      expect((await open(worker, id!)).html).toBeNull();
      expect(imap.htmlFetches).toHaveLength(1);
      const { rows } = await pool.query(`select body_html from email.messages where id = $1::uuid`, [id]);
      expect(rows[0]?.body_html).toBe('');

      // A fresh start, with no failures in memory, still never asks again.
      const restarted = new MailWorker({ connect, env, cleanup: { maxBatches: 0 } });
      restarted.attach(writable());
      expect((await open(restarted, id!)).html).toBeNull();
      expect(imap.htmlFetches).toHaveLength(1);
    });

    it('never fetches for a purged message, or before the first poll', async () => {
      const [id] = await seed(['Issue 0 & more']);
      const idle = new MailWorker({ connect, env });
      expect((await open(idle, id!)).html).toBeNull();
      const worker = new MailWorker({ connect, env, cleanup: { maxBatches: 0 } });
      worker.attach(writable());
      await pool.query(`update email.messages set body_text = null, body_purged_at = now()`);
      expect((await open(worker, id!)).html).toBeNull();
      expect(imap.htmlFetches).toHaveLength(0);
    });
  });
});
