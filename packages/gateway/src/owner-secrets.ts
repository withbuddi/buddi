/**
 * Owner secrets at the composition root (docs/specs/owner-secrets.md §7,
 * docs/specs/plugin-host-api.md §6, §9 step 3).
 *
 * Two jobs at start, both once:
 *
 *  - **Adopt what the email plugin kept.** Each mailbox's password lived in
 *    the vault under the account row's `secret_name` (`EMAIL_<address>_<hash>`,
 *    or `GMAIL_APP_PASSWORD` for the account `.env` names) and was copied into
 *    `process.env` for the plugin to read. Each becomes an owner secret of the
 *    same name, bound to `email.account` with the account's id as its target,
 *    pre-approved. Idempotent; an old entry is deleted only after the new one
 *    reads back.
 *  - **Clear what nothing reads any more** from `process.env`: the mailbox
 *    passwords. What else can go, and what cannot yet, is said on
 *    `mailboxSecretNames`.
 */
import { adoptVaultEntry, type AdoptOutcome, type Vault } from '@buddi/core';
import { ACCOUNT_KIND, GMAIL_SECRET_NAME, listAccounts } from '@buddi/tool-email';
import type { Pool } from 'pg';

/** The shape of a page-added mailbox's old vault name (`secretNameFor`). Not `EMAIL_BACKFILL`. */
const MAILBOX_SECRET_RE = /^EMAIL_[A-Z0-9_]+_[0-9a-f]{8}$/;

export interface MailboxAdoption {
  /** Account address → what happened to its password. Never a value. */
  outcomes: Record<string, AdoptOutcome | 'failed'>;
  /** One line per failure, naming the account and never the value. */
  problems: string[];
}

/** Move every mailbox password into an owner secret bound to its login. */
export async function adoptMailboxSecrets(
  pool: Pool,
  vault: Vault | undefined,
  env: NodeJS.ProcessEnv,
): Promise<MailboxAdoption> {
  const result: MailboxAdoption = { outcomes: {}, problems: [] };
  if (vault === undefined) {
    result.problems.push('this installation has no vault, so mailbox passwords cannot become owner secrets');
    return result;
  }
  for (const account of await listAccounts(pool, { enabledOnly: false })) {
    if (account.authMode !== 'app-password') continue;
    try {
      result.outcomes[account.address] = await adoptVaultEntry(pool, vault, {
        from: account.secretName,
        name: account.secretName,
        bindings: [{ kind: ACCOUNT_KIND, target: account.id, rule: 'pre-approved' }],
        // The account `.env` names may still have its password there, the
        // day-1 path. Adopted the same way; `.env` is the owner's file.
        fallback: account.secretName === GMAIL_SECRET_NAME ? env[GMAIL_SECRET_NAME] : undefined,
      });
    } catch (err) {
      result.outcomes[account.address] = 'failed';
      result.problems.push(
        `${account.address}: its password stays where it was (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return result;
}

/**
 * What the gateway removes from `process.env` once it has started, and why the
 * rest stays for now (host API §6; the whole list is step 4's).
 *
 * Cleared: the mailbox passwords — the email plugin asks `ctx.buddi.secrets`
 * and nothing reads them from the environment any more.
 *
 * Not yet, because something in this process still reads them after boot:
 *  - `DATABASE_URL`: the dashboard's backups (`web/backups.ts`, pg_dump and
 *    the archive's database name) and Telegram's notify fallback pool.
 *  - `BUDDI_VAULT_KEY`: every `createVault({ env: process.env })` made per
 *    request — provider settings and accounts, Telegram setup, the web token,
 *    recovery, backups. The file vault reads the key on each open.
 *  - `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`: provider
 *    resolution per agent (`providerFor`) and model-account reloads.
 *  - `TELEGRAM_BOT_TOKEN`: every `notifyOwner`, and Telegram started from the
 *    dashboard.
 *  - `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY`: the web plugin, per search.
 *  - `BUDDI_DB_PASSWORD`: assembled into `DATABASE_URL`, cleared with it.
 */
export function mailboxSecretNames(env: NodeJS.ProcessEnv, accountSecretNames: readonly string[]): string[] {
  const names = new Set<string>([GMAIL_SECRET_NAME, ...accountSecretNames]);
  for (const name of Object.keys(env)) if (MAILBOX_SECRET_RE.test(name)) names.add(name);
  return [...names].sort();
}

/** Delete these names from the environment. Returns the ones that were there. */
export function clearFromEnvironment(env: NodeJS.ProcessEnv, names: readonly string[]): string[] {
  const cleared: string[] = [];
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      delete env[name];
      cleared.push(name);
    }
  }
  return cleared;
}
