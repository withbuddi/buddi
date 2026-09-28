/**
 * A plugin the way an author ships it: `npm pack`ed, then installed from the
 * `.tgz` with the real npm, end to end — staged, approved, placed.
 *
 * The fixture carries everything that used to break this: a `link:`
 * devDependency on core that points nowhere, core as a peer, no `buddi.name`,
 * and a dependency whose own package.json asks for core as a peer too. Its one
 * registry dependency is served by a fake registry on 127.0.0.1 that writes
 * down every request, and the assertion that matters is about that log:
 * **nothing named `@buddi/core` is ever asked for.** The `@buddi` scope on npm
 * is not buddi's; a request for core by name is a request to a stranger.
 *
 * Hermetic: npm is pointed at the fake registry, a fresh cache and an empty
 * user config, so the owner's `~/.npmrc` and `~/.npm` are never read.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { approveStaged } from './approve.js';
import { resetAdoptedPlugins } from './load.js';
import { npmBinary } from './npm.js';
import { installedPackageDir } from './paths.js';
import { integrityOfFile, packageJsonForInstall, stagePlugin } from './stage.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKED_FIXTURE = path.join(HERE, 'fixtures', 'packed-plugin');

let root: string;
let env: NodeJS.ProcessEnv;
let server: Server;
let registry: string;
let requests: string[];
const savedNpmEnv: Record<string, string | undefined> = {};
const NPM_ENV = ['npm_config_registry', 'npm_config_cache', 'npm_config_userconfig', 'npm_config_update_notifier'];

/** A package tarball with `package/package.json` and an index. */
function tarballOf(dir: string, pkg: Record<string, unknown>, index: string): Buffer {
  const staging = path.join(dir, 'package');
  mkdirSync(staging, { recursive: true });
  writeFileSync(path.join(staging, 'package.json'), JSON.stringify(pkg));
  writeFileSync(path.join(staging, 'index.js'), index);
  const tgz = path.join(dir, 'out.tgz');
  execFileSync('tar', ['-czf', tgz, '-C', dir, 'package']);
  return readFileSync(tgz);
}

beforeEach(async () => {
  resetAdoptedPlugins();
  root = mkdtempSync(path.join(tmpdir(), 'buddi-packed-'));
  mkdirSync(path.join(root, 'agents'), { recursive: true });
  mkdirSync(path.join(root, 'skills'), { recursive: true });
  env = {
    ...process.env,
    BUDDI_DATA_DIR: path.join(root, 'data'),
    BUDDI_AGENTS_DIR: path.join(root, 'agents'),
    BUDDI_SKILLS_DIR: path.join(root, 'skills'),
    BUDDI_PLUGINS_FILE: path.join(root, 'plugins.json'),
  };

  // The one dependency, and it asks for core as a peer the way a helper
  // library written for buddi plugins would.
  const tinyPkg = { name: 'tiny-dep', version: '1.0.0', main: 'index.js', peerDependencies: { '@buddi/core': '>=0.1.0' } };
  const tiny = tarballOf(path.join(root, 'tiny'), tinyPkg, 'module.exports = "tiny";\n');
  const integrity = `sha512-${createHash('sha512').update(tiny).digest('base64')}`;
  requests = [];
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (req.url === '/tiny-dep') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          name: 'tiny-dep',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': { ...tinyPkg, dist: { integrity, tarball: `${base}/tiny-dep/-/tiny-dep-1.0.0.tgz` } },
          },
        }),
      );
      return;
    }
    if (req.url === '/tiny-dep/-/tiny-dep-1.0.0.tgz') {
      res.end(tiny);
      return;
    }
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end('{"error":"not found"}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  // The npm staging runs inherits this process's environment.
  const userconfig = path.join(root, 'npmrc');
  writeFileSync(userconfig, '');
  const values: Record<string, string> = {
    npm_config_registry: registry,
    npm_config_cache: path.join(root, 'npm-cache'),
    npm_config_userconfig: userconfig,
    npm_config_update_notifier: 'false',
  };
  for (const key of NPM_ENV) {
    savedNpmEnv[key] = process.env[key];
    process.env[key] = values[key];
  }
});

afterEach(async () => {
  resetAdoptedPlugins();
  for (const key of NPM_ENV) {
    if (savedNpmEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedNpmEnv[key];
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

/** `npm pack` the fixture, after `edit`, exactly as its author would. */
function npmPack(edit?: (pkg: Record<string, any>) => void): string {
  const author = path.join(root, 'author');
  rmSync(author, { recursive: true, force: true });
  cpSync(PACKED_FIXTURE, author, { recursive: true });
  if (edit !== undefined) {
    const file = path.join(author, 'package.json');
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
    edit(pkg);
    writeFileSync(file, JSON.stringify(pkg, null, 2));
  }
  const out = path.join(root, 'packed');
  mkdirSync(out, { recursive: true });
  const stdout = execFileSync(npmBinary(), ['pack', '--json', '--pack-destination', out], {
    cwd: author,
    encoding: 'utf8',
  });
  const [first] = JSON.parse(stdout) as Array<{ filename: string }>;
  return path.join(out, path.basename(first!.filename));
}

function askedForCore(): string[] {
  return requests.filter((r) => /@buddi|buddi%2fcore/i.test(r));
}

describe('a plugin packed with npm', () => {
  it('stages from the .tgz and approves, and npm is never asked for @buddi/core', async () => {
    const tgz = npmPack();
    const staged = await stagePlugin(tgz, { env });

    expect(askedForCore()).toEqual([]);
    expect(requests).toContain('GET /tiny-dep');
    // The hash the owner approves is the tarball's, untouched by what npm read.
    expect(staged.integrity).toBe(integrityOfFile(tgz));
    // No buddi.name: the manifest's name is the plugin's, read at approval.
    expect(staged.nameFromManifest).toBe(true);
    expect(staged.coreAsDependency).toBeUndefined();
    // The author's package.json is back, byte for byte, link and all.
    const shipped = JSON.parse(readFileSync(path.join(staged.packageDir, 'package.json'), 'utf8'));
    expect(shipped.devDependencies['@buddi/core']).toMatch(/^link:/);
    expect(existsSync(path.join(staged.dir, 'core-placeholder'))).toBe(false);
    // Core is the running one, narrowed to the plugin API.
    const core = JSON.parse(
      readFileSync(path.join(staged.packageDir, 'node_modules', '@buddi', 'core', 'package.json'), 'utf8'),
    );
    expect(Object.keys(core.exports)).toEqual(['./plugin', './package.json']);

    const outcome = await approveStaged(staged.id, { integrity: staged.integrity, env });
    expect(outcome.kind).toBe('installed');
    if (outcome.kind !== 'installed') return;
    expect(outcome.record.name).toBe('packed');
    expect(existsSync(path.join(installedPackageDir('packed', env), 'node_modules', 'tiny-dep'))).toBe(true);
    expect(askedForCore()).toEqual([]);
  }, 120_000);

  it('stages a package that lists core as a hard dependency, and says so', async () => {
    const tgz = npmPack((pkg) => {
      pkg.dependencies['@buddi/core'] = '>=0.1.0';
    });
    const staged = await stagePlugin(tgz, { env });
    expect(staged.coreAsDependency).toBe(true);
    expect(askedForCore()).toEqual([]);
  }, 120_000);

  it('refuses a manifest name another package is installed under', async () => {
    const first = await stagePlugin(npmPack(), { env });
    await approveStaged(first.id, { integrity: first.integrity, env });
    // A different package whose manifest also calls itself "packed".
    const other = await stagePlugin(
      npmPack((pkg) => {
        pkg.name = '@stranger/not-packed';
      }),
      { env },
    );
    await expect(approveStaged(other.id, { integrity: other.integrity, env })).rejects.toThrow(
      /already installed from the package @someone\/buddi-plugin-packed/,
    );
    // The same package again is a reinstall, not a takeover.
    const again = await stagePlugin(npmPack(), { env });
    const outcome = await approveStaged(again.id, { integrity: again.integrity, env });
    expect(outcome.kind).toBe('installed');
  }, 120_000);

  it('still refuses a buddi.name the manifest does not answer to', async () => {
    const staged = await stagePlugin(
      npmPack((pkg) => {
        pkg.buddi.name = 'something-else';
      }),
      { env },
    );
    expect(staged.nameFromManifest).toBeUndefined();
    await expect(approveStaged(staged.id, { integrity: staged.integrity, env })).rejects.toThrow(
      /manifest it exports calls itself "packed"/,
    );
  }, 120_000);
});

describe('the package.json npm reads in a stage', () => {
  it('has no development half and no core anywhere, and points core at a local placeholder', () => {
    const { pkg, coreRemovedFrom } = packageJsonForInstall(
      {
        name: 'x',
        version: '1.0.0',
        dependencies: { '@buddi/core': '^0.1.0', zod: '^3' },
        peerDependencies: { '@buddi/core': '>=0.1.0', react: '*' },
        peerDependenciesMeta: { '@buddi/core': { optional: true } },
        optionalDependencies: { '@buddi/core': '*' },
        devDependencies: { '@buddi/core': 'link:../core', vitest: '^2' },
        bundleDependencies: ['@buddi/core', 'zod'],
        overrides: { '@buddi/core': 'npm:evil@1', zod: { '@buddi/core@1': '1.0.0', foo: '1' } },
      },
      '/stage/core-placeholder',
    );
    expect(coreRemovedFrom).toEqual(['dependencies', 'peerDependencies', 'optionalDependencies']);
    expect(pkg.devDependencies).toBeUndefined();
    expect(pkg.dependencies).toEqual({ zod: '^3' });
    expect(pkg.peerDependencies).toEqual({ react: '*' });
    expect(pkg.peerDependenciesMeta).toEqual({});
    expect(pkg.bundleDependencies).toEqual(['zod']);
    expect(pkg.overrides).toEqual({ zod: { foo: '1' }, '@buddi/core': 'file:/stage/core-placeholder' });
  });
});
