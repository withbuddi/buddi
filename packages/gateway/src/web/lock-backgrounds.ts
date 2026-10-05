/**
 * The pictures the dashboard ships for the lock screen beside Earth, as the
 * gateway knows them: the ids in `backgrounds/manifest.json`, read from the
 * built UI (Vite copies `packages/web/public` into it) or, in a checkout
 * without a build, from the web package's own `public/`. A pick is checked
 * against these; a stored one the manifest no longer lists reads as Earth.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { LOCK_PICTURE_ID } from '@buddi/core';
import { REPO_ROOT } from '../agents/catalog.js';

export const LOCK_PICTURES_MANIFEST = path.join('backgrounds', 'manifest.json');

/**
 * The manifest's ids, made sound: an entry needs an id (lower-case words
 * joined by hyphens), a title, a credit, and a landscape or a portrait file.
 * Anything else is left out, never guessed at.
 */
export function lockPictureIds(manifest: unknown): string[] {
  const pictures = (manifest as { pictures?: unknown } | null)?.pictures;
  if (!Array.isArray(pictures)) return [];
  const ids: string[] = [];
  for (const entry of pictures) {
    if (!entry || typeof entry !== 'object') continue;
    const p = entry as Record<string, unknown>;
    const file = (v: unknown): boolean => typeof v === 'string' && /^[\w.-]+\.jpg$/.test(v);
    if (typeof p.id !== 'string' || p.id.length > 64 || !LOCK_PICTURE_ID.test(p.id) || ids.includes(p.id)) continue;
    if (typeof p.title !== 'string' || p.title.trim() === '' || typeof p.credit !== 'string' || p.credit.trim() === '') continue;
    if (!file(p.landscape) && !file(p.portrait)) continue;
    if ((p.landscape !== undefined && !file(p.landscape)) || (p.portrait !== undefined && !file(p.portrait))) continue;
    ids.push(p.id);
  }
  return ids;
}

/** Read once per directory: the manifest changes with a release, and a release restarts the gateway. */
const read = new Map<string, ReadonlySet<string>>();

export function lockPicturesFrom(assetsDir: string): ReadonlySet<string> {
  const known = read.get(assetsDir);
  if (known) return known;
  let ids: string[] = [];
  for (const file of [path.join(assetsDir, LOCK_PICTURES_MANIFEST), path.join(REPO_ROOT, 'packages', 'web', 'public', LOCK_PICTURES_MANIFEST)]) {
    try {
      ids = lockPictureIds(JSON.parse(readFileSync(file, 'utf8')));
      break;
    } catch {
      /* not there, or not JSON: the next place */
    }
  }
  const set = new Set(ids);
  read.set(assetsDir, set);
  return set;
}
