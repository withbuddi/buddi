/**
 * Account configuration — deliberately **not** a tool.
 *
 * An agent must never be able to point the mailbox somewhere else: which
 * account buddi reads and sends as is owner configuration, done by CLI/env at
 * startup, and the registry never carries a `configure_account` capability to
 * argue with. For v1 that is one Gmail account named by `GMAIL_USER`, whose app
 * password lives under the env name `GMAIL_APP_PASSWORD`.
 *
 * The schema stores the *name* of the secret, never the secret. Resolution goes
 * through `resolveAuth`, which reads the named entry from the environment
 * today; when the vault lands, only this function changes.
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
       (address, imap_host, imap_port, smtp_host, smtp_port, auth_mode, secret_name)
     values ($1, $2, $3, $4, $5, 'app-password', $6)
     on conflict (address) do update
       set imap_host = excluded.imap_host,
           imap_port = excluded.imap_port,
           smtp_host = excluded.smtp_host,
           smtp_port = excluded.smtp_port,
           auth_mode = excluded.auth_mode,
           secret_name = excluded.secret_name
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
 * The account this installation uses. One account in v1 — the oldest row, so
 * the answer is stable — and `null` when none is configured.
 */
export async function currentAccount(pool: Pool): Promise<AccountRecord | null> {
  const { rows } = await pool.query(
    `select ${ACCOUNT_COLUMNS} from email.accounts order by created_at asc, address asc limit 1`,
  );
  return rows[0] ? toAccount(rows[0]) : null;
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
