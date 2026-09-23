/**
 * The tools every new agent starts with: the memory plugin's.
 *
 * An agent without them forgets everything between conversations, which is
 * almost never what the owner meant by asking for one. So a new agent made
 * through `platform.create_agent` is granted them unless the request says
 * otherwise, and the picker tags them "core". A plugin's own proposal is left
 * exactly as the plugin wrote it: omitting them there is the plugin's call.
 */
import type { ToolRegistry } from '@buddi/core';

/** The plugin whose tools every new agent starts with. */
export const CORE_PLUGIN = 'memory';

/** The core tool names on this installation: empty when the memory plugin is not installed. */
export function coreTools(registry: Pick<ToolRegistry, 'manifests'>): string[] {
  return registry.manifests().find((m) => m.name === CORE_PLUGIN)?.tools.map((t) => t.name) ?? [];
}

/** The grant with the core tools appended, unless it already reaches them or the request opted out. */
export function withCoreTools(
  tools: readonly string[],
  registry: Pick<ToolRegistry, 'manifests'>,
  optOut: boolean,
): string[] {
  const core = coreTools(registry);
  if (optOut || core.length === 0) return [...tools];
  const family = `${CORE_PLUGIN}.*`;
  if (tools.some((t) => t.trim() === family)) return [...tools];
  return [...tools, ...core.filter((name) => !tools.some((t) => t.trim() === name))];
}
