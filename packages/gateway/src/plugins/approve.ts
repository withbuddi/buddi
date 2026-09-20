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
 * Two hashes, doing two different jobs. The integrity is the *tarball's*, and
 * it is what the owner reads and types back. `stagedHash` is the tree's, taken
 * after unpacking and after `npm install`, and it is what this file re-computes
 * immediately before the first import: a stage sits on disk for as long as the
 * owner takes to decide, and the bytes that run must be the bytes that were
 * described. Neither hash replaces the other.
 *
 * Only after that does the entry point get imported, the existing
 * `planInstall` run, and the prose compared with the manifest. Approval 2
 * exists for one case: that comparison found a difference. A package whose
 * `buddi.md` and manifest agree installs on one approval; one that disagrees
 * stops and shows the owner both.
 *
 * The move is last and is ordinary in shape, careful in order: the record is
 * written first, marked `placing`, then the staged package is renamed under
 * `<data>/plugins/<name>/`, then the tree is hashed again and has to equal
 * what was hashed before the import — a plugin that rewrote itself while being
 * imported is refused and removed — and only then is the record finalised.
 * Nothing here restarts anything: an installed plugin is registered by the
 * next process start, and the caller is told so with `restartNeeded`.
 */
import { existsSync, renameSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import {
  migrate,
  pluginsFilePath,
  readPluginsFile,
  removeInstalledPlugin,
  upsertInstalledPlugin,
  writePluginsFile,
  type InstalledPlugin,
  type PluginProvenance,
} from '@buddi/core';
import type { Pool } from 'pg';
import { agentSearchPath } from '../agents/catalog.js';
import { driftBetween } from './claims.js';
import { entryPointOf, planInstall, type InstallPlan } from './install.js';
import { InstallRefusal } from './refusals.js';
import { loadManifest } from './load.js';
import { assertInsidePluginsRoot, installedPackageDir } from './paths.js';
import { treeHash, TreeRefusal } from './tree.js';
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

/**
 * One approval at a time, per plugin name.
 *
 * Two approvals of the same name racing would both rename into the same
 * directory and both write the record: whichever lost the rename would write a
 * record pointing at the other one's files. Nothing in a dashboard stops an
 * owner clicking twice, so the serialisation lives here rather than in a
 * caller.
 */
const inFlight = new Map<string, Promise<unknown>>();

async function perName<T>(name: string, work: () => Promise<T>): Promise<T> {
  const previous = inFlight.get(name) ?? Promise.resolve();
  const queued = previous.then(work, work);
  const settled = queued.catch(() => undefined);
  inFlight.set(name, settled);
  try {
    return await queued;
  } finally {
    if (inFlight.get(name) === settled) inFlight.delete(name);
  }
}

/** The hash of the staged tree, now. Refuses a tree that grew a link. */
function hashStagedTree(staged: StagedPlugin): string {
  try {
    return treeHash(staged.packageDir, { includeModules: true, linksAllowedUnder: 'node_modules' });
  } catch (err) {
    if (err instanceof TreeRefusal) throw new InstallRefusal('unsafe-tree', err.message);
    throw err;
  }
}

export async function approveStaged(id: string, opts: ApproveOptions): Promise<ApprovalOutcome> {
  const env = opts.env ?? process.env;
  const staged = readStaged(id, env);
  return perName(staged.name, () => approveOne(staged, id, opts));
}

async function approveOne(
  staged: StagedPlugin,
  id: string,
  opts: ApproveOptions,
): Promise<ApprovalOutcome> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? ((): Date => new Date());

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

  /*
   * The last thing before the first import: are these still the bytes that
   * were read? A stage waits on disk for as long as the owner takes, and the
   * card they are answering describes what was there when it was written.
   */
  let preImportHash = '';
  if (staged.stagedHash !== undefined && staged.stagedHash !== '') {
    preImportHash = hashStagedTree(staged);
    if (preImportHash !== staged.stagedHash) {
      throw new InstallRefusal(
        'staged-changed',
        `the staged files for ${staged.name} ${staged.version} are not the ones that were read: they ` +
          `hashed to ${staged.stagedHash} and they hash to ${preImportHash} now. Nothing was imported. ` +
          `Reject it (buddi plugins reject ${id}) and stage it again.`,
      );
    }
  }

  // Recorded before the import, not after. The whole point of the record is
  // that it says what the owner agreed to; writing it afterwards would mean a
  // plugin whose top-level code never returns was never recorded as approved.
  const approvedAt = now().toISOString();
  writeStaged({ ...staged, state: 'approved', approvedAt, approvedIntegrity: staged.integrity });

  // The first import of this plugin's code, ever.
  const plan = await planInstall(staged.packageDir, env);
  assertNameMatches(staged, plan);
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
    preImportHash,
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
 * The manifest has to answer to the name of the package it came in.
 *
 * Otherwise a package called `buddi-plugin-weather` can carry a manifest
 * called `finance`, take that name in the record, take that schema, and be
 * granted to an agent under a name the owner never installed. The escape hatch
 * is written down rather than guessed at: `package.json` may declare
 * `buddi.name`, which is the name its manifest uses, and that is the name that
 * must match.
 *
 * A directory source is exempt: the owner typed a path to a build on their own
 * disk, and the identity of that build is the path, not a registry name.
 */
function assertNameMatches(staged: StagedPlugin, plan: InstallPlan): void {
  if (staged.source.kind === 'directory') return;
  const declared = staged.declaredName ?? staged.name;
  if (plan.manifest.name === declared) return;
  throw new InstallRefusal(
    'name-mismatch',
    `the package ${staged.name} ${staged.version} says its plugin is called "${declared}", and the ` +
      `manifest it exports calls itself "${plan.manifest.name}". A package installs under its own name ` +
      'or under the "buddi": {"name": …} it declares, and this one does neither. Nothing was installed.',
  );
}

/**
 * Move the package into place, write the record, migrate.
 *
 * The order is chosen so that every failure leaves something the owner can
 * understand: the record says what is being placed before anything is moved,
 * the previous version is moved aside rather than deleted and is only removed
 * once the record names the new one, and migrations run last because a
 * migration that fails leaves a plugin installed and unusable, which
 * `buddi plugins list` already reports, rather than a schema migrated for a
 * plugin no record mentions.
 */
async function place(
  staged: StagedPlugin,
  plan: InstallPlan,
  opts: { env: NodeJS.ProcessEnv; approvedAt: string; preImportHash: string; pool?: Pool },
): Promise<{ record: InstalledPlugin; entry: string; migrations: string[]; migrationProblem?: string }> {
  const env = opts.env;
  const moving = staged.source.kind !== 'directory';
  const finalDir = moving ? assertInsidePluginsRoot(installedPackageDir(plan.manifest.name, env), env) : staged.packageDir;
  const file = pluginsFilePath({ ownerRoot: agentSearchPath(env).ownerRoot, env });

  const provenance: PluginProvenance | undefined = moving
    ? {
        ...(staged.integrity === '' ? {} : { integrity: staged.integrity }),
        ...(staged.publisher === undefined ? {} : { publisher: staged.publisher }),
        // What was hashed before the import, not after: the bytes the owner
        // agreed to are the ones that were read, and the check below is what
        // proves the move did not change them.
        installedHash: opts.preImportHash,
        approvedAt: opts.approvedAt,
        ...(staged.integrity === '' ? {} : { approvedIntegrity: staged.integrity }),
      }
    : undefined;

  const base: InstalledPlugin = {
    name: plan.manifest.name,
    version: plan.manifest.version,
    // The entry is under the directory it is about to live in, which is where
    // `entryPointOf` below re-derives it from once the files are there.
    entry: path.join(finalDir, path.relative(staged.packageDir, plan.entry)),
    schema: plan.manifest.schema,
    installedAt: opts.approvedAt,
    source: staged.source,
    ...(provenance === undefined ? {} : { provenance }),
  };

  let asideDir: string | undefined;
  const previousRecord = readPluginsFile(file).plugins.find((p) => p.name === base.name);
  if (moving) {
    // The intent, before the files. A crash from here on leaves a record that
    // says what was happening rather than a directory nobody can account for.
    writePluginsFile(file, upsertInstalledPlugin(readPluginsFile(file), { ...base, placing: true }));
    mkdirSync(path.dirname(finalDir), { recursive: true });
    if (existsSync(finalDir)) {
      asideDir = assertInsidePluginsRoot(`${finalDir}.previous-${Date.now()}`, env);
      renameSync(finalDir, asideDir);
    }
    try {
      renameSync(staged.packageDir, finalDir);
    } catch (err) {
      if (asideDir !== undefined) renameSync(asideDir, finalDir);
      unplace(file, base.name, previousRecord);
      throw new InstallRefusal(
        'move-failed',
        `${staged.name} could not be moved into ${finalDir}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // The same bytes, in a new place. A plugin whose top-level code rewrote
    // its own files during the import would otherwise be recorded under a hash
    // of something that is no longer there.
    const afterMove = treeHash(finalDir, { includeModules: true, linksAllowedUnder: 'node_modules' });
    if (afterMove !== opts.preImportHash) {
      rmSync(finalDir, { recursive: true, force: true });
      if (asideDir !== undefined) renameSync(asideDir, finalDir);
      unplace(file, base.name, previousRecord);
      throw new InstallRefusal(
        'changed-on-import',
        `${staged.name} ${staged.version} changed its own files while it was being imported: they ` +
          `hashed to ${opts.preImportHash} before and ${afterMove} after. It has been removed. That is ` +
          'a package rewriting itself as it is read, and nothing about it can be described to you.',
      );
    }
  }

  const entry = entryPointOf(finalDir);
  const record: InstalledPlugin = { ...base, entry };
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

/**
 * Undo the `placing` record when the move it announced did not happen.
 *
 * The entry that was there before is written back verbatim — an upgrade whose
 * move failed has its old version on disk again, so its old record is the true
 * one — and a first install's entry is removed, because nothing is installed.
 */
function unplace(file: string, name: string, previous: InstalledPlugin | undefined): void {
  try {
    const contents = readPluginsFile(file);
    const current = contents.plugins.find((p) => p.name === name);
    if (current?.placing !== true) return;
    writePluginsFile(
      file,
      previous === undefined
        ? removeInstalledPlugin(contents, name).contents
        : upsertInstalledPlugin(contents, previous),
    );
  } catch {
    // The record is already the thing that went wrong; the refusal being
    // thrown says so, and `buddi plugins list` reads what is there.
  }
}
