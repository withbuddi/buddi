#!/usr/bin/env node
/**
 * buddi's version as buddi.app's CFBundleVersion.
 *
 * Sparkle compares CFBundleVersion, which has to be numbers and dots, and buddi
 * versions look like `0.1.0-pre.39`. The app shows the buddi version as it is
 * (CFBundleShortVersionString) and carries this as CFBundleVersion:
 *
 *   0.1.0-pre.39  →  0.1.0.39
 *   0.1.0         →  0.1.0.1000   (a final release sorts above every pre of it)
 *
 * Used by apps/mac/Makefile and the `mac-app` job in .github/workflows/release.yml;
 * `ReleaseVersion` in apps/mac/App/BundleLayout.swift is the same mapping.
 *
 *   node scripts/release/bundle-version.mjs 0.1.0-pre.39   # prints 0.1.0.39
 */
import { fileURLToPath } from 'node:url';

/** The fourth component a final release gets: above any `pre.N` (N < 1000). */
export const FINAL = 1000;

export function bundleVersion(version) {
  const text = String(version ?? '').trim().replace(/^v/, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-pre\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`"${text}" is not a buddi version like 0.1.0 or 0.1.0-pre.39.`);
  const [, major, minor, patch, pre] = match;
  for (const part of [major, minor, patch, pre]) {
    if (part !== undefined && String(Number(part)) !== part) throw new Error(`"${text}" has a leading zero.`);
  }
  if (pre !== undefined && (Number(pre) < 1 || Number(pre) >= FINAL)) throw new Error(`"${text}": pre-release numbers run from 1 to ${FINAL - 1}.`);
  return `${major}.${minor}.${patch}.${pre ?? FINAL}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    console.log(bundleVersion(process.argv[2]));
  } catch (error) {
    console.error(`bundle-version: ${error.message}`);
    process.exit(1);
  }
}
