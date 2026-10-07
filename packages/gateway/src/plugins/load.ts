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
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  contributionOf,
  isPluginSchemaName,
  satisfiesRange,
  parsePluginRequires,
  parsePluginUses,
  pluginRequiresMismatch,
  pluginUsesMismatch,
  pluginsFilePath,
  readPluginsFile,
  type InstalledPlugin,
  type PluginContribution,
  type PluginManifest,
  type PluginUse,
} from '@buddi/core';
import { agentSearchPath, builtInManifests } from '../agents/catalog.js';
import { createMissionManifest } from '../missions/report.js';
import { createAskManifest } from '../surfaces/pending-question.js';
import { createOfferManifest } from '../surfaces/offered-actions.js';
import { createHandoffManifest } from '../surfaces/handoff.js';
import { relinkInstalledPlugins, type RelinkOptions, type RelinkReport } from './relink.js';

/**
 * The families that are *not* in the base registry: they are registered onto a
 * per-run copy of it, because each one closes over that run's sink (the mission
 * decision, the pending question, the offered actions).
 *
 * They are reserved here all the same, and that is the point. A per-run family
 * is the worst thing for an installed plugin to collide with: the base registry
 * would accept the plugin happily, and then every mission run and every chat
 * session would throw at `registry.register(...)` — the installation stops
 * answering, at run time, far from the install that caused it. Refusing the
 * name at install is the only place that failure can still be explained.
 */
export function perRunManifests(): PluginManifest[] {
  // The sinks are empty objects on purpose: a sink is a mutable box a run
  // writes its decision into, and nothing here ever calls `execute`. What is
  // wanted is the shape — the family name and the tool names — from the same
  // factories the runs use, so this cannot fall behind them either.
  return [
    createMissionManifest({}),
    createAskManifest({}),
    createOfferManifest({}),
    createHandoffManifest({}, { maker: () => undefined, listed: async () => undefined }),
  ];
}

/** Memoised per `env` object, like the search path: building a registry is real work. */
const builtInNames = new WeakMap<NodeJS.ProcessEnv, ReadonlySet<string>>();
const builtInTools = new WeakMap<NodeJS.ProcessEnv, ReadonlySet<string>>();

/**
 * The plugin names this build compiles in. They are never records.
 *
 * **Derived, never listed.** Everything the base registry registers, plus the
 * per-run families above. A hand-written list was the defect: `web` shipped
 * after the list was written, so an installed plugin called `web` passed this
 * check and its migrations would have been applied into the built-in web
 * plugin's schema, next to `web.fetches`.
 */
export function builtInPluginNames(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const cached = builtInNames.get(env);
  if (cached) return cached;
  const names = new Set<string>(
    [...builtInManifests(env), ...perRunManifests()].map((m) => m.name),
  );
  // Sources an agent's sidecar names that are not plugins: `buddi`, which the
  // starter team was accepted under before it became catalogue packages, and
  // `market`, the catalogue's own. A plugin of either name would claim them.
  names.add('buddi');
  names.add('market');
  builtInNames.set(env, names);
  return names;
}

/**
 * Every tool name this build already answers to, the per-run families included.
 *
 * The registry refuses a colliding tool name when a plugin registers, so this
 * adds nothing for the base families beyond a better sentence. It is the
 * per-run ones it exists for: `mission.report` from a plugin with an innocent
 * name would sit quietly in the base registry and blow up on the next mission.
 */
export function builtInToolNames(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const cached = builtInTools.get(env);
  if (cached) return cached;
  const names = new Set<string>(
    [...builtInManifests(env), ...perRunManifests()].flatMap((m) => m.tools.map((t) => t.name)),
  );
  builtInTools.set(env, names);
  return names;
}

/** Is this the name of something this build already ships? */
export function isBuiltInPlugin(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return builtInPluginNames(env).has(name);
}

/** A plugin that is installed but did not load, and the sentence saying why. */
export interface PluginProblem {
  name: string;
  /** The record's entry path, so the owner can look at it. */
  entry: string;
  message: string;
  /**
   * The record itself, when there is one.
   *
   * Doctor checks the approved hash of a plugin that did *not* load as well as
   * one that did: a plugin whose files were replaced is exactly the plugin
   * most likely to stop importing, and "it did not load" and "it is not what
   * you approved" are two different sentences an owner should get together.
   * Absent for the one problem that is not a plugin: the record file itself.
   */
  record?: InstalledPlugin;
}

/** The name the record file's own problems are reported under. */
export const RECORD_ITSELF = '(the record itself)';

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
  /**
   * Installed and disabled by the owner: not imported, nothing registered,
   * the schema left exactly where it is. Absent means none.
   */
  disabled?: InstalledPlugin[];
  /**
   * Imported, but held back because something it requires is missing,
   * disabled, outside its range or not set up (docs/plugins.md §2.10):
   * nothing of it is registered and its data stays. `requires.ts` lets it in
   * once every need is met. Absent means none.
   */
  waiting?: WaitingPlugin[];
}

/** What a plugin needs of one it requires and does not have. */
export interface PluginNeed {
  plugin: string;
  range: string;
  /**
   * `missing`: not installed. `disabled`: installed and switched off.
   * `failed`: installed, did not load. `range`: loaded at a version outside
   * the range. `waiting`: itself held back. `setup`: loaded, not set up.
   */
  state: 'missing' | 'disabled' | 'failed' | 'range' | 'waiting' | 'setup';
  /** The version installed, when there is one. */
  installed?: string;
  /** For `setup`: what that plugin says to do first, and where. */
  note?: string;
  page?: string;
}

/** A plugin held back by its requirements. */
export interface WaitingPlugin {
  record: InstalledPlugin;
  manifest: PluginManifest;
  needs: PluginNeed[];
}

/** Where this installation's record lives. */
export function recordFile(env: NodeJS.ProcessEnv = process.env): string {
  return pluginsFilePath({ ownerRoot: agentSearchPath(env).ownerRoot, env });
}

/**
 * Is this object a plugin manifest? The check a module gets before its code is
 * allowed anywhere near the registry.
 */
export function manifestProblem(
  value: unknown,
  expected?: { name?: string },
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (typeof value !== 'object' || value === null) return 'its entry point exports no manifest object';
  const m = value as Partial<PluginManifest>;
  if (typeof m.name !== 'string' || m.name.trim() === '') return 'its manifest has no name';
  if (typeof m.version !== 'string' || m.version.trim() === '') return `plugin "${m.name}" has no version`;
  if (typeof m.schema !== 'string' || m.schema.trim() === '') return `plugin "${m.name}" declares no schema`;
  if (!Array.isArray(m.tools)) return `plugin "${m.name}" has no tools array`;
  if (isBuiltInPlugin(m.name, env)) {
    return `"${m.name}" is the name of a plugin this build already ships; a second one would collide on every tool name`;
  }
  if (m.schema === 'core') {
    return `plugin "${m.name}" claims the "core" schema, which belongs to buddi itself`;
  }
  /*
   * The schema name reaches `create schema`, `set search_path` and, on a
   * purge, `drop schema`. It is quoted everywhere it does, and it also has to
   * be a plain identifier: a manifest is a string somebody else wrote, and the
   * place to refuse one that is not a schema name is before it is recorded as
   * owning tables.
   */
  if (!isPluginSchemaName(m.schema)) {
    return (
      `plugin "${m.name}" declares the schema ${JSON.stringify(m.schema)}, which is not a Postgres ` +
      'identifier: lowercase letters, digits and underscores, not starting with a digit'
    );
  }
  const reserved = builtInToolNames(env);
  const taken = (m.tools as PluginManifest['tools']).map((t) => t?.name).filter((n) => reserved.has(n));
  if (taken.length > 0) {
    return (
      `plugin "${m.name}" declares the tool name${taken.length === 1 ? '' : 's'} ` +
      `${taken.join(', ')}, which this build already answers to`
    );
  }
  if (expected?.name !== undefined && expected.name !== m.name) {
    return `it now calls itself "${m.name}", but it is installed as "${expected.name}"`;
  }
  return undefined;
}

/**
 * The `buddi.uses` of the package an entry point belongs to: the nearest
 * `package.json` above it. What the install card listed, read back.
 *
 * A package.json with no `buddi.uses` declares nothing, and so does an entry
 * with no package.json above it at all (a bare built file, in a test).
 */
export function packageUses(entry: string): { ok: true; uses: PluginUse[] } | { ok: false; message: string } {
  const pkg = packageBuddi(entry);
  if (!pkg.ok) return pkg;
  return parsePluginUses(pkg.buddi?.uses, "its package.json's buddi.uses");
}

/** The `buddi.requires` of the package an entry point belongs to, as `packageUses` reads `uses`. */
export function packageRequires(entry: string): { ok: true; requires: Record<string, string> } | { ok: false; message: string } {
  const pkg = packageBuddi(entry);
  if (!pkg.ok) return pkg;
  return parsePluginRequires(pkg.buddi?.requires, "its package.json's buddi.requires");
}

/** The `buddi` field of the nearest package.json above an entry point. */
function packageBuddi(entry: string): { ok: true; buddi: { uses?: unknown; requires?: unknown; optional?: unknown } | undefined } | { ok: false; message: string } {
  let dir = path.dirname(entry);
  for (let i = 0; i < 8; i += 1) {
    const file = path.join(dir, 'package.json');
    if (existsSync(file)) {
      let pkg: { buddi?: { uses?: unknown; requires?: unknown; optional?: unknown } };
      try {
        pkg = JSON.parse(readFileSync(file, 'utf8')) as typeof pkg;
      } catch (err) {
        return { ok: false, message: `its package.json cannot be read: ${err instanceof Error ? err.message : String(err)}` };
      }
      return { ok: true, buddi: pkg.buddi };
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return { ok: true, buddi: undefined };
}

/**
 * Why a loaded manifest's `requires` cannot register, or undefined: a map
 * this build cannot read, or not the one its package.json — and so the
 * install card — declared (docs/plugins.md §2.10).
 */
export function requiresProblem(manifest: PluginManifest, entry: string): string | undefined {
  const declared = parsePluginRequires(manifest.requires, `plugin "${manifest.name}"'s manifest requires`, manifest.name);
  if (!declared.ok) return declared.message;
  const shown = packageRequires(entry);
  if (!shown.ok) return shown.message;
  const requires = pluginRequiresMismatch(manifest.name, declared.requires, shown.requires);
  if (requires !== undefined) return requires;
  // `optional` (1.27), declared twice the same way: the card says "works better with".
  const optional = parsePluginRequires(manifest.optional, `plugin "${manifest.name}"'s manifest optional`, manifest.name);
  if (!optional.ok) return optional.message;
  const pkg = packageBuddi(entry);
  if (!pkg.ok) return pkg.message;
  const shownOptional = parsePluginRequires(pkg.buddi?.optional, "its package.json's buddi.optional");
  if (!shownOptional.ok) return shownOptional.message;
  return pluginRequiresMismatch(manifest.name, optional.requires, shownOptional.requires, 'optional');
}

/**
 * Why a loaded manifest's `uses` cannot register, or undefined: an area this
 * build does not have, or a list that is not the one its package.json — and
 * so the install card — declared (docs/plugin-host-api.md §5).
 */
export function usesProblem(manifest: PluginManifest, entry: string): string | undefined {
  const declared = parsePluginUses(manifest.uses, `plugin "${manifest.name}"'s manifest uses`);
  if (!declared.ok) return declared.message;
  const shown = packageUses(entry);
  if (!shown.ok) return shown.message;
  return pluginUsesMismatch(manifest.name, declared.uses, shown.uses);
}

/** Import one entry point and validate what comes back. */
export async function loadManifest(
  entry: string,
  expected?: { name?: string },
  env: NodeJS.ProcessEnv = process.env,
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
  const problem = manifestProblem(candidate, expected, env);
  if (problem !== undefined) return { ok: false, message: problem };
  const uses = usesProblem(candidate as PluginManifest, entry);
  if (uses !== undefined) return { ok: false, message: uses };
  const requires = requiresProblem(candidate as PluginManifest, entry);
  if (requires !== undefined) return { ok: false, message: requires };
  return { ok: true, manifest: candidate as PluginManifest };
}

/**
 * Point every installed plugin at this process's core (`relink.ts`), reading
 * this installation's record.
 */
export function relinkPlugins(env: NodeJS.ProcessEnv = process.env, opts: Omit<RelinkOptions, 'file'> = {}): RelinkReport {
  return relinkInstalledPlugins(env, { ...opts, file: recordFile(env) });
}

let relinkBeforeLoading = false;

/**
 * Relink every installed plugin before the next load. The gateway's serve
 * entry points call this first, and only they: the shims are shared by every
 * process on the data directory, and the one that should own them is the one
 * that keeps the plugins loaded — not a `buddi plugins list` from another
 * installation's CLI.
 */
export function relinkPluginsOnLoad(on = true): void {
  relinkBeforeLoading = on;
}

/** Read the record and load everything in it. Never throws on a single plugin. */
export async function loadInstalledPlugins(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LoadedPlugins> {
  const file = recordFile(env);
  if (relinkBeforeLoading) {
    try {
      relinkInstalledPlugins(env, { file });
    } catch {
      // Never in the way of a start: whatever stays broken says so below.
    }
  }
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
        { name: RECORD_ITSELF, entry: file, message: err instanceof Error ? err.message : String(err) },
      ],
    };
  }
  const schemas = new Map<string, string>();
  const disabled: InstalledPlugin[] = [];
  for (const record of contents.plugins) {
    // Disabled: nothing of it is imported, so nothing of it registers — no
    // tools, pages, views, glances, sources, sentinels or channels — and its
    // schema is not migrated, only kept.
    if (record.enabled === false) {
      disabled.push(record);
      continue;
    }
    const result = await loadManifest(record.entry, { name: record.name }, env);
    if (!result.ok) {
      problems.push({ name: record.name, entry: record.entry, message: result.message, record });
      continue;
    }
    const owner = schemas.get(result.manifest.schema);
    if (owner !== undefined) {
      problems.push({
        name: record.name,
        entry: record.entry,
        message: `it claims the "${result.manifest.schema}" schema, which "${owner}" already owns here`,
        record,
      });
      continue;
    }
    schemas.set(result.manifest.schema, record.name);
    loaded.push({ record, manifest: result.manifest, contribution: contributionOf(result.manifest) });
  }
  // What can be known before anything runs: a requirement missing,
  // disabled, failed or out of range holds the plugin back. Whether a
  // requirement is set up is asked once the registry exists (`requires.ts`).
  const held = holdBack({ file, loaded, problems, ...(disabled.length === 0 ? {} : { disabled }) }, env);
  return held;
}

/**
 * Move every loaded plugin whose requirements are not met (as far as the
 * record and the load can tell) into `waiting`, until nothing moves: a
 * plugin held back is itself a need for whatever requires it.
 */
export function holdBack(plugins: LoadedPlugins, env: NodeJS.ProcessEnv = process.env): LoadedPlugins {
  let loaded = [...plugins.loaded];
  const waiting = [...(plugins.waiting ?? [])];
  for (let pass = 0; pass < 10; pass += 1) {
    const current: LoadedPlugins = { ...plugins, loaded, waiting };
    const moving = loaded
      .map((p) => ({ p, needs: staticNeeds(p.manifest, current, env) }))
      .filter(({ needs }) => needs.length > 0);
    if (moving.length === 0) break;
    loaded = loaded.filter((p) => !moving.some((m) => m.p === p));
    for (const { p, needs } of moving) waiting.push({ record: p.record, manifest: p.manifest, needs });
  }
  for (const w of waiting) w.needs = staticNeeds(w.manifest, { ...plugins, loaded, waiting }, env);
  const { waiting: _old, ...rest } = plugins;
  return { ...rest, loaded, ...(waiting.length === 0 ? {} : { waiting }) };
}

/**
 * What a manifest's requirements lack, from the record and the load alone:
 * missing, disabled, failed, out of range or held back. A plugin this build
 * ships satisfies any range.
 */
export function staticNeeds(manifest: PluginManifest, plugins: LoadedPlugins, env: NodeJS.ProcessEnv = process.env): PluginNeed[] {
  const needs: PluginNeed[] = [];
  for (const [name, range] of Object.entries(manifest.requires ?? {})) {
    if (isBuiltInPlugin(name, env)) continue;
    const loaded = plugins.loaded.find((p) => p.record.name === name);
    const version = loaded?.manifest.version;
    if (loaded) {
      if (satisfiesRange(version as string, range) !== true) needs.push({ plugin: name, range, state: 'range', installed: version as string });
      continue;
    }
    const held = plugins.waiting?.find((w) => w.record.name === name);
    if (held) {
      needs.push({ plugin: name, range, state: satisfiesRange(held.manifest.version, range) === true ? 'waiting' : 'range', installed: held.manifest.version });
      continue;
    }
    const off = plugins.disabled?.find((r) => r.name === name);
    if (off) {
      needs.push({ plugin: name, range, state: 'disabled', installed: off.version });
      continue;
    }
    const failed = plugins.problems.find((p) => p.name === name);
    if (failed) {
      needs.push({ plugin: name, range, state: 'failed', ...(failed.record ? { installed: failed.record.version } : {}) });
      continue;
    }
    needs.push({ plugin: name, range, state: 'missing' });
  }
  return needs;
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

/**
 * A plugin that will not migrate is a plugin that did not load.
 *
 * It is moved out of `loaded` and into `problems`, which is the same place an
 * entry that threw at import lands: `installedManifests` stops offering it for
 * the rest of this run, so nothing registers its tools against a schema that
 * is not there, and `pluginLoadReport` — what the Plugins page and doctor read
 * — says why. `docs/install.md` §7: one plugin never stops the gateway.
 */
export function demoteToLoadFailure(
  name: string,
  message: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const plugins = adoptedPlugins(env);
  if (plugins === undefined) return;
  const failed = plugins.loaded.find((p) => p.record.name === name);
  if (failed === undefined) return;
  adoptPlugins(env, {
    file: plugins.file,
    loaded: plugins.loaded.filter((p) => p !== failed),
    problems: [
      ...plugins.problems,
      { name, entry: failed.record.entry, message, record: failed.record },
    ],
    ...(plugins.disabled === undefined ? {} : { disabled: plugins.disabled }),
    ...(plugins.waiting === undefined ? {} : { waiting: plugins.waiting }),
  });
}

/** Forget what was adopted. Tests only. */
export function resetAdoptedPlugins(): void {
  adopted = undefined;
}

/** The directory a `directory` source points at, resolved and checked. */
export function resolvePluginDirectory(dir: string, cwd = process.cwd()): string {
  return path.resolve(cwd, dir);
}

/** One installed plugin that did not load, as the API and doctor report it. */
export interface PluginLoadFailure {
  name: string;
  /** From the record, since the manifest is exactly what could not be read. */
  version: string;
  error: string;
}

/**
 * What failed to load, for the API and the doctor.
 *
 * Reads what was adopted at start rather than importing anything: by the time
 * anybody asks, the imports have happened, and re-importing a plugin whose
 * top-level code throws to answer a page request would run it again. A process
 * that never adopted (a unit test, a one-shot command) gets an empty list,
 * which is the honest answer for a process that never read the record.
 */
export function pluginLoadReport(env: NodeJS.ProcessEnv = process.env): PluginLoadFailure[] {
  const plugins = adoptedPlugins(env);
  if (plugins === undefined) return [];
  const versions = new Map<string, string>();
  try {
    for (const record of readPluginsFile(plugins.file).plugins) versions.set(record.name, record.version);
  } catch {
    // The record itself is one of the problems below; it is reported there.
  }
  return plugins.problems.map((problem) => ({
    name: problem.name,
    version: versions.get(problem.name) ?? '?',
    error: problem.message,
  }));
}
