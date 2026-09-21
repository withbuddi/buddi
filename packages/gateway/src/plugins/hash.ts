/**
 * The hash doctor compares against.
 *
 * A plugin runs with the process's full privileges, so the only honest control
 * after an install is an accounting one: what is on disk today is, or is not,
 * what the owner approved. `installedHashOf` is that accounting. It is sha256
 * over every file in the package, with the path hashed alongside the content so
 * that moving a file is a change, in sorted order so that two identical trees
 * on two machines agree.
 *
 * `node_modules` is **included**, and that is a change from the first version
 * of this file. The excuse for leaving it out was that npm writes it and its
 * layout varies; the consequence was that the hash covered the plugin's own
 * code and not the code that actually runs, which is the plugin plus every
 * dependency npm put beside it. Those bytes were fetched once, at staging, and
 * an update is the only thing that is supposed to change them — so the hash
 * covers them, and a dependency rewritten in place is now a doctor warning
 * rather than a blind spot.
 *
 * Two things are still outside it: `node_modules/@buddi/core`, which is the
 * symlink staging writes to the *running installation's* core and therefore
 * not part of the package at all, and `.git`. Everything else is hashed, and a
 * symlink among the package's own files is refused rather than skipped: a hash
 * that silently ignores what it cannot read proves nothing.
 */
import type { InstalledPlugin } from '@buddi/core';
import { packageDirOf } from './paths.js';
import { treeHash, walkTree } from './tree.js';

/** Every file in the package, relative and posix-separated, sorted. */
export function packageFiles(dir: string): string[] {
  return walkTree(dir, { includeModules: true, linksAllowedUnder: 'node_modules' }).map((e) => e.relative);
}

/** `sha256-<hex>` over the package's files, dependencies included. */
export function installedHashOf(dir: string): string {
  return treeHash(dir, { includeModules: true, linksAllowedUnder: 'node_modules' });
}

export interface HashVerification {
  name: string;
  /** Absent when nothing was recorded — a directory source, or a v1 record. */
  expected?: string;
  /** Absent when the package directory is gone. */
  actual?: string;
  /** True only when both are present and equal. */
  matches: boolean;
  /** The sentence doctor prints. Empty when there is nothing to say. */
  message: string;
}

/**
 * Has this package changed since it was approved?
 *
 * "Not recorded" is not a failure. A directory source is a developer's own
 * build and changes every time they rebuild it; saying so every morning would
 * train the owner to ignore the row that matters.
 */
export function verifyInstalledHash(
  plugin: InstalledPlugin,
  opts: { env?: NodeJS.ProcessEnv; packageDir?: string } = {},
): HashVerification {
  const expected = plugin.provenance?.installedHash;
  if (expected === undefined) {
    return {
      name: plugin.name,
      matches: true,
      message: '',
    };
  }
  const dir = opts.packageDir ?? packageDirOf(plugin, opts.env ?? process.env);
  let actual: string | undefined;
  let refused: string | undefined;
  try {
    actual = installedHashOf(dir);
  } catch (err) {
    // A tree that cannot be hashed — it is gone, or something in it is a link
    // now — is exactly the thing this check exists to say out loud.
    refused = err instanceof Error ? err.message : String(err);
  }
  if (actual === undefined) {
    return {
      name: plugin.name,
      expected,
      matches: false,
      message:
        `${plugin.name}: its files (${dir}) could not be checked against what you approved: ` +
        `${refused ?? 'the directory is not on disk any more'}`,
    };
  }
  if (actual === expected) return { name: plugin.name, expected, actual, matches: true, message: '' };
  return {
    name: plugin.name,
    expected,
    actual,
    matches: false,
    message:
      `${plugin.name} changed on disk since it was approved. Its files no longer hash to what you ` +
      'approved, and a plugin runs with everything buddi can do. Reinstall it from its source, or ' +
      `uninstall it: buddi plugins uninstall ${plugin.name}`,
  };
}
