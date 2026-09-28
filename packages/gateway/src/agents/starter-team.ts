/**
 * The starter team: ready-made agents a newcomer adds in one tap.
 *
 * Day one holds a front desk and a maker, and nothing shows what an agent adds
 * over the front desk alone. So buddi ships a small catalogue — Scout, Planner,
 * Keeper — that needs nothing but a brain, written as ordinary agent files
 * under `starter/<id>/` (an `agent.md` and its `skills/`), and proposes them
 * exactly as a plugin proposes an agent: under the built-in source `buddi`,
 * through `pluginAgentProposals`, so accepting one is the same gated
 * `platform.accept_plugin_agent` the email plugin's Mail offer runs. No second
 * road to a principal: the same checks, the same preview, the same approval.
 *
 * The agents a plugin proposes (Mail Triage, Ledger, Illustrator) stay with
 * their plugins. `PLUGIN_TEAMMATES` only names them, so the catalogue can draw
 * them greyed with the reason while their plugin or their requirement is
 * missing.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_FILE, parseAgentFile, parseSkillFile, SKILLS_DIR, type BundledMascot, type SuggestedAgent } from '@buddi/core';

/** The source the starter offers are raised under, as if it were a plugin. */
export const STARTER_PLUGIN = 'buddi';
/** The version a starter proposal carries into an accepted agent's provenance. */
export const STARTER_VERSION = '0.1.0';

/**
 * Where the catalogue lives. The files are data, not code, so `tsc` does not
 * copy them: from `src/agents` they sit beside this module, and from
 * `dist/agents` they are read from the package's own `src/agents/starter`,
 * which the package ships (`files` in its package.json).
 */
export function starterDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const beside = path.join(here, 'starter');
  if (existsSync(beside)) return beside;
  return path.resolve(here, '..', '..', 'src', 'agents', 'starter');
}

/** A mission an accepted starter agent arrives with, run as that agent. */
export interface StarterMission {
  /** Its name, and the slug of its id (`agent:<agent>:<slug>`). */
  name: string;
  /** Five-field cron, read in the owner's timezone. */
  cron: string;
  prompt: string;
}

interface StarterMeta {
  /** The card's one line. */
  text: string;
  /** The card's muted line: what it needs, and what makes it better. `Needs a brain` when absent. */
  needs?: string;
  avatar?: BundledMascot;
  mission?: StarterMission;
}

/** What the files cannot say: the card's line, the face, the first mission. */
const META: Record<string, StarterMeta> = {
  scout: {
    text: 'Reads the web, gives a second opinion, watches pages you name.',
    avatar: 'research',
  },
  planner: {
    text: 'Keeps your day: reminders, follow-ups it remembers, a brief every morning.',
    needs: 'Needs a brain; better with the Weather and Calendar plugins',
    avatar: 'core',
    mission: {
      name: 'Morning brief',
      cron: '0 8 * * *',
      prompt:
        'Write the owner\'s morning brief, following your writing-the-morning-brief skill. In this order: today\'s ' +
        'weather for the home place and anything severe; today\'s meetings with their times and the gaps between ' +
        'them; reminders due today and anything overdue; your missions that run today; then one line of what to do ' +
        'first. Skip any part whose tools you do not have, and never mention a missing plugin or tool in the brief. ' +
        'Plain short lines, at most eight. When nothing is due, nothing is waiting and the day is unremarkable, ' +
        'call mission.silent.',
    },
  },
  keeper: {
    text: 'Remembers one domain\'s history you choose: the car, the house, a project.',
    avatar: 'garage',
  },
};

/** The order the cards are drawn in. */
export const STARTER_IDS = ['scout', 'planner', 'keeper'] as const;

export interface StarterAgent extends SuggestedAgent {
  mission?: StarterMission;
  /** The card's muted line, when it says more than `Needs a brain`. */
  needs?: string;
}

let cached: { dir: string; agents: StarterAgent[] } | null = null;

/**
 * The catalogue, read from its files once per directory. A file that does not
 * parse throws: it ships with buddi, and the test that reads it is the guard.
 */
export function starterAgents(dir: string = starterDir()): StarterAgent[] {
  if (cached && cached.dir === dir) return cached.agents;
  const agents = STARTER_IDS.map((id): StarterAgent => {
    const agentDir = path.join(dir, id);
    const file = path.join(agentDir, AGENT_FILE);
    const { frontmatter, body } = parseAgentFile(readFileSync(file, 'utf8'), { dirName: id, file });
    const skillsDir = path.join(agentDir, SKILLS_DIR);
    const skills = existsSync(skillsDir)
      ? readdirSync(skillsDir)
          .filter((name) => name.endsWith('.md'))
          .sort()
          .map((name) => {
            const skillFile = path.join(skillsDir, name);
            const skill = parseSkillFile(readFileSync(skillFile, 'utf8'), {
              fileName: name.slice(0, -'.md'.length),
              file: skillFile,
            });
            return { name: skill.name, description: skill.description, body: skill.body.trim() };
          })
      : [];
    const meta = META[id] as StarterMeta;
    return {
      id: frontmatter.id,
      handle: frontmatter.handle ?? frontmatter.id,
      name: frontmatter.name,
      description: frontmatter.description,
      persona: body.trim(),
      tools: frontmatter.tools,
      ...(frontmatter.roles === undefined ? {} : { roles: frontmatter.roles }),
      ...(frontmatter.language === undefined ? {} : { language: frontmatter.language }),
      ...(skills.length === 0 ? {} : { skills }),
      offer: { text: meta.text },
      ...(meta.avatar === undefined ? {} : { avatar: meta.avatar }),
      ...(meta.mission === undefined ? {} : { mission: meta.mission }),
      ...(meta.needs === undefined ? {} : { needs: meta.needs }),
    };
  });
  cached = { dir, agents };
  return agents;
}

/** The starter agents as proposals from the `buddi` source. */
export function starterProposals(): Array<{ plugin: string; pluginVersion: string; agent: SuggestedAgent }> {
  return starterAgents().map((agent) => ({ plugin: STARTER_PLUGIN, pluginVersion: STARTER_VERSION, agent }));
}

/** The first mission a proposal arrives with, when it is a starter agent that has one. */
export function starterMission(plugin: string, agentId: string): StarterMission | null {
  if (plugin !== STARTER_PLUGIN) return null;
  return starterAgents().find((a) => a.id === agentId.toLowerCase())?.mission ?? null;
}

/** Where the owner goes to lift a plugin teammate's greying. */
export type TeammateFix = 'plugins' | 'mailbox' | 'accounts';

/** An agent a plugin proposes, named so the catalogue can explain its absence. */
export interface PluginTeammate {
  plugin: string;
  agent: string;
  handle: string;
  name: string;
  text: string;
  /** What it needs, as the card's muted line. */
  needs: string;
  /** Why it is greyed while its plugin does not offer it. */
  reason: string;
  /** Why it is greyed when the plugin is there but says it is not wanted now. */
  covered?: string;
  fix: TeammateFix;
}

export const PLUGIN_TEAMMATES: readonly PluginTeammate[] = [
  {
    plugin: 'email',
    agent: 'mail-triage',
    handle: 'mail',
    name: 'Mail Triage',
    text: 'Reads your inbox and pulls out what needs you.',
    needs: 'Needs a mailbox',
    reason: 'Needs a mailbox',
    fix: 'mailbox',
  },
  {
    plugin: 'finance',
    agent: 'ledger',
    handle: 'ledger',
    name: 'Ledger',
    text: 'Reads statements, tracks spending, a weekly recap.',
    needs: 'Needs the finance plugin',
    reason: 'From the finance plugin',
    covered: 'You already have a cash-flow advisor',
    fix: 'plugins',
  },
  {
    plugin: 'image',
    agent: 'illustrator',
    handle: 'art',
    name: 'Illustrator',
    text: 'Turns a request into one clear picture.',
    needs: 'Needs the image plugin and an account that draws',
    reason: 'Needs the image plugin and an account that draws',
    fix: 'plugins',
  },
];
