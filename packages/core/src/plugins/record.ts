/**
 * Reading and writing the installed-plugins record.
 *
 * Small, boring, and fail-closed on one axis that matters: a record file that
 * cannot be parsed is an **error**, never an empty list. Treating a corrupt
 * file as "nothing installed" would silently unregister every tool the owner's
 * agents are granted, and the next catalog load would then refuse to boot with
 * a message about an unresolvable tool — a confusing symptom two layers away
 * from the cause.
 *
 * Writes are atomic (staged beside the file, renamed over it), for the same
 * reason agent files are: a half-written record is an installation that will
 * not start.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  PLUGINS_FILE,
  PLUGINS_FILE_ENV,
  PLUGINS_FILE_VERSION,
  type InstalledPlugin,
  type PluginsFile,
} from './types.js';

export class PluginsFileError extends Error {
  override readonly name = 'PluginsFileError';
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Where the record lives: `<owner's private directory>/plugins.json`, or
 * whatever `BUDDI_PLUGINS_FILE` pins.
 *
 * The owner's directory rather than the repository, for the reason the agent
 * search path exists at all: what this installation has installed is the
 * owner's configuration, and it is never committed.
 */
export function pluginsFilePath(opts: { ownerRoot: string; env?: NodeJS.ProcessEnv }): string {
  const pinned = opts.env?.[PLUGINS_FILE_ENV]?.trim();
  if (pinned !== undefined && pinned !== '') return path.resolve(pinned);
  return path.join(opts.ownerRoot, PLUGINS_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse the file's text. Exported so a test needs no disk. */
export function parsePluginsFile(text: string, file = PLUGINS_FILE): PluginsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new PluginsFileError(file, `${file} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(raw)) throw new PluginsFileError(file, `${file} must contain an object`);
  if (raw.version !== PLUGINS_FILE_VERSION) {
    throw new PluginsFileError(
      file,
      `${file} says version ${JSON.stringify(raw.version)}; this build reads version ${PLUGINS_FILE_VERSION}`,
    );
  }
  if (!Array.isArray(raw.plugins)) throw new PluginsFileError(file, `${file} has no "plugins" array`);
  const plugins: InstalledPlugin[] = raw.plugins.map((entry, i) => {
    if (!isRecord(entry)) throw new PluginsFileError(file, `${file}: plugins[${i}] is not an object`);
    for (const key of ['name', 'version', 'entry', 'installedAt', 'schema']) {
      if (typeof entry[key] !== 'string' || (entry[key] as string).trim() === '') {
        throw new PluginsFileError(file, `${file}: plugins[${i}] has no "${key}"`);
      }
    }
    const source = entry.source;
    if (!isRecord(source) || source.kind !== 'directory' || typeof source.path !== 'string') {
      throw new PluginsFileError(
        file,
        `${file}: plugins[${i}] ("${String(entry.name)}") has no usable source; this build installs from a directory`,
      );
    }
    return {
      name: entry.name as string,
      version: entry.version as string,
      entry: entry.entry as string,
      installedAt: entry.installedAt as string,
      schema: entry.schema as string,
      source: { kind: 'directory', path: source.path },
    };
  });
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (seen.has(plugin.name)) {
      throw new PluginsFileError(file, `${file} lists "${plugin.name}" twice; one plugin, one record`);
    }
    seen.add(plugin.name);
  }
  return { version: PLUGINS_FILE_VERSION, plugins };
}

/** The record, or an empty one. A missing file means nothing is installed. */
export function readPluginsFile(file: string): PluginsFile {
  if (!existsSync(file)) return { version: PLUGINS_FILE_VERSION, plugins: [] };
  return parsePluginsFile(readFileSync(file, 'utf8'), file);
}

/** Write the record atomically, creating its directory if it is not there yet. */
export function writePluginsFile(file: string, contents: PluginsFile): void {
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Add or replace one plugin's record, keeping the rest in order. */
export function upsertInstalledPlugin(contents: PluginsFile, plugin: InstalledPlugin): PluginsFile {
  const others = contents.plugins.filter((p) => p.name !== plugin.name);
  const index = contents.plugins.findIndex((p) => p.name === plugin.name);
  if (index === -1) return { version: PLUGINS_FILE_VERSION, plugins: [...others, plugin] };
  const next = [...contents.plugins];
  next[index] = plugin;
  return { version: PLUGINS_FILE_VERSION, plugins: next };
}

/** Drop one plugin's record. Returns the new contents and whether it was there. */
export function removeInstalledPlugin(
  contents: PluginsFile,
  name: string,
): { contents: PluginsFile; removed: boolean } {
  const plugins = contents.plugins.filter((p) => p.name !== name);
  return {
    contents: { version: PLUGINS_FILE_VERSION, plugins },
    removed: plugins.length !== contents.plugins.length,
  };
}
