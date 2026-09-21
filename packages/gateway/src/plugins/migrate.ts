/**
 * Migrating what is installed, at a start.
 *
 * Core's `runMigrations` does the work; this decides what a failure means.
 * Core's own migrations and the compiled-in plugins' are this build describing
 * itself: if one of those will not apply, the installation is wrong about
 * itself and starting on it would be worse than not starting, so it throws.
 * An installed third-party plugin is the other case — `docs/install.md` §7 is
 * explicit that a plugin which fails to load never stops the gateway, and a
 * plugin whose migrations will not apply has not loaded: it has no schema to
 * work in. So it is demoted to a load failure, left out of
 * `installedManifests` for the rest of this run, and reported by
 * `pluginLoadReport`, which is what the Plugins page and doctor read.
 *
 * Both start paths call this: the supervisor, before it starts the gateway,
 * and `buddi migrate` in a checkout.
 */
import { runMigrations, type AppliedMigration } from '@buddi/core';
import type { Pool } from 'pg';
import { installedManifests } from '../agents/catalog.js';
import { demoteToLoadFailure, externalManifests } from './load.js';

export interface MigrateInstalledResult {
  applied: AppliedMigration[];
  /** The installed plugins whose migrations failed, in the order they failed. */
  problems: Array<{ name: string; message: string }>;
}

export async function migrateInstalled(
  pool: Pool,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MigrateInstalledResult> {
  // Only what the record put here. A process that never adopted the record
  // sees no external plugins at all, so nothing is optional and this is the
  // strict behaviour it always had.
  const optional = externalManifests(env).map((m) => m.name);
  const problems: MigrateInstalledResult['problems'] = [];
  const applied = await runMigrations(pool, installedManifests(env), {
    optional,
    onProblem: (problem) => {
      problems.push({ name: problem.name, message: problem.message });
      demoteToLoadFailure(problem.name, problem.message, env);
    },
  });
  return { applied, problems };
}
