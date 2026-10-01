/**
 * Recovery mode, from the dashboard's side.
 *
 * A restored installation wakes up with its loops off (see `serve.ts`) and one
 * question outstanding: what of all this still applies? The checklist is that
 * question, in four parts, and every part is read from what is actually there
 * rather than from what the archive claimed:
 *
 *  - **secrets.** No backup contains a secret value, by design. So every
 *    provider account, the Telegram token and anything the restored `.env`
 *    marked as living in the vault is looked up the way the runtime reads it
 *    on *this* machine — owner secret first, raw vault entry, then the
 *    environment — and only what buddi truly cannot read is listed, with a
 *    link to where it is fixed. Mailbox passwords and connection sign-ins
 *    (OAuth tokens, pasted tokens, a program's secret variables) are checked
 *    the same way, by the names the email plugin and the connections service
 *    read them under. A name in the vault's list proves nothing: an
 *    adopted credential is kept under `owner-secret:<id>`, not its name.
 *  - **plugins.** `plugins.json` came back in the archive; what is installed
 *    here is what this build runs plus what the live plugins record holds (a
 *    plugin approved since the last start, which loads at the next one). The
 *    difference is the list.
 *  - **pending work.** Counts the restore took at the moment it loaded, so the
 *    number stays true even after the owner has dropped the rows.
 *  - **grants.** Standing tool permissions, one row each, keep or drop.
 *
 * Leaving is the last step, and it is deliberately not a live switch: the
 * loops are decided once, at startup, so leaving asks the supervisor to
 * restart the gateway. See the note in `serve.ts`.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createVault,
  describeSource,
  envValue,
  leaveRecovery,
  listPendingPluginData,
  listToolPermissions,
  pluginsFilePath,
  readPluginsFile,
  readRecovery,
  revokeToolPermission,
  type PendingPluginData,
  type ToolPermission,
  type Vault,
} from '@buddi/core';
import type { Pool } from 'pg';
import { listAccounts, type AccountRecord } from '@buddi/tool-email';
import { agentSearchPath, installedManifests } from '../agents/catalog.js';
import { readOllamaDevice } from '../ollama-accounts.js';
import { LEGACY_PASSWORD_VAR, LEGACY_USER_VAR, ownerSecretVault } from '../owner-secrets.js';

export interface RecoverySecret {
  /** The name the credential is kept under. Shown small, for the curious; never a value. */
  name: string;
  kind: 'account' | 'telegram' | 'plugin' | 'email' | 'connection';
  /**
   * What it is, in words: "Gemini — API key", "Telegram — bot token",
   * "Gmail — app password for you@example.com", "GitHub — sign-in",
   * "Trokky — TROKKY_TOKEN".
   */
  label: string;
  /** The model account this is the credential of, so the page can open that account. */
  accountId?: string;
  /** The mailbox (`email.accounts.id`) whose password this is. */
  mailboxId?: string;
  /** The connection (`mcp.connections.id`) this credential belongs to. */
  connectionId?: string;
  /** An OAuth sign-in: the fix is signing in again, not pasting a key. */
  signIn?: true;
  settingsRoute: string;
}

export interface RecoveryPlugin {
  name: string;
  version: string;
  source: string;
  installed: boolean;
  /**
   * Installed since the restart that loaded this gateway — in the plugins
   * record (what `buddi plugins list` reads) but not running yet. Shown as
   * "installed — loads at the next restart", never "install again".
   */
  loadsAtRestart?: true;
  /** `<npm name>@<version>` when it came from a registry: what Settings → Plugins can stage again. */
  install?: string;
  /**
   * Data the restore kept for this plugin, loaded when it is installed. `note`
   * is the sentence the page shows: "1,544 rows waiting, loaded when you
   * install it", or why an installed plugin's data is still waiting.
   */
  waiting?: { rows: number; note: string };
}

/** A table whose kept data was not loaded because the table already had rows. */
export interface RecoveryKeptTable {
  schema: string;
  table: string;
  rows: number;
  /** In plain words, for the page. */
  sentence: string;
}

export interface RecoveryGrant {
  id: string;
  agent: string;
  tool: string;
  scope: string;
  description: string;
}

export interface RecoveryView {
  active: boolean;
  restoredAt: string | null;
  archive: string | null;
  checklist: {
    secrets: RecoverySecret[];
    plugins: RecoveryPlugin[];
    /** Kept tables left staged because the installed table already had rows. */
    keptTables: RecoveryKeptTable[];
    pending: { jobs: number; missions: number; approvals: number; telegramChats: number };
    grants: RecoveryGrant[];
  };
}

export interface RecoveryDeps {
  pool: Pool;
  env: NodeJS.ProcessEnv;
  /** Injected in tests; this machine's own vault otherwise. */
  vault?: Vault | undefined;
  /** Where leaving recovery says what it dropped. Optional; defaults to stderr. */
  log?: ((line: string) => void) | undefined;
}

const ACCOUNTS_ROUTE = '#/settings/accounts';
const TELEGRAM_ROUTE = '#/settings/telegram';
const SECRETS_ROUTE = '#/settings/secrets';
const EMAIL_ROUTE = '#/settings/p.email.settings';
const CONNECTIONS_ROUTE = '#/settings/connections';

/**
 * Settings → Email with one mailbox's Set password open: the page's row form
 * opens itself on the row whose id is `account` (`openWhen` in its descriptor).
 */
function mailboxPasswordRoute(id: string): string {
  return `${EMAIL_ROUTE}?account=${encodeURIComponent(id)}&set=password`;
}

/** Settings → Connections with one connection's sheet open. */
function connectionRoute(id: string): string {
  return `${CONNECTIONS_ROUTE}?connection=${encodeURIComponent(id)}`;
}

/** Names that are a model credential wherever they turn up. */
const MODEL_SECRETS = new Set(['OPENAI_API_KEY']);

/**
 * Names a restored `.env` may mark that the owner never pastes on a page: the
 * database's own credentials and the vault's key. A gateway that is serving
 * this page is already using them, so listing them would only ever be wrong.
 */
const RUNNING_PROVES = new Set(['DATABASE_URL', 'BUDDI_DB_PASSWORD', 'BUDDI_VAULT_KEY']);

/**
 * Names a restored `.env` may mark that the runtime no longer reads by name:
 * the old `.env` mailbox, adopted into a Settings → Email account whose
 * password the mailbox check below looks for under its own name.
 */
const READ_ELSEWHERE = new Set([LEGACY_USER_VAR, LEGACY_PASSWORD_VAR]);

/** What the known names are, in words. Anything else is shown by its name. */
const SECRET_WORDS: Record<string, string> = {
  OPENAI_API_KEY: 'OpenAI — API key',
  TELEGRAM_BOT_TOKEN: 'Telegram — bot token',
  TAVILY_API_KEY: 'Tavily — search key',
  BRAVE_SEARCH_API_KEY: 'Brave Search — search key',
};

const AUTH_WORDS: Record<string, string> = {
  'api-key': 'API key',
  chatgpt: 'ChatGPT sign-in',
  'anthropic-oauth': 'Claude sign-in',
  'device-key': 'Ollama device key',
};

function openVault(deps: RecoveryDeps): Vault | undefined {
  if (deps.vault) return deps.vault;
  try {
    return createVault({ env: deps.env });
  } catch {
    return undefined;
  }
}

/**
 * Whether buddi can read a credential by this name the way the runtime does:
 * the owner secret of that name when one exists (`owner-secret:<id>` in the
 * vault, which is where every adopted account key and plugin secret lives
 * now), else the raw vault entry. Only ever a yes or no; the value never
 * leaves this function. A locked or failing vault is "no", the safe direction.
 */
async function readable(vault: Vault | undefined, pool: Pool, name: string): Promise<string | null> {
  if (!vault || name === '') return null;
  try {
    const value = await ownerSecretVault(vault, pool).get(name);
    return value !== null && value.trim() !== '' ? value : null;
  } catch {
    return null;
  }
}

interface AccountRow {
  id: string;
  kind: string;
  auth: string;
  label: string;
  secret_ref: string | null;
  legacy_env: string | null;
}

/**
 * Mirrors `ProviderAccountService#secret` and its "configured" rule: the
 * credential through the owner-secret-aware vault, then a migrated account's
 * own named environment variable; an Ollama device counts once connected.
 */
async function accountHasCredential(vault: Vault | undefined, deps: RecoveryDeps, row: AccountRow): Promise<boolean> {
  const raw = row.secret_ref ? await readable(vault, deps.pool, row.secret_ref) : null;
  const value = raw ?? (row.legacy_env ? envValue(deps.env, row.legacy_env) ?? null : null);
  if (value === null) return false;
  if (row.auth !== 'device-key') return true;
  try {
    return readOllamaDevice(value).connectedAt !== null;
  } catch {
    return false;
  }
}

/**
 * Names the restored `.env` says live in the vault.
 *
 * `scrubEnv` writes `NAME="<vault>"` for every secret it removed, so the file
 * that came back is a list of what the old machine had without being a list of
 * what it was.
 */
export function vaultMarkersIn(envText: string): string[] {
  const names: string[] = [];
  for (const line of envText.split(/\r?\n/)) {
    const found = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['"]?<vault>['"]?\s*$/.exec(line);
    if (found) names.push(found[1] as string);
  }
  return names;
}

/** The provider a mailbox's IMAP host belongs to, the way the Mail settings page would name it. */
const MAIL_PROVIDERS: Array<[RegExp, string]> = [
  [/(^|\.)gmail\.com$|(^|\.)googlemail\.com$/, 'Gmail'],
  [/(^|\.)office365\.com$|(^|\.)outlook\.com$/, 'Outlook'],
  [/(^|\.)yahoo\.com$/, 'Yahoo Mail'],
  [/(^|\.)me\.com$|(^|\.)icloud\.com$/, 'iCloud Mail'],
  [/(^|\.)fastmail\.com$/, 'Fastmail'],
];

export function mailProvider(imapHost: string): string {
  const host = imapHost.trim().toLowerCase();
  return MAIL_PROVIDERS.find(([pattern]) => pattern.test(host))?.[1] ?? 'Email';
}

/**
 * Every enabled mailbox whose password buddi cannot read here.
 *
 * Mirrors `mailboxAuth`: the password is the owner secret named by the row's
 * `secret_name` (a raw vault entry of that name counts too: the start adopts
 * it). A mailbox the old `.env` named that was never adopted reads the way
 * `adoptEnvMailbox` will at the next start — its own name, then
 * `GMAIL_APP_PASSWORD` as an owner secret, a vault entry or in the
 * environment — and is added again on the Email page when none answers.
 */
async function missingMailboxes(vault: Vault | undefined, deps: RecoveryDeps): Promise<RecoverySecret[]> {
  let accounts: AccountRecord[];
  try {
    accounts = await listAccounts(deps.pool);
  } catch {
    return []; // No email schema: no mailboxes here.
  }
  const out: RecoverySecret[] = [];
  for (const account of accounts) {
    if (account.authMode !== 'app-password') continue;
    if ((await readable(vault, deps.pool, account.secretName)) !== null) continue;
    const label = `${mailProvider(account.imapHost)} — app password for ${account.address}`;
    if (account.addedVia === 'env') {
      if ((await readable(vault, deps.pool, LEGACY_PASSWORD_VAR)) !== null) continue;
      if (envValue(deps.env, LEGACY_PASSWORD_VAR) !== undefined) continue;
    }
    // Set password on the Email page, which tests the login before it keeps
    // anything and leaves the mailbox's mail where it is.
    out.push({ name: account.secretName, kind: 'email', label, mailboxId: account.id, settingsRoute: mailboxPasswordRoute(account.id) });
  }
  return out;
}

interface ConnectionRowLite {
  id: string;
  name: string;
  transport: string;
  auth_kind: string;
  vault_ref: string | null;
  state: string;
  env: unknown;
}

/**
 * Every connection credential buddi cannot read here, the way the
 * connections service reads it: an OAuth sign-in is the vault entry the row's
 * `vault_ref` names (`MCP_CONNECTION_<id>`), a pasted token the owner secret
 * it names (`MCP_TOKEN_<id>`), and a program's secret variable the owner
 * secret its `secretRef` names (`MCP_ENV_<id>_<VAR>`). A connection that never
 * finished signing in is not listed: there was nothing to bring back.
 */
async function missingConnections(vault: Vault | undefined, deps: RecoveryDeps): Promise<RecoverySecret[]> {
  let rows: ConnectionRowLite[];
  try {
    ({ rows } = await deps.pool.query<ConnectionRowLite>(
      `select id::text as id, name, transport, auth_kind, vault_ref, state, env from mcp.connections order by created_at`,
    ));
  } catch {
    return []; // No connections table: nothing connected here.
  }
  const out: RecoverySecret[] = [];
  for (const row of rows) {
    const route = connectionRoute(row.id);
    if (row.auth_kind !== 'none' && row.vault_ref && (await readable(vault, deps.pool, row.vault_ref)) === null) {
      out.push({
        name: row.vault_ref,
        kind: 'connection',
        label: `${row.name} — sign-in`,
        connectionId: row.id,
        ...(row.auth_kind === 'oauth' ? { signIn: true as const } : {}),
        settingsRoute: route,
      });
    }
    if (row.transport !== 'stdio' || !Array.isArray(row.env)) continue;
    for (const entry of row.env as Array<Record<string, unknown>>) {
      const ref = entry.secretRef;
      if (typeof ref !== 'string' || ref === '') continue;
      if ((await readable(vault, deps.pool, ref)) !== null) continue;
      out.push({ name: ref, kind: 'connection', label: `${row.name} — ${String(entry.name)}`, connectionId: row.id, settingsRoute: route });
    }
  }
  return out;
}

async function missingSecrets(deps: RecoveryDeps): Promise<RecoverySecret[]> {
  const vault = openVault(deps);
  const out: RecoverySecret[] = [];
  const listed = (name: string): boolean => name !== '' && out.some((s) => s.name === name);

  // Every account the runtime could not get a credential for.
  let rows: AccountRow[] = [];
  try {
    ({ rows } = await deps.pool.query<AccountRow>(
      `select id, kind, auth, label, secret_ref, legacy_env from core.provider_accounts
        where enabled and not deleting and auth <> 'none' order by created_at, id`,
    ));
  } catch {
    // No accounts table is an installation that predates them, not an error.
  }
  for (const row of rows) {
    if (await accountHasCredential(vault, deps, row)) continue;
    const name = row.secret_ref ?? row.legacy_env ?? '';
    if (listed(name)) continue;
    out.push({
      name,
      kind: 'account',
      label: `${row.label} — ${AUTH_WORDS[row.auth] ?? row.auth}`,
      accountId: row.id,
      settingsRoute: `${ACCOUNTS_ROUTE}?account=${encodeURIComponent(row.id)}`,
    });
  }

  /*
   * Anything else by name: the environment the gateway started with (a real
   * value, not the `<vault>` marker), then the owner secret or vault entry of
   * that name — where the dashboard saves the bot token and where every plugin
   * key lives since the host API.
   */
  const add = async (name: string, kind: RecoverySecret['kind'], settingsRoute: string): Promise<void> => {
    if (listed(name) || RUNNING_PROVES.has(name) || READ_ELSEWHERE.has(name)) return;
    if (envValue(deps.env, name) !== undefined) return;
    if ((await readable(vault, deps.pool, name)) !== null) return;
    out.push({ name, kind, label: SECRET_WORDS[name] ?? name, settingsRoute });
  };

  // A bot that was paired on the old machine but has no token on this one.
  try {
    const { rows: paired } = await deps.pool.query<{ n: string }>(
      `select count(*)::text as n from core.surface_identities where surface = 'telegram'`,
    );
    if (Number(paired[0]?.n ?? '0') > 0) await add('TELEGRAM_BOT_TOKEN', 'telegram', TELEGRAM_ROUTE);
  } catch {
    /* same */
  }

  // Everything else the restored `.env` said was in the vault.
  const envFile = deps.env.BUDDI_ENV_FILE;
  if (envFile && existsSync(envFile)) {
    const text = await readFile(envFile, 'utf8').catch(() => '');
    for (const name of vaultMarkersIn(text)) {
      if (name === 'TELEGRAM_BOT_TOKEN') await add(name, 'telegram', TELEGRAM_ROUTE);
      else if (MODEL_SECRETS.has(name)) await add(name, 'account', ACCOUNTS_ROUTE);
      else await add(name, 'plugin', SECRETS_ROUTE);
    }
  }

  for (const item of [...(await missingMailboxes(vault, deps)), ...(await missingConnections(vault, deps))]) {
    if (!listed(item.name)) out.push(item);
  }
  return out;
}

/**
 * What the archive said was installed, against what is installed here.
 *
 * The restore writes the archive's own `plugins.json` to
 * `<dataDir>/restored-plugins.json` rather than over the live record, so this
 * is the one place that can say "the backup had this and this machine does
 * not". The live record is only a fallback: on an installation restored by an
 * older engine there is no such file, and the record beside the agents is the
 * closest thing to what came back.
 */
function pluginsFromArchive(env: NodeJS.ProcessEnv, pending: readonly PendingPluginData[] = []): RecoveryPlugin[] {
  const search = agentSearchPath(env);
  const running = new Set(installedManifests(env).map((m) => m.name));
  const data = env.BUDDI_DATA_DIR?.trim();
  const restored = data ? path.join(data, 'restored-plugins.json') : undefined;
  const live = pluginsFilePath({ ownerRoot: search.ownerRoot, env });
  const fromArchive = restored !== undefined && existsSync(restored);
  const from = fromArchive ? restored : live;
  /*
   * The live record, read on every call, is what `buddi plugins approve` and
   * the dashboard's install write: a plugin there that is not running was
   * installed since this gateway started. Only when the archive's list is its
   * own file — without it the live record *is* the archive's list, and every
   * plugin in it would read as installed.
   */
  const recorded = new Set<string>();
  if (fromArchive) {
    try {
      for (const p of readPluginsFile(live).plugins) if (p.placing !== true) recorded.add(p.name);
    } catch {
      /* an unreadable record proves nothing is installed; the running set still counts */
    }
  }
  let listed: RecoveryPlugin[] = [];
  const schemaOf = new Map<string, string>();
  try {
    const file = readPluginsFile(from);
    listed = file.plugins.map((p) => {
      schemaOf.set(p.name, p.schema ?? p.name);
      return {
        name: p.name,
        version: p.version,
        source: describeSource(p.source),
        installed: running.has(p.name) || recorded.has(p.name),
        ...(!running.has(p.name) && recorded.has(p.name) ? { loadsAtRestart: true as const } : {}),
        ...(p.source.kind === 'registry' ? { install: `${p.source.name}@${p.source.version}` } : {}),
      };
    });
  } catch {
    listed = [];
  }
  // Only what is still waiting to load; tables kept because they had rows are
  // their own items.
  const waitingRows = (entry: PendingPluginData): number =>
    entry.tables.filter((t) => t.kept === null).reduce((sum, t) => sum + t.rows, 0);
  const claimed = new Set<string>();
  for (const plugin of listed) {
    const entry = pending.find((p) => p.schema === schemaOf.get(plugin.name));
    if (entry === undefined) continue;
    claimed.add(entry.schema);
    const rows = waitingRows(entry);
    if (!entry.tables.some((t) => t.kept === null)) continue;
    plugin.waiting = { rows, note: waitingNote(rows, plugin.installed, entry.reason) };
  }
  // Data for a schema the archive's plugin list does not name still deserves
  // a line: it is the owner's, and it is waiting.
  for (const entry of pending) {
    if (claimed.has(entry.schema)) continue;
    const rows = waitingRows(entry);
    if (!entry.tables.some((t) => t.kept === null)) continue;
    listed.push({
      name: entry.schema,
      version: '',
      source: `kept from ${entry.archive}`,
      installed: false,
      waiting: { rows, note: waitingNote(rows, false, entry.reason) },
    });
  }
  return listed;
}

/** "1,544 rows waiting, loaded when you install it" — or why it is still waiting. */
export function waitingNote(rows: number, installed: boolean, reason: string | null): string {
  const count = `${rows.toLocaleString('en-US')} row${rows === 1 ? '' : 's'} waiting`;
  if (!installed || reason === null) return `${count}, loaded when you install it`;
  return `${count}: ${reason}`;
}

function keptTablesOf(pending: readonly PendingPluginData[]): RecoveryKeptTable[] {
  return pending.flatMap((entry) =>
    entry.tables
      .filter((t) => t.kept !== null)
      .map((t) => ({
        schema: entry.schema,
        table: t.table,
        rows: t.rows,
        sentence:
          `${t.table} already had rows here, so the backup's ${t.rows.toLocaleString('en-US')} ` +
          `were kept aside at ${entry.stagedPath} instead of loaded over them.`,
      })),
  );
}

function grantView(permission: ToolPermission): RecoveryGrant {
  const scope = permission.conversationId === '' ? 'every conversation' : 'one conversation';
  return {
    id: permission.id,
    agent: permission.agentId,
    tool: permission.tool,
    scope,
    description: `${permission.agentId} may use ${permission.tool} in ${scope}, granted ${permission.createdAt.slice(0, 10)}`,
  };
}

/** The whole checklist. Cheap enough to be a plain GET the page can poll. */
export async function readRecoveryView(deps: RecoveryDeps, ownerId: string): Promise<RecoveryView> {
  const state = await readRecovery(deps.pool);
  if (!state || !state.active) {
    return {
      active: false,
      restoredAt: state ? state.restoredAt.toISOString() : null,
      archive: state ? state.archive : null,
      checklist: { secrets: [], plugins: [], keptTables: [], pending: { jobs: 0, missions: 0, approvals: 0, telegramChats: 0 }, grants: [] },
    };
  }
  const grants = await listToolPermissions(deps.pool, ownerId).catch(() => [] as ToolPermission[]);
  const pendingData = await listPendingPluginData(deps.pool);
  return {
    active: true,
    restoredAt: state.restoredAt.toISOString(),
    archive: state.archive,
    checklist: {
      secrets: await missingSecrets(deps),
      plugins: pluginsFromArchive(deps.env, pendingData),
      keptTables: keptTablesOf(pendingData),
      pending: {
        jobs: state.pending.jobs,
        missions: state.pending.missions,
        approvals: state.pending.approvals,
        telegramChats: state.pending.telegramChats,
      },
      grants: grants.map(grantView),
    },
  };
}

export interface LeaveInput {
  dropPending: boolean;
  /**
   * The grants to keep. `undefined` is not "keep none": it is a caller that
   * said nothing about grants, and nothing said is never a reason to revoke
   * every standing permission the owner has.
   */
  keepGrants: string[] | undefined;
}

export interface LeaveResult {
  left: boolean;
  droppedJobs: number;
  droppedApprovals: number;
  droppedGrants: number;
}

/**
 * Leave recovery: drop what the owner did not keep, then clear the row.
 *
 * `dropPending` defaults to true at the route, because the common case is an
 * owner restoring last week's backup today: the queued work is for a world
 * that has already happened, and running it would be the surprise.
 *
 * Nothing is dropped unless there is an open recovery row. The page can be
 * left open, reloaded or posted twice, and this is destructive in one
 * direction only: without the guard a second POST would cancel the jobs and
 * revoke the grants of an installation that finished recovering days ago.
 */
export async function leaveRecoveryMode(
  deps: RecoveryDeps,
  ownerId: string,
  input: LeaveInput,
  now: Date,
): Promise<LeaveResult> {
  const state = await readRecovery(deps.pool);
  if (!state || !state.active) {
    return { left: false, droppedJobs: 0, droppedApprovals: 0, droppedGrants: 0 };
  }
  const log = deps.log ?? ((line: string) => console.error(line));
  let droppedJobs = 0;
  let droppedApprovals = 0;
  if (input.dropPending) {
    const jobs = await deps.pool.query(
      `update core.jobs set state = 'cancelled', updated_at = $1
        where state in ('pending', 'leased', 'suspended')`,
      [now],
    );
    droppedJobs = jobs.rowCount ?? 0;
    const approvals = await deps.pool.query(
      `update core.approvals set state = 'expired' where state = 'pending'`,
    );
    droppedApprovals = approvals.rowCount ?? 0;
  }
  let droppedGrants = 0;
  const dropped: string[] = [];
  if (input.keepGrants !== undefined) {
    const keep = new Set(input.keepGrants);
    const grants = await listToolPermissions(deps.pool, ownerId).catch(() => [] as ToolPermission[]);
    for (const grant of grants) {
      if (keep.has(grant.id)) continue;
      if (await revokeToolPermission(deps.pool, ownerId, grant.id)) {
        droppedGrants += 1;
        dropped.push(`${grant.agentId}:${grant.tool}`);
      }
    }
  }
  const left = await leaveRecovery(deps.pool, now);
  log(
    `recovery: left recovery — ${droppedJobs} job(s) cancelled, ${droppedApprovals} approval(s) expired, ` +
      `${droppedGrants} grant(s) revoked${dropped.length > 0 ? ` (${dropped.join(', ')})` : ''}`,
  );
  return { left, droppedJobs, droppedApprovals, droppedGrants };
}

/** Where an uploaded archive lands; named here so the routes agree. */
export function incomingDirFor(env: NodeJS.ProcessEnv): string | undefined {
  const data = env.BUDDI_DATA_DIR?.trim();
  return data ? path.join(data, 'incoming') : undefined;
}
