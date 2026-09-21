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
 * Every start path calls this: the supervisor, before it starts the packaged
 * gateway; a checkout's `buddi serve`, before it builds its wiring; and
 * `buddi migrate`, for the owner who wants to migrate without starting.
 */
import { readdir } from 'node:fs/promises';
import { CORE_MIGRATIONS_DIR, runMigrations, type AppliedMigration } from '@buddi/core';
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

/**
 * The refusal that comes before anything runs.
 *
 * `core.migrations` records a file this build does not ship: the database was
 * migrated by newer code, and this code's idea of those tables is the old one.
 * Migrations only go forward, so there is nothing to undo — the answer is the
 * matching release, and the only safe thing to do meanwhile is not to start.
 * Checked for core and for every installed plugin whose directory is readable;
 * one that is not readable is a plugin problem, which `migrateInstalled` says
 * in words rather than a reason to refuse the whole start.
 */
export async function refuseIfSchemaIsNewer(
  pool: Pool,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const exists = await pool.query<{ table_name: string | null }>(
    "SELECT to_regclass('core.migrations') AS table_name",
  );
  // No record table: nothing has ever been applied here, so nothing can be
  // newer than this build.
  if (!exists.rows[0]?.table_name) return;
  const shipped = new Map([['core', new Set(await readdir(CORE_MIGRATIONS_DIR))]]);
  for (const manifest of installedManifests(env)) {
    if (!manifest.migrationsDir) continue;
    const files = await readdir(manifest.migrationsDir).catch(() => null);
    if (files) shipped.set(manifest.schema, new Set(files));
  }
  const applied = await pool.query<{ schema: string; filename: string }>(
    'SELECT schema, filename FROM core.migrations',
  );
  if (
    applied.rows.some((row) => shipped.has(row.schema) && !shipped.get(row.schema)!.has(row.filename))
  ) {
    throw new Error(
      'Database schema is newer than this release. Install the matching release; ' +
        'no migration or gateway start was attempted.',
    );
  }
}

/**
 * Migrating at a start: the refusal, the migrations, and the account of them.
 *
 * One function so that every start is the same start. The supervisor runs it
 * before it spawns the packaged gateway; a checkout's `buddi serve` runs it on
 * itself, for the same reason — an owner restarting after a `git pull` should
 * not have to remember a second command, and the failure mode they were being
 * asked to avoid (new code on the old schema) is exactly the one a forgotten
 * command produces.
 *
 * Throws on the refusal and on core's or a compiled-in plugin's migrations; an
 * installed third-party plugin's failure is returned in `problems`, having
 * already been demoted to the load report.
 */
export async function migrateAtStart(
  pool: Pool,
  env: NodeJS.ProcessEnv = process.env,
  options: { log?: (line: string) => void } = {},
): Promise<MigrateInstalledResult> {
  const log = options.log ?? ((line: string) => console.error(line));
  await refuseIfSchemaIsNewer(pool, env);
  const result = await migrateInstalled(pool, env);
  for (const applied of result.applied) log(`migrate: applied ${applied.schema}/${applied.filename}`);
  log(
    result.applied.length === 0
      ? 'migrate: schema up to date'
      : `migrate: ${result.applied.length} migration(s) applied`,
  );
  for (const problem of result.problems) {
    log(`plugin ${problem.name} was not loaded: ${problem.message}`);
  }
  return result;
}
