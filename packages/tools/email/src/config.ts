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
import { createHash } from 'node:crypto';
import type { DbArea } from '@buddi/core/plugin';
import {
  type AccountRecord,
  type EmailAuth,
  type Resolved,
} from './ports.js';
import { ACCOUNT_COLUMNS, toAccount } from './rows.js';

/** `ctx.buddi.db`, a transaction's handle, or anything that answers a query as they do. */
type Db = Pick<DbArea, 'query'>;

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
 * one.
 *
 * And then a hash, which is not decoration. Sanitising alone is not injective:
 * `a-b@example.test` and `a.b@example.test` both flatten to
 * `EMAIL_A_B_EXAMPLE_TEST`, and two accounts sharing one vault entry means
 * adding the second overwrites the first's password, and removing either
 * deletes the other's. So the name carries eight hex digits of
 * sha256(normalised address): still readable at a glance
 * (`EMAIL_AMEN_EXAMPLE_COM_3f2a9c41`), and distinct for distinct mailboxes.
 * The database backs this up with a unique constraint on `secret_name`, and
 * the settings page refuses a name another row already owns *before* it writes
 * anything to the vault.
 */
export function secretNameFor(address: string): string {
  const normalised = address.trim().toLowerCase();
  const sanitised = normalised.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (sanitised === '') throw new Error(`no secret name can be derived from ${JSON.stringify(address)}`);
  const digest = createHash('sha256').update(normalised, 'utf8').digest('hex').slice(0, 8);
  return `${ACCOUNT_SECRET_PREFIX}${sanitised}_${digest}`;
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
  pool: Db,
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
  pool: Db,
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
  pool: Db,
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

/** Write down that a poll of this account finished. The one writer of the column. */
export async function markAccountSynced(pool: Db, accountId: string, at: Date): Promise<void> {
  await pool.query(`update email.accounts set last_synced_at = $2 where id = $1`, [accountId, at]);
}

/**
 * When each account last *finished* a poll, keyed by account id.
 *
 * Stamped by the source at the end of a pass that did not fail
 * (`sources/inbox-poll.ts`), so it answers "how current is what we hold"
 * rather than "when did mail last arrive" — `lastSyncByAccount` below answers
 * the second, and the settings page wants that one. `null` for an account that
 * has never completed a poll, which is not the same as one that synced and
 * found nothing.
 */
export async function lastSyncedByAccount(pool: Db): Promise<Map<string, Date | null>> {
  const { rows } = await pool.query(`select id, last_synced_at from email.accounts`);
  const out = new Map<string, Date | null>();
  for (const row of rows) {
    const value = (row as { last_synced_at: unknown }).last_synced_at;
    out.set(
      String((row as { id: unknown }).id),
      value instanceof Date ? value : value === null || value === undefined ? null : new Date(String(value)),
    );
  }
  return out;
}

/**
 * When mail last *landed* for each account, keyed by account id.
 *
 * Derived rather than stamped: the newest `fetched_at` among the account's
 * messages. Null means nothing has ever arrived — which is what the settings
 * page wants to show, and which is exactly why it cannot answer "how current
 * is this mailbox": a quiet mailbox polled a minute ago reads the same as one
 * nothing has polled since Tuesday. `lastSyncedByAccount` above is that one.
 */
export async function lastSyncByAccount(pool: Db): Promise<Map<string, string | null>> {
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
