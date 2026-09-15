/**
 * Loading installed plugins — the one place in this repository that imports
 * code it was handed a path to.
 *
 * Core may not do this. Not because a dynamic import is worse than a static one
 * but because the direction of the dependency is the whole architecture:
 * core knows a plugin only through `PluginManifest`, and something that
 * resolves an arbitrary entry point and imports it is, by definition, knowing
 * more. So it lives here, at the composition root, and `check-boundaries.mjs`
 * now fails if core grows a dynamic import of a non-relative specifier.
 *
 * Three rules:
 *
 *  - **one bad plugin never takes the installation down.** An entry that has
 *    moved, a module that throws at import, a default export that is not a
 *    manifest: each becomes a *problem* on the result, reported by
 *    `buddi plugins list` and `buddi doctor`, and every other plugin still
 *    loads. The alternative is an owner whose whole assistant stops answering
 *    because a weather plugin was deleted.
 *  - **loading is checked, not trusted.** The manifest is validated before it
 *    is handed to the registry: shape, a name that is not already a built-in,
 *    and a schema that is neither core's nor another plugin's.
 *  - **loaded once per process.** The registry is built in several places from
 *    a synchronous function; the import is asynchronous. So an entry point
 *    awaits `loadInstalledPlugins` once, at startup, and everything built
 *    afterwards reads the adopted result — the same shape `adoptProcessCatalog`
 *    already uses, for the same reason.
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  contributionOf,
  pluginsFilePath,
  readPluginsFile,
  type InstalledPlugin,
  type PluginContribution,
  type PluginManifest,
} from '@buddi/core';
import { agentSearchPath } from '../agents/catalog.js';

/** The plugin names this build compiles in. They are never records. */
export const BUILT_IN_PLUGINS: readonly string[] = [
  'finance',
  'email',
  'memory',
  'artifacts',
  'reminder',
  'schedule',
  'canvas',
  'owner',
  'platform',
  'agent',
];

/** A plugin that is installed but did not load, and the sentence saying why. */
export interface PluginProblem {
  name: string;
  /** The record's entry path, so the owner can look at it. */
  entry: string;
  message: string;
}

/** One plugin that loaded: its record and the manifest it produced. */
export interface LoadedPlugin {
  record: InstalledPlugin;
  manifest: PluginManifest;
  contribution: PluginContribution;
}

export interface LoadedPlugins {
  /** The record file this came from — printed by `plugins list`. */
  file: string;
  loaded: LoadedPlugin[];
  problems: PluginProblem[];
}

/** Where this installation's record lives. */
export function recordFile(env: NodeJS.ProcessEnv = process.env): string {
  return pluginsFilePath({ ownerRoot: agentSearchPath(env).ownerRoot, env });
}

/**
 * Is this object a plugin manifest? The check a module gets before its code is
 * allowed anywhere near the registry.
 */
export function manifestProblem(value: unknown, expected?: { name?: string }): string | undefined {
  if (typeof value !== 'object' || value === null) return 'its entry point exports no manifest object';
  const m = value as Partial<PluginManifest>;
  if (typeof m.name !== 'string' || m.name.trim() === '') return 'its manifest has no name';
  if (typeof m.version !== 'string' || m.version.trim() === '') return `plugin "${m.name}" has no version`;
  if (typeof m.schema !== 'string' || m.schema.trim() === '') return `plugin "${m.name}" declares no schema`;
  if (!Array.isArray(m.tools)) return `plugin "${m.name}" has no tools array`;
  if (BUILT_IN_PLUGINS.includes(m.name)) {
    return `"${m.name}" is the name of a plugin this build already ships; a second one would collide on every tool name`;
  }
  if (m.schema === 'core') {
    return `plugin "${m.name}" claims the "core" schema, which belongs to buddi itself`;
  }
  if (expected?.name !== undefined && expected.name !== m.name) {
    return `it now calls itself "${m.name}", but it is installed as "${expected.name}"`;
  }
  return undefined;
}

/** Import one entry point and validate what comes back. */
export async function loadManifest(
  entry: string,
  expected?: { name?: string },
): Promise<{ ok: true; manifest: PluginManifest } | { ok: false; message: string }> {
  if (!existsSync(entry)) {
    return {
      ok: false,
      message: `its entry point is not on disk any more (${entry}) — was the plugin moved, or not built?`,
    };
  }
  let mod: Record<string, unknown>;
  try {
    mod = (await import(pathToFileURL(entry).href)) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, message: `importing it threw: ${err instanceof Error ? err.message : String(err)}` };
  }
  const candidate = mod.manifest ?? mod.default;
  const problem = manifestProblem(candidate, expected);
  if (problem !== undefined) return { ok: false, message: problem };
  return { ok: true, manifest: candidate as PluginManifest };
}

/** Read the record and load everything in it. Never throws on a single plugin. */
export async function loadInstalledPlugins(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedPlugins> {
  const file = recordFile(env);
  const loaded: LoadedPlugin[] = [];
  const problems: PluginProblem[] = [];
  let contents;
  try {
    contents = readPluginsFile(file);
  } catch (err) {
    // A record nobody can parse is reported, not thrown: this function is
    // awaited by every entry point, and a corrupt file must not take down the
    // very command (`buddi plugins list`) an owner would use to see it.
    return {
      file,
      loaded,
      problems: [
        { name: '(the record itself)', entry: file, message: err instanceof Error ? err.message : String(err) },
      ],
    };
  }
  const schemas = new Map<string, string>();
  for (const record of contents.plugins) {
    const result = await loadManifest(record.entry, { name: record.name });
    if (!result.ok) {
      problems.push({ name: record.name, entry: record.entry, message: result.message });
      continue;
    }
    const owner = schemas.get(result.manifest.schema);
    if (owner !== undefined) {
      problems.push({
        name: record.name,
        entry: record.entry,
        message: `it claims the "${result.manifest.schema}" schema, which "${owner}" already owns here`,
      });
      continue;
    }
    schemas.set(result.manifest.schema, record.name);
    loaded.push({ record, manifest: result.manifest, contribution: contributionOf(result.manifest) });
  }
  return { file, loaded, problems };
}

/* ------------------------------------------------------------------ *
 * Adoption: one load per process
 * ------------------------------------------------------------------ */

let adopted: { env: NodeJS.ProcessEnv; plugins: LoadedPlugins } | undefined;

/**
 * Load the installed plugins once and publish them to this process.
 *
 * Every long-running entry point awaits this before it builds a registry. A
 * process that never calls it — a unit test, a fixture — sees exactly the
 * built-in plugins, which is the honest answer for a process that never read
 * the owner's record.
 */
export async function loadPluginsOnce(env: NodeJS.ProcessEnv = process.env): Promise<LoadedPlugins> {
  if (adopted && adopted.env === env) return adopted.plugins;
  const plugins = await loadInstalledPlugins(env);
  adopted = { env, plugins };
  return plugins;
}

/** What `loadPluginsOnce` found, or nothing when it was never called. */
export function adoptedPlugins(env: NodeJS.ProcessEnv = process.env): LoadedPlugins | undefined {
  return adopted && adopted.env === env ? adopted.plugins : undefined;
}

/** The manifests of every installed plugin that loaded. Empty before adoption. */
export function externalManifests(env: NodeJS.ProcessEnv = process.env): PluginManifest[] {
  return (adoptedPlugins(env)?.loaded ?? []).map((p) => p.manifest);
}

/** Publish a set of plugins directly. For tests, and for `plugins install`. */
export function adoptPlugins(env: NodeJS.ProcessEnv, plugins: LoadedPlugins): void {
  adopted = { env, plugins };
}

/** Forget what was adopted. Tests only. */
export function resetAdoptedPlugins(): void {
  adopted = undefined;
}

/** The directory a `directory` source points at, resolved and checked. */
export function resolvePluginDirectory(dir: string, cwd = process.cwd()): string {
  return path.resolve(cwd, dir);
}
