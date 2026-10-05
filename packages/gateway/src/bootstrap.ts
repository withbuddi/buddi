/**
 * Shared process wiring for the gateway's long-running entry points.
 *
 * `buddi serve`, `buddi-telegram` and `buddi missions` all need the same four
 * things — a pool, a tool registry, the agent catalog and a resolved provider —
 * built the same way and exactly once. Resolution fails closed with a typed
 * problem: a process that cannot reach a credential never starts and never
 * guesses one.
 */
import { assetImageCodec } from './plugins/asset-image.js';
import path from 'node:path';
import { systemContext } from './system-context.js';
import {
  DATABASE_URL_VAR,
  KNOWN_SECRETS,
  compileJsonSchema,
  configurePluginHost,
  createPool,
  invalidateSecretScrubber,
  createVault,
  loadScrubEntries,
  setSecretScrubSource,
  primeSecretScrubber,
  hydrateDatabaseUrl,
  resolveDatabaseUrl,
  resolveDataDir,
  resolveProvider,
  resolveSecrets,
  timezoneFromEnv,
  ownerTimezone,
  refreshOwnerTimezone,
  vaultSelection,
  type DatabaseUrlResolution,
  type AgentCatalog,
  type CatalogAgent,
  type SecretProblem,
  type SecretSource,
  type CoreToolContext,
  type ToolRegistry,
  type Vault,
} from '@buddi/core';
import { createHttpTransport, createOAuthPort, createPluginSignInService, createProvider, defaultHttpTransport, type RuntimeProvider } from '@buddi/runtime';
import { bindConnections, type ConnectionsService } from '@buddi/tool-mcp';
import { ProviderSettings } from './providers.js';
import { ProviderAccounts } from './provider-accounts.js';
import { connectionSecrets } from './owner-secrets.js';
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
import { protectedWritePaths } from './agents/learned-skills.js';
import { bindOwnerTools } from './agents/owner-tools.js';
import { bindPlatformTools } from './agents/platform.js';
import type { CatalogueService } from './agents/platform-catalogue.js';
import { createCatalogueService } from './web/catalogue-source.js';
import { browserDelegable, browserHost } from './browser-host.js';
import { loadDefaultAgentRecord, writeDefaultAgentRecord } from './agents/default-agent.js';
import { describeDatabaseError, probeDatabase } from './db-ready.js';
import { loadPluginsOnce } from './plugins/load.js';
import { sweepIncoming, sweepStages } from './plugins/stage.js';
import { sweepPluginDirs } from './plugins/paths.js';
import { ROLE_FRONT_DESK } from './agents/roles.js';

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
  // Mail accounts' passwords are not hydrated: they are owner secrets, which
  // the email plugin asks `ctx.buddi.secrets` for and never reads from the
  // environment (`owner-secrets.ts`). `GMAIL_APP_PASSWORD` is not either:
  // the start's one-time adoption of the old `.env` mailbox reads it
  // itself (`adoptEnvMailbox`), and it is cleared from the environment after.
  const names = [...WIRED_SECRETS];
  const resolved = await resolveSecrets(names, { vault, env });
  for (const name of names) {
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
  /**
   * The owner's timezone, read at each use: Settings → Profile, else
   * `BUDDI_TZ`, else New York (`ownerTimezone`). Copy it into a long-lived
   * object only as a getter, or a change in Settings will not reach it.
   */
  readonly timezone: string;
  ctx: CoreToolContext;
  /** Where secrets came from this boot. Absent when nothing hydrated them. */
  secrets?: SecretHydration;
  /** Settings → Connections: remote MCP servers and their tools (docs/connections.md). */
  connections?: ConnectionsService;
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
    // And tarballs uploaded from the dashboard that never became a stage: the
    // upload is deleted as soon as staging has copied it, so anything left is
    // from a gateway that died between the two.
    const uploads = sweepIncoming(env);
    if (uploads.length > 0) console.error(`swept ${uploads.length} uploaded plugin tarball(s) nobody staged`);
    /*
     * And what a half-finished install left: the `<name>.previous-…` an upgrade
     * moves aside, and a package directory no record mentions, which is what a
     * crash between the rename and the record write leaves behind. Skipped
     * entirely when the record itself could not be read — with no list of what
     * is installed, everything would look like an orphan.
     */
    const readable = plugins.problems.every((problem) => problem.record !== undefined);
    if (readable) {
      const known = [
        ...plugins.loaded.map((p) => p.record.name),
        ...plugins.problems.map((p) => p.name),
      ];
      const dirs = sweepPluginDirs(env, { known });
      for (const dir of dirs) {
        console.error(`removed ${dir} from the plugins directory: no record names it`);
      }
    }
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
  const wiring = createWiring(env);
  /*
   * The owner's zone is the profile's (Settings → Profile), with `BUDDI_TZ`
   * only the fallback. Read now, and again every minute so a change made by
   * another process (or straight in the database) lands without a restart;
   * a write in this process applies at once (`setOwnerProfile`).
   */
  await refreshOwnerTimezone(wiring.pool);
  const zoneRefresh = setInterval(() => { void refreshOwnerTimezone(wiring.pool); }, 60_000);
  if (typeof zoneRefresh.unref === 'function') zoneRefresh.unref();
  const providerSettings = new ProviderSettings({ pool: wiring.pool, env, reload: wiring.reloadProviders });
  const providerAccounts = new ProviderAccounts({ pool: wiring.pool, env, catalog: () => wiring.catalog, reload: wiring.reloadProviders });
  try {
    await providerSettings.load();
    // Initialization captures the old choice once, before switching resolution.
    await providerAccounts.initialize();
    wiring.useProviderAccounts(providerAccounts);
  }
  catch (error) { await wiring.pool.end(); throw error; }
  /*
   * Who the default agent is, as the installation recorded it. Read once here
   * and held for the process, then the catalog is rebuilt so that every
   * surface — the dashboard, Telegram, a mission — resolves the same agent
   * without anybody restarting anything. A database that cannot answer leaves
   * the file flag deciding, which is what an installation that has never
   * picked one has always done.
   */
  try {
    const recorded = await loadDefaultAgentRecord(wiring.pool);
    if (recorded !== undefined) wiring.reloadCatalog();
  } catch {
    // Reading a preference may never be the thing that stops a start.
  }
  // Every reviewed connection's tools, before any surface takes a turn. A
  // connection that cannot be read is a line in the log, never a stopped start.
  try {
    await wiring.connections?.boot();
    // An unreachable connection is tried again in the background (1, 5, 15,
    // 60 minutes, then hourly), on a timer that never keeps a process alive.
    wiring.connections?.startBackground();
  } catch (error) {
    console.error(`connections: tools not registered: ${error instanceof Error ? error.message : String(error)}`);
  }
  const selected = wiring.catalog.defaultAgent();
  // The first automaton, before any sync sink (a plugin's buddi.log, the
  // serve loops' lines) writes a word: the async choke points re-prime later.
  await primeSecretScrubber();
  // The zone stays a getter through the spread: a spread would freeze the
  // zone of this moment, and Settings → Profile can change it at any time.
  return { ...wiring, get timezone() { return wiring.timezone; }, secrets, providerSettings, providerAccounts, model: selected.model,
    providerKind: selected.provider.kind, credentialKind: selected.provider.credential.kind };
}

/**
 * Build the shared wiring or throw. The caller owns `pool` and must end it.
 */
export function createWiring(env: NodeJS.ProcessEnv = process.env): Wiring {
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
  // The browser runtime picks a route per task: plugin-provided routes come
  // from this registry, and an agent's pin from its agent.md (docs/browser.md).
  const browser = browserHost(env);
  browser.useRouteProviders(() => registry.routeProviders());
  browser.useAgentPins((agentId) => catalog.get(agentId)?.browserRoute);
  /*
   * A plugin may add or remove tools while buddi runs (`ctx.buddi.tools`,
   * host API 1.6): a connection made at 3pm brings `mcp.github.*`. The
   * catalog is rebuilt so every agent's `tools:` grant is resolved again and
   * its next turn sees the change. A rebuild that fails keeps the previous
   * catalog serving, as any reload does, and says why.
   */
  registry.onChange(() => {
    try {
      catalog.reload();
    } catch (error) {
      console.error(`agent catalog not reloaded after a tool change: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  /*
   * What `ctx.buddi` needs and no context carries (docs/plugin-host-api.md):
   * how the shared transport is made, which core may not import (the `http`
   * area makes one with its address guard as the socket's resolver), and the
   * live roster for `owner.agentForRole` — read on each call, so an agent
   * given a role at lunchtime answers for it this afternoon.
   */
  configurePluginHost({
    httpTransport: createHttpTransport,
    agentForRole: (role) => catalog.agentsWithRole(role).find((agent) => agent.availability.ok)?.id,
    // Installed at all, runnable or not: a plugin asking this is deciding
    // whether to offer the agent, and one held back is not one to offer again.
    hasAgent: (id) => catalog.get(id) !== undefined,
    env,
    // Plugin assets (1.27): decoded and drawn again as PNG here, never served as given.
    images: assetImageCodec,
    // A plugin's OAuth sign-in (1.28): a loopback listener per sign-in, and the
    // refresh behind `auth: { as: 'bearer' }`, on the shared transport.
    signIns: createPluginSignInService({ transport: defaultHttpTransport }),
  });

  const now = (): Date => new Date();
  const configuredTimezone = timezoneFromEnv(env);
  const zone = (): string => ownerTimezone(configuredTimezone);
  // No start-up check on the default agent's credential: Anthropic comes in
  // only through a model account, bound after this wiring exists, and an agent
  // without one is reported per agent ("Choose a provider account…").

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
  // A plugin's channel (docs/notifications.md) is called by core's routing,
  // outside any context: its host is built over this pool, in the owner's
  // zone, with links on the dashboard's public origin when there is one.
  configurePluginHost({
    db: pool,
    timezone: configuredTimezone,
    ...(env.BUDDI_WEB_PUBLIC_ORIGIN?.trim() ? { publicOrigin: env.BUDDI_WEB_PUBLIC_ORIGIN.trim() } : {}),
  });
  /*
   * The output scrubber's source, once per process (docs/owner-secrets.md
   * §5): every owner secret by name, buddi's own keys under theirs. Set here,
   * where every entry point builds its pool, so `buddi chat`, `buddi ask`,
   * `buddi serve` and the dashboard all scrub. The first async choke point
   * (a tool result, an event, a provider request) builds the automaton; a
   * save, rename or delete invalidates it and the next one rebuilds.
   */
  try {
    setSecretScrubSource(() => loadScrubEntries(pool, createVault({ env }), env));
  } catch (error) {
    console.error(`output scrubbing unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
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
    // A delegate browses only from an owner conversation with a page open there.
    delegableSession: browserDelegable(browser),
  });
  // `owner.rename_me` rewrites the calling agent's own file, so it needs the
  // catalog for the same reason delegation does. Each surface rebinds with its
  // own name, so a completed first run records where it actually happened.
  bindOwnerTools(registry, { catalog });
  // The `platform.*` family writes agent files and then reloads this same
  // façade, which is why it is bound here and not at construction: it needs the
  // catalog it is about to replace.
  /*
   * Connections (docs/connections.md): the service behind the plugin
   * registered above, with the vault its sign-ins live in and the one shared
   * outbound transport. Its tools are registered by `boot`, after the
   * database answers (`createWiringAsync`).
   */
  let vault: Vault | undefined;
  try { vault = createVault({ env }); } catch { vault = undefined; }
  const connectionSecretsPort = connectionSecrets(pool, vault);
  const connections = bindConnections(registry.manifests(), {
    pool,
    vault,
    transport: defaultHttpTransport,
    oauth: createOAuthPort({ transport: defaultHttpTransport }),
    ...(connectionSecretsPort ? { secrets: connectionSecretsPort } : {}),
    compileSchema: (schema) => compileJsonSchema(schema).dispose(),
    tokensChanged: invalidateSecretScrubber,
    now,
    log: (line) => console.error(line),
    // A program's working directory is `<data>/connections/<id>`; its PATH,
    // HOME and locale come from this process's environment.
    dataDir: resolveDataDir(env),
    env,
  });
  let catalogueService: CatalogueService | undefined;
  bindPlatformTools(registry, {
    catalog,
    reload: () => catalog.reload(),
    // Making an agent the default is a row, not a file edit: the tool records
    // the owner's choice and the catalog reload below picks it up.
    setDefaultAgent: async (agentId: string) => {
      await writeDefaultAgentRecord(pool, agentId);
    },
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
    // The agent catalogue (agent-catalogue.md §5): the market list this
    // installation keeps, read when a tool asks; built once, on first use.
    catalogue: () =>
      (catalogueService ??= createCatalogueService({
        env,
        log: (line) => console.error(line),
        registry,
        ctx: wiring.ctx,
        now,
      })),
  });
  const wiring: Wiring = {
    pool,
    registry,
    catalog,
    ...(connections ? { connections } : {}),
    reloadCatalog: () => catalog.reload(),
    reloadProviders: () => { adapters.clear(); catalog.reload(); },
    useProviderAccounts: (service: ProviderAccounts) => { accounts = service; adapters.clear(); catalog.reload(); },
    provider,
    providerFor,
    model: catalog.defaultAgent().provider.model,
    credentialKind: catalog.defaultAgent().provider.credential.kind,
    providerKind: catalog.defaultAgent().provider.kind,
    now,
    get timezone() { return zone(); },
    ctx: { db: pool, ownerId: OWNER_ID, now,
      get timezone() { return zone(); },
      protectedPaths: protectedWritePaths(),
      /*
       * Stable, and late-bound like the getter below: the account service is
       * attached after this object is built (and spread), so each call asks
       * for it then. No service, no accounts — never an ambient key.
       */
      providerAccounts: {
        list: () => accounts?.pluginAccess().list() ?? [],
        resolve: (id, model, signal) => {
          if (!accounts) return Promise.reject(new Error('Provider accounts are not available in this process.'));
          return accounts.pluginAccess().resolve(id, model, signal);
        },
        withCodexProfile: (id, use, signal) => {
          if (!accounts) return Promise.reject(new Error('Provider accounts are not available in this process.'));
          return accounts.pluginAccess().withCodexProfile(id, use, signal);
        },
        generateCodexImage: (id, options) => {
          if (!accounts) return Promise.reject(new Error('Provider accounts are not available in this process.'));
          return accounts.pluginAccess().generateCodexImage(id, options);
        },
      },
      systemContext: (run) =>
        systemContext({ db: pool, ownerId: OWNER_ID, now, timezone: zone() }, run, {
          // Only the front desk is told the owner's places (docs/agents.md).
          isFrontDesk: (agentId) => catalog.agentsWithRole(ROLE_FRONT_DESK).some((agent) => agent.id === agentId),
          // The edition origin line names the agent that delivered it by handle.
          handleOf: (agentId) => catalog.get(agentId)?.handle ?? null,
        }),
      /*
       * A getter, not a value: this object is built before anything is bound,
       * and the preview listener publishes its port into the environment the
       * moment it has one. Reading it here means a plugin never sees a stale
       * number and nothing has to remember to write one back.
       */
      get previewPort(): number | undefined {
        const port = Number(process.env.BUDDI_PREVIEW_PORT ?? '');
        return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
      } },
  };
  return wiring;
}
