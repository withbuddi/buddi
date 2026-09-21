#!/usr/bin/env node
/**
 * `buddi plugins` — install, uninstall, list, info.
 *
 * The lifecycle a plugin never had. Until now "installed" meant a line in the
 * gateway's own source, so sharing a plugin meant sharing a patch; this command
 * is the whole of what makes buddi something a stranger can extend.
 *
 * Two rules shape every subcommand:
 *
 *  - **nothing is installed without the owner reading what arrives.**
 *    `install` with no `--yes` is a *summary*, not an install: what tools come,
 *    which of them run without asking, what schema it will own, what it will do
 *    on a timer, what it wants to talk to on the network, and what agents it
 *    proposes. Then the owner decides.
 *  - **uninstall keeps the data.** The record goes and the code stops loading;
 *    the plugin's Postgres schema stays exactly where it is and the command
 *    says so with the row count. `--purge` is the separate verb that destroys,
 *    and it prints what it is about to destroy first.
 *
 * Health uses the doctor's three words — ok, warn, fail — because an owner
 * reading `plugins list` after `doctor` should not have to learn a second
 * vocabulary for the same idea.
 */
import { realpathSync } from 'node:fs';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  contributionHeadline,
  contributionOf,
  createPool,
  describeSource,
  migrate,
  readPluginsFile,
  renderContribution,
  type InstalledPlugin,
  type PluginContribution,
} from '@buddi/core';
import type { Pool } from 'pg';
import { loadEnvironment } from './bootstrap.js';
import { installedManifests } from './agents/catalog.js';
import {
  isBuiltInPlugin,
  loadInstalledPlugins,
  loadManifest,
  recordFile,
  type LoadedPlugins,
} from './plugins/load.js';
import { InstallRefusal, renderAgentDrift } from './plugins/install.js';
import { applyUninstall, planUninstall, UninstallRefusal } from './plugins/uninstall.js';
import { approveStaged } from './plugins/approve.js';
import {
  listStaged,
  readStaged,
  rejectStaged,
  resolveCoreDir,
  stagePlugin,
  StageRefusal,
  TRUST_SENTENCE,
  type StagedPlan,
  type StagedPlugin,
} from './plugins/stage.js';
import { updatePlugin } from './plugins/update.js';
import { verifyInstalledHash } from './plugins/hash.js';
import { assertScaffoldName, schemaFor, writeScaffold } from './plugins/scaffold.js';
import { assertBuilt, defaultDevDeps, watchDist } from './plugins/dev.js';

export const USAGE = `buddi plugins — what this installation has installed

  buddi plugins init <name> [--dir <path>] write a new plugin: manifest, one auto tool, one gated
                                          tool, a migration, a buddi.md and a test. Refuses a
                                          directory that already exists.
  buddi plugins dev <dir>                 watch <dir>/dist and, when it changes, restart the
                                          service (or say to restart buddi): plugins load at start
  buddi plugins list                      what is installed, its version, and whether it is healthy
  buddi plugins info <name>               what it is, what it brought, and what it proposes
  buddi plugins install <spec>            STAGE it and read what it claims (imports nothing)
  buddi plugins install <spec> --yes --integrity <hash>
                                          approve it: import it, plan it, install it.
                                          The hash is the one the staged card printed; a
                                          package that came from a registry or a .tgz is
                                          never approved without it, not even with --yes.
                                          Without it the command stages, prints the card and
                                          exits 3: staged, not installed.
  buddi plugins update <name> [--version] stage the next version; --yes --integrity approves it
  buddi plugins staged                    what is staged and waiting for you
  buddi plugins approve <id> [--integrity <hash>] [--acknowledge-drift]
  buddi plugins reject <id>               delete a stage and everything it fetched
  buddi plugins uninstall <name>          what removing it would do (removes nothing)
  buddi plugins uninstall <name> --yes    remove it; its database schema is KEPT
      --detach-agents                     also take its tools out of agents that were granted them
      --purge --confirm <name>            ALSO DROP its schema and everything in it. Irreversible,
                                          and the plugin's own name has to be typed back.

A <spec> is a directory that exists, a .tgz on disk, or an npm package:
\`finance\`, \`@you/buddi-plugin-finance@1.2.3\`. Installing one runs its code inside buddi.`;

export interface ParsedPluginsArgs {
  command:
    | 'help'
    | 'list'
    | 'info'
    | 'init'
    | 'dev'
    | 'install'
    | 'update'
    | 'staged'
    | 'approve'
    | 'reject'
    | 'uninstall';
  target?: string;
  yes: boolean;
  detachAgents: boolean;
  purge: boolean;
  acknowledgeDrift: boolean;
  /** Passed back at approval. Absent means "the hash this run just showed me". */
  integrity?: string;
  /** The plugin's own name, typed back, for `--purge`. */
  confirm?: string;
  version?: string;
  registry?: string;
  /** Where `init` writes the scaffold. Default: `./<name>`. */
  dir?: string;
}

const VALUE_FLAGS = ['--integrity', '--version', '--registry', '--confirm', '--dir'] as const;
const BARE_FLAGS = ['--yes', '--detach-agents', '--purge', '--acknowledge-drift'] as const;

export function parsePluginsArgs(argv: string[]): ParsedPluginsArgs {
  const [head, ...rest] = argv;
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if ((VALUE_FLAGS as readonly string[]).includes(name)) {
      const value = inline ?? rest[++i];
      if (value === undefined) throw new Error(`buddi plugins: ${name} needs a value`);
      values.set(name, value);
      continue;
    }
    if (!(BARE_FLAGS as readonly string[]).includes(name)) {
      throw new Error(`buddi plugins: unknown option ${name}`);
    }
    flags.add(name);
  }
  const base = {
    yes: flags.has('--yes'),
    detachAgents: flags.has('--detach-agents'),
    purge: flags.has('--purge'),
    acknowledgeDrift: flags.has('--acknowledge-drift'),
    ...(values.has('--integrity') ? { integrity: values.get('--integrity') as string } : {}),
    ...(values.has('--confirm') ? { confirm: values.get('--confirm') as string } : {}),
    ...(values.has('--version') ? { version: values.get('--version') as string } : {}),
    ...(values.has('--registry') ? { registry: values.get('--registry') as string } : {}),
    ...(values.has('--dir') ? { dir: values.get('--dir') as string } : {}),
  };
  if (head === undefined || head === 'help' || head === '--help') return { command: 'help', ...base };
  if (head === 'list') return { command: 'list', ...base };
  if (head === 'staged') return { command: 'staged', ...base };
  if (['info', 'init', 'dev', 'install', 'update', 'approve', 'reject', 'uninstall'].includes(head)) {
    const target = positional[0];
    if (target === undefined) {
      const what =
        head === 'install' ? 'plugin to install (a directory, a .tgz, or an npm package)'
        : head === 'approve' || head === 'reject' ? 'staging id'
        : head === 'init' ? 'name for the new plugin'
        : head === 'dev' ? "plugin directory to watch (the one whose dist/ you are building)"
        : 'plugin name';
      throw new Error(`buddi plugins ${head} needs a ${what}`);
    }
    return { command: head as ParsedPluginsArgs['command'], target, ...base };
  }
  throw new Error(`buddi plugins: unknown command "${head}"`);
}

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

export type Health = 'ok' | 'warn' | 'fail';

export interface PluginRow {
  name: string;
  version: string;
  origin: 'built-in' | 'installed';
  health: Health;
  detail: string;
}

/** Migration files a manifest ships that the ledger has not recorded. */
async function unappliedMigrations(pool: Pool, schema: string, dir: string): Promise<string[]> {
  if (dir.trim() === '' || !existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  const { rows } = await pool.query('select filename from core.migrations where schema = $1', [schema]);
  const applied = new Set((rows as Array<{ filename: string }>).map((r) => r.filename));
  return files.filter((f) => !applied.has(f));
}

async function healthOf(
  plugin: { record: InstalledPlugin; manifestSchema: string; migrationsDir: string },
  pool: Pool | undefined,
): Promise<{ health: Health; detail: string }> {
  if (!pool) return { health: 'warn', detail: 'loads; the database was not reachable, so its schema was not checked' };
  try {
    const { rows } = await pool.query(
      'select 1 from information_schema.schemata where schema_name = $1',
      [plugin.manifestSchema],
    );
    if (rows.length === 0) {
      return {
        health: 'fail',
        detail: `its schema "${plugin.manifestSchema}" does not exist — run \`buddi migrate\``,
      };
    }
    const pending = await unappliedMigrations(pool, plugin.manifestSchema, plugin.migrationsDir);
    if (pending.length > 0) {
      return {
        health: 'fail',
        detail: `${pending.length} migration${pending.length === 1 ? '' : 's'} not applied (${pending.join(', ')}) — run \`buddi migrate\``,
      };
    }
    return { health: 'ok', detail: `schema "${plugin.manifestSchema}" present and migrated` };
  } catch (err) {
    return { health: 'warn', detail: `loads; its schema could not be checked: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** The table `plugins list` prints. Pure over what it is handed. */
export function renderRows(rows: readonly PluginRow[]): string {
  const width = Math.max(...rows.map((r) => r.name.length), 6);
  return rows
    .map(
      (r) =>
        `  ${r.health.padEnd(4)} ${r.name.padEnd(width)}  ${r.version.padEnd(8)} ${r.origin.padEnd(9)} ${r.detail}`,
    )
    .join('\n');
}

async function commandList(pool: Pool | undefined, env: NodeJS.ProcessEnv): Promise<number> {
  const file = recordFile(env);
  const plugins = await loadInstalledPlugins(env);
  const rows: PluginRow[] = [];
  for (const manifest of installedManifests(env)) {
    if (!isBuiltInPlugin(manifest.name, env)) continue;
    const health = await healthOf(
      {
        record: {} as InstalledPlugin,
        manifestSchema: manifest.schema,
        migrationsDir: manifest.migrationsDir,
      },
      pool,
    );
    rows.push({
      name: manifest.name,
      version: manifest.version,
      origin: 'built-in',
      health: health.health,
      detail: `${contributionHeadline(contributionOf(manifest))} — ${health.detail}`,
    });
  }
  for (const loaded of plugins.loaded) {
    const health = await healthOf(
      {
        record: loaded.record,
        manifestSchema: loaded.manifest.schema,
        migrationsDir: loaded.manifest.migrationsDir,
      },
      pool,
    );
    // What is on disk against what was approved. A plugin runs with everything
    // buddi can do, so "it changed since you said yes" outranks a schema note.
    const hash = verifyInstalledHash(loaded.record, { env });
    rows.push({
      name: loaded.record.name,
      version: loaded.manifest.version,
      origin: 'installed',
      health: hash.matches ? health.health : 'warn',
      detail: hash.matches
        ? `${contributionHeadline(loaded.contribution)} — ${health.detail}`
        : hash.message,
    });
  }
  for (const problem of plugins.problems) {
    rows.push({
      name: problem.name,
      version: '?',
      origin: 'installed',
      health: 'fail',
      detail: `installed but did not load: ${problem.message}`,
    });
  }
  console.log(`buddi plugins — record: ${file}\n`);
  console.log(renderRows(rows));
  console.log(
    `\n${plugins.loaded.length} installed, ${rows.length - plugins.loaded.length - plugins.problems.length} built in` +
      `${plugins.problems.length > 0 ? `, ${plugins.problems.length} broken` : ''}.`,
  );
  if (plugins.loaded.length === 0 && plugins.problems.length === 0) {
    console.log('Nothing is installed beyond what this build ships. `buddi plugins install <directory>`.');
  }
  return plugins.problems.length > 0 ? 1 : 0;
}

async function commandInfo(name: string, pool: Pool | undefined, env: NodeJS.ProcessEnv): Promise<number> {
  const builtIn = installedManifests(env).find((m) => m.name === name && isBuiltInPlugin(m.name, env));
  const plugins: LoadedPlugins = await loadInstalledPlugins(env);
  const loaded = plugins.loaded.find((p) => p.record.name === name);
  const manifest = loaded?.manifest ?? builtIn;
  if (!manifest) {
    const problem = plugins.problems.find((p) => p.name === name);
    if (problem) {
      console.error(`${name} is installed but did not load: ${problem.message}`);
      console.error(`  entry: ${problem.entry}`);
      return 1;
    }
    console.error(`no plugin called "${name}" here (buddi plugins list)`);
    return 1;
  }
  console.log(renderContribution(contributionOf(manifest)).join('\n'));
  if (loaded) {
    console.log('');
    console.log('INSTALLED');
    console.log(`  from ${describeSource(loaded.record.source)}`);
    console.log(`  entry ${loaded.record.entry}`);
    console.log(`  recorded ${loaded.record.version} at ${loaded.record.installedAt}`);
    const provenance = loaded.record.provenance;
    if (provenance !== undefined) {
      if (provenance.publisher !== undefined) console.log(`  published by ${provenance.publisher}`);
      if (provenance.integrity !== undefined) console.log(`  integrity ${provenance.integrity}`);
      if (provenance.approvedAt !== undefined) console.log(`  approved ${provenance.approvedAt}`);
      const hash = verifyInstalledHash(loaded.record, { env });
      console.log(hash.matches ? '  its files still hash to what you approved' : `  ${hash.message}`);
    }
  } else {
    console.log('');
    console.log('INSTALLED');
    console.log('  compiled into this build. It cannot be uninstalled; it is part of buddi.');
  }
  if (pool) {
    try {
      const { rows } = await pool.query(
        `select table_name, (xpath('/row/c/text()',
           query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text::int as n
           from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by table_name`,
        [manifest.schema],
      );
      if (rows.length > 0) {
        console.log('');
        console.log(`WHAT IT HAS STORED (schema "${manifest.schema}")`);
        for (const row of rows as Array<{ table_name: string; n: number }>) {
          console.log(`  ${row.table_name}: ${row.n} rows`);
        }
      }
    } catch {
      // A schema that is not there yet is not an error worth a stack trace.
    }
  }
  return 0;
}

/* ------------------------------------------------------------------ *
 * Staging and the two approvals
 * ------------------------------------------------------------------ */

/** Everything the owner reads before the plugin has ever been imported. */
function renderStaged(staged: StagedPlugin): string[] {
  const lines: string[] = [];
  lines.push('');
  lines.push(`${staged.name} ${staged.version}`);
  lines.push(`  from      ${describeSource(staged.source)}`);
  lines.push(`  published by ${staged.publisher ?? '(nobody: nothing was fetched from a registry)'}`);
  lines.push(`  integrity ${staged.integrity === '' ? '(none: a directory on this disk)' : staged.integrity}`);
  if (staged.stagedHash !== undefined && staged.stagedHash !== '') {
    // The tarball's hash says what was fetched; this one says what is unpacked
    // on disk, dependencies included, and it is what approving re-checks.
    lines.push(`  files     ${staged.stagedHash}`);
  }
  lines.push(
    `  depends on ${staged.dependencies.count} package${staged.dependencies.count === 1 ? '' : 's'}` +
      `${staged.dependencies.withScripts.length === 0 ? ', none of which declares an install script' : ':'}`,
  );
  for (const dependency of staged.dependencies.withScripts) {
    lines.push(`    ${dependency} — WANTS TO RUN CODE AT INSTALL. It was installed with --ignore-scripts,`);
    lines.push('      so it has not run; approving this plugin does not run it either.');
  }
  if (staged.scripts.length > 0) {
    lines.push(`  it declares the lifecycle script${staged.scripts.length === 1 ? '' : 's'} ${staged.scripts.join(', ')}; none was run`);
  }
  lines.push('');
  lines.push('WHAT IT SAYS ABOUT ITSELF (its buddi.md — its claim, not a fact)');
  if (staged.claims.missing) {
    lines.push('  It ships no buddi.md. It stated nothing in advance about what it does.');
  } else {
    for (const line of staged.claims.text.split('\n')) lines.push(`  ${line}`);
  }
  lines.push('');
  lines.push(...wrap(TRUST_SENTENCE, 86).map((line) => `  ${line}`));
  return lines;
}

/** Hard-wrap a sentence so the terminal never decides where it breaks. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(' ')) {
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

/** What approval 1 found, and what approval 2 would be agreeing to. */
function renderDrift(plan: StagedPlan): string[] {
  const lines = ['', 'ITS PROSE AND ITS CODE DO NOT AGREE'];
  for (const difference of plan.drift) lines.push(`  ${difference}`);
  lines.push('');
  lines.push('That is not proof of anything. It is the moment to look: the package described itself');
  lines.push('one way and its manifest is another. Nothing has been installed, no schema touched.');
  return lines;
}

async function approveAndReport(
  staged: StagedPlugin,
  args: ParsedPluginsArgs,
  pool: Pool | undefined,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const outcome = await approveStaged(staged.id, {
    integrity: args.integrity ?? staged.integrity,
    acknowledgeDrift: args.acknowledgeDrift,
    env,
    ...(pool ? { pool } : {}),
  });
  if (outcome.kind === 'drift') {
    console.log(renderContribution(outcome.plan.contribution as PluginContribution).join('\n'));
    console.log(renderDrift(outcome.plan).join('\n'));
    console.log('');
    console.log(`  buddi plugins approve ${staged.id} --acknowledge-drift`);
    return 1;
  }
  console.log(renderContribution(outcome.plan.contribution).join('\n'));
  console.log(renderAgentDrift(outcome.plan).join('\n'));
  console.log('');
  console.log(`installed ${outcome.record.name} ${outcome.record.version} → ${outcome.plan.recordFile}`);
  console.log(`  files    ${path.dirname(outcome.record.entry)}`);
  if (outcome.record.provenance?.installedHash !== undefined) {
    console.log(`  approved ${outcome.record.provenance.installedHash}`);
    console.log('  buddi doctor says so if those files ever stop hashing to that.');
  }
  for (const filename of outcome.migrations) console.log(`applied ${outcome.record.schema}/${filename}`);
  if (outcome.migrations.length === 0 && outcome.migrationProblem === undefined) {
    console.log(`migrations: ${outcome.record.schema} already up to date`);
  }
  if (outcome.migrationProblem !== undefined) console.log(outcome.migrationProblem);
  console.log('');
  console.log('Its tools are registered the next time a buddi process starts. If `buddi serve` is');
  console.log('running, restart it: `buddi service restart`.');
  if (outcome.plan.contribution.agents.length > 0) {
    console.log('');
    console.log('It proposes agents. Nothing was created — ask your agent for one by name, for example:');
    for (const agent of outcome.plan.contribution.agents) {
      console.log(`  "accept the ${agent.id} agent from the ${outcome.record.name} plugin"`);
    }
    console.log('You will be shown the whole tool grant and asked to approve it.');
  }
  if (outcome.plan.contribution.missions.length > 0) {
    console.log('');
    console.log('It suggests missions. `buddi missions add-defaults` registers the ones it can place.');
  }
  return 0;
}

/**
 * `--yes` is not the second approval for a package that came from elsewhere.
 *
 * Approval 1 is the owner saying yes to *a specific hash*, and a `--yes` typed
 * before the fetch happened cannot be that: at the moment it was typed there
 * was no hash to agree to, and whatever npm answers with afterwards would be
 * approved sight unseen. So for a registry or a tarball source `--yes` alone
 * prints the card and the command that approves it, and exits having installed
 * nothing. A directory source is exempt: the owner typed a path to their own
 * build and there is no hash and no publisher in the first place.
 */
export function needsIntegrityFirst(staged: StagedPlugin, args: ParsedPluginsArgs): boolean {
  return args.yes && staged.source.kind !== 'directory' && args.integrity === undefined;
}

/**
 * The exit code for "staged, not installed".
 *
 * A refusal to act that exits 0 reads as success: a `set -e` install step in
 * somebody's setup notes would report the plugin installed and leave it
 * waiting for an approval nobody typed. 3 is distinct from 1 (something went
 * wrong) so a script can tell the two apart and go on to `plugins approve`.
 */
export const STAGED_NOT_INSTALLED = 3;

/** What to print when `--yes` arrived without the hash it has to carry. */
function askForIntegrity(staged: StagedPlugin): number {
  console.log('');
  console.log('NOTHING OF THIS PLUGIN HAS RUN, and --yes did not install it. Approving is agreeing to a');
  console.log('specific package: the hash above is what was fetched, and it is passed back so that the');
  console.log('yes cannot land on something else. Read the card, then:');
  console.log('');
  console.log(`  buddi plugins approve ${staged.id} --integrity ${staged.integrity}`);
  console.log(`  buddi plugins reject ${staged.id}      (and it is deleted, with everything it fetched)`);
  return STAGED_NOT_INSTALLED;
}

async function commandInstall(
  spec: string,
  args: ParsedPluginsArgs,
  pool: Pool | undefined,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const staged = await stagePlugin(spec, {
    env,
    ...(args.registry === undefined ? {} : { registry: args.registry }),
    onPhase: (phase) => {
      if (phase === 'fetching') console.log('fetching…');
      if (phase === 'installing-dependencies') console.log('installing its dependencies (--ignore-scripts)…');
    },
  });
  console.log(renderStaged(staged).join('\n'));
  if (!args.yes) {
    console.log('');
    console.log('NOTHING OF THIS PLUGIN HAS RUN. It was fetched, unpacked and read; its entry point has');
    console.log('not been imported, no tool is registered, no schema exists and no agent was created.');
    console.log('Approving is what imports it for the first time.');
    console.log('');
    console.log(
      staged.source.kind === 'directory'
        ? `  buddi plugins approve ${staged.id}`
        : `  buddi plugins approve ${staged.id} --integrity ${staged.integrity}`,
    );
    return 0;
  }
  if (needsIntegrityFirst(staged, args)) return askForIntegrity(staged);
  return approveAndReport(staged, args, pool, env);
}

async function commandUpdate(
  name: string,
  args: ParsedPluginsArgs,
  pool: Pool | undefined,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const staged = await updatePlugin(name, {
    env,
    ...(args.version === undefined ? {} : { version: args.version }),
    ...(args.registry === undefined ? {} : { registry: args.registry }),
  });
  console.log(renderStaged(staged).join('\n'));
  console.log('');
  console.log(
    `This REPLACES ${staged.previous?.name ?? name} ${staged.previous?.version ?? '?'}. Its migrations run forward only.`,
  );
  if (!args.yes) {
    console.log('');
    console.log('Nothing has been imported. A new version is somebody else\'s code exactly as the first');
    console.log('one was, so it is approved the same way.');
    console.log('');
    console.log(
      staged.source.kind === 'directory'
        ? `  buddi plugins approve ${staged.id}`
        : `  buddi plugins approve ${staged.id} --integrity ${staged.integrity}`,
    );
    return 0;
  }
  if (needsIntegrityFirst(staged, args)) return askForIntegrity(staged);
  return approveAndReport(staged, args, pool, env);
}

function commandStaged(env: NodeJS.ProcessEnv): number {
  const staged = listStaged(env);
  if (staged.length === 0) {
    console.log('Nothing is staged. `buddi plugins install <spec>` stages one.');
    return 0;
  }
  for (const entry of staged) {
    console.log(`  ${entry.id}  ${entry.name} ${entry.version}  ${entry.state}  staged ${entry.createdAt}`);
    console.log(`      ${describeSource(entry.source)}`);
  }
  console.log('');
  console.log('A stage nobody decides on is deleted after a day.');
  return 0;
}

async function commandApprove(
  id: string,
  args: ParsedPluginsArgs,
  pool: Pool | undefined,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const staged = readStaged(id, env);
  console.log(renderStaged(staged).join('\n'));
  return approveAndReport(staged, args, pool, env);
}

function commandReject(id: string, env: NodeJS.ProcessEnv): number {
  const removed = rejectStaged(id, env);
  console.log(removed ? `${id} rejected: everything it fetched was deleted` : `there is no stage "${id}"`);
  return 0;
}

async function commandUninstall(
  name: string,
  args: ParsedPluginsArgs,
  pool: Pool | undefined,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const plan = await planUninstall(name, { ...(pool ? { pool } : {}), env });
  console.log(
    `Removing ${plan.record.name} ${plan.record.version} (installed from ${describeSource(plan.record.source)})`,
  );
  console.log('');
  console.log(`  ${plan.toolNames.length} tools stop being registered${plan.toolNames.length === 0 ? '' : `: ${plan.toolNames.join(', ')}`}`);
  if (plan.manifest === undefined) {
    console.log('  its entry point no longer loads, so what it contributed had to be read from the record');
  }
  if (plan.agents.length === 0) {
    console.log('  no agent names it in a tool grant');
  } else {
    for (const agent of plan.agents) {
      console.log(
        `  ${agent.agentId} names it (${agent.removed.join(', ')}) — ${
          args.detachAgents ? 'those entries will be removed from its grant' : 'REFUSED unless you pass --detach-agents'
        }`,
      );
    }
  }
  for (const mission of plan.missions) console.log(`  mission ${mission.id} will be disabled (not deleted)`);
  for (const job of plan.jobs) console.log(`  queued job ${job.id} (${job.kind}) will be cancelled`);
  for (const approval of plan.approvals) {
    console.log(`  pending approval for ${approval.tool} will be rejected — it could never execute`);
  }
  console.log('');
  if (plan.data) {
    console.log(`  DATA: schema "${plan.data.schema}" — ${plan.data.tables.length} tables, ${plan.data.totalRows} rows`);
    for (const table of plan.data.tables) console.log(`    ${table.table}: ${table.rows} rows`);
    console.log(
      args.purge
        ? '    --purge: ALL OF IT IS DROPPED. There is no undo except a backup.'
        : '    kept exactly as it is. Reinstalling the plugin finds it again.',
    );
  } else if (plan.dataProblem) {
    console.log(`  DATA: could not be counted (${plan.dataProblem})`);
  }
  if (!args.yes) {
    console.log('');
    console.log(`Nothing has been removed. Re-run with --yes${args.purge ? ' (and --purge, which destroys the data)' : ''}.`);
    return 0;
  }
  if (args.purge && args.confirm !== plan.record.name) {
    // The same rule the engine and the dashboard enforce, in the place the
    // owner is typing: a flag is easy to repeat from a shell history, and the
    // name is what says this one was meant.
    console.error('');
    console.error(
      `--purge drops the schema "${plan.record.schema}" and everything in it. Type the plugin's name ` +
        `back to confirm it: buddi plugins uninstall ${plan.record.name} --yes --purge --confirm ${plan.record.name}`,
    );
    return 1;
  }
  const outcome = await applyUninstall(plan, {
    env,
    ...(pool ? { pool } : {}),
    detachAgents: args.detachAgents,
    purge: args.purge,
  });
  console.log('');
  for (const note of outcome.notes) console.log(`  ${note}`);
  console.log('');
  console.log('Restart any running buddi process so it stops registering the tools: `buddi service restart`.');
  return 0;
}

/* ------------------------------------------------------------------ *
 * Starting one, and working on one
 * ------------------------------------------------------------------ */

/** The version of `@buddi/core` this process is running, for the peer range. */
export function runningCoreVersion(): string {
  const dir = resolveCoreDir();
  if (dir !== undefined) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
        version?: string;
      };
      if (typeof pkg.version === 'string' && pkg.version.trim() !== '') return pkg.version;
    } catch {
      // Fall through: a core whose package.json cannot be read is a bundle,
      // and the published range below is the honest answer for one.
    }
  }
  return '0.1.0';
}

/**
 * `init` — the first ten minutes.
 *
 * It writes and nothing else: no database, no record, no import. The scaffold
 * is already installable, so the sentence at the end is the whole rest of the
 * path and the owner can paste it.
 */
function commandInit(name: string, args: ParsedPluginsArgs, env: NodeJS.ProcessEnv): number {
  const checked = assertScaffoldName(name);
  if (isBuiltInPlugin(checked, env)) {
    console.error(
      `"${checked}" is the name of a plugin this build already ships, so an install would refuse ` +
        'it: every one of its tool names would collide. Pick another name.',
    );
    return 1;
  }
  const dir = path.resolve(process.cwd(), args.dir ?? checked);
  const coreDir = resolveCoreDir();
  const written = writeScaffold(dir, {
    name: checked,
    coreVersion: runningCoreVersion(),
    ...(coreDir === undefined ? {} : { coreDir }),
  });
  console.log(`${checked} — a new plugin in ${dir}\n`);
  for (const file of written) console.log(`  ${file}`);
  console.log('');
  console.log(`It owns the Postgres schema "${schemaFor(checked)}" and contributes two tools:`);
  console.log(`  ${checked}.list_notes    tier auto    a read of its own schema, runs when asked`);
  console.log(`  ${checked}.forget_note   tier gated   describes the effect; the owner approves it`);
  console.log('');
  console.log('Next:');
  console.log(`  cd ${path.relative(process.cwd(), dir) || '.'}`);
  console.log('  pnpm install && pnpm build && pnpm test');
  console.log(`  buddi plugins install . --yes`);
  console.log('  buddi service restart      # plugins are registered at start');
  console.log('');
  console.log('The guide is docs/plugins.md in the buddi repository — start at "Start here".');
  return 0;
}

/**
 * `dev` — watch the build and say what has to happen for it to take effect.
 *
 * It does not reload anything, and `plugins/dev.ts` says at length why it
 * cannot: the registry is built once at start and held by reference everywhere,
 * and Node's module cache would hand back the plugin that is already loaded.
 * So this is a watcher over `dist` that restarts a supervised installation and
 * otherwise prints the one line a developer in a checkout needs.
 */
async function commandDev(dir: string): Promise<number> {
  const resolved = path.resolve(process.cwd(), dir);
  const dist = assertBuilt(resolved);
  const name = path.basename(resolved);
  console.log(`watching ${dist}`);
  console.log(
    'Plugins are loaded once, at start. A rebuild is not picked up until buddi restarts; this ' +
      'watcher does the restart when there is a service to restart, and tells you when there is not.',
  );
  console.log('Ctrl-C to stop.');
  const watcher = watchDist(resolved, defaultDevDeps(), name);
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      watcher.close();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  return 0;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let args: ParsedPluginsArgs;
  try {
    args = parsePluginsArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(`\n${USAGE}`);
    return 1;
  }
  if (args.command === 'help') {
    console.log(USAGE);
    return 0;
  }
  await loadEnvironment();
  // Writing a scaffold and watching a build touch nothing an installation owns:
  // no record, no schema, no import. They are dispatched before the pool so
  // they work on a machine whose database was never started — which is exactly
  // the machine somebody writes their first plugin on.
  try {
    if (args.command === 'init') return commandInit(args.target as string, args, process.env);
    if (args.command === 'dev') return await commandDev(args.target as string);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  // Every subcommand works with the database down; it just says less. That is
  // deliberate — "what is installed here" is exactly the question an owner asks
  // when something is broken.
  let pool: Pool | undefined;
  if (process.env.DATABASE_URL) {
    try {
      pool = createPool(process.env.DATABASE_URL);
      await pool.query('select 1');
    } catch {
      await pool?.end().catch(() => {});
      pool = undefined;
    }
  }
  try {
    if (args.command === 'list') return await commandList(pool, process.env);
    if (args.command === 'staged') return commandStaged(process.env);
    if (args.command === 'info') return await commandInfo(args.target as string, pool, process.env);
    if (args.command === 'install') {
      return await commandInstall(args.target as string, args, pool, process.env);
    }
    if (args.command === 'update') return await commandUpdate(args.target as string, args, pool, process.env);
    if (args.command === 'approve') return await commandApprove(args.target as string, args, pool, process.env);
    if (args.command === 'reject') return commandReject(args.target as string, process.env);
    return await commandUninstall(args.target as string, args, pool, process.env);
  } catch (err) {
    if (err instanceof InstallRefusal || err instanceof UninstallRefusal || err instanceof StageRefusal) {
      console.error(err.message);
      return 1;
    }
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    await pool?.end().catch(() => {});
  }
}

export async function runPluginsCli(argv: string[]): Promise<number> {
  return main(argv);
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then((code) => {
    process.exitCode = code;
  });
}
