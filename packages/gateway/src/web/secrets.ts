/**
 * The dashboard's Keys and secrets routes (docs/owner-secrets.md §6).
 *
 * The reads are core's own page queries (`secrets.list`, `secrets.uses`); the
 * writes are the ownerOnly tools of the same manifest — `secrets.put`,
 * `secrets.rename`, `secrets.rebind`, `secrets.delete`,
 * `secrets.scrub_history` — invoked as the owner through the registry, the same
 * atomic path the plugin pages' act route uses and the same guarantee: no model
 * ever sees a tool that takes a value, and a decision made here is the same
 * write any surface would make. The value the owner typed crosses exactly one
 * boundary — this route's body — into the tool that stores it.
 */
import type { Pool } from 'pg';
import { OWNER_AGENT_ID, SECRETS_QUERIES, type ToolRegistry, type CoreToolContext } from '@buddi/core';
import { listAccounts } from '@buddi/tool-email';
import type { LoginKeeper, LoginStore, LoginStoreNames } from '@buddi/tool-browser';
import { LEGACY_PASSWORD_VAR } from '../owner-secrets.js';
import { mailProvider } from './recovery.js';

export interface SecretsDeps {
  pool: Pool;
  registry: ToolRegistry;
  ctx: Omit<CoreToolContext, 'db'>;
  now?: () => Date;
  /** The browser host's login keeper: the labels of logins buddi kept from the owner's own sign-ins. */
  logins?: Pick<LoginKeeper, 'saved' | 'forget' | 'rename'>;
}

export interface RouteReply {
  status: number;
  body: unknown;
}

const reply = (status: number, body: unknown): RouteReply => ({ status, body });

/** Writes from one session: the act route's own budget, reused here. */
const lastWrite = new Map<string, number>();
function writeRateLimited(session: string, at: number): boolean {
  const last = lastWrite.get(session) ?? 0;
  if (at - last < 1_000) return true;
  lastWrite.set(session, at);
  if (lastWrite.size > 5_000) {
    for (const [key, when] of lastWrite) if (at - when > 60_000) lastWrite.delete(key);
  }
  return false;
}

/** One write: the tool by name, invoked as the owner, the answer the tool's own. */
async function invoke(deps: SecretsDeps, tool: string, args: unknown, session: string): Promise<RouteReply> {
  const now = deps.now ?? (() => new Date());
  if (writeRateLimited(session, now().getTime())) {
    return reply(429, { error: 'Too many writes from this page. Wait a moment and try again.' });
  }
  // As the owner: an ownerOnly tool does not exist for any other caller, by design.
  const result = await deps.registry.invoke(tool, args ?? {}, { ...deps.ctx, agentId: OWNER_AGENT_ID, db: deps.pool, now } as CoreToolContext);
  if (result.ok) return reply(200, { result: result.output });
  if (result.reason === 'invalid-args') return reply(400, { error: result.message });
  if (result.reason === 'unknown-tool') return reply(404, { error: result.message });
  return reply(400, { error: result.message });
}

const SETTINGS_TOOLS = new Set(['secrets.put', 'secrets.rename', 'secrets.rebind', 'secrets.delete', 'secrets.scrub_history']);

/**
 * What holds a secret by name: the thing whose row says "my credential is the
 * owner secret called this". The page names a secret by it (a mailbox's
 * address, a model account's label, a connection's name) instead of the
 * generated name, and a secret nothing holds any more is "not used by
 * anything" — a suggestion to remove it, never a removal.
 */
export type SecretUser =
  /** `loginFailedAt`: the mail server turned the password down at that time (the Email page's own record), until a login works again. */
  | { kind: 'mailbox'; id: string; address: string; provider: string; auth: 'app-password' | 'xoauth2'; loginFailedAt: string | null }
  | { kind: 'model-account'; id: string; label: string; auth: string }
  | { kind: 'connection'; id: string; name: string; variable: string | null };

/** The kinds whose target names the thing that holds the secret: the binding is alive only while that thing still points back. */
const HELD_KINDS = new Set(['email.account', 'accounts.provider', 'mcp.env']);

/** A table or schema that is not installed: a confirmed absence, not a failed lookup. */
function notInstalled(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === '42P01' || code === '3F000';
}

/**
 * Every row that names an owner secret as its credential, by secret name, and
 * whether every lookup answered. A table that is not installed holds nothing;
 * any other failure — a timeout, a lost connection — leaves `complete` false,
 * because "nothing found" is then not an answer (`isUnused`).
 */
export async function readSecretUsers(pool: Pick<Pool, 'query'>): Promise<{ users: Map<string, SecretUser[]>; complete: boolean }> {
  const users = new Map<string, SecretUser[]>();
  let complete = true;
  const failed = (err: unknown): void => {
    if (!notInstalled(err)) complete = false;
  };
  const add = (name: string | null | undefined, user: SecretUser): void => {
    if (!name) return;
    users.set(name, [...(users.get(name) ?? []), user]);
  };
  try {
    for (const account of await listAccounts(pool as Pool, { enabledOnly: false })) {
      const user: SecretUser = { kind: 'mailbox', id: account.id, address: account.address, provider: mailProvider(account.imapHost), auth: account.authMode, loginFailedAt: account.loginFailedAt ?? null };
      add(account.secretName, user);
      // A mailbox the old `.env` named still falls back to `GMAIL_APP_PASSWORD`
      // until its own password is set (`adoptEnvMailbox`, `missingMailboxes`).
      if (account.addedVia === 'env' && account.secretName !== LEGACY_PASSWORD_VAR) add(LEGACY_PASSWORD_VAR, user);
    }
  } catch (err) {
    // No email schema: no mailboxes here.
    failed(err);
  }
  try {
    const { rows } = await pool.query<{ id: string; label: string; auth: string; secret_ref: string | null }>(
      `select id, label, auth, secret_ref from core.provider_accounts where not deleting`,
    );
    for (const row of rows) add(row.secret_ref, { kind: 'model-account', id: row.id, label: row.label, auth: row.auth });
  } catch (err) {
    // An installation that predates model accounts.
    failed(err);
  }
  try {
    const { rows } = await pool.query<{ id: string; name: string; vault_ref: string | null; env: unknown }>(
      `select id::text as id, name, vault_ref, env from mcp.connections`,
    );
    for (const row of rows) {
      add(row.vault_ref, { kind: 'connection', id: row.id, name: row.name, variable: null });
      if (!Array.isArray(row.env)) continue;
      for (const entry of row.env as Array<Record<string, unknown>>) {
        if (typeof entry.secretRef === 'string') {
          add(entry.secretRef, { kind: 'connection', id: row.id, name: row.name, variable: typeof entry.name === 'string' ? entry.name : null });
        }
      }
    }
  } catch (err) {
    // No connections table: nothing connected here.
    failed(err);
  }
  return { users, complete };
}

/** `readSecretUsers`, the users alone. */
export async function secretUsers(pool: Pick<Pool, 'query'>): Promise<Map<string, SecretUser[]>> {
  return (await readSecretUsers(pool)).users;
}

interface ListedSecret {
  name: string;
  bindings: Array<{ kind: string; target: unknown }>;
}

/**
 * Whether nothing can reach a secret any more: it has bindings, and every one
 * of them is dead — a held kind whose mailbox, account or connection no longer
 * names this secret, or a kind no installed plugin registers. A secret with no
 * binding at all is unused only when it was never the owner's own: a name a
 * mailbox, an account or a connection generated, or the old `.env` mailbox
 * password. An owner's fresh secret with no binding is "not usable yet", a
 * different sentence the page says itself.
 *
 * `complete` false — a lookup of what holds secrets failed — means nobody
 * knows: never unused then, only confirmed absence counts.
 */
export function isUnused(secret: ListedSecret, users: readonly SecretUser[], registered: ReadonlySet<string>, complete = true): boolean {
  if (users.length > 0) return false;
  if (!complete) return false;
  if (secret.bindings.length === 0) return GENERATED_NAME.test(secret.name) || secret.name === LEGACY_PASSWORD_VAR;
  return secret.bindings.every((binding) => HELD_KINDS.has(binding.kind) || !registered.has(binding.kind));
}

/** The names buddi itself generates for a credential it keeps for a row. */
const GENERATED_NAME = /^(PROVIDER_ACCOUNT_|CODEX_ACCOUNT_|ANTHROPIC_ACCOUNT_|OLLAMA_DEVICE_|MCP_TOKEN_|MCP_ENV_|MCP_CONNECTION_|EMAIL_[A-Z0-9_]+_[0-9a-f]{8}$)/;

/** `GET /api/secrets` — the page's one read: secrets, destinations, buddi's own keys, and what holds each secret. */
export async function listSecrets(deps: SecretsDeps): Promise<RouteReply> {
  const result = (await SECRETS_QUERIES[0]!.produce({}, { ...deps.ctx, db: deps.pool, now: deps.now ?? (() => new Date()) } as CoreToolContext)) as {
    secrets: ListedSecret[];
    destinations: Array<{ kind: string }>;
  };
  const { users, complete } = await readSecretUsers(deps.pool);
  const registered = new Set(result.destinations.map((d) => d.kind));
  // A login buddi kept from the owner's own sign-in: its site, the user name and when (labels, never the password).
  const logins = new Map((deps.logins?.saved() ?? []).map((login) => [login.name, { site: login.site, username: login.username, savedAt: login.savedAt }] as const));
  return reply(200, {
    ...result,
    secrets: result.secrets.map((secret) => {
      const usedBy = users.get(secret.name) ?? [];
      // `usageUnknown`: it would read as unused, but a lookup failed — the page
      // says it couldn't check instead of offering Remove.
      const usageUnknown = !complete && isUnused(secret, usedBy, registered, true);
      const login = logins.get(secret.name);
      return { ...secret, usedBy, unused: isUnused(secret, usedBy, registered, complete), ...(usageUnknown ? { usageUnknown } : {}), ...(login ? { login } : {}) };
    }),
  });
}

/** `GET /api/secrets/uses` — the use log, whole or one secret's. */
export async function secretUses(deps: SecretsDeps, url: URL): Promise<RouteReply> {
  const name = url.searchParams.get('name') ?? undefined;
  const limit = Number(url.searchParams.get('limit') ?? 100);
  const uses = SECRETS_QUERIES[1]!;
  return reply(200, await uses.produce({ ...(name !== undefined ? { name } : {}), limit }, { ...deps.ctx, db: deps.pool, now: deps.now ?? (() => new Date()) } as CoreToolContext));
}

/** `POST /api/secrets` — one owner write, `{ tool, args }`. */
export async function secretsAct(
  deps: SecretsDeps,
  body: unknown,
  session: { id: string },
): Promise<RouteReply> {
  if (typeof body !== 'object' || body === null) return reply(400, { error: 'Send `{ tool, args }`.' });
  const { tool, args } = body as { tool?: unknown; args?: unknown };
  if (typeof tool !== 'string' || !SETTINGS_TOOLS.has(tool)) {
    return reply(404, { error: 'That is not a write the Keys and secrets page makes.' });
  }
  const answer = await invoke(deps, tool, args, session.id);
  // A kept login removed here: its label goes with it. Renamed: its label follows the new name.
  const { name, to } = (args ?? {}) as { name?: unknown; to?: unknown };
  if (answer.status === 200 && typeof name === 'string') {
    if (tool === 'secrets.delete') await deps.logins?.forget(name).catch(() => false);
    else if (tool === 'secrets.rename' && typeof to === 'string') await deps.logins?.rename(name, to).catch(() => false);
  }
  return answer;
}

/**
 * The owner-secret store the browser host's login keeper hands a saved sign-in
 * to (docs/browser.md, "Saving a sign-in"): core's own `secrets.put`, invoked
 * as the owner exactly as the Keys and secrets page invokes it, so the value
 * goes to the vault, the scrubber is rebuilt for it before anything else is
 * written, and the save-time look runs. No model sees this call, no event
 * records its arguments, and a refusal says only that it was refused — the
 * tool's own words are not passed on, because they are not this caller's to
 * vouch for.
 */
export function ownerLoginStore(deps: SecretsDeps): LoginStore {
  return async ({ name, value, bindings }) => {
    const now = deps.now ?? (() => new Date());
    const result = await deps.registry.invoke('secrets.put', { name, value, bindings }, { ...deps.ctx, agentId: OWNER_AGENT_ID, db: deps.pool, now } as CoreToolContext);
    if (!result.ok) throw new Error('buddi could not keep that login.');
  };
}

/** The names the owner-secret store holds now, names only: what a new login's name must not take. */
export function ownerLoginNames(deps: SecretsDeps): LoginStoreNames {
  return async () => {
    const listed = (await SECRETS_QUERIES[0]!.produce({}, { ...deps.ctx, db: deps.pool, now: deps.now ?? (() => new Date()) } as CoreToolContext)) as { secrets: Array<{ name: string }> };
    return listed.secrets.map((secret) => secret.name);
  };
}

