/**
 * Where an installed plugin's files live.
 *
 * Under the installation's data directory, beside the artifacts and the logs,
 * because that is the directory an owner backs up and the one a packaged
 * install already owns. Never in the repository: what this installation has
 * installed is the owner's configuration, like the record file itself.
 */
import path from 'node:path';
import { resolveDataDir, type InstalledPlugin } from '@buddi/core';

/** `<data>/plugins` — one directory per installed plugin, plus `staging`. */
export function pluginsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveDataDir(env), 'plugins');
}

/** `<data>/plugins/staging` — one directory per stage, named by its id. */
export function stagingRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(pluginsRoot(env), 'staging');
}

/** Where a plugin installed from a registry or a tarball is unpacked to. */
export function installedPackageDir(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(pluginsRoot(env), name);
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
