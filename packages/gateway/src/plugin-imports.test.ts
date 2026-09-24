/**
 * Every plugin reaches core through `ctx.buddi` and `@buddi/core/plugin`, and
 * nothing else (docs/specs/plugin-host-api.md §6).
 *
 * This is not a sandbox — a plugin runs in buddi's process and could import a
 * file by absolute path — it is what makes a reach past the host visible in
 * review. It walks every plugin's `src` under `packages/tools/*` (and the
 * example under `examples/plugins/*`) and fails,
 * naming the file, on:
 *
 *  - an import of `@buddi/core` other than `@buddi/core/plugin`, or
 *    `@buddi/core/testing` in a test;
 *  - an import of `@buddi/runtime`, `@buddi/gateway` or any `@buddi/tool-*`;
 *  - a relative import that leaves the plugin's own package;
 *  - a `core.` table named in a SQL string, outside tests. Until each plugin
 *    connects as its own Postgres role (§11, deferred), this is the scope
 *    rule for `ctx.buddi.db`.
 *
 * buddi-plugins runs the same check from its root `pnpm test`
 * (`scripts/check-plugin-imports.mjs`).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TOOLS = path.join(REPO, 'packages', 'tools');

/**
 * Tests that drive a built-in plugin through a part of buddi that lives above
 * core, and so cannot come from `@buddi/core/testing`: the real HTTP
 * transport (`@buddi/runtime`, which core may not import) and the real agent
 * loop. Tests only, never shipped; each is named, so a new one is a decision.
 */
const RUNTIME_IN_TESTS: Readonly<Record<string, string>> = {
  'packages/tools/web/src/fetch.test.ts': 'reads pages over the real transport and a fixture server',
  'packages/tools/web/src/tools.db.test.ts': 'runs the tools over the real transport',
  'packages/tools/web/src/providers.test.ts': 'checks the tool name and variable the runtime also reads',
  'packages/tools/browser/src/driver.integration.test.ts': 'runs the browser under the real agent loop',
};

const SOURCE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const TEST = /\.test\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...walk(full));
    else if (SOURCE.test(entry) && !entry.endsWith('.d.ts')) found.push(full);
  }
  return found;
}

/** The code, comments blanked: prose may mention `core.events`; code may not. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function specifiers(text: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\b(?:import|export)\s[^'"`;]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) for (const match of text.matchAll(pattern)) found.push(match[1]!);
  return found;
}

const SQL_WORD = /\b(select|insert|update|delete|from|join|into|table|returning)\b/i;
const CORE_TABLE = /(?<![\w@/.-])core\.([a-z_][a-z0-9_]*)\b/g;

/** Each `core.<table>` in a string or template literal that reads as SQL. */
function coreTables(text: string): string[] {
  const found: string[] = [];
  for (const literal of text.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g)) {
    const body = literal[0];
    if (!SQL_WORD.test(body)) continue;
    for (const table of body.matchAll(CORE_TABLE)) found.push(`core.${table[1]}`);
  }
  return found;
}

/** Why this import is not allowed here, or undefined. */
function importProblem(spec: string, from: { file: string; packageRoot: string; test: boolean }): string | undefined {
  if (spec === '@buddi/core/plugin') return undefined;
  if (from.test && (spec === '@buddi/core/testing' || spec.startsWith('@buddi/core/testing/'))) return undefined;
  if (spec === '@buddi/core' || spec.startsWith('@buddi/core/')) {
    return `imports ${spec}; a plugin reaches core through ctx.buddi and @buddi/core/plugin${from.test ? ' (and @buddi/core/testing in a test)' : ''}`;
  }
  if (/^@buddi\/(runtime|gateway)(\/|$)/.test(spec) || /^@buddi\/tool-/.test(spec)) {
    return `imports ${spec}, which is buddi's own code, not the plugin API`;
  }
  if (spec.startsWith('.')) {
    const target = path.resolve(path.dirname(from.file), spec);
    if (target !== from.packageRoot && !target.startsWith(from.packageRoot + path.sep)) {
      return `imports ${spec}, outside its own package`;
    }
  }
  return undefined;
}

/** Every violation in one plugin package, as `file: problem`. */
function pluginViolations(packageRoot: string, repoRoot: string, allowRuntime: Readonly<Record<string, string>> = {}): string[] {
  const src = path.join(packageRoot, 'src');
  let files: string[];
  try {
    files = walk(src);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const file of files) {
    const relative = path.relative(repoRoot, file).split(path.sep).join('/');
    const test = TEST.test(file);
    const text = code(readFileSync(file, 'utf8'));
    for (const spec of specifiers(text)) {
      if (test && allowRuntime[relative] !== undefined && /^@buddi\/runtime(\/|$)/.test(spec)) continue;
      const problem = importProblem(spec, { file, packageRoot, test });
      if (problem !== undefined) found.push(`${relative}: ${problem}`);
    }
    if (!test) {
      for (const table of coreTables(text)) {
        found.push(`${relative}: names ${table} in SQL; a plugin's queries stay in its own schema`);
      }
    }
  }
  return found;
}

const EXAMPLES = path.join(REPO, 'examples', 'plugins');
const PLUGINS = [TOOLS, EXAMPLES].flatMap((root) =>
  readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((dir) => statSync(dir).isDirectory()),
);

describe('a plugin reaches core through ctx.buddi alone', () => {
  it('finds the plugins it checks', () => {
    expect(PLUGINS.length).toBeGreaterThan(0);
  });

  for (const dir of PLUGINS) {
    it(`${path.basename(dir)} imports only @buddi/core/plugin and names no core table`, () => {
      expect(pluginViolations(dir, REPO, RUNTIME_IN_TESTS)).toEqual([]);
    });
  }

  it('each allowed runtime import is still there, so the list cannot outlive its reason', () => {
    for (const file of Object.keys(RUNTIME_IN_TESTS)) {
      expect(code(readFileSync(path.join(REPO, file), 'utf8')), file).toMatch(/['"]@buddi\/runtime['"]/);
    }
  });
});

describe('the check itself', () => {
  const fixture = path.join(TOOLS, 'fixture-plugin');
  const at = (name: string, test = false) => ({ file: path.join(fixture, 'src', name), packageRoot: fixture, test });

  it('refuses an import of createVault from core, naming it', () => {
    expect(importProblem('@buddi/core', at('index.ts'))).toMatch(/imports @buddi\/core;/);
    expect(importProblem('@buddi/core/testing', at('index.ts'))).toMatch(/imports @buddi\/core\/testing/);
    expect(importProblem('@buddi/core/plugin', at('index.ts'))).toBeUndefined();
    expect(importProblem('@buddi/core/testing', at('index.test.ts', true))).toBeUndefined();
  });

  it('refuses buddi\'s own packages and a way out of the package', () => {
    expect(importProblem('@buddi/runtime', at('index.ts'))).toBeDefined();
    expect(importProblem('@buddi/gateway', at('index.ts'))).toBeDefined();
    expect(importProblem('@buddi/tool-email', at('index.ts'))).toBeDefined();
    expect(importProblem('../../core/src/vault/index.js', at('index.ts'))).toMatch(/outside its own package/);
    expect(importProblem('./store.js', at('index.ts'))).toBeUndefined();
  });

  it('finds the import and the core table in source text', () => {
    const text = code(`
      import { createVault } from '@buddi/core';
      // select * from core.agents — prose, allowed
      const git = ['-c', 'core.hooksPath=/x'];
      const rows = await ctx.buddi.db.query(\`select kind from core.events where id = $1\`, [id]);
    `);
    expect(specifiers(text)).toEqual(['@buddi/core']);
    expect(coreTables(text)).toEqual(['core.events']);
  });
});
