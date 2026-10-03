/*
 * The native computer helper in the release tarball.
 *
 * `@buddi/tool-browser` spawns `dist/native/buddi-computer` (see
 * `packages/tools/browser/src/computer.ts`, COMPUTER_HELPER). It is built on
 * macOS only, by `packages/tools/browser/scripts/build-native.mjs`; the
 * release workflow builds it as a universal binary in a macOS job and drops it
 * into the Linux publish job's checkout before `pnpm release:pack`. A release
 * sets BUDDI_RELEASE_REQUIRE_NATIVE=1 so a tarball without it fails; a local
 * pack on Linux (the Docker trial) simply ships without it, and the dashboard
 * says "Use my apps" is macOS-only there anyway.
 */
import { chmod, stat } from 'node:fs/promises';
import path from 'node:path';

/** Where the helper sits inside the browser package. */
export const HELPER_IN_PACKAGE = 'dist/native/buddi-computer';
/** In the staged workspace, before `npm install` copies it into node_modules. */
export const STAGED_HELPER = `packages/tools/browser/${HELPER_IN_PACKAGE}`;
/** Where the installed runtime looks for it: the bundled copy. */
export const INSTALLED_HELPER = `node_modules/@buddi/tool-browser/${HELPER_IN_PACKAGE}`;

/**
 * Make sure the staged helper is there (when required) and executable: a
 * GitHub artifact download drops the mode bits, and npm packs a file as 0755
 * only when some execute bit is set.
 * @param {string} stage
 * @param {{ require: boolean }} options
 * @returns {Promise<boolean>} whether the helper ships
 */
export async function stageNativeHelper(stage, { require }) {
  const file = path.join(stage, STAGED_HELPER);
  try {
    if (!(await stat(file)).isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (require) throw new Error(`${STAGED_HELPER} is missing: a release ships the macOS computer helper. Build it on macOS (node packages/tools/browser/scripts/build-native.mjs --universal) or download the release workflow's native artifact into the checkout first.`);
    return false;
  }
  await chmod(file, 0o755);
  return true;
}

/**
 * Does `npm pack --json`'s file list carry the helper where the runtime looks?
 * @param {Array<{ path: string, mode?: number }>} files
 */
export function helperInPack(files) {
  const entry = files.find((f) => f.path === INSTALLED_HELPER);
  return entry !== undefined && (entry.mode === undefined || (entry.mode & 0o111) !== 0);
}
