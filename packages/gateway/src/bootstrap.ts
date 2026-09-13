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
  createPool,
  resolveProvider,
  type AgentCatalog,
  type ToolContext,
  type ToolRegistry,
} from '@buddi/core';
import { createAnthropicProvider, type RuntimeProvider } from '@buddi/runtime';
import { config as loadDotenv } from 'dotenv';
import type { Pool } from 'pg';
import { createToolRegistry, loadGatewayCatalog, REPO_ROOT } from './agents/catalog.js';
import { bindDelegation } from './agents/delegation.js';

export { REPO_ROOT };

export const OWNER_ID = 'owner';

/** Load `.env` from the repo root. Idempotent; never overrides a real env var. */
export function loadEnv(): void {
  loadDotenv({ path: path.join(REPO_ROOT, '.env') });
}

export interface Wiring {
  pool: Pool;
  registry: ToolRegistry;
  /** Every agent installed as a file under `agents/`. */
  catalog: AgentCatalog;
  provider: RuntimeProvider;
  /** What `resolveProvider` settled on — printed in startup logs. */
  model: string;
  credentialKind: string;
  now: () => Date;
  ctx: ToolContext;
}

/**
 * Build the shared wiring or throw. The caller owns `pool` and must end it.
 */
export function createWiring(env: NodeJS.ProcessEnv = process.env): Wiring {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set (cp .env.example .env, then pnpm db:up)');
  }

  const registry = createToolRegistry();
  const catalog = loadGatewayCatalog({ env, registry });

  const now = (): Date => new Date();
  const resolution = resolveProvider(catalog.defaultAgent().provider, env);
  if (!resolution.ok) {
    throw new Error(
      `provider not usable [${resolution.problem.code}]: ${resolution.problem.message}` +
        '\nSet CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY in .env',
    );
  }

  const pool = createPool(databaseUrl);
  const provider = createAnthropicProvider(resolution.provider);
  // Delegation can only be wired once both exist; before this call the tool
  // refuses rather than reaching for an ambient catalog.
  bindDelegation(registry, { catalog, provider });
  return {
    pool,
    registry,
    catalog,
    provider,
    model: resolution.provider.model,
    credentialKind: resolution.provider.credentialKind,
    now,
    ctx: { db: pool, ownerId: OWNER_ID, now },
  };
}
