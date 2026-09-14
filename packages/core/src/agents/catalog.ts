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
 *  - two agents answering to one `@handle` (case-insensitively) is a load error:
 *    the handle is what the owner types, and it must name exactly one agent;
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
import {
  loadSkillsDir,
  skillAdmits,
  skillsSection,
  SkillFileError,
  SKILLS_DIR,
  type Skill,
  type SkillProvenance,
} from './skills.js';

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
      | 'duplicate-handle'
      | 'unresolvable-tool'
      | 'multiple-defaults'
      | 'no-default-agent'
      | 'agent-file'
      | 'skill-file'
      | 'unknown-skill'
      | 'duplicate-skill',
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
  /** How the owner addresses it: `@ledger`. Unique across the catalog. */
  handle: string;
  name: string;
  description: string;
  isDefault: boolean;
}

/** One colleague as an agent's prompt sees it. */
export interface AgentRosterEntry {
  handle: string;
  name: string;
  description: string;
}

/** A skill as the catalog reports it: enough to trace it, not its whole text. */
export interface CatalogAgentSkill {
  name: string;
  provenance: SkillProvenance;
  file: string;
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
  /** Skills composed into the prompt, private first, then shared. */
  skills: CatalogAgentSkill[];
  /** The persona plus the generated sections; still carries `{{today}}`. */
  systemPromptTemplate: string;
  /** The runnable definition for one turn, with `{{today}}` substituted. */
  definition(now: Date): AgentDefinition;
}

export interface AgentCatalog {
  get(id: string): CatalogAgent | undefined;
  /** By `@handle`, case-insensitively and with or without the leading `@`. */
  byHandle(handle: string): CatalogAgent | undefined;
  list(): AgentSummary[];
  defaultAgent(): CatalogAgent;
  /**
   * An id, a handle, or the default when nothing is given. Unknown names throw
   * — never silently the default.
   */
  resolve(idOrHandle?: string): CatalogAgent;
}

export interface LoadAgentCatalogOptions {
  /** Directory holding `<id>/agent.md` subdirectories. */
  dir: string;
  registry: ToolNameSource;
  env: NodeJS.ProcessEnv;
  /**
   * Directory of shared skills. Defaults to `skills/` next to the agents
   * directory (so `<repo>/agents` pairs with `<repo>/skills`). A missing
   * directory simply means no shared skills.
   */
  skillsDir?: string;
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
export function generatedSection(
  tools: readonly string[],
  language: AgentLanguage,
  wiring?: { handle: string; colleagues: readonly AgentRosterEntry[] },
): string {
  const toolLine =
    tools.length === 0
      ? 'You have no tools in this installation. Answer from the conversation alone, and say plainly when something needs a tool you do not have.'
      : `Tools available to you in this installation: ${tools.join(', ')}.`;
  const lines = [`- ${toolLine}`, `- ${LANGUAGE_LINE[language]}`];
  if (wiring) {
    lines.push(
      `- Your handle is @${wiring.handle}. The owner addresses you by writing @${wiring.handle} at the start of a message; refer to yourself as @${wiring.handle} when naming agents.`,
    );
    if (wiring.colleagues.length === 0) {
      lines.push('- You are the only agent installed here. There is nobody to hand work to.');
    } else {
      lines.push(
        '- The owner\'s other agents, and how to name them:',
        ...wiring.colleagues.map((c) => `  - @${c.handle} — ${c.name}: ${c.description}`),
        '- Always name another agent by its handle, never by its id.',
      );
    }
  }
  return `## Your wiring (generated, authoritative)\n${lines.join('\n')}`;
}

/**
 * Which skills this agent loads.
 *
 *  - every private skill under `agents/<id>/skills/`, unconditionally;
 *  - every shared skill whose `agents` filter admits this agent — no filter
 *    means every agent, which is how a house rule reaches agents whose files
 *    nobody edited.
 *
 * `skills:` in the frontmatter is an explicit request by name; a name that is
 * not a shared skill, or is one this agent is not admitted to, fails the load
 * rather than quietly composing a prompt missing its procedure.
 */
export function selectSkills(
  agentId: string,
  declared: readonly string[],
  privateSkills: readonly Skill[],
  sharedSkills: readonly Skill[],
): Skill[] {
  const chosen: Skill[] = [...privateSkills];
  const byName = new Map(privateSkills.map((s) => [s.name, s]));

  for (const skill of sharedSkills) {
    const shadowed = byName.get(skill.name);
    if (shadowed !== undefined) {
      throw new AgentCatalogError(
        'duplicate-skill',
        `agent "${agentId}": shared skill "${skill.name}" (${skill.file}) collides with its own ` +
          `skill (${shadowed.file}); one name, one procedure`,
      );
    }
  }

  for (const name of declared) {
    const skill = sharedSkills.find((s) => s.name === name);
    if (skill === undefined) {
      throw new AgentCatalogError(
        'unknown-skill',
        `agent "${agentId}" declares skill "${name}", which is not a shared skill ` +
          `(shared: ${sharedSkills.map((s) => s.name).join(', ') || 'none'})`,
      );
    }
    if (!skillAdmits(skill, agentId)) {
      throw new AgentCatalogError(
        'unknown-skill',
        `agent "${agentId}" declares skill "${name}", which lists agents ` +
          `${(skill.agents ?? []).join(', ')} and not this one`,
      );
    }
  }

  for (const skill of sharedSkills) {
    if (skillAdmits(skill, agentId) || declared.includes(skill.name)) chosen.push(skill);
  }
  return chosen;
}

function buildAgent(
  frontmatter: AgentFrontmatter,
  body: string,
  file: string,
  sharedSkills: readonly Skill[],
  opts: LoadAgentCatalogOptions,
  roster: readonly AgentRosterEntry[] = [],
): CatalogAgent {
  const tools = resolveToolNames(frontmatter.tools, opts.registry, frontmatter.id);
  const language: AgentLanguage = frontmatter.language ?? 'mirror';
  const provider = providerFromEnv(opts.env, frontmatter.model);
  const privateSkills = readSkills(path.join(path.dirname(file), SKILLS_DIR), 'private');
  const skills = selectSkills(frontmatter.id, frontmatter.skills ?? [], privateSkills, sharedSkills);
  const section = skillsSection(skills);
  const colleagues = roster.filter((entry) => entry.handle !== frontmatter.handle);
  const systemPromptTemplate = [
    body.trimEnd(),
    ...(section === '' ? [] : [section]),
    generatedSection(tools, language, { handle: frontmatter.handle, colleagues }),
  ].join('\n\n');
  const maxTurns = frontmatter.maxTurns ?? DEFAULT_MAX_TURNS;

  return {
    id: frontmatter.id,
    handle: frontmatter.handle,
    name: frontmatter.name,
    description: frontmatter.description,
    isDefault: frontmatter.default === true,
    file,
    model: provider.model,
    tools,
    maxTurns,
    language,
    provider,
    skills: skills.map(({ name, provenance, file: skillFile }) => ({
      name,
      provenance,
      file: skillFile,
    })),
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

/** Read one skills directory, re-labelling a parse failure as a catalog error. */
function readSkills(dir: string, scope: 'private' | 'shared'): Skill[] {
  try {
    return loadSkillsDir(dir, scope);
  } catch (err) {
    if (err instanceof SkillFileError) throw new AgentCatalogError('skill-file', err.message);
    throw err;
  }
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

  const sharedSkills = readSkills(
    opts.skillsDir ?? path.join(path.dirname(path.resolve(opts.dir)), SKILLS_DIR),
    'shared',
  );

  // Two passes: every file is parsed before any prompt is composed, because the
  // wiring tail names the agent's colleagues and no agent can know them alone.
  const files: { frontmatter: AgentFrontmatter; body: string; file: string }[] = [];
  const seenIds = new Set<string>();
  const seenHandles = new Map<string, string>();

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
    const { id, handle } = parsed.frontmatter;
    if (seenIds.has(id)) {
      throw new AgentCatalogError('duplicate-agent', `duplicate agent id: ${id}`);
    }
    // Case-insensitively: the owner types `@Ledger` as readily as `@ledger`,
    // and two agents answering to one spoken name is an ambiguity, not a nuance.
    const key = handle.toLowerCase();
    const taken = seenHandles.get(key);
    if (taken !== undefined) {
      throw new AgentCatalogError(
        'duplicate-handle',
        `duplicate agent handle "@${handle}": ${taken} and ${id} both answer to it`,
      );
    }
    seenIds.add(id);
    seenHandles.set(key, id);
    files.push({ frontmatter: parsed.frontmatter, body: parsed.body, file });
  }

  const roster: AgentRosterEntry[] = files.map(({ frontmatter }) => ({
    handle: frontmatter.handle,
    name: frontmatter.name,
    description: frontmatter.description,
  }));

  const agents = new Map<string, CatalogAgent>();
  const byHandle = new Map<string, CatalogAgent>();
  const defaults: string[] = [];

  for (const { frontmatter, body, file } of files) {
    const agent = buildAgent(frontmatter, body, file, sharedSkills, opts, roster);
    agents.set(agent.id, agent);
    byHandle.set(agent.handle.toLowerCase(), agent);
    if (agent.isDefault) defaults.push(agent.id);
  }

  if (defaults.length > 1) {
    throw new AgentCatalogError(
      'multiple-defaults',
      `exactly one agent may be default; ${defaults.join(' and ')} both declare it`,
    );
  }

  const known = [...agents.values()].map((a) => `${a.id} (@${a.handle})`);
  return {
    get: (id) => agents.get(id),
    byHandle: (handle) => byHandle.get(handle.trim().replace(/^@/, '').toLowerCase()),
    list: () =>
      [...agents.values()].map(({ id, handle, name, description, isDefault }) => ({
        id,
        handle,
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
    resolve(idOrHandle?: string): CatalogAgent {
      if (idOrHandle === undefined || idOrHandle.trim() === '') return this.defaultAgent();
      const wanted = idOrHandle.trim();
      const agent =
        agents.get(wanted) ?? byHandle.get(wanted.replace(/^@/, '').toLowerCase());
      if (!agent) throw new UnknownAgentError(wanted, known);
      return agent;
    },
  };
}
