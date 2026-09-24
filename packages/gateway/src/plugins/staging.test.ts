/**
 * Staging, the two approvals, and the one property all of it exists for:
 * **nothing of a plugin runs until the owner has said yes.**
 *
 * That property cannot be asserted by reading code, so the fixture asserts it
 * from the inside: `fixtures/marker-plugin` appends to a file at import time.
 * If the marker is absent after a stage, the plugin's top-level code has not
 * run in this process. If it appears at approval, it has. There is nothing to
 * fake and nothing to mock.
 *
 * npm is injected everywhere. The fake `view` answers from a literal and the
 * fake `pack` serves a tarball built from a fixture directory on disk, so this
 * suite never reaches the network and never touches the owner's installation:
 * every path it writes to is a fresh temporary directory.
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { adoptPlugins, loadInstalledPlugins, pluginLoadReport, resetAdoptedPlugins } from './load.js';
import { isPluginSchemaName } from '@buddi/core';
import { approveStaged } from './approve.js';
import { InstallRefusal } from './install.js';
import { driftBetween, parseBuddiMd } from './claims.js';
import { installedHashOf, verifyInstalledHash } from './hash.js';
import { installedPackageDir, pluginDirKey, pluginsRoot, sweepPluginDirs } from './paths.js';
import { assertRegularTree, treeHash } from './tree.js';
import { entryPointOf } from './install.js';
import { manifestProblem } from './load.js';
import { uninstallPlugin } from './uninstall.js';
import { parsePluginSpec, splitNpmSpec } from './spec.js';
import { isNewerVersion, parseSemver, updatePlugin } from './update.js';
import {
  integrityOfFile,
  lifecycleScripts,
  listStaged,
  rejectStaged,
  resolveCoreDir,
  scanDependencies,
  stagePlugin,
  sweepStages,
  TRUST_SENTENCE,
} from './stage.js';
import type { NpmRunner } from './npm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MARKER_FIXTURE = path.join(HERE, 'fixtures', 'marker-plugin');
const THROWING_FIXTURE = path.join(HERE, 'fixtures', 'throwing-plugin');
const require_ = createRequire(import.meta.url);
const ZOD_DIR = path.dirname(require_.resolve('zod/package.json'));

let root: string;
let env: NodeJS.ProcessEnv;
let marker: string;
/** Temporary directories outside `root`, removed with it. */
const temporary: string[] = [];

beforeEach(() => {
  resetAdoptedPlugins();
  root = mkdtempSync(path.join(tmpdir(), 'buddi-stage-'));
  mkdirSync(path.join(root, 'agents'), { recursive: true });
  mkdirSync(path.join(root, 'skills'), { recursive: true });
  marker = path.join(root, 'marker.txt');
  // Every path this suite writes to is under `root`. Nothing reaches the
  // owner's data directory, record or agents.
  env = {
    ...process.env,
    BUDDI_DATA_DIR: path.join(root, 'data'),
    BUDDI_AGENTS_DIR: path.join(root, 'agents'),
    BUDDI_SKILLS_DIR: path.join(root, 'skills'),
    BUDDI_PLUGINS_FILE: path.join(root, 'plugins.json'),
  };
  // The fixture's top-level code reads the real process environment, because
  // that is what a plugin imported into this process sees.
  process.env.BUDDI_FIXTURE_MARKER = marker;
});

afterEach(() => {
  resetAdoptedPlugins();
  delete process.env.BUDDI_FIXTURE_MARKER;
  rmSync(root, { recursive: true, force: true });
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Pack a fixture directory the way npm would: everything under `package/`. */
function packFixture(source: string, into: string, edit?: (dir: string) => void): string {
  const staging = mkdtempSync(path.join(tmpdir(), 'buddi-pack-'));
  cpSync(source, path.join(staging, 'package'), { recursive: true });
  edit?.(path.join(staging, 'package'));
  mkdirSync(into, { recursive: true });
  const tgz = path.join(into, 'fixture.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', staging, 'package']);
  rmSync(staging, { recursive: true, force: true });
  return tgz;
}

interface FakeNpmOptions {
  fixture?: string;
  version?: string;
  /** Overrides what the registry *claims*, which is how a mismatch is staged. */
  integrity?: string;
  publisher?: string;
  edit?: (packageDir: string) => void;
  /** Recorded so a test can assert `--ignore-scripts` was the only way in. */
  installs?: string[];
}

/**
 * An npm that answers from disk. No registry, no network, no child npm.
 *
 * The tarball is packed once and then handed out, so what `view` reports as the
 * integrity really is the hash of the bytes `pack` produces — staging compares
 * the two and refuses when they disagree, and a fake that could not agree with
 * itself would make that refusal untestable.
 */
function fakeNpm(opts: FakeNpmOptions = {}): NpmRunner {
  const fixture = opts.fixture ?? MARKER_FIXTURE;
  const version = opts.version ?? '1.0.0';
  const name = JSON.parse(readFileSync(path.join(fixture, 'package.json'), 'utf8')).name as string;
  let packed: string | undefined;
  const tarball = (): string => {
    if (packed === undefined) {
      const dir = mkdtempSync(path.join(tmpdir(), 'buddi-fake-npm-'));
      temporary.push(dir);
      packed = packFixture(fixture, dir, (pkgDir) => {
        const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
        pkg.version = version;
        writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkg, null, 2));
        opts.edit?.(pkgDir);
      });
    }
    return packed;
  };
  return {
    async view(): Promise<any> {
      return {
        name,
        version,
        dist: {
          integrity: opts.integrity ?? integrityOfFile(tarball()),
          tarball: `https://registry.invalid/${name}`,
        },
        _npmUser: { name: opts.publisher ?? 'a-publisher' },
      };
    },
    async pack(_spec, destination): Promise<string> {
      mkdirSync(destination, { recursive: true });
      const into = path.join(destination, 'fixture.tgz');
      copyFileSync(tarball(), into);
      return into;
    },
    async install(dir): Promise<void> {
      opts.installs?.push(dir);
      // What npm would have written, minus the network: the one dependency the
      // fixture declares, linked rather than downloaded.
      const modules = path.join(dir, 'node_modules');
      mkdirSync(modules, { recursive: true });
      if (!existsSync(path.join(modules, 'zod'))) symlinkSync(ZOD_DIR, path.join(modules, 'zod'), 'junction');
    },
  };
}

describe('what the owner typed', () => {
  it('prefers a directory that exists over a package with the same name', () => {
    expect(parsePluginSpec(MARKER_FIXTURE)).toEqual({ kind: 'directory', path: MARKER_FIXTURE });
  });

  it('reads a scoped npm spec with a range', () => {
    expect(splitNpmSpec('@you/buddi-plugin-finance@^1.2')).toEqual({
      name: '@you/buddi-plugin-finance',
      range: '^1.2',
    });
    expect(parsePluginSpec('buddi-plugin-weather')).toEqual({
      kind: 'registry',
      name: 'buddi-plugin-weather',
      range: 'latest',
    });
  });

  it('refuses a .tgz that is not there rather than treating it as a package name', () => {
    expect(() => parsePluginSpec(path.join(root, 'nope.tgz'))).toThrow(/not on disk/);
  });
});

describe('staging', () => {
  it('fetches, unpacks and reads a package without importing one line of it', async () => {
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm: fakeNpm() });

    expect(existsSync(marker)).toBe(false);
    expect(staged.name).toBe('buddi-plugin-fixture-marker');
    expect(staged.version).toBe('1.0.0');
    expect(staged.publisher).toBe('a-publisher');
    expect(staged.source).toEqual({
      kind: 'registry',
      name: 'buddi-plugin-fixture-marker',
      version: '1.0.0',
    });
    expect(staged.claims.schema).toBe('fixture_marker');
    expect(staged.claims.hosts).toEqual(['example.invalid']);
    expect(listStaged(env).map((s) => s.id)).toEqual([staged.id]);
  });

  it('installs dependencies with scripts ignored, and links the core this process runs', async () => {
    const installs: string[] = [];
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm: fakeNpm({ installs }) });

    expect(installs).toEqual([staged.packageDir]);
    expect(staged.dependencies.count).toBeGreaterThan(0);
    // The peer is the running installation's core, not a second copy of it.
    const linked = path.join(staged.packageDir, 'node_modules', '@buddi', 'core');
    expect(existsSync(path.join(linked, 'package.json'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(linked, 'package.json'), 'utf8')).name).toBe('@buddi/core');
  });

  it('links a core whose only export is the plugin API, the running one\'s own', async () => {
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm: fakeNpm() });
    const linked = path.join(staged.packageDir, 'node_modules', '@buddi', 'core');
    expect(lstatSync(linked).isSymbolicLink()).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(path.join(linked, 'package.json'), 'utf8')).exports)).toEqual([
      './plugin',
      './package.json',
    ]);
    // Resolved as the plugin resolves it: from inside its own package.
    const probe = path.join(staged.packageDir, 'probe.mjs');
    writeFileSync(probe, '');
    const require_ = createRequire(probe);
    expect(() => require_.resolve('@buddi/core')).toThrow();
    expect(() => require_.resolve('@buddi/core/testing')).toThrow();
    expect(() => require_.resolve('@buddi/core/dist/index.js')).toThrow();
    // The same objects core holds, not a copy, so `instanceof QueryRefusal`
    // still means something. Asked of plain Node, as the gateway loads a plugin
    // (vitest keeps a module graph of its own).
    writeFileSync(probe, "export * as api from '@buddi/core/plugin';\n");
    const own = pathToFileURL(path.join(resolveCoreDir()!, 'dist', 'plugin', 'index.js')).href;
    const same = execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `const { api } = await import(${JSON.stringify(pathToFileURL(probe).href)});` +
        `const own = await import(${JSON.stringify(own)});` +
        `process.stdout.write(String(api.QueryRefusal === own.QueryRefusal && api.HOST_API_VERSION === own.HOST_API_VERSION));`,
    ]).toString();
    expect(same).toBe('true');
  });

  it('names every dependency that wanted to run code at install', () => {
    const packageDir = path.join(root, 'pkg');
    const nested = path.join(packageDir, 'node_modules', 'sharp-ish');
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      path.join(nested, 'package.json'),
      JSON.stringify({ name: 'sharp-ish', version: '1.0.0', scripts: { install: 'node build.js' } }),
    );
    const quiet = path.join(packageDir, 'node_modules', 'quiet');
    mkdirSync(quiet, { recursive: true });
    writeFileSync(path.join(quiet, 'package.json'), JSON.stringify({ name: 'quiet', version: '1.0.0' }));

    // No script written down anywhere, and node-gyp compiles C++ as this user.
    const gyp = path.join(packageDir, 'node_modules', 'native-ish');
    mkdirSync(gyp, { recursive: true });
    writeFileSync(path.join(gyp, 'package.json'), JSON.stringify({ name: 'native-ish', version: '1.0.0' }));
    writeFileSync(path.join(gyp, 'binding.gyp'), '{ "targets": [] }');

    const scanned = scanDependencies(packageDir);
    expect(scanned.count).toBe(3);
    expect(scanned.withScripts).toEqual([
      'native-ish (binding.gyp: wants to build native code)',
      'sharp-ish (install)',
    ]);
    expect(lifecycleScripts({ scripts: { postinstall: 'x', test: 'y' } })).toEqual(['postinstall']);
  });

  it('deletes a rejected stage, and sweeps the ones nobody decided on', async () => {
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm: fakeNpm() });
    expect(rejectStaged(staged.id, env)).toBe(true);
    expect(listStaged(env)).toEqual([]);

    const old = await stagePlugin('buddi-plugin-fixture-marker', {
      env,
      npm: fakeNpm(),
      now: () => new Date('2020-01-01T00:00:00.000Z'),
    });
    expect(sweepStages(env)).toEqual([old.id]);
    expect(existsSync(old.dir)).toBe(false);
  });

  it('says the sentence the owner is agreeing to, in one place', () => {
    expect(TRUST_SENTENCE).toContain('it is not sandboxed');
    expect(TRUST_SENTENCE).toContain('Install only what you would run as yourself.');
  });
});

describe('approval 1', () => {
  it('refuses an integrity that is not the one that was staged, and imports nothing', async () => {
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm: fakeNpm() });

    await expect(
      approveStaged(staged.id, { integrity: `sha512-${'b'.repeat(86)}==`, env }),
    ).rejects.toThrow(InstallRefusal);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(path.join(root, 'plugins.json'))).toBe(false);
  });

  it('is the first moment the plugin\'s code runs, and records what was approved', async () => {
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm: fakeNpm() });
    expect(existsSync(marker)).toBe(false);

    const outcome = await approveStaged(staged.id, { integrity: staged.integrity, env });

    expect(existsSync(marker)).toBe(true);
    if (outcome.kind !== 'installed') throw new Error(`expected an install, got ${outcome.kind}`);
    expect(outcome.restartNeeded).toBe(true);
    expect(outcome.record.name).toBe('fixture-marker');
    expect(outcome.record.source.kind).toBe('registry');
    expect(outcome.record.provenance?.publisher).toBe('a-publisher');
    expect(outcome.record.provenance?.approvedIntegrity).toBe(staged.integrity);
    expect(outcome.record.provenance?.installedHash).toMatch(/^sha256-[0-9a-f]{64}$/);
    // The files moved out of staging and under the data directory, and the
    // stage that held them is gone.
    expect(outcome.record.entry.startsWith(installedPackageDir('fixture-marker', env))).toBe(true);
    expect(listStaged(env)).toEqual([]);
    // Once, not twice. The install used to import the entry a second time to
    // re-read the manifest from where the package now lives, so a plugin with
    // a side effect at import did it twice on every install.
    expect(readFileSync(marker, 'utf8').trimEnd().split('\n')).toHaveLength(1);
  });
});

describe('approval 2: the prose and the code disagree', () => {
  it('stops at the drift and installs nothing until it is acknowledged', async () => {
    const npm = fakeNpm({
      edit: (dir) => {
        writeFileSync(
          path.join(dir, 'buddi.md'),
          '# fixture-marker\n\nIt stores nothing.\n\nSchema: something_else\nHosts: none\n',
        );
      },
    });
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm });
    expect(staged.claims.schema).toBe('something_else');

    const first = await approveStaged(staged.id, { integrity: staged.integrity, env });
    if (first.kind !== 'drift') throw new Error('expected the drift to stop the install');
    expect(first.plan.drift.join(' ')).toContain('something_else');
    expect(first.plan.drift.join(' ')).toContain('example.invalid');
    expect(existsSync(path.join(root, 'plugins.json'))).toBe(false);

    const second = await approveStaged(staged.id, {
      integrity: staged.integrity,
      acknowledgeDrift: true,
      env,
    });
    expect(second.kind).toBe('installed');
  });

  it('compares only what the prose actually stated', () => {
    const claims = parseBuddiMd('# x\n\nSchema: money\nHosts: `api.example.com`, b.example.com.\n');
    expect(claims.hosts).toEqual(['api.example.com', 'b.example.com']);
    expect(driftBetween(claims, { schema: 'money', network: [{ host: 'api.example.com' }, { host: 'b.example.com' }] })).toEqual([]);
    expect(driftBetween(parseBuddiMd(undefined), { schema: 'money' })).toEqual([
      'it ships no buddi.md, so it stated nothing in advance about what it does',
    ]);
  });
});

describe('update', () => {
  it('refuses a version that is not newer, and keeps nothing it fetched', async () => {
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm: fakeNpm() });
    await approveStaged(staged.id, { integrity: staged.integrity, env });

    await expect(updatePlugin('fixture-marker', { env, npm: fakeNpm({ version: '1.0.0' }) })).rejects.toThrow(
      /not newer/,
    );
    expect(listStaged(env)).toEqual([]);
  });

  it('stages a newer one, naming what it replaces', async () => {
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm: fakeNpm() });
    await approveStaged(staged.id, { integrity: staged.integrity, env });

    const next = await updatePlugin('fixture-marker', {
      env,
      npm: fakeNpm({
        version: '1.1.0',
        edit: (dir) => {
          const source = readFileSync(path.join(dir, 'index.js'), 'utf8');
          writeFileSync(path.join(dir, 'index.js'), source.replace(/version: '1\.0\.0'/, "version: '1.1.0'"));
        },
      }),
    });
    expect(next.version).toBe('1.1.0');
    expect(next.previous).toEqual({ name: 'fixture-marker', version: '1.0.0' });
  });

  it('knows which version is newer', () => {
    expect(isNewerVersion('1.2.0', '1.10.0')).toBe(false);
    expect(isNewerVersion('1.10.0', '1.2.0')).toBe(true);
    expect(isNewerVersion('2.0.0', '2.0.0-rc.1')).toBe(true);
    expect(isNewerVersion('2.0.0-rc.1', '2.0.0')).toBe(false);
  });
});

describe('uninstall', () => {
  it('removes the record and the files buddi put there, keeping the schema', async () => {
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm: fakeNpm() });
    await approveStaged(staged.id, { integrity: staged.integrity, env });
    const dir = installedPackageDir('fixture-marker', env);
    expect(existsSync(dir)).toBe(true);

    const { outcome } = await uninstallPlugin('fixture-marker', { env });

    expect(existsSync(dir)).toBe(false);
    expect(outcome.purged).toBe(false);
    expect(outcome.notes.join(' ')).toContain('package directory');
    // Dropping the schema is the other verb, and it needs the database.
    expect(outcome.notes.join(' ')).toContain('left untouched');
    expect(JSON.parse(readFileSync(path.join(root, 'plugins.json'), 'utf8')).plugins).toEqual([]);
  });

  it('never deletes a developer\'s own build directory', async () => {
    const dev = path.join(root, 'dev-plugin');
    cpSync(MARKER_FIXTURE, dev, { recursive: true });
    const staged = await stagePlugin(dev, { env, npm: fakeNpm() });
    await approveStaged(staged.id, { integrity: staged.integrity, env });

    await uninstallPlugin('fixture-marker', { env });
    expect(existsSync(path.join(dev, 'index.js'))).toBe(true);
  });
});

describe('what doctor and the API read afterwards', () => {
  it('reports a plugin whose entry throws, and loads every other one', async () => {
    const good = await stagePlugin('buddi-plugin-fixture-marker', { env, npm: fakeNpm() });
    await approveStaged(good.id, { integrity: good.integrity, env });

    // The broken one goes straight into the record: approving it would refuse,
    // which is the point, and what is being tested is the *load* afterwards.
    const broken = path.join(root, 'broken');
    cpSync(THROWING_FIXTURE, broken, { recursive: true });
    const file = path.join(root, 'plugins.json');
    const contents = JSON.parse(readFileSync(file, 'utf8'));
    contents.plugins.push({
      name: 'fixture-throws',
      version: '1.0.0',
      entry: path.join(broken, 'index.js'),
      schema: 'fixture_throws',
      installedAt: new Date().toISOString(),
      source: { kind: 'directory', path: broken },
    });
    writeFileSync(file, JSON.stringify(contents, null, 2));

    adoptPlugins(env, await loadInstalledPlugins(env));
    const report = pluginLoadReport(env);
    expect(report).toHaveLength(1);
    expect(report[0]?.name).toBe('fixture-throws');
    expect(report[0]?.version).toBe('1.0.0');
    expect(report[0]?.error).toContain('this fixture throws on import');
  });

  it('notices when a file changed after it was approved', async () => {
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm: fakeNpm() });
    const outcome = await approveStaged(staged.id, { integrity: staged.integrity, env });
    if (outcome.kind !== 'installed') throw new Error('expected an install');

    expect(verifyInstalledHash(outcome.record, { env }).matches).toBe(true);

    const dir = installedPackageDir('fixture-marker', env);
    writeFileSync(path.join(dir, 'index.js'), `${readFileSync(path.join(dir, 'index.js'), 'utf8')}\n// edited\n`);

    const verified = verifyInstalledHash(outcome.record, { env });
    expect(verified.matches).toBe(false);
    expect(verified.message).toContain('fixture-marker changed on disk since it was approved');
    expect(verified.actual).not.toBe(verified.expected);
  });

  it('says nothing about a directory source, which has no approved hash', () => {
    const verified = verifyInstalledHash(
      {
        name: 'dev',
        version: '0.0.0',
        entry: path.join(MARKER_FIXTURE, 'index.js'),
        installedAt: new Date().toISOString(),
        schema: 'dev',
        source: { kind: 'directory', path: MARKER_FIXTURE },
      },
      { env },
    );
    expect(verified.matches).toBe(true);
    expect(verified.message).toBe('');
  });

  it('hashes the path as well as the content, so moving a file is a change', () => {
    const a = path.join(root, 'a');
    mkdirSync(a, { recursive: true });
    writeFileSync(path.join(a, 'one.js'), 'x');
    const before = installedHashOf(a);
    rmSync(path.join(a, 'one.js'));
    writeFileSync(path.join(a, 'two.js'), 'x');
    expect(installedHashOf(a)).not.toBe(before);
  });

  it('hashes a tarball in the same SRI form npm publishes', () => {
    const tgz = packFixture(MARKER_FIXTURE, path.join(root, 'packed'));
    expect(integrityOfFile(tgz)).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/);
  });
});

/* ------------------------------------------------------------------ *
 * What a tarball is allowed to contain
 * ------------------------------------------------------------------ */

/** Build a tarball by hand, with whatever `tar` this platform ships. */
function tarballOf(build: (dir: string) => void, opts: { members?: string[]; absolute?: boolean } = {}): string {
  const staging = mkdtempSync(path.join(tmpdir(), 'buddi-evil-'));
  temporary.push(staging);
  mkdirSync(path.join(staging, 'package'), { recursive: true });
  build(path.join(staging, 'package'));
  const tgz = path.join(staging, 'evil.tgz');
  execFileSync('tar', [
    ...(opts.absolute === true ? ['-czPf'] : ['-czf']),
    tgz,
    '-C',
    staging,
    ...(opts.members ?? ['package']),
  ]);
  return tgz;
}

describe('a tarball is files and directories, or it is refused', () => {
  it('refuses a package with a symlink in it, and keeps nothing', async () => {
    const outside = path.join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    const tgz = tarballOf((dir) => {
      writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'buddi-plugin-sneaky', version: '1.0.0', main: 'index.js' }),
      );
      writeFileSync(path.join(dir, 'index.js'), 'export const manifest = {};\n');
      // The shape that matters: the directory the core peer link is written
      // into, pointed somewhere else entirely.
      mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
      symlinkSync(outside, path.join(dir, 'node_modules', '@buddi'), 'junction');
    });

    await expect(stagePlugin(tgz, { env, npm: fakeNpm() })).rejects.toThrow(/symbolic link/);
    // Nothing was written through it, and nothing of the package is kept.
    expect(existsSync(path.join(outside, 'core'))).toBe(false);
    expect(listStaged(env)).toEqual([]);
  });

  it('never writes outside the staging directory, whatever the members are called', async () => {
    const escapee = path.join(root, 'escaped.txt');
    const tgz = tarballOf(
      (dir) => {
        writeFileSync(
          path.join(dir, 'package.json'),
          JSON.stringify({ name: 'buddi-plugin-traversal', version: '1.0.0', main: 'index.js' }),
        );
        writeFileSync(path.join(dir, 'index.js'), 'export const manifest = {};\n');
        // A member whose path climbs out of the directory it is extracted into.
        writeFileSync(path.join(dir, '..', 'escaped.txt'), 'written by a tarball');
      },
      { members: ['package', 'package/../escaped.txt'], absolute: true },
    );

    await stagePlugin(tgz, { env, npm: fakeNpm(), skipDependencies: true }).catch(() => undefined);
    // Whether tar dropped the member or the walk refused the stage, the one
    // thing that must be true is that nothing landed outside the stage.
    expect(existsSync(escapee)).toBe(false);
  });

  it('refuses a device or a fifo among the files', () => {
    const dir = path.join(root, 'fifo-pkg');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), '{}');
    execFileSync('mkfifo', [path.join(dir, 'pipe')]);
    expect(() => assertRegularTree(dir)).toThrow(/neither a file nor a directory/);
  });
});

/* ------------------------------------------------------------------ *
 * The hash of what actually runs
 * ------------------------------------------------------------------ */

describe('the staged tree is hashed, and the hash is what approval re-checks', () => {
  it('covers the dependencies, not only the package\'s own files', async () => {
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm: fakeNpm() });
    expect(staged.stagedHash).toMatch(/^sha256-[0-9a-f]{64}$/);

    const before = staged.stagedHash;
    const added = path.join(staged.packageDir, 'node_modules', 'extra');
    mkdirSync(added, { recursive: true });
    writeFileSync(path.join(added, 'package.json'), '{"name":"extra","version":"1.0.0"}');
    expect(treeHash(staged.packageDir, { includeModules: true, linksAllowedUnder: 'node_modules' })).not.toBe(before);
  });

  it('refuses a stage whose files changed while it waited, and imports nothing', async () => {
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm: fakeNpm() });
    writeFileSync(path.join(staged.packageDir, 'index.js'), 'export const manifest = { name: "other" };\n');

    await expect(approveStaged(staged.id, { integrity: staged.integrity, env })).rejects.toThrow(
      /not the ones that were read/,
    );
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(path.join(root, 'plugins.json'))).toBe(false);
  });

  it('refuses a tarball whose bytes are not what the registry published', async () => {
    const npm = fakeNpm({ integrity: `sha512-${'z'.repeat(86)}==` });
    await expect(stagePlugin('buddi-plugin-fixture-marker', { env, npm })).rejects.toThrow(
      /the registry says .* and the tarball that arrived is/,
    );
    expect(listStaged(env)).toEqual([]);
  });

  it('refuses a tarball that is not the version npm resolved', async () => {
    const npm = fakeNpm({
      edit: (dir) => {
        const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
        pkg.version = '9.9.9';
        writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
      },
    });
    await expect(stagePlugin('buddi-plugin-fixture-marker', { env, npm })).rejects.toThrow(
      /calls itself buddi-plugin-fixture-marker@9\.9\.9/,
    );
  });

  it('refuses a plugin that rewrites its own files while it is being imported', async () => {
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm: fakeNpm() });
    // The fixture appends to whatever `BUDDI_FIXTURE_MARKER` names, at import.
    // Pointed at its own directory, it is a package that changes as it is read.
    process.env.BUDDI_FIXTURE_MARKER = path.join(staged.packageDir, 'self-written.txt');

    await expect(approveStaged(staged.id, { integrity: staged.integrity, env })).rejects.toThrow(
      /changed its own files while it was being imported/,
    );
    // Removed, and no record left claiming it is installed.
    expect(existsSync(installedPackageDir('fixture-marker', env))).toBe(false);
    const record = existsSync(path.join(root, 'plugins.json'))
      ? JSON.parse(readFileSync(path.join(root, 'plugins.json'), 'utf8')).plugins
      : [];
    expect(record).toEqual([]);
  });

  it('records the hash taken before the import, and doctor checks the same tree', async () => {
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm: fakeNpm() });
    const outcome = await approveStaged(staged.id, { integrity: staged.integrity, env });
    if (outcome.kind !== 'installed') throw new Error('expected an install');
    expect(outcome.record.provenance?.installedHash).toBe(staged.stagedHash);
    expect(verifyInstalledHash(outcome.record, { env }).matches).toBe(true);

    // A dependency rewritten in place is now visible, which is what including
    // node_modules in the hash bought.
    const dir = installedPackageDir('fixture-marker', env);
    mkdirSync(path.join(dir, 'node_modules', 'extra'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', 'extra', 'index.js'), 'whatever');
    expect(verifyInstalledHash(outcome.record, { env }).matches).toBe(false);
  });

  it('reports a package that grew a symlink rather than hashing around it', async () => {
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm: fakeNpm() });
    const outcome = await approveStaged(staged.id, { integrity: staged.integrity, env });
    if (outcome.kind !== 'installed') throw new Error('expected an install');
    const dir = installedPackageDir('fixture-marker', env);
    symlinkSync(path.join(root, 'agents'), path.join(dir, 'elsewhere'), 'junction');
    expect(lstatSync(path.join(dir, 'elsewhere')).isSymbolicLink()).toBe(true);

    const verified = verifyInstalledHash(outcome.record, { env });
    expect(verified.matches).toBe(false);
    expect(verified.message).toMatch(/could not be checked|symbolic link/);
  });
});

/* ------------------------------------------------------------------ *
 * Names, paths and identity
 * ------------------------------------------------------------------ */

describe('what a package may be called, and where it may be put', () => {
  it('folds a scoped name into one safe directory, and refuses the rest', () => {
    expect(pluginDirKey('weather')).toBe('weather');
    expect(pluginDirKey('@you/weather')).toBe('@you+weather');
    expect(() => pluginDirKey('staging')).toThrow(/no plugin may take it/);
    expect(() => pluginDirKey('../../etc/cron.d')).toThrow(/not a usable plugin name/);
    expect(() => pluginDirKey('Weather')).toThrow(/not a usable plugin name/);
    expect(() => installedPackageDir('../escape', env)).toThrow(/not a usable plugin name/);
    expect(installedPackageDir('@you/weather', env).endsWith(path.join('plugins', '@you+weather'))).toBe(true);
  });

  it('refuses a manifest that calls itself something other than the package', async () => {
    const npm = fakeNpm({
      edit: (dir) => {
        const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
        pkg.buddi.name = 'something-else';
        writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
      },
    });
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm });
    expect(staged.declaredName).toBe('something-else');
    await expect(approveStaged(staged.id, { integrity: staged.integrity, env })).rejects.toThrow(
      /manifest it exports calls itself "fixture-marker"/,
    );
    expect(existsSync(installedPackageDir('fixture-marker', env))).toBe(false);
  });

  it('refuses an entry point that resolves outside the package', () => {
    const dir = path.join(root, 'escaping');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(root, 'elsewhere.js'), 'export const manifest = {};\n');
    writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'escaping', version: '1.0.0', main: '../elsewhere.js' }),
    );
    expect(() => entryPointOf(dir)).toThrow(/outside the package directory/);
  });

  it('refuses a schema name that is not an identifier, before anything records it', () => {
    expect(isPluginSchemaName('fixture_marker')).toBe(true);
    expect(isPluginSchemaName('public; drop schema core')).toBe(false);
    expect(
      manifestProblem({ name: 'x', version: '1.0.0', schema: 'we-ird', tools: [] }, undefined, env),
    ).toMatch(/not a Postgres identifier/);
  });
});

/* ------------------------------------------------------------------ *
 * Finishing, or not finishing, an install
 * ------------------------------------------------------------------ */

describe('an install that does not finish', () => {
  it('sweeps a moved-aside version and a directory no record names', async () => {
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm: fakeNpm() });
    await approveStaged(staged.id, { integrity: staged.integrity, env });
    const root_ = pluginsRoot(env);
    mkdirSync(path.join(root_, 'ghost'), { recursive: true });
    mkdirSync(path.join(root_, 'fixture-marker.previous-1700000000000'), { recursive: true });

    const swept = sweepPluginDirs(env, { known: ['fixture-marker'] }).sort();

    expect(swept).toEqual(['fixture-marker.previous-1700000000000', 'ghost']);
    expect(existsSync(installedPackageDir('fixture-marker', env))).toBe(true);
    // The staging directory is never an orphan, whatever else is swept.
    expect(existsSync(path.join(root_, 'staging'))).toBe(true);
  });

  it('serialises two approvals of the same stage: one installs, the other refuses', async () => {
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm: fakeNpm() });
    const both = await Promise.allSettled([
      approveStaged(staged.id, { integrity: staged.integrity, env }),
      approveStaged(staged.id, { integrity: staged.integrity, env }),
    ]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const record = JSON.parse(readFileSync(path.join(root, 'plugins.json'), 'utf8')).plugins;
    expect(record).toHaveLength(1);
    expect(record[0].placing).toBeUndefined();
  });

  it('refuses a purge with no name typed back, whether or not one was sent', async () => {
    const staged = await stagePlugin('buddi-plugin-fixture-marker', { env, npm: fakeNpm() });
    await approveStaged(staged.id, { integrity: staged.integrity, env });

    await expect(uninstallPlugin('fixture-marker', { env, purge: true })).rejects.toThrow(
      /Type the plugin's name/,
    );
    await expect(
      uninstallPlugin('fixture-marker', { env, purge: true, confirm: 'fixture-marke' }),
    ).rejects.toThrow(/Type the plugin's name/);
    // Still installed: the refusal happened before anything was removed.
    expect(existsSync(installedPackageDir('fixture-marker', env))).toBe(true);
  });
});

describe('which version is newer', () => {
  it('follows semver, including its prerelease rules', () => {
    expect(isNewerVersion('1.10.0', '1.2.0')).toBe(true);
    expect(isNewerVersion('1.2.0', '1.10.0')).toBe(false);
    expect(isNewerVersion('2.0.0', '2.0.0-rc.1')).toBe(true);
    expect(isNewerVersion('2.0.0-rc.2', '2.0.0-rc.1')).toBe(true);
    expect(isNewerVersion('2.0.0-rc.10', '2.0.0-rc.2')).toBe(true);
    expect(isNewerVersion('2.0.0-alpha', '2.0.0-alpha.1')).toBe(false);
    expect(isNewerVersion('2.0.0-alpha.beta', '2.0.0-alpha.1')).toBe(true);
    expect(isNewerVersion('1.0.0+build.2', '1.0.0+build.1')).toBe(false);
  });

  it('refuses to compare what is not a version rather than guessing', () => {
    expect(() => isNewerVersion('latest', '1.0.0')).toThrow(/not a version this can compare/);
    expect(() => isNewerVersion('1.0', '1.0.0')).toThrow(/not a version this can compare/);
    expect(() => isNewerVersion('1.0.0', '')).toThrow(/not a version this can compare/);
    expect(parseSemver('1.2.3-rc.1')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: ['rc', 1] });
  });
});
