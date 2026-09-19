/**
 * Editing an agent file in place.
 *
 * An agent is configuration, and configuration the owner can only change with a
 * text editor is configuration most owners never change. This module is the
 * other half of `frontmatter.ts`: the parser reads the YAML subset, and this
 * writes *only the keys that changed* back into it.
 *
 * The rules it holds to, because an agent file is a document the owner wrote:
 *
 *  - the markdown body is never rewritten — not reflowed, not re-terminated,
 *    not touched at all, so a body containing its own `---` line survives;
 *  - key order is preserved, and so is every key this schema does not know
 *    about (a future `roles:` is somebody else's key, not ours to drop);
 *  - comments and blank lines inside the frontmatter stay where they were;
 *  - a new key is appended to the end of the block rather than sorted in;
 *  - the result is re-parsed before it is written. A patch that would produce a
 *    file the loader refuses is refused *here*, with the file left untouched —
 *    fail closed, and never leave the installation with an agent that will not
 *    load.
 *
 * The model check is the catalogue's, quoted verbatim (`modelProblem`): pinning
 * an OpenAI model on an Anthropic agent is refused in the same sentence the
 * loader would use, because a model is never migrated for anyone.
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import {
  AgentFileError,
  parseAgentFile,
  splitFrontmatter,
  type AgentFrontmatter,
  type YamlValue,
} from './frontmatter.js';
import { modelProblem, type ProviderKind } from '../provider.js';

export class AgentEditError extends Error {
  override readonly name = 'AgentEditError';
  constructor(
    readonly code:
      /** The patch would pin a model the pinned provider does not serve. */
      | 'model-mismatch'
      /** The file does not parse *before* the edit; nothing is written. */
      | 'unreadable'
      /** The patched file would not load. The original is left in place. */
      | 'invalid-result'
      /** Nothing in the patch differs from what the file already says. */
      | 'no-change',
    message: string,
    readonly file?: string,
  ) {
    super(file ? `${file}: ${message}` : message);
  }
}

/**
 * A patch is "set this key" (a value), "remove this key" (`null`) or "leave it
 * alone" (`undefined`, or simply absent). Nothing else is expressible, so no
 * patch can restructure a file.
 */
export type FrontmatterPatch = Record<string, YamlValue | null | undefined>;

/** The engine keys this installation lets an operator change from a command. */
export interface EnginePatch {
  provider?: ProviderKind | undefined;
  model?: string | undefined;
  maxTurns?: number | undefined;
  language?: 'mirror' | 'en' | 'fr' | undefined;
  /** `null` removes the key: back to the model's own default. */
  thinking?: 'on' | 'off' | null | undefined;
}

/** Keys `buddi agents set` and the dashboard may write. Nothing else. */
export const ENGINE_KEYS: readonly string[] = ['provider', 'model', 'maxTurns', 'language', 'thinking'];

/* ------------------------------------------------------------------ *
 * Serialization
 * ------------------------------------------------------------------ */

/** Characters that make a scalar ambiguous to the parser unless it is quoted. */
function needsQuotes(value: string): boolean {
  if (value === '') return true;
  if (value !== value.trim()) return true;
  if (value === 'true' || value === 'false') return true;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return true;
  if (/^[[{#&*!|>'"%@`-]/.test(value)) return true;
  if (value.includes(':') || value.includes('#') || value.includes('\n')) return true;
  return false;
}

/** One frontmatter value, in the subset `parseYamlSubset` reads back. */
export function serializeYamlValue(value: YamlValue): string {
  if (Array.isArray(value)) return `[${value.map((item) => serializeYamlValue(item)).join(', ')}]`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return needsQuotes(value) ? `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : value;
}

/* ------------------------------------------------------------------ *
 * The patch
 * ------------------------------------------------------------------ */

/** `key:` at the start of a line, the only form the parser accepts for a pair. */
function keyOf(line: string): string | undefined {
  return /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line)?.[1];
}

/** Is this line part of a block list belonging to the key above it? */
function isListItem(line: string): boolean {
  return /^\s*-\s/.test(line) || /^\s*-\s*$/.test(line);
}

/**
 * Apply a patch to the frontmatter of `source`, byte-for-byte everywhere else.
 *
 * Pure, and the interesting half of this module: given the same text and the
 * same patch it produces the same text, with no filesystem anywhere near it.
 */
export function applyFrontmatterPatch(
  source: string,
  patch: FrontmatterPatch,
  file?: string,
): string {
  // Validates the shape (and the closing `---`) before anything is spliced.
  splitFrontmatter(source, file);

  const lines = source.split('\n');
  // `splitFrontmatter` has already proven both fences exist.
  let end = 0;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] as string).trim() === '---') {
      end = i;
      break;
    }
  }

  const head = lines.slice(0, 1);
  const block = lines.slice(1, end);
  const tail = lines.slice(end); // the closing fence and the whole body

  const out: string[] = [];
  const applied = new Set<string>();

  for (let i = 0; i < block.length; i++) {
    const line = block[i] as string;
    const key = keyOf(line);
    if (key === undefined || !Object.prototype.hasOwnProperty.call(patch, key)) {
      out.push(line);
      continue;
    }
    const value = patch[key];
    if (value === undefined) {
      out.push(line);
      continue;
    }
    applied.add(key);
    // A block list belongs to its key: replacing or removing the key takes the
    // items with it, or the parser would meet orphaned `- item` lines.
    let skipTo = i;
    while (skipTo + 1 < block.length && isListItem(block[skipTo + 1] as string)) skipTo += 1;
    i = skipTo;
    if (value === null) continue; // removed
    out.push(`${key}: ${serializeYamlValue(value)}`);
  }

  // Keys the file did not have yet go at the end of the block, in patch order.
  for (const [key, value] of Object.entries(patch)) {
    if (applied.has(key) || value === undefined || value === null) continue;
    out.push(`${key}: ${serializeYamlValue(value)}`);
  }

  return [...head, ...out, ...tail].join('\n');
}

export interface FrontmatterEdit {
  /** The whole file, patched. Identical outside the frontmatter block. */
  text: string;
  before: AgentFrontmatter;
  after: AgentFrontmatter;
  /** Keys whose value actually differs, in patch order. */
  changed: string[];
}

/** `provider:` defaults to anthropic when a file does not pin one. */
function providerOf(frontmatter: { provider?: ProviderKind }): ProviderKind {
  return frontmatter.provider ?? 'anthropic';
}

function same(a: YamlValue | undefined, b: YamlValue | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

/**
 * Plan and validate an edit without touching the disk.
 *
 * The model rule is applied against the *resulting* pair: changing only the
 * provider re-validates the model the file already had, which is the case that
 * would otherwise leave a file that parses today and refuses to load tomorrow.
 */
export function patchAgentSource(
  source: string,
  patch: FrontmatterPatch,
  file?: string,
): FrontmatterEdit {
  let parsed;
  try {
    parsed = parseAgentFile(source, file === undefined ? {} : { file });
  } catch (err) {
    throw new AgentEditError(
      'unreadable',
      `will not edit a file that does not load: ${err instanceof Error ? err.message : String(err)}`,
      file,
    );
  }
  const before = parsed.frontmatter;

  const changed = Object.entries(patch)
    .filter(([key, value]) => {
      if (value === undefined) return false;
      const current = (before as Record<string, YamlValue | undefined>)[key];
      return value === null ? current !== undefined : !same(current, value);
    })
    .map(([key]) => key);

  // The catalogue's verdict, quoted, before anything is written.
  const kind = (patch.provider as ProviderKind | undefined) ?? providerOf(before);
  const model = (patch.model as string | undefined) ?? before.model;
  if (model !== undefined) {
    const problem = modelProblem(kind, model);
    if (problem !== undefined) throw new AgentEditError('model-mismatch', problem, file);
  }

  const text = applyFrontmatterPatch(source, patch, file);

  let after;
  try {
    after = parseAgentFile(text, file === undefined ? {} : { file }).frontmatter;
  } catch (err) {
    throw new AgentEditError(
      'invalid-result',
      `this change would leave an agent that cannot load: ${
        err instanceof AgentFileError || err instanceof Error ? err.message : String(err)
      }`,
      file,
    );
  }

  return { text, before, after, changed };
}

export interface AgentFileEdit extends FrontmatterEdit {
  file: string;
  /** False when the file already said exactly this; nothing was written. */
  written: boolean;
}

/**
 * Patch one `agents/<id>/agent.md` on disk.
 *
 * The body is never rewritten, the file's mode is preserved, and a patch that
 * changes nothing writes nothing — re-running the same `buddi agents set` is a
 * no-op rather than a fresh mtime the service would have no reason to reload.
 */
export function updateAgentFrontmatter(
  file: string,
  patch: FrontmatterPatch,
): AgentFileEdit {
  const source = readFileSync(file, 'utf8');
  const edit = patchAgentSource(source, patch, file);
  if (edit.changed.length === 0 || edit.text === source) {
    return { ...edit, file, written: false };
  }
  let mode: number | undefined;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    mode = undefined;
  }
  writeFileSync(file, edit.text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode });
  return { ...edit, file, written: true };
}

/** An `EnginePatch` as a `FrontmatterPatch`; absent keys stay absent. */
export function enginePatch(change: EnginePatch): FrontmatterPatch {
  const patch: FrontmatterPatch = {};
  if (change.provider !== undefined) patch.provider = change.provider;
  if (change.model !== undefined) patch.model = change.model;
  if (change.maxTurns !== undefined) patch.maxTurns = change.maxTurns;
  if (change.language !== undefined) patch.language = change.language;
  if (change.thinking !== undefined) patch.thinking = change.thinking;
  return patch;
}

/** The sentence every surface prints after a successful engine change. */
export const RESTART_NOTE =
  'the running surfaces (buddi serve, Telegram, the scheduler) still hold the old ' +
  'catalog — run `buddi service restart` to apply this change to them';
