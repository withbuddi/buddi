/**
 * `buddi backup list` and `buddi backup prune`.
 *
 * Both read only the directory listing — never an archive's contents — so they
 * stay instant with a hundred backups in the folder, and a corrupt archive does
 * not stop the owner from seeing what they have.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { envelopePath } from './crypt.js';
import {
  PRE_RESTORE_PREFIX,
  archiveTime,
  isArchiveName,
  isEncryptedArchiveName,
  selectForPrune,
  type ArchiveEntry,
} from './manifest.js';

export interface ListedArchive extends ArchiveEntry {
  file: string;
  /** True for the `.age` form, which is listed exactly like the plain one. */
  encrypted: boolean;
}

/** Every buddi archive in `dir`, newest first. */
export async function listArchives(dir: string): Promise<ListedArchive[]> {
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir)).filter(isArchiveName);
  const out: ListedArchive[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const info = await stat(file).catch(() => null);
    if (!info) continue;
    // The name's stamp is the backup's own idea of when it ran; mtime is a
    // fallback for a file someone copied around.
    const named = archiveTime(name);
    out.push({
      name,
      file,
      bytes: info.size,
      at: named ? named.getTime() : info.mtimeMs,
      encrypted: isEncryptedArchiveName(name),
    });
  }
  return out.sort((a, b) => b.at - a.at || b.name.localeCompare(a.name));
}

export interface PruneResult {
  kept: ListedArchive[];
  removed: ListedArchive[];
  freedBytes: number;
}

export async function pruneArchives(
  keep: number,
  dir: string,
): Promise<PruneResult> {
  // `pre-restore-…` archives are the copy taken of an installation immediately
  // before it was overwritten. They are not part of the rotation and are never
  // pruned: the one moment they matter is the one where the restore went wrong
  // and nobody is counting how many backups they have.
  const archives = (await listArchives(dir)).filter((a) => !a.name.startsWith(PRE_RESTORE_PREFIX));
  const selection = selectForPrune(archives, keep);
  const byName = new Map(archives.map((a) => [a.name, a]));
  const removed: ListedArchive[] = [];
  for (const entry of selection.remove) {
    const listed = byName.get(entry.name);
    if (!listed) continue;
    await rm(listed.file, { force: true });
    // The envelope is part of the archive, not a file of its own: leaving it
    // behind would leave the directory full of `.json` files describing
    // ciphertext nobody has.
    if (listed.encrypted) await rm(envelopePath(listed.file), { force: true });
    removed.push(listed);
  }
  return {
    kept: selection.keep.flatMap((e) => {
      const listed = byName.get(e.name);
      return listed ? [listed] : [];
    }),
    removed,
    freedBytes: removed.reduce((sum, r) => sum + r.bytes, 0),
  };
}
