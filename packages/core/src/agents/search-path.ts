/**
 * Where agents and skills are looked for — the platform/owner split.
 *
 * buddi is two things in one clone: a *platform* anybody may read, and one
 * owner's *private configuration* — personas that name their bank, their
 * landlord, their inbox. Shipping the second with the first is the mistake
 * this module exists to make impossible: the repository carries `examples/`,
 * and the owner's real agents live somewhere that is never committed.
 *
 * So a catalog is loaded from an ordered *search path*, not a directory:
 *
 *   1. `examples/agents` and `examples/skills` — shipped with the repo;
 *   2. the owner's private set — `BUDDI_AGENTS_DIR` if set, else
 *      `<repo>/private/agents` when it exists, else `~/.buddi/agents`
 *      (`BUDDI_SKILLS_DIR` / `<repo>/private/skills` / `~/.buddi/skills`).
 *
 * Later wins. A private agent whose id matches an example one *replaces* it
 * wholesale — the file, never a merge: half an example persona blended into
 * half of the owner's is a prompt nobody wrote and nobody can review. The same
 * rule holds for a skill, by name.
 *
 * One concession to installations that predate the split: when no private
 * directory exists but `<repo>/agents` does, that directory *is* the private
 * set, `legacy` is true, and the caller prints a one-line notice pointing at
 * `buddi agents migrate`. An upgrade may never silently stop loading the
 * owner's agents.
 *
 * Pure: `env`, `home` and `exists` are all injected, so the whole resolution
 * is testable without touching a disk or `process.env`.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Which half of the search path an agent or skill came from. */
export type AgentSource = 'example' | 'private';

/** The environment variables that override the private half of the path. */
export const AGENTS_DIR_ENV = 'BUDDI_AGENTS_DIR';
export const SKILLS_DIR_ENV = 'BUDDI_SKILLS_DIR';

/** The repo-relative locations, as constants so nothing spells them twice. */
export const EXAMPLES_DIR = 'examples';
export const PRIVATE_DIR = 'private';

/** One entry of the search path: an agents directory and its skills directory. */
export interface AgentSearchEntry {
  dir: string;
  skillsDir: string;
  source: AgentSource;
  /** False when the directory is not on disk — skipped rather than an error. */
  exists: boolean;
}

export interface AgentSearchPath {
  /** In load order, earliest first. Later entries override earlier ones. */
  entries: AgentSearchEntry[];
  examples: AgentSearchEntry;
  /** The owner's half — the one `buddi init` creates and `migrate` fills. */
  owner: AgentSearchEntry;
  /**
   * The directory the owner's agents and skills belong under — `<repo>/private`
   * by default. On a legacy installation this is the *migration target*, not
   * where `owner.dir` currently points.
   */
  ownerRoot: string;
  /** True when the owner's half is still the pre-split `<repo>/agents`. */
  legacy: boolean;
}

export interface ResolveSearchPathOptions {
  repoRoot: string;
  env?: NodeJS.ProcessEnv;
  /** The owner's home directory; injected so tests never read a real one. */
  home?: string;
  /** Injected in tests. Defaults to `existsSync`. */
  exists?: (dir: string) => boolean;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * Resolve the search path. Never throws and never creates anything: a machine
 * with no private directory yet is a valid machine that runs the examples.
 */
export function resolveAgentSearchPath(opts: ResolveSearchPathOptions): AgentSearchPath {
  const env = opts.env ?? {};
  const exists = opts.exists ?? existsSync;
  const home = opts.home ?? env.HOME ?? env.USERPROFILE ?? '';
  const repoRoot = opts.repoRoot;

  const examplesDir = path.join(repoRoot, EXAMPLES_DIR, 'agents');
  const examplesSkills = path.join(repoRoot, EXAMPLES_DIR, 'skills');

  const repoPrivate = path.join(repoRoot, PRIVATE_DIR);
  const homePrivate = path.join(home, '.buddi');

  const pinnedAgents = nonEmpty(env[AGENTS_DIR_ENV]);
  const pinnedSkills = nonEmpty(env[SKILLS_DIR_ENV]);

  const resolvedAgents =
    pinnedAgents ??
    (exists(path.join(repoPrivate, 'agents')) ? path.join(repoPrivate, 'agents') : path.join(homePrivate, 'agents'));
  const resolvedSkills =
    pinnedSkills ??
    (exists(path.join(repoPrivate, 'skills')) || exists(path.join(repoPrivate, 'agents'))
      ? path.join(repoPrivate, 'skills')
      : path.join(homePrivate, 'skills'));

  // The pre-split layout, still on disk. Only when nothing private exists yet
  // and only when `BUDDI_AGENTS_DIR` did not pin something explicitly.
  const legacyAgents = path.join(repoRoot, 'agents');
  const legacy = pinnedAgents === undefined && !exists(resolvedAgents) && exists(legacyAgents);
  const ownerAgents = legacy ? legacyAgents : resolvedAgents;
  const ownerSkills = legacy && pinnedSkills === undefined ? path.join(repoRoot, 'skills') : resolvedSkills;

  const examples: AgentSearchEntry = {
    dir: examplesDir,
    skillsDir: examplesSkills,
    source: 'example',
    exists: exists(examplesDir),
  };
  const owner: AgentSearchEntry = {
    dir: ownerAgents,
    skillsDir: ownerSkills,
    source: 'private',
    exists: exists(ownerAgents),
  };

  return {
    entries: [examples, owner],
    examples,
    owner,
    // Where the owner's set *belongs* — the migration target, which is still
    // the private directory even while the legacy one is what loads today.
    ownerRoot: path.dirname(resolvedAgents),
    legacy,
  };
}

/**
 * The one line an installation that has not migrated yet should see, or
 * `undefined` when there is nothing to say. Printed once per process.
 */
export function migrationNotice(search: AgentSearchPath): string | undefined {
  if (!search.legacy) return undefined;
  return (
    `buddi: your agents still live in ${search.owner.dir}, inside the repository — ` +
    'run `buddi agents migrate` to move them somewhere private (they are never committed).'
  );
}
