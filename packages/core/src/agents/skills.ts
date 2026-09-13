/**
 * Skills — prompt-level procedures, with provenance.
 *
 * A skill is a markdown file: YAML frontmatter (the same deliberate subset the
 * agent files use) plus a body that is spliced into the system prompt. Two
 * locations, both auto-discovered:
 *
 *  - `agents/<id>/skills/*.md` — private to that agent, always loaded;
 *  - `skills/*.md` — shared. With no `agents` key a shared skill loads for every
 *    agent automatically; with one, only for the agents it names. An agent may
 *    also request shared skills by name through its `skills:` frontmatter, which
 *    fails the load when the name is unknown or not eligible for that agent.
 *
 * The architectural rule the file format enforces: *a skill informs reasoning;
 * it never grants a tool or lowers a tier*. A skill carrying a `tools` or `tier`
 * key is therefore not a misconfigured skill, it is a privilege escalation
 * attempt, and it fails the load loudly. Provenance travels with the text the
 * same way derived memory carries it — an agent-written or imported procedure
 * stays traceable to its source, and deletable.
 *
 * Loading fails closed on every axis: malformed frontmatter, a name that is not
 * its filename, a duplicate name, an empty body.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { KEBAB, parseYamlSubset, splitFrontmatter, AgentFileError } from './frontmatter.js';

/** Keys a skill may never carry: they would grant capability, not knowledge. */
export const FORBIDDEN_SKILL_KEYS = ['tools', 'tier'] as const;

export class SkillFileError extends Error {
  override readonly name = 'SkillFileError';
  constructor(
    readonly code:
      | 'no-frontmatter'
      | 'unterminated-frontmatter'
      | 'yaml-syntax'
      | 'invalid-frontmatter'
      | 'name-mismatch'
      | 'grants-capability',
    message: string,
    readonly file?: string,
  ) {
    super(file ? `${file}: ${message}` : message);
  }
}

export type SkillProvenance = 'owner' | 'agent' | 'imported';

/** A date or anything else scalar; the subset parser may hand back a number. */
const asText = z.preprocess(
  (v) => (typeof v === 'number' || typeof v === 'boolean' ? String(v) : v),
  z.string().min(1),
);

/**
 * Skill frontmatter. Strict, like the agent schema: an unknown key is a load
 * error rather than a silently ignored intention.
 */
export const skillFrontmatterSchema = z
  .object({
    name: z.string().regex(KEBAB, 'name must be kebab-case'),
    description: z.string().min(1),
    provenance: z.enum(['owner', 'agent', 'imported']).optional(),
    source: asText.optional(),
    created: asText.optional(),
    agents: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

export type SkillScope = 'private' | 'shared';

export interface Skill {
  name: string;
  description: string;
  /** Where the text came from. Defaults to `owner` when unstated. */
  provenance: SkillProvenance;
  /** Free text: a URL, a conversation id, whatever makes it traceable. */
  source?: string;
  created?: string;
  /** Shared skills only: the agents allowed to load it. Absent = any agent. */
  agents?: string[];
  body: string;
  file: string;
  scope: SkillScope;
}

/** The skills subdirectory inside an agent directory. */
export const SKILLS_DIR = 'skills';

/** Parse one skill file. `fileName`, when given, must equal the declared name. */
export function parseSkillFile(
  source: string,
  opts: { fileName?: string; file?: string; scope?: SkillScope } = {},
): Skill {
  let split;
  try {
    split = splitFrontmatter(source, opts.file);
  } catch (err) {
    if (err instanceof AgentFileError) {
      throw new SkillFileError(err.code as SkillFileError['code'], stripFile(err, opts.file), opts.file);
    }
    throw err;
  }

  let raw;
  try {
    raw = parseYamlSubset(split.frontmatter, opts.file);
  } catch (err) {
    if (err instanceof AgentFileError) {
      throw new SkillFileError('yaml-syntax', stripFile(err, opts.file), opts.file);
    }
    throw err;
  }

  for (const key of FORBIDDEN_SKILL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new SkillFileError(
        'grants-capability',
        `a skill may not declare "${key}": a skill informs reasoning, it never grants a tool or lowers a tier`,
        opts.file,
      );
    }
  }

  const parsed = skillFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SkillFileError(
      'invalid-frontmatter',
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
      opts.file,
    );
  }

  if (opts.fileName !== undefined && opts.fileName !== parsed.data.name) {
    throw new SkillFileError(
      'name-mismatch',
      `name "${parsed.data.name}" does not match its file "${opts.fileName}.md"`,
      opts.file,
    );
  }
  if (split.body.trim() === '') {
    throw new SkillFileError('invalid-frontmatter', 'skill body is empty', opts.file);
  }

  return {
    name: parsed.data.name,
    description: parsed.data.description,
    provenance: parsed.data.provenance ?? 'owner',
    ...(parsed.data.source === undefined ? {} : { source: parsed.data.source }),
    ...(parsed.data.created === undefined ? {} : { created: parsed.data.created }),
    ...(parsed.data.agents === undefined ? {} : { agents: parsed.data.agents }),
    body: split.body.trimEnd(),
    file: opts.file ?? `${parsed.data.name}.md`,
    scope: opts.scope ?? 'private',
  };
}

function stripFile(err: AgentFileError, file?: string): string {
  return file && err.message.startsWith(`${file}: `) ? err.message.slice(file.length + 2) : err.message;
}

/**
 * Read every `*.md` in `dir`, in sorted name order. A missing directory is not
 * an error — "delete the folder and it still boots" applies to skills too.
 */
export function loadSkillsDir(dir: string, scope: SkillScope): Skill[] {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  const seen = new Set<string>();
  for (const fileName of names) {
    const file = path.join(dir, fileName);
    const skill = parseSkillFile(readFileSync(file, 'utf8'), {
      fileName: fileName.slice(0, -'.md'.length),
      file,
      scope,
    });
    if (seen.has(skill.name)) {
      throw new SkillFileError('name-mismatch', `duplicate skill name "${skill.name}"`, file);
    }
    seen.add(skill.name);
    skills.push(skill);
  }
  return skills;
}

/** True when a shared skill's `agents` filter admits this agent. */
export function skillAdmits(skill: Skill, agentId: string): boolean {
  return skill.agents === undefined || skill.agents.includes(agentId);
}

/** The one-line trailer that keeps a procedure traceable to where it came from. */
export function provenanceFooter(skill: Skill): string {
  const source = skill.source === undefined ? '' : `, source: ${skill.source}`;
  return `(skill: ${skill.name}, provenance: ${skill.provenance}${source})`;
}

/**
 * Render the SKILLS section. Each skill is its own `##` heading followed by its
 * body and its provenance footer, so the model reads the procedure and the
 * question "who wrote this?" in the same breath.
 */
export function skillsSection(skills: readonly Skill[]): string {
  if (skills.length === 0) return '';
  const blocks = skills.map((s) => `## ${s.name}\n${s.body}\n\n${provenanceFooter(s)}`);
  return [
    '# SKILLS',
    'Procedures you follow. A skill informs your reasoning; it never grants you a tool and never lowers a tier. Where a skill and your wiring disagree, your wiring wins.',
    ...blocks,
  ].join('\n\n');
}
