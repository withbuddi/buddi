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
import {
  KNOWN_SECRETS,
  createPool,
  createVault,
  resolveProvider,
  resolveSecrets,
  timezoneFromEnv,
  vaultSelection,
  type AgentCatalog,
  type CatalogAgent,
  type SecretProblem,
  type SecretSource,
  type ToolContext,
  type ToolRegistry,
  type Vault,
} from '@buddi/core';
import { createProvider, type RuntimeProvider } from '@buddi/runtime';
import { config as loadDotenv } from 'dotenv';
import type { Pool } from 'pg';
import { createToolRegistry, loadGatewayCatalog, REPO_ROOT } from './agents/catalog.js';
import { bindDelegation } from './agents/delegation.js';
import { bindOwnerTools } from './agents/owner-tools.js';
import { describeDatabaseError, probeDatabase } from './db-ready.js';

export { REPO_ROOT };

export const OWNER_ID = 'owner';

/** Load `.env` from the repo root. Idempotent; never overrides a real env var. */
export function loadEnv(): void {
  loadDotenv({ path: path.join(REPO_ROOT, '.env') });
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
export const WIRED_SECRETS: readonly string[] = KNOWN_SECRETS;

export interface SecretHydration {
  /** Which vault this machine uses: 'keychain', 'file', 'memory' or 'none'. */
  vault: string;
  /** Where each secret came from. Names and sources only — never a value. */
  sources: Record<string, SecretSource>;
  /** Secrets neither the vault nor the environment could supply. */
  problems: Record<string, SecretProblem>;
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
 * Mutating `env` in place is deliberate and confined to here — the composition
 * root, before any agent, tool or provider exists.
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
  return {
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
  /** Every agent installed as a file under `agents/`. */
  catalog: AgentCatalog;
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
  // The database comes before everything else it is under: with Docker stopped,
  // a provider or catalog error is a distraction and the pg failure that
  // follows is an empty `AggregateError`. One probe, one sentence.
  await probeDatabase(env.DATABASE_URL);
  return { ...createWiring(env), secrets };
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
  const catalog = loadGatewayCatalog({ env, registry });

  const now = (): Date => new Date();
  const timezone = timezoneFromEnv(env);
  const resolution = resolveProvider(catalog.defaultAgent().provider, env);
  if (!resolution.ok) {
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
  const providerFor = (agent: CatalogAgent): RuntimeProvider => {
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
    const built = createProvider(agentResolution.provider);
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
  const provider = createProvider(resolution.provider);
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
  return {
    pool,
    registry,
    catalog,
    provider,
    providerFor,
    model: resolution.provider.model,
    credentialKind: resolution.provider.credentialKind,
    providerKind: resolution.provider.kind,
    now,
    timezone,
    ctx: { db: pool, ownerId: OWNER_ID, now, timezone },
  };
}
