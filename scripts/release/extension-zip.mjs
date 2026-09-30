#!/usr/bin/env node
/*
 * The Chrome Web Store upload for a release: `buddi-extension-<version>.zip`,
 * made from `packages/extension/dist` (build the workspace first).
 *
 * The store build differs from the unpacked folder the tarball ships in two
 * ways, both in `packages/extension/scripts/zip.mjs`: no `key` (the store
 * assigns the id) and the release's version, mapped to Chrome's four integers.
 *
 *   node scripts/release/extension-zip.mjs <version> [out-dir]
 *
 * `scripts/release/build.mjs` calls `writeExtensionZip` next to the tarball.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storeZip } from '../../packages/extension/scripts/zip.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const EXTENSION_DIST = path.join(root, 'packages/extension/dist');

/** Writes the zip into `outDir` and returns its path. */
export async function writeExtensionZip(version, outDir, dist = EXTENSION_DIST) {
  const file = path.join(outDir, `buddi-extension-${version}.zip`);
  await writeFile(file, await storeZip(dist, version));
  return file;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, outDir = process.cwd()] = process.argv.slice(2);
  if (!version) { console.error('usage: node scripts/release/extension-zip.mjs <version> [out-dir]'); process.exit(2); }
  console.log(`Extension zip: ${await writeExtensionZip(version, path.resolve(outDir))}`);
}
