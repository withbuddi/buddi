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
  pluginsFilePath,
  readPluginsFile,
  resolveAgentSearchPath,
  reminderLimitsFromEnv,
  ToolRegistry,
  type AgentCatalog,
  type AgentSearchPath,
  type PluginManifest,
  type LoadAgentCatalogOptions,
} from '@buddi/core';
import { manifest as artifactsManifest } from '@buddi/tool-artifacts';
import { manifest as emailManifest } from '@buddi/tool-email';
import { buildPreamble, manifest as memoryManifest,
  buildPreambleForScopes,
  groupScope,
  SHARED,
} from '@buddi/tool-memory';
import { manifest as webManifest } from '@buddi/tool-web';
import { createBrowserManifest, hostBrowser } from '@buddi/tool-browser';
import { createHostManifest, hostService } from '@buddi/tool-host';
import { externalManifests } from '../plugins/load.js';
import { createCanvasManifest } from './canvas.js';
import { createSystemManifest } from '../system-context.js';
import { recordedDefaultAgent } from './default-agent.js';
import { createDelegationManifest, readDelegates } from './delegation.js';
import { createOwnerManifest } from './owner-tools.js';
import { createPlatformManifest } from './platform.js';
import { delegateToWriterRefusal, writeToolsIn } from './platform-names.js';
import { createReminderManifest, createScheduleManifest } from '../missions/reminders.js';

/** Repo root relative to this module — resolved from the module URL, never cwd. */
export const REPO_ROOT = process.env.BUDDI_INSTALL_ROOT ?? path.resolve(
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
  return buildRegistry(env, externalManifests(env));
}

/**
 * Exactly what this build compiles in, as manifests — nothing the owner
 * installed.
 *
 * This is the single source of truth the collision guards read
 * (`plugins/load.ts`, `plugins/install.ts`): a name or a schema is "built in"
 * because it is *registered here*, not because somebody remembered to add it to
 * a list. The list version of this drifted the day the web plugin shipped, and
 * an externally installed plugin could then take the name `web` and the `web`
 * schema off it.
 *
 * It is the same code path as `createToolRegistry` with an empty external set,
 * so a plugin registered above cannot be missing from it.
 */
export function builtInManifests(env: NodeJS.ProcessEnv = process.env): PluginManifest[] {
  return buildRegistry(env, []).manifests();
}

function buildRegistry(env: NodeJS.ProcessEnv, external: readonly PluginManifest[]): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createSystemManifest());
  // Nothing domain-specific is compiled in any more. Finance was the last one,
  // and it is now installed like any other plugin (`buddi plugins install
  // packages/tools/finance` in a checkout), which is why an agent that grants
  // `finance.*` needs that install before it will load. See
  // docs/install-foundation.md.
  registry.register(emailManifest);
  registry.register(memoryManifest);
  registry.register(artifactsManifest);
  // Search and page retrieval. Registered like every other plugin, and granted
  // like every other plugin: being installed gives no agent the capability —
  // an agent reaches the web only if its own `tools:` line names `web.*`.
  registry.register(webManifest);
  registry.register(createBrowserManifest(hostBrowser(env)));
  registry.register(createHostManifest(hostService(env)));
  // Everything the owner installed, from `plugins.json`. Empty in any process
  // that did not await `loadPluginsOnce` — a unit test, a fixture — which is
  // the honest answer for a process that never read the owner's record.
  //
  // A plugin that will not register (a tool name that collides with one
  // already here, an input schema no provider would accept) is skipped with a
  // line on the process log rather than thrown: an installation must not stop
  // answering because a third-party plugin has a bug. `buddi plugins list`
  // shows the same failure where the owner will look for it.
  for (const manifest of external) {
    try {
      registry.register(manifest);
    } catch (err) {
      console.error(
        `plugin ${manifest.name}@${manifest.version} did not register and its tools are absent: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
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
  // The platform family: reading what is installed is tier `auto`, and every
  // write — a new agent, a changed grant, a skill, a removal — is `gated`. It
  // takes the registry for two reasons: a proposed grant is resolved against
  // it, and `platform.installed_tools` is a reflection of it.
  registry.register(createPlatformManifest(registry));
  // Delegation is registered last and takes the registry itself: the nested run
  // executes against this same registry, and its catalog and provider are bound
  // by `bindDelegation` once they exist (the catalog is loaded *against* this
  // registry, so it cannot exist yet).
  registry.register(createDelegationManifest(registry));
  return registry;
}

/**
 * Every plugin manifest installed here — what `db:migrate` walks, what
 * `missions add-defaults` reads suggestions from, and what a backup enumerates.
 *
 * The compiled-in ones that own a schema of their own, then whatever the owner
 * installed. Same standing: a plugin that arrived through `buddi plugins
 * install` owns a schema and suggests missions exactly as a compiled-in one does.
 *
 * Derived from the registry, not listed: this was a hand-written four, and a
 * built-in plugin that shipped afterwards would have been left out of the
 * migrations, the doctor's pending-migration row and the backup. The filter is
 * what the old list said in longhand — a family that creates no tables (the
 * canvas, the reminders, delegation) has nothing here to walk.
 */
export function installedManifests(env: NodeJS.ProcessEnv = process.env): PluginManifest[] {
  return [
    ...builtInManifests(env).filter((m) => (m.migrationsDir ?? '').trim() !== ''),
    ...externalManifests(env),
  ];
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

/**
 * The same hook for a group run: shared plus the room's own scope, and never
 * a member's private notes (docs/groups.md, "Memory").
 */
export function memoryPreambleForGroup(pool: Queryable): (groupId: string) => Promise<string> {
  return (groupId) => buildPreambleForScopes(pool, [SHARED, groupScope(groupId)]);
}

export interface GatewayCatalogOptions {
  providerSelection?: LoadAgentCatalogOptions['providerSelection'];
  env?: NodeJS.ProcessEnv;
  registry?: ToolRegistry;
  dir?: string;
}

/** Printed at most once per process: a notice is a nudge, not a log line. */
let noticed = false;

/**
 * Nobody may delegate to an agent that can write the installation.
 *
 * Checked at *load*, not only where a grant is proposed, because a
 * `delegates.json` is a plain file: an owner can write one by hand, a backup
 * can restore one, and an allowlist that quietly opened a path from the mail
 * agent to `platform.create_agent` would be the one failure this confinement
 * exists to prevent. So it is a load error, loud, naming both agents — the
 * installation refuses to come up rather than come up with the corridor open.
 */
export function assertNoDelegationToWriters(catalog: AgentCatalog): void {
  for (const summary of catalog.list()) {
    const agent = catalog.get(summary.id);
    if (!agent) continue;
    // `delegates.json` sits next to `agent.md`, whichever half of the search
    // path the agent came from.
    const agentsDir = path.dirname(path.dirname(agent.file));
    for (const targetId of readDelegates(agent.id, agentsDir)) {
      const held = writeToolsIn(catalog.get(targetId)?.tools ?? []);
      if (held.length > 0) {
        throw new Error(delegateToWriterRefusal(agent.id, targetId, held));
      }
    }
  }
}

/**
 * Examples that are an offer, not a colleague, and only make sense once the
 * installation is actually running.
 *
 * Agent Father is the only one so far. It is the "make me another one" that
 * comes *after* the owner has an assistant of their own: on a fresh install it
 * has no account to think with and nothing to make a second agent beside, so
 * listing it puts a stranger who cannot answer at the top of the first roster
 * the owner ever sees.
 *
 * This is a hard-coded id rather than a `requires:` frontmatter key. The key
 * would be a new word in core's agent schema — parsed, validated, documented,
 * and offered to every owner writing a file — to express one rule about one
 * agent this repository ships. If a second example ever needs it, this list is
 * where the rule already is, and that is the moment to make it frontmatter.
 */
export const EXAMPLES_HELD_BACK: readonly string[] = ['agent-father'];

/**
 * The roster, minus the examples the installation has not grown into yet.
 *
 * Only `list()` is filtered — the roster, `/api/agents`, the rail and Home all
 * read it, and §6 of docs/onboarding.md says *listed*. A held-back agent is not
 * deleted: `get`, `byHandle` and `resolve` still answer for it, so `/new`, a
 * handle typed by hand and a handle collision check all keep working, and
 * nothing that already holds its id breaks the moment the rule flips.
 *
 * The condition is read on every call rather than captured: the accounts
 * service reloads the catalog when a credential changes, but a rule about live
 * state should not depend on somebody remembering to.
 */
export function withHeldBackExamples(catalog: AgentCatalog): AgentCatalog {
  const started = () => {
    const all = catalog.list();
    // "The owner has met their assistant" — an agent of their own, made by the
    // wizard or by hand — and "there is a brain": an agent here can run.
    return all.some((a) => a.source !== 'example') && all.some((a) => a.available);
  };
  return {
    ...catalog,
    get defaultProblem() { return catalog.defaultProblem; },
    get: (id) => catalog.get(id),
    byHandle: (handle) => catalog.byHandle(handle),
    agentsWithRole: (role) => catalog.agentsWithRole(role),
    agentForRole: (role) => catalog.agentForRole(role),
    defaultAgent: () => catalog.defaultAgent(),
    resolve: (idOrHandle) => catalog.resolve(idOrHandle),
    list: () => {
      const all = catalog.list();
      if (started()) return all;
      return all.filter((a) => !(a.source === 'example' && EXAMPLES_HELD_BACK.includes(a.id)));
    },
  };
}

/**
 * Which plugin provides a tool family, for the held-back sentence.
 *
 * A family is a plugin's name — `finance.*` comes from the plugin called
 * `finance` — so the question is only whether this installation has heard of
 * it: a plugin in the owner's record that has not loaded yet (a restart
 * pending, an entry point that threw), or one compiled into this build. If it
 * has, the sentence names it; if it has not, core says "a plugin providing the
 * finance tools", which is the honest answer and still points at the page.
 *
 * Everything here is wrapped: producing a *sentence* may never be the thing
 * that stops a catalog loading, which is the whole point of this path.
 */
export function pluginNameForFamily(env: NodeJS.ProcessEnv = process.env): (family: string) => string | undefined {
  const known = new Set<string>();
  try {
    for (const manifest of builtInManifests(env)) known.add(manifest.name);
  } catch { /* a build that cannot list itself still loads agents */ }
  try {
    const file = pluginsFilePath({ ownerRoot: agentSearchPath(env).ownerRoot, env });
    for (const entry of readPluginsFile(file).plugins) known.add(entry.name);
  } catch { /* no record, or an unreadable one: the family is the answer */ }
  return (family) => (known.has(family) ? family : undefined);
}

/**
 * The allowlist, for the *prompt* — never for the decision.
 *
 * `agent.delegate` takes a catalog id, so an agent that is shown only handles
 * guesses one and is refused. The generated wiring names the colleagues it may
 * ask, with their ids, and this is where that list comes from. A malformed or
 * unreadable file yields nothing rather than failing the load: the refusal
 * path reads the same file again at the point of use and is still loud there.
 *
 * The file is read from **the agent's own directory**, which core hands in —
 * the same `dirname(dirname(agent.file))` `assertNoDelegationToWriters` uses.
 * With a search path, an agent from the owner's half and one from the repo's
 * examples do not share an `agents/`, and reaching for a single default
 * directory would print one agent's colleagues in another's prompt, or none.
 */
function delegatesForPrompt(): (agentId: string, agentsDir: string) => readonly string[] {
  return (agentId, agentsDir) => {
    try {
      return readDelegates(agentId, agentsDir);
    } catch {
      return [];
    }
  };
}

export function loadGatewayCatalog(opts: GatewayCatalogOptions = {}): AgentCatalog {
  const env = opts.env ?? process.env;
  const registry = opts.registry ?? createToolRegistry(env);
  const pluginForFamily = pluginNameForFamily(env);
  // An explicit `dir` is a caller that means exactly one directory (a test, a
  // fixture): honour it literally and skip the search path entirely.
  if (opts.dir !== undefined) {
    const single = loadAgentCatalog({ dir: opts.dir, registry, env, providerSelection: opts.providerSelection, pluginForFamily, delegatesFor: delegatesForPrompt(), ...(recordedDefaultAgent() === undefined ? {} : { defaultAgentId: recordedDefaultAgent() as string }) });
    assertNoDelegationToWriters(single);
    return single;
  }
  const search = agentSearchPath(env);
  if (!noticed) {
    const notice = migrationNotice(search);
    if (notice !== undefined) console.error(notice);
    noticed = true;
  }
  const catalog = loadAgentCatalog({
    dirs: search.entries.map(({ dir, skillsDir, source }) => ({ dir, skillsDir, source })),
    registry,
    env,
    providerSelection: opts.providerSelection,
    pluginForFamily,
    delegatesFor: delegatesForPrompt(),
    // The owner's recorded choice, which core prefers over any file flag.
    ...(recordedDefaultAgent() === undefined ? {} : { defaultAgentId: recordedDefaultAgent() as string }),
  });
  assertNoDelegationToWriters(catalog);
  return withHeldBackExamples(catalog);
}

/* ------------------------------------------------------------------ *
 * Reloading, without a restart
 * ------------------------------------------------------------------ */

/**
 * A catalog whose contents can be rebuilt from disk while the process runs.
 *
 * Every surface in this build holds *the catalog object* and asks it questions
 * per turn — `resolve` on each message, `list` for the roster, `get` when a
 * mission fires. That is the seam: if the object the holders share stays the
 * same object and only what is *behind* it changes, then an agent written a
 * second ago is resolvable everywhere at once, with nothing to re-wire and no
 * holder left pointing at yesterday's map.
 *
 * So this is a façade, not a cache: it forwards every call to whichever catalog
 * is current, and `reload()` swaps that one. A reload that fails — a file the
 * owner half-wrote, a tool that no longer exists — leaves the previous catalog
 * in place and throws, because a broken write may never take the installation
 * down.
 */
export interface ReloadableAgentCatalog extends AgentCatalog {
  /** Rebuild from disk and swap, or throw with the old catalog still serving. */
  reload(): void;
  /**
   * Called after a *successful* swap, so a surface that publishes something
   * derived from the catalog can publish it again. Telegram's command menu is
   * the case that forced this: `/new` is in the menu only while an agent claims
   * the `maker` role, and the owner can create that agent's replacement in
   * session — a menu computed once at boot would then be a lie until restart.
   *
   * Returns an unsubscribe. A listener that throws is contained: a write must
   * not fail because a cosmetic re-publish did.
   */
  onReload(listener: () => void): () => void;
  /** The catalog currently behind the façade. For tests and diagnostics. */
  current(): AgentCatalog;
}

/** Wrap a loader in the façade every surface can keep holding. */
export function reloadableCatalog(
  load: () => AgentCatalog,
  onListenerError: (err: unknown) => void = () => {},
): ReloadableAgentCatalog {
  let inner = load();
  const listeners = new Set<() => void>();
  return {
    get: (id) => inner.get(id),
    byHandle: (handle) => inner.byHandle(handle),
    list: () => inner.list(),
    refused: () => inner.refused?.() ?? [],
    agentsWithRole: (role) => inner.agentsWithRole(role),
    agentForRole: (role) => inner.agentForRole(role),
    defaultAgent: () => inner.defaultAgent(),
    get defaultProblem() { return inner.defaultProblem; },
    resolve: (idOrHandle) => inner.resolve(idOrHandle),
    reload() {
      // Assigned only after `load()` returned: a throw leaves `inner` alone,
      // and the listeners are not told about a swap that never happened.
      inner = load();
      for (const listener of listeners) {
        try {
          listener();
        } catch (err) {
          onListenerError(err);
        }
      }
    },
    onReload(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    current: () => inner,
  };
}

let cached: { env: NodeJS.ProcessEnv; catalog: ReloadableAgentCatalog } | undefined;

/**
 * The process-wide catalog. Memoised per `env` object: the provider ref is
 * pinned from the environment at load, so a different environment is a
 * different catalog rather than a stale one.
 */
export function gatewayCatalog(env: NodeJS.ProcessEnv = process.env): ReloadableAgentCatalog {
  if (cached && cached.env === env) return cached.catalog;
  const catalog = reloadableCatalog(() => loadGatewayCatalog({ env }));
  cached = { env, catalog };
  return catalog;
}

/**
 * Publish the wiring's catalog as *the* process catalog.
 *
 * `createWiring` builds a catalog against the registry it just built, and the
 * mission runner reaches for `gatewayCatalog()` when nobody handed it one. Two
 * catalogs in one process would mean a reload that reaches one of them and not
 * the other, which is exactly the half-working reload this whole mechanism
 * exists to avoid. So the composition root adopts its own.
 */
export function adoptProcessCatalog(
  env: NodeJS.ProcessEnv,
  catalog: ReloadableAgentCatalog,
): void {
  cached = { env, catalog };
}
