/*
 * Builds `dist/`, which is the folder the owner loads unpacked and the folder
 * the release tarball ships under `extension/`.
 *
 * esbuild rather than the workspace's `tsc`, because Chrome wants three
 * separate bundles with three different shapes (an ES module worker, a classic
 * script for the page, an ES module for the popup) and no `node_modules`
 * resolution at runtime. Types are still checked: `pnpm typecheck` runs `tsc`
 * over the same sources with `noEmit`.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { SIZES, icon } from './icons.mjs';
import { stampManifest } from './version.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

/** Everything `manifest.json` names, so the manifest test has one list to check against. */
export const BUNDLES = [
  { entry: 'src/background.ts', out: 'background.js', format: 'esm' },
  { entry: 'src/content.ts', out: 'content.js', format: 'iife' },
  { entry: 'src/popup.ts', out: 'popup.js', format: 'esm' },
];
/*
 * The popup's own files. The fonts and the Blob are copied in rather than
 * fetched: an extension page loads nothing remote (Manifest V3's CSP forbids
 * it, and the store asks), so DM Sans, DM Mono and the mascot travel with it.
 */
export const STATIC = [
  'manifest.json', 'popup.html', 'popup.css', 'blob.png',
  'fonts/dm-sans-latin-standard-normal.woff2', 'fonts/dm-sans-latin-ext-standard-normal.woff2',
  'fonts/dm-mono-latin-400-normal.woff2', 'fonts/dm-mono-latin-500-normal.woff2',
];

/**
 * The buddi version this build carries: the release's when one is being cut
 * (`BUDDI_RELEASE_VERSION`, as `scripts/release/build.mjs` reads it), else the
 * root package's.
 */
export async function buddiVersion() {
  const named = (process.env.BUDDI_RELEASE_VERSION ?? '').trim();
  if (named) return named;
  return JSON.parse(await readFile(path.join(root, '..', '..', 'package.json'), 'utf8')).version;
}

export async function buildExtension({ clean = true } = {}) {
  if (clean) await rm(dist, { recursive: true, force: true });
  await mkdir(path.join(dist, 'icons'), { recursive: true });
  await mkdir(path.join(dist, 'fonts'), { recursive: true });

  for (const bundle of BUNDLES) {
    await build({
      entryPoints: [path.join(root, bundle.entry)],
      outfile: path.join(dist, bundle.out),
      bundle: true, format: bundle.format, target: 'chrome116', platform: 'browser',
      // A release is read by whoever loads it unpacked; there is nothing to hide.
      minify: false, sourcemap: false, legalComments: 'none',
    });
  }

  for (const asset of STATIC) await cp(path.join(root, 'static', asset), path.join(dist, asset));
  for (const size of SIZES) await writeFile(path.join(dist, 'icons', `${size}.png`), icon(size));

  // The manifest's version is buddi's, in the four integers Chrome accepts
  // (`version.mjs`): one number for the popup, the hello frame and the tarball.
  // This is the unpacked build, so it keeps its `key`; the store zip drops it.
  const manifest = stampManifest(JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8')), await buddiVersion());
  await writeFile(path.join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dist;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildExtension();
  console.log(`Extension: ${dist}`);
}
