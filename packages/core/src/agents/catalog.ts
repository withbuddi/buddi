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
 * One thing is deliberately *not* fail-closed at the catalog level: a
 * credential this machine does not have. An agent pinned to a provider whose
 * key is absent is loaded and marked **unavailable**, with the typed problem
 * that says why, and every other agent loads normally. A missing key for one
 * agent may never take the installation down — the owner who has not signed up
 * for a second provider must still be able to run the four agents they have.
 * Running an unavailable agent still fails closed: the run path resolves the
 * provider itself, and resolution is where the refusal lives.
 *
 * The catalog knows tools only through the registry contract, and never reads
 * `process.env` itself: the caller passes `env`, as everywhere else in core.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AgentDefinition } from '../agent.js';
import { resolveProvider, type ProviderKind, type ProviderProblem, type ProviderRef } from '../provider.js';
import { localDateString, timezoneFromEnv } from '../time.js';
import { AgentFileError, parseAgentFile, type AgentFrontmatter } from './frontmatter.js';
import { providerFromEnv } from './provider-from-env.js';
import type { AgentSource } from './search-path.js';
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
  /** Which company this agent's runs go to. `provider` on a `CatalogAgent`
   * is the whole pinned ref; a summary carries only its kind. */
  providerKind: ProviderKind;
  /** Capabilities this agent claims (`overview`, `recap`), declaration order. */
  roles: string[];
  /**
   * Which half of the search path this agent came from: an example shipped
   * with the repo, or the owner's private set. Recorded rather than inferred,
   * so `buddi agents` can say where a persona lives without re-deriving paths.
   */
  source: AgentSource;
  /** False when this machine cannot reach the agent's provider credential. */
  available: boolean;
  /** Why not, in one sentence. Present only when `available` is false. */
  unavailableReason?: string;
}

/**
 * Whether this installation can actually run the agent, as a result union — the
 * same shape `resolveProvider` uses, because it is that answer, kept.
 */
export type AgentAvailability =
  | { ok: true }
  | { ok: false; problem: ProviderProblem };

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
  /**
   * Resolution, done once at load with the `env` the caller passed. Not a
   * credential: the secret itself is never held here, only whether one was
   * reachable and what the problem is when it was not.
   */
  availability: AgentAvailability;
  /** Skills composed into the prompt, private first, then shared. */
  skills: CatalogAgentSkill[];
  /** The persona plus the generated sections; still carries `{{today}}`. */
  systemPromptTemplate: string;
  /**
   * The runnable definition for one turn, with `{{today}}` substituted. The
   * date is the owner's calendar day, not UTC's: `timezone` defaults to the
   * catalog's (from `BUDDI_TZ` in the `env` the loader was handed).
   */
  definition(now: Date, timezone?: string): AgentDefinition;
}

/**
 * Nobody claims the role a surface asked for. A typed problem, not an error:
 * an installation whose agents do not do overviews is a *configuration*, and
 * the surface says so in one sentence instead of throwing.
 */
export interface RoleProblem {
  code: 'no-agent-for-role';
  role: string;
  message: string;
}

/** `{ ok: true; agent }` or the typed problem — never a half-answer. */
export type RoleResolution =
  | { ok: true; agent: CatalogAgent }
  | { ok: false; problem: RoleProblem };

/** The frontmatter key an owner adds to make an agent answer for a role. */
export const ROLES_KEY = 'roles';

/** One sentence naming the key, for a surface to print verbatim. */
export function roleProblemMessage(role: string): string {
  return (
    `No installed agent provides the "${role}" role. ` +
    `Add \`${ROLES_KEY}: [${role}]\` to the frontmatter of an agent file ` +
    `(agents/<id>/agent.md) and it will answer this.`
  );
}

export interface AgentCatalog {
  get(id: string): CatalogAgent | undefined;
  /** Every agent claiming this role, in catalog (declaration) order. */
  agentsWithRole(role: string): CatalogAgent[];
  /**
   * The agent that answers for this role: the first that claims it, in
   * declaration order. A role nobody claims is a typed problem, never a throw
   * and never silently the default agent.
   */
  agentForRole(role: string): RoleResolution;
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

/** One directory on the search path, and what it contributes. */
export interface AgentDirSpec {
  /** Directory holding `<id>/agent.md` subdirectories. */
  dir: string;
  /** Shared skills for this entry. Defaults to `skills/` next to `dir`. */
  skillsDir?: string;
  /** Recorded on every agent loaded from here. Defaults to `private`. */
  source?: AgentSource;
}

export interface LoadAgentCatalogOptions {
  /** Installation-owned account metadata. Core never reads credentials or SQL. */
  providerSelection?: (agent: AgentFrontmatter) => { provider: ProviderRef; availability: AgentAvailability };
  /**
   * A single directory — the original shape, kept because most tests and every
   * ad-hoc caller means exactly one. A directory that cannot be read is an
   * error here, as it always was.
   */
  dir?: string;
  /**
   * The search path, earliest first. A later entry providing the same agent id
   * *replaces* the earlier one wholesale — the file, never a merge — and the
   * same holds for a shared skill by name. A directory that is not on disk is
   * skipped; only a path where *nothing* exists is an error.
   */
  dirs?: ReadonlyArray<string | AgentDirSpec>;
  registry: ToolNameSource;
  env: NodeJS.ProcessEnv;
  /**
   * Directory of shared skills for the single-directory form. Defaults to
   * `skills/` next to the agents directory (so `<repo>/agents` pairs with
   * `<repo>/skills`). A missing directory simply means no shared skills.
   */
  skillsDir?: string;
}

/**
 * `YYYY-MM-DD` in the owner's zone — the same rendering the tools use for
 * dates. UTC is never the answer: at 8 PM in New York it is already tomorrow
 * there, and the agent would greet the owner with the wrong day.
 */
export function toDateString(now: Date, timezone: string = timezoneFromEnv()): string {
  return localDateString(now, timezone);
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
 *
 * Its sibling is `surfaceSection` in `../surfaces.js`, generated from the same
 * principle and composed immediately after this one at run time. It is not
 * baked in here because the surface is a property of the *run*, not of the
 * agent file: one persona answers on Telegram and on the dashboard.
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
  source: AgentSource,
  sharedSkills: readonly Skill[],
  opts: LoadAgentCatalogOptions,
  roster: readonly AgentRosterEntry[] = [],
): CatalogAgent {
  const tools = resolveToolNames(frontmatter.tools, opts.registry, frontmatter.id);
  // The owner's zone, read from the env the caller passed — the catalog still
  // never reaches for `process.env` itself.
  const catalogTimezone = timezoneFromEnv(opts.env);
  const language: AgentLanguage = frontmatter.language ?? 'mirror';
  const selection = opts.providerSelection?.(frontmatter);
  const provider = selection?.provider ?? providerFromEnv(opts.env, frontmatter.model, frontmatter.provider);
  // Fail *soft* here and fail closed at run time: see the file header.
  const resolution = resolveProvider(provider, opts.env);
  const availability: AgentAvailability = selection?.availability ?? (resolution.ok
    ? { ok: true }
    : { ok: false, problem: resolution.problem });
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
    roles: [...(frontmatter.roles ?? [])],
    source,
    providerKind: provider.kind,
    available: availability.ok,
    ...(availability.ok ? {} : { unavailableReason: availability.problem.message }),
    file,
    model: provider.model,
    tools,
    maxTurns,
    language,
    provider,
    availability,
    skills: skills.map(({ name, provenance, file: skillFile }) => ({
      name,
      provenance,
      file: skillFile,
    })),
    systemPromptTemplate,
    definition(now: Date, timezone: string = catalogTimezone): AgentDefinition {
      return {
        id: frontmatter.id,
        name: frontmatter.name,
        systemPrompt: injectToday(systemPromptTemplate, localDateString(now, timezone)),
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

/**
 * Normalise whichever shape the caller used into an ordered search path.
 *
 * `dir` (one directory, missing is an error) is the original contract and is
 * kept exactly; `dirs` is the search path, where a directory that is simply
 * not there is skipped.
 */
function searchEntries(opts: LoadAgentCatalogOptions): {
  specs: Array<Required<Pick<AgentDirSpec, 'dir' | 'skillsDir'>> & { source: AgentSource }>;
  strict: boolean;
} {
  const raw: AgentDirSpec[] =
    opts.dirs !== undefined
      ? opts.dirs.map((entry) => (typeof entry === 'string' ? { dir: entry } : entry))
      : opts.dir !== undefined
        ? [{ dir: opts.dir, ...(opts.skillsDir === undefined ? {} : { skillsDir: opts.skillsDir }) }]
        : [];
  if (raw.length === 0) {
    throw new AgentCatalogError('agents-dir-missing', 'no agents directory was given (pass dir or dirs)');
  }
  return {
    specs: raw.map((spec) => ({
      dir: spec.dir,
      skillsDir: spec.skillsDir ?? path.join(path.dirname(path.resolve(spec.dir)), SKILLS_DIR),
      source: spec.source ?? 'private',
    })),
    strict: opts.dirs === undefined,
  };
}

interface ParsedAgentFile {
  frontmatter: AgentFrontmatter;
  body: string;
  file: string;
  source: AgentSource;
  /** Which entry of the search path it came from; later wins. */
  order: number;
}

/**
 * Load one directory. Duplicate ids *within* a directory stay an error — two
 * files in one folder claiming one id is a mistake, not an override; overriding
 * is what the next directory on the path is for.
 */
function readAgentDir(dir: string, source: AgentSource, order: number): ParsedAgentFile[] {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();

  const files: ParsedAgentFile[] = [];
  const seenIds = new Set<string>();
  for (const dirName of entries) {
    const file = path.join(dir, dirName, AGENT_FILE);
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
    const { id } = parsed.frontmatter;
    if (seenIds.has(id)) {
      throw new AgentCatalogError('duplicate-agent', `duplicate agent id: ${id}`);
    }
    seenIds.add(id);
    files.push({ frontmatter: parsed.frontmatter, body: parsed.body, file, source, order });
  }
  return files;
}

/**
 * Read every directory on the search path, later entries overriding earlier
 * ones by agent id and by skill name.
 */
export function loadAgentCatalog(opts: LoadAgentCatalogOptions): AgentCatalog {
  const { specs, strict } = searchEntries(opts);

  // Skills first: a private skill replaces an example one of the same name, so
  // an owner's house rule wins over anything the repo ships.
  const skillsByName = new Map<string, Skill>();
  const byId = new Map<string, ParsedAgentFile>();
  let read = 0;

  for (const [order, spec] of specs.entries()) {
    let loaded: ParsedAgentFile[];
    try {
      loaded = readAgentDir(spec.dir, spec.source, order);
    } catch (err) {
      // A parse or duplicate-id failure inside a directory is the owner's
      // mistake and must stay loud; only an unreadable directory is skippable.
      if (err instanceof AgentCatalogError) throw err;
      if (strict) {
        throw new AgentCatalogError(
          'agents-dir-missing',
          `cannot read agents directory ${spec.dir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      continue; // a search-path directory that is not on disk contributes nothing
    }
    read += 1;
    for (const skill of readSkills(spec.skillsDir, 'shared')) skillsByName.set(skill.name, skill);
    // Wholesale replacement: the later file, not a merge of two personas.
    for (const entry of loaded) byId.set(entry.frontmatter.id, entry);
  }

  if (read === 0) {
    throw new AgentCatalogError(
      'agents-dir-missing',
      `no agents directory exists on the search path: ${specs.map((s) => s.dir).join(', ')}`,
    );
  }

  const sharedSkills = [...skillsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const files = [...byId.values()].sort((a, b) => a.frontmatter.id.localeCompare(b.frontmatter.id));

  // Handles are checked *after* overriding: an example agent replaced by a
  // private one of the same id never collides with the file that replaced it.
  const seenHandles = new Map<string, string>();
  for (const { frontmatter } of files) {
    const key = frontmatter.handle.toLowerCase();
    const taken = seenHandles.get(key);
    if (taken !== undefined) {
      throw new AgentCatalogError(
        'duplicate-handle',
        `duplicate agent handle "@${frontmatter.handle}": ${taken} and ${frontmatter.id} both answer to it`,
      );
    }
    seenHandles.set(key, frontmatter.id);
  }

  const roster: AgentRosterEntry[] = files.map(({ frontmatter }) => ({
    handle: frontmatter.handle,
    name: frontmatter.name,
    description: frontmatter.description,
  }));

  const agents = new Map<string, CatalogAgent>();
  const byHandle = new Map<string, CatalogAgent>();
  const claimed: Array<{ id: string; order: number }> = [];

  for (const { frontmatter, body, file, source, order } of files) {
    const agent = buildAgent(frontmatter, body, file, source, sharedSkills, opts, roster);
    agents.set(agent.id, agent);
    byHandle.set(agent.handle.toLowerCase(), agent);
    if (agent.isDefault) claimed.push({ id: agent.id, order });
  }

  /*
   * Two directories may both ship a `default: true` — the example agent does,
   * and so does the owner's front desk. That is not an ambiguity: the later
   * entry on the search path wins, exactly as it does for a file. Two agents
   * claiming it *within one directory* is still an error, because there is
   * nothing to break the tie.
   */
  const lastClaim = Math.max(...claimed.map((c) => c.order), -1);
  const defaults = claimed.filter((c) => c.order === lastClaim).map((c) => c.id);
  // An example that lost the tie is no longer the default, and must not keep
  // saying it is: `buddi agents` prints this flag.
  for (const { id } of claimed) {
    if (!defaults.includes(id)) (agents.get(id) as { isDefault: boolean }).isDefault = false;
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
      [...agents.values()].map((a) => ({
        id: a.id,
        handle: a.handle,
        name: a.name,
        description: a.description,
        isDefault: a.isDefault,
        roles: [...a.roles],
        source: a.source,
        providerKind: a.providerKind,
        available: a.availability.ok,
        ...(a.availability.ok
          ? {}
          : { unavailableReason: a.availability.problem.message }),
      })),
    agentsWithRole: (role) => {
      const wanted = role.trim().toLowerCase();
      return [...agents.values()].filter((a) => a.roles.includes(wanted));
    },
    agentForRole(role): RoleResolution {
      const agent = this.agentsWithRole(role)[0];
      return agent
        ? { ok: true, agent }
        : {
            ok: false,
            problem: {
              code: 'no-agent-for-role',
              role,
              message: roleProblemMessage(role),
            },
          };
    },
    defaultAgent(): CatalogAgent {
      const id = defaults[0];
      if (id === undefined) {
        throw new AgentCatalogError(
          'no-default-agent',
          `no agent in ${specs.map((entry) => entry.dir).join(', ')} declares "default: true"`,
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
