/**
 * Mail accounts, added from the dashboard instead of from `.env`.
 *
 * docs/email.md §2: "Secrets live in the vault, one name per account, entered
 * on the settings page, never in `.env`." This is that route, and it is shaped
 * exactly like the Telegram token one next door — the owner acting on their own
 * installation, behind the same session, Origin and CSRF gate, with the secret
 * going to the machine's vault and the *name* of it going to the database.
 *
 * Three things happen on the way in, in this order, and the order is the whole
 * design:
 *
 *  1. **The login is tested, once, before anything is kept.** An address, a
 *     host and a password that IMAP refuses is not an account — it is a typo,
 *     and the owner finds out now rather than at the next poll, from a log line
 *     they will never read. The test goes through the plugin's own client
 *     factory, so it is the same code path the source uses and a test injects a
 *     fake instead of dialling out.
 *  2. **The password goes to the vault**, under `EMAIL_<sanitised address>` —
 *     derived from the address rather than chosen, so the name is the same on
 *     the page, in the row, in the keychain and in `buddi doctor`.
 *  3. **The row is written**, carrying that name and nothing else. Nothing in
 *     the email schema ever holds a credential.
 *
 * Removing an account undoes both halves: the row and the vault entry. A
 * password left behind in the keychain after the mailbox it opened was removed
 * is a secret nobody is responsible for any more.
 */
import { createVault, type Vault } from '@buddi/core';
import {
  ACCOUNT_COLUMNS,
  INBOX,
  lastSyncByAccount,
  listAccounts,
  secretNameFor,
  toAccount,
  imapflowFactory,
  type AccountRecord,
  type ImapClientFactory,
} from '@buddi/tool-email';
import type { Pool } from 'pg';

export interface EmailWebDeps {
  pool: Pool;
  env: NodeJS.ProcessEnv;
  /** Injected by tests; the machine's own vault otherwise. */
  vault?: Vault | undefined;
  /** How the login is tested. Injected by tests; the real IMAP client otherwise. */
  connect?: ImapClientFactory | undefined;
}

export class EmailWebError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'EmailWebError';
  }
}

/** One account as the page shows it. Never the secret — only its name. */
export interface EmailAccountView {
  id: string;
  address: string;
  displayName: string | null;
  aliases: string[];
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  /** The vault entry that holds this account's password. A name, not a value. */
  secretName: string;
  enabled: boolean;
  /** 'env' is the GMAIL_USER seed; 'page' is one added here. */
  addedVia: 'env' | 'page';
  /** When mail last landed for this account, or null if none ever has. */
  lastSyncAt: string | null;
}

function view(account: AccountRecord, lastSyncAt: string | null): EmailAccountView {
  return {
    id: account.id,
    address: account.address,
    displayName: account.displayName,
    aliases: account.aliases,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    secretName: account.secretName,
    enabled: account.enabled,
    addedVia: account.addedVia,
    lastSyncAt,
  };
}

export interface EmailAccountsView {
  accounts: EmailAccountView[];
}

/** Every account, disabled ones included: a row you cannot see cannot be fixed. */
export async function listEmailAccounts(deps: EmailWebDeps): Promise<EmailAccountsView> {
  const accounts = await listAccounts(deps.pool, { enabledOnly: false });
  const synced = await lastSyncByAccount(deps.pool);
  return { accounts: accounts.map((account) => view(account, synced.get(account.id) ?? null)) };
}

/** What the page sends. Everything but `password` also comes back out again. */
export interface NewEmailAccount {
  address: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  password: string;
  displayName?: string | null;
  aliases?: string[];
}

const ADDRESS = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function address(value: unknown, what: string): string {
  const trimmed = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!ADDRESS.test(trimmed)) throw new EmailWebError(400, `${what} does not look like an email address.`);
  return trimmed;
}

function host(value: unknown, what: string): string {
  const trimmed = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (trimmed === '' || /\s/.test(trimmed)) throw new EmailWebError(400, `${what} is missing.`);
  return trimmed;
}

function port(value: unknown, what: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    throw new EmailWebError(400, `${what} must be a port number between 1 and 65535.`);
  }
  return n;
}

/** The body, checked into a shape the rest of this file can trust. */
export function readNewAccount(body: Record<string, unknown>): NewEmailAccount {
  const password = typeof body.password === 'string' ? body.password.trim() : '';
  if (password === '') throw new EmailWebError(400, 'The password for this mailbox is missing.');
  const aliases = Array.isArray(body.aliases)
    ? body.aliases.map((alias, i) => address(alias, `Alias ${i + 1}`))
    : [];
  const displayName = typeof body.displayName === 'string' && body.displayName.trim() !== ''
    ? body.displayName.trim().slice(0, 120)
    : null;
  return {
    address: address(body.address, 'That address'),
    imapHost: host(body.imapHost, 'The IMAP host'),
    imapPort: port(body.imapPort, 'The IMAP port'),
    smtpHost: host(body.smtpHost, 'The SMTP host'),
    smtpPort: port(body.smtpPort, 'The SMTP port'),
    password,
    displayName,
    aliases: [...new Set(aliases)],
  };
}

/**
 * Does this mailbox actually open?
 *
 * One connection, one SELECT, closed again. A failure is the owner's to fix and
 * is answered in their words, not the server's: "the server refused these
 * credentials" rather than an IMAP response line nobody outside a mail client
 * has ever read. The underlying message is appended when there is one, because
 * "could not connect" without the host's own reason is the kind of answer that
 * sends someone to a log file.
 */
export async function testLogin(deps: EmailWebDeps, account: NewEmailAccount): Promise<void> {
  const connect = deps.connect ?? imapflowFactory;
  const candidate: AccountRecord = {
    id: '',
    address: account.address,
    imapHost: account.imapHost,
    imapPort: account.imapPort,
    smtpHost: account.smtpHost,
    smtpPort: account.smtpPort,
    authMode: 'app-password',
    secretName: secretNameFor(account.address),
    aliases: account.aliases ?? [],
    displayName: account.displayName ?? null,
    enabled: true,
    addedVia: 'page',
    createdAt: null,
  };
  let client: Awaited<ReturnType<ImapClientFactory>> | null = null;
  try {
    client = await connect(candidate, { mode: 'app-password', user: account.address, pass: account.password });
    await client.open(INBOX);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new EmailWebError(
      400,
      `${account.imapHost} would not let us in as ${account.address}. Check the address and the app password — many providers need an app password rather than the one you type into their website. (${reason})`,
    );
  } finally {
    await client?.close().catch(() => {});
  }
}

/**
 * Test, keep the password, write the row.
 *
 * The vault entry is written before the row and removed again if the insert
 * fails, so the two never disagree: a secret with no account is a password
 * nobody owns, and an account with no secret is a mailbox that cannot open.
 */
export async function addEmailAccount(
  deps: EmailWebDeps,
  body: Record<string, unknown>,
): Promise<EmailAccountView> {
  const account = readNewAccount(body);

  const { rows: existing } = await deps.pool.query(
    `select 1 from email.accounts where address = $1`,
    [account.address],
  );
  if (existing.length > 0) {
    throw new EmailWebError(409, `${account.address} is already here. Remove it first if you want to change its password.`);
  }

  await testLogin(deps, account);

  const vault = deps.vault ?? createVault({ env: deps.env });
  if (!vault) throw new EmailWebError(409, 'This installation has nowhere safe to keep the password.');
  const secretName = secretNameFor(account.address);
  try {
    await vault.set(secretName, account.password);
  } catch {
    throw new EmailWebError(409, 'The password could not be kept safely. Unlock this machine and try again.');
  }
  // Into this process's environment too, so the next poll finds it without a
  // restart. Startup reads the same name back out of the vault.
  deps.env[secretName] = account.password;

  try {
    const { rows } = await deps.pool.query(
      `insert into email.accounts
         (address, imap_host, imap_port, smtp_host, smtp_port, auth_mode, secret_name,
          aliases, display_name, enabled, added_via)
       values ($1, $2, $3, $4, $5, 'app-password', $6, $7::text[], $8, true, 'page')
       returning ${ACCOUNT_COLUMNS}`,
      [
        account.address,
        account.imapHost,
        account.imapPort,
        account.smtpHost,
        account.smtpPort,
        secretName,
        account.aliases ?? [],
        account.displayName,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('the account row was not written');
    return view(toAccount(row), null);
  } catch (error) {
    await vault.delete(secretName).catch(() => {});
    delete deps.env[secretName];
    throw new EmailWebError(
      500,
      `${account.address} opened, but the account could not be written down: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export interface RemovedEmailAccount {
  removed: boolean;
  address: string | null;
  /** True when the vault entry went with it. */
  secretRemoved: boolean;
}

/**
 * Remove an account and the password it used.
 *
 * The row goes first: the mail, the drafts and the cursor go with it by
 * cascade, and the draft rows keep their history with a null account. Then the
 * vault entry, which is only removed when it is *this* account's — the
 * env-seeded account shares `GMAIL_APP_PASSWORD` with the variable that named
 * it, and deleting that from under `.env` would be a surprise.
 */
export async function removeEmailAccount(
  deps: EmailWebDeps,
  id: string,
): Promise<RemovedEmailAccount> {
  const { rows } = await deps.pool.query(
    `delete from email.accounts where id = $1 returning ${ACCOUNT_COLUMNS}`,
    [id],
  );
  const row = rows[0];
  if (!row) return { removed: false, address: null, secretRemoved: false };
  const account = toAccount(row);

  let secretRemoved = false;
  if (account.addedVia === 'page' && account.secretName === secretNameFor(account.address)) {
    const vault = deps.vault ?? createVault({ env: deps.env });
    secretRemoved = (await vault?.delete(account.secretName).catch(() => false)) ?? false;
    delete deps.env[account.secretName];
  }
  return { removed: true, address: account.address, secretRemoved };
}
