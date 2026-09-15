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
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  contributionHeadline,
  contributionOf,
  createPool,
  migrate,
  readPluginsFile,
  renderContribution,
  type InstalledPlugin,
} from '@buddi/core';
import type { Pool } from 'pg';
import { loadEnvironment } from './bootstrap.js';
import { installedManifests } from './agents/catalog.js';
import {
  BUILT_IN_PLUGINS,
  loadInstalledPlugins,
  loadManifest,
  recordFile,
  type LoadedPlugins,
} from './plugins/load.js';
import { applyInstall, InstallRefusal, planInstall, renderAgentDrift } from './plugins/install.js';
import { applyUninstall, planUninstall, UninstallRefusal } from './plugins/uninstall.js';

export const USAGE = `buddi plugins — what this installation has installed

  buddi plugins list                      what is installed, its version, and whether it is healthy
  buddi plugins info <name>               what it is, what it brought, and what it proposes
  buddi plugins install <directory>       READ what a plugin contributes (installs nothing)
  buddi plugins install <directory> --yes install it
  buddi plugins uninstall <name>          what removing it would do (removes nothing)
  buddi plugins uninstall <name> --yes    remove it; its database schema is KEPT
      --detach-agents                     also take its tools out of agents that were granted them
      --purge                             ALSO DROP its schema and everything in it. Irreversible.

A plugin is a built package directory: package.json, the dist/ it points at, and
migrations/ if it owns tables. Installing one runs its code inside buddi.`;

export interface ParsedPluginsArgs {
  command: 'help' | 'list' | 'info' | 'install' | 'uninstall';
  target?: string;
  yes: boolean;
  detachAgents: boolean;
  purge: boolean;
}

export function parsePluginsArgs(argv: string[]): ParsedPluginsArgs {
  const [head, ...rest] = argv;
  const flags = rest.filter((a) => a.startsWith('--'));
  const positional = rest.filter((a) => !a.startsWith('--'));
  for (const flag of flags) {
    if (!['--yes', '--detach-agents', '--purge'].includes(flag)) {
      throw new Error(`buddi plugins: unknown option ${flag}`);
    }
  }
  const base = {
    yes: flags.includes('--yes'),
    detachAgents: flags.includes('--detach-agents'),
    purge: flags.includes('--purge'),
  };
  if (head === undefined || head === 'help' || head === '--help') return { command: 'help', ...base };
  if (head === 'list') return { command: 'list', ...base };
  if (head === 'info' || head === 'install' || head === 'uninstall') {
    const target = positional[0];
    if (target === undefined) throw new Error(`buddi plugins ${head} needs a ${head === 'install' ? 'directory' : 'plugin name'}`);
    return { command: head, target, ...base };
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
    if (!BUILT_IN_PLUGINS.includes(manifest.name)) continue;
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
    rows.push({
      name: loaded.record.name,
      version: loaded.manifest.version,
      origin: 'installed',
      health: health.health,
      detail: `${contributionHeadline(loaded.contribution)} — ${health.detail}`,
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
  const builtIn = installedManifests(env).find((m) => m.name === name && BUILT_IN_PLUGINS.includes(m.name));
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
    console.log(`  from ${loaded.record.source.path}`);
    console.log(`  entry ${loaded.record.entry}`);
    console.log(`  recorded ${loaded.record.version} at ${loaded.record.installedAt}`);
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

async function commandInstall(
  directory: string,
  args: ParsedPluginsArgs,
  pool: Pool | undefined,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const plan = await planInstall(directory, env);
  console.log(renderContribution(plan.contribution).join('\n'));
  console.log(renderAgentDrift(plan).join('\n'));
  console.log('');
  console.log(`From: ${plan.directory}`);
  console.log(`Entry: ${plan.entry}`);
  if (plan.previous) {
    console.log(
      `This REPLACES the installed ${plan.previous.name} ${plan.previous.version} (installed ${plan.previous.installedAt}).`,
    );
  }
  if (!args.yes) {
    console.log('');
    console.log('Nothing has been installed. Reading this summary imported the plugin\'s entry point —');
    console.log('there is no way to describe a module without loading it — but no tool is registered, no');
    console.log('schema is created, nothing is scheduled and no agent exists until you say so.');
    console.log(`\n  buddi plugins install ${directory} --yes`);
    return 0;
  }
  const record = applyInstall(plan, { env });
  console.log('');
  console.log(`installed ${record.name} ${record.version} → ${plan.recordFile}`);
  if (pool && plan.manifest.migrationsDir.trim() !== '') {
    const applied = await migrate(pool, { schema: plan.manifest.schema, dir: plan.manifest.migrationsDir });
    if (applied.length === 0) console.log(`migrations: ${plan.manifest.schema} already up to date`);
    for (const m of applied) console.log(`applied ${m.schema}/${m.filename}`);
  } else if (plan.manifest.migrationsDir.trim() !== '') {
    console.log('the database was not reachable: run `buddi migrate` before using it');
  }
  console.log('');
  console.log('Its tools are registered the next time a buddi process starts. If `buddi serve` is');
  console.log('running, restart it: `buddi service restart`.');
  if (plan.contribution.agents.length > 0) {
    console.log('');
    console.log('It proposes agents. Nothing was created — ask your agent for one by name, for example:');
    for (const agent of plan.contribution.agents) {
      console.log(`  "accept the ${agent.id} agent from the ${record.name} plugin"`);
    }
    console.log('You will be shown the whole tool grant and asked to approve it.');
  }
  if (plan.contribution.missions.length > 0) {
    console.log('');
    console.log('It suggests missions. `buddi missions add-defaults` registers the ones it can place.');
  }
  return 0;
}

async function commandUninstall(
  name: string,
  args: ParsedPluginsArgs,
  pool: Pool | undefined,
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const plan = await planUninstall(name, { ...(pool ? { pool } : {}), env });
  console.log(`Removing ${plan.record.name} ${plan.record.version} (installed from ${plan.record.source.path})`);
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
    if (args.command === 'info') return await commandInfo(args.target as string, pool, process.env);
    if (args.command === 'install') {
      return await commandInstall(args.target as string, args, pool, process.env);
    }
    return await commandUninstall(args.target as string, args, pool, process.env);
  } catch (err) {
    if (err instanceof InstallRefusal || err instanceof UninstallRefusal) {
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
