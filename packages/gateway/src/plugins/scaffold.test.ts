/**
 * The scaffold, checked against the rules it exists to get right.
 *
 * Not "does it write eight files" — that is the least interesting thing about
 * it. What matters is that what it writes would *install*: the peer is a peer,
 * the `buddi` field ties the package name to the manifest name, the schema is a
 * Postgres identifier, the gated tool has a `describe`, and the `buddi.md` says
 * the same schema the manifest owns, so the first install shows no drift.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InstallRefusal } from './refusals.js';
import { assertScaffoldName, scaffoldFiles, schemaFor, writeScaffold } from './scaffold.js';
import { parseBuddiMd, driftBetween } from './claims.js';
import { isPluginSchemaName } from '@buddi/core';

const temporary: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'buddi-scaffold-'));
  temporary.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('the name', () => {
  it('accepts a plain lowercase name', () => {
    expect(assertScaffoldName('weather')).toBe('weather');
    expect(assertScaffoldName(' my-notes ')).toBe('my-notes');
  });

  it('refuses a scope, an uppercase letter, a dot and a path', () => {
    for (const bad of ['@you/weather', 'Weather', 'my.plugin', '../escape', '', '1weather']) {
      expect(() => assertScaffoldName(bad)).toThrow(InstallRefusal);
    }
  });

  it('folds a hyphen to an underscore for the schema, which must be an identifier', () => {
    expect(schemaFor('my-notes')).toBe('my_notes');
    expect(isPluginSchemaName(schemaFor('my-notes'))).toBe(true);
    expect(isPluginSchemaName(schemaFor('weather'))).toBe(true);
  });
});

describe('what it writes', () => {
  const files = scaffoldFiles({ name: 'my-notes', coreVersion: '0.2.3', coreDir: '/opt/buddi/core' });

  it('names every file the guide promises', () => {
    expect(Object.keys(files).sort()).toEqual(
      [
        '.gitignore',
        'LICENSE',
        'README.md',
        'pnpm-workspace.yaml',
        'buddi.md',
        'migrations/001_my_notes.sql',
        'package.json',
        'src/index.test.ts',
        'src/index.ts',
        'src/version.ts',
        'tsconfig.json',
      ].sort(),
    );
  });

  it('declares core as an optional peer, and links it for development where npm pack cannot see it', () => {
    const pkg = JSON.parse(files['package.json'] as string) as Record<string, any>;
    expect(pkg.peerDependencies['@buddi/core']).toBe('>=0.2.3');
    expect(pkg.peerDependenciesMeta['@buddi/core']).toEqual({ optional: true });
    expect(pkg.dependencies['@buddi/core']).toBeUndefined();
    expect(pkg.devDependencies['@buddi/core']).toBeUndefined();
    // Nothing npm pack ships names a link.
    expect(files['package.json']).not.toContain('link:');
    expect(files['pnpm-workspace.yaml']).toContain(`'@buddi/core': "link:/opt/buddi/core"`);
    expect(pkg.files).not.toContain('pnpm-workspace.yaml');
  });

  it('leaves the development link to fill in when there is no core on disk', () => {
    const bundled = scaffoldFiles({ name: 'weather', coreVersion: '0.1.0' });
    expect(bundled['pnpm-workspace.yaml']).toContain("#   '@buddi/core': 'link:");
    expect(bundled['pnpm-workspace.yaml']).not.toMatch(/^overrides:/m);
  });

  it('packs cleanly: builds first, and ships no build info or source maps', () => {
    const pkg = JSON.parse(files['package.json'] as string) as Record<string, any>;
    expect(pkg.scripts.prepack).toBe('tsc -p tsconfig.json');
    expect(pkg.files).toEqual(['dist', '!dist/**/*.map', '!dist/**/*.tsbuildinfo', 'migrations', 'buddi.md']);
  });

  it('carries a license: Apache-2.0 by default, or the one the author names', () => {
    const pkg = JSON.parse(files['package.json'] as string) as Record<string, any>;
    expect(pkg.license).toBe('Apache-2.0');
    expect(files.LICENSE).toContain('because no --license was given');
    const mit = scaffoldFiles({ name: 'weather', coreVersion: '0.1.0', license: 'MIT' });
    expect(JSON.parse(mit['package.json'] as string).license).toBe('MIT');
    expect(mit.LICENSE).toContain('Licensed under MIT');
    expect(() => scaffoldFiles({ name: 'weather', coreVersion: '0.1.0', license: 'MIT; rm -rf' })).toThrow(
      InstallRefusal,
    );
  });

  it('names the author in package.json and the manifest alike, or in neither', () => {
    const named = scaffoldFiles({ name: 'weather', coreVersion: '0.1.0', author: ' Ada "the" Lovelace ' });
    expect(JSON.parse(named['package.json'] as string).author).toEqual({ name: 'Ada "the" Lovelace' });
    expect(named['src/index.ts']).toContain('author: { name: "Ada \\"the\\" Lovelace" },');
    const nobody = scaffoldFiles({ name: 'weather', coreVersion: '0.1.0' });
    expect(JSON.parse(nobody['package.json'] as string).author).toBeUndefined();
    expect(nobody['src/index.ts']).not.toContain('author:');
    expect(() => scaffoldFiles({ name: 'weather', coreVersion: '0.1.0', author: 'x'.repeat(81) })).toThrow(/1 to 80/);
  });

  it('ties the published package name to the manifest name through the buddi field', () => {
    const pkg = JSON.parse(files['package.json'] as string) as Record<string, any>;
    expect(pkg.name).toBe('buddi-plugin-my-notes');
    expect(pkg.buddi.name).toBe('my-notes');
    expect(pkg.buddi.manifest).toBe('manifest');
    expect(pkg.keywords).toContain('buddi-plugin');
    // The two things an install reads off disk have to be shipped.
    expect(pkg.files).toContain('migrations');
    expect(pkg.files).toContain('buddi.md');
  });

  it('writes a manifest with one auto tool and one gated tool that describes itself', () => {
    const source = files['src/index.ts'] as string;
    expect(source).toContain("name: 'my-notes'");
    expect(source).toContain("schema: 'my_notes'");
    expect(source).toContain("tier: 'auto'");
    expect(source).toContain("tier: 'gated'");
    expect(source).toContain('async describe(');
    // A gated execute that cannot be replayed.
    expect(source).toContain('ctx.actionId?.trim()');
    // Absolute, resolved from the built file, and not the percent-encoding form.
    expect(source).toContain('fileURLToPath(import.meta.url)');
    expect(source).not.toContain("new URL('../migrations'");
    // The source stub ships commented out, so nothing polls by default.
    expect(source).toContain(" * export const poll: Source = {");
  });

  it('writes a migration that is unqualified and additive', () => {
    const sql = files['migrations/001_my_notes.sql'] as string;
    expect(sql).toContain('create table if not exists note');
    expect(sql).not.toContain('my_notes.note (');
  });

  it("ships a buddi.md whose Schema line is the schema the manifest owns", () => {
    const claims = parseBuddiMd(files['buddi.md'] as string);
    expect(claims.schema).toBe('my_notes');
    expect(claims.hosts).toEqual([]);
    // The first install must show no drift: prose and manifest agree.
    expect(driftBetween(claims, { schema: 'my_notes', network: [] })).toEqual([]);
  });
});

describe('writing it out', () => {
  it('creates the tree', () => {
    const root = path.join(scratch(), 'weather');
    const written = writeScaffold(root, { name: 'weather', coreVersion: '0.1.0' });
    expect(written).toContain('src/index.ts');
    expect(existsSync(path.join(root, 'migrations', '001_weather.sql'))).toBe(true);
    expect(readFileSync(path.join(root, 'package.json'), 'utf8')).toContain('buddi-plugin-weather');
  });

  it('refuses a directory that already exists', () => {
    const root = scratch();
    expect(() => writeScaffold(root, { name: 'weather', coreVersion: '0.1.0' })).toThrow(
      /already exists/,
    );
  });
});
