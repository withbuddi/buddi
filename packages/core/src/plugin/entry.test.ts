/**
 * `@buddi/core/plugin` holds nothing with state or I/O
 * (docs/plugin-host-api.md §3).
 *
 * Walks every module the entry point loads at run time — type-only imports
 * and exports are erased, so they are skipped — and fails naming the file
 * that pulls in a package outside the short list below. A helper that needs
 * `pg` or the file system belongs on `ctx.buddi`, not here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as entry from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Bare specifiers a pure helper may use: an IP-literal check, a hash, a schema library. */
const ALLOWED = new Set(['node:net', 'node:crypto', 'zod']);

/** Value imports and re-exports of one module: `import type` and `export type` are erased. */
function runtimeSpecifiers(source: string): string[] {
  const found: string[] = [];
  const statement = /^(import|export)\s+(type\s+)?([^;]*?)\s+from\s+'([^']+)'/gms;
  for (const match of source.matchAll(statement)) {
    if (match[2] !== undefined) continue;
    found.push(match[4] as string);
  }
  for (const match of source.matchAll(/^import\s+'([^']+)'/gm)) found.push(match[1] as string);
  return found;
}

function walk(file: string, seen: Map<string, string[]>): void {
  if (seen.has(file)) return;
  const bare: string[] = [];
  seen.set(file, bare);
  for (const specifier of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
    if (specifier.startsWith('.')) {
      walk(path.resolve(path.dirname(file), specifier.replace(/\.js$/, '.ts')), seen);
    } else {
      bare.push(specifier);
    }
  }
}

describe('@buddi/core/plugin', () => {
  it('loads no package with state or I/O', () => {
    const seen = new Map<string, string[]>();
    walk(path.join(here, 'index.ts'), seen);
    const offending = [...seen]
      .flatMap(([file, bare]) => bare.filter((b) => !ALLOWED.has(b)).map((b) => `${path.relative(here, file)} imports ${b}`));
    expect(offending).toEqual([]);
  });

  it('exports the helpers the inventory names', () => {
    for (const name of ['localDateString', 'sha256Of', 'pageFile', 'QueryRefusal', 'parseViewDescriptors', 'checkUrl']) {
      expect(typeof (entry as Record<string, unknown>)[name], name).toBe('function');
    }
    expect(entry.HOST_API_VERSION).toBe('1.1');
  });
});
