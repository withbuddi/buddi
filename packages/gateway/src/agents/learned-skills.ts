/**
 * Learned skills, as the gateway serves them (docs/specs/learning.md, step 2).
 *
 * Core writes and reads the files (`core/learning/skill-files.ts`); this is
 * where an agent id becomes a directory, where a keep is checked against the
 * skills the agent already has, where the agent sheet's Skills tab is read
 * and where "remove this skill" is carried out.
 *
 * It is also where the owner's agent files are named as off limits to every
 * file tool (`protectedWritePaths`): an agent learns by proposing, and a
 * developer workspace that happens to contain the owner's `private/agents`
 * must still refuse a write into it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  agentSkillsDir,
  appendEvent,
  learnedSkillConflict,
  learnedSkillSteps,
  loadSkillsDir,
  parseSkillFile,
  readCurrentSkill,
  removeLearnedSkill,
  revokeKeptProposal,
  skillSlug,
  skillVersions,
  type AgentCatalog,
  type LearnedSkillMeta,
  type Proposal,
  type Skill,
} from '@buddi/core';
import type { Pool } from 'pg';
import { agentSearchPath, EXAMPLES_SKILLS_DIR } from './catalog.js';

/**
 * The directories no file tool may write into: the owner's agents (personas,
 * allowlists and every agent's own skills, learned ones included) and their
 * shared skills. The shipped examples are the platform's source and are left
 * to the ordinary rules: a developer agent working on buddi edits them, and a
 * learned skill is never written there.
 */
export function protectedWritePaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const search = agentSearchPath(env);
  return [...new Set([search.owner.dir, search.owner.skillsDir].map((dir) => path.resolve(dir)))];
}

/** An agent's own skills directory, or null for an agent the owner cannot write to (absent, or a shipped example). */
export function agentSkillsDirFor(catalog: AgentCatalog, agentId: string): string | null {
  const agent = catalog.get(agentId);
  if (!agent || agent.source === 'example') return null;
  return agentSkillsDir(path.dirname(agent.file));
}

function sharedSkills(env: NodeJS.ProcessEnv): Skill[] {
  const search = agentSearchPath(env);
  const out: Skill[] = [];
  for (const dir of [EXAMPLES_SKILLS_DIR, search.owner.skillsDir]) {
    try {
      out.push(...loadSkillsDir(dir, 'shared'));
    } catch {
      // A broken shared skill is the catalog's error to report, not this check's.
    }
  }
  return out;
}

/**
 * Why a skill proposal cannot be kept here, or null when it can. Asked
 * before the keep is recorded, so a refusal leaves the card open.
 */
export function skillKeepProblem(
  catalog: AgentCatalog,
  proposal: Proposal,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const agent = catalog.get(proposal.agent);
  if (!agent) return `${proposal.agent} is not installed here any more, so there is nowhere to write its skill.`;
  if (agent.source === 'example') {
    return `${proposal.agent} ships with buddi, and its files belong to the platform. Ask Agent Father to make it yours first; then its learned skills can be kept.`;
  }
  const slug = skillSlug(String(proposal.payload.name ?? ''));
  if (sharedSkills(env).some((s) => s.name === slug)) {
    return `A shared skill is already called "${slug}"; one name, one procedure. Discard this one, or ask ${proposal.agent} to propose it under another name.`;
  }
  return learnedSkillConflict(agentSkillsDir(path.dirname(agent.file)), slug);
}

/** A learned skill's current version, as a later proposal on it is compared with. */
export interface CurrentLearnedSkill {
  name: string;
  version: number;
  proposal: string;
  steps: string;
}

/** The learned skill a skill proposal would replace, when there is one. */
export function currentLearnedSkill(catalog: AgentCatalog, agent: string, title: string): CurrentLearnedSkill | null {
  const dir = agentSkillsDirFor(catalog, agent);
  if (!dir) return null;
  const skill = readCurrentSkill(dir, skillSlug(title));
  if (!skill?.learned) return null;
  return { name: skill.name, version: skill.learned.version, proposal: skill.learned.proposal, steps: learnedSkillSteps(skill) };
}

export interface AgentSkillView {
  name: string;
  description: string;
  scope: 'private' | 'shared';
  provenance: Skill['provenance'];
  source: string | null;
  file: string;
  body: string;
  learned: (LearnedSkillMeta & { versions: number[]; versionsDir: string }) | null;
}

/** Every skill the agent loads, learned ones with their provenance and versions: the agent sheet's Skills tab. */
export function readAgentSkills(
  catalog: AgentCatalog,
  agentId: string,
): { agent: string; writable: boolean; skills: AgentSkillView[] } | null {
  const agent = catalog.get(agentId);
  if (!agent) return null;
  const dir = agentSkillsDirFor(catalog, agentId);
  const skills: AgentSkillView[] = [];
  for (const entry of agent.skills) {
    let skill: Skill;
    try {
      skill = parseSkillFile(readFileSync(entry.file, 'utf8'), { file: entry.file });
    } catch {
      continue;
    }
    const scope = path.dirname(entry.file) === agentSkillsDir(path.dirname(agent.file)) ? 'private' : 'shared';
    skills.push({
      name: skill.name,
      description: skill.description,
      scope,
      provenance: skill.provenance,
      source: skill.source ?? null,
      file: entry.file,
      body: skill.body,
      learned:
        skill.learned && dir && scope === 'private'
          ? {
              ...skill.learned,
              versions: skillVersions(dir, skill.name),
              versionsDir: path.join(dir, 'versions', skill.name),
            }
          : null,
    });
  }
  return { agent: agentId, writable: dir !== null, skills };
}

export type RemoveSkillResult =
  | { ok: true; name: string; version: number; proposal: string }
  | { ok: false; status: number; error: string };

/**
 * "Remove this skill": the current file goes (its versions stay), the catalog
 * reloads, the proposal it was kept from becomes a discard as of now — so the
 * agent is told once and will not propose it again for 90 days — and a line
 * goes into Activity.
 */
export async function removeLearnedSkillFromWeb(
  deps: { pool: Pool; catalog: AgentCatalog; now: () => Date; reload?: () => void },
  agentId: string,
  name: string,
): Promise<RemoveSkillResult> {
  const dir = agentSkillsDirFor(deps.catalog, agentId);
  if (!dir) return { ok: false, status: 404, error: 'That agent has no learned skills to remove.' };
  const removed = removeLearnedSkill(dir, name);
  if (!removed?.learned) {
    return { ok: false, status: 404, error: `There is no learned skill called "${name}" under ${agentId}; only a learned skill is removed from here.` };
  }
  try {
    deps.reload?.();
  } catch {
    // The file is gone; the next load says what else is wrong.
  }
  const meta = removed.learned;
  await revokeKeptProposal(deps.pool, { id: meta.proposal, now: deps.now() }).catch(() => null);
  await appendEvent(deps.pool, 'skill.removed', {
    agent: agentId,
    name: removed.name,
    title: meta.title,
    version: meta.version,
    proposal: meta.proposal,
    by: 'owner',
  }).catch(() => undefined);
  return { ok: true, name: removed.name, version: meta.version, proposal: meta.proposal };
}
