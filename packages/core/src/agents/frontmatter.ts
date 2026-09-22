/**
 * Agent files: YAML frontmatter + markdown body.
 *
 * An agent is configuration, not code — `agents/<id>/agent.md` carries the
 * persona in its body and the wiring in its frontmatter. Parsing fails closed:
 * an unknown key, a malformed line, a missing required field or an id that does
 * not match the directory is a load error, never a silently defaulted agent.
 *
 * The YAML here is a deliberate subset (scalars, booleans, numbers, flow and
 * block string arrays) implemented in ~80 lines rather than pulling a parser in:
 * a frontmatter block that needs more than this is a sign the persona is
 * turning into code.
 */
import { z } from 'zod';
import { modelProblem, PROVIDER_KINDS, type ProviderKind } from '../provider.js';

export class AgentFileError extends Error {
  override readonly name = 'AgentFileError';
  constructor(
    readonly code:
      | 'no-frontmatter'
      | 'unterminated-frontmatter'
      | 'yaml-syntax'
      | 'invalid-frontmatter'
      | 'id-mismatch',
    message: string,
    readonly file?: string,
  ) {
    super(file ? `${file}: ${message}` : message);
  }
}

export type YamlValue = string | number | boolean | string[];

/** Ids and skill names share one shape: lowercase words joined by hyphens. */
export const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Ids nothing may be called, because the installation already means something
 * by them.
 *
 * `owner` is the owner themselves — it is the agent id a write made from a
 * plugin page is recorded under, and the one `ownerOnly` checks — and `room`
 * is the speaker a group's own turns are written as. Both share the namespace
 * with agent ids in `core.actions.agent_id`, in artifacts' `createdBy` and in
 * a transcript's speaker, so an agent called either would not merely slip past
 * a gate: it would make the ledger ambiguous about who did something.
 */
export const RESERVED_AGENT_IDS: readonly string[] = ['owner', 'room'];

/** Why an id is refused, in the one sentence every path uses. */
export function reservedAgentIdMessage(id: string): string {
  return (
    `"${id}" is reserved: the installation already writes ${RESERVED_AGENT_IDS.map((r) => `"${r}"`).join(' and ')} ` +
    'in the columns that say who did something — the owner, and a group\'s own voice. Choose another id.'
  );
}

/**
 * A handle is the name the owner types: `@ledger`. Kebab-case like an id, but
 * it must start with a letter and stay short — it is typed at the head of a
 * message, not stored in a config file.
 */
export const HANDLE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Shortest and longest a handle may be, `@` excluded. */
export const HANDLE_MIN = 2;
export const HANDLE_MAX = 20;

/**
 * How long an agent's own opening may be.
 *
 * `intro` is one sentence — what this agent does, in its own words, shown on
 * an empty thread where `description` (written for *other agents* to read)
 * sounds like a catalogue entry. A starter is a short example request the
 * owner can click; three is the most that reads as a suggestion rather than a
 * menu, and a long one stops looking like something you would type.
 */
export const INTRO_MAX = 200;
export const STARTER_MAX = 80;
export const STARTERS_MAX = 3;

/** Split `---\n<yaml>\n---\n<body>`. The leading `---` must be the first line. */
export function splitFrontmatter(source: string, file?: string): {
  frontmatter: string;
  body: string;
} {
  const text = source.replace(/^﻿/, '');
  const lines = text.split('\n');
  if ((lines[0] ?? '').trim() !== '---') {
    throw new AgentFileError('no-frontmatter', 'file does not start with a --- frontmatter block', file);
  }
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] as string).trim() === '---') {
      return {
        frontmatter: lines.slice(1, i).join('\n'),
        body: lines.slice(i + 1).join('\n').replace(/^\n+/, ''),
      };
    }
  }
  throw new AgentFileError('unterminated-frontmatter', 'frontmatter block is never closed by ---', file);
}

function scalar(raw: string): string | number | boolean {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value !== '' && /^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function flowList(raw: string): string[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((item) => String(scalar(item)));
}

/** Minimal YAML subset: `key: scalar`, `key: [a, b]`, and `- item` blocks. */
export function parseYamlSubset(source: string, file?: string): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {};
  const lines = source.split('\n');
  let listKey: string | null = null;

  for (const [index, line] of lines.entries()) {
    const where = `line ${index + 1}`;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item) {
      if (listKey === null) {
        throw new AgentFileError('yaml-syntax', `${where}: list item outside a key`, file);
      }
      (out[listKey] as string[]).push(String(scalar(item[1] as string)));
      continue;
    }

    if (/^\s/.test(line)) {
      throw new AgentFileError('yaml-syntax', `${where}: unsupported indentation`, file);
    }

    const pair = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!pair) throw new AgentFileError('yaml-syntax', `${where}: not a "key: value" line`, file);
    const key = pair[1] as string;
    const raw = (pair[2] as string).trim();
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new AgentFileError('yaml-syntax', `${where}: duplicate key "${key}"`, file);
    }

    if (raw === '') {
      out[key] = [];
      listKey = key;
      continue;
    }
    listKey = null;
    out[key] = raw.startsWith('[') && raw.endsWith(']') ? flowList(raw) : scalar(raw);
  }
  return out;
}

/**
 * Frontmatter schema. Strict: an unknown key is a load error, so a typo in
 * `tools` never quietly produces an agent with no tools.
 */
export const agentFrontmatterSchema = z
  .object({
    id: z
      .string()
      .regex(KEBAB, 'id must be kebab-case')
      .refine((id) => !RESERVED_AGENT_IDS.includes(id), (id) => ({ message: reservedAgentIdMessage(id) })),
    /**
     * How the owner addresses this agent: `@ledger`. Required, because an agent
     * nobody can call by name is only half installed; uniqueness across the
     * catalog is the catalog's business, not one file's.
     */
    handle: z
      .string()
      .min(HANDLE_MIN, `handle must be at least ${HANDLE_MIN} characters`)
      .max(HANDLE_MAX, `handle must be at most ${HANDLE_MAX} characters`)
      .regex(HANDLE, 'handle must be kebab-case and start with a letter'),
    name: z.string().min(1),
    description: z.string().min(1),
    /**
     * Which provider this agent runs on. Pinned per agent, because an endpoint
     * is a data destination: the owner's finances go to one company or another
     * by this line, not by whichever key happens to be set.
     */
    provider: z.enum(['anthropic', 'openai']).optional(),
    model: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)),
    /**
     * Capabilities this agent claims, as free-form kebab strings: `overview`,
     * `recap`, `triage`. A role is how a *surface* asks for an agent without
     * naming one — `/status` runs whoever claims `overview` — so the shape is
     * validated and the meaning deliberately is not: core ships no vocabulary
     * of roles, and an installation with different agents invents its own.
     */
    roles: z.array(z.string().regex(KEBAB, 'a role must be kebab-case')).optional(),
    /**
     * One sentence in the agent's own voice: what it does, said to the owner.
     * Absent, a surface falls back to `description`, which is written for
     * other agents and reads like one.
     */
    intro: z.string().min(1).max(INTRO_MAX, `intro must be at most ${INTRO_MAX} characters`).optional(),
    /**
     * Up to three short example requests. They are *drafts* a surface may put
     * in the owner's mouth — never sent on the owner's behalf.
     */
    starters: z
      .array(z.string().min(1).max(STARTER_MAX, `a starter must be at most ${STARTER_MAX} characters`))
      .max(STARTERS_MAX, `at most ${STARTERS_MAX} starters`)
      .optional(),
    /** Shared skills to load by name; private skills are always loaded. */
    skills: z.array(z.string().min(1)).optional(),
    maxTurns: z.number().int().positive().optional(),
    /** Reasoning before answering: `on`, `off`, or absent for the model's default. */
    thinking: z.enum(['on', 'off']).optional(),
    default: z.boolean().optional(),
    language: z.enum(['mirror', 'en', 'fr']).optional(),
    /**
     * The face the dashboard draws: an emoji, or the name of an image file in
     * this agent's own folder (`face.png`). Never a URL: the page fetches
     * nothing off-origin, and a file beside the persona is the owner's.
     */
    avatar: z.string().min(1).max(120).optional(),
    /** The agent's own colour, as `#rrggbb`. Absent: a tint from its id. */
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'accent must be #rrggbb').optional(),
  })
  .strict()
  // The model catalogue validates *within* the pinned provider and never
  // authorizes a migration: an agent file asking for a model its provider does
  // not serve is a configuration error, caught at load, not a silent re-route.
  .superRefine((value, ctx) => {
    if (value.model === undefined) return;
    const kind: ProviderKind = value.provider ?? 'anthropic';
    const problem = modelProblem(kind, value.model);
    if (problem !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: problem });
    }
  });

/** Provider names an agent file may use, for error messages. */
export const AGENT_PROVIDERS: readonly ProviderKind[] = PROVIDER_KINDS;

export type AgentFrontmatter = z.infer<typeof agentFrontmatterSchema>;

export interface ParsedAgentFile {
  frontmatter: AgentFrontmatter;
  body: string;
}

/**
 * Parse one agent file. `dirName`, when given, must equal the declared id — the
 * directory is the agent's address, and two names for one thing is a bug.
 */
export function parseAgentFile(
  source: string,
  opts: { dirName?: string; file?: string } = {},
): ParsedAgentFile {
  const { frontmatter, body } = splitFrontmatter(source, opts.file);
  const raw = parseYamlSubset(frontmatter, opts.file);
  const parsed = agentFrontmatterSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentFileError(
      'invalid-frontmatter',
      parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; '),
      opts.file,
    );
  }
  if (opts.dirName !== undefined && opts.dirName !== parsed.data.id) {
    throw new AgentFileError(
      'id-mismatch',
      `id "${parsed.data.id}" does not match its directory "${opts.dirName}"`,
      opts.file,
    );
  }
  if (body.trim() === '') {
    throw new AgentFileError('invalid-frontmatter', 'agent body (the persona) is empty', opts.file);
  }
  return { frontmatter: parsed.data, body };
}
