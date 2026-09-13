/**
 * The agent catalog — agents are configuration files, not code.
 *
 * `agents/<id>/agent.md` is the whole definition: frontmatter wires the agent
 * (tools, model, turn budget), the markdown body is the persona. Loading is
 * fail-closed on every axis that could silently widen behaviour:
 *
 *  - a tool entry that resolves to nothing in the registry is a load error, so a
 *    persona never instructs the model to call something that is not installed;
 *  - two agents claiming `default: true` is a load error — "the agent used when a
 *    chat has no active one" must be unambiguous;
 *  - an unknown id at resolve time throws, it is never coerced to the default.
 *
 * The catalog knows tools only through the registry contract, and never reads
 * `process.env` itself: the caller passes `env`, as everywhere else in core.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AgentDefinition } from '../agent.js';
import type { ProviderRef } from '../provider.js';
import { AgentFileError, parseAgentFile, type AgentFrontmatter } from './frontmatter.js';
import { providerFromEnv } from './provider-from-env.js';

/** Default turn budget when the agent file does not pin one. */
export const DEFAULT_MAX_TURNS = 12;

/** The agent file inside each `agents/<id>/` directory. */
export const AGENT_FILE = 'agent.md';

export type AgentLanguage = 'mirror' | 'en' | 'fr';

/** All the catalog needs from a `ToolRegistry`; the real one satisfies it. */
export interface ToolNameSource {
  list(): ReadonlyArray<{ name: string }>;
}

export class AgentCatalogError extends Error {
  override readonly name = 'AgentCatalogError';
  constructor(
    readonly code:
      | 'agents-dir-missing'
      | 'duplicate-agent'
      | 'unresolvable-tool'
      | 'multiple-defaults'
      | 'no-default-agent'
      | 'agent-file',
    message: string,
  ) {
    super(message);
  }
}

export class UnknownAgentError extends Error {
  override readonly name = 'UnknownAgentError';
  readonly code = 'unknown-agent';
  constructor(agentId: string, known: readonly string[]) {
    super(`unknown agent "${agentId}" (known: ${known.join(', ') || 'none'})`);
  }
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  isDefault: boolean;
}

export interface CatalogAgent extends AgentSummary {
  /** Where the file came from — quoted in errors, never in a prompt. */
  file: string;
  model: string;
  /** Tool names resolved against the registry, in registry order. */
  tools: string[];
  maxTurns: number;
  language: AgentLanguage;
  provider: ProviderRef;
  /** The persona plus the generated sections; still carries `{{today}}`. */
  systemPromptTemplate: string;
  /** The runnable definition for one turn, with `{{today}}` substituted. */
  definition(now: Date): AgentDefinition;
}

export interface AgentCatalog {
  get(id: string): CatalogAgent | undefined;
  list(): AgentSummary[];
  defaultAgent(): CatalogAgent;
  /** `id` or the default. Unknown ids throw — never silently the default. */
  resolve(id?: string): CatalogAgent;
}

export interface LoadAgentCatalogOptions {
  /** Directory holding `<id>/agent.md` subdirectories. */
  dir: string;
  registry: ToolNameSource;
  env: NodeJS.ProcessEnv;
}

/** `YYYY-MM-DD` in UTC — the same rendering the tools use for dates. */
export function toDateString(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Substitute every `{{today}}` placeholder. Pure; tested. */
export function injectToday(template: string, today: string): string {
  return template.split('{{today}}').join(today);
}

/** `finance.*` style globs; `*` matches any run of characters, `?` exactly one. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.split('*').join('.*').split('?').join('.')}$`);
}

/**
 * Resolve the declared entries against the registry, preserving registry order
 * and de-duplicating overlaps. An entry matching nothing fails the load.
 */
export function resolveToolNames(
  declared: readonly string[],
  registry: ToolNameSource,
  agentId: string,
): string[] {
  const available = registry.list().map((t) => t.name);
  const selected = new Set<string>();
  for (const entry of declared) {
    const matches = entry.includes('*') || entry.includes('?')
      ? available.filter((name) => globToRegExp(entry).test(name))
      : available.filter((name) => name === entry);
    if (matches.length === 0) {
      throw new AgentCatalogError(
        'unresolvable-tool',
        `agent "${agentId}" declares tool "${entry}", which matches no registered tool ` +
          `(registered: ${available.join(', ') || 'none'})`,
      );
    }
    for (const name of matches) selected.add(name);
  }
  return available.filter((name) => selected.has(name));
}

const LANGUAGE_LINE: Record<AgentLanguage, string> = {
  mirror:
    "Reply in the language the owner's latest message is written in. Never switch language on your own.",
  en: 'Always reply in English, whatever language the owner writes in.',
  fr: 'Réponds toujours en français, quelle que soit la langue du message.',
};

/**
 * The generated tail of the system prompt. The tool list is generated rather
 * than written into the persona, so a file can never claim a tool it was not
 * granted, nor go stale when the plugin ships one more.
 */
export function generatedSection(tools: readonly string[], language: AgentLanguage): string {
  const toolLine =
    tools.length === 0
      ? 'You have no tools in this installation. Answer from the conversation alone, and say plainly when something needs a tool you do not have.'
      : `Tools available to you in this installation: ${tools.join(', ')}.`;
  return `## Your wiring (generated, authoritative)\n- ${toolLine}\n- ${LANGUAGE_LINE[language]}`;
}

function buildAgent(
  frontmatter: AgentFrontmatter,
  body: string,
  file: string,
  opts: LoadAgentCatalogOptions,
): CatalogAgent {
  const tools = resolveToolNames(frontmatter.tools, opts.registry, frontmatter.id);
  const language: AgentLanguage = frontmatter.language ?? 'mirror';
  const provider = providerFromEnv(opts.env, frontmatter.model);
  const systemPromptTemplate = `${body.trimEnd()}\n\n${generatedSection(tools, language)}`;
  const maxTurns = frontmatter.maxTurns ?? DEFAULT_MAX_TURNS;

  return {
    id: frontmatter.id,
    name: frontmatter.name,
    description: frontmatter.description,
    isDefault: frontmatter.default === true,
    file,
    model: provider.model,
    tools,
    maxTurns,
    language,
    provider,
    systemPromptTemplate,
    definition(now: Date): AgentDefinition {
      return {
        id: frontmatter.id,
        name: frontmatter.name,
        systemPrompt: injectToday(systemPromptTemplate, toDateString(now)),
        tools,
        provider,
        maxTurns,
      };
    },
  };
}

/** Read `<dir>/<id>/agent.md` for every subdirectory, in sorted id order. */
export function loadAgentCatalog(opts: LoadAgentCatalogOptions): AgentCatalog {
  let entries: string[];
  try {
    entries = readdirSync(opts.dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (err) {
    throw new AgentCatalogError(
      'agents-dir-missing',
      `cannot read agents directory ${opts.dir}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const agents = new Map<string, CatalogAgent>();
  const defaults: string[] = [];

  for (const dirName of entries) {
    const file = path.join(opts.dir, dirName, AGENT_FILE);
    try {
      statSync(file);
    } catch {
      continue; // a directory without an agent.md is not an agent
    }
    let parsed;
    try {
      parsed = parseAgentFile(readFileSync(file, 'utf8'), { dirName, file });
    } catch (err) {
      if (err instanceof AgentFileError) throw new AgentCatalogError('agent-file', err.message);
      throw err;
    }
    const agent = buildAgent(parsed.frontmatter, parsed.body, file, opts);
    if (agents.has(agent.id)) {
      throw new AgentCatalogError('duplicate-agent', `duplicate agent id: ${agent.id}`);
    }
    agents.set(agent.id, agent);
    if (agent.isDefault) defaults.push(agent.id);
  }

  if (defaults.length > 1) {
    throw new AgentCatalogError(
      'multiple-defaults',
      `exactly one agent may be default; ${defaults.join(' and ')} both declare it`,
    );
  }

  const ids = [...agents.keys()];
  return {
    get: (id) => agents.get(id),
    list: () =>
      [...agents.values()].map(({ id, name, description, isDefault }) => ({
        id,
        name,
        description,
        isDefault,
      })),
    defaultAgent(): CatalogAgent {
      const id = defaults[0];
      if (id === undefined) {
        throw new AgentCatalogError(
          'no-default-agent',
          `no agent in ${opts.dir} declares "default: true"`,
        );
      }
      return agents.get(id) as CatalogAgent;
    },
    resolve(id?: string): CatalogAgent {
      if (id === undefined || id.trim() === '') return this.defaultAgent();
      const agent = agents.get(id);
      if (!agent) throw new UnknownAgentError(id, ids);
      return agent;
    },
  };
}
