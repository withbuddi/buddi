/**
 * The two things the dashboard composer needs from the gateway beyond a send:
 * the commands plugins add to its `/` menu, and what a run is told when the
 * owner's message names a teammate or runs one of those commands
 * (docs/dashboard.md, The composer).
 *
 * Both are words, never actions. A mention does not route the message
 * anywhere: the agent the owner is talking to is told who was named and how it
 * can reach them, and it decides. A plugin command is the owner's `/name`
 * sent to that agent, which is told which plugin it is from and what it is
 * for.
 */
import type { AgentCatalog, CatalogAgent, PluginCommand, ToolRegistry } from '@buddi/core';
import { ROLE_MAKER } from '../agents/roles.js';

/** The chat's own commands: a plugin's command by one of these names is left out. */
export const CHAT_COMMANDS: readonly string[] = ['use', 'new', 'stop', 'quiet'];

/** What the page is handed for a plugin's command. */
export interface ComposerCommand {
  plugin: string;
  name: string;
  description: string;
  args?: string;
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_PER_PLUGIN = 12;

/** One plugin's declared commands, the malformed and the clashing left out. */
export function validCommands(declared: readonly PluginCommand[] | undefined): PluginCommand[] {
  if (!Array.isArray(declared)) return [];
  const seen = new Set<string>();
  const kept: PluginCommand[] = [];
  for (const c of declared) {
    if (!c || typeof c.name !== 'string' || typeof c.description !== 'string') continue;
    const name = c.name.trim().replace(/^\//, '').toLowerCase();
    const description = c.description.trim();
    if (!NAME.test(name) || CHAT_COMMANDS.includes(name) || seen.has(name)) continue;
    if (description === '' || description.length > 120) continue;
    const args = typeof c.args === 'string' && c.args.trim() !== '' && c.args.length <= 40 ? c.args.trim() : undefined;
    seen.add(name);
    kept.push({ name, description, ...(args ? { args } : {}) });
    if (kept.length >= MAX_PER_PLUGIN) break;
  }
  return kept;
}

/** Every installed plugin's commands, in registration order; the first plugin to claim a name keeps it. */
export function pluginCommands(registry: Pick<ToolRegistry, 'manifests'>): ComposerCommand[] {
  const taken = new Set<string>();
  const out: ComposerCommand[] = [];
  for (const manifest of registry.manifests()) {
    for (const c of validCommands(manifest.commands)) {
      if (taken.has(c.name)) continue;
      taken.add(c.name);
      out.push({ plugin: manifest.name, ...c });
    }
  }
  return out;
}

const holdsDelegate = (tools: readonly string[]): boolean => tools.some((t) => t === 'agent.delegate' || t === 'agent.*');

/** The colleagues a message names with `@handle`, in order, the agent itself and unknown handles left out. */
export function mentionedAgents(text: string, catalog: Pick<AgentCatalog, 'byHandle'>, selfId: string): CatalogAgent[] {
  const out: CatalogAgent[] = [];
  // Not in code: a handle inside backticks is something quoted, not someone asked.
  const prose = text.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
  for (const match of prose.matchAll(/(^|[\s(])@([a-z][a-z0-9-]{0,39})\b/gi)) {
    const agent = catalog.byHandle(match[2]!.toLowerCase());
    if (!agent || agent.id === selfId || out.some((a) => a.id === agent.id)) continue;
    out.push(agent);
  }
  return out;
}

/**
 * What one turn is told about the owner's words, or undefined when there is
 * nothing to tell: who was named and how to reach them, and which plugin a
 * leading `/command` belongs to.
 *
 * The maker is not handled here when the message *starts* with it: the page
 * borrows the maker for that message instead (its own turn, its own thread).
 */
export function composerTurnNote(input: {
  agent: Pick<CatalogAgent, 'id' | 'tools'>;
  text: string;
  catalog: Pick<AgentCatalog, 'byHandle'>;
  commands?: readonly ComposerCommand[];
}): string | undefined {
  const lines: string[] = [];
  const command = /^\/([a-z][a-z0-9-]*)(?:\s|$)/.exec(input.text.trim());
  const known = command ? input.commands?.find((c) => c.name === command[1]) : undefined;
  if (known) {
    lines.push(
      `The owner ran /${known.name}, a command from the ${known.plugin} plugin: ${known.description}. ` +
        'Do what it says with the tools you hold, taking any words after the command as its input; if you hold none that can, say so in one sentence.',
    );
  }
  const named = mentionedAgents(input.text, input.catalog, input.agent.id);
  if (named.length > 0) {
    const who = named.map((a) => `@${a.handle} (${a.name}${a.roles?.includes(ROLE_MAKER) ? ', who makes and changes agents' : ''})`).join(', ');
    lines.push(
      holdsDelegate(input.agent.tools)
        ? `The owner names ${who} in this message: ask ${named.length > 1 ? 'them' : 'that colleague'} with agent.delegate for what the owner wants from them, then relay the answer in your reply, credited by handle.`
        : `The owner names ${who} in this message, but you cannot hand work to a colleague (you do not hold agent.delegate). ` +
          `Say so in one sentence and suggest /use @${named[0]!.handle} to talk to them directly; then help with the rest yourself.`,
    );
  }
  return lines.length > 0 ? lines.join('\n') : undefined;
}

/** `/quiet` with no onboarding row to write to: the sentence Telegram and the terminal say. */
export const QUIET_UNAVAILABLE_TEXT = 'There is nothing proactive running here yet, so there is nothing to quieten.';
