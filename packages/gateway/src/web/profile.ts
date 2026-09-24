/**
 * What an agent *is* — assembled for the page, read-only by construction.
 *
 * The dashboard could already say which agent you are talking to and how old
 * the conversation is. It could not say the one thing that actually matters
 * about a thing that acts on your life: **what it is allowed to do, and which
 * of those things it does without asking.** That answer lived in
 * `agents/<id>/agent.md` and in a tier field in a plugin's source, which is to
 * say nowhere the owner would ever look.
 *
 * So this is the privilege boundary, assembled from the three places that
 * actually decide it and from nowhere else:
 *
 *  - the **grant** — the agent's resolved tool list, each tool carrying the
 *    tier the registry holds for it, so `auto` and `gated` are distinguished by
 *    the same field the registry itself fails closed on. The description is the
 *    tool's own, never text invented here;
 *  - the **engine** — provider, model, and the credential *named*: kind and
 *    environment variable, in the vocabulary `buddi agents` already uses. The
 *    value is never read, so it can never be sent;
 *  - the **wiring** — skills (which change behaviour as much as tools do),
 *    delegates (the other route to a capability this agent does not hold), and
 *    the roles that decide which agent a surface command lands on.
 *
 * Two deliberate properties:
 *
 * **It is a read.** There is no write endpoint beside it: a grant changes on
 * the Setup tab's tool picker (or `buddi.agent_update` over MCP), or through
 * the maker agent, where the change becomes an approval with the escalation
 * named in words. `changeVia` is the
 * whole of this module's contribution to changing anything: the maker's handle,
 * resolved by role, and the sentence to open with.
 *
 * **It answers about the files, not about the catalog's memory of them.** Like
 * `engineView` next door, the skills are re-read from disk for their own
 * descriptions; unlike it, a file that has since been deleted degrades to the
 * name the catalog holds rather than failing the request.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  GATED_TIERS,
  parseSkillFile,
  type AgentCatalog,
  type AgentHoldBack,
  type AgentSource,
  type CatalogAgent,
  type Tier,
  type ToolRegistry,
} from '@buddi/core';
import { readDelegates } from '../agents/delegation.js';
import { ROLE_MAKER } from '../agents/roles.js';

/** One granted tool, with the only fact about it that is a privilege. */
export interface ProfileTool {
  name: string;
  /** The tool's own one-line description, from the plugin that ships it. */
  description: string;
  tier: Tier;
  /** True when a call stops and becomes an approval the owner has to answer. */
  gated: boolean;
}

/** The tools of one plugin family, in registry order. */
export interface ProfileToolFamily {
  /** The plugin that contributes them. The page renders it, never matches it. */
  family: string;
  tools: ProfileTool[];
  gated: number;
}

export interface ProfileSkill {
  name: string;
  /** The skill's own description; absent when the file is no longer readable. */
  description?: string;
  provenance: string;
  /** `private` to this agent, or `shared` across the installation. */
  scope: string;
  file: string;
}

export interface ProfileDelegate {
  id: string;
  handle: string;
  name: string;
  description: string;
  available: boolean;
}

/**
 * Where a change to any of this goes. Resolved by role, so an installation
 * whose maker is called something else still gets a working line, and one with
 * no maker at all gets none rather than a dead link.
 */
export interface ProfileChangeVia {
  agentId: string;
  handle: string;
  name: string;
  /** The message to open with, already naming the agent being looked at. */
  prompt: string;
  available: boolean;
}

export interface AgentProfileView {
  id: string;
  handle: string;
  name: string;
  description: string;
  isDefault: boolean;
  /** `example` (shipped with the repo) or `private` (the owner's own). */
  source: AgentSource;
  file: string;
  available: boolean;
  unavailableReason?: string;
  /** Set when a granted tool family is not installed here. `tools` is empty. */
  heldBack?: AgentHoldBack;
  roles: string[];
  engine: {
    provider: string;
    model: string;
    maxTurns: number;
    language: string;
    /** How the credential is held — e.g. `subscription-token`, `api-key`. */
    credentialKind: string;
    /** Which environment variable it is read from. Never its value. */
    credentialEnv: string;
  };
  tools: ProfileToolFamily[];
  /** Totals across every family, so the panel can lead with the summary. */
  toolCount: number;
  gatedCount: number;
  skills: ProfileSkill[];
  delegates: ProfileDelegate[];
  changeVia?: ProfileChangeVia;
  /** The read-only sentence. Always present; the panel prints it verbatim. */
  note: string;
}

/**
 * The sentence the panel ends on: where a change is actually made. Since the
 * tool picker that is the Setup tab (and `buddi.agent_update` over MCP, which
 * turns the same save into an approval card); only the tools that create or
 * change agents are still granted by editing the file by hand.
 */
export const READ_ONLY_NOTE =
  "Tools and delegates change on this agent's Setup tab, or over MCP through buddi.agent_update as an " +
  'approval card; only the tools that create or change agents are granted by editing its file by hand.';

/** With no maker installed the answer is the same: the Setup tab does not need one. */
export const NO_MAKER_NOTE = READ_ONLY_NOTE;

/**
 * And for the maker looking at itself: its other tools change like anyone's,
 * but the ones that make it the maker are the hand-only ones.
 */
export const MAKER_ITSELF_NOTE =
  "Tools and delegates change on this agent's Setup tab, or over MCP through buddi.agent_update as an " +
  'approval card; the tools that create or change agents, which this one holds, are granted only by editing its file.';

/** The opening message the maker is handed, with the agent already named. */
export function changePrompt(handle: string, name: string): string {
  return `I want to change what @${handle} (${name}) can do.`;
}

export interface ProfileDeps {
  catalog: AgentCatalog;
  registry: Pick<ToolRegistry, 'list' | 'manifests'>;
}

/**
 * One agent, whole. `undefined` when no such agent — the route turns that into
 * a 404 rather than guessing at the default, exactly as `resolve` refuses to.
 */
export function readAgentProfile(
  deps: ProfileDeps,
  idOrHandle: string,
): AgentProfileView | undefined {
  const agent = deps.catalog.get(idOrHandle) ?? deps.catalog.byHandle(idOrHandle);
  if (!agent) return undefined;

  const maker = deps.catalog.agentForRole(ROLE_MAKER);
  // The maker cannot send the owner to itself: "change what @father can do"
  // opened on @father is a loop, and its own grant is the one thing the maker
  // is not the route for.
  const changeVia =
    maker.ok && maker.agent.id !== agent.id
      ? {
          agentId: maker.agent.id,
          handle: maker.agent.handle,
          name: maker.agent.name,
          prompt: changePrompt(agent.handle, agent.name),
          available: maker.agent.availability.ok,
        }
      : undefined;

  const families = toolFamilies(agent.tools, deps.registry);
  const credential = agent.provider.credential as { kind?: string; env?: string };

  return {
    id: agent.id,
    handle: agent.handle,
    name: agent.name,
    description: agent.description,
    isDefault: agent.isDefault,
    source: agent.source,
    file: agent.file,
    available: agent.availability.ok,
    ...(agent.availability.ok ? {} : { unavailableReason: agent.availability.problem.message }),
    ...(agent.heldBack === undefined ? {} : { heldBack: agent.heldBack }),
    roles: [...agent.roles],
    engine: {
      provider: agent.provider.kind,
      model: agent.provider.model,
      maxTurns: agent.maxTurns,
      language: agent.language,
      credentialKind: credential?.kind ?? 'unknown',
      credentialEnv: credential?.env ?? 'unknown',
    },
    tools: families,
    toolCount: families.reduce((total, family) => total + family.tools.length, 0),
    gatedCount: families.reduce((total, family) => total + family.gated, 0),
    skills: skillsOf(agent),
    delegates: delegatesOf(agent, deps.catalog),
    ...(changeVia ? { changeVia } : {}),
    note: changeVia
      ? READ_ONLY_NOTE
      : maker.ok && maker.agent.id === agent.id
        ? MAKER_ITSELF_NOTE
        : NO_MAKER_NOTE,
  };
}

/**
 * The grant, grouped by the plugin that ships each tool.
 *
 * Grouping is by *manifest*, not by the dotted prefix of the name: the prefix
 * is a convention, the manifest is the thing that was installed. A tool the
 * registry no longer knows — an agent file that outran a plugin removal, which
 * the loader would normally refuse — is reported under its own prefix with an
 * unknown tier rather than silently dropped from a list whose whole job is to
 * be complete.
 */
export function toolFamilies(
  tools: readonly string[],
  registry: ProfileDeps['registry'],
): ProfileToolFamily[] {
  const specs = new Map(registry.list().map((spec) => [spec.name, spec]));
  const plugins = new Map<string, string>();
  for (const manifest of registry.manifests()) {
    for (const tool of manifest.tools) plugins.set(tool.name, manifest.name);
  }

  const families: ProfileToolFamily[] = [];
  const byName = new Map<string, ProfileToolFamily>();
  for (const name of tools) {
    const spec = specs.get(name);
    const family = plugins.get(name) ?? name.split('.')[0] ?? name;
    let group = byName.get(family);
    if (!group) {
      group = { family, tools: [], gated: 0 };
      byName.set(family, group);
      families.push(group);
    }
    const tier = spec?.tier ?? 'gated';
    const gated = (GATED_TIERS as readonly string[]).includes(tier);
    group.tools.push({
      name,
      description: spec?.description ?? '',
      tier,
      gated,
    });
    if (gated) group.gated += 1;
  }
  return families;
}

/**
 * The skills composed into this agent's prompt, each re-read for its own
 * description. A file that has gone missing keeps its name and its provenance —
 * the catalog knows both — and simply has nothing to say about itself.
 */
function skillsOf(agent: CatalogAgent): ProfileSkill[] {
  return agent.skills.map((skill) => {
    try {
      const parsed = parseSkillFile(readFileSync(skill.file, 'utf8'), { file: skill.file });
      return {
        name: skill.name,
        description: parsed.description,
        provenance: skill.provenance,
        scope: scopeOf(agent.file, skill.file),
        file: skill.file,
      };
    } catch {
      return {
        name: skill.name,
        provenance: skill.provenance,
        scope: scopeOf(agent.file, skill.file),
        file: skill.file,
      };
    }
  });
}

/** Private when the skill lives inside this agent's own directory. */
function scopeOf(agentFile: string, skillFile: string): string {
  return path.dirname(skillFile).startsWith(path.dirname(agentFile)) ? 'private' : 'shared';
}

/**
 * Who this agent may hand work to, read from the same `delegates.json` the
 * delegation tool reads at call time — so the panel cannot say one thing while
 * the tool does another.
 *
 * An id naming an agent that is not installed is dropped rather than shown as a
 * ghost: the allowlist is a file an owner or a restore can get wrong, and the
 * honest answer to "who can it reach" is the agents it can actually reach.
 */
function delegatesOf(agent: CatalogAgent, catalog: AgentCatalog): ProfileDelegate[] {
  const agentsDir = path.dirname(path.dirname(agent.file));
  let ids: string[];
  try {
    ids = readDelegates(agent.id, agentsDir);
  } catch {
    // A malformed allowlist fails the *load*, so this process would not be
    // serving at all. If one appeared since, the panel says nobody rather than
    // taking the dashboard down.
    return [];
  }
  return ids.flatMap((id) => {
    const target = catalog.get(id);
    if (!target) return [];
    return [
      {
        id: target.id,
        handle: target.handle,
        name: target.name,
        description: target.description,
        available: target.availability.ok,
      },
    ];
  });
}
