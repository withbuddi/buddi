/**
 * Owner secrets at the composition root (docs/owner-secrets.md §7,
 * docs/plugin-host-api.md §4.2, §6).
 *
 * Three jobs at start, all once:
 *
 *  - **Adopt the mailbox `.env` used to name** (`GMAIL_USER`, its password
 *    `GMAIL_APP_PASSWORD`) as a Settings → Email account — `adoptEnvMailbox`.
 *    After that buddi reads no mailbox from the environment.
 *  - **Adopt what the email plugin kept.** Each mailbox's password lived in
 *    the vault under the account row's `secret_name` (`EMAIL_<address>_<hash>`)
 *    and was copied into `process.env` for the plugin to read. Each becomes an
 *    owner secret of the same name, bound to `email.account` with the
 *    account's id as its target, pre-approved. Idempotent; an old entry is
 *    deleted only after the new one reads back.
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
  renameOwnerSecret,
  VAULT_PLACEHOLDER,
  useOwnerSecret,
  type BuddiHost,
  type AdoptOutcome,
  type SecretDestination,
  type Vault,
} from '@buddi/core';
import { ACCOUNT_KIND, listAccounts, secretNameFor, writeGmailAccount } from '@buddi/tool-email';
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

/** The two `.env` lines that used to name a mailbox. Read once, by `adoptEnvMailbox`, and never again. */
export const LEGACY_USER_VAR = 'GMAIL_USER';
export const LEGACY_PASSWORD_VAR = 'GMAIL_APP_PASSWORD';

/**
 * The `email.settings` key that records the adoption ran to an end. With it
 * there, `.env` is not read for a mailbox again — not even to re-create one
 * the owner later removed in Settings while the old lines were still there.
 */
export const ENV_MAILBOX_ADOPTED_KEY = 'env_mailbox_adopted';

export type EnvMailboxAdoption =
  /** Adopted, or found nothing to adopt, on an earlier start: `.env` is not read. */
  | { outcome: 'done' }
  /** `GMAIL_USER` is not set: nothing to adopt, and nothing will be. */
  | { outcome: 'none' }
  /** Adopted on this start: the account exists and its password moved. */
  | { outcome: 'adopted'; address: string; accountId: string }
  /** A Settings → Email account of that address already exists; nothing touched. */
  | { outcome: 'exists'; address: string }
  /** No readable password (or no vault to keep one in): nothing created. */
  | { outcome: 'no-password'; address: string; reason: string };

/** A value that is really there: not empty, not the `"<vault>"` marker `import-env` leaves. */
function realValue(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const unquoted = trimmed.replace(/^(["'])(.*)\1$/, '$2');
  if (trimmed === '' || unquoted === VAULT_PLACEHOLDER) return null;
  return trimmed;
}

/**
 * Adopt the mailbox `.env` names as a Settings → Email account, once, at start
 * (the pattern of `adoptProviderAccountSecrets`).
 *
 * Buddi used to seed an account from `GMAIL_USER` on every boot, its password
 * named `GMAIL_APP_PASSWORD` (in `.env`, in the vault, or — since owner
 * secrets — an owner secret of that name bound to the account). Now only
 * accounts added in Settings exist, so this turns that mailbox into one:
 *
 *  - The password is looked for where it may be: an owner secret already under
 *    the account's own name (a start that stopped half way), the owner secret
 *    `GMAIL_APP_PASSWORD`, the raw vault entry of that name, then `.env`.
 *    None readable: nothing is created, and the caller says to add it in
 *    Settings → Email.
 *  - **Continuity.** Everything the mailbox has — folders and their UID
 *    cursors, messages, threads, triage, drafts, rules — is keyed by the
 *    account row's id, and the old seed's row is converted in place
 *    (`writeGmailAccount`), so the id does not change and nothing is re-read,
 *    re-triaged or dropped. There is nothing to re-key.
 *  - The password moves to where a page-added account keeps it: the owner
 *    secret `secretNameFor(address)`, bound to `email.account` with the row's
 *    id, pre-approved. An owner secret `GMAIL_APP_PASSWORD` is *renamed* (same
 *    id, same vault entry, its history kept); otherwise the value is written
 *    under the new name and read back before the row changes hands, and the
 *    raw vault entry goes last. `.env` is the owner's file and is not touched.
 *
 * Once: a run that adopts, finds the address already added in Settings, or
 * finds no `GMAIL_USER` at all records that in `email.settings`
 * (`ENV_MAILBOX_ADOPTED_KEY`), and every later start answers `done` without
 * reading `.env`. Only a missing password leaves it to try again next start.
 */
export async function adoptEnvMailbox(
  pool: Pool,
  vault: Vault | undefined,
  env: NodeJS.ProcessEnv,
): Promise<EnvMailboxAdoption> {
  let marked: unknown[];
  try {
    ({ rows: marked } = await pool.query(`select 1 from email.settings where key = $1`, [ENV_MAILBOX_ADOPTED_KEY]));
  } catch (err) {
    // No email schema: the mail plugin is not installed here, so there is no
    // mailbox to adopt into.
    if ((err as { code?: string }).code === '42P01' || (err as { code?: string }).code === '3F000') return { outcome: 'none' };
    throw err;
  }
  if (marked.length > 0) return { outcome: 'done' };
  const finished = async (result: EnvMailboxAdoption): Promise<EnvMailboxAdoption> => {
    const address = 'address' in result ? result.address : null;
    await pool.query(
      `insert into email.settings (key, value, updated_at) values ($1, $2::jsonb, now())
       on conflict (key) do nothing`,
      [ENV_MAILBOX_ADOPTED_KEY, JSON.stringify({ outcome: result.outcome, address })],
    );
    return result;
  };

  const address = env[LEGACY_USER_VAR]?.trim().toLowerCase();
  if (!address) return finished({ outcome: 'none' });

  const { rows } = await pool.query<{ id: string; added_via: string }>(
    `select id::text as id, added_via from email.accounts where address = $1`,
    [address],
  );
  const row = rows[0];
  if (row !== undefined && row.added_via !== 'env') return finished({ outcome: 'exists', address });

  const name = secretNameFor(address);
  if (vault === undefined) {
    return { outcome: 'no-password', address, reason: 'this installation has no vault to keep its password in' };
  }
  const ownerValue = async (secretName: string): Promise<{ id: string; value: string } | null> => {
    const secret = await findSecret(pool, secretName);
    if (secret === null) return null;
    const value = realValue(await vault.get(ownerSecretVaultName(secret.id)).catch(() => null));
    return value === null ? null : { id: secret.id, value };
  };
  const resumed = await ownerValue(name);
  const legacyOwner = resumed === null ? await ownerValue(LEGACY_PASSWORD_VAR) : null;
  const rawVault = resumed === null && legacyOwner === null
    ? realValue(await vault.get(LEGACY_PASSWORD_VAR).catch(() => null))
    : null;
  const value = resumed?.value ?? legacyOwner?.value ?? rawVault ?? realValue(env[LEGACY_PASSWORD_VAR]);
  if (value === null) {
    return { outcome: 'no-password', address, reason: `${LEGACY_PASSWORD_VAR} is not readable` };
  }

  // The row first when there is none, because the binding names its id; a
  // password that cannot be kept takes a new row back out.
  const inserted = row === undefined;
  const accountId = row?.id ?? (await writeGmailAccount(pool, address)).id;
  try {
    if (legacyOwner !== null) await renameOwnerSecret(pool, LEGACY_PASSWORD_VAR, name);
    const kept = await putOwnerSecret(pool, vault, {
      name,
      value,
      bindings: [{ kind: ACCOUNT_KIND, target: accountId, rule: 'pre-approved' }],
    });
    if ((await vault.get(ownerSecretVaultName(kept.id))) !== value) {
      throw new Error(`the owner secret "${name}" did not read back`);
    }
  } catch (err) {
    if (inserted) await pool.query(`delete from email.accounts where id = $1::uuid`, [accountId]).catch(() => {});
    throw err;
  }
  // The row changes hands only now, with its password already where it looks.
  await writeGmailAccount(pool, address);
  if (rawVault !== null) await vault.delete(LEGACY_PASSWORD_VAR).catch(() => false);
  return finished({ outcome: 'adopted', address, accountId });
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
): Promise<MailboxAdoption> {
  const result: MailboxAdoption = { outcomes: {}, problems: [] };
  if (vault === undefined) {
    result.problems.push('this installation has no vault, so mailbox passwords cannot become owner secrets');
    return result;
  }
  for (const account of await listAccounts(pool, { enabledOnly: false })) {
    if (account.authMode !== 'app-password') continue;
    // A row the old `.env` seed left and `adoptEnvMailbox` could not adopt:
    // its password is not readable, and the page is where it comes back.
    if (account.addedVia === 'env') continue;
    try {
      result.outcomes[account.address] = await adoptVaultEntry(pool, vault, {
        from: account.secretName,
        name: account.secretName,
        bindings: [{ kind: ACCOUNT_KIND, target: account.id, rule: 'pre-approved' }],
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
  // `GMAIL_APP_PASSWORD` too: nothing reads it after `adoptEnvMailbox`.
  const names = new Set<string>([LEGACY_PASSWORD_VAR, ...accountSecretNames]);
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
