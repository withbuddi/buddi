/**
 * The mascots the dashboard ships, as an accepted agent's first picture.
 *
 * A plugin's proposal may name one (`SuggestedAgent.avatar`). The files are the
 * web package's own (`packages/web/public/mascot/`, copied into the built
 * `dist/mascot/` the gateway serves); buddi-design is where they are drawn.
 * They are read from where the static assets are served first, then from the
 * source tree, so a gateway run before the UI is built still finds them.
 *
 * The picture goes through the same store and the same re-encoding as the
 * owner's own upload (`avatars.ts`, `avatar-image.ts`), so it is a picture the
 * owner can replace or remove like any other.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BUNDLED_MASCOTS, type BundledMascot, type Queryable } from '@buddi/core';
import { normaliseAvatar } from './avatar-image.js';
import { writeAvatar } from './avatars.js';
import { REPO_ROOT } from './catalog.js';

/** Where the mascot files may be, in the order they are tried. */
export function mascotDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const assets = (env.BUDDI_WEB_ASSETS ?? '').trim();
  return [
    path.join(assets !== '' ? assets : path.join(REPO_ROOT, 'packages', 'web', 'dist'), 'mascot'),
    path.join(REPO_ROOT, 'packages', 'web', 'public', 'mascot'),
  ];
}

export function isBundledMascot(name: unknown): name is BundledMascot {
  return typeof name === 'string' && (BUNDLED_MASCOTS as readonly string[]).includes(name);
}

/** The bytes of one shipped mascot, or null when none of the places has it. */
export function readBundledMascot(name: BundledMascot, dirs: readonly string[] = mascotDirs()): Buffer | null {
  for (const dir of dirs) {
    try {
      return readFileSync(path.join(dir, `${name}.png`));
    } catch {
      // Not here; the next place.
    }
  }
  return null;
}

/**
 * Keep a shipped mascot as an agent's picture. True when it was stored. Never
 * throws: an agent without its face is still the agent the owner approved.
 */
export async function storeBundledMascot(
  db: Queryable,
  agentId: string,
  name: unknown,
  dirs?: readonly string[],
): Promise<boolean> {
  if (!isBundledMascot(name)) return false;
  const bytes = readBundledMascot(name, dirs);
  if (!bytes) return false;
  try {
    await writeAvatar(db, agentId, await normaliseAvatar(bytes, 'image/png'));
    return true;
  } catch {
    return false;
  }
}
