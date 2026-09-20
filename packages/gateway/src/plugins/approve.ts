/**
 * The two approvals.
 *
 * Approval 1 is the one that matters: until it happens nothing of the plugin
 * has been imported, and typing it is the owner saying yes to the sentence in
 * `TRUST_SENTENCE` and to a specific integrity hash. The hash is passed back
 * rather than assumed — the caller returns the string it displayed, and a
 * mismatch refuses — so an approval can never apply to a package the owner did
 * not read. It is the same shape as a gated tool's approval: the envelope is
 * what was shown, and executing checks it still matches.
 *
 * Only after that does the entry point get imported, the existing
 * `planInstall` run, and the prose compared with the manifest. Approval 2
 * exists for one case: that comparison found a difference. A package whose
 * `buddi.md` and manifest agree installs on one approval; one that disagrees
 * stops and shows the owner both.
 *
 * The move is last and is ordinary: rename the staged package under
 * `<data>/plugins/<name>`, keeping any previous version aside until the record
 * is written, then apply that plugin's migrations into its own schema. Nothing
 * here restarts anything: an installed plugin is registered by the next
 * process start, and the caller is told so with `restartNeeded`.
 */
import { existsSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  migrate,
  pluginsFilePath,
  readPluginsFile,
  upsertInstalledPlugin,
  writePluginsFile,
  type InstalledPlugin,
  type PluginProvenance,
} from '@buddi/core';
import type { Pool } from 'pg';
import { agentSearchPath } from '../agents/catalog.js';
import { driftBetween } from './claims.js';
import { installedHashOf } from './hash.js';
import { entryPointOf, InstallRefusal, planInstall, type InstallPlan } from './install.js';
import { loadManifest } from './load.js';
import { installedPackageDir } from './paths.js';
import {
  readStaged,
  rejectStaged,
  stagedPackageExists,
  writeStaged,
  type StagedPlan,
  type StagedPlugin,
} from './stage.js';

export interface ApproveOptions {
  /** The integrity string the caller displayed. A mismatch refuses. */
  integrity: string;
  /** Approval 2. Only ever needed when the first approval reported drift. */
  acknowledgeDrift?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Applying the plugin's own migrations needs it; without it they wait. */
  pool?: Pool;
  now?: () => Date;
}

export type ApprovalOutcome =
  /** Approval 2 is needed: the prose and the manifest disagree. */
  | { kind: 'drift'; staged: StagedPlugin; plan: StagedPlan }
  | {
      kind: 'installed';
      record: InstalledPlugin;
      plan: InstallPlan;
      /** Always true: the registry is built at process start. */
      restartNeeded: true;
      /** Migration filenames applied, or the reason none were. */
      migrations: string[];
      migrationProblem?: string;
    };

/** A constant-time-ish equality that also treats absent and empty as the same. */
function sameIntegrity(shown: string | undefined, recorded: string): boolean {
  return (shown ?? '').trim() === recorded.trim();
}

export async function approveStaged(id: string, opts: ApproveOptions): Promise<ApprovalOutcome> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? ((): Date => new Date());
  const staged = readStaged(id, env);

  if (!sameIntegrity(opts.integrity, staged.integrity)) {
    throw new InstallRefusal(
      'integrity-mismatch',
      `the integrity you approved is not the one that was staged. You approved "${opts.integrity}"; ` +
        `${staged.name} ${staged.version} staged as "${staged.integrity || '(none: a directory source)'}". ` +
        'Nothing was imported. Stage it again and read the hash before approving it.',
    );
  }
  if (!stagedPackageExists(staged)) {
    throw new InstallRefusal(
      'stage-gone',
      `the staged files for ${staged.name} are not on disk any more (${staged.packageDir}); stage it again`,
    );
  }

  // Recorded before the import, not after. The whole point of the record is
  // that it says what the owner agreed to; writing it afterwards would mean a
  // plugin whose top-level code never returns was never recorded as approved.
  const approvedAt = now().toISOString();
  writeStaged({ ...staged, state: 'approved', approvedAt, approvedIntegrity: staged.integrity });

  // The first import of this plugin's code, ever.
  const plan = await planInstall(staged.packageDir, env);
  const drift = driftBetween(staged.claims, plan.manifest);
  const stagedPlan: StagedPlan = {
    contribution: plan.contribution,
    drift,
    agents: plan.agents,
  };

  if (drift.length > 0 && opts.acknowledgeDrift !== true) {
    writeStaged({
      ...staged,
      state: 'planned',
      approvedAt,
      approvedIntegrity: staged.integrity,
      plan: stagedPlan,
    });
    return { kind: 'drift', staged: readStaged(id, env), plan: stagedPlan };
  }

  const { record, migrations, migrationProblem, entry } = await place(staged, plan, {
    env,
    approvedAt,
    ...(opts.pool === undefined ? {} : { pool: opts.pool }),
  });
  rejectStaged(id, env);
  return {
    kind: 'installed',
    record,
    plan: { ...plan, entry },
    restartNeeded: true,
    migrations,
    ...(migrationProblem === undefined ? {} : { migrationProblem }),
  };
}

/**
 * Move the package into place, write the record, migrate.
 *
 * The order is chosen so that every failure leaves something the owner can
 * understand: the previous version is moved aside rather than deleted and is
 * only removed once the record names the new one, and migrations run last
 * because a migration that fails leaves a plugin installed and unusable, which
 * `buddi plugins list` already reports, rather than a schema migrated for a
 * plugin no record mentions.
 */
async function place(
  staged: StagedPlugin,
  plan: InstallPlan,
  opts: { env: NodeJS.ProcessEnv; approvedAt: string; pool?: Pool },
): Promise<{ record: InstalledPlugin; entry: string; migrations: string[]; migrationProblem?: string }> {
  const env = opts.env;
  let finalDir = staged.packageDir;
  let asideDir: string | undefined;

  if (staged.source.kind !== 'directory') {
    finalDir = installedPackageDir(plan.manifest.name, env);
    mkdirSync(path.dirname(finalDir), { recursive: true });
    if (existsSync(finalDir)) {
      asideDir = `${finalDir}.previous-${Date.now()}`;
      renameSync(finalDir, asideDir);
    }
    try {
      renameSync(staged.packageDir, finalDir);
    } catch (err) {
      if (asideDir !== undefined) renameSync(asideDir, finalDir);
      throw new InstallRefusal(
        'move-failed',
        `${staged.name} could not be moved into ${finalDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const entry = entryPointOf(finalDir);
  const provenance: PluginProvenance | undefined =
    staged.source.kind === 'directory'
      ? undefined
      : {
          ...(staged.integrity === '' ? {} : { integrity: staged.integrity }),
          ...(staged.publisher === undefined ? {} : { publisher: staged.publisher }),
          installedHash: installedHashOf(finalDir),
          approvedAt: opts.approvedAt,
          ...(staged.integrity === '' ? {} : { approvedIntegrity: staged.integrity }),
        };

  const record: InstalledPlugin = {
    name: plan.manifest.name,
    version: plan.manifest.version,
    entry,
    schema: plan.manifest.schema,
    installedAt: opts.approvedAt,
    source: staged.source,
    ...(provenance === undefined ? {} : { provenance }),
  };
  const file = pluginsFilePath({ ownerRoot: agentSearchPath(env).ownerRoot, env });
  writePluginsFile(file, upsertInstalledPlugin(readPluginsFile(file), record));
  if (asideDir !== undefined) rmSync(asideDir, { recursive: true, force: true });

  // The manifest was read from the staging directory, so its `migrationsDir`
  // points there. Re-read it from where it now lives rather than rewriting the
  // path: the package decides what its migrations directory is, not this file.
  let migrations: string[] = [];
  let migrationProblem: string | undefined;
  const moved = await loadManifest(entry, { name: record.name }, env);
  const migrationsDir = moved.ok ? moved.manifest.migrationsDir : plan.manifest.migrationsDir;
  if (migrationsDir.trim() === '') {
    migrations = [];
  } else if (opts.pool === undefined) {
    migrationProblem = 'the database was not reachable, so its migrations were not applied: run `buddi migrate`';
  } else {
    try {
      const applied = await migrate(opts.pool, { schema: record.schema, dir: migrationsDir });
      migrations = applied.map((m) => m.filename);
    } catch (err) {
      migrationProblem = `its migrations failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return {
    record,
    entry,
    migrations,
    ...(migrationProblem === undefined ? {} : { migrationProblem }),
  };
}
