/**
 * `GET /api/plugins/folders?path=<absolute path>` — the folders on the
 * gateway's machine, for "A directory I built".
 *
 * The page cannot browse the machine buddi runs on (a browser's own folder
 * picker gives no path, and the browser may be on a phone), so this lists one
 * folder's subfolders by name and says which of them hold a package.json. It
 * starts at the owner's home directory and refuses anything outside it, the
 * way the folder the owner builds a plugin in always is. Hidden folders are
 * left out of the list; a path that names one explicitly is still answered,
 * because the owner typed it.
 *
 * Names and one existence check each: nothing is read, nothing is written,
 * and nothing leaves the machine.
 */
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { RouteReply } from './plugins.js';

/** More than this in one folder and the list says it stopped. */
export const MAX_FOLDERS = 500;

export interface FolderEntry {
  name: string;
  path: string;
  /** It holds a package.json: something that can be read as a plugin. */
  plugin: boolean;
}

export interface FoldersView {
  path: string;
  /** One level up, or `null` at the home directory. */
  parent: string | null;
  /** The home directory, where the list starts and stops. */
  home: string;
  folders: FolderEntry[];
  /** Set when there were more than `MAX_FOLDERS`. */
  truncated?: true;
}

/** The owner's home directory: `HOME` as the gateway was started, else the OS's. */
export function homeOf(env: NodeJS.ProcessEnv): string {
  const home = env.HOME?.trim() || homedir();
  try {
    return realpathSync(home);
  } catch {
    return path.resolve(home);
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isDirectory(full: string): boolean {
  try {
    return statSync(full).isDirectory();
  } catch {
    return false;
  }
}

export function pluginFoldersRoute(env: NodeJS.ProcessEnv, url: URL): RouteReply {
  const home = homeOf(env);
  const asked = url.searchParams.get('path')?.trim() || home;
  if (!path.isAbsolute(asked)) {
    return { status: 400, body: { error: 'Give the whole path, starting at /.' } };
  }
  let real: string;
  try {
    real = realpathSync(path.resolve(asked));
  } catch {
    return { status: 404, body: { error: `There is no folder at ${asked}.` } };
  }
  // Checked after links are followed: a link out of the home directory is outside it.
  if (!inside(home, real)) {
    return { status: 403, body: { error: 'Only folders inside your home directory are listed here.' } };
  }
  if (!isDirectory(real)) {
    return { status: 400, body: { error: `${asked} is a file, not a folder.` } };
  }
  let names: string[];
  try {
    names = readdirSync(real);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return {
      status: 403,
      body: { error: code === 'EACCES' || code === 'EPERM' ? `buddi may not read ${real}.` : `${real} could not be read.` },
    };
  }
  const folders: FolderEntry[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))) {
    if (name.startsWith('.')) continue;
    const full = path.join(real, name);
    if (!isDirectory(full)) continue;
    // A link that leads out of the home directory is not offered as a way in.
    try {
      if (!inside(home, realpathSync(full))) continue;
    } catch {
      continue;
    }
    folders.push({ name, path: full, plugin: existsSync(path.join(full, 'package.json')) });
  }
  const view: FoldersView = {
    path: real,
    parent: real === home ? null : path.dirname(real),
    home,
    folders: folders.slice(0, MAX_FOLDERS),
    ...(folders.length > MAX_FOLDERS ? { truncated: true as const } : {}),
  };
  return { status: 200, body: view };
}
