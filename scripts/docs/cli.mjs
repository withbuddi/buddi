#!/usr/bin/env node
/**
 * Render docs/cli.md from the command table (packages/cli/src/commands.ts).
 *
 * Reads the built table, so run it after `pnpm -r build` (or `pnpm docs:cli`,
 * which builds the cli package first). The `updated` date moves only when the
 * page's text does, so running it twice changes nothing.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { COMMANDS, renderReference } = await import(
  path.join(root, 'packages', 'cli', 'dist', 'commands.js')
);

const file = path.join(root, 'docs', 'cli.md');
const body = renderReference(COMMANDS);

/** The page without its frontmatter, and the frontmatter's `updated`. */
function split(text) {
  const match = /^---\n([\s\S]*?)\n---\n\n?/.exec(text);
  if (!match) return { updated: undefined, body: text };
  const updated = /^updated:\s*(.+)$/m.exec(match[1])?.[1]?.trim();
  return { updated, body: text.slice(match[0].length) };
}

const previous = existsSync(file) ? split(readFileSync(file, 'utf8')) : undefined;
const now = new Date();
const today = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, '0')).join('-');
const updated = previous && previous.body === body && previous.updated ? previous.updated : today;

const page = [
  '---',
  'title: "The buddi command line"',
  'status: reference',
  `updated: ${updated}`,
  '---',
  '',
  body,
].join('\n');

if (previous && previous.body === body) {
  console.log('docs/cli.md is up to date.');
} else {
  writeFileSync(file, page);
  console.log('Wrote docs/cli.md.');
}
