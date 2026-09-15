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
 *    that never asked for one.
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
import type { PluginManifest, ToolRegistry } from '@buddi/core';
import {
  createDelegateTool,
  type DelegateCatalog,
  type RuntimeProvider,
} from '@buddi/runtime';
import { AGENTS_DIR } from './catalog.js';
import { delegateToWriterRefusal, writeToolsIn } from './platform-names.js';

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
  const file = path.join(agentsDir, agentId, DELEGATES_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
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
  return parsed as string[];
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
export function createDelegationManifest(
  registry: ToolRegistry,
  opts: DelegationManifestOptions = {},
): PluginManifest {
  const agentsDir = opts.agentsDir ?? AGENTS_DIR;
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
          return readDelegates(agentId, agentsDir).filter((targetId) => {
            // `DelegateCatalog` exposes the grant through the definition it
            // would run with, which is the same resolved list the loader built.
            const held = writeToolsIn(catalog.get(targetId)?.definition(new Date()).tools ?? []);
            if (held.length === 0) return true;
            throw new Error(delegateToWriterRefusal(agentId, targetId, held));
          });
        },
      }),
    ],
  };
}
