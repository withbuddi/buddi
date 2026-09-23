/**
 * `GET /api/agents/:id/tools` — every installed tool, for the picker on the
 * agent sheet's Setup tab.
 *
 * The page knows no tool by name, so everything that makes one row different
 * from another is decided here and arrives as data:
 *
 *  - **the group** is the plugin that ships the tool (by manifest, falling back
 *    to the dotted prefix for the platform's own tools, as the profile does);
 *  - **the glob** a group saves as when every tool in it is checked — offered
 *    only when `<prefix>.*` resolves to exactly that group and none of it is a
 *    write tool, so the page can never save a glob the server would refuse or
 *    one that would reach further than the boxes it ticked;
 *  - **grantable** is false for the tools that create, change and remove
 *    agents: `checkTools` refuses them from any door but a text editor, so the
 *    picker draws them and never lets them be checked;
 *  - **core** marks the memory tools a new agent starts with. Informational
 *    on the page: removable, with a confirm;
 *  - **suggested** is, for an agent accepted from a plugin's proposal, what
 *    that proposal names today and the file does not grant. Nothing is added
 *    by this route or by the page on its own.
 */
import path from 'node:path';
import { GATED_TIERS, resolveToolGrants, type AgentCatalog, type ToolRegistry } from '@buddi/core';
import { PLATFORM_WRITE_TOOLS } from '../agents/platform-names.js';
import { coreTools } from '../agents/core-tools.js';
import { readProvenance } from '../plugins/provenance.js';

export interface PickerTool {
  name: string;
  description: string;
  tier: string;
  gated: boolean;
  /** False for the agent-writing tools: granted only by editing the file by hand. */
  grantable: boolean;
  /** One of the tools a new agent starts with. */
  core: boolean;
}

export interface PickerGroup {
  plugin: string;
  /** What to save when every tool here is checked; absent when a glob would not mean exactly this group. */
  glob?: string;
  tools: PickerTool[];
}

export interface PickerSuggestion {
  plugin: string;
  /** The sentence the page prints as the heading. */
  label: string;
  tools: Array<{ name: string; description: string }>;
}

export interface ToolPickerView {
  id: string;
  groups: PickerGroup[];
  /** What the agent holds now, globs expanded. */
  granted: string[];
  suggested?: PickerSuggestion;
}

export interface ToolPickerDeps {
  catalog: AgentCatalog;
  registry: Pick<ToolRegistry, 'list' | 'manifests'>;
}

export function readToolPicker(deps: ToolPickerDeps, idOrHandle: string): ToolPickerView | undefined {
  const agent = deps.catalog.get(idOrHandle) ?? deps.catalog.byHandle(idOrHandle);
  if (!agent) return undefined;

  const specs = deps.registry.list();
  const pluginOf = new Map<string, string>();
  for (const manifest of deps.registry.manifests()) {
    for (const tool of manifest.tools) pluginOf.set(tool.name, manifest.name);
  }
  const core = new Set(coreTools(deps.registry));
  const prefix = (name: string): string => name.split('.')[0] ?? name;

  const groups: PickerGroup[] = [];
  const byPlugin = new Map<string, PickerGroup>();
  for (const spec of specs) {
    const plugin = pluginOf.get(spec.name) ?? prefix(spec.name);
    let group = byPlugin.get(plugin);
    if (!group) {
      group = { plugin, tools: [] };
      byPlugin.set(plugin, group);
      groups.push(group);
    }
    group.tools.push({
      name: spec.name,
      description: spec.description,
      tier: spec.tier,
      gated: (GATED_TIERS as readonly string[]).includes(spec.tier),
      grantable: !PLATFORM_WRITE_TOOLS.includes(spec.name),
      core: core.has(spec.name),
    });
  }

  for (const group of groups) {
    const prefixes = new Set(group.tools.map((t) => prefix(t.name)));
    if (prefixes.size !== 1) continue;
    const family = [...prefixes][0] as string;
    const reach = specs.filter((s) => prefix(s.name) === family).length;
    if (reach !== group.tools.length) continue;
    if (group.tools.some((t) => !t.grantable)) continue;
    group.glob = `${family}.*`;
  }

  const granted = [...agent.tools];
  const suggested = suggestionFor(deps, path.dirname(agent.file), granted);
  return { id: agent.id, groups, granted, ...(suggested ? { suggested } : {}) };
}

/**
 * What the plugin's proposal names today that this agent does not hold.
 *
 * Read from the `plugin.json` beside the file and the manifest as installed
 * now. A proposal naming a tool this installation does not have, or a write
 * tool, is not offered: the picker could not save it.
 */
function suggestionFor(deps: ToolPickerDeps, agentDir: string, granted: readonly string[]): PickerSuggestion | undefined {
  const provenance = readProvenance(agentDir);
  if (!provenance) return undefined;
  const manifest = deps.registry.manifests().find((m) => m.name === provenance.plugin);
  const proposal = manifest?.agents?.find((a) => a.id.toLowerCase() === provenance.agent.toLowerCase());
  if (!proposal) return undefined;
  let names: string[];
  try {
    names = resolveToolGrants(proposal.tools, deps.registry, proposal.id).tools;
  } catch {
    names = proposal.tools.filter((name) => deps.registry.list().some((s) => s.name === name));
  }
  const specs = new Map(deps.registry.list().map((s) => [s.name, s]));
  const missing = names.filter((name) => !granted.includes(name) && !PLATFORM_WRITE_TOOLS.includes(name));
  if (missing.length === 0) return undefined;
  return {
    plugin: provenance.plugin,
    label: `Suggested by the ${provenance.plugin} plugin since you accepted`,
    tools: missing.map((name) => ({ name, description: specs.get(name)?.description ?? '' })),
  };
}
