/**
 * Where the installation lives.
 *
 * `buddi` is a *global* binary: it is run from any directory, so the repo can
 * never be inferred from `process.cwd()`. It is resolved from this module's own
 * location instead — walking up until the workspace root is found — which keeps
 * working through the symlink `pnpm link --global` leaves behind (Node resolves
 * the entry point's real path before this module is evaluated).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hydrateDatabaseUrl, type DatabaseUrlResolution } from '@buddi/core';
import { loadPluginsOnce } from '@buddi/gateway';
import { config as loadDotenv } from 'dotenv';

/** `packages/cli/dist` at runtime, `packages/cli/src` under vitest. */
export const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/** A directory is the repo root when it holds the workspace manifest. */
export function isRepoRoot(dir: string): boolean {
  return existsSync(path.join(dir, 'pnpm-workspace.yaml'));
}

/**
 * Walk up from `start` to the workspace root. Falls back to three levels up
 * (`packages/cli/dist` → repo) rather than throwing, so a packed install that
 * lost the workspace manifest still points somewhere sane.
 */
export function findRepoRoot(start: string, exists: (dir: string) => boolean = isRepoRoot): string {
  let dir = start;
  for (;;) {
    if (exists(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start, '..', '..', '..');
    dir = parent;
  }
}

export const REPO_ROOT = findRepoRoot(MODULE_DIR);

/** Everything the installation writes: artifacts, logs. Overridable for tests. */
export const DATA_DIR = process.env.BUDDI_DATA_DIR ?? path.join(REPO_ROOT, 'data');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const ENV_FILE = path.join(REPO_ROOT, '.env');
export const ENV_EXAMPLE_FILE = path.join(REPO_ROOT, '.env.example');
/** What the service supervises: the built long-running process. */
export const SERVE_ENTRY = path.join(REPO_ROOT, 'packages', 'gateway', 'dist', 'serve.js');
/** The built `buddi` binary — what a scheduled backup runs. */
export const CLI_ENTRY = path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'main.js');
/** Where `buddi backup create` writes unless `--out` says otherwise. */
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');

/** Load `.env` from the repo root. Idempotent; never overrides a real env var. */
export function loadEnv(): void {
  loadDotenv({ path: ENV_FILE });
}

/**
 * `.env`, and then the one variable that is deliberately no longer in it.
 *
 * `DATABASE_URL` is assembled from the vault at runtime rather than written
 * into `.env` with the password in clear, and reading the vault is a keychain
 * call. Every subcommand waits on this before it touches `process.env.DATABASE_URL`.
 */
export async function loadEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DatabaseUrlResolution> {
  loadEnv();
  // The installed plugins, for the same reason and at the same moment: a
  // registry built before the record is read has none of their tools, and an
  // agent granted one of those tools then fails to load.
  await loadPluginsOnce(env);
  return hydrateDatabaseUrl(env);
}
