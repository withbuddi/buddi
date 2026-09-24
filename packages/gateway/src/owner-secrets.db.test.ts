/**
 * The email plugin's mailbox passwords, moved into owner secrets at start
 * (docs/specs/owner-secrets.md §7, acceptance 5): adopted from a throwaway
 * vault and from the day-1 `.env` copy, idempotently; the old entries gone
 * only after the new ones read back; the copies cleared from the environment
 * with the tuning knobs left alone; and both mailboxes then polled with no
 * password anywhere in the environment. The database is created here and
 * dropped.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  configurePluginHost,
  createMemoryVault,
  createPluginHost,
  createPool,
  findSecret,
  hostBindingOf,
  ownerSecretVaultName,
  resetPluginHost,
  resetSecretDestinations,
  runMigrations,
  ToolRegistry,
  type SourceContext,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import {
  createEmailManifest,
  createInboxPollSource,
  ensureGmailAccount,
  FakeImapServer,
  fakeMessage,
  GMAIL_SECRET_NAME,
  listAccounts,
  secretNameFor,
} from '@buddi/tool-email';
import { adoptMailboxSecrets, clearFromEnvironment, mailboxSecretNames } from './owner-secrets.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_owner_secrets_${process.pid}`;
const PERSONAL = 'owner@example.test';
const WORK = 'owner@work.test';
const WORK_SECRET = secretNameFor(WORK);

suite('mailbox passwords as owner secrets (postgres)', () => {
  let admin: Pool;
  let pool: Pool;
  let dataDir: string;

  beforeAll(async () => {
    admin = createPool(databaseUrl as string);
    await admin.query(`drop database if exists ${TEST_DB}`);
    await admin.query(`create database ${TEST_DB}`);
    const url = new URL(databaseUrl as string);
    url.pathname = `/${TEST_DB}`;
    pool = createPool(url.toString());
    dataDir = await mkdtemp(path.join(tmpdir(), 'buddi-owner-secrets-'));
    process.env.BUDDI_DATA_DIR = dataDir;
  }, 60_000);

  afterAll(async () => {
    resetPluginHost();
    resetSecretDestinations();
    await pool?.end();
    if (admin) {
      await admin.query(`drop database if exists ${TEST_DB}`);
      await admin.end();
    }
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    delete process.env.BUDDI_DATA_DIR;
  });

  it('adopts each mailbox once, clears the environment, and the mailboxes keep polling', async () => {
    const personal = new FakeImapServer();
    const work = new FakeImapServer();
    personal.add('INBOX', fakeMessage({
      messageId: '<p-1@bank.test>', from: 'Bank <alerts@bank.test>', to: [PERSONAL],
      subject: 'Statement', bodyText: 'Your statement is ready.', date: new Date('2026-09-20T08:00:00Z'),
    }));
    work.add('INBOX', fakeMessage({
      messageId: '<w-1@client.test>', from: 'Client <c@client.test>', to: [WORK],
      subject: 'Invoice 42', bodyText: 'Could you resend invoice 42?', date: new Date('2026-09-21T08:00:00Z'),
    }));
    const logins: Array<[string, string]> = [];
    const connect: NonNullable<Parameters<typeof createEmailManifest>[0]>['connect'] = async (account, auth) => {
      logins.push([account.address, auth.pass]);
      return (account.address === WORK ? work : personal).client();
    };

    // The installed plugin: no environment injected, so passwords come from secrets.
    const manifest = createEmailManifest({ connect });
    await runMigrations(pool, [manifest]);
    const registry = new ToolRegistry();
    registry.register(manifest);

    await ensureGmailAccount(pool, { GMAIL_USER: PERSONAL });
    await pool.query(
      `insert into email.accounts
         (address, imap_host, imap_port, smtp_host, smtp_port, auth_mode, secret_name, enabled, added_via)
       values ($1, 'imap.work.test', 993, 'smtp.work.test', 465, 'app-password', $2, true, 'page')`,
      [WORK, WORK_SECRET],
    );

    // As a boot left them: the page-added password in the vault and hydrated
    // into the environment, the `.env` account's only in the environment.
    const vault = createMemoryVault({ seed: { [WORK_SECRET]: 'work-app-password' } });
    const env: NodeJS.ProcessEnv = {
      [GMAIL_SECRET_NAME]: 'personal-app-password',
      [WORK_SECRET]: 'work-app-password',
      EMAIL_BACKFILL: '20',
      GMAIL_USER: PERSONAL,
    };

    const first = await adoptMailboxSecrets(pool, vault, env);
    expect(first).toEqual({ outcomes: { [PERSONAL]: 'adopted', [WORK]: 'adopted' }, problems: [] });
    const again = await adoptMailboxSecrets(pool, vault, env);
    expect(again.outcomes).toEqual({ [PERSONAL]: 'already', [WORK]: 'already' });

    const accounts = await listAccounts(pool, { enabledOnly: false });
    for (const [name, value] of [[GMAIL_SECRET_NAME, 'personal-app-password'], [WORK_SECRET, 'work-app-password']] as const) {
      const secret = (await findSecret(pool, name))!;
      expect(await vault.get(ownerSecretVaultName(secret.id))).toBe(value);
      const account = accounts.find((a) => a.secretName === name)!;
      const { rows } = await pool.query(`select kind, target, rule from core.secret_bindings where secret_id = $1`, [secret.id]);
      expect(rows).toEqual([{ kind: 'email.account', target: account.id, rule: 'pre-approved' }]);
    }
    // The old vault entry went once the new one read back.
    expect(await vault.get(WORK_SECRET)).toBeNull();

    const cleared = clearFromEnvironment(env, mailboxSecretNames(env, accounts.map((a) => a.secretName)));
    expect(cleared.sort()).toEqual([GMAIL_SECRET_NAME, WORK_SECRET].sort());
    expect(env).toEqual({ EMAIL_BACKFILL: '20', GMAIL_USER: PERSONAL });

    // Both mailboxes poll, their passwords delivered through ctx.buddi.secrets.
    configurePluginHost({ vault });
    const lines: string[] = [];
    const facts = {
      db: pool,
      now: () => new Date('2026-09-22T12:00:00Z'),
      timezone: 'UTC',
      log: (line: string) => lines.push(line),
      enqueueRun: async () => {},
    } as SourceContext;
    const ctx = { ...facts, buddi: createPluginHost(hostBindingOf(manifest), facts as never) } as SourceContext;
    // The installed source, with no environment, but every message backfilled.
    await createInboxPollSource({ connect: connect!, backfill: 1_000 }).poll(ctx);

    expect(lines.filter((line) => line.includes('secret-missing'))).toEqual([]);
    expect(logins.sort()).toEqual([
      [WORK, 'work-app-password'],
      [PERSONAL, 'personal-app-password'],
    ].sort());
    const { rows: landed } = await pool.query(`select subject from email.messages order by subject`);
    expect(landed.map((r) => r.subject)).toEqual(['Invoice 42', 'Statement']);
    const { rows: uses } = await pool.query(`select secret_name, outcome from core.secret_uses order by secret_name`);
    expect(uses.every((u) => u.outcome === 'held')).toBe(true);
    for (const name of [GMAIL_SECRET_NAME, WORK_SECRET]) expect(process.env[name]).toBeUndefined();
  }, 60_000);
});
