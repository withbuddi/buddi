/**
 * The email plugin's mailbox passwords, moved into owner secrets at start
 * (docs/owner-secrets.md §7, acceptance 5): adopted from a throwaway
 * vault, idempotently; the mailbox `.env` used to name adopted once as a
 * Settings → Email account with its mail and cursors kept; the old entries gone
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
  putOwnerSecret,
  hostBindingOf,
  ownerSecretVaultName,
  resetPluginHost,
  resetSecretDestinations,
  runMigrations,
  ToolRegistry,
  type CoreSourceContext,
} from '@buddi/core';
import { testDatabaseUrl } from '@buddi/core/testing';
import {
  createEmailManifest,
  createInboxPollSource,
  FakeImapServer,
  fakeMessage,
  listAccounts,
  secretNameFor,
  type ImapClientFactory,
} from '@buddi/tool-email';
import {
  adoptEnvMailbox,
  adoptMailboxSecrets,
  adoptProviderAccountSecrets,
  clearFromEnvironment,
  ENV_MAILBOX_ADOPTED_KEY,
  mailboxSecretNames,
  ownerSecretVault,
} from './owner-secrets.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const TEST_DB = `buddi_owner_secrets_${process.pid}`;
const PERSONAL = 'owner@example.test';
const WORK = 'owner@work.test';
const WORK_SECRET = secretNameFor(WORK);
const PERSONAL_SECRET = secretNameFor(PERSONAL);
const LEGACY_SECRET = 'GMAIL_APP_PASSWORD';

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

    await pool.query(
      `insert into email.accounts
         (address, imap_host, imap_port, smtp_host, smtp_port, auth_mode, secret_name, enabled, added_via)
       values ($1, 'imap.work.test', 993, 'smtp.work.test', 465, 'app-password', $2, true, 'page')`,
      [WORK, WORK_SECRET],
    );

    // As a boot left them: the page-added password in the vault and hydrated
    // into the environment, the `.env` mailbox's only in `.env`.
    const vault = createMemoryVault({ seed: { [WORK_SECRET]: 'work-app-password' } });
    const env: NodeJS.ProcessEnv = {
      [LEGACY_SECRET]: 'personal-app-password',
      [WORK_SECRET]: 'work-app-password',
      EMAIL_BACKFILL: '20',
      GMAIL_USER: PERSONAL,
    };

    // The `.env` mailbox becomes a Settings account first, then every
    // account's password is adopted as before.
    expect(await adoptEnvMailbox(pool, vault, env)).toMatchObject({ outcome: 'adopted', address: PERSONAL });
    const first = await adoptMailboxSecrets(pool, vault);
    expect(first).toEqual({ outcomes: { [PERSONAL]: 'already', [WORK]: 'adopted' }, problems: [] });
    const again = await adoptMailboxSecrets(pool, vault);
    expect(again.outcomes).toEqual({ [PERSONAL]: 'already', [WORK]: 'already' });

    const accounts = await listAccounts(pool, { enabledOnly: false });
    for (const [name, value] of [[PERSONAL_SECRET, 'personal-app-password'], [WORK_SECRET, 'work-app-password']] as const) {
      const secret = (await findSecret(pool, name))!;
      expect(await vault.get(ownerSecretVaultName(secret.id))).toBe(value);
      const account = accounts.find((a) => a.secretName === name)!;
      const { rows } = await pool.query(`select kind, target, rule from core.secret_bindings where secret_id = $1`, [secret.id]);
      expect(rows).toEqual([{ kind: 'email.account', target: account.id, rule: 'pre-approved' }]);
    }
    // The old vault entry went once the new one read back.
    expect(await vault.get(WORK_SECRET)).toBeNull();

    const cleared = clearFromEnvironment(env, mailboxSecretNames(env, accounts.map((a) => a.secretName)));
    expect(cleared.sort()).toEqual([LEGACY_SECRET, WORK_SECRET].sort());
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
    } as CoreSourceContext;
    const ctx = { ...facts, buddi: createPluginHost(hostBindingOf(manifest), facts as never) } as CoreSourceContext;
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
    for (const name of [LEGACY_SECRET, PERSONAL_SECRET, WORK_SECRET]) expect(process.env[name]).toBeUndefined();
  }, 60_000);

  it('adopts provider account credentials into owner secrets bound to their rows, and the adapters read through the translated vault', async () => {
    await pool.query(
      `insert into core.provider_accounts
         (id, label, kind, auth, base_url, default_model, secret_ref, enabled, legacy_env)
       values ('11111111-1111-4111-8111-111111111111', 'Work key', 'anthropic', 'api-key', 'https://api.anthropic.com', 'claude-sonnet-5', 'PROVIDER_ACCOUNT_ADOPTED_1', true, null),
              ('22222222-2222-4222-8222-222222222222', 'Legacy key', 'openai', 'api-key', 'https://api.openai.com/v1', 'gpt-5', 'OPENAI_API_KEY', true, 'OPENAI_API_KEY')`,
    );
    const vault = createMemoryVault({ seed: {
      PROVIDER_ACCOUNT_ADOPTED_1: 'sk-ant-adopted-credential',
      OPENAI_API_KEY: 'sk-legacy-key',
    } });

    const first = await adoptProviderAccountSecrets(pool, vault);
    expect(first.outcomes).toEqual({
      '11111111-1111-4111-8111-111111111111': 'adopted',
      '22222222-2222-4222-8222-222222222222': 'skipped',
    });
    const again = await adoptProviderAccountSecrets(pool, vault);
    expect(again.outcomes['11111111-1111-4111-8111-111111111111']).toBe('already');

    // The adopted value lives under the owner secret, the old entry is gone.
    const secret = (await findSecret(pool, 'PROVIDER_ACCOUNT_ADOPTED_1'))!;
    expect(await vault.get(ownerSecretVaultName(secret.id))).toBe('sk-ant-adopted-credential');
    expect(await vault.get('PROVIDER_ACCOUNT_ADOPTED_1')).toBeNull();
    const { rows: bindings } = await pool.query(
      `select kind, target, rule from core.secret_bindings where secret_id = $1`, [secret.id]);
    expect(bindings).toEqual([{ kind: 'accounts.provider', target: '11111111-1111-4111-8111-111111111111', rule: 'pre-approved' }]);

    // The translated vault: an adapter asking by the old name reaches the
    // owner secret's value; writes land under the same owner secret.
    const translated = ownerSecretVault(vault, pool);
    expect(await translated.get('PROVIDER_ACCOUNT_ADOPTED_1')).toBe('sk-ant-adopted-credential');
    await translated.set('PROVIDER_ACCOUNT_ADOPTED_1', 'sk-ant-refreshed-value');
    expect(await vault.get(ownerSecretVaultName(secret.id))).toBe('sk-ant-refreshed-value');
    expect(await translated.get('OPENAI_API_KEY')).toBe('sk-legacy-key'); // untouched: buddi's own key
    await expect(translated.get('NOTHING_BY_THAT_NAME')).resolves.toBeNull();
  }, 30_000);

  describe('the .env mailbox, adopted once as a Settings → Email account', () => {
    async function reset(): Promise<void> {
      resetPluginHost();
      await pool.query(
        'truncate email.drafts, email.triage, email.messages, email.threads, email.folders, email.accounts, email.settings cascade',
      );
      await pool.query('truncate core.secrets cascade');
    }

    /** The row the old boot seed wrote for `GMAIL_USER`, exactly as it wrote it. */
    async function oldSeedRow(address = PERSONAL): Promise<string> {
      const { rows } = await pool.query(
        `insert into email.accounts
           (address, imap_host, imap_port, smtp_host, smtp_port, auth_mode, secret_name, added_via)
         values ($1, 'imap.gmail.com', 993, 'smtp.gmail.com', 465, 'app-password', $2, 'env')
         returning id::text as id`,
        [address, LEGACY_SECRET],
      );
      return rows[0].id as string;
    }

    /** One poll by the installed source, no environment: passwords come from owner secrets. */
    function poller(server: FakeImapServer, vault: ReturnType<typeof createMemoryVault>) {
      const logins: string[] = [];
      const fetched: number[] = [];
      const enqueued: string[] = [];
      const connect: ImapClientFactory = async (_account, auth) => {
        logins.push(auth.pass);
        const client = server.client();
        const fetchSince = client.fetchSince.bind(client);
        client.fetchSince = async (mailbox, since, limit) => {
          const got = await fetchSince(mailbox, since, limit);
          if (mailbox === 'INBOX') fetched.push(...got.map((m) => m.uid));
          return got;
        };
        return client;
      };
      const manifest = createEmailManifest({ connect });
      const poll = async (): Promise<string[]> => {
        configurePluginHost({ vault });
        const lines: string[] = [];
        const facts = {
          db: pool,
          now: () => new Date('2026-09-22T12:00:00Z'),
          timezone: 'UTC',
          log: (line: string) => lines.push(line),
          enqueueRun: async (input: { dedupKey?: string }) => {
            enqueued.push(String(input.dedupKey));
            return { id: `run-${enqueued.length}` };
          },
        } as unknown as CoreSourceContext;
        const ctx = { ...facts, buddi: createPluginHost(hostBindingOf(manifest), facts as never) } as CoreSourceContext;
        await createInboxPollSource({ connect, backfill: 1_000 }).poll(ctx);
        return lines;
      };
      return { poll, logins, fetched, enqueued };
    }

    it('creates the account in place, moves the password, keeps the cursor, and nothing is read or triaged twice', async () => {
      await reset();
      const server = new FakeImapServer();
      server.add('INBOX', fakeMessage({
        messageId: '<before@bank.test>', from: 'Bank <alerts@bank.test>', to: [PERSONAL],
        subject: 'Before', bodyText: 'Synced by the old seed.', date: new Date('2026-09-20T08:00:00Z'),
      }));
      // Yesterday's install: the env row, its password already an owner
      // secret named GMAIL_APP_PASSWORD bound to it, one message synced and triaged.
      const accountId = await oldSeedRow();
      const vault = createMemoryVault();
      const legacy = await putOwnerSecret(pool, vault, {
        name: LEGACY_SECRET,
        value: 'personal-app-password',
        bindings: [{ kind: 'email.account', target: accountId, rule: 'pre-approved' }],
      });
      const before = poller(server, vault);
      expect((await before.poll()).filter((l) => l.includes('secret-missing'))).toEqual([]);
      expect(before.fetched).toEqual([1]);
      expect(before.enqueued).toHaveLength(1);

      // `.env` still says what it said, the password a vault marker there.
      const env = { GMAIL_USER: ` ${PERSONAL.toUpperCase()} `, [LEGACY_SECRET]: '"<vault>"' };
      expect(await adoptEnvMailbox(pool, vault, env)).toEqual({ outcome: 'adopted', address: PERSONAL, accountId });

      const [account] = await listAccounts(pool, { enabledOnly: false });
      expect(await listAccounts(pool, { enabledOnly: false })).toHaveLength(1);
      expect(account).toMatchObject({
        id: accountId,
        address: PERSONAL,
        addedVia: 'page',
        secretName: PERSONAL_SECRET,
        imapHost: 'imap.gmail.com',
        imapPort: 993,
        smtpHost: 'smtp.gmail.com',
        smtpPort: 465,
      });
      // Renamed, not copied: the same owner secret, its value and binding kept.
      expect(await findSecret(pool, LEGACY_SECRET)).toBeNull();
      const moved = (await findSecret(pool, PERSONAL_SECRET))!;
      expect(moved.id).toBe(legacy.id);
      expect(await vault.get(ownerSecretVaultName(moved.id))).toBe('personal-app-password');
      const { rows: bindings } = await pool.query(`select kind, target, rule from core.secret_bindings where secret_id = $1`, [moved.id]);
      expect(bindings).toEqual([{ kind: 'email.account', target: accountId, rule: 'pre-approved' }]);

      // The next poll picks up where the old one stopped: only the new message.
      server.add('INBOX', fakeMessage({
        messageId: '<after@bank.test>', from: 'Bank <alerts@bank.test>', to: [PERSONAL],
        subject: 'After', bodyText: 'Arrived after the upgrade.', date: new Date('2026-09-21T08:00:00Z'),
      }));
      const after = poller(server, vault);
      expect((await after.poll()).filter((l) => l.includes('secret-missing'))).toEqual([]);
      expect(after.logins).toEqual(['personal-app-password']);
      expect(after.fetched).toEqual([2]);
      expect(after.enqueued).toHaveLength(1);
      expect(after.enqueued[0]).not.toBe(before.enqueued[0]);
      const { rows: landed } = await pool.query(`select subject, account_id::text as account from email.messages order by uid`);
      expect(landed).toEqual([
        { subject: 'Before', account: accountId },
        { subject: 'After', account: accountId },
      ]);

      // Once: every later start answers `done` and reads nothing from `.env`.
      expect(await adoptEnvMailbox(pool, vault, env)).toEqual({ outcome: 'done' });
      const { rows: marker } = await pool.query(`select value from email.settings where key = $1`, [ENV_MAILBOX_ADOPTED_KEY]);
      expect(marker[0].value).toEqual({ outcome: 'adopted', address: PERSONAL });
    }, 60_000);

    it('moves a raw vault password or a .env one, and takes the raw vault entry away', async () => {
      await reset();
      const accountId = await oldSeedRow();
      const vault = createMemoryVault({ seed: { [LEGACY_SECRET]: 'from-the-vault' } });
      const adopted = await adoptEnvMailbox(pool, vault, { GMAIL_USER: PERSONAL, [LEGACY_SECRET]: '"<vault>"' });
      expect(adopted).toEqual({ outcome: 'adopted', address: PERSONAL, accountId });
      expect(await vault.get(LEGACY_SECRET)).toBeNull();
      const secret = (await findSecret(pool, PERSONAL_SECRET))!;
      expect(await vault.get(ownerSecretVaultName(secret.id))).toBe('from-the-vault');

      // No row yet at all (GMAIL_USER set, never booted): the account is created.
      await reset();
      const fresh = createMemoryVault();
      const created = await adoptEnvMailbox(pool, fresh, { GMAIL_USER: PERSONAL, [LEGACY_SECRET]: 'from-dotenv' });
      expect(created).toMatchObject({ outcome: 'adopted', address: PERSONAL });
      const [account] = await listAccounts(pool, { enabledOnly: false });
      expect(account).toMatchObject({ addedVia: 'page', secretName: PERSONAL_SECRET });
      const made = (await findSecret(pool, PERSONAL_SECRET))!;
      expect(await fresh.get(ownerSecretVaultName(made.id))).toBe('from-dotenv');
    });

    it('creates nothing, and tries again next start, when the password is not readable', async () => {
      await reset();
      const vault = createMemoryVault();
      const env = { GMAIL_USER: PERSONAL, [LEGACY_SECRET]: '"<vault>"' };
      expect(await adoptEnvMailbox(pool, vault, env)).toMatchObject({ outcome: 'no-password', address: PERSONAL });
      expect(await listAccounts(pool, { enabledOnly: false })).toEqual([]);
      const { rows: secrets } = await pool.query(`select name from core.secrets`);
      expect(secrets).toEqual([]);
      const { rows: marker } = await pool.query(`select 1 from email.settings where key = $1`, [ENV_MAILBOX_ADOPTED_KEY]);
      expect(marker).toEqual([]);

      // An old seed row with no password is left as it was, for the page to claim.
      const accountId = await oldSeedRow();
      expect(await adoptEnvMailbox(pool, vault, env)).toMatchObject({ outcome: 'no-password' });
      const [kept] = await listAccounts(pool, { enabledOnly: false });
      expect(kept).toMatchObject({ id: accountId, addedVia: 'env', secretName: LEGACY_SECRET });
    });

    it('touches nothing when the address is already a Settings account, and never reads .env again', async () => {
      await reset();
      await pool.query(
        `insert into email.accounts
           (address, imap_host, imap_port, smtp_host, smtp_port, auth_mode, secret_name, display_name, added_via)
         values ($1, 'imap.gmail.com', 993, 'smtp.gmail.com', 465, 'app-password', $2, 'Mine', 'page')`,
        [PERSONAL, PERSONAL_SECRET],
      );
      const vault = createMemoryVault({ seed: { [LEGACY_SECRET]: 'stale' } });
      const env = { GMAIL_USER: PERSONAL, [LEGACY_SECRET]: 'stale' };
      expect(await adoptEnvMailbox(pool, vault, env)).toEqual({ outcome: 'exists', address: PERSONAL });
      expect(await vault.get(LEGACY_SECRET)).toBe('stale');
      expect(await findSecret(pool, PERSONAL_SECRET)).toBeNull();
      const [account] = await listAccounts(pool, { enabledOnly: false });
      expect(account).toMatchObject({ displayName: 'Mine', addedVia: 'page' });

      // The owner removes it in Settings; the stale .env lines do not bring it back.
      await pool.query('delete from email.accounts');
      expect(await adoptEnvMailbox(pool, vault, env)).toEqual({ outcome: 'done' });
      expect(await listAccounts(pool, { enabledOnly: false })).toEqual([]);
    });

    it('records that there was nothing to adopt, so a GMAIL_USER set later is ignored', async () => {
      await reset();
      const vault = createMemoryVault();
      expect(await adoptEnvMailbox(pool, vault, {})).toEqual({ outcome: 'none' });
      expect(await adoptEnvMailbox(pool, vault, { GMAIL_USER: PERSONAL, [LEGACY_SECRET]: 'x' })).toEqual({ outcome: 'done' });
      expect(await listAccounts(pool, { enabledOnly: false })).toEqual([]);
    });
  });
});
