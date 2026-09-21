/**
 * Account configuration — deliberately **not** a tool.
 *
 * An agent must never be able to point the mailbox somewhere else: which
 * accounts buddi reads and sends as is owner configuration, done from the
 * settings page or by env at startup, and the registry never carries a
 * `configure_account` capability to argue with. What an agent may do is *name*
 * one of the accounts the owner configured — that is a filter over rows, not a
 * new mailbox — which is why the read tools take an `account` argument and
 * nothing here takes a host or a password.
 *
 * Two ways a row gets here, and they never fight:
 *
 *  - `ensureGmailAccount` seeds the one account `GMAIL_USER` names, on every
 *    boot, exactly as it always did. It refreshes hosts and auth mode, and it
 *    touches nothing the owner set on the page.
 *  - the settings page inserts the rest, each with its own vault secret.
 *
 * The schema stores the *name* of the secret, never the secret. Resolution goes
 * through `resolveAuth`, which reads the named entry from the environment the
 * caller hands it; the vault is what fills that environment at startup.
 */
import type { Pool } from 'pg';
import {
  type AccountRecord,
  type EmailAuth,
  type Resolved,
} from './ports.js';
import { ACCOUNT_COLUMNS, toAccount } from './rows.js';

export type EnvLike = Record<string, string | undefined>;

/** Gmail's endpoints. Implicit TLS on both; nothing here ever downgrades. */
export const GMAIL_IMAP_HOST = 'imap.gmail.com';
export const GMAIL_IMAP_PORT = 993;
export const GMAIL_SMTP_HOST = 'smtp.gmail.com';
export const GMAIL_SMTP_PORT = 465;

/** The env var naming the account, and the vault key naming its app password. */
export const GMAIL_USER_VAR = 'GMAIL_USER';
export const GMAIL_SECRET_NAME = 'GMAIL_APP_PASSWORD';

/** The mailbox the source polls. */
export const INBOX = 'INBOX';

/** The prefix every page-added account's vault secret is filed under. */
export const ACCOUNT_SECRET_PREFIX = 'EMAIL_';

/**
 * The vault name for an account's password, derived from its address.
 *
 * Derived rather than chosen, so the name is the same on the page, in the row,
 * in the keychain and in the doctor's output, and so removing the account can
 * remove the secret without a second lookup. Secret names are
 * environment-variable shaped (`assertSecretName` in core refuses anything
 * else), so everything that is not a letter, a digit or an underscore becomes
 * one: `amen@example.com` is `EMAIL_AMEN_EXAMPLE_COM`.
 */
export function secretNameFor(address: string): string {
  const sanitised = address.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (sanitised === '') throw new Error(`no secret name can be derived from ${JSON.stringify(address)}`);
  return `${ACCOUNT_SECRET_PREFIX}${sanitised}`;
}

/**
 * Upsert the configured Gmail account. Returns `null` when `GMAIL_USER` is not
 * set — no mailbox configured is a valid, running state, not an error, and the
 * source simply has nothing to poll.
 *
 * Re-running it is how the owner moves the account: the address is the key, the
 * hosts and auth mode are refreshed from these constants.
 */
export async function ensureGmailAccount(
  pool: Pool,
  env: EnvLike = process.env,
): Promise<AccountRecord | null> {
  const address = env[GMAIL_USER_VAR]?.trim().toLowerCase();
  if (!address) return null;

  const { rows } = await pool.query(
    `insert into email.accounts
       (address, imap_host, imap_port, smtp_host, smtp_port, auth_mode, secret_name, added_via)
     values ($1, $2, $3, $4, $5, 'app-password', $6, 'env')
     on conflict (address) do update
       set imap_host = excluded.imap_host,
           imap_port = excluded.imap_port,
           smtp_host = excluded.smtp_host,
           smtp_port = excluded.smtp_port,
           auth_mode = excluded.auth_mode,
           -- An account the owner added on the page owns its own vault secret
           -- and its own provenance. The env seed refreshes the transport it
           -- knows about and leaves both alone, so re-seeding a boot never
           -- points a page-added account at GMAIL_APP_PASSWORD.
           secret_name = case when email.accounts.added_via = 'page'
                              then email.accounts.secret_name
                              else excluded.secret_name end,
           added_via = email.accounts.added_via
     returning ${ACCOUNT_COLUMNS}`,
    [
      address,
      GMAIL_IMAP_HOST,
      GMAIL_IMAP_PORT,
      GMAIL_SMTP_HOST,
      GMAIL_SMTP_PORT,
      GMAIL_SECRET_NAME,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('ensureGmailAccount: upsert returned no row');
  return toAccount(row);
}

/**
 * Every account this installation holds, oldest first so the order is stable.
 *
 * `enabledOnly` is the default everywhere that *acts*: the poll, the read
 * tools, a draft. A disabled account keeps its mail and its cursor and is
 * simply not walked. The settings page asks for all of them, because a row you
 * cannot see is a row you cannot turn back on.
 */
export async function listAccounts(
  pool: Pool,
  opts: { enabledOnly?: boolean } = {},
): Promise<AccountRecord[]> {
  const enabledOnly = opts.enabledOnly ?? true;
  const { rows } = await pool.query(
    `select ${ACCOUNT_COLUMNS} from email.accounts
      ${enabledOnly ? 'where enabled' : ''}
      order by created_at asc, address asc`,
  );
  return rows.map(toAccount);
}

/**
 * One account, named the way a person or an agent would name it: by its id, by
 * its address, or by one of its aliases.
 *
 * An alias is identity, so "the account that receives as this address" is the
 * same question as "the account with this address" and gets the same answer.
 * Unknown is `null`, not a throw: which of the two ways a caller says that is
 * the caller's, and `requireOneAccount` is where the sentence lives.
 */
export async function findAccount(
  pool: Pool,
  ref: string,
  opts: { enabledOnly?: boolean } = {},
): Promise<AccountRecord | null> {
  const needle = ref.trim().toLowerCase();
  if (needle === '') return null;
  const enabledOnly = opts.enabledOnly ?? true;
  const { rows } = await pool.query(
    `select ${ACCOUNT_COLUMNS} from email.accounts
      where ${enabledOnly ? 'enabled and ' : ''}(
              address = $1
              or $1 = any (select lower(a) from unnest(aliases) as a)
              or id::text = $1
            )
      order by created_at asc
      limit 1`,
    [needle],
  );
  return rows[0] ? toAccount(rows[0]) : null;
}

/**
 * When mail last landed for each account, keyed by account id.
 *
 * Derived rather than stamped: the newest `fetched_at` among the account's
 * messages is a fact the ingest already writes, and a `last_sync_at` column
 * would be a second one to keep true. Null means nothing has ever arrived.
 */
export async function lastSyncByAccount(pool: Pool): Promise<Map<string, string | null>> {
  const { rows } = await pool.query(
    `select account_id, max(fetched_at) as last_sync from email.messages group by account_id`,
  );
  const out = new Map<string, string | null>();
  for (const row of rows) {
    const value = (row as { last_sync: unknown }).last_sync;
    out.set(
      String((row as { account_id: unknown }).account_id),
      value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : String(value),
    );
  }
  return out;
}

/**
 * Credentials for an account, by the secret name the row carries.
 *
 * `xoauth2` is a declared auth mode with no implementation: it returns a typed
 * `unsupported-auth-mode` problem rather than silently falling back to a
 * password, because "the other auth mode on the same transport" is the
 * documented migration path and a silent fallback would hide that it has not
 * happened yet.
 */
export function resolveAuth(
  account: AccountRecord,
  env: EnvLike = process.env,
): Resolved<EmailAuth> {
  if (account.authMode === 'xoauth2') {
    return {
      ok: false,
      problem: {
        code: 'unsupported-auth-mode',
        message: `account ${account.address} is configured for xoauth2, which this build does not implement (app-password only)`,
      },
    };
  }
  const pass = env[account.secretName]?.trim();
  if (!pass) {
    return {
      ok: false,
      problem: {
        code: 'secret-missing',
        message: `no secret named ${account.secretName} for account ${account.address}`,
      },
    };
  }
  return { ok: true, value: { mode: 'app-password', user: account.address, pass } };
}
