/**
 * The libraries a compose program may load, and every folder they need to
 * be read from (docs/files.md, "Composed documents").
 *
 * A program imports exactly one name — `docx` for a Word document,
 * `pptxgenjs` for a deck — and those packages import their own
 * dependencies. The child Node is granted read access to those package
 * folders and nothing else, each one `realpath`ed: a granted folder never
 * holds a link (a link inside a granted path is the permission model's
 * documented hole), and a pnpm install's symlinked `node_modules` are never
 * granted. The runner resolves every bare import itself, from this map, to
 * the real folder (`runner.ts`), so Node never has to look through a link.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type ComposeKind = 'docx' | 'pptx';

/** The one library each kind is written against. */
export const COMPOSE_LIBRARY: Readonly<Record<ComposeKind, string>> = { docx: 'docx', pptx: 'pptxgenjs' };

/** Where every allowed package and its dependencies are, as the runner reads it. */
export interface LibraryClosure {
  /** Each library a program may import, by name: its real folder. */
  top: Record<string, string>;
  /** Each package folder in the closure: its dependencies' real folders, by name. */
  deps: Record<string, Record<string, string>>;
  /** Every folder the child may read (the closure, deduplicated). */
  grants: string[];
  /** Each library's version, as its package.json says. */
  versions: Record<string, string>;
}

/** The real folder of package `name`, looked up from `from` the way Node does (each `node_modules` above). */
function findPackage(name: string, from: string): string | null {
  let dir = from;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function readManifest(dir: string): { name?: string; version?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

let cached: LibraryClosure | null = null;

/**
 * The closure of `docx` and `pptxgenjs` as installed beside this package.
 * Type-only packages (`@types/*`) are skipped; a dependency that is not
 * installed (an optional one) is left out.
 */
export function libraryClosure(): LibraryClosure {
  if (cached) return cached;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const top: Record<string, string> = {};
  const deps: Record<string, Record<string, string>> = {};
  const versions: Record<string, string> = {};
  const walk = (dir: string): void => {
    if (deps[dir]) return;
    const manifest = readManifest(dir);
    const own: Record<string, string> = {};
    deps[dir] = own;
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
      if (name.startsWith('@types/')) continue;
      const found = findPackage(name, dir);
      if (!found) continue;
      own[name] = found;
      walk(found);
    }
  };
  for (const name of Object.values(COMPOSE_LIBRARY)) {
    const dir = findPackage(name, here);
    if (!dir) throw new Error(`the ${name} library is not installed beside buddi`);
    top[name] = dir;
    versions[name] = String(readManifest(dir).version ?? '');
    walk(dir);
  }
  cached = { top, deps, versions, grants: [...new Set(Object.keys(deps))].sort() };
  return cached;
}
