/**
 * Installing a plugin — deliberately a two-step act.
 *
 * `planInstall` reads the package, imports its entry point, and works out
 * everything that can be known without changing anything: what it is, what it
 * contributes, whether its name or its schema collides with something already
 * here, and — on an upgrade — what has happened to the agents the owner
 * accepted from it. `applyInstall` writes the record.
 *
 * The split is the whole point. Installing is running somebody else's code, so
 * the owner reads the contribution summary *first* and then says yes; there is
 * no path in this module that writes a record without a plan having been
 * rendered.
 *
 * Note what the plan already had to do to be honest: importing the entry point
 * is itself running the plugin's top-level code. There is no way to describe a
 * module without loading it, and pretending otherwise would be the dishonest
 * version. What the summary buys is that nothing is *registered*, no schema is
 * created and nothing is scheduled until the owner agrees — and the owner is
 * told this in the CLI's own words.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  contributionOf,
  pluginsFilePath,
  readPluginsFile,
  upsertInstalledPlugin,
  writePluginsFile,
  type InstalledPlugin,
  type PluginContribution,
  type PluginManifest,
} from '@buddi/core';
import { agentSearchPath, AGENTS_DIR } from '../agents/catalog.js';
import { driftFor, type Drift } from './provenance.js';
import { loadManifest, manifestProblem, recordFile, BUILT_IN_PLUGINS } from './load.js';

/** Schemas this build already owns. A plugin claiming one is refused. */
export const BUILT_IN_SCHEMAS: readonly string[] = ['core', 'public', 'finance', 'memory', 'email'];

export class InstallRefusal extends Error {
  override readonly name = 'InstallRefusal';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function refuse(code: string, message: string): never {
  throw new InstallRefusal(code, message);
}

/**
 * The module a package directory says to import.
 *
 * `main` first, then a `.` export condition, which is how every package in
 * this repository is written. Anything more elaborate is a resolver, and a
 * resolver is exactly the kind of thing that should wait for the npm source.
 */
export function entryPointOf(directory: string): string {
  const packageFile = path.join(directory, 'package.json');
  if (!existsSync(packageFile)) {
    refuse(
      'not-a-package',
      `${directory} has no package.json, so it is not a plugin package. A plugin is a built npm-style ` +
        'package directory: package.json, a dist/ it points at, and migrations/ if it owns tables.',
    );
  }
  let pkg: Record<string, any>;
  try {
    pkg = JSON.parse(readFileSync(packageFile, 'utf8')) as Record<string, any>;
  } catch (err) {
    refuse('bad-package', `${packageFile} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const dot = pkg.exports?.['.'];
  const fromExports =
    typeof dot === 'string' ? dot : typeof dot?.default === 'string' ? dot.default : undefined;
  const relative = typeof pkg.main === 'string' ? pkg.main : fromExports;
  if (relative === undefined) {
    refuse('no-entry', `${packageFile} names no "main" and no "." export, so there is nothing to import`);
  }
  const entry = path.resolve(directory, relative);
  if (!existsSync(entry)) {
    refuse(
      'not-built',
      `${packageFile} points at ${relative}, which is not on disk. The plugin is not built — run its ` +
        'own build (`pnpm build`) in that directory and try again.',
    );
  }
  return entry;
}

export interface InstallPlan {
  directory: string;
  entry: string;
  manifest: PluginManifest;
  contribution: PluginContribution;
  /** The record being replaced, when this is an upgrade. */
  previous?: InstalledPlugin;
  /** Every agent it proposes, and where the owner's copy stands today. */
  agents: Array<{ id: string; handle: string; drift: Drift }>;
  /** Where the record will be written. */
  recordFile: string;
}

/** Everything knowable before anything changes. Throws an `InstallRefusal`. */
export async function planInstall(
  directory: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<InstallPlan> {
  const dir = path.resolve(directory);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    refuse('no-directory', `${dir} is not a directory`);
  }
  const entry = entryPointOf(dir);
  const loaded = await loadManifest(entry);
  if (!loaded.ok) refuse('not-a-plugin', `${dir} is not a usable plugin: ${loaded.message}`);
  const manifest = loaded.manifest;
  const problem = manifestProblem(manifest);
  if (problem !== undefined) refuse('not-a-plugin', problem);

  const file = recordFile(env);
  const contents = readPluginsFile(file);
  const previous = contents.plugins.find((p) => p.name === manifest.name);
  if (BUILT_IN_SCHEMAS.includes(manifest.schema) && previous === undefined) {
    refuse(
      'schema-taken',
      `plugin "${manifest.name}" wants the Postgres schema "${manifest.schema}", which buddi itself or ` +
        'one of its built-in plugins already owns. A plugin owns its own schema and nobody else\'s.',
    );
  }
  const schemaOwner = contents.plugins.find(
    (p) => p.schema === manifest.schema && p.name !== manifest.name,
  );
  if (schemaOwner) {
    refuse(
      'schema-taken',
      `plugin "${manifest.name}" wants the schema "${manifest.schema}", which "${schemaOwner.name}" ` +
        'already owns here. Uninstall that one first, or ask this plugin\'s author for a schema of its own.',
    );
  }
  if (previous !== undefined && previous.schema !== manifest.schema) {
    refuse(
      'schema-moved',
      `"${manifest.name}" is installed owning the schema "${previous.schema}" and this version claims ` +
        `"${manifest.schema}". That is a data move, not an upgrade: uninstall it first and decide what ` +
        'happens to the old schema deliberately.',
    );
  }

  const agentsDir = agentSearchPath(env).owner.dir ?? AGENTS_DIR;
  const agents = (manifest.agents ?? []).map((suggestion) => {
    const agentDir = path.join(agentsDir, suggestion.id);
    return {
      id: suggestion.id,
      handle: suggestion.handle,
      drift: driftFor({
        agentDir,
        agentFile: path.join(agentDir, 'agent.md'),
        suggestion,
        pluginVersion: manifest.version,
      }),
    };
  });

  return {
    directory: dir,
    entry,
    manifest,
    contribution: contributionOf(manifest),
    ...(previous === undefined ? {} : { previous }),
    agents,
    recordFile: file,
  };
}

/** Write the record. The owner has already read the plan. */
export function applyInstall(
  plan: InstallPlan,
  opts: { env?: NodeJS.ProcessEnv; now?: Date } = {},
): InstalledPlugin {
  const env = opts.env ?? process.env;
  const file = pluginsFilePath({ ownerRoot: agentSearchPath(env).ownerRoot, env });
  const record: InstalledPlugin = {
    name: plan.manifest.name,
    version: plan.manifest.version,
    entry: plan.entry,
    schema: plan.manifest.schema,
    installedAt: (opts.now ?? new Date()).toISOString(),
    source: { kind: 'directory', path: plan.directory },
  };
  writePluginsFile(file, upsertInstalledPlugin(readPluginsFile(file), record));
  return record;
}

/**
 * What an upgrade says about the agents the owner accepted.
 *
 * The whole answer is "nothing was touched" — see `provenance.ts`. This is the
 * sentence that says so per agent, which is the only thing an upgrade is
 * allowed to do about them.
 */
export function renderAgentDrift(plan: InstallPlan): string[] {
  if (plan.agents.length === 0) return [];
  const lines = ['', 'AGENTS IT PROPOSES, AND YOUR COPIES'];
  for (const agent of plan.agents) {
    lines.push(`  ${agent.id} — ${agent.drift.message}`);
  }
  lines.push('  No agent file is written by installing or upgrading. Ever.');
  return lines;
}
