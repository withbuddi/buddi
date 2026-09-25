#!/usr/bin/env node
/**
 * CHANGELOG.md, read and cut by the release.
 *
 *   node scripts/release/changelog.mjs section <version>   the section's body (`unreleased` for Unreleased)
 *   node scripts/release/changelog.mjs cut <version>       Unreleased becomes `## <version> — <date>`
 *
 * A section's body is its `###` headings and their list items. It stops at the
 * next `##` heading or at the first plain paragraph, which is how the line
 * about older releases at the bottom of the file stays out of every section.
 * `build.mjs` imports `sectionOf` so the tarball and the GitHub release carry
 * the same notes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CHANGELOG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../CHANGELOG.md');

const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** A refusal the command prints as it is, and the build fails with. */
export class ChangelogError extends Error {}

/** What a `## ` heading names: `unreleased` or a version. */
function headingName(line) {
  const text = line.slice(3).trim().replace(/^\[([^\]]*)\]/, '$1');
  return (text.split(/\s+/)[0] ?? '').toLowerCase();
}

function label(version) {
  return version.toLowerCase() === 'unreleased' ? 'Unreleased' : version;
}

/** The `## ` heading of a version, and where its body ends. Undefined when absent. */
function locate(lines, version) {
  const wanted = version.toLowerCase();
  const start = lines.findIndex(line => line.startsWith('## ') && headingName(line) === wanted);
  if (start === -1) return undefined;
  let end = start + 1;
  let inList = false;
  for (; end < lines.length; end++) {
    const line = lines[end];
    if (line.startsWith('## ')) break;
    if (line.trim() === '') continue;
    if (line.startsWith('### ')) { inList = false; continue; }
    if (/^[-*] /.test(line)) { inList = true; continue; }
    // A wrapped entry, indented under its bullet.
    if (inList && /^\s+\S/.test(line)) continue;
    break;
  }
  // Blank lines at the end belong to nobody.
  while (end > start + 1 && lines[end - 1].trim() === '') end--;
  return { start, end };
}

/** The markdown body of a version's section, without its `##` heading. Throws when missing or empty. */
export function sectionOf(text, version) {
  const lines = text.split(/\r?\n/);
  const found = locate(lines, version);
  if (found === undefined) throw new ChangelogError(`CHANGELOG.md has no section for ${label(version)}.`);
  const body = lines.slice(found.start + 1, found.end);
  if (!body.some(line => /^[-*] /.test(line))) throw new ChangelogError(`The ${label(version)} section of CHANGELOG.md has no entries.`);
  return body.join('\n').trim();
}

/** The whole file with Unreleased renamed to `<version> — <date>` and a fresh Unreleased above it. */
export function cutRelease(text, version, date) {
  if (!VERSION.test(version)) throw new ChangelogError(`"${version}" is not a version like 1.2.3.`);
  const lines = text.split(/\r?\n/);
  if (locate(lines, version) !== undefined) throw new ChangelogError(`CHANGELOG.md already has a section for ${version}.`);
  const found = locate(lines, 'unreleased');
  if (found === undefined) throw new ChangelogError('CHANGELOG.md has no Unreleased section.');
  sectionOf(text, 'unreleased');
  lines.splice(found.start, 1, '## Unreleased', '', `## ${version} — ${date}`);
  return lines.join('\n');
}

export function today(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

function main(argv) {
  const [command, version] = argv;
  if ((command !== 'section' && command !== 'cut') || version === undefined || version === '') {
    console.error('Usage: changelog.mjs section <version|unreleased> | cut <version>');
    return 2;
  }
  const file = process.env.BUDDI_CHANGELOG?.trim() || CHANGELOG;
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch { console.error(`There is no changelog at ${file}.`); return 1; }
  try {
    if (command === 'section') {
      process.stdout.write(`${sectionOf(text, version)}\n`);
    } else {
      writeFileSync(file, cutRelease(text, version, today()));
      console.log(`CHANGELOG.md: Unreleased is now ${version}.`);
    }
    return 0;
  } catch (error) {
    if (!(error instanceof ChangelogError)) throw error;
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
