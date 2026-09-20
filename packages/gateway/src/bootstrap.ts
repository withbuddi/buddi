/**
 * Shared process wiring for the gateway's long-running entry points.
 *
 * `buddi serve`, `buddi-telegram` and `buddi missions` all need the same four
 * things — a pool, a tool registry, the agent catalog and a resolved provider —
 * built the same way and exactly once. Resolution fails closed with a typed
 * problem: a process that cannot reach a credential never starts and never
 * guesses one.
 */
import path from 'node:path';
import { systemContext } from './system-context.js';
import {
  DATABASE_URL_VAR,
  KNOWN_SECRETS,
  createPool,
  createVault,
  hydrateDatabaseUrl,
  resolveDatabaseUrl,
  resolveProvider,
  resolveSecrets,
  timezoneFromEnv,
  vaultSelection,
  type DatabaseUrlResolution,
  type AgentCatalog,
  type CatalogAgent,
  type SecretProblem,
  type SecretSource,
  type ToolContext,
  type ToolRegistry,
  type Vault,
} from '@buddi/core';
import { createProvider, type RuntimeProvider } from '@buddi/runtime';
import { ProviderSettings } from './providers.js';
import { ProviderAccounts } from './provider-accounts.js';
import { config as loadDotenv } from 'dotenv';
import type { Pool } from 'pg';
import {
  adoptProcessCatalog,
  createToolRegistry,
  loadGatewayCatalog,
  reloadableCatalog,
  REPO_ROOT,
  type ReloadableAgentCatalog,
} from './agents/catalog.js';
import { bindDelegation } from './agents/delegation.js';
import { bindOwnerTools } from './agents/owner-tools.js';
import { bindPlatformTools } from './agents/platform.js';
import { describeDatabaseError, probeDatabase } from './db-ready.js';
import { loadPluginsOnce } from './plugins/load.js';
import { sweepStages } from './plugins/stage.js';

export { REPO_ROOT };

export const OWNER_ID = 'owner';

/** Load `.env` from the repo root. Idempotent; never overrides a real env var. */
export function loadEnv(): void {
  loadDotenv({ path: process.env.BUDDI_ENV_FILE ?? path.join(REPO_ROOT, '.env') });
}

/**
 * `.env`, and then the one variable that is no longer *in* it.
 *
 * `DATABASE_URL` used to be a plain line in `.env` with the password in clear;
 * now it is assembled from the vault, which is a keychain call and therefore
 * async. Every entry point that reads `process.env.DATABASE_URL` before it
 * builds its wiring waits on this instead of on `loadEnv` alone.
 */
export async function loadEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DatabaseUrlResolution> {
  loadEnv();
  // And what the owner installed. Every entry point already waits on this call
  // before it touches `DATABASE_URL`, and it must equally wait on it before it
  // builds a tool registry or loads the agent catalog: an agent granted an
  // installed plugin's tools does not load at all if those tools are not
  // registered. `buddi agents` found that out the hard way.
  await loadPluginsOnce(env);
  return hydrateDatabaseUrl(env);
}

/**
 * The secrets this installation keeps in the vault.
 *
 * Everything downstream still reads a *named environment variable* — the
 * provider port, the Telegram client, the email plugin's app password — so the
 * vault's whole job at the composition root is to fill those names in before
 * anything is built. That keeps "no ambient credentials" true: a component is
 * handed its credential by name, and never goes looking for one.
 */
export const WIRED_SECRETS: readonly string[] = KNOWN_SECRETS.filter(
  // `DATABASE_URL` is in `KNOWN_SECRETS` so `import-env` moves it and the
  // backup scrubber blanks it, but it is not hydrated by name: it is
  // *assembled* below from whichever of its four sources answers first.
  (name) => name !== DATABASE_URL_VAR,
);

export interface SecretHydration {
  /** Which vault this machine uses: 'keychain', 'file', 'memory' or 'none'. */
  vault: string;
  /** Where each secret came from. Names and sources only — never a value. */
  sources: Record<string, SecretSource>;
  /** Secrets neither the vault nor the environment could supply. */
  problems: Record<string, SecretProblem>;
  /** Where this boot's `DATABASE_URL` came from. Never the URL itself. */
  database: { source: DatabaseUrlResolution['source']; legacyPassword: boolean };
}

/**
 * Fill the process environment from the vault, once, at startup.
 *
 * Vault first, `.env` second (the documented day-1 fallback), and a secret the
 * owner moved into the keychain wins over a stale copy left behind in `.env`.
 * A secret that resolves nowhere is left absent: the component that needs it
 * fails closed with its own typed problem, which is a better message than
 * anything this function could invent.
 *
 * Initial hydration happens here. Owner provider management may subsequently
 * refresh only provider credentials/defaults and reload the shared catalog;
 * existing runtime adapters keep their already-resolved credential snapshot.
 */
export async function hydrateSecrets(
  env: NodeJS.ProcessEnv = process.env,
  vault: Vault | undefined = createVault({ env }),
): Promise<SecretHydration> {
  const resolved = await resolveSecrets(WIRED_SECRETS, { vault, env });
  for (const name of WIRED_SECRETS) {
    const value = resolved.env[name];
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  // The connection string is assembled last, from the environment the loop
  // above just finished filling in: an explicit `DATABASE_URL` still wins, and
  // otherwise the password the vault holds is wrapped around this
  // installation's own host, port and database name.
  const database = await resolveDatabaseUrl({ env, vault });
  env[DATABASE_URL_VAR] = database.url;
  if (database.problem) resolved.problems[DATABASE_URL_VAR] = database.problem;
  return {
    database: { source: database.source, legacyPassword: database.legacyPassword },
    // The vault that actually answered, not the one the environment selects —
    // they differ only when a caller injected one (a test, the doctor).
    vault: vault?.kind ?? vaultSelection({ env }),
    sources: resolved.sources,
    problems: resolved.problems,
  };
}

export interface Wiring {
  pool: Pool;
  registry: ToolRegistry;
  /**
   * Every agent installed as a file under `agents/`.
   *
   * A façade, not a snapshot: `reloadCatalog()` rebuilds what is behind it, and
   * every surface holding this object sees the new agent on its next turn.
   */
  catalog: ReloadableAgentCatalog;
  /**
   * Re-read the agent files and swap them in, in this process, now. Throws with
   * the previous catalog still serving when the tree on disk will not load.
   */
  reloadCatalog(): void;
  reloadProviders(): void;
  providerSettings?: ProviderSettings;
  providerAccounts?: ProviderAccounts;
  useProviderAccounts(accounts: ProviderAccounts): void;
  provider: RuntimeProvider;
  /**
   * The adapter for one agent, built from that agent's own pinned provider.
   *
   * Provider choice is per agent, so "the process's provider" is only ever the
   * default agent's. Every path that runs a *named* agent asks for its own —
   * and gets a typed error, never another vendor's endpoint, when the agent's
   * credential is not on this machine.
   */
  providerFor(agent: CatalogAgent): RuntimeProvider;
  /** What `resolveProvider` settled on — printed in startup logs. */
  model: string;
  credentialKind: string;
  /** Which provider the default agent runs on. */
  providerKind: string;
  now: () => Date;
  /** The owner's timezone (`BUDDI_TZ`), the one the scheduler already uses. */
  timezone: string;
  ctx: ToolContext;
  /** Where secrets came from this boot. Absent when nothing hydrated them. */
  secrets?: SecretHydration;
}

/**
 * The wiring, with the vault consulted first.
 *
 * Prefer this over `createWiring` in every long-running entry point: it is the
 * one call that lets a credential live in the OS keychain instead of `.env`.
 * `createWiring` stays synchronous and unchanged for callers that already have
 * their environment resolved.
 */
export async function createWiringAsync(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Wiring> {
  const secrets = await hydrateSecrets(env);
  // What the owner installed, before anything that builds a registry. Importing
  // a plugin's entry point is asynchronous and building the registry is not, so
  // this is the one await that has to happen first; everything after it reads
  // the adopted result. A plugin that fails to load is reported by
  // `buddi plugins list`, never thrown here — see `plugins/load.ts`.
  const plugins = await loadPluginsOnce(env);
  // Stages nobody decided on are unapproved third-party code sitting in the
  // data directory. A day is long enough to come back to an approval screen.
  try {
    const swept = sweepStages(env);
    if (swept.length > 0) console.error(`swept ${swept.length} abandoned plugin stage(s)`);
  } catch {
    // Housekeeping never stops a start.
  }
  for (const problem of plugins.problems) {
    console.error(
      `plugin ${problem.name} is installed but did not load: ${problem.message} ` +
        '(buddi plugins list)',
    );
  }
  // The database comes before everything else it is under: with Docker stopped,
  // a provider or catalog error is a distraction and the pg failure that
  // follows is an empty `AggregateError`. One probe, one sentence.
  await probeDatabase(env.DATABASE_URL);
  const wiring = createWiring(env, { allowMissingDefault: true });
  const providerSettings = new ProviderSettings({ pool: wiring.pool, env, reload: wiring.reloadProviders });
  const providerAccounts = new ProviderAccounts({ pool: wiring.pool, env, catalog: () => wiring.catalog, reload: wiring.reloadProviders });
  try {
    await providerSettings.load();
    // Initialization captures the old choice once, before switching resolution.
    await providerAccounts.initialize();
    wiring.useProviderAccounts(providerAccounts);
  }
  catch (error) { await wiring.pool.end(); throw error; }
  const selected = wiring.catalog.defaultAgent();
  return { ...wiring, secrets, providerSettings, providerAccounts, model: selected.model,
    providerKind: selected.provider.kind, credentialKind: selected.provider.credential.kind };
}

/**
 * Build the shared wiring or throw. The caller owns `pool` and must end it.
 */
export function createWiring(env: NodeJS.ProcessEnv = process.env, options: { allowMissingDefault?: boolean } = {}): Wiring {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set (cp .env.example .env, then pnpm db:up)');
  }

  const registry = createToolRegistry(env);
  // One catalog per process, behind a façade every surface can keep holding:
  // `platform.create_agent` swaps what is behind it and the new agent is
  // reachable from the CLI, Telegram, the web chat and the mission runner on
  // their next turn, with no restart. `adoptProcessCatalog` makes sure the
  // runner's own `gatewayCatalog()` is this same object and not a second one.
  let accounts: ProviderAccounts | undefined;
  const catalog = reloadableCatalog(() => loadGatewayCatalog({ env, registry, providerSelection: accounts?.selection }));
  adoptProcessCatalog(env, catalog);

  const now = (): Date => new Date();
  const timezone = timezoneFromEnv(env);
  const resolution = resolveProvider(catalog.defaultAgent().provider, env);
  if (!resolution.ok && !options.allowMissingDefault) {
    throw new Error(
      `provider not usable [${resolution.problem.code}]: ${resolution.problem.message}` +
        '\nSet CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY in .env',
    );
  }

  /**
   * One adapter per agent, memoised per provider ref. Fails closed and names
   * the agent: "@scout needs OPENAI_API_KEY" is an answer the owner can act on,
   * where "provider not usable" at startup would have taken down four agents
   * that were perfectly fine.
   */
  const adapters = new Map<string, RuntimeProvider>();
  /**
   * Every attempt that failed, with its whole cause chain, on the process log.
   *
   * This is the line that did not exist. A provider call that failed and then
   * succeeded left no trace at all, and one that failed for good left the word
   * `fetch failed` — undici's wrapper, with the actual `ERR_HTTP2_INVALID_SESSION`
   * one link down on `cause`, unread. A day of failures taught us nothing
   * because of this one missing log line.
   */
  const onRetry = (notice: { attempt: number; delayMs: number; kind: string; detail: string }): void => {
    console.error(
      `provider: ${notice.kind} attempt ${notice.attempt} failed, retrying in ${notice.delayMs}ms — ${notice.detail}`,
    );
  };

  const providerFor = (agent: CatalogAgent): RuntimeProvider => {
    if (accounts) return accounts.provider(agent.provider);
    const key = `${agent.provider.kind}:${agent.provider.model}:${agent.provider.credential.env}`;
    const cached = adapters.get(key);
    if (cached) return cached;
    const agentResolution = resolveProvider(agent.provider, env);
    if (!agentResolution.ok) {
      throw new Error(
        `agent "${agent.id}" (@${agent.handle}) cannot run [${agentResolution.problem.code}]: ` +
          `${agentResolution.problem.message}`,
      );
    }
    const built = createProvider(agentResolution.provider, { onRetry });
    adapters.set(key, built);
    return built;
  };

  const pool = createPool(databaseUrl);
  // The synchronous path cannot probe, but it can make sure the failure it
  // eventually hits is legible: an idle client that loses the server throws on
  // the pool, and `pg`'s own error there is the empty `AggregateError`.
  pool.on('error', (err) => {
    console.error(`database: ${describeDatabaseError(err, databaseUrl)}`);
  });
  const provider: RuntimeProvider = {
    get capabilities() { return providerFor(catalog.defaultAgent()).capabilities; },
    complete: request => providerFor(catalog.defaultAgent()).complete(request),
  };
  // Delegation can only be wired once both exist; before this call the tool
  // refuses rather than reaching for an ambient catalog. `providerFor` rides
  // along so a colleague pinned to another provider is run on that provider.
  bindDelegation(registry, {
    catalog,
    provider,
    providerFor: ({ id }) => {
      const agent = catalog.get(id);
      return agent ? providerFor(agent) : provider;
    },
  });
  // `owner.rename_me` rewrites the calling agent's own file, so it needs the
  // catalog for the same reason delegation does. Each surface rebinds with its
  // own name, so a completed first run records where it actually happened.
  bindOwnerTools(registry, { catalog });
  // The `platform.*` family writes agent files and then reloads this same
  // façade, which is why it is bound here and not at construction: it needs the
  // catalog it is about to replace.
  bindPlatformTools(registry, {
    catalog,
    reload: () => catalog.reload(),
    accounts: () => {
      if (!accounts) return undefined;
      const service = accounts;
      return {
        list: () => service.view().accounts.map((a) => ({
          id: a.id, label: a.label, kind: a.kind, enabled: a.enabled, configured: a.configured,
          defaultModel: a.defaultModel, assignedAgents: a.assignedAgents,
        })),
        bindingOf: (agentId) => service.view().bindings.find((b) => b.agentId === agentId),
        assign: (agentId, accountId, model) => service.assign(agentId, { accountId, model }),
      };
    },
  });
  return {
    pool,
    registry,
    catalog,
    reloadCatalog: () => catalog.reload(),
    reloadProviders: () => { adapters.clear(); catalog.reload(); },
    useProviderAccounts: (service: ProviderAccounts) => { accounts = service; adapters.clear(); catalog.reload(); },
    provider,
    providerFor,
    model: catalog.defaultAgent().provider.model,
    credentialKind: catalog.defaultAgent().provider.credential.kind,
    providerKind: catalog.defaultAgent().provider.kind,
    now,
    timezone,
    ctx: { db: pool, ownerId: OWNER_ID, now, timezone,
      systemContext: () => systemContext({ db: pool, ownerId: OWNER_ID, now, timezone }) },
  };
}
