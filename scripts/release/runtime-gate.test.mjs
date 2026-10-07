import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { check, parseVersion, PIN_FILE, RECIPE_FILE, satisfies } from './runtime-gate.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = fileURLToPath(new URL('./runtime-gate.mjs', import.meta.url));

describe('satisfies', () => {
  test.each([
    ['22.23.3', '>=22', true],
    ['22.23.3', '>=22.24', false],
    ['22.23.3', '>=22.23.3', true],
    ['22.23.3', '>22.23.3', false],
    ['22.23.3', '>22', false],
    ['22.23.3', '^22.6.0', true],
    ['22.23.3', '^24', false],
    ['22.23.3', '~22.23.0', true],
    ['22.23.3', '~22.22', false],
    ['22.23.3', '22.x', true],
    ['22.23.3', '22', true],
    ['22.23.3', '*', true],
    ['22.23.3', '>=20 <22', false],
    ['22.23.3', '>= 20 < 23', true],
    ['22.23.3', '<=22', true],
    ['22.23.3', '<=22.22', false],
    ['22.23.3', '^20.19 || ^22.12 || >=24', true],
    ['22.11.0', '^20.19 || ^22.12 || >=24', false],
    ['22.23.3', '20 - 22', true],
    ['22.23.3', '20 - 22.20', false],
    ['0.0.5', '^0.0.3', false],
    ['0.1.9', '^0.1.2', true],
  ])('%s against "%s" is %s', (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  test('a range it cannot read throws rather than passing', () => {
    expect(() => satisfies('22.23.3', '>=22.0.0-rc.1')).toThrow(/cannot read/);
    expect(() => satisfies('22.23.3', 'latest')).toThrow(/cannot read/);
    expect(() => satisfies('22.23.3', '')).toThrow(/not a range/);
  });

  test('the pin must be exact', () => {
    expect(parseVersion('v22.23.3')).toEqual([22, 23, 3]);
    expect(() => parseVersion('22')).toThrow(/exact/);
  });
});

describe('check', () => {
  const dirs = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  /** A tree with the real pin and recipe, a root manifest, and one package. */
  function tree({ root = { engines: { node: '>=22' } }, pkg = {}, pin, recipe } = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'runtime-gate-'));
    dirs.push(dir);
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify(root));
    mkdirSync(path.join(dir, 'packages/cli'), { recursive: true });
    writeFileSync(path.join(dir, 'packages/cli/package.json'), JSON.stringify(pkg));
    mkdirSync(path.join(dir, 'apps/mac/scripts'), { recursive: true });
    if (pin === undefined) cpSync(path.join(repo, PIN_FILE), path.join(dir, PIN_FILE));
    else if (pin !== null) writeFileSync(path.join(dir, PIN_FILE), pin);
    const real = readFileSync(path.join(repo, RECIPE_FILE), 'utf8');
    writeFileSync(path.join(dir, RECIPE_FILE), recipe ? recipe(real) : real);
    return dir;
  }

  test('the tree as it is passes', () => {
    const result = check(repo);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test('a package needing a newer Node than the pin fails, naming both', () => {
    const result = check(tree({ pin: '22.23.3\n', pkg: { engines: { node: '>=24' } } }));
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/packages\/cli\/package.json: engines.node ">=24" excludes Node 22.23.3/);
  });

  test('the root engines is required: the published manifest takes it', () => {
    const result = check(tree({ root: {} }));
    expect(result.errors.join('\n')).toMatch(/package.json declares no engines.node/);
  });

  test('a missing or loose pin fails', () => {
    expect(check(tree({ pin: null })).errors.join('\n')).toMatch(/NODE_VERSION is missing/);
    expect(check(tree({ pin: '22\n' })).errors.join('\n')).toMatch(/exact Node version/);
  });

  test('a recipe that drops npm fails', () => {
    const noCopy = check(tree({ recipe: s => s.replace(/^cp -R .*node_modules\/npm.*$/m, '') }));
    expect(noCopy.errors.join('\n')).toMatch(/node without npm/);
    const noLink = check(tree({ recipe: s => s.replace(/^ln -s lib\/node_modules\/npm\/bin\/npm-cli\.js.*$/m, '# ln -s lib/node_modules/npm/bin/npm-cli.js "$PAYLOAD/runtime/npm"') }));
    expect(noLink.errors.join('\n')).toMatch(/no longer links runtime\/npm/);
  });

  test('a recipe that ignores the pin fails', () => {
    const result = check(tree({ recipe: s => s.replace(/NODE_VERSION/g, 'NODE_RELEASE') }));
    expect(result.errors.join('\n')).toMatch(/does not read the pinned version/);
  });

  test('the command exits 1 on a problem and prints it', () => {
    const dir = tree({ pkg: { engines: { node: '>=99' } } });
    let out = '';
    let status = 0;
    try { execFileSync(process.execPath, [script, dir], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: '' } }); }
    catch (error) { status = error.status; out = error.stdout; }
    expect(status).toBe(1);
    expect(out).toMatch(/error: packages\/cli\/package.json: engines.node ">=99" excludes/);
  });
});
