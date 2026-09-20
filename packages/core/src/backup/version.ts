/**
 * Which buddi wrote an archive.
 *
 * `@buddi/core`'s own `package.json`, read from beside this module, and never
 * `git describe`: a packaged installation is not a git checkout, so the git
 * answer is "unknown" on every machine a backup actually has to be restored on.
 * The engine is in core precisely so that this is the version of the code that
 * dumped the data, whoever called it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** `dist/backup/version.js` at runtime, `src/backup/version.ts` under vitest. */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let cached: string | undefined;

export function buddiVersion(): string {
  if (cached !== undefined) return cached;
  try {
    const pkg = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      version?: string;
    };
    cached = pkg.version ?? '0.0.0';
  } catch {
    cached = 'unknown';
  }
  return cached;
}
