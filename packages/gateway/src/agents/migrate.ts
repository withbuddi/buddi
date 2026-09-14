/**
 * `buddi agents migrate` — moving the owner's agents out of the repository.
 *
 * Before the platform/owner split, an installation kept its personas in
 * `<repo>/agents` and its house rules in `<repo>/skills`, both tracked by git.
 * Those files name the owner's bank, their landlord, their inbox: they are the
 * one thing in this clone that must never be shared. This moves them into the
 * private directory, which is gitignored.
 *
 * Two properties matter more than anything clever:
 *
 *  - **it moves, it never copies.** Two catalogs of the same agent, one of them
 *    stale, is worse than either alone. When the move is done the old path is
 *    gone, so there is exactly one file per agent.
 *  - **it is idempotent.** A second run finds nothing to move and says so. A
 *    target that already exists is left alone and reported, never overwritten —
 *    the owner's newer file always wins over the one being migrated.
 *
 * The examples are not touched: they live under `examples/` and they ship.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, rmdirSync } from 'node:fs';
import path from 'node:path';

export interface Move {
  from: string;
  to: string;
}

export interface MigrationResult {
  /** Where everything was moved to — `<repo>/private` unless pinned. */
  targetRoot: string;
  moved: Move[];
  /** Left where they were, with the reason: a target of that name exists. */
  skipped: Array<Move & { reason: string }>;
  /** Source directories that were removed because they ended up empty. */
  removed: string[];
}

export interface MigrateOptions {
  repoRoot: string;
  /** Where the owner's set belongs. `search.ownerRoot` in practice. */
  targetRoot: string;
  /** Report what would happen, change nothing. */
  dryRun?: boolean;
}

/** Move one entry, falling back to copy+remove across filesystems. */
function moveEntry(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    cpSync(from, to, { recursive: true });
    rmSync(from, { recursive: true, force: true });
  }
}

function migrateOne(
  sourceDir: string,
  targetDir: string,
  result: MigrationResult,
  dryRun: boolean,
): void {
  if (!existsSync(sourceDir)) return;
  const entries = readdirSync(sourceDir).filter((name) => !name.startsWith('.'));
  if (entries.length > 0 && !dryRun) mkdirSync(targetDir, { recursive: true });

  for (const name of entries) {
    const from = path.join(sourceDir, name);
    const to = path.join(targetDir, name);
    if (existsSync(to)) {
      result.skipped.push({ from, to, reason: 'a file of that name is already there' });
      continue;
    }
    if (!dryRun) moveEntry(from, to);
    result.moved.push({ from, to });
  }

  // Only when it is genuinely empty: a skipped entry means something is left.
  if (dryRun) return;
  try {
    if (readdirSync(sourceDir).length === 0) {
      rmdirSync(sourceDir);
      result.removed.push(sourceDir);
    }
  } catch {
    /* a directory we cannot tidy is not a failed migration */
  }
}

/**
 * Move `<repo>/agents` and `<repo>/skills` into the private directory.
 * Nothing to move is a successful, empty result — not an error.
 */
export function migrateAgents(opts: MigrateOptions): MigrationResult {
  const dryRun = opts.dryRun ?? false;
  const result: MigrationResult = { targetRoot: opts.targetRoot, moved: [], skipped: [], removed: [] };

  const sameRoot = path.resolve(opts.targetRoot) === path.resolve(opts.repoRoot);
  if (sameRoot) return result; // the target *is* the source; nothing to do

  migrateOne(
    path.join(opts.repoRoot, 'agents'),
    path.join(opts.targetRoot, 'agents'),
    result,
    dryRun,
  );
  migrateOne(
    path.join(opts.repoRoot, 'skills'),
    path.join(opts.targetRoot, 'skills'),
    result,
    dryRun,
  );
  return result;
}

/** What the command prints. Pure, so the wording is testable. */
export function renderMigration(result: MigrationResult, dryRun = false): string {
  const lines: string[] = [];
  if (result.moved.length === 0 && result.skipped.length === 0) {
    return `Nothing to migrate — no agents/ or skills/ directory in the repository.\nYour agents already live outside it.`;
  }
  lines.push(
    dryRun
      ? `Would move into ${result.targetRoot}:`
      : `Moved into ${result.targetRoot}:`,
  );
  for (const move of result.moved) lines.push(`  ${path.basename(move.from)}  →  ${move.to}`);
  for (const skip of result.skipped) {
    lines.push(`  ${path.basename(skip.from)}  left alone — ${skip.reason} (${skip.to})`);
  }
  if (result.removed.length > 0) {
    lines.push(...result.removed.map((dir) => `  removed the empty ${dir}`));
  }
  if (!dryRun) {
    lines.push('', 'These files are gitignored now. Restart the service so it reloads them:');
    lines.push('  buddi service restart');
  }
  return lines.join('\n');
}
