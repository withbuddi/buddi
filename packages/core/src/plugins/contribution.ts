/**
 * What a plugin contributes, in the words an owner reads *before* installing it.
 *
 * Installing a plugin is running somebody else's code in the process that holds
 * this owner's money, mail and keys. There is no sandbox here and pretending
 * otherwise would be worse than saying so, so the whole safety story is: it is
 * explicit, and before it happens the owner sees the complete list of what
 * arrives. This module is that list.
 *
 * Two things decide the shape:
 *
 *  - **tier `auto` is the loud part.** A tool at `auto` runs with no human in
 *    the loop the first time a model decides to call it. A plugin that quietly
 *    ships one is the case this summary exists for, so `auto` tools are counted
 *    in the headline, listed first, and never folded into a total. An
 *    `ownerOnly` tool is *not* one of them whatever its tier: no model is told
 *    it exists, so nothing but the owner's own click can call it, and counting
 *    it under "runs without asking you" overstates what arrives.
 *  - **anything that runs on a timer is named with its period.** A sentinel or
 *    a source needs nobody to ask: it wakes up. "Runs every 6 hours, by itself"
 *    is a fact about what the owner is agreeing to, not a footnote.
 *
 * Everything here is pure — a manifest in, a structure and text out — so it can
 * be rendered by the CLI, by a tool that answers "what would this install", and
 * by a test, without a database, a disk or a process.
 */
import type { PluginManifest, Tier } from '../tools.js';
import { PLUGIN_USE_WORDS, parsePluginUses, type PluginUse } from '../plugin/uses.js';

export interface ContributedTool {
  name: string;
  tier: Tier;
  description: string;
  /** No model ever sees it: the owner calls it from one of the plugin's pages. */
  ownerOnly?: boolean;
}

export interface ContributedTimer {
  id: string;
  description: string;
  /** Period in seconds. */
  every: number;
}

export interface ContributedAgent {
  id: string;
  handle: string;
  name: string;
  description: string;
  /** Exactly as the plugin declared it — names and family globs. */
  tools: string[];
  roles: string[];
  skills: string[];
}

export interface PluginContribution {
  name: string;
  version: string;
  description?: string;
  /** The Postgres schema it will own, or undefined when it owns no tables. */
  schema?: string;
  tools: ContributedTool[];
  /** The subset that runs with nobody asked. Never folded into a total. */
  autoTools: ContributedTool[];
  gatedTools: ContributedTool[];
  /**
   * The subset only the owner can call, from one of the plugin's own pages.
   *
   * Counted apart from both of the others, and that is the whole point: an
   * `ownerOnly` tool at tier `auto` is not "runs without asking you" — no
   * model is ever told it exists, and the only thing that can call it is the
   * owner clicking something. Listing it under the loud heading was a summary
   * that overstated what an installation brings, which is the one direction
   * this summary must never be wrong in.
   */
  ownerTools: ContributedTool[];
  sentinels: ContributedTimer[];
  sources: ContributedTimer[];
  missions: Array<{ id: string; name: string; cron: string; agent: string }>;
  agents: ContributedAgent[];
  skills: Array<{ name: string; description: string }>;
  views: number;
  network: Array<{ host: string; why: string }>;
  /** The areas of buddi it declares it reaches beyond itself (`uses`). */
  uses: PluginUse[];
}

/** Everything one manifest brings, as data. */
export function contributionOf(manifest: PluginManifest): PluginContribution {
  const tools: ContributedTool[] = manifest.tools.map((tool) => ({
    name: tool.name,
    tier: tool.tier,
    description: tool.description,
    ...(tool.ownerOnly === true ? { ownerOnly: true } : {}),
  }));
  const agentTools = tools.filter((t) => t.ownerOnly !== true);
  return {
    name: manifest.name,
    version: manifest.version,
    ...(manifest.description === undefined ? {} : { description: manifest.description }),
    ...(manifest.schema && manifest.schema !== 'core' ? { schema: manifest.schema } : {}),
    tools,
    autoTools: agentTools.filter((t) => t.tier === 'auto'),
    gatedTools: agentTools.filter((t) => t.tier !== 'auto'),
    ownerTools: tools.filter((t) => t.ownerOnly === true),
    sentinels: (manifest.sentinels ?? []).map((s) => ({
      id: s.id,
      description: s.description,
      every: s.every,
    })),
    sources: (manifest.sources ?? []).map((s) => ({
      id: s.id,
      description: s.description,
      every: s.every,
    })),
    missions: (manifest.missions ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      cron: m.cron,
      agent: m.agentId !== undefined ? `@${m.agentId}` : `whichever agent has the "${m.agentRole ?? 'default'}" role`,
    })),
    agents: (manifest.agents ?? []).map((a) => ({
      id: a.id,
      handle: a.handle,
      name: a.name,
      description: a.description,
      tools: [...a.tools],
      roles: [...(a.roles ?? [])],
      skills: (a.skills ?? []).map((s) => s.name),
    })),
    skills: (manifest.skills ?? []).map((s) => ({ name: s.name, description: s.description })),
    views: (manifest.views ?? []).length,
    network: (manifest.network ?? []).map((n) => ({ host: n.host, why: n.why })),
    // An unreadable list is refused at `register()`; here it is shown as
    // nothing rather than thrown, so the summary can always be drawn.
    uses: (() => {
      const parsed = parsePluginUses(manifest.uses, 'uses');
      return parsed.ok ? parsed.uses : [];
    })(),
  };
}

/** The first sentence of a description, clipped — an owner is not reading a paragraph. */
function oneLine(text: string, max = 110): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const stop = /[.:?!](\s|$)/.exec(flat);
  const sentence = stop ? flat.slice(0, stop.index + 1) : flat;
  return sentence.length <= max ? sentence : `${sentence.slice(0, max - 1).trimEnd()}…`;
}

/** `every 6 hours`, `every 15 minutes`, `every 30 seconds`. */
export function humanPeriod(seconds: number): string {
  if (seconds % 86_400 === 0) return `every ${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`;
  if (seconds % 3_600 === 0) return `every ${seconds / 3_600} hour${seconds === 3_600 ? '' : 's'}`;
  if (seconds % 60 === 0) return `every ${seconds / 60} minute${seconds === 60 ? '' : 's'}`;
  return `every ${seconds} seconds`;
}

/**
 * The summary, as lines.
 *
 * The order is the order of the questions an owner actually asks: what is this,
 * what can it do without me, what does it own, what will it do on its own, what
 * does it want to talk to, and what is it offering to become.
 */
export function renderContribution(c: PluginContribution): string[] {
  const lines: string[] = [];
  lines.push(`${c.name} ${c.version}${c.description === undefined ? '' : ` — ${c.description}`}`);
  lines.push('');
  lines.push('Installing this runs code written by somebody else inside buddi, with the same');
  lines.push('reach as the rest of it. Here is everything it contributes.');
  lines.push('');

  lines.push(`TOOLS (${c.tools.length})`);
  if (c.tools.length === 0) lines.push('  none.');
  if (c.autoTools.length > 0) {
    lines.push(
      `  ${c.autoTools.length} run WITHOUT ASKING YOU (tier auto): an agent that holds them calls them`,
    );
    lines.push('  on its own, and you find out afterwards.');
    for (const tool of c.autoTools) lines.push(`    ${tool.name} — ${oneLine(tool.description)}`);
  }
  if (c.gatedTools.length > 0) {
    lines.push(`  ${c.gatedTools.length} need your approval before they do anything:`);
    for (const tool of c.gatedTools) lines.push(`    ${tool.name} (${tool.tier}) — ${oneLine(tool.description)}`);
  }
  if (c.ownerTools.length > 0) {
    lines.push(
      `  ${c.ownerTools.length} only you can use from its pages; no agent ever sees them:`,
    );
    for (const tool of c.ownerTools) lines.push(`    ${tool.name} — ${oneLine(tool.description)}`);
  }
  lines.push('');

  lines.push('DATA');
  lines.push(
    c.schema === undefined
      ? '  It owns no tables of its own.'
      : `  It owns the Postgres schema "${c.schema}" and applies its own migrations there.`,
  );
  lines.push('');

  const timers = [
    ...c.sentinels.map((s) => ({ ...s, kind: 'watcher' })),
    ...c.sources.map((s) => ({ ...s, kind: 'source' })),
  ];
  lines.push(`ON A TIMER (${timers.length})`);
  if (timers.length === 0) lines.push('  Nothing. It acts only when an agent calls one of its tools.');
  for (const timer of timers) {
    lines.push(`  ${timer.id} (${timer.kind}) — ${humanPeriod(timer.every)}: ${oneLine(timer.description)}`);
  }
  lines.push('');

  lines.push(...renderUses(c.uses));
  lines.push('');

  lines.push(`NETWORK (${c.network.length})`);
  if (c.network.length === 0) {
    lines.push('  It declares no outbound host. Nothing enforces that — an undeclared host means');
    lines.push('  the author did not write one down, not that the plugin cannot reach the network.');
  }
  for (const use of c.network) lines.push(`  ${use.host} — ${use.why}`);
  lines.push('');

  lines.push(`AGENTS IT PROPOSES (${c.agents.length})`);
  if (c.agents.length === 0) lines.push('  None. Installing it creates no agent.');
  for (const agent of c.agents) {
    lines.push(`  ${agent.name} (@${agent.handle}) — ${oneLine(agent.description)}`);
    lines.push(`    would be granted: ${agent.tools.join(', ') || 'nothing'}`);
    if (agent.roles.length > 0) lines.push(`    roles: ${agent.roles.join(', ')}`);
    if (agent.skills.length > 0) lines.push(`    skills: ${agent.skills.join(', ')}`);
  }
  lines.push('  Nothing here is created by installing. Each one is an offer you approve, one at a');
  lines.push('  time, seeing the whole grant — or never accept at all.');
  lines.push('');

  lines.push(`MISSIONS IT SUGGESTS (${c.missions.length})`);
  if (c.missions.length === 0) lines.push('  None.');
  for (const mission of c.missions) {
    lines.push(`  ${mission.id} — "${mission.cron}", run by ${mission.agent}`);
  }
  if (c.missions.length > 0) lines.push('  Suggestions: `buddi missions add-defaults` is you accepting them.');

  if (c.skills.length > 0) {
    lines.push('');
    lines.push(`SHARED SKILLS IT PROPOSES (${c.skills.length})`);
    for (const skill of c.skills) lines.push(`  ${skill.name} — ${oneLine(skill.description)}`);
  }
  if (c.views > 0) {
    lines.push('');
    lines.push(`It also ships ${c.views} view descriptor${c.views === 1 ? '' : 's'}: how its results are drawn`);
    lines.push('on the dashboard. Descriptors are data; they run no code in the browser.');
  }
  return lines;
}

/**
 * The areas of buddi a plugin reaches beyond itself, one plain line each —
 * the same lines the install card on the dashboard shows. `added` marks the
 * ones an upgrade brings that the installed version did not have.
 */
export function renderUses(uses: readonly PluginUse[], added: readonly PluginUse[] = []): string[] {
  const lines = [`IN BUDDI, BEYOND ITSELF (${uses.length})`];
  if (uses.length === 0) lines.push('  Nothing beyond its own schema, its own folder and its own tools\' approvals.');
  for (const use of uses) {
    lines.push(`  It ${PLUGIN_USE_WORDS[use]}.${added.includes(use) ? '  (NEW in this version)' : ''}`);
  }
  return lines;
}

/** One line for `buddi plugins list`. */
export function contributionHeadline(c: PluginContribution): string {
  const parts = [`${c.tools.length} tools`];
  if (c.autoTools.length > 0) parts.push(`${c.autoTools.length} auto`);
  if (c.sentinels.length + c.sources.length > 0) {
    parts.push(`${c.sentinels.length + c.sources.length} on a timer`);
  }
  if (c.agents.length > 0) parts.push(`${c.agents.length} agents proposed`);
  if (c.missions.length > 0) parts.push(`${c.missions.length} missions suggested`);
  return parts.join(', ');
}
