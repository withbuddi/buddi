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

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
    id: z.string().regex(KEBAB, 'id must be kebab-case'),
    name: z.string().min(1),
    description: z.string().min(1),
    model: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)),
    maxTurns: z.number().int().positive().optional(),
    default: z.boolean().optional(),
    language: z.enum(['mirror', 'en', 'fr']).optional(),
  })
  .strict();

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
