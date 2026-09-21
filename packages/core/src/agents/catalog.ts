/**
 * The agent catalog — agents are configuration files, not code.
 *
 * `agents/<id>/agent.md` is the whole definition: frontmatter wires the agent
 * (tools, model, turn budget), the markdown body is the persona. Loading is
 * fail-closed on every axis that could silently widen behaviour:
 *
 *  - a tool entry that resolves to nothing in the registry is a load error, so a
 *    persona never instructs the model to call something that is not installed;
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
 * **Which agent is the default is not one of those axes any more.** It is a
 * fact about the *installation*, not about a file: the owner picks it on the
 * dashboard and the gateway records it (see `defaultAgentId`). The file flag
 * survives as a fallback for an installation that has never recorded one, and
 * a tree where zero or several files claim it is no longer fatal — the catalog
 * loads, the first runnable agent answers, and `defaultProblem` says what the
 * files disagree about so a surface can offer the fix.
 *
 * The catalog knows tools only through the registry contract, and never reads
 * `process.env` itself: the caller passes `env`, as everywhere else in core.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AgentDefinition, ThinkingSetting } from '../agent.js';
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
  /**
   * Set when a tool family this agent was granted is not installed here. The
   * agent is listed and greyed rather than missing, and never runs.
   */
  heldBack?: AgentHoldBack;
  /** One sentence in the agent's own voice, for a surface that opens on it. */
  intro?: string;
  /** Up to three example requests a surface may offer as drafts. */
  starters?: string[];
  /** An emoji, or an image file name inside the agent's folder. */
  avatar?: string;
  /** `#rrggbb`, the agent's own colour. */
  accent?: string;
}

/**
 * Whether this installation can actually run the agent, as a result union — the
 * same shape `resolveProvider` uses, because it is that answer, kept.
 */
export type AgentProblem =
  | ProviderProblem
  /** A granted tool family no loaded plugin provides. See `AgentHoldBack`. */
  | { code: 'missing-plugin'; message: string };

export type AgentAvailability =
  | { ok: true }
  | { ok: false; problem: AgentProblem };

/** One colleague as an agent's prompt sees it. */
export interface AgentRosterEntry {
  /**
   * Whether this installation can run the colleague right now. A prompt that
   * offers a colleague with no brain behind it sends the model to delegate
   * into a refusal; saying so is cheaper than the round trip. Absent means
   * "as far as this roster knows, yes".
   */
  available?: boolean;
  /**
   * The catalog id. Handles are how the owner and the agents name each other;
   * the id is what `agent.delegate` takes, so a prompt that lists colleagues
   * to delegate to has to carry both or the model invents one.
   */
  id: string;
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
  /**
   * Tool names resolved against the registry, in registry order. Empty for a
   * held-back agent: it is granted nothing until its plugin is installed.
   */
  tools: string[];
  maxTurns: number;
  thinking?: ThinkingSetting;
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

/**
 * The files disagree about who the default is, and the catalog decided anyway.
 *
 * Typed rather than thrown, for the reason a missing credential is: an
 * installation whose files claim the default twice — or not at all — is a
 * *configuration*, and it must still answer while the owner fixes it. The
 * dashboard turns this into one sentence and a picker.
 */
export interface DefaultAgentProblem {
  code: 'multiple-defaults' | 'no-default-agent';
  /** The ids that claim it, in catalog order. Empty for `no-default-agent`. */
  agents: string[];
  /** One sentence a surface may print verbatim. */
  message: string;
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
  /**
   * The agent a chat that names nobody lands on, resolved in this order:
   *
   *  1. the installation's recorded choice (`defaultAgentId`), when it names a
   *     loaded agent this machine can actually run;
   *  2. the single file that declares `default: true`;
   *  3. the first runnable agent in roster order — never an error, because an
   *     installation with agents in it always has somewhere to land.
   *
   * Throws only when there is no agent at all.
   */
  defaultAgent(): CatalogAgent;
  /** Set when the *files* disagree about the default. See `DefaultAgentProblem`. */
  readonly defaultProblem?: DefaultAgentProblem;
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
   * Which plugin provides a tool family, for the held-back sentence. Core has
   * no idea what is installable — the gateway reads the record and the
   * built-ins — so an installation that can name the plugin says "the finance
   * plugin" and one that cannot says "the finance tools".
   */
  pluginForFamily?: (family: string) => string | undefined;
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
   * The installation's recorded default agent, by id or handle.
   *
   * The owner's choice, held by the installation rather than by a file — core
   * does not know where it is kept (the gateway reads it out of
   * `core.web_settings`), only that it wins over every file flag when it names
   * a loaded agent this machine can run. An id that names nothing, or names an
   * agent that cannot run, is ignored rather than fatal: a removed plugin or a
   * lapsed credential must not leave the installation with nowhere to land.
   */
  defaultAgentId?: string;
  /**
   * Who each agent may delegate to, by id. The allowlist is an installation's
   * file (`agents/<id>/delegates.json`), which core does not read: the gateway
   * hands the answer in so the generated wiring can name the colleagues an
   * agent is allowed to ask — with their ids, which is what the tool takes.
   * It is a *description* of authorization, never the authorization itself;
   * the delegate tool checks the file again at the point of use.
   */
  delegatesFor?: (agentId: string, agentsDir: string) => readonly string[];
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
 * A grant that only a *plugin* could satisfy: `family.something`, where the
 * family is a plain identifier. `finance.*` and `finance.list_accounts` are
 * both of this shape; `send_mail`, `finance`, `fin*.x` are not — nothing that
 * could be installed would make them resolve, so they stay load errors.
 */
const FAMILY_GRANT = /^([a-z][a-z0-9_-]*)\.(.+)$/;

/** What a grant list resolved to, and which families nothing here provides. */
export interface ToolGrantResolution {
  /** Names resolved against the registry, in registry order. */
  tools: string[];
  /**
   * Families the agent was granted that no loaded plugin provides, in
   * declaration order. Non-empty means the agent is held back (see
   * `AgentHoldBack`) rather than loaded with a narrower grant: an agent that
   * silently lost half its tools would answer wrongly instead of not at all.
   */
  missingFamilies: string[];
}

/**
 * Resolve the declared entries against the registry, preserving registry order
 * and de-duplicating overlaps.
 *
 * Two kinds of failure, deliberately told apart:
 *
 *  - a grant naming a family *nothing registered here provides at all* is a
 *    missing plugin. That is a state of the installation, not a mistake in the
 *    file: `finance.*` is exactly right the moment the finance plugin is
 *    installed. It is collected, and the caller holds the agent back.
 *  - anything else — a tool name inside a family that *is* loaded, an entry
 *    that is not family-shaped — is the owner's mistake and still throws. No
 *    install would fix it, and a persona must never claim a tool that will
 *    never exist.
 */
export function resolveToolGrants(
  declared: readonly string[],
  registry: ToolNameSource,
  agentId: string,
): ToolGrantResolution {
  const available = registry.list().map((t) => t.name);
  const families = new Set(available.map((name) => name.split('.')[0]));
  const selected = new Set<string>();
  const missingFamilies: string[] = [];
  for (const entry of declared) {
    const matches = entry.includes('*') || entry.includes('?')
      ? available.filter((name) => globToRegExp(entry).test(name))
      : available.filter((name) => name === entry);
    if (matches.length === 0) {
      const family = FAMILY_GRANT.exec(entry.trim())?.[1];
      if (family !== undefined && !families.has(family)) {
        if (!missingFamilies.includes(family)) missingFamilies.push(family);
        continue;
      }
      throw new AgentCatalogError(
        'unresolvable-tool',
        `agent "${agentId}" declares tool "${entry}", which matches no registered tool ` +
          `(registered: ${available.join(', ') || 'none'})`,
      );
    }
    for (const name of matches) selected.add(name);
  }
  return { tools: available.filter((name) => selected.has(name)), missingFamilies };
}

/**
 * The strict form: every entry must resolve, whatever the reason it did not.
 *
 * This is what a *proposed* grant is checked against (`platform.create_agent`),
 * where "the plugin is not installed" is a refusal rather than a state to
 * record: an agent is never written granting tools this machine does not have.
 */
export function resolveToolNames(
  declared: readonly string[],
  registry: ToolNameSource,
  agentId: string,
): string[] {
  const available = registry.list().map((t) => t.name);
  const { tools, missingFamilies } = resolveToolGrants(declared, registry, agentId);
  if (missingFamilies.length > 0) {
    const entry = declared.find((d) => missingFamilies.includes(FAMILY_GRANT.exec(d.trim())?.[1] ?? ''));
    throw new AgentCatalogError(
      'unresolvable-tool',
      `agent "${agentId}" declares tool "${entry}", which matches no registered tool ` +
        `(registered: ${available.join(', ') || 'none'})`,
    );
  }
  return tools;
}

/**
 * Why an agent is in the catalog but cannot take a turn: a tool family it was
 * granted is not installed here.
 *
 * Not an error, and not a hidden agent. `finance.*` in a file is *correct*;
 * the finance plugin simply is not installed yet. The agent is listed, greyed
 * wherever it appears, says what is missing and where to fix it, and refuses
 * to run — and every other agent loads. One uninstalled plugin taking the
 * whole installation down is precisely what this replaces.
 */
export interface AgentHoldBack {
  reason: 'missing-plugin';
  /** The families nothing provides here, in declaration order. */
  families: string[];
  /** One sentence for a surface to print verbatim. */
  message: string;
}

/**
 * That sentence: "Needs the finance plugin."
 *
 * Names the plugin when the caller can map the family to one (`buddi plugins`
 * knows), and the family itself otherwise — "needs a plugin providing the
 * finance tools" is still something the owner can act on. It says what is
 * missing and stops there: *where* it is fixed is the surface's to add, so the
 * dashboard can make those words the link and the CLI can print a command.
 */
export function heldBackMessage(
  families: readonly string[],
  pluginForFamily?: (family: string) => string | undefined,
): string {
  const parts = families.map((family) => {
    const plugin = pluginForFamily?.(family);
    return plugin === undefined ? `a plugin providing the ${family} tools` : `the ${plugin} plugin`;
  });
  const list =
    parts.length <= 1
      ? (parts[0] ?? 'a plugin that is not installed')
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `Needs ${list}.`;
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
/**
 * The delegation tool's name, as the generated wiring refers to it. Written
 * here rather than imported: core knows no plugin, and this is a string in a
 * prompt, not a call.
 */
export const DELEGATE_TOOL_NAME = 'agent.delegate';

/** A description as one line: the first sentence or line of it, trimmed. */
function oneLine(description: string): string {
  const first = description.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  return first.length > 160 ? `${first.slice(0, 159)}…` : first;
}

/**
 * How many colleagues a generated section names before it stops counting.
 *
 * A roster is a list of *people*, and a prompt that spends two hundred lines
 * naming them has stopped being wiring and started being a directory. The
 * first two dozen are named; the rest are counted, so the model knows the
 * list is longer than what it can see rather than believing it is complete.
 */
export const MAX_LISTED_COLLEAGUES = 24;

function capped<T>(entries: readonly T[], line: (entry: T) => string): string[] {
  const shown = entries.slice(0, MAX_LISTED_COLLEAGUES).map(line);
  const more = entries.length - shown.length;
  return more > 0 ? [...shown, `  - …and ${more} more.`] : shown;
}

/** An agent this installation cannot run is offered as what it is. */
function unavailableMark(entry: AgentRosterEntry): string {
  return entry.available === false ? ' (not available now)' : '';
}

export function generatedSection(
  tools: readonly string[],
  language: AgentLanguage,
  wiring?: {
    handle: string;
    colleagues: readonly AgentRosterEntry[];
    /** The colleagues this agent may ask with `agent.delegate`, in file order. */
    delegates?: readonly AgentRosterEntry[];
  },
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
        ...capped(wiring.colleagues, (c) => `  - @${c.handle} — ${c.name}: ${c.description}${unavailableMark(c)}`),
        '- When naming an agent to the owner, use its handle; pass ids only to ' +
          `${DELEGATE_TOOL_NAME}.`,
        '- The owner can put several agents in a group: one named conversation on the dashboard, with a coordinator that brings members in. Refer to a group by its name. Only an agent holding platform.create_group can make one, and platform.update_group is how a group\'s name, coordinator and members are changed afterwards — a group is not fixed at creation. Membership grants no tool.',
      );
    }
    /*
     * The one place an id belongs in a prompt: `agent.delegate` takes catalog
     * ids, and a model that has only been shown handles guesses one and is
     * refused. Listed only when the agent actually holds the tool.
     */
    if (tools.includes(DELEGATE_TOOL_NAME)) {
      const delegates = wiring.delegates ?? [];
      lines.push(
        delegates.length === 0
          ? `- You may not delegate to anyone: ${DELEGATE_TOOL_NAME} will refuse every id. Answer with what you have, or tell the owner who they should ask.`
          : `- Colleagues you may ask with ${DELEGATE_TOOL_NAME}, by the id to pass as \`agent\` (these ids only — never guess one):`,
        ...capped(delegates, (d) => `  - \`${d.id}\` (@${d.handle}) — ${d.name}: ${oneLine(d.description)}${unavailableMark(d)}`),
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

/**
 * Can this installation run that colleague, as the *roster* needs to know?
 *
 * The roster is built before any agent is, because every agent's prompt names
 * the others — so this asks the two questions `buildAgent` will ask again (is
 * a tool family missing, is the provider reachable) without building anything.
 * It never decides whether an agent loads: a question that throws here is
 * answered "yes" and thrown properly a moment later, in `buildAgent`, where
 * the error belongs.
 */
function rosterAvailability(frontmatter: AgentFrontmatter, opts: LoadAgentCatalogOptions): boolean {
  try {
    const { missingFamilies } = resolveToolGrants(frontmatter.tools, opts.registry, frontmatter.id);
    if (missingFamilies.length > 0) return false;
    const selection = opts.providerSelection?.(frontmatter);
    if (selection?.availability) return selection.availability.ok;
    const provider = selection?.provider ?? providerFromEnv(opts.env, frontmatter.model, frontmatter.provider);
    return resolveProvider(provider, opts.env).ok;
  } catch {
    return true;
  }
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
  const { tools: granted, missingFamilies } = resolveToolGrants(
    frontmatter.tools,
    opts.registry,
    frontmatter.id,
  );
  /*
   * A held-back agent holds *nothing*. Loading it with the half of its grant
   * that did resolve would put a persona written around a balance in front of
   * the owner with no way to read one — worse than saying so.
   */
  const heldBack: AgentHoldBack | undefined =
    missingFamilies.length === 0
      ? undefined
      : {
          reason: 'missing-plugin',
          families: missingFamilies,
          message: heldBackMessage(missingFamilies, opts.pluginForFamily),
        };
  const tools = heldBack === undefined ? granted : [];
  // The owner's zone, read from the env the caller passed — the catalog still
  // never reaches for `process.env` itself.
  const catalogTimezone = timezoneFromEnv(opts.env);
  const language: AgentLanguage = frontmatter.language ?? 'mirror';
  const selection = opts.providerSelection?.(frontmatter);
  const provider = selection?.provider ?? providerFromEnv(opts.env, frontmatter.model, frontmatter.provider);
  // Fail *soft* here and fail closed at run time: see the file header.
  const resolution = resolveProvider(provider, opts.env);
  /*
   * A missing plugin wins over a missing credential: it is the concrete,
   * one-click fix, and an agent with neither should be sent to the door it can
   * actually open first.
   */
  const availability: AgentAvailability = heldBack !== undefined
    ? { ok: false, problem: { code: 'missing-plugin', message: heldBack.message } }
    : (selection?.availability ?? (resolution.ok
      ? { ok: true }
      : { ok: false, problem: resolution.problem }));
  const privateSkills = readSkills(path.join(path.dirname(file), SKILLS_DIR), 'private');
  const skills = selectSkills(frontmatter.id, frontmatter.skills ?? [], privateSkills, sharedSkills);
  const section = skillsSection(skills);
  const colleagues = roster.filter((entry) => entry.id !== frontmatter.id);
  /*
   * The allowlist as the installation holds it, resolved against the roster.
   * An id the file names that no agent answers to is dropped rather than
   * printed: the prompt must not promise a colleague that does not exist.
   */
  const delegates = [...new Set(opts.delegatesFor?.(frontmatter.id, path.dirname(path.dirname(file))) ?? [])]
    .map((id) => roster.find((entry) => entry.id === id))
    .filter((entry): entry is AgentRosterEntry => entry !== undefined);
  const systemPromptTemplate = [
    body.trimEnd(),
    ...(section === '' ? [] : [section]),
    generatedSection(tools, language, { handle: frontmatter.handle, colleagues, delegates }),
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
    ...(heldBack === undefined ? {} : { heldBack }),
    ...(frontmatter.intro === undefined ? {} : { intro: frontmatter.intro }),
    ...(frontmatter.starters === undefined ? {} : { starters: [...frontmatter.starters] }),
    ...(frontmatter.avatar === undefined ? {} : { avatar: frontmatter.avatar }),
    ...(frontmatter.accent === undefined ? {} : { accent: frontmatter.accent }),
    file,
    model: provider.model,
    tools,
    maxTurns,
    ...(frontmatter.thinking === undefined ? {} : { thinking: frontmatter.thinking }),
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
        ...(frontmatter.thinking === undefined ? {} : { thinking: frontmatter.thinking }),
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
    id: frontmatter.id,
    handle: frontmatter.handle,
    name: frontmatter.name,
    description: frontmatter.description,
    available: rosterAvailability(frontmatter, opts),
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
   * claiming it *within one directory* is a disagreement the owner has to
   * settle, and it is reported rather than thrown (see `DefaultAgentProblem`).
   */
  const lastClaim = Math.max(...claimed.map((c) => c.order), -1);
  const fileDefaults = claimed.filter((c) => c.order === lastClaim).map((c) => c.id);

  const ordered = [...agents.values()];
  const runnable = (agent: CatalogAgent | undefined): agent is CatalogAgent =>
    agent !== undefined && agent.availability.ok;

  /**
   * The record's choice, when it names a loaded agent that can actually run.
   *
   * An agent that cannot run is passed over — but only when *somebody else*
   * can. On an installation whose credential has lapsed nothing is runnable,
   * and landing on a different agent that is equally unable to answer would
   * throw away the owner's choice to gain nothing.
   */
  const recorded = ((): CatalogAgent | undefined => {
    const wanted = opts.defaultAgentId?.trim();
    if (wanted === undefined || wanted === '') return undefined;
    const found = agents.get(wanted) ?? byHandle.get(wanted.replace(/^@/, '').toLowerCase());
    if (found === undefined) return undefined;
    return runnable(found) || !ordered.some((a) => a.availability.ok) ? found : undefined;
  })();

  const resolvedDefaultId =
    recorded?.id ??
    (fileDefaults.length === 1 ? fileDefaults[0] : undefined) ??
    ordered.find((a) => a.availability.ok)?.id ??
    ordered[0]?.id;

  /*
   * The problem describes the *files*, not the outcome: the owner's picker
   * needs to say "two of your files claim it, and the one chosen here wins"
   * even though the installation is landing somewhere perfectly sensible. The
   * "nobody claims it" half is worth saying only when no record settles it
   * either — otherwise the owner has already answered the question.
   */
  const defaultProblem: DefaultAgentProblem | undefined =
    fileDefaults.length > 1
      ? {
          code: 'multiple-defaults',
          agents: fileDefaults,
          message:
            `${fileDefaults.join(' and ')} both declare "default: true" in their files. ` +
            'The default agent chosen for this installation wins over both.',
        }
      : fileDefaults.length === 0 && recorded === undefined
        ? {
            code: 'no-default-agent',
            agents: [],
            message:
              `No agent in ${specs.map((entry) => entry.dir).join(', ')} declares "default: true", ` +
              'and this installation has not recorded one. Pick a default agent.',
          }
        : undefined;

  // `isDefault` is the *answer*, not the flag: an agent whose file claims it
  // but lost to the record must not keep saying it is the one.
  for (const agent of ordered) {
    (agent as { isDefault: boolean }).isDefault = agent.id === resolvedDefaultId;
  }

  const known = ordered.map((a) => `${a.id} (@${a.handle})`);
  return {
    ...(defaultProblem === undefined ? {} : { defaultProblem }),
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
        ...(a.heldBack === undefined ? {} : { heldBack: a.heldBack }),
        ...(a.intro === undefined ? {} : { intro: a.intro }),
        ...(a.starters === undefined ? {} : { starters: [...a.starters] }),
        ...(a.avatar === undefined ? {} : { avatar: a.avatar }),
        ...(a.accent === undefined ? {} : { accent: a.accent }),
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
      if (resolvedDefaultId === undefined) {
        throw new AgentCatalogError(
          'no-default-agent',
          `there is no agent in ${specs.map((entry) => entry.dir).join(', ')} to be the default`,
        );
      }
      return agents.get(resolvedDefaultId) as CatalogAgent;
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
