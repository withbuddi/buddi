/**
 * The gateway's view of the agent catalog.
 *
 * Core owns loading and the fail-closed rules; the gateway owns *what is
 * installed* — the tool registry the agent files are resolved against, and the
 * `agents/` directory at the repo root. Every entry point (CLI, Telegram,
 * missions, serve) goes through here so they all see one catalog.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadAgentCatalog,
  ToolRegistry,
  type AgentCatalog,
  type PluginManifest,
} from '@buddi/core';
import { manifest as artifactsManifest } from '@buddi/tool-artifacts';
import { manifest as financeManifest } from '@buddi/tool-finance';
import { buildPreamble, manifest as memoryManifest } from '@buddi/tool-memory';
import { createDelegationManifest } from './delegation.js';

/** Repo root relative to this module — resolved from the module URL, never cwd. */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

/** Agents are files in the repo, auto-discovered (ARCHITECTURE.md, "Drop-in tools and skills"). */
export const AGENTS_DIR = path.join(REPO_ROOT, 'agents');

/** The slice of `pg.Pool` the memory preamble needs. */
export interface Queryable {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

/** The plugins installed in this build. Core with zero plugins is still valid. */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(financeManifest);
  registry.register(memoryManifest);
  registry.register(artifactsManifest);
  // Delegation is registered last and takes the registry itself: the nested run
  // executes against this same registry, and its catalog and provider are bound
  // by `bindDelegation` once they exist (the catalog is loaded *against* this
  // registry, so it cannot exist yet).
  registry.register(createDelegationManifest(registry));
  return registry;
}

/** Every plugin manifest installed here — what `db:migrate` walks. */
export function installedManifests(): PluginManifest[] {
  return [financeManifest, memoryManifest];
}

/**
 * The runtime's memory hook, bound to a pool.
 *
 * The runtime knows only `(agentId) => Promise<string>`; which plugin answers,
 * and what a memory even is, stops here. Pass the result as `memoryPreamble` to
 * `runAgent` and the agent starts every run knowing what it remembers.
 */
export function memoryPreambleFor(pool: Queryable): (agentId: string) => Promise<string> {
  return (agentId) => buildPreamble(pool, agentId);
}

export interface GatewayCatalogOptions {
  env?: NodeJS.ProcessEnv;
  registry?: ToolRegistry;
  dir?: string;
}

export function loadGatewayCatalog(opts: GatewayCatalogOptions = {}): AgentCatalog {
  return loadAgentCatalog({
    dir: opts.dir ?? AGENTS_DIR,
    registry: opts.registry ?? createToolRegistry(),
    env: opts.env ?? process.env,
  });
}

let cached: { env: NodeJS.ProcessEnv; catalog: AgentCatalog } | undefined;

/**
 * The process-wide catalog. Memoised per `env` object: the provider ref is
 * pinned from the environment at load, so a different environment is a
 * different catalog rather than a stale one.
 */
export function gatewayCatalog(env: NodeJS.ProcessEnv = process.env): AgentCatalog {
  if (cached && cached.env === env) return cached.catalog;
  const catalog = loadGatewayCatalog({ env });
  cached = { env, catalog };
  return catalog;
}
