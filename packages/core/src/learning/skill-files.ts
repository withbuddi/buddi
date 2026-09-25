/**
 * Learned skills as files (docs/learning.md §2, step 2).
 *
 * A kept `propose_skill` becomes a skill file in the agent's own skills
 * directory — `<agent dir>/skills/<name>.md`, the directory the catalog
 * already loads every private skill from — with the proposal's provenance in
 * its front matter. Nothing here is a second loader: the file is an ordinary
 * skill, and the next run reads it like any other.
 *
 * Versions are plain files an owner without git can open:
 *
 *     skills/<name>.md                 the current version, the one that loads
 *     skills/versions/<name>/v1.md     every version ever kept, current included
 *     skills/versions/<name>/v2.md
 *
 * The loader reads only `*.md` directly under `skills/`, so `versions/` is
 * never composed into a prompt. Removing a skill deletes the current file and
 * leaves its versions where they are.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { KEBAB } from '../agents/frontmatter.js';
import { parseSkillFile, SKILLS_DIR, type Skill } from '../agents/skills.js';
import { describeUntrustedSource } from './sources.js';
import type { Proposal } from './types.js';

/** Where every kept version of every learned skill is kept, inside `skills/`. */
export const VERSIONS_DIR = 'versions';

/** The longest a learned skill's file name may be. */
const SLUG_MAX = 60;

/** A skill's name as a file name: "Check a bank balance" → `check-a-bank-balance`. */
export function skillSlug(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return KEBAB.test(slug) ? slug : 'learned-skill';
}

/** The skills directory of an agent whose file lives in `agentDir`. */
export function agentSkillsDir(agentDir: string): string {
  return path.join(agentDir, SKILLS_DIR);
}

export function currentSkillFile(skillsDir: string, slug: string): string {
  return path.join(skillsDir, `${slug}.md`);
}

export function skillVersionsDir(skillsDir: string, slug: string): string {
  return path.join(skillsDir, VERSIONS_DIR, slug);
}

/** The versions kept for this skill, oldest first: `[1, 2, 3]`. */
export function skillVersions(skillsDir: string, slug: string): number[] {
  let names: string[];
  try {
    names = readdirSync(skillVersionsDir(skillsDir, slug));
  } catch {
    return [];
  }
  return names
    .map((n) => /^v(\d+)\.md$/.exec(n)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
}

/** The current file, parsed, or null when there is none (or it is not a skill). */
export function readCurrentSkill(skillsDir: string, slug: string): Skill | null {
  const file = currentSkillFile(skillsDir, slug);
  if (!existsSync(file)) return null;
  try {
    return parseSkillFile(readFileSync(file, 'utf8'), { fileName: slug, file });
  } catch {
    return null;
  }
}

/**
 * One front-matter value on one line, quoted so the subset parser never reads
 * it as a list, a number or a boolean. A newline in a source's URL or a
 * sentence must never become a second key: a `tools:` line smuggled in here
 * would fail the whole catalog's load.
 */
function q(value: string): string {
  return `"${value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()}"`;
}

export interface LearnedSkillText {
  slug: string;
  content: string;
}

/** The file a kept skill proposal becomes, at `version`. */
export function composeLearnedSkill(proposal: Proposal, opts: { version: number; keptAt: Date }): LearnedSkillText {
  const p = proposal.payload;
  const title = String(p.name ?? 'Learned skill');
  const slug = skillSlug(title);
  const when = String(p.when ?? '').trim() || title;
  const body = String(p.body ?? '').replace(/\r\n/g, '\n').trim();
  const prov = proposal.provenance;
  const lines = [
    '---',
    `name: ${slug}`,
    `description: ${q(when)}`,
    'provenance: agent',
    `source: ${q(`learning proposal ${proposal.id}`)}`,
    `created: ${q(opts.keptAt.toISOString().slice(0, 10))}`,
    `title: ${q(title)}`,
    `agent: ${q(proposal.agent)}`,
    ...(prov.conversation ? [`conversation: ${q(prov.conversation)}`] : []),
    ...(prov.runId ? [`run_id: ${q(prov.runId)}`] : []),
    ...(typeof prov.turn === 'number' && prov.turn > 0 ? [`turn: ${Math.floor(prov.turn)}`] : []),
    `untrusted: ${proposal.untrusted ? 'true' : 'false'}`,
    ...((prov.sources ?? []).length > 0
      ? ['sources:', ...(prov.sources ?? []).map((s) => `  - ${q(describeUntrustedSource(s))}`)]
      : []),
    `proposal: ${q(proposal.id)}`,
    `kept_at: ${q(opts.keptAt.toISOString())}`,
    `version: ${opts.version}`,
    `edited: ${p.edited === true ? 'true' : 'false'}`,
    '---',
    '',
    `When: ${when.replace(/\s+/g, ' ')}`,
    '',
    body,
    '',
  ];
  return { slug, content: lines.join('\n') };
}

function writeAtomic(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

/** A keep that would overwrite a skill nobody learned. */
export class LearnedSkillConflict extends Error {
  override readonly name = 'LearnedSkillConflict';
}

/**
 * Why a learned skill cannot be written under this name, or null when it can:
 * a file by that name exists and it was not learned (the owner's own, or one
 * a plugin proposed and the owner accepted). It is never overwritten.
 */
export function learnedSkillConflict(skillsDir: string, slug: string): string | null {
  const file = currentSkillFile(skillsDir, slug);
  if (!existsSync(file)) return null;
  if (readCurrentSkill(skillsDir, slug)?.learned) return null;
  return `This agent already has a skill called "${slug}" that was not learned (${file}). Rename the proposal's skill, or remove that file first; it is never overwritten.`;
}

export interface WrittenSkill {
  slug: string;
  file: string;
  version: number;
  versionFile: string;
  /** Put the directory back as it was: the previous current file, or none. */
  undo: () => void;
}

/**
 * Write version n+1 of a learned skill: the version file first, then the
 * current file. Refuses (throws) when the result would not load as a skill,
 * so a keep can never leave a file that breaks the catalog.
 */
export function writeLearnedSkill(skillsDir: string, proposal: Proposal, keptAt: Date): WrittenSkill {
  const slug = skillSlug(String(proposal.payload.name ?? ''));
  const conflict = learnedSkillConflict(skillsDir, slug);
  if (conflict) throw new LearnedSkillConflict(conflict);
  const versions = skillVersions(skillsDir, slug);
  const version = (versions.at(-1) ?? 0) + 1;
  const { content } = composeLearnedSkill(proposal, { version, keptAt });
  const file = currentSkillFile(skillsDir, slug);
  // The same parser the catalog uses, before anything is on disk.
  parseSkillFile(content, { fileName: slug, file });
  const previous = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const versionFile = path.join(skillVersionsDir(skillsDir, slug), `v${version}.md`);
  writeAtomic(versionFile, content);
  writeAtomic(file, content);
  return {
    slug,
    file,
    version,
    versionFile,
    undo: () => {
      rmSync(versionFile, { force: true });
      if (previous === null) rmSync(file, { force: true });
      else writeAtomic(file, previous);
    },
  };
}

/**
 * Remove a learned skill: the current file goes, the versions stay. Returns
 * what was removed, or null when there is no learned skill by that name (a
 * skill the owner wrote, or a plugin's, is never removed from here).
 */
export function removeLearnedSkill(skillsDir: string, slug: string): Skill | null {
  if (!KEBAB.test(slug)) return null;
  const current = readCurrentSkill(skillsDir, slug);
  if (!current?.learned) return null;
  rmSync(currentSkillFile(skillsDir, slug), { force: true });
  return current;
}

/** A learned skill's steps as the agent proposed them: its body without the `When:` line it was written with. */
export function learnedSkillSteps(skill: Pick<Skill, 'body'>): string {
  return skill.body.replace(/^When: [^\n]*\n+/, '').trim();
}
