/**
 * Delegation, wired for this installation (roadmap step 5).
 *
 * The runtime owns the `agent.delegate` tool and every authorization rule in it;
 * this file owns the two things that are installation-specific:
 *
 *  - **who may ask whom** — `agents/<id>/delegates.json`, a plain JSON array of
 *    agent ids sitting next to the persona. It is deliberately a *sibling file*
 *    rather than a frontmatter key: an allowlist is authorization, and the file
 *    that the model's persona lives in is not where authorization belongs. No
 *    file means no delegation, which is the fail-closed default for every agent
 *    that never asked for one — except the front desk and the maker, which ask
 *    everyone unless a file narrows them, and `"*"` in a file means everyone
 *    (`@buddi/core`'s `delegates.ts` holds the rule). An agent the maker
 *    creates holding `agent.delegate` and naming no list is written `["*"]`
 *    (`defaultDelegatesFor`): delegation by default, chosen here in the
 *    gateway, never by the persona.
 *  - **what the nested run uses** — the process catalog and the resolved
 *    provider, bound *after* the registry exists. The registry is built before
 *    the catalog (agent files are resolved against the registry), so the tool
 *    cannot be handed a catalog at construction: it takes a getter, and
 *    `bindDelegation` fills it in once the catalog and provider are up.
 *
 * Binding is per registry (a `WeakMap`), so two registries in one process — a
 * test's and the app's — never see each other's wiring. An unbound registry
 * refuses to delegate rather than reaching for an ambient default.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { delegateScope, resolveDelegates, type PluginManifest, type ToolRegistry } from '@buddi/core';
import {
  createDelegateTool,
  type DelegateCatalog,
  type RuntimeProvider,
} from '@buddi/runtime';
import { AGENTS_DIR } from './catalog.js';
import { delegateToWriterRefusal, writeToolsIn } from './platform-names.js';
import { writeFilesAtomic } from './platform-files.js';

/** Plugin family name for the agent-to-agent tools. */
export const AGENT_PLUGIN = 'agent';

/** The allowlist file, next to `agent.md` in the agent's own directory. */
export const DELEGATES_FILE = 'delegates.json';

/**
 * Read `agents/<id>/delegates.json`.
 *
 * Missing file -> `[]`: an agent that never declared colleagues delegates to
 * nobody. A file that exists but is not a JSON array of ids throws — a typo in
 * an authorization file must be loud, and the throw reaches the model as a
 * refusal, never as a silently empty allowlist that looks like policy.
 */
export function readDelegates(agentId: string, agentsDir: string = AGENTS_DIR): string[] {
  return readDelegatesFile(agentId, agentsDir) ?? [];
}

/**
 * The same file, telling "no file" (`undefined`) apart from an empty list: a
 * front-desk or maker agent with no file asks everyone, with `[]` nobody.
 */
export function readDelegatesFile(agentId: string, agentsDir: string = AGENTS_DIR): string[] | undefined {
  const file = path.join(agentsDir, agentId, DELEGATES_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== 'string' || id.trim() === '')) {
    throw new Error(`${file} must be a JSON array of agent ids, e.g. ["credit-coach"]`);
  }
  // A file the owner edited twice can name the same colleague twice. It is one
  // permission either way, and a prompt that lists it twice reads as if there
  // were two of them.
  return [...new Set((parsed as string[]).map((id) => id.trim()))];
}

/** What a new agent from the maker may ask when it holds the tool and names nobody: everyone. */
export const DEFAULT_NEW_AGENT_DELEGATES: readonly string[] = ['*'];

/**
 * The allowlist `platform.create_agent` writes. An explicit list (even `[]`)
 * is written as given; an agent that holds `agent.delegate` and names none
 * gets `["*"]`, so a new teammate can ask the others from its first message
 * and the owner narrows it in Setup; one without the tool gets no file.
 * Market packages bring their own `delegates` and never pass through here.
 */
export function defaultDelegatesFor(tools: readonly string[], delegates: readonly string[] | null): string[] | null {
  if (delegates !== null) return [...delegates];
  return tools.includes('agent.delegate') ? [...DEFAULT_NEW_AGENT_DELEGATES] : null;
}

export interface DelegationBinding {
  catalog: DelegateCatalog;
  /** The caller's provider; used for a colleague with no adapter of its own. */
  provider: RuntimeProvider;
  /**
   * The adapter for one target agent. Provider choice is pinned per agent, so
   * delegating to a colleague on another provider must reach that provider —
   * anything else would send the owner's data to a company their agent file
   * does not name. Optional only so an older caller still binds; when it is
   * absent every nested run uses `provider`.
   */
  providerFor?: (agent: { id: string }) => RuntimeProvider;
  /**
   * The `session` tools a delegate may hold (docs/browser.md, "Delegates"):
   * `['browser.act']` only when the asking conversation has a browser session
   * open. The delegation tool asks it only for a run with a live owner
   * request at depth 0, so a mission's delegate never gets here.
   */
  delegableSession?: (ctx: { agentId?: string; conversationId?: string }) => readonly string[];
}

const bindings = new WeakMap<ToolRegistry, DelegationBinding>();

/** Wire a registry's delegation tool once the catalog and provider exist. */
export function bindDelegation(registry: ToolRegistry, binding: DelegationBinding): void {
  bindings.set(registry, binding);
}

function boundOrThrow(registry: ToolRegistry): DelegationBinding {
  const binding = bindings.get(registry);
  if (!binding) {
    throw new Error(
      'delegation refused: this process has no agent catalog bound, so no colleague can be reached',
    );
  }
  return binding;
}

export interface DelegationManifestOptions {
  /** Where `<id>/delegates.json` lives. Defaults to the repo's `agents/`. */
  agentsDir?: string;
}

/**
 * The `agent` plugin manifest: one tool, no schema of its own.
 *
 * It owns no tables — delegation writes only to `core.conversations`,
 * `core.messages` and `core.events`, which core already owns — so it ships no
 * migrations and is not in `installedManifests()`, which is the list `db:migrate`
 * walks.
 */
/**
 * The allowlist as delegation applies it: the file's entries, minus any agent
 * that can write the installation, which is refused at the point of use. The
 * same list serves `group.ask`, so a room never widens who may ask whom.
 */
export function delegateAllowlist(
  agentId: string,
  catalog: AllowlistCatalog,
  agentsDir: string = AGENTS_DIR,
): string[] {
  return resolveAllowlist(agentId, catalog, readDelegatesFile(agentId, agentsDir));
}

/** What resolving an allowlist reads from the catalog. `DelegateCatalog` and `AgentCatalog` both fit. */
export interface AllowlistCatalog {
  get(id: string): { definition(now: Date): { tools: string[] } } | undefined;
  list(): ReadonlyArray<{ id: string }>;
}

function rolesOf(catalog: AllowlistCatalog, agentId: string): string[] {
  const roles = (catalog.get(agentId) as { roles?: unknown } | undefined)?.roles;
  return Array.isArray(roles) ? roles.filter((r): r is string => typeof r === 'string') : [];
}

function writesHeldBy(catalog: AllowlistCatalog, id: string): string[] {
  return writeToolsIn(catalog.get(id)?.definition(new Date()).tools ?? []);
}

/** Each dangling `agent -> target` pair is logged once per process, not on every turn. */
const danglingNoted = new Set<string>();

/**
 * An allowlist can name an agent that is no longer installed: one removed
 * before removal cleaned the lists, a file restored from a backup, a hand
 * edit. That id grants nothing (there is nobody to reach), so it is ignored
 * rather than failing the load or the call, and said once in the log.
 */
function noteDangling(agentId: string, targetId: string): void {
  const key = `${agentId}\u0000${targetId}`;
  if (danglingNoted.has(key)) return;
  danglingNoted.add(key);
  console.warn(`${agentId}/${DELEGATES_FILE} names "${targetId}", which is not installed; ignoring it.`);
}

/** One allowlist rewrite, worked out before anything moves. See `stageDelegateStrip`. */
export interface DelegateEdit {
  /** The agent whose list it is. */
  id: string;
  path: string;
  content: string;
}

/**
 * The allowlist edits removing one agent needs: every other agent's list that
 * names it, without that id. Nothing is written, so this runs before the
 * agent moves and a read that throws costs nothing. A missing or unreadable
 * file is left out (the loader tolerates the dangling id).
 */
export function stageDelegateStrip(
  removedId: string,
  agents: ReadonlyArray<{ id: string; agentsDir: string }>,
): DelegateEdit[] {
  const edits: DelegateEdit[] = [];
  for (const { id, agentsDir } of agents) {
    if (id === removedId) continue;
    let stored: string[] | undefined;
    try {
      stored = readDelegatesFile(id, agentsDir);
    } catch {
      continue;
    }
    if (stored === undefined || !stored.includes(removedId)) continue;
    const next = stored.filter((target) => target !== removedId);
    edits.push({ id, path: path.join(agentsDir, id, DELEGATES_FILE), content: `${JSON.stringify(next, null, 2)}\n` });
  }
  return edits;
}

/**
 * Write staged allowlist edits, each on its own: one that fails (a read-only
 * folder, a full disk) is named in `failed` and the rest still go through.
 * It never throws — the agent has already moved by now, and what follows its
 * move (catalog reload, mission pausing, the recovery path) must still happen.
 */
export function applyDelegateEdits(edits: readonly DelegateEdit[]): { changed: string[]; failed: string[] } {
  const changed: string[] = [];
  const failed: string[] = [];
  for (const edit of edits) {
    try {
      writeFilesAtomic([{ path: edit.path, content: edit.content }]);
      changed.push(edit.id);
    } catch (err) {
      console.warn(`could not update ${edit.id}/${DELEGATES_FILE}: ${err instanceof Error ? err.message : String(err)}`);
      failed.push(edit.id);
    }
  }
  return { changed, failed };
}

/**
 * Strip one id from the allowlists in the given agent directories, after that
 * agent was removed: `stageDelegateStrip` then `applyDelegateEdits`. Returns
 * the agents whose list changed and those whose list could not be written.
 */
export function stripDelegate(
  removedId: string,
  agents: ReadonlyArray<{ id: string; agentsDir: string }>,
): { changed: string[]; failed: string[] } {
  return applyDelegateEdits(stageDelegateStrip(removedId, agents));
}

/**
 * The allowlist as delegation applies it, from the stored file (`undefined`:
 * none). An open list ("everyone", by role or by `"*"`) is every other agent
 * in the catalog that does not write the installation — a writer is simply not
 * in "everyone". An explicit list that names a writer is refused, loudly; one
 * that names an agent not installed has that id ignored (`noteDangling`).
 */
export function resolveAllowlist(
  agentId: string,
  catalog: AllowlistCatalog,
  stored: readonly string[] | undefined,
): string[] {
  const agent = { id: agentId, roles: rolesOf(catalog, agentId) };
  if (delegateScope(agent, stored).kind === 'everyone') {
    const everyone = catalog.list().map((a) => a.id).filter((id) => writesHeldBy(catalog, id).length === 0);
    return resolveDelegates(agent, stored, everyone);
  }
  return resolveDelegates(agent, stored, []).filter((targetId) => {
    if (catalog.get(targetId) === undefined) {
      noteDangling(agentId, targetId);
      return false;
    }
    const held = writesHeldBy(catalog, targetId);
    if (held.length === 0) return true;
    throw new Error(delegateToWriterRefusal(agentId, targetId, held));
  });
}

export function createDelegationManifest(
  registry: ToolRegistry,
  opts: DelegationManifestOptions = {},
): PluginManifest {
  const configured = opts.agentsDir;
  /*
   * Whose `delegates.json`? The caller's own directory, which the catalog
   * knows: on a search path the owner's agents and the shipped examples do
   * not share an `agents/`, and reading the allowlist from the wrong half
   * would refuse a delegation the owner did grant. An explicit `agentsDir`
   * (a test, a fixture) still wins, and a catalog that cannot say where an
   * agent's file is falls back to the repo's.
   */
  const dirFor = (agentId: string, catalog: DelegateCatalog): string => {
    if (configured !== undefined) return configured;
    const file = (catalog.get(agentId) as { file?: unknown } | undefined)?.file;
    return typeof file === 'string' && file !== '' ? path.dirname(path.dirname(file)) : AGENTS_DIR;
  };
  return {
    name: AGENT_PLUGIN,
    version: '0.1.0',
    schema: AGENT_PLUGIN,
    migrationsDir: '',
    tools: [
      createDelegateTool({
        catalog: () => boundOrThrow(registry).catalog,
        provider: (agent) => {
          const binding = boundOrThrow(registry);
          return binding.providerFor?.(agent) ?? binding.provider;
        },
        registry,
        delegableSession: (ctx) => bindings.get(registry)?.delegableSession?.(ctx) ?? [],
        /*
         * The allowlist, with the one entry it may never contain removed at the
         * point of use as well as at load. An agent that can write the
         * installation must not be reachable *through* another agent: that
         * would put `platform.create_agent` one delegation away from the agent
         * that reads untrusted mail. Caught here too, because a file can change
         * under a running process.
         */
        allowlistFor: (agentId) => {
          const catalog = boundOrThrow(registry).catalog;
          // `DelegateCatalog` exposes the grant through the definition it
          // would run with, which is the same resolved list the loader built.
          return resolveAllowlist(agentId, catalog, readDelegatesFile(agentId, dirFor(agentId, catalog)));
        },
      }),
    ],
  };
}
