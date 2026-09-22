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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, createVault, pageQueryContext, runMigrations, ToolRegistry, type Vault } from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import { ensureGmailAccount, GMAIL_SECRET_NAME, listAccounts, secretNameFor } from '../config.js';
import { FakeImapServer, fakeMessage } from '../imap/fake.js';
import { createEmailManifest } from '../index.js';
import { createInboxPollSource } from '../sources/inbox-poll.js';
import type { ImapClientFactory } from '../ports.js';
import type { ToolContext } from '../types.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_email_pages_test_${process.pid}`;

const OWNER = 'owner@example.test';
const ADDED = 'owner@work.test';

suite('the mail pages, over postgres', () => {
  let admin: Pool;
  let pool: Pool;
  let dataDir: string;
  let registry: ToolRegistry;
  let ctx: ToolContext;
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

    const manifest = createEmailManifest({ connect, env, vault });
    await runMigrations(pool, [manifest]);
    registry = new ToolRegistry();
    registry.register(manifest);

    ctx = {
      db: pool,
      ownerId: 'test',
      now: () => clock,
      timezone: 'UTC',
      agentId: 'owner',
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
    await source.poll({ db: pool, now: ctx.now, timezone: 'UTC', log: () => {}, enqueueRun: async () => {} });

    const { rows } = await pool.query(`select id, thread_id from email.messages`);
    const messageId = String(rows[0]!.id);
    const threadId = String(rows[0]!.thread_id);
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
    expect(listed.threads[0]).toMatchObject({ subject: 'Invoice 42', pill: 'draft' });
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
    expect(message).toMatchObject({ purged: false, attachments: [] });
    expect(message.bodyText).toContain('resend invoice 42');

    const draft = await ask('draft', { id: ids.draftId });
    expect(draft).toMatchObject({ id: ids.draftId, live: true, bodyText: 'It is attached.' });
    expect(draft.toText).toContain('tdorothee@client.test');

    const accounts = await ask('accounts');
    expect(accounts.accounts[0]).toMatchObject({ address: OWNER, state: 'on · from .env' });
    expect(accounts.accounts[0].secretName).toBe(GMAIL_SECRET_NAME);

    expect(await ask('watcher_settings')).toMatchObject({ waitingDays: 2, dateConfidence: 0.6 });
    await act('email.set_settings', { waitingDays: 5 });
    expect(await ask('watcher_settings')).toMatchObject({ waitingDays: 5 });
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
    // The password is in the vault under the name the row carries, and the row
    // carries a name rather than a secret.
    expect(account.secretName).toBe(secretNameFor(ADDED));
    expect(await vault.get(account.secretName)).toBe('letmein');

    expect(await refusal('email.add_account', { address: ADDED, password: 'again' })).toMatch(
      /is already here\. Remove it first/,
    );

    await act('email.remove_account', { id: account.id });
    expect((await listAccounts(pool, { enabledOnly: false })).some((a) => a.address === ADDED)).toBe(false);
    expect(await vault.get(account.secretName)).toBeNull();
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

  it('keeps and revokes a selection in one act, by the ids the page is showing', async () => {
    await pool.query(
      `insert into email.policies (account_id, scope, matcher, action, params, origin, proposed)
       select id, 'sender', 'ads@shop.test', 'ignore', '{}'::jsonb, 'learned', true from email.accounts limit 1`,
    );
    await pool.query(
      `insert into email.policies (account_id, scope, matcher, action, params, origin, proposed)
       select id, 'domain', 'shop.test', 'ignore', '{}'::jsonb, 'learned', true from email.accounts limit 1`,
    );
    const proposed = await ask('policies');
    expect(proposed.proposedCount).toBe(2);

    const kept = await act('email.keep_policies', { ids: proposed.proposed.map((p: any) => p.id) });
    expect(kept).toMatchObject({ kept: 2, revoked: 0 });
    expect((await ask('policies')).appliedCount).toBe(2);

    const one = (await ask('policies')).applied[0];
    await act('email.revoke_policies', { ids: one.ids });
    expect((await ask('policies')).appliedCount).toBe(1);
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
