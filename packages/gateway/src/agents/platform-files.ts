/**
 * Writing agent files — the disk half of the `platform.*` family.
 *
 * Everything here is pure text or an atomic rename. The rules it keeps, because
 * the thing being written is the owner's configuration and a half-written agent
 * directory is an installation that will not boot:
 *
 *  - **nothing is ever written in place.** A new agent is composed into a
 *    temporary directory and moved onto its final name with one `rename`; an
 *    edited file is written beside itself and renamed over. A crash leaves
 *    either the old tree or the new one, never half of either.
 *  - **a multi-file write stages everything before it moves anything.** An
 *    agent with a `delegates.json` is two files, and an approved change that
 *    rewrote the persona and then failed on the allowlist would be an agent
 *    with new instructions and old authorization.
 *  - **the body is a document.** Editing frontmatter goes through core's
 *    `applyFrontmatterPatch`, which leaves every byte outside the block alone;
 *    replacing the persona replaces exactly the persona.
 *  - **delete never destroys.** The directory is moved under the owner's own
 *    `.trash/`, and the caller is told where it went.
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { serializeYamlValue, splitFrontmatter, type YamlValue } from '@buddi/core';

/** Where a deleted agent goes: a sibling of `agents/`, never inside it. */
export const TRASH_DIR = '.trash';

/** The keys a composed agent file writes, in the order it writes them. */
export const FRONTMATTER_ORDER: readonly string[] = [
  'id',
  'handle',
  'name',
  'description',
  'default',
  'provider',
  'model',
  'tools',
  'roles',
  'skills',
  'maxTurns',
  'language',
];

/**
 * The frontmatter of an agent this family composes.
 *
 * `default` is written for exactly one reason: a private agent replacing a
 * shipped example replaces it *wholesale*, so overriding the example that
 * declares `default: true` would otherwise leave the installation with no
 * default agent at all.
 */
export interface AgentFileSpec {
  id: string;
  handle: string;
  name: string;
  description: string;
  tools: string[];
  provider?: string;
  model?: string;
  roles?: string[];
  maxTurns?: number;
  language?: string;
  /** Only ever carried over from an example being replaced. */
  default?: boolean;
  /** The persona. Written verbatim, with exactly one trailing newline. */
  persona: string;
}

/**
 * Compose a whole `agent.md`.
 *
 * Deterministic over its input, and that matters more than it looks: the
 * envelope the owner approves carries this text, and `execute` recomposes it
 * from the canonical arguments rather than trusting anything carried across.
 * The two must be the same string or the preview lied.
 */
export function composeAgentFile(spec: AgentFileSpec): string {
  const values: Record<string, YamlValue | undefined> = {
    id: spec.id,
    handle: spec.handle,
    name: spec.name,
    description: spec.description,
    default: spec.default === true ? true : undefined,
    provider: spec.provider,
    model: spec.model,
    tools: spec.tools,
    roles: spec.roles === undefined || spec.roles.length === 0 ? undefined : spec.roles,
    maxTurns: spec.maxTurns,
    language: spec.language,
  };
  const lines = FRONTMATTER_ORDER.flatMap((key) => {
    const value = values[key];
    return value === undefined ? [] : [`${key}: ${serializeYamlValue(value)}`];
  });
  return `---\n${lines.join('\n')}\n---\n\n${spec.persona.trim()}\n`;
}

/**
 * Replace the persona of an existing file, byte-for-byte everywhere else.
 *
 * The frontmatter block is copied out of the source rather than re-serialised,
 * so a comment, a blank line or a key this build has never heard of survives an
 * edit that only meant to rewrite the prose.
 */
export function replaceBody(source: string, persona: string, file?: string): string {
  const { frontmatter } = splitFrontmatter(source, file);
  return `---\n${frontmatter}\n---\n\n${persona.trim()}\n`;
}

/** One file to write: an absolute path and its whole contents. */
export interface FileWrite {
  path: string;
  content: string;
}

/**
 * Write several files, staging every one before moving any.
 *
 * Each temporary sits in the destination's own directory so the rename is
 * within one filesystem and therefore atomic. A failure while staging removes
 * what was staged and leaves the tree exactly as it was.
 */
export function writeFilesAtomic(writes: readonly FileWrite[]): void {
  const staged: Array<{ tmp: string; final: string }> = [];
  try {
    for (const write of writes) {
      const dir = path.dirname(write.path);
      mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `.${path.basename(write.path)}.${process.pid}.${Date.now()}.tmp`);
      writeFileSync(tmp, write.content, 'utf8');
      staged.push({ tmp, final: write.path });
    }
  } catch (err) {
    for (const { tmp } of staged) rmSync(tmp, { force: true });
    throw err;
  }
  for (const { tmp, final } of staged) renameSync(tmp, final);
}

/**
 * Create a new agent directory in one move.
 *
 * The whole directory is built somewhere else and renamed into place, so an
 * agent never exists in a state where the catalog could read a persona without
 * its allowlist. A destination that already exists is a caller's bug: this is
 * reached only after validation refused every duplicate it knows about.
 */
export function createAgentDirAtomic(
  target: string,
  files: Readonly<Record<string, string>>,
): void {
  const parent = path.dirname(target);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(path.join(parent, `.new-${path.basename(target)}-`));
  try {
    for (const [name, content] of Object.entries(files)) {
      const file = path.join(staging, name);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content, 'utf8');
    }
    renameSync(staging, target);
  } catch (err) {
    rmSync(staging, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Move an agent directory aside. Returns where it went, which the tool says out
 * loud — a delete the owner cannot undo is not a delete they would have asked
 * for.
 */
export function moveAgentAside(agentDir: string, trashRoot: string, stamp: string): string {
  const destination = path.join(trashRoot, 'agents', `${path.basename(agentDir)}-${stamp}`);
  mkdirSync(path.dirname(destination), { recursive: true });
  renameSync(agentDir, destination);
  return destination;
}

/** `20260915-142233` — sortable, readable, and safe in a path. */
export function trashStamp(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

/** The skill file for a scope: private to one agent, or shared by all of them. */
export function skillFilePath(opts: {
  scope: 'agent' | 'shared';
  name: string;
  agentsDir: string;
  sharedSkillsDir: string;
  agentId?: string;
}): string {
  return opts.scope === 'agent'
    ? path.join(opts.agentsDir, opts.agentId ?? '', 'skills', `${opts.name}.md`)
    : path.join(opts.sharedSkillsDir, `${opts.name}.md`);
}

/** Compose a skill file: the frontmatter the loader reads, then the procedure. */
export function composeSkillFile(spec: {
  name: string;
  description: string;
  provenance: string;
  source?: string;
  created?: string;
  agents?: string[];
  body: string;
}): string {
  const lines = [
    `name: ${serializeYamlValue(spec.name)}`,
    `description: ${serializeYamlValue(spec.description)}`,
    `provenance: ${serializeYamlValue(spec.provenance)}`,
    ...(spec.source === undefined ? [] : [`source: ${serializeYamlValue(spec.source)}`]),
    ...(spec.created === undefined ? [] : [`created: ${serializeYamlValue(spec.created)}`]),
    ...(spec.agents === undefined || spec.agents.length === 0
      ? []
      : [`agents: ${serializeYamlValue(spec.agents)}`]),
  ];
  return `---\n${lines.join('\n')}\n---\n\n${spec.body.trim()}\n`;
}
