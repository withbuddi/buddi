/**
 * What this installation is, in the shape the engine takes.
 *
 * The engine (`@buddi/core/backup`) reads no environment and looks for no
 * repository: it is told where everything is. This is the one place that
 * answers those questions for the checkout CLI — the data directory, the
 * private agent and skill directories, `.env`, the vault, and the migrations
 * each installed plugin ships so a restore can rebuild its schema.
 */
import {
  CORE_MIGRATIONS_DIR,
  CORE_SCHEMA,
  createVault,
  describeSource,
  pluginsFilePath,
  readPluginsFile,
  timezoneFromEnv,
  type CreateOptions,
  type MigrationDir,
  type MigrationSource,
  type PluginRecord,
} from '@buddi/core';
import { agentSearchPath, installedManifests } from '@buddi/gateway';
import { BACKUP_DIR, DATA_DIR, ENV_FILE } from '../paths.js';

/** Core's migrations, then every installed plugin's. */
export function migrationDirs(env: NodeJS.ProcessEnv): MigrationDir[] {
  const dirs: MigrationDir[] = [{ schema: CORE_SCHEMA, dir: CORE_MIGRATIONS_DIR }];
  for (const manifest of installedManifests(env)) {
    if ((manifest.migrationsDir ?? '').trim() === '') continue;
    dirs.push({ schema: manifest.schema, dir: manifest.migrationsDir });
  }
  return dirs;
}

/** The same list, as a restore reads it: schema, directory, plugin name. */
export function pluginMigrations(env: NodeJS.ProcessEnv): MigrationSource[] {
  return installedManifests(env)
    .filter((m) => (m.migrationsDir ?? '').trim() !== '')
    .map((m) => ({ schema: m.schema, dir: m.migrationsDir, plugin: m.name }));
}

/** What the manifest records about the plugins installed here. */
export function pluginRecords(env: NodeJS.ProcessEnv): PluginRecord[] {
  const search = agentSearchPath(env);
  try {
    const file = readPluginsFile(pluginsFilePath({ ownerRoot: search.ownerRoot, env }));
    return file.plugins.map((p) => ({
      name: p.name,
      version: p.version,
      schema: p.schema,
      source: describeSource(p.source),
    }));
  } catch {
    // An unreadable record is `buddi plugins`' problem to report, not a reason
    // to refuse a backup of everything else.
    return [];
  }
}

/** Everything the engine needs about this installation. */
export function installationOptions(env: NodeJS.ProcessEnv): CreateOptions {
  const search = agentSearchPath(env);
  return {
    databaseUrl: env.DATABASE_URL,
    backupsDir: BACKUP_DIR,
    dataDir: env.BUDDI_DATA_DIR ? env.BUDDI_DATA_DIR : DATA_DIR,
    agentsDir: search.owner.dir,
    skillsDir: search.owner.skillsDir,
    pluginsFile: pluginsFilePath({ ownerRoot: search.ownerRoot, env }),
    envFile: ENV_FILE,
    timezone: timezoneFromEnv(env),
    migrationDirs: migrationDirs(env),
    plugins: pluginRecords(env),
    vault: createVault({ env }),
  };
}
