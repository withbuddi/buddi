/**
 * The library links the per-platform Postgres package only describes.
 *
 * `@embedded-postgres/<platform>` ships its shared libraries as real files and
 * lists the version links between them (`libicuuc.77.dylib ->
 * libicuuc.77.1.dylib`, `libpq.so.5 -> libpq.so.5.18`) in
 * `native/pg-symlinks.json`; its postinstall script creates them. npm with
 * scripts off, or npm 11 holding back scripts not in `allowScripts`, never
 * runs it, and Postgres then dies in the dynamic loader. This creates them.
 *
 * A leaf module on purpose: node builtins only, no path constants, no side
 * effects, so `@buddi/install`'s upgrade code may import it as a value before
 * `environment()` has rewritten the environment (see `upgrade.ts`), exactly as
 * it imports `@buddi/core/semver`. Pure fs: no child processes, no network.
 */
import { lstat, readFile, readlink, stat, symlink, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Create every missing link `pg-symlinks.json` names, relative to the link's
 * own directory, and return the links created (relative to `dir`).
 *
 * `dir` is either the package directory (manifest at `native/pg-symlinks.json`)
 * or a copy of its `native/` tree (manifest at `pg-symlinks.json`); manifest
 * paths are read relative to the directory that holds the manifest. An
 * existing file is never touched, nor is a link that already points where it
 * should. A link pointing elsewhere is replaced only when it is broken or
 * leaves `dir` — the second is what an older copy made with `fs.cp` left
 * behind: absolute links into the global npm tree, which break the moment npm
 * replaces that tree. No manifest means nothing to do.
 */
export async function hydratePostgresLinks(dir: string): Promise<string[]> {
  let base: string | undefined;
  let text: string | undefined;
  for (const candidate of [path.join(dir, 'native'), dir]) {
    text = await readFile(path.join(candidate, 'pg-symlinks.json'), 'utf8').catch(() => undefined);
    if (text !== undefined) { base = candidate; break; }
  }
  if (base === undefined || text === undefined) return [];
  let entries: unknown;
  try { entries = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(entries)) return [];
  const root = path.resolve(base);
  const inside = (file: string): boolean => file.startsWith(root + path.sep);
  // Upstream writes `native/lib/x`; a copy of `native/` drops that prefix.
  const rebase = (value: string): string | undefined => {
    const normalized = value.replaceAll('\\', '/');
    const suffix = normalized.includes('/native/') ? normalized.split('/native/').pop() as string : normalized.replace(/^native\//, '');
    const resolved = path.resolve(root, suffix);
    return inside(resolved) ? resolved : undefined;
  };
  const created: string[] = [];
  for (const entry of entries as { source?: unknown; target?: unknown }[]) {
    if (typeof entry?.source !== 'string' || typeof entry.target !== 'string') continue;
    // Upstream's source is the file; target is the link to create.
    const file = rebase(entry.source), link = rebase(entry.target);
    if (file === undefined || link === undefined || file === link) continue;
    // A link to nothing would only trade one loader error for another.
    if (!await stat(file).then(() => true, () => false)) continue;
    const wanted = path.relative(path.dirname(link), file);
    const existing = await lstat(link).catch(() => undefined);
    if (existing !== undefined) {
      if (!existing.isSymbolicLink()) continue;
      const current = await readlink(link);
      if (current === wanted) continue;
      const resolved = path.resolve(path.dirname(link), current);
      const broken = !await stat(link).then(() => true, () => false);
      if (!broken && inside(resolved)) continue;
      await unlink(link);
    }
    try { await symlink(wanted, link); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; continue; }
    created.push(path.relative(dir, link));
  }
  return created;
}
