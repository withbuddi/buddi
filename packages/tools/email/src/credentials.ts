/**
 * A mailbox's password, through the owner's secrets
 * (docs/owner-secrets.md §3, §4, "Plugin account credentials").
 *
 * Each mailbox's password is an owner secret — named by the account row's
 * `secret_name`, as it always was — bound to this plugin's `email.account`
 * destination with the account's id as its target, pre-approved because the
 * owner typed it on this plugin's own page. This plugin never opens the
 * vault: it asks `ctx.buddi.secrets.use`, core checks the binding and calls
 * `deliver` below, and the connection the password is for takes it from
 * there. That is the stated exception to "never held": an IMAP or SMTP login
 * keeps its password for as long as the connection lives. Nothing here puts
 * a password in `process.env`, and nothing keeps one past the call it was
 * delivered for.
 */
import type { BuddiHost, SecretDestination } from '@buddi/core/plugin';
import { resolveAuth, type EnvLike } from './config.js';
import type { AccountRecord, EmailAuth, Resolved } from './ports.js';

/** The destination kind a mailbox password is bound to. */
export const ACCOUNT_KIND = 'email.account';

/**
 * Values delivered and not yet taken, by use id. `deliver` puts one here and
 * the call that asked for it takes it out at once: a use id is answered to
 * exactly one caller, so two polls of the same mailbox never take each
 * other's.
 */
const handed = new Map<string, string>();

/** `email.account`: the login of one of the owner's mailboxes, by account id. */
export const accountDestination: SecretDestination = {
  kind: ACCOUNT_KIND,
  maxRule: 'pre-approved',
  async checkTarget(target, bound, buddi) {
    if (typeof target !== 'string' || target !== bound) return false;
    // The account must still be here: a binding to a removed mailbox binds nothing.
    const { rows } = await buddi.db.query(`select 1 from email.accounts where id::text = $1`, [target]);
    return rows.length > 0;
  },
  describe: (target) => `the login of mailbox ${String(target)}`,
  deliver(value, _target, { use }) {
    handed.set(use, value);
  },
};

/**
 * The credentials for one account's connection.
 *
 * `env`, when a caller injects one (the tests, a one-shot script), answers as
 * it always did; the installed plugin injects none and asks the owner's
 * secrets. A use the owner has to approve, or one refused, is a typed
 * `secret-missing` problem, as a missing password always was: an unattended
 * poll fails closed and says why.
 */
export async function mailboxAuth(
  ctx: { buddi?: BuddiHost | undefined },
  account: AccountRecord,
  env?: EnvLike,
): Promise<Resolved<EmailAuth>> {
  if (env !== undefined || account.authMode === 'xoauth2') return resolveAuth(account, env ?? {});
  const secrets = ctx.buddi?.secrets;
  if (secrets === undefined) {
    return { ok: false, problem: { code: 'secret-missing', message: `no owner secrets in this process for ${account.address}` } };
  }
  const outcome = await secrets.use(account.secretName, ACCOUNT_KIND, account.id);
  if ('done' in outcome) {
    const pass = handed.get(outcome.use);
    handed.delete(outcome.use);
    if (pass === undefined || pass.trim() === '') {
      return { ok: false, problem: { code: 'secret-missing', message: `no password was delivered for ${account.address}` } };
    }
    return { ok: true, value: { mode: 'app-password', user: account.address, pass: pass.trim() } };
  }
  const why = 'pending' in outcome
    ? `the password for ${account.address} waits on the owner's approval (${outcome.pending})`
    : `${account.address}: ${outcome.refused}`;
  return { ok: false, problem: { code: 'secret-missing', message: why } };
}
