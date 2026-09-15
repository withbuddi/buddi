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
  migrationNotice,
  resolveAgentSearchPath,
  reminderLimitsFromEnv,
  ToolRegistry,
  type AgentCatalog,
  type AgentSearchPath,
  type PluginManifest,
} from '@buddi/core';
import { manifest as artifactsManifest } from '@buddi/tool-artifacts';
import { manifest as emailManifest } from '@buddi/tool-email';
import { manifest as financeManifest } from '@buddi/tool-finance';
import { buildPreamble, manifest as memoryManifest } from '@buddi/tool-memory';
import { createCanvasManifest } from './canvas.js';
import { createDelegationManifest } from './delegation.js';
import { createOwnerManifest } from './owner-tools.js';
import { createReminderManifest, createScheduleManifest } from '../missions/reminders.js';

/** Repo root relative to this module — resolved from the module URL, never cwd. */
export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

/**
 * Where agents and skills are looked for, in order (ARCHITECTURE.md, "Drop-in
 * tools and skills"): the examples this repository ships, then the owner's
 * private set, which overrides them and is never committed.
 *
 * Memoised per `env` object for the same reason the catalog is: the private
 * half can be pinned with `BUDDI_AGENTS_DIR`, so a different environment is a
 * different path rather than a stale one.
 */
const searchPaths = new WeakMap<NodeJS.ProcessEnv, AgentSearchPath>();

export function agentSearchPath(env: NodeJS.ProcessEnv = process.env): AgentSearchPath {
  const cached = searchPaths.get(env);
  if (cached) return cached;
  const search = resolveAgentSearchPath({ repoRoot: REPO_ROOT, env });
  searchPaths.set(env, search);
  return search;
}

/** The examples shipped with the repository — the platform half of the split. */
export const EXAMPLES_AGENTS_DIR = path.join(REPO_ROOT, 'examples', 'agents');
export const EXAMPLES_SKILLS_DIR = path.join(REPO_ROOT, 'examples', 'skills');

/**
 * The owner's own agents directory: what `buddi agents` points at when it names
 * a place to put a file, and where `delegates.json` is read from. Resolved once
 * from `process.env` at import, like `REPO_ROOT` itself.
 */
export const AGENTS_DIR = agentSearchPath(process.env).owner.dir;

/** The slice of `pg.Pool` the memory preamble needs. */
export interface Queryable {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}

/**
 * The plugins installed in this build. Core with zero plugins is still valid.
 *
 * `env` is read for one thing only: the reminder budget, which the owner can
 * move (`BUDDI_REMINDER_*`). It is resolved here rather than inside the tool so
 * that the numbers the store enforces and the numbers the tool *describes* are
 * the same object, decided once at the composition root.
 */
export function createToolRegistry(env: NodeJS.ProcessEnv = process.env): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(financeManifest);
  registry.register(emailManifest);
  registry.register(memoryManifest);
  registry.register(artifactsManifest);
  // Reminders and schedules are registered in the *base* registry, unlike the
  // mission tools: an agent can put something on the clock from any run, and a
  // reminder set in a chat is the same object as one set by the daily check.
  registry.register(createReminderManifest(reminderLimitsFromEnv(env)));
  registry.register(createScheduleManifest());
  // The canvas, for the same reason: what an agent can draw is a property of
  // the installation, not of one conversation. It owns no data, so it is here
  // rather than in `installedManifests` — there is nothing to migrate.
  registry.register(createCanvasManifest());
  // The first-run tools. Registered in the base registry like the reminders:
  // the owner may correct their name or their zone in any conversation, not
  // only in the one that first asked for it.
  registry.register(createOwnerManifest(registry));
  // Delegation is registered last and takes the registry itself: the nested run
  // executes against this same registry, and its catalog and provider are bound
  // by `bindDelegation` once they exist (the catalog is loaded *against* this
  // registry, so it cannot exist yet).
  registry.register(createDelegationManifest(registry));
  return registry;
}

/** Every plugin manifest installed here — what `db:migrate` walks. */
export function installedManifests(): PluginManifest[] {
  return [financeManifest, memoryManifest, emailManifest];
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

/** Printed at most once per process: a notice is a nudge, not a log line. */
let noticed = false;

export function loadGatewayCatalog(opts: GatewayCatalogOptions = {}): AgentCatalog {
  const env = opts.env ?? process.env;
  const registry = opts.registry ?? createToolRegistry(env);
  // An explicit `dir` is a caller that means exactly one directory (a test, a
  // fixture): honour it literally and skip the search path entirely.
  if (opts.dir !== undefined) {
    return loadAgentCatalog({ dir: opts.dir, registry, env });
  }
  const search = agentSearchPath(env);
  if (!noticed) {
    const notice = migrationNotice(search);
    if (notice !== undefined) console.error(notice);
    noticed = true;
  }
  return loadAgentCatalog({
    dirs: search.entries.map(({ dir, skillsDir, source }) => ({ dir, skillsDir, source })),
    registry,
    env,
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
