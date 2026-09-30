/**
 * Owner secrets at the composition root (docs/owner-secrets.md §7,
 * docs/plugin-host-api.md §4.2, §6).
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
import {
  adoptVaultEntry,
  deleteOwnerSecret,
  findSecret,
  ownerSecretVaultName,
  putOwnerSecret,
  registerSecretDestination,
  useOwnerSecret,
  type BuddiHost,
  type AdoptOutcome,
  type SecretDestination,
  type Vault,
} from '@buddi/core';
import { ACCOUNT_KIND, GMAIL_SECRET_NAME, listAccounts } from '@buddi/tool-email';
import type { EnvTarget, SecretsPort } from '@buddi/tool-mcp';
import type { Pool } from 'pg';

/** The shape of a page-added mailbox's old vault name (`secretNameFor`). Not `EMAIL_BACKFILL`. */
const MAILBOX_SECRET_RE = /^EMAIL_[A-Z0-9_]+_[0-9a-f]{8}$/;

/**
 * The provider accounts' destination (docs/owner-secrets.md §3, §7):
 * `<plugin>.account` shape under the gateway's own `accounts` name. The target
 * is the account row's id, and the destination checks it against the live
 * table — a removed account's binding delivers nothing. Pre-approved, because
 * the owner typed the credential on this account's own page.
 */
export const ACCOUNTS_PROVIDER_KIND = 'accounts.provider';

export function accountsProviderDestination(
  accountExists: (id: string) => Promise<boolean>,
  /** Sync, from the service's own loaded rows: `describe` has no async in the contract. */
  describe: (id: string) => string,
): SecretDestination {
  return {
    kind: ACCOUNTS_PROVIDER_KIND,
    maxRule: 'pre-approved',
    async checkTarget(target) {
      return typeof target === 'string' && (await accountExists(target));
    },
    describe(target) {
      return typeof target === 'string' ? describe(target) : 'a provider account';
    },
    deliver() {
      // The gateway's own modules take the value through `deliverInto` (the
      // same core-internal path the `http` area uses); this runs only on a
      // defect, and a defect delivers nowhere.
      throw new Error('accounts.provider delivers through the gateway itself, never through a destination');
    },
  };
}

/**
 * The vault the OAuth adapters see, with the account credentials' names
 * translated onto the owner secrets they were adopted into (owner-secrets §7).
 *
 * An adapter keeps asking for `PROVIDER_ACCOUNT_…` by name; the value it
 * reaches is the owner secret of that name, stored under `owner-secret:<id>`.
 * A name with no owner secret passes through untouched, so a not-yet-adopted
 * entry and buddi's own keys answer exactly as before. Writes go the same way:
 * a token refresh lands under the same `owner-secret:<id>`, the rows untouched.
 */
export function ownerSecretVault(vault: Vault, pool: Pick<Pool, 'query'>): Vault {
  const secretIdFor = async (name: string): Promise<string | null> => {
    const secret = await findSecret(pool, name);
    return secret?.id ?? null;
  };
  return {
    kind: vault.kind,
    async get(name) {
      const id = await secretIdFor(name);
      return id === null ? vault.get(name) : vault.get(ownerSecretVaultName(id));
    },
    async set(name, value) {
      const id = await secretIdFor(name);
      if (id === null) await vault.set(name, value);
      else await vault.set(ownerSecretVaultName(id), value);
    },
    async delete(name) {
      const id = await secretIdFor(name);
      return id === null ? vault.delete(name) : vault.delete(ownerSecretVaultName(id));
    },
    list: () => vault.list(),
  };
}

/**
 * Delete a provider account's credential wherever it lives today: the owner
 * secret whole (rows and value) when one was adopted or saved, the raw vault
 * entry when not. A vault that cannot delete fails closed — the caller refuses
 * the removal rather than leaving a live credential behind.
 */
export async function deleteAccountSecret(
  pool: Pick<Pool, 'query'>,
  vault: Vault | undefined,
  secretRef: string | undefined,
): Promise<void> {
  if (vault === undefined || secretRef === undefined) return;
  const secret = await findSecret(pool, secretRef).catch(() => null);
  if (secret === null) {
    await vault.delete(secretRef);
    return;
  }
  await deleteOwnerSecret(pool, vault, secretRef).catch(() => false);
  // `deleteOwnerSecret` swallows a refused delete; the read-back is what makes
  // the failure a failure.
  if ((await vault.get(ownerSecretVaultName(secret.id))) !== null) {
    throw new Error(`the credential of "${secretRef}" could not be removed from the vault`);
  }
}

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
 *  - `OPENAI_API_KEY`: provider
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

export interface ProviderAccountAdoption {
  /** Account id → what happened to its credential. Never a value. */
  outcomes: Record<string, AdoptOutcome | 'failed' | 'skipped'>;
  /** One line per failure, naming the account and never the value. */
  problems: string[];
}

/**
 * Move every provider account's credential into an owner secret bound to its
 * account row (owner-secrets §7, "Migrating what plugins hold today").
 *
 * The account row's `secretRef` stays the *name*; the value moves from the raw
 * vault entry to `owner-secret:<id>`, and the old entry is deleted only once
 * the new one reads back. Idempotent, run once at start. Legacy accounts — the
 * ones that read a named environment variable — keep that variable: buddi's
 * own keys are not bindable (§6) and their rows carry `legacyEnv`.
 */
export async function adoptProviderAccountSecrets(
  pool: Pool,
  vault: Vault | undefined,
): Promise<ProviderAccountAdoption> {
  const result: ProviderAccountAdoption = { outcomes: {}, problems: [] };
  if (vault === undefined) {
    result.problems.push('this installation has no vault, so provider account credentials cannot become owner secrets');
    return result;
  }
  const { rows } = await pool.query(
    `select id, label, secret_ref as "secretRef", legacy_env as "legacyEnv"
       from core.provider_accounts where secret_ref is not null`,
  );
  for (const row of rows as Array<{ id: string; label: string; secretRef: string; legacyEnv: string | null }>) {
    if (row.legacyEnv !== null) {
      result.outcomes[row.id] = 'skipped';
      continue;
    }
    try {
      result.outcomes[row.id] = await adoptVaultEntry(pool, vault, {
        from: row.secretRef,
        name: row.secretRef,
        bindings: [{ kind: ACCOUNTS_PROVIDER_KIND, target: row.id, rule: 'pre-approved' }],
      });
    } catch (err) {
      result.outcomes[row.id] = 'failed';
      result.problems.push(
        `${row.label}: its credential stays where it was (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  return result;
}

/**
 * A connection's pasted token (docs/connections.md, "Connect"), as an owner
 * secret bound to core's `http.header` destination for that connection's host
 * and header, pre-approved: the owner pasted it on that connection's own
 * screen. A read is one recorded use through `useOwnerSecret`, answered only
 * for the bound host and header — the same core-internal delivery the `http`
 * area uses — so Settings → Secrets lists it, its last use and its binding.
 */
/**
 * A program's secret variable (docs/connections.md, "A program on this
 * computer"): `mcp.env`, under the connections plugin's own name. The target
 * is the connection and the variable's name; the value goes into the
 * program's environment when it starts, and nowhere else. Core never calls
 * `deliver`: the connections service asks through `useOwnerSecret` with its
 * own delivery, like `http.header`.
 */
export const MCP_ENV_KIND = 'mcp.env';

function asEnvTarget(target: unknown): EnvTarget | undefined {
  if (typeof target !== 'object' || target === null) return undefined;
  const { connection, variable } = target as Record<string, unknown>;
  return typeof connection === 'string' && typeof variable === 'string' ? { connection, variable } : undefined;
}

export function registerMcpEnvDestination(): void {
  registerSecretDestination('mcp', {
    kind: MCP_ENV_KIND,
    maxRule: 'pre-approved',
    checkTarget(target, bound) {
      const asked = asEnvTarget(target);
      const kept = asEnvTarget(bound);
      return asked !== undefined && kept !== undefined && asked.connection === kept.connection && asked.variable === kept.variable;
    },
    describe(target) {
      const asked = asEnvTarget(target);
      return asked === undefined ? 'a connected program\'s environment' : `the ${asked.variable} variable of a program on this computer`;
    },
    deliver() {
      throw new Error('mcp.env delivers through the connections service itself, never through a destination');
    },
  });
}

export function connectionSecrets(pool: Pool, vault: Vault | undefined): SecretsPort | undefined {
  if (vault === undefined) return undefined;
  const host = { version: '0.0', plugin: 'http' } as unknown as BuddiHost;
  const mcpHost = { version: '0.0', plugin: 'mcp' } as unknown as BuddiHost;
  registerMcpEnvDestination();
  return {
    async putEnv(name, value, target) {
      await putOwnerSecret(pool, vault, {
        name,
        value,
        bindings: [{ kind: MCP_ENV_KIND, target: { connection: target.connection, variable: target.variable }, rule: 'pre-approved' }],
      });
    },
    async envValue(name, target) {
      let value: string | undefined;
      const result = await useOwnerSecret(
        { pool, vault, plugin: 'mcp', buddi: mcpHost, now: () => new Date(), deliverInto: (delivered) => { value = delivered; } },
        { name, kind: MCP_ENV_KIND, target: { connection: target.connection, variable: target.variable } },
      );
      if ('done' in result && value !== undefined) return value;
      if ('pending' in result) throw new Error(`"${name}" waits for the owner's approval.`);
      throw new Error('refused' in result ? result.refused : `"${name}" was not delivered.`);
    },
    async put(name, value, target) {
      await putOwnerSecret(pool, vault, {
        name,
        value,
        bindings: [{ kind: 'http.header', target: { host: target.host.toLowerCase(), header: target.header }, rule: 'pre-approved' }],
      });
    },
    async value(name, target) {
      let value: string | undefined;
      const result = await useOwnerSecret(
        {
          pool,
          vault,
          plugin: 'http',
          buddi: host,
          now: () => new Date(),
          deliverInto: (delivered) => {
            value = delivered;
          },
        },
        { name, kind: 'http.header', target: { host: target.host.toLowerCase(), header: target.header } },
      );
      if ('done' in result && value !== undefined) return value;
      if ('pending' in result) throw new Error(`"${name}" waits for the owner's approval.`);
      throw new Error('refused' in result ? result.refused : `"${name}" was not delivered.`);
    },
    async remove(name) {
      await deleteOwnerSecret(pool, vault, name);
    },
  };
}
