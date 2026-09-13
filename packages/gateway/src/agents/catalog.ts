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
import { loadAgentCatalog, ToolRegistry, type AgentCatalog } from '@buddi/core';
import { manifest as financeManifest } from '@buddi/tool-finance';

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

/** The plugins installed in this build. Core with zero plugins is still valid. */
export function createToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(financeManifest);
  return registry;
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
