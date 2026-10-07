/**
 * Pointing every installed plugin at the core that is running now.
 *
 * Approval writes each plugin a plugin-only `@buddi/core` that re-exports the
 * running core's `dist/plugin` by absolute path (`linkCore` in stage.ts). In a
 * packaged install that path is inside a versioned folder — buddi.app's
 * `releases/buddi-<v>/…`, or the bundle's own `buddi-<v>/…` — and an upgrade
 * removes the old one, so every plugin approved under an earlier version would
 * fail at import with a "Cannot find module" for a core that is gone.
 *
 * So the gateway rewrites those shims before it loads anything
 * (`relinkPluginsOnLoad` in load.ts), and the upgrader does the same once the new release
 * is in place. Both are idempotent: a shim already pointing at this core is
 * read, compared and left alone, so a normal start writes nothing.
 *
 * A directory install (a developer's own folder) keeps whatever its
 * `node_modules/@buddi/core` is — usually a `link:` to a checkout — unless it
 * is a shim buddi wrote, which is rewritten like any other.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { readPluginsFile, type InstalledPlugin } from '@buddi/core';
import { packageDirOf } from './paths.js';
import {
  isPluginOnlyCore,
  nestedCoreDirs,
  pluginOnlyCoreIsCurrent,
  resolveCoreDir,
  writePluginOnlyCore,
} from './stage.js';

/** Rewrite one shim when it is not already the one over `coreDir`. True when it changed. */
function relinkOne(dir: string, coreDir: string, onlyOurs: boolean): boolean {
  if (onlyOurs && !isPluginOnlyCore(dir)) return false;
  if (pluginOnlyCoreIsCurrent(dir, coreDir)) return false;
  rmSync(dir, { recursive: true, force: true });
  writePluginOnlyCore(dir, coreDir);
  return true;
}

/**
 * Point one plugin's `@buddi/core` and every nested core at `coreDir`.
 * True when anything was rewritten.
 */
export function relinkPackage(packageDir: string, coreDir: string, opts: { directory?: boolean } = {}): boolean {
  const onlyOurs = opts.directory === true;
  const top = path.join(packageDir, 'node_modules', '@buddi', 'core');
  if (!onlyOurs) mkdirSync(path.dirname(top), { recursive: true });
  let changed = relinkOne(top, coreDir, onlyOurs);
  for (const nested of nestedCoreDirs(packageDir)) changed = relinkOne(nested, coreDir, onlyOurs) || changed;
  return changed;
}

export interface RelinkOptions {
  /** The core to point at. The one this process runs, unless the upgrader names the next release's. */
  coreDir?: string;
  /** One line per plugin that actually changed (and per one that could not be). */
  log?: (line: string) => void;
  /** The record file to read (`recordFile(env)` in load.ts). */
  file?: string;
  /** The records themselves, instead of a file. */
  plugins?: InstalledPlugin[];
}

/** What a relink pass did: the names it rewrote. */
export interface RelinkReport {
  coreDir?: string;
  relinked: string[];
}

/**
 * Point every installed plugin — enabled or not, any source — at `coreDir`.
 * Never throws: a plugin whose folder is gone is left to the loader, which
 * says it did not load; one that cannot be rewritten is logged and skipped.
 */
export function relinkInstalledPlugins(env: NodeJS.ProcessEnv = process.env, opts: RelinkOptions = {}): RelinkReport {
  const coreDir = opts.coreDir ?? resolveCoreDir();
  const log = opts.log ?? ((line: string): void => console.error(line));
  if (coreDir === undefined) return { relinked: [] };
  let records = opts.plugins;
  if (records === undefined) {
    if (opts.file === undefined) return { coreDir, relinked: [] };
    try {
      records = readPluginsFile(opts.file).plugins;
    } catch {
      // A record nobody can parse is the loader's to report.
      return { coreDir, relinked: [] };
    }
  }
  const relinked: string[] = [];
  for (const record of records) {
    let dir: string;
    try {
      dir = packageDirOf(record, env);
    } catch {
      continue;
    }
    if (!existsSync(dir)) continue;
    try {
      if (relinkPackage(dir, coreDir, { directory: record.source.kind === 'directory' })) {
        relinked.push(record.name);
        log(`plugins: relinked ${record.name} to the running @buddi/core`);
      }
    } catch (err) {
      log(`plugins: could not relink ${record.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { coreDir, relinked };
}

/**
 * Is this load error a plugin-only core whose target is gone — what an upgrade
 * that removed the previous version's folder leaves behind? The fix is a
 * relink, which every start does.
 */
export function isCoreMovedError(message: string): boolean {
  if (!/Cannot find module|ERR_MODULE_NOT_FOUND/.test(message)) return false;
  const normal = message.split('\\').join('/');
  return /@buddi\/core\/dist\/plugin\/index\.js/.test(normal) && /node_modules\/@buddi\/core\/plugin\.js/.test(normal);
}
