/**
 * Where an installed plugin's files live.
 *
 * Under the installation's data directory, beside the artifacts and the logs,
 * because that is the directory an owner backs up and the one a packaged
 * install already owns. Never in the repository: what this installation has
 * installed is the owner's configuration, like the record file itself.
 *
 * A plugin's name decides a directory name here, so the name is checked before
 * it is ever joined onto a path. A manifest is a string a stranger wrote: one
 * called `../../.ssh` or `staging` is not a naming argument, it is a write
 * somewhere it was not invited. The rule is npm's own charset, a scoped name
 * folded to one safe segment (`@scope/name` → `@scope+name`), and a
 * containment check on the result before anything renames or removes.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { resolveDataDir, type InstalledPlugin } from '@buddi/core';
import { InstallRefusal } from './refusals.js';

/** The directories under the plugins root that are not plugins. */
export const STAGING_DIR = 'staging';
/**
 * Where an uploaded `.tgz` lands before it is staged.
 *
 * The dashboard can hand buddi a tarball the owner has on their own machine,
 * and the bytes have to be somewhere on disk before anything reads them. They
 * go here rather than into the staging directory because nothing has been
 * staged yet: an upload is a file, and it is deleted the moment staging has
 * copied it (or failed to).
 */
export const INCOMING_DIR = 'incoming';

/** npm's rule, narrowed: lowercase, one optional scope, no path characters. */
const NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/**
 * The directory name a plugin's files go under.
 *
 * Scoped names are folded with `+` rather than kept as two segments: one
 * segment is one thing to check, to sweep and to remove, and `+` cannot appear
 * in an npm name so the folding cannot collide with a package that was already
 * called that.
 */
export function pluginDirKey(name: string): string {
  const trimmed = name.trim();
  if (!NAME.test(trimmed) || trimmed.length > 214) {
    throw new InstallRefusal(
      'bad-name',
      `"${name}" is not a usable plugin name. A name is lowercase letters, digits, "." "_" "-" and at ` +
        'most one @scope/ — it becomes a directory under the data directory, so nothing else is allowed.',
    );
  }
  const key = trimmed.replace('/', '+');
  if (key === STAGING_DIR || key === INCOMING_DIR) {
    throw new InstallRefusal(
      'reserved-name',
      `"${name}" is the name of a directory buddi keeps under the plugins root (${STAGING_DIR}, ` +
        `${INCOMING_DIR}), so no plugin may take it.`,
    );
  }
  return key;
}

/** `<data>/plugins` — one directory per installed plugin, plus `staging`. */
export function pluginsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDataDir(env), 'plugins');
}

/** `<data>/plugins/staging` — one directory per stage, named by its id. */
export function stagingRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(pluginsRoot(env), STAGING_DIR);
}

/** `<data>/plugins/incoming` — uploaded tarballs, until staging has copied them. */
export function incomingRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(pluginsRoot(env), INCOMING_DIR);
}

/**
 * Where a plugin installed from a registry or a tarball is unpacked to.
 *
 * The result is checked to be directly under the plugins root before it is
 * handed back, so a name that got past the charset somehow still cannot name a
 * directory outside it.
 */
export function installedPackageDir(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = pluginsRoot(env);
  const dir = path.resolve(root, pluginDirKey(name));
  if (path.dirname(dir) !== path.resolve(root)) {
    throw new InstallRefusal('escapes-plugins-root', `"${name}" does not name a directory inside ${root}`);
  }
  return dir;
}

/** Refuse a path that is not inside the plugins root. The last check before rm. */
export function assertInsidePluginsRoot(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const root = path.resolve(pluginsRoot(env));
  const resolved = path.resolve(dir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new InstallRefusal(
      'escapes-plugins-root',
      `${dir} is not inside ${root}, and this is the code that renames and removes directories`,
    );
  }
  return resolved;
}

/**
 * The directory whose files the recorded hash covers.
 *
 * A directory source points at the developer's own build and stays there; a
 * registry or tarball source was copied under the data directory and is ours.
 */
export function packageDirOf(record: InstalledPlugin, env: NodeJS.ProcessEnv = process.env): string {
  if (record.source.kind === 'directory') return record.source.path;
  return installedPackageDir(record.name, env);
}

/**
 * Remove what a half-finished install left behind.
 *
 * Two shapes: the `<name>.previous-<time>` directory an upgrade moves aside
 * and deletes once the record names the new version, and a package directory
 * no record mentions at all — which is what a crash between the rename and the
 * record write leaves. Both are unapproved code sitting in the data directory,
 * and neither is reachable by anything: the record is what loads.
 *
 * Called once at gateway start, and it says what it removed. Silence about
 * deleting somebody's files is how a sweep becomes the bug.
 */
export function sweepPluginDirs(
  env: NodeJS.ProcessEnv = process.env,
  opts: { known: readonly string[] },
): string[] {
  const root = pluginsRoot(env);
  if (!existsSync(root)) return [];
  const keep = new Set(opts.known.map((name) => pluginDirKeyOrName(name)));
  const swept: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === STAGING_DIR || entry.name === INCOMING_DIR) continue;
    const previous = /\.previous-\d+$/.test(entry.name);
    if (!previous && keep.has(entry.name)) continue;
    const dir = assertInsidePluginsRoot(path.join(root, entry.name), env);
    rmSync(dir, { recursive: true, force: true });
    swept.push(entry.name);
  }
  return swept;
}

/** The directory key, or the name itself when it is not a legal one. */
function pluginDirKeyOrName(name: string): string {
  try {
    return pluginDirKey(name);
  } catch {
    return name;
  }
}
