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
 * `node_modules` is excluded deliberately. It is not part of what was approved
 * — npm writes it, its layout differs between npm versions, and including it
 * would make the hash change for reasons that have nothing to do with the
 * plugin's own code. The trade is stated plainly in `docs/plugins.md`: this
 * detects a tampered plugin, not a tampered dependency.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { InstalledPlugin } from '@buddi/core';
import { packageDirOf } from './paths.js';

const EXCLUDED = new Set(['node_modules', '.git']);

/** Every file in the package, relative and posix-separated, sorted. */
export function packageFiles(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (EXCLUDED.has(entry.name)) continue;
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(current, entry.name), relative);
      else if (entry.isFile()) found.push(relative);
    }
  };
  walk(dir, '');
  return found.sort();
}

/** `sha256-<hex>` over the package's files. Stable across machines. */
export function installedHashOf(dir: string): string {
  const hash = createHash('sha256');
  for (const relative of packageFiles(dir)) {
    hash.update(relative);
    hash.update('\0');
    hash.update(readFileSync(path.join(dir, relative)));
    hash.update('\0');
  }
  return `sha256-${hash.digest('hex')}`;
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
  try {
    if (statSync(dir).isDirectory()) actual = installedHashOf(dir);
  } catch {
    actual = undefined;
  }
  if (actual === undefined) {
    return {
      name: plugin.name,
      expected,
      matches: false,
      message: `${plugin.name}: its package directory (${dir}) is not on disk any more, so what was approved cannot be checked`,
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
