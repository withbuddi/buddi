/**
 * Disabling and enabling a plugin in the running gateway, with no restart.
 *
 * Everything a plugin contributes is read off the live registry: the tools an
 * agent is granted (the catalog is rebuilt on `onChange`), the pages the rail
 * and Settings list (`GET /api/pages`), views, Home blocks and glances, and the
 * sources and sentinels the loops run (each tick reads `manifests()`). So
 * taking the plugin out of the registry stops all of it at once, and putting
 * it back is what boot does for one plugin: import it, migrate its schema,
 * register it, adopt its proposed rules.
 *
 * The adopted load (`adoptedPlugins`) is kept in step, because the Plugins
 * page and `installedManifests` read it: a disabled plugin must not show as
 * loaded, nor an enabled one as waiting for a restart.
 */
import { contributionOf, runMigrations, ownerTimezone, type InstalledPlugin, type PluginManifest } from '@buddi/core';
import type { Pool } from 'pg';
import { adoptPluginPolicies } from '../agents/learning.js';
import { adoptedPlugins, adoptPlugins, loadManifest, staticNeeds, type PluginNeed } from './load.js';

/** What of the registry this needs: the gateway's own `ToolRegistry`. */
export interface LiveRegistry {
  register(manifest: PluginManifest): void;
  unregister(plugin: string): boolean;
  manifests(): PluginManifest[];
}

export interface LiveDeps {
  registry: LiveRegistry;
  env: NodeJS.ProcessEnv;
  pool?: Pool | undefined;
  log?: (line: string) => void;
}

export interface LiveResult {
  /** Done in this process. */
  applied: boolean;
  /** Why it did not load now, when it will not load at a restart either. */
  problem?: string;
  /** What only a restart can finish, when something could not be done live. */
  restartFor?: string;
  /** Loaded, but held back by these requirements (docs/plugins.md §2.10). */
  waiting?: PluginNeed[];
}

/** Keep the adopted load in step with the registry. */
export function adoptChange(
  env: NodeJS.ProcessEnv,
  record: InstalledPlugin,
  manifest: PluginManifest | undefined,
  needs?: PluginNeed[],
): void {
  const plugins = adoptedPlugins(env);
  if (plugins === undefined) return;
  const loaded = plugins.loaded.filter((p) => p.record.name !== record.name);
  const disabled = (plugins.disabled ?? []).filter((r) => r.name !== record.name);
  const problems = plugins.problems.filter((p) => p.name !== record.name);
  const waiting = (plugins.waiting ?? []).filter((w) => w.record.name !== record.name);
  if (manifest === undefined) disabled.push({ ...record, enabled: false });
  else {
    const { enabled: _was, ...enabled } = record;
    if (needs !== undefined && needs.length > 0) waiting.push({ record: enabled, manifest, needs });
    else loaded.push({ record: enabled, manifest, contribution: contributionOf(manifest) });
  }
  adoptPlugins(env, {
    file: plugins.file,
    loaded,
    problems,
    ...(disabled.length === 0 ? {} : { disabled }),
    ...(waiting.length === 0 ? {} : { waiting }),
  });
}

/** Take the plugin out of the running gateway. Its data and record entry stay. */
export function unloadPluginLive(record: InstalledPlugin, deps: LiveDeps): LiveResult {
  deps.registry.unregister(record.name);
  adoptChange(deps.env, record, undefined);
  return { applied: true };
}

/** Load the plugin into the running gateway the way boot does. */
export async function loadPluginLive(record: InstalledPlugin, deps: LiveDeps, opts: { ignoreNeeds?: boolean } = {}): Promise<LiveResult> {
  const { registry, env } = deps;
  const log = deps.log ?? ((line: string) => console.error(line));
  if (registry.manifests().some((m) => m.name === record.name)) return { applied: true };
  const loaded = await loadManifest(record.entry, { name: record.name }, env);
  if (!loaded.ok) return { applied: false, problem: loaded.message };
  const manifest = loaded.manifest;
  const holder = registry.manifests().find((m) => m.schema === manifest.schema);
  if (holder !== undefined) {
    return { applied: false, problem: `its schema "${manifest.schema}" is already ${holder.name}'s` };
  }
  // A requirement it lacks holds it back, as at a start: imported, nothing
  // registered, waiting for `requires.ts` to let it in.
  const plugins = adoptedPlugins(env);
  const needs = plugins === undefined || opts.ignoreNeeds ? [] : staticNeeds(manifest, plugins, env);
  if (needs.length > 0) {
    adoptChange(env, record, manifest, needs);
    return { applied: true, waiting: needs };
  }
  // Its tables first, as at a start: nothing registers against a schema that
  // is not there. Without a database that is the one part left to a restart.
  const ownsTables = manifest.migrationsDir !== undefined && manifest.migrationsDir.trim() !== '';
  if (ownsTables) {
    if (deps.pool === undefined) {
      return { applied: false, restartFor: 'its schema could not be migrated here (no database), so it loads at the next start' };
    }
    try {
      await runMigrations(deps.pool, [manifest]);
    } catch (err) {
      return { applied: false, problem: `its migrations could not be applied: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  try {
    registry.register(manifest);
  } catch (err) {
    return { applied: false, problem: `it did not register: ${err instanceof Error ? err.message : String(err)}` };
  }
  adoptChange(env, record, manifest);
  if (deps.pool !== undefined) {
    await adoptPluginPolicies(deps.pool, [manifest], new Date(), log, ownerTimezone(env)).catch(() => undefined);
  }
  return { applied: true };
}
