/**
 * Accounts are plural, over a throwaway database.
 *
 * Two mailboxes, each with its own mail, its own alias and its own secret, and
 * the four questions that only have an answer once there is more than one:
 *
 *  - does a read see both, and does every row say which one it came from;
 *  - does naming one narrow the answer to it;
 *  - does a reply leave from the mailbox it answers, under the alias the
 *    original was addressed to;
 *  - and does the single env-seeded account still work exactly as it did.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPool, runMigrations, ToolRegistry } from '@buddi/core';
import { ensureGmailAccount, GMAIL_SECRET_NAME, listAccounts, secretNameFor } from '../config.js';
import { FakeImapServer, fakeMessage } from '../imap/fake.js';
import { createEmailManifest } from '../index.js';
import { FakeSmtpServer } from '../smtp/fake.js';
import { createInboxPollSource } from '../sources/inbox-poll.js';
import { draftReply } from './drafts.js';
import type { z } from 'zod';
import type { ImapClientFactory } from '../ports.js';
import type { GatedToolDefinition, ToolContext } from '../types.js';
import type { SendEnvelope, SendInput, SendResult } from './send.js';
import { testDatabaseUrl } from '@buddi/core/testing';
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

const TEST_DB = `buddi_email_accounts_test_${process.pid}`;

const PERSONAL = 'owner@example.test';
const WORK = 'owner@work.test';
const WORK_ALIAS = 'invoices@work.test';
const WORK_SECRET = secretNameFor(WORK);

/** Both secrets, by the name each account's row carries. */
const ENV = {
  GMAIL_USER: PERSONAL,
  [GMAIL_SECRET_NAME]: 'personal-app-password',
  [WORK_SECRET]: 'work-app-password',
};

suite('email accounts, plural (postgres)', () => {
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

    dataDir = await mkdtemp(path.join(tmpdir(), 'buddi-email-accounts-'));
    process.env.BUDDI_DATA_DIR = dataDir;

    smtp = new FakeSmtpServer();
    const manifest = createEmailManifest({ send: smtp.factory(), env: ENV });
    await runMigrations(pool, [manifest]);

    registry = new ToolRegistry();
    registry.register(manifest);
    sendTool = manifest.tools.find((t) => t.name === 'email.send') as typeof sendTool;

    ctx = hosted({
      db: pool,
      ownerId: 'test',
      now: () => new Date('2026-09-21T12:00:00Z'),
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
   * One IMAP server per mailbox, dispatched on the account the source hands
   * the factory. Two accounts polled in one pass is the thing under test; two
   * accounts served the same fixture would prove nothing.
   */
  function twoServers(): { connect: ImapClientFactory; personal: FakeImapServer; work: FakeImapServer } {
    const personal = new FakeImapServer();
    const work = new FakeImapServer();
    personal.add(
      'INBOX',
      fakeMessage({
        messageId: '<bank-1@bank.test>',
        from: 'Alerts <alerts@bank.test>',
        to: [PERSONAL],
        subject: 'Direct debit returned',
        bodyText: 'Your direct debit was returned unpaid.',
        date: new Date('2026-09-20T08:00:00Z'),
      }),
    );
    work.add(
      'INBOX',
      fakeMessage({
        messageId: '<client-1@client.test>',
        from: 'Dorothée <tdorothee@client.test>',
        // Addressed to the alias, not to the account's own address: this is
        // what a reply's From has to come back as.
        to: [WORK_ALIAS],
        subject: 'Invoice 42',
        bodyText: 'Could you resend invoice 42?',
        date: new Date('2026-09-21T08:00:00Z'),
      }),
    );
    return {
      personal,
      work,
      connect: (async (account) =>
        (account.address === WORK ? work : personal).client()) as ImapClientFactory,
    };
  }

  /** Both accounts, both mailboxes polled in one pass. */
  async function seed(): Promise<{ personalId: string; workId: string }> {
    await pool.query('truncate email.drafts, email.triage, email.messages, email.folders, email.accounts cascade');
    await ensureGmailAccount(pool, ENV);
    await pool.query(
      `insert into email.accounts
         (address, imap_host, imap_port, smtp_host, smtp_port, auth_mode, secret_name,
          aliases, display_name, enabled, added_via)
       values ($1, 'imap.work.test', 993, 'smtp.work.test', 465, 'app-password', $2,
               $3::text[], 'Work', true, 'page')`,
      [WORK, WORK_SECRET, [WORK_ALIAS]],
    );

    const { connect } = twoServers();
    const source = createInboxPollSource({ connect, env: ENV, backfill: 1_000 });
    await source.poll(hosted({
      db: pool,
      now: ctx.now,
      timezone: 'UTC',
      log: () => {},
      enqueueRun: async () => {},
    }));

    const { rows } = await pool.query(
      `select m.id, a.address from email.messages m join email.accounts a on a.id = m.account_id`,
    );
    const personalId = rows.find((r: any) => r.address === PERSONAL)?.id as string;
    const workId = rows.find((r: any) => r.address === WORK)?.id as string;
    return { personalId: String(personalId), workId: String(workId) };
  }

  let ids: { personalId: string; workId: string };
  beforeEach(async () => {
    ids = await seed();
  });

  it('polls every enabled account in one pass, each into its own mailbox row', async () => {
    const { rows } = await pool.query(
      `select a.address, count(m.id)::int as n
         from email.accounts a left join email.messages m on m.account_id = a.id
        group by a.address order by a.address`,
    );
    expect(rows).toEqual([
      { address: PERSONAL, n: 1 },
      { address: WORK, n: 1 },
    ]);
    const { rows: boxes } = await pool.query(`select count(*)::int as n from email.folders`);
    expect(boxes[0].n).toBe(2);
  });

  it('lists across both accounts, and every row says which one it came from', async () => {
    const listed = await call('email.list_recent', {});
    expect(listed.accounts).toEqual([PERSONAL, WORK]);
    // Across several mailboxes there is no single account this answer is about.
    expect(listed.account).toBeNull();
    expect(listed.messages.map((m: any) => [m.subject, m.account])).toEqual([
      ['Invoice 42', WORK],
      ['Direct debit returned', PERSONAL],
    ]);
  });

  it('narrows to one account when it is named, by address or by id', async () => {
    const byAddress = await call('email.list_recent', { account: WORK });
    expect(byAddress.account).toBe(WORK);
    expect(byAddress.messages.map((m: any) => m.subject)).toEqual(['Invoice 42']);

    const accounts = await listAccounts(pool);
    const work = accounts.find((a) => a.address === WORK)!;
    const byId = await call('email.list_recent', { account: work.id });
    expect(byId.messages.map((m: any) => m.subject)).toEqual(['Invoice 42']);

    // An alias names the account that receives as it.
    const byAlias = await call('email.list_recent', { account: WORK_ALIAS });
    expect(byAlias.account).toBe(WORK);

    await expect(call('email.list_recent', { account: 'nobody@nowhere.test' })).rejects.toThrow(
      /no mail account here is nobody@nowhere\.test/,
    );
  });

  it('searches and profiles across both accounts, and narrows the same way', async () => {
    expect((await call('email.search', { query: 'invoice' })).count).toBe(1);
    expect((await call('email.search', { query: 'invoice', account: PERSONAL })).count).toBe(0);
    expect((await call('email.search', { query: 'invoice', account: WORK })).messages[0].account).toBe(WORK);

    const profile = await call('email.sender_profile', { address: 'tdorothee@client.test' });
    expect(profile).toMatchObject({ received: 1, writesTo: [WORK] });
    expect((await call('email.sender_profile', { address: 'tdorothee@client.test', account: PERSONAL })).received).toBe(0);
  });

  it('reads a message with its account, and refuses to read one from another mailbox', async () => {
    const read = await call('email.read', { id: ids.workId });
    expect(read.account).toBe(WORK);
    await expect(call('email.read', { id: ids.workId, account: PERSONAL })).rejects.toThrow(
      /did not arrive in owner@example\.test/,
    );
  });

  it('takes the account from the message a reply answers, and never from an argument', async () => {
    const draft = await call('email.draft_reply', { inReplyTo: ids.workId, bodyText: 'Here it is.' });
    expect(draft.account).toBe(WORK);
    // The account's own address, even though the original names the alias in
    // its To line. `To` and `Cc` are written by whoever sent the message:
    // delivery happens through Bcc, forwarding and catch-alls, so an alias
    // appearing there says who typed it, not who it reached. The owner picks
    // an alias on the approval card, where the envelope lists them.
    expect(draft.from).toBe(WORK);
    const { rows } = await pool.query(
      `select a.address from email.drafts d join email.accounts a on a.id = d.account_id where d.id = $1`,
      [draft.id],
    );
    expect(rows[0].address).toBe(WORK);
    // There is no way to ask for another mailbox: the schema has no such key.
    expect(Object.keys((draftReply.input as unknown as z.ZodObject<z.ZodRawShape>).shape)).not.toContain('account');
  });

  it('sends from the account the draft carries, and offers its aliases as the owner’s choice', async () => {
    const draft = await call('email.draft_reply', { inReplyTo: ids.workId, bodyText: 'Here it is.' });
    const approvedEffect = await sendTool.describe({ draftId: draft.id }, ctx);
    // The default identity is the account's address, and the alternatives are
    // in the envelope the approval is bound to — so the card can offer them
    // and the owner reads what will actually be on the wire.
    expect(approvedEffect.envelope).toMatchObject({ accountAddress: WORK, from: WORK });
    expect(approvedEffect.envelope.fromChoices).toEqual([WORK, WORK_ALIAS]);
    expect(approvedEffect.preview).toContain(`Send mail as ${WORK}`);
    // The alternatives are a *control* now, not a line of preview prose: the
    // card draws a select from this, and the preview stays the effect.
    expect(approvedEffect.preview).not.toContain('if you choose it here');
    expect(approvedEffect.choices).toEqual([
      { key: 'from', label: 'Send as', options: [WORK, WORK_ALIAS], default: WORK },
    ]);

    const before = smtp.sent.length;
    await sendTool.execute(
      { draftId: draft.id },
      { ...ctx, actionId: '77777777-7777-4777-8777-777777777777', approvedEffect },
    );
    expect(smtp.sent).toHaveLength(before + 1);
    expect(smtp.sent[before]).toMatchObject({ from: WORK, to: ['tdorothee@client.test'] });
  });

  it('sends under the alias the owner chose, still authenticating as the account', async () => {
    const draft = await call('email.draft_reply', { inReplyTo: ids.workId, bodyText: 'Here it is.' });
    const approvedEffect = await sendTool.describe({ draftId: draft.id }, ctx);
    const before = smtp.sent.length;
    await sendTool.execute(
      { draftId: draft.id },
      {
        ...ctx,
        actionId: '88888888-8888-4888-8888-888888888888',
        approvedEffect,
        // What core hands a gated execute after validating the owner's pick
        // against the very list the envelope declared.
        choices: { from: WORK_ALIAS },
      },
    );
    expect(smtp.sent).toHaveLength(before + 1);
    // The alias is the identity on the wire; the account is still what opened
    // the connection, which is `FakeSmtpServer`'s `account` on the dispatch.
    expect(smtp.sent[before]).toMatchObject({ from: WORK_ALIAS });
    expect(smtp.logins[smtp.logins.length - 1]).toBe(WORK);
  });

  it('refuses an identity the approval never offered', async () => {
    const draft = await call('email.draft_reply', { inReplyTo: ids.workId, bodyText: 'Here it is.' });
    const approvedEffect = await sendTool.describe({ draftId: draft.id }, ctx);
    await expect(
      sendTool.execute(
        { draftId: draft.id },
        {
          ...ctx,
          actionId: '99999999-9999-4999-8999-999999999999',
          approvedEffect,
          choices: { from: 'someone@elsewhere.test' },
        },
      ),
    ).rejects.toThrow(/not one of the identities this approval offered/);
  });

  it('replies from the personal account under its own address, with nothing else to choose', async () => {
    const draft = await call('email.draft_reply', { inReplyTo: ids.personalId, bodyText: 'Noted.' });
    expect(draft).toMatchObject({ account: PERSONAL, from: PERSONAL });
    const { envelope, preview } = await sendTool.describe({ draftId: draft.id }, ctx);
    expect(envelope.from).toBe(PERSONAL);
    expect(envelope.fromChoices).toEqual([PERSONAL]);
    expect(preview).toContain(`Send mail as ${PERSONAL}`);
    expect(preview).not.toContain('mailbox)');
    expect(preview).not.toContain('if you choose it here');
  });

  it('makes a new message name its mailbox, because it has no thread to take one from', async () => {
    await expect(
      call('email.draft_new', { to: 'someone@example.test', subject: 'Hello', bodyText: 'Body.' }),
    ).rejects.toThrow(/say which one with `account`/);

    const draft = await call('email.draft_new', {
      account: WORK,
      to: 'someone@example.test',
      subject: 'Hello',
      bodyText: 'Body.',
    });
    // Nothing was addressed to an alias, so the account speaks as itself.
    expect(draft).toMatchObject({ account: WORK, from: WORK });
  });

  it('leaves a disabled account out of every read, and keeps its mail', async () => {
    await pool.query(`update email.accounts set enabled = false where address = $1`, [WORK]);
    const listed = await call('email.list_recent', {});
    expect(listed.accounts).toEqual([PERSONAL]);
    expect(listed.messages.map((m: any) => m.subject)).toEqual(['Direct debit returned']);
    const { rows } = await pool.query(`select count(*)::int as n from email.messages`);
    expect(rows[0].n).toBe(2);
  });

  describe('the env-seeded account, alone, exactly as before', () => {
    beforeEach(async () => {
      await pool.query('truncate email.drafts, email.triage, email.messages, email.folders, email.accounts cascade');
    });

    it('seeds one account from GMAIL_USER, with no aliases and no page provenance', async () => {
      const seeded = await ensureGmailAccount(pool, ENV);
      expect(seeded).toMatchObject({
        address: PERSONAL,
        secretName: GMAIL_SECRET_NAME,
        addedVia: 'env',
        enabled: true,
        aliases: [],
        displayName: null,
      });
      // Re-running it is how the owner moves the account, and it stays one row.
      await ensureGmailAccount(pool, ENV);
      expect(await listAccounts(pool)).toHaveLength(1);
    });

    it('seeds nothing when GMAIL_USER is not set', async () => {
      expect(await ensureGmailAccount(pool, { [GMAIL_SECRET_NAME]: 'x' })).toBeNull();
      expect(await listAccounts(pool)).toHaveLength(0);
    });

    it('needs no `account` argument anywhere while there is only one', async () => {
      await ensureGmailAccount(pool, ENV);
      const server = new FakeImapServer();
      server.add(
        'INBOX',
        fakeMessage({
          messageId: '<one@bank.test>',
          from: 'alerts@bank.test',
          to: [PERSONAL],
          subject: 'Only mailbox',
          bodyText: 'Hello.',
          date: new Date('2026-09-20T08:00:00Z'),
        }),
      );
      await createInboxPollSource({ connect: server.factory(), env: ENV, backfill: 1_000 }).poll(hosted({
        db: pool,
        now: ctx.now,
        timezone: 'UTC',
        log: () => {},
        enqueueRun: async () => {},
      }));

      const listed = await call('email.list_recent', {});
      expect(listed.account).toBe(PERSONAL);
      expect(listed.messages[0].account).toBe(PERSONAL);
      const draft = await call('email.draft_new', {
        to: 'someone@example.test',
        subject: 'Hello',
        bodyText: 'Body.',
      });
      expect(draft).toMatchObject({ account: PERSONAL, from: PERSONAL });
    });

    it('refuses to open the page-added account when its secret is not there', async () => {
      await ensureGmailAccount(pool, ENV);
      await pool.query(
        `insert into email.accounts
           (address, imap_host, imap_port, smtp_host, smtp_port, auth_mode, secret_name, added_via)
         values ($1, 'imap.work.test', 993, 'smtp.work.test', 465, 'app-password', $2, 'page')`,
        [WORK, WORK_SECRET],
      );
      const lines: string[] = [];
      const server = new FakeImapServer();
      // The personal account still polls; the other one says why it cannot.
      await createInboxPollSource({
        connect: server.factory(),
        env: { GMAIL_USER: PERSONAL, [GMAIL_SECRET_NAME]: 'personal-app-password' },
      }).poll(hosted({
        db: pool,
        now: ctx.now,
        timezone: 'UTC',
        log: (line) => lines.push(line),
        enqueueRun: async () => {},
      }));
      expect(lines.join('\n')).toContain(`no secret named ${WORK_SECRET}`);
      const { rows } = await pool.query(
        `select a.address from email.folders m join email.accounts a on a.id = m.account_id`,
      );
      expect(rows.map((r: any) => r.address)).toEqual([PERSONAL]);
    });

    it('will not let two accounts share one vault entry', async () => {
      // The schema, not the caller, is what makes this impossible: a shared
      // name means adding the second mailbox overwrites the first's password
      // and removing either deletes the other's.
      await pool.query(
        `insert into email.accounts
           (address, imap_host, imap_port, smtp_host, smtp_port, auth_mode, secret_name, added_via)
         values ('a-b@example.test', 'imap.example.test', 993, 'smtp.example.test', 465,
                 'app-password', $1, 'page')`,
        [secretNameFor('a-b@example.test')],
      );
      await expect(
        pool.query(
          `insert into email.accounts
             (address, imap_host, imap_port, smtp_host, smtp_port, auth_mode, secret_name, added_via)
           values ('a.b@example.test', 'imap.example.test', 993, 'smtp.example.test', 465,
                   'app-password', $1, 'page')`,
          [secretNameFor('a-b@example.test')],
        ),
      ).rejects.toThrow(/accounts_secret_name_idx|duplicate key/);

      // And the names the two addresses actually derive are different, so the
      // constraint is never in the owner's way.
      expect(secretNameFor('a.b@example.test')).not.toBe(secretNameFor('a-b@example.test'));
    });
  });
});
