/**
 * What is actually on disk, checked before anything trusts it.
 *
 * A staged package is an archive a stranger wrote, unpacked inside the owner's
 * data directory. Two things about that are dangerous before a single line of
 * it has run, and both are answered here rather than in the code that unpacks:
 *
 *  - **a symlink is a hole in the staging directory.** A tarball member called
 *    `node_modules/@buddi` pointing at `/usr/local/lib` turns the peer link
 *    that follows it into a write outside the stage, and the `rmSync` that
 *    clears an old link into a delete outside it. So the tree is walked with
 *    `lstat` and a link is a refusal, not a skipped entry.
 *  - **a hash that skips what it cannot read proves nothing.** The tree hash
 *    below covers every regular file *and* the target of every link it is
 *    willing to tolerate (inside `node_modules`, where npm writes `.bin`
 *    shims), so a tree that changes cannot hash the same.
 *
 * Both walkers share one rule: every path is resolved and has to stay under
 * the root. A `..` member that survived tar, or a directory that is really
 * somewhere else, is refused by containment rather than by pattern matching on
 * names.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export class TreeRefusal extends Error {
  override readonly name = 'TreeRefusal';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Names never walked into: they are not the package, and one is enormous. */
const NEVER = new Set(['.git']);

/**
 * The peer link staging writes itself.
 *
 * It points at the core this gateway is running, which is deliberately outside
 * the staged tree, so it is the one link that is neither refused nor hashed.
 */
export const CORE_PEER_LINK = 'node_modules/@buddi/core';

export interface TreeOptions {
  /** Walk `node_modules` too. False is "the package's own files". */
  includeModules?: boolean;
  /**
   * Where a symlink is tolerated instead of refused. npm writes `.bin` shims
   * and, inside a workspace, links between packages; the package's own files
   * never legitimately contain one.
   */
  linksAllowedUnder?: string;
}

interface Visited {
  relative: string;
  full: string;
  kind: 'file' | 'link';
  /** The link's target, verbatim, for a tolerated link. */
  target?: string;
}

function refuse(code: string, message: string): never {
  throw new TreeRefusal(code, message);
}

/**
 * Walk a package tree, refusing anything that is not a file or a directory.
 *
 * The entries come back sorted by path, so two identical trees on two machines
 * produce the same sequence and therefore the same hash.
 */
export function walkTree(root: string, opts: TreeOptions = {}): Visited[] {
  const realRoot = realpathSync(root);
  /** Where this path really is, once every link in it has been followed. */
  const inside = (full: string): boolean => {
    let resolved: string;
    try {
      resolved = realpathSync(full);
    } catch {
      return false;
    }
    return resolved === realRoot || resolved.startsWith(`${realRoot}${path.sep}`);
  };
  const found: Visited[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (NEVER.has(entry.name)) continue;
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (relative === CORE_PEER_LINK) continue;
      if (!opts.includeModules && relative === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const allowed =
          opts.linksAllowedUnder !== undefined &&
          (relative === opts.linksAllowedUnder || relative.startsWith(`${opts.linksAllowedUnder}/`));
        if (!allowed) {
          refuse(
            'symlink',
            `${relative} is a symbolic link. A package buddi unpacks is files and directories only: a ` +
              'link is a way out of the directory it was unpacked into, and this one is refused before ' +
              'anything follows it.',
          );
        }
        found.push({ relative, full, kind: 'link', target: readlinkSync(full) });
        continue;
      }
      if (entry.isDirectory()) {
        if (!inside(full)) {
          refuse('escapes', `${relative} resolves outside the package directory`);
        }
        walk(full, relative);
        continue;
      }
      if (!entry.isFile()) {
        refuse(
          'not-a-regular-file',
          `${relative} is neither a file nor a directory (a device, a socket or a fifo). A package is ` +
            'files; anything else arrived for a reason nobody can explain.',
        );
      }
      if (!inside(full)) refuse('escapes', `${relative} resolves outside the package directory`);
      found.push({ relative, full, kind: 'file' });
    }
  };
  walk(root, '');
  return found.sort((a, b) => (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
}

/**
 * Refuse a freshly extracted tree that contains anything but files and
 * directories. Called before the peer link is written and before npm runs, so
 * that neither of them ever follows a link somebody else chose.
 */
export function assertRegularTree(root: string): void {
  walkTree(root, { includeModules: true });
}

/**
 * `sha256-<hex>` over a tree: every path, every byte, and every tolerated
 * link's target.
 *
 * The path is hashed beside the content so that moving a file is a change, and
 * the entries are sorted so that two machines agree.
 */
export function treeHash(root: string, opts: TreeOptions = {}): string {
  const hash = createHash('sha256');
  for (const entry of walkTree(root, opts)) {
    hash.update(entry.kind);
    hash.update('\0');
    hash.update(entry.relative);
    hash.update('\0');
    if (entry.kind === 'link') hash.update(entry.target ?? '');
    else hash.update(readFileSync(entry.full));
    hash.update('\0');
  }
  return `sha256-${hash.digest('hex')}`;
}

/** Is this path a directory that exists? Cheap, and never throws. */
export function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
