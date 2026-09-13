/**
 * Shared process wiring for the gateway's long-running entry points.
 *
 * `buddi serve`, `buddi-telegram` and `buddi missions` all need the same three
 * things — a pool, a tool registry and a resolved provider — built the same way
 * and exactly once. Resolution fails closed with a typed problem: a process that
 * cannot reach a credential never starts and never guesses one.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPool,
  resolveProvider,
  ToolRegistry,
  type ToolContext,
} from '@buddi/core';
import { createAnthropicProvider, type RuntimeProvider } from '@buddi/runtime';
import { manifest as financeManifest } from '@buddi/tool-finance';
import { config as loadDotenv } from 'dotenv';
import type { Pool } from 'pg';
import { createFinanceAdvisor } from './agents/finance-advisor.js';

/** Repo root relative to this module — resolved from the module URL, never cwd. */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
);

export const OWNER_ID = 'owner';

/** Load `.env` from the repo root. Idempotent; never overrides a real env var. */
export function loadEnv(): void {
  loadDotenv({ path: path.join(REPO_ROOT, '.env') });
}

export interface Wiring {
  pool: Pool;
  registry: ToolRegistry;
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

  const registry = new ToolRegistry();
  registry.register(financeManifest);

  const now = (): Date => new Date();
  const resolution = resolveProvider(
    createFinanceAdvisor({ env, now: now() }).provider,
    env,
  );
  if (!resolution.ok) {
    throw new Error(
      `provider not usable [${resolution.problem.code}]: ${resolution.problem.message}` +
        '\nSet CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) or ANTHROPIC_API_KEY in .env',
    );
  }

  const pool = createPool(databaseUrl);
  return {
    pool,
    registry,
    provider: createAnthropicProvider(resolution.provider),
    model: resolution.provider.model,
    credentialKind: resolution.provider.credentialKind,
    now,
    ctx: { db: pool, ownerId: OWNER_ID, now },
  };
}
