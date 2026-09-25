/**
 * The mail pages' reads and writes, over a throwaway database.
 *
 * The screens themselves are drawn by the generic engine, which has its own
 * tests and knows no plugin; what is *this* plugin's to prove is what the
 * pages ask for and what they do:
 *
 *  - every query answers the shape its descriptor draws, **through the
 *    read-only pool the engine hands it** (`pageQueryContext`), so a read the
 *    page makes cannot be a read that also writes;
 *  - every write refuses what the routes refused, in the same words — a
 *    mailbox added twice, a rule with no mailbox, a save against a version
 *    somebody else has moved past;
 *  - and none of them exists for anybody but the owner: an `ownerOnly` tool
 *    invoked as an agent is not "forbidden", it is *unknown*.
 */
import type { BuddiHost } from '@buddi/core/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  configurePluginHost,
  createPool,
  createVault,
  findSecret,
  ownerSecretVaultName,
  pageQueryContext,
  resetPluginHost,
  runMigrations,
  QueryRefusal,
  ToolRegistry,
  type Vault,
} from '@buddi/core/testing';
import { testDatabaseUrl } from '@buddi/core/testing';
import { ensureGmailAccount, GMAIL_SECRET_NAME, listAccounts, secretNameFor } from '../config.js';
import { FakeImapServer, fakeMessage } from '../imap/fake.js';
import { createEmailManifest } from '../index.js';
import { createInboxPollSource } from '../sources/inbox-poll.js';
import { emailPageDescriptors } from './descriptors.js';
import { MAX_BODY_BYTES, TRUNCATED_NOTE } from './queries.js';
import type { ImapClientFactory } from '../ports.js';
import type { CoreToolContext } from '@buddi/core/testing';
import { createPluginHost, hostBindingOf } from '@buddi/core/testing';
import { manifest as emailManifestForHost } from '../index.js';

/** The context core hands the email plugin: these facts, with its `ctx.buddi` built over them. */
function hosted<C>(facts: C): C & { buddi: BuddiHost } {
  // Built over the context it returns, so a test that changes a field on it
  // afterwards changes what the host reads, as core's per-call host would.
  const ctx = { ...facts } as C & { buddi: BuddiHost };
  ctx.buddi = createPluginHost(hostBindingOf(emailManifestForHost), ctx as never);
  return ctx;
}

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_email_pages_test_${process.pid}`;

/**
 * A view path, read the way the dashboard reads one (`canvas/resolve.ts`):
 * dotted names, `[n]` for an index, and `undefined` for a miss. The point of
 * the tests below is that a descriptor's paths are not misses.
 */
function readPath(source: unknown, path: string): unknown {
  if (path === '' || path === '$') return source;
  let cursor: unknown = source;
  for (const segment of path.split('.')) {
    const match = /^([^[\]]*)((?:\[\d+\])*)$/.exec(segment);
    if (!match) return undefined;
    const [, key = '', indexes = ''] = match;
    if (key !== '') {
      if (cursor === null || typeof cursor !== 'object') return undefined;
      cursor = (cursor as Record<string, unknown>)[key];
    }
    for (const index of indexes.match(/\d+/g) ?? []) {
      if (!Array.isArray(cursor)) return undefined;
      cursor = (cursor as unknown[])[Number(index)];
    }
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

const OWNER = 'owner@example.test';
const ADDED = 'owner@work.test';

suite('the mail pages, over postgres', () => {
  let admin: Pool;
  let pool: Pool;
  let dataDir: string;
  let registry: ToolRegistry;
  let ctx: CoreToolContext;
  let vault: Vault;
  let env: Record<string, string | undefined>;
  let imap: FakeImapServer;
  /** A clock a test can move: a version precondition is about two instants. */
  let clock = new Date('2026-09-21T12:00:00Z');

  /** One read, exactly as the query route makes it: read-only pool and all. */
  const ask = async (name: string, params: Record<string, unknown> = {}): Promise<any> => {
    const manifest = createEmailManifest();
    const query = (manifest.queries ?? []).find((q) => q.name === name);
    if (!query) throw new Error(`no query called ${name}`);
    const parsed = query.params.parse(params);
    return query.produce(parsed, pageQueryContext(ctx)) as Promise<any>;
  };

  /** One write, as the act route makes it: through the registry, as the owner. */
  const act = async (name: string, args: unknown, agentId = 'owner'): Promise<any> => {
    const result = await registry.invoke(name, args, { ...ctx, agentId });
    if (!result.ok) throw new Error(`${name} refused (${result.reason}): ${result.message}`);
    return result.output;
  };

  const refusal = async (name: string, args: unknown, agentId = 'owner'): Promise<string> => {
    const result = await registry.invoke(name, args, { ...ctx, agentId });
    if (result.ok) throw new Error(`${name} was expected to refuse`);
    return result.message;
  };

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());

    dataDir = await mkdtemp(path.join(tmpdir(), 'buddi-email-pages-'));
    process.env.BUDDI_DATA_DIR = dataDir;

    env = { GMAIL_USER: OWNER, [GMAIL_SECRET_NAME]: 'app-password' };
    vault = createVault({ env: { BUDDI_VAULT: 'memory' } as NodeJS.ProcessEnv }) as Vault;
    imap = new FakeImapServer();
    const connect: ImapClientFactory = async () => imap.client();

    configurePluginHost({ vault });
    const manifest = createEmailManifest({ connect, env });
    await runMigrations(pool, [manifest]);
    registry = new ToolRegistry();
    registry.register(manifest);

    ctx = hosted({
      db: pool,
      ownerId: 'test',
      now: () => clock,
      timezone: 'UTC',
      agentId: 'owner',
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
    resetPluginHost();
  });

  /** One mailbox, one conversation of two messages, one draft waiting on it. */
  async function seed(): Promise<{ threadId: string; messageId: string; draftId: string }> {
    await pool.query(
      'truncate email.drafts, email.policies, email.triage, email.messages, email.threads, email.folders, email.accounts, email.settings cascade',
    );
    imap = new FakeImapServer();
    imap.add(
      'INBOX',
      fakeMessage({
        messageId: '<invoice-1@client.test>',
        from: 'Dorothée <tdorothee@client.test>',
        to: [OWNER],
        subject: 'Invoice 42',
        bodyText: 'Could you resend invoice 42?',
        date: new Date('2026-09-20T08:00:00Z'),
      }),
    );
    await ensureGmailAccount(pool, env);
    const source = createInboxPollSource({
      connect: (async () => imap.client()) as ImapClientFactory,
      env,
      backfill: 1_000,
    });
    await source.poll(hosted({ db: pool, now: ctx.now, timezone: 'UTC', log: () => {}, enqueueRun: async () => {} }));

    const { rows } = await pool.query(`select id, thread_id from email.messages`);
    const messageId = String(rows[0]!.id);
    const threadId = String(rows[0]!.thread_id);
    // A listing, which is all ingest ever records: the page draws a Fetch per
    // row and the link to the file once somebody has fetched one.
    await pool.query(`update email.messages set attachments = $1::jsonb where id = $2::uuid`, [
      JSON.stringify([{ filename: 'invoice.pdf', mime: 'application/pdf', sizeBytes: 12_345, part: '2' }]),
      messageId,
    ]);
    // An agent's draft, which is what the owner's editor opens onto.
    const draft = await act('email.draft_reply', { inReplyTo: messageId, bodyText: 'It is attached.' }, 'mail-triage');
    return { threadId, messageId, draftId: String(draft.draft?.id ?? draft.id) };
  }

  let ids: { threadId: string; messageId: string; draftId: string };
  beforeEach(async () => {
    clock = new Date('2026-09-21T12:00:00Z');
    ids = await seed();
  });

  /* -------------------------------------------------------------- *
   * The reads
   * -------------------------------------------------------------- */

  it('lists the conversations with the draft pill, and searches the same rows', async () => {
    const listed = await ask('threads');
    expect(listed.threads).toHaveLength(1);
    // The state and the draft are two pills now, not one in place of the other.
    expect(listed.threads[0]).toMatchObject({ subject: 'Invoice 42', draftPill: 'draft' });
    expect(listed.threads[0].state).toBeTruthy();
    // Nothing narrows it, so the search half is empty rather than everything.
    expect(listed.items).toEqual([]);

    const found = await ask('threads', { q: 'invoice' });
    expect(found.count).toBe(1);
    expect(found.items[0]).toMatchObject({ threadId: ids.threadId, who: 'they wrote' });

    const none = await ask('threads', { q: 'nothing here says this' });
    expect(none.items).toEqual([]);
  });

  it('answers one conversation with its messages, its live draft and its ended ones', async () => {
    const thread = await ask('thread', { id: ids.threadId });
    expect(thread).toMatchObject({ subject: 'Invoice 42', hasMessages: true, hasDraft: true, hasOlder: false });
    expect(thread.messages[0]).toMatchObject({ from: expect.stringContaining('tdorothee@client.test') });
    // Snippets, never bodies: the page fetches one when the owner opens it.
    expect(thread.messages[0].bodyText).toBeUndefined();
    expect(thread.drafts).toHaveLength(1);
    expect(thread.drafts[0]).toMatchObject({ id: ids.draftId, live: true, unresolved: false });

    await act('email.discard_draft', { draftId: ids.draftId });
    const after = await ask('thread', { id: ids.threadId });
    expect(after.hasDraft).toBe(false);
    expect(after.hasOlder).toBe(true);
    expect(after.older[0]).toMatchObject({ status: 'discarded' });
  });

  it('answers one message, one draft, the mailboxes and the watcher settings', async () => {
    const message = await ask('message', { id: ids.messageId });
    expect(message).toMatchObject({ purged: false });
    expect(message.bodyText).toContain('resend invoice 42');
    // The listing, and where the file went — which is nowhere until somebody
    // fetches it. Keyed by its index, because a filename comes off the wire.
    expect(message.attachments).toEqual([
      {
        messageId: ids.messageId,
        index: 0,
        filename: 'invoice.pdf',
        detail: 'application/pdf · 12.1 KB',
        line: 'invoice.pdf — application/pdf · 12.1 KB',
        artifactId: null,
        held: 'not fetched',
      },
    ]);

    const draft = await ask('draft', { id: ids.draftId });
    expect(draft).toMatchObject({ id: ids.draftId, live: true, bodyText: 'It is attached.' });
    expect(draft.toText).toContain('tdorothee@client.test');

    const accounts = await ask('accounts');
    // Two pills, each with its own words and tone, rather than one sentence.
    expect(accounts.accounts[0]).toMatchObject({ address: OWNER });
    expect(accounts.accounts[0].state).toEqual([
      { value: 'on', tone: 'neutral' },
      { value: 'from .env', tone: 'neutral' },
    ]);
    expect(accounts.accounts[0].secretName).toBe(GMAIL_SECRET_NAME);

    /*
     * A body longer than the engine will carry is cut with a sentence rather
     * than making the whole answer fail its size cap: the one message the
     * owner opened must not be the one message that will not open.
     */
    // Multi-byte on purpose: the cap counts bytes, and a cut must still land
    // on a character rather than half of one.
    await pool.query(`update email.messages set body_text = $2 where id = $1::uuid`, [
      ids.messageId,
      '語'.repeat(MAX_BODY_BYTES),
    ]);
    const long = await ask('message', { id: ids.messageId });
    expect(Buffer.byteLength(long.bodyText, 'utf8')).toBeLessThanOrEqual(
      MAX_BODY_BYTES + Buffer.byteLength(`\n\n${TRUNCATED_NOTE}`, 'utf8'),
    );
    expect(long.bodyText).toContain(TRUNCATED_NOTE);
    expect(long.bodyText).not.toContain('\uFFFD');
    expect(long.bodyText.startsWith('語語語')).toBe(true);

    expect(await ask('watcher_settings')).toMatchObject({ waitingDays: 2, dateConfidence: 0.6 });
    await act('email.set_settings', { waitingDays: 5 });
    expect(await ask('watcher_settings')).toMatchObject({ waitingDays: 5 });
  });

  /**
   * The descriptors say `rows: 'threads'`, `key: 'id'`, `from: 'toText'`; the
   * queries above say what is actually there. Nothing checks the two against
   * each other at run time — a path that misses is an empty panel — so they
   * are checked here, against a real answer, for every array a page draws.
   */
  it('draws only paths its own queries answer with', async () => {
    const answers: Record<string, any> = {
      threads: await ask('threads', { q: 'invoice' }),
      thread: await ask('thread', { id: ids.threadId }),
      message: await ask('message', { id: ids.messageId }),
      draft: await ask('draft', { id: ids.draftId }),
      accounts: await ask('accounts'),
      policies: await ask('policies'),
      rule_threads: await ask('rule_threads'),
      watcher_settings: await ask('watcher_settings'),
    };
    const at = readPath;

    const seen: string[] = [];
    const walk = (node: any, query: string | null): void => {
      if (node === null || typeof node !== 'object') return;
      const own: string | null = node.query?.query ?? query;
      if (typeof node.rows === 'string' && own) {
        const rows = at(answers[own], node.rows);
        expect(Array.isArray(rows), `${own}.${node.rows} is an array`).toBe(true);
        seen.push(`${own}.${node.rows}`);
        const first = (rows as unknown[])[0];
        // A row's key, and — for a picker — the value it submits and the
        // words the owner reads.
        for (const field of ['key', 'value', 'label'] as const) {
          if (typeof node[field] === 'string' && first !== undefined) {
            expect(at(first, node[field]), `${own}.${node.rows}[0].${node[field]}`).toBeDefined();
          }
        }
      }
      for (const child of Array.isArray(node) ? node : Object.values(node)) walk(child, own);
    };
    for (const page of emailPageDescriptors) walk(page.body, null);
    // Every list, repeat and search on both pages, and no fewer.
    expect(seen).toEqual([
      'threads.items',
      'threads.threads',
      'thread.messages',
      'message.attachments',
      'thread.drafts',
      'thread.older',
      'accounts.accounts',
      'policies.applied',
      // The rule drawer's two pickers: the mailboxes, and that mailbox's
      // conversations.
      'accounts.accounts',
      'rule_threads.threads',
    ]);
  });

  /**
   * Every `when` is asked of the data the component is actually handed.
   *
   * This is the test that was missing. Three conditions in the Mail detail
   * read the thread query while standing where a `list-detail` hands down the
   * *page's* data — which, with no `data` query on the descriptor, is nothing
   * — so "no messages here", "no draft is waiting" and the whole Older-drafts
   * fold could only ever be false, and the ended drafts were unreachable from
   * the screen. A path that resolves nowhere is now a failure here rather than
   * a section that quietly stopped existing.
   *
   * It walks the real descriptors against real answers, and it carries the
   * engine's own rule about roots: a `detail` and an `expand` hand their query
   * down to their body, a `repeat` hands down one row, a `section` hands down
   * what it was given, and a `list-detail`'s detail is handed the page's.
   */
  it('asks every `when` of data the component is given', async () => {
    const roots: string[] = [];
    const checked: string[] = [];

    const paramOf = async (ref: any, root: unknown): Promise<unknown> => {
      if (ref && typeof ref === 'object' && 'param' in ref) {
        return ref.param === 'thread' ? ids.threadId : undefined;
      }
      if (ref && typeof ref === 'object' && 'const' in ref) return ref.const;
      if (ref && typeof ref === 'object' && 'path' in ref) return readPath(root, ref.path);
      return undefined;
    };

    const answer = async (queryRef: any, root: unknown): Promise<unknown> => {
      const params: Record<string, unknown> = {};
      for (const [key, ref] of Object.entries(queryRef.params ?? {})) {
        const value = await paramOf(ref, root);
        if (value !== undefined && value !== null && value !== '') params[key] = String(value);
      }
      return ask(queryRef.query, params);
    };

    const walk = async (component: any, root: unknown, where: string): Promise<void> => {
      if (component.when) {
        checked.push(`${where}.when(${component.when.path})`);
        expect(
          readPath(root, component.when.path),
          `${where}: \`when\` asks for ${component.when.path}, which is not in the data this component is handed`,
        ).toBeDefined();
      }
      const kind = component.kind;
      if (kind === 'section') {
        for (const [i, child] of (component.body ?? []).entries()) await walk(child, root, `${where}.${i}`);
        return;
      }
      if (kind === 'button') return;
      if (kind === 'list-detail') {
        // The detail is handed the page's data, not the list's row.
        for (const [i, child] of (component.detail ?? []).entries()) {
          await walk(child, root, `${where}.detail.${i}`);
        }
        return;
      }
      if (kind === 'detail' || kind === 'expand') {
        const data = await answer(component.query, root);
        roots.push(`${where} → ${component.query.query}`);
        for (const [i, child] of (component.body ?? []).entries()) await walk(child, data, `${where}.${i}`);
        return;
      }
      if (kind === 'repeat') {
        const data: any = await answer(component.query, root);
        const rows = readPath(data, component.rows) as unknown[];
        expect(Array.isArray(rows), `${where}: ${component.rows} is an array`).toBe(true);
        // A row is what the body is handed; with none, the body is unchecked,
        // so the fixture above makes sure every repeat on the page has one.
        expect(rows.length, `${where}: the seeded fixture has no ${component.rows} to draw`).toBeGreaterThan(0);
        roots.push(`${where} → ${component.query.query}.${component.rows}[]`);
        for (const [i, child] of (component.body ?? []).entries()) await walk(child, rows[0], `${where}.${i}`);
        return;
      }
    };

    for (const page of emailPageDescriptors) {
      // The top of a page is handed its own `data` read, and nothing at all
      // without one — which is exactly why a `when` up there needs one.
      const root = page.data ? await answer(page.data, null) : null;
      for (const [i, component] of page.body.entries()) {
        await walk(component, root, `${page.id}.body.${i}`);
      }
    }
    // The conditions that are left, and where each one stands.
    expect(checked).toEqual([
      // An attachment's Fetch and its link, each asked of its own row: the
      // button gives way to the link the moment there is a file.
      'mail.body.2.0.detail.1.0.1.1.when(artifactId)',
      'mail.body.2.0.detail.1.0.1.2.when(artifactId)',
      // The two draft notices, each asked of the draft the editor is about.
      'mail.body.2.0.detail.2.0.when(unresolved)',
      'mail.body.2.0.detail.2.1.when(notLive)',
      // The offer of @mail, asked of the settings page's own accounts read.
      'settings.body.2.0.when(triage)',
    ]);
    expect(roots).toContain('mail.body.2.0.detail.3 → thread');
  });

  /**
   * The ended drafts are reachable, and the fold asks nothing to be so.
   *
   * This is the shape of the P0: the fold used to carry
   * `when: { path: 'hasOlder', equals: true }` while standing where the page's
   * own data — nothing — is what a `when` is asked of, so it never drew. A
   * discarded draft could not be read anywhere on the screen.
   */
  it('keeps the Older drafts fold reachable, with the ended draft in it', async () => {
    await act('email.discard_draft', { draftId: ids.draftId });

    const mail = emailPageDescriptors.find((page) => page.id === 'mail')!;
    const section: any = mail.body.find((c: any) => c.kind === 'section');
    const split: any = section.body.find((c: any) => c.kind === 'list-detail');
    const fold: any = split.detail.find((c: any) => c.kind === 'expand' && c.label === 'Older drafts');
    expect(fold, 'the Mail detail has an Older drafts fold').toBeDefined();
    expect(fold.when, 'the fold may not ask a question of data it is not handed').toBeUndefined();

    const inside = fold.body[0];
    const answer = await ask(fold.query.query, { id: ids.threadId });
    const older = readPath(answer, inside.rows) as any[];
    expect(older.map((row) => row.status)).toEqual(['discarded']);
    expect(readPath(older[0], inside.item.title.path)).toBe('Re: Invoice 42');
    expect(String(readPath(older[0], inside.item.sub.path))).toContain('Discarded');
  });

  /**
   * A schema that is not there, and a pool that is not answering, are not the
   * same thing — and the difference is the whole of this test.
   *
   * The routes degraded gracefully for the first (the plugin is not installed:
   * no policies, default settings) and refused loudly for the second, because
   * a page that draws `2 / 0.6` after a timeout tells the owner he has read
   * his own settings back when he has not.
   */
  it('degrades when the plugin is not installed, and refuses when the database is not answering', async () => {
    const manifest = createEmailManifest();
    const query = (name: string) => (manifest.queries ?? []).find((q) => q.name === name)!;
    const failing = (code: string): CoreToolContext => hosted({
      ...ctx,
      db: {
        query: async () => {
          const error = new Error(`relation "email.settings" does not exist`) as Error & { code: string };
          error.code = code;
          throw error;
        },
      } as never,
    });

    expect(await query('policies').produce({}, failing('42P01'))).toEqual({
      applied: [],
      appliedCount: 0,
      proposedCount: 0,
      savedRuns: 0,
      unavailable: true,
    });
    expect(await query('watcher_settings').produce({}, failing('42P01'))).toMatchObject({
      waitingDays: 2,
      dateConfidence: 0.6,
    });

    // 57014 is `query_canceled` — the statement timeout the page's own pool
    // sets. Anything that is not "the table is missing" is a failure to say.
    await expect(query('policies').produce({}, failing('57014'))).rejects.toThrow(/does not exist/);
    await expect(query('watcher_settings').produce({}, failing('57014'))).rejects.toThrow(/does not exist/);
  });

  /**
   * The search above the list, and the two ways it can be empty.
   *
   * "From acme.com, since March" with no words in the box is a search the old
   * form allowed and the builder still honours; pressing Search with nothing
   * at all is a question the owner can fix, and is answered rather than
   * silently drawing nothing.
   */
  it('searches on filters alone, and refuses a search with nothing in it', async () => {
    const byFilter = await ask('threads', { searching: 'true', from: 'client.test' });
    expect(byFilter.count).toBe(1);
    expect(byFilter.items[0]).toMatchObject({ threadId: ids.threadId });

    await expect(ask('threads', { searching: 'true' })).rejects.toThrow(
      'Type something to search for, or set one of the filters.',
    );
    /*
     * And with no mailbox at all: an installation on its first morning is the
     * likeliest place to press Search with an empty box, and the refusal must
     * not be swallowed by "there is nothing here anyway".
     */
    await pool.query('truncate email.accounts cascade');
    await expect(ask('threads', { searching: 'true' })).rejects.toThrow(
      'Type something to search for, or set one of the filters.',
    );
    expect(await ask('threads')).toMatchObject({ threads: [], items: [], count: 0 });
    // The list above it asks the same query with no parameters, and must not
    // be refused for a search nobody made.
    expect((await ask('threads')).items).toEqual([]);
  });

  /**
   * A draft that ended and a draft nobody can account for are different
   * states, and the page says a different thing about each.
   */
  it('tells an ended draft from one a dispatch is holding', async () => {
    const ended = await act('email.discard_draft', { draftId: ids.draftId });
    expect(ended).toMatchObject({ discarded: true });
    const discarded = await ask('draft', { id: ids.draftId });
    expect(discarded).toMatchObject({ live: false, unresolved: false, notLive: true });
    expect(discarded.notLiveLine).toBe(
      'This draft is discarded and cannot be edited or sent. It is kept so you can read what was proposed.',
    );

    await pool.query(
      `update email.drafts set status = 'draft', discarded_at = null, sent_action_id = $2, send_error = $3 where id = $1::uuid`,
      [ids.draftId, '77777777-7777-4777-8777-777777777777', 'connection reset by peer'],
    );
    const held = await ask('draft', { id: ids.draftId });
    // Not live, and *not* "no longer editable": nobody knows what happened.
    expect(held).toMatchObject({ live: false, unresolved: true, notLive: false });
    expect(held.unresolvedLine).toContain('genuinely unknown');
    expect(held.unresolvedLine).toContain('The server said: connection reset by peer');
  });

  /**
   * The rule form's two pickers (docs/specs/email.md §5).
   *
   * A conversation is **picked, never typed**: the database names a thread by
   * the root Message-ID of its chain, which is not something an owner has. So
   * the form offers subjects, scoped to the mailbox it was already told about,
   * and sends the id the gate matches.
   */
  it('offers the mailboxes, and one mailbox\'s conversations, as things to pick', async () => {
    const accounts = await ask('accounts');
    const mailbox = accounts.accounts[0];
    expect(mailbox.label).toBe(OWNER);

    const all = await ask('rule_threads');
    expect(all.threads).toHaveLength(1);
    expect(all.threads[0]).toMatchObject({ id: ids.threadId, accountId: mailbox.id });
    // The mailbox is named on the label even when the list is one mailbox's:
    // a label should say what it is on its own.
    expect(all.threads[0].label).toContain(`[${OWNER}] Invoice 42 — `);

    expect((await ask('rule_threads', { mailbox: mailbox.id })).threads).toHaveLength(1);
    expect(
      (await ask('rule_threads', { mailbox: '99999999-9999-4999-8999-999999999999' })).threads,
    ).toEqual([]);
  });

  /**
   * A refusal the owner can act on is answered as one.
   *
   * `QueryRefusal` is the difference between "the email plugin could not
   * answer threads" — which is what every one of these used to become — and
   * the sentence that says what to do about it.
   */
  it('refuses a read in words the owner can act on', async () => {
    for (const [name, params, sentence] of [
      ['thread', { id: '99999999-9999-4999-8999-999999999999' }, 'No conversation here has that id.'],
      ['draft', { id: '99999999-9999-4999-8999-999999999999' }, 'No draft here has that id.'],
      ['message', { id: '99999999-9999-4999-8999-999999999999' }, 'No message here has that id.'],
      ['threads', { searching: 'true' }, 'Type something to search for, or set one of the filters.'],
      ['threads', { searching: 'true', q: 'invoice', since: 'March' }, '`since`'],
    ] as const) {
      const refused = await ask(name, params as Record<string, unknown>).catch((error: unknown) => error);
      expect(refused, `${name} refuses`).toBeInstanceOf(QueryRefusal);
      expect((refused as Error).message).toContain(sentence);
    }
  });

  /* -------------------------------------------------------------- *
   * The writes
   * -------------------------------------------------------------- */

  it('adds a mailbox with the hosts worked out from its address, and refuses a second one', async () => {
    const added = await act('email.add_account', { address: ADDED, password: 'letmein' });
    expect(added).toMatchObject({ added: true, address: ADDED });
    const accounts = await listAccounts(pool, { enabledOnly: false });
    const account = accounts.find((a) => a.address === ADDED)!;
    expect(account).toMatchObject({ imapHost: 'imap.work.test', imapPort: 993, smtpHost: 'smtp.work.test' });
    // The password is an owner secret named as the row names it, bound to
    // this mailbox's login and kept in the vault under its id; the row
    // carries a name rather than a secret, and nothing is under the old name.
    expect(account.secretName).toBe(secretNameFor(ADDED));
    const secret = (await findSecret(pool, account.secretName))!;
    expect(await vault.get(ownerSecretVaultName(secret.id))).toBe('letmein');
    expect(await vault.get(account.secretName)).toBeNull();
    const { rows: bindings } = await pool.query(
      `select kind, target, rule from core.secret_bindings where secret_id = $1`,
      [secret.id],
    );
    expect(bindings).toEqual([{ kind: 'email.account', target: account.id, rule: 'pre-approved' }]);

    expect(await refusal('email.add_account', { address: ADDED, password: 'again' })).toMatch(
      /is already here\. Remove it first/,
    );

    await act('email.remove_account', { id: account.id });
    expect((await listAccounts(pool, { enabledOnly: false })).some((a) => a.address === ADDED)).toBe(false);
    expect(await findSecret(pool, account.secretName)).toBeNull();
    expect(await vault.get(ownerSecretVaultName(secret.id))).toBeNull();
  });

  /*
   * The poll hands every new message to `mail-triage`, which the plugin
   * proposes and nobody has until the owner accepts it. A mailbox saved
   * before then is mail with nobody to read it, so the save says so and the
   * settings page's data carries what its offer line is drawn against.
   */
  it('says on save that background triage needs a mail agent, while there is none', async () => {
    configurePluginHost({ hasAgent: (id) => id !== 'mail-triage' });
    try {
      const added = await act('email.add_account', { address: ADDED, password: 'letmein' });
      expect(added).toMatchObject({ added: true, triage: 'needs-agent' });
      expect(added.note).toContain('Background triage needs a mail agent.');
      expect(added.note).toContain('Create @mail');
      expect((await ask('accounts')).triage).toBe('needs-agent');
      expect(await ask('triage_offer')).toEqual({ wanted: true });

      configurePluginHost({ hasAgent: () => true });
      expect((await ask('accounts')).triage).toBe('ready');
      const account = (await listAccounts(pool, { enabledOnly: false })).find((a) => a.address === ADDED)!;
      await act('email.remove_account', { id: account.id });
    } finally {
      configurePluginHost({ hasAgent: () => true });
    }
    // With the agent there, the save says nothing about it.
    const again = await act('email.add_account', { address: ADDED, password: 'letmein' });
    expect(again.triage).toBeUndefined();
    expect(again.note).not.toContain('triage');
    const account = (await listAccounts(pool, { enabledOnly: false })).find((a) => a.address === ADDED)!;
    await act('email.remove_account', { id: account.id });
  });

  it('does not exist for an agent: an ownerOnly tool is unknown, not forbidden', async () => {
    expect(await refusal('email.add_account', { address: ADDED, password: 'x' }, 'mail-triage')).toBe(
      'unknown tool: email.add_account',
    );
    expect(registry.list().some((t) => t.name.startsWith('email.add_account'))).toBe(false);
    expect(registry.list().some((t) => t.name === 'email.save_draft')).toBe(false);
  });

  it('writes a rule the owner typed, and refuses one that names no mailbox', async () => {
    expect(await refusal('email.add_rule', { scope: 'sender', matcher: 'news@shop.test', action: 'ignore' })).toMatch(
      /Say which mailbox this rule is for/,
    );
    expect(
      await refusal('email.add_rule', {
        scope: 'sender',
        matcher: 'news@shop.test',
        action: 'ignore',
        mailbox: 'nobody@nowhere.test',
      }),
    ).toBe('That mailbox is not one of yours.');
    expect(
      await refusal('email.add_rule', {
        scope: 'sender',
        matcher: 'news@shop.test',
        action: 'ignore',
        mailbox: OWNER,
        allAccounts: true,
      }),
    ).toBe('Choose one mailbox, or "for every mailbox" — not both.');

    await act('email.add_rule', { scope: 'sender', matcher: 'news@shop.test', action: 'ignore', mailbox: OWNER });
    const policies = await ask('policies');
    expect(policies.appliedCount).toBe(1);
    expect(policies.applied[0]).toMatchObject({ matcher: 'news@shop.test', action: 'ignore' });
    expect(policies.applied[0].sub).toContain('you decided it');
    // The row's own button sends this, so it is a list of one.
    expect(policies.applied[0].ids).toEqual([policies.applied[0].id]);
  });

  it('writes a rule about the conversation that was picked, and never about every mailbox', async () => {
    const mailbox = (await ask('accounts')).accounts[0];
    // The form sends ids, because that is what the pickers carry.
    const added = await act('email.add_rule', {
      scope: 'thread',
      thread: ids.threadId,
      action: 'ignore',
      sender: 'Dorothée <TDOROTHEE@client.test>',
      mailbox: mailbox.id,
    });
    expect(added).toMatchObject({ added: true });
    expect(added.note).toContain('ignore thread');
    const { rows } = await pool.query(`select account_id, matcher, params from email.policies`);
    expect(String(rows[0].account_id)).toBe(mailbox.id);
    expect(rows[0].matcher).toBe(ids.threadId);
    expect(rows[0].params.sender).toBe('tdorothee@client.test');

    // A conversation lives in one mailbox, so this pair cannot both be true.
    expect(
      await refusal('email.add_rule', {
        scope: 'thread',
        thread: ids.threadId,
        action: 'ignore',
        allAccounts: true,
      }),
    ).toBe('A conversation lives in one mailbox, so a rule about one is never "every mailbox".');
    expect(
      await refusal('email.add_rule', { scope: 'thread', action: 'ignore', mailbox: mailbox.id }),
    ).toBe('Choose the conversation this rule is about.');
  });

  it('counts the rules waiting in Proposals, and revokes a selection of kept ones in one act', async () => {
    await pool.query(`delete from core.proposals`);
    await pool.query(
      `insert into core.proposals (kind, agent, payload, fingerprint)
       values ('policy', 'email', '{"plugin":"email","matcher":{"sender":"x@y.test"},"action":"ignore"}'::jsonb, 'fp-email'),
              ('policy', 'other', '{"plugin":"elsewhere","matcher":{},"action":"x"}'::jsonb, 'fp-other'),
              ('skill', 'ada', '{"name":"n"}'::jsonb, 'fp-skill')`,
    );
    // Only this plugin's open rules; the page links to them rather than copying them.
    expect((await ask('policies')).proposedCount).toBe(1);
    await pool.query(`delete from core.proposals`);

    await pool.query(
      `insert into email.policies (account_id, scope, matcher, action, params, origin, proposed)
       select id, 'sender', 'ads@shop.test', 'ignore', '{}'::jsonb, 'learned', false from email.accounts limit 1`,
    );
    await pool.query(
      `insert into email.policies (account_id, scope, matcher, action, params, origin, proposed)
       select id, 'domain', 'shop.test', 'ignore', '{}'::jsonb, 'learned', false from email.accounts limit 1`,
    );
    expect((await ask('policies')).appliedCount).toBe(2);

    const one = (await ask('policies')).applied[0];
    const revoked = await act('email.revoke_policies', { ids: one.ids });
    expect(revoked).toMatchObject({ revoked: 1, missing: 0, note: '1 rule revoked.' });
    expect((await ask('policies')).appliedCount).toBe(1);

    /*
     * A selection that touched nothing is the race the owner lost, not a
     * success: the rules went while the list was on screen. (A *revoked* rule
     * is still a row, and revoking it again is the no-op the store intends —
     * what is gone here is the row itself.)
     */
    const gone = '88888888-8888-4888-8888-888888888888';
    expect(await refusal('email.revoke_policies', { ids: [gone] })).toBe('That policy is no longer there.');
    // Half of it landing is said out loud too.
    const left = (await ask('policies')).applied[0];
    const partly = await act('email.revoke_policies', { ids: [...left.ids, gone] });
    expect(partly).toMatchObject({ note: '1 rule revoked; 1 was no longer there.' });
  });

  it('saves a draft against the version the editor loaded, and refuses a stale one', async () => {
    const loaded = await ask('draft', { id: ids.draftId });
    expect(await refusal('email.save_draft', {
      draftId: ids.draftId,
      to: loaded.toText,
      subject: 'Invoice 42',
      bodyText: '   ',
      version: loaded.updatedAt,
    })).toBe('A draft needs a body. Discard it instead of emptying it.');

    // A save a minute later, so the stored version moves and the editor that
    // loaded the old one is genuinely stale.
    clock = new Date('2026-09-21T12:01:00Z');
    const saved = await act('email.save_draft', {
      draftId: ids.draftId,
      to: loaded.toText,
      cc: '',
      bcc: '',
      subject: 'Re: Invoice 42',
      bodyText: 'Here it is, with my own words.',
      version: loaded.updatedAt,
    });
    expect(saved).toMatchObject({ saved: true });
    const after = await ask('draft', { id: ids.draftId });
    expect(after).toMatchObject({ status: 'edited', bodyText: 'Here it is, with my own words.' });
    expect(after.statusLine).toContain('Edited by you');

    // The version has moved, so the editor that loaded the old one saves
    // nothing rather than putting its stale text back.
    expect(await refusal('email.save_draft', {
      draftId: ids.draftId,
      to: loaded.toText,
      subject: 'Re: Invoice 42',
      bodyText: 'The words that lost the race.',
      version: loaded.updatedAt,
    })).toMatch(/changed while you had it open/);
  });
});
