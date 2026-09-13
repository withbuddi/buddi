#!/usr/bin/env node
/**
 * Dependency-direction check (ARCHITECTURE.md principle 6):
 * core never imports a tool or an upper layer. Tools import core, not the reverse.
 *
 * Lightweight on purpose — no ESLint. Scans packages/core sources (and its
 * package.json dependencies) for forbidden @buddi/* references.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreDir = path.join(repoRoot, 'packages', 'core');

const FORBIDDEN = [/^@buddi\/runtime$/, /^@buddi\/gateway$/, /^@buddi\/tool-.+$/];
const SPECIFIER = /(?:from\s*|import\s*|require\s*\(\s*)['"]([^'"]+)['"]/g;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage']);

function forbidden(spec) {
  return FORBIDDEN.some((re) => re.test(spec));
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(e.name)) yield full;
  }
}

const violations = [];

for await (const file of walk(coreDir)) {
  const src = await readFile(file, 'utf8');
  const lines = src.split('\n');
  for (const [i, line] of lines.entries()) {
    SPECIFIER.lastIndex = 0;
    let m;
    while ((m = SPECIFIER.exec(line))) {
      if (forbidden(m[1])) {
        violations.push(`${path.relative(repoRoot, file)}:${i + 1} imports ${m[1]}`);
      }
    }
  }
}

try {
  const pkg = JSON.parse(await readFile(path.join(coreDir, 'package.json'), 'utf8'));
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (forbidden(dep)) {
        violations.push(`packages/core/package.json: ${field} declares ${dep}`);
      }
    }
  }
} catch (err) {
  console.error(`check-boundaries: cannot read packages/core/package.json: ${err.message}`);
  process.exit(1);
}

if (violations.length > 0) {
  console.error('Boundary violations (core must never import runtime/gateway/tools):');
  for (const v of violations) console.error(`  - ${v}`);
  process.exit(1);
}

console.log('check-boundaries: ok (core imports no runtime/gateway/tool package)');
