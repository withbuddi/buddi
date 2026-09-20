#!/usr/bin/env node
/** Assemble a release, not a checkout. Never reads .env, data, or private/. */
import { cp, mkdir, readFile, writeFile, mkdtemp, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { BINARY_VERSION } from '../../packages/core/dist/postgres/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
/** The one binary, relative to the package root. */
const LAUNCHER = 'packages/install/dist/launcher.js';
const stage = await mkdtemp(path.join(os.tmpdir(), 'buddi-release-'));
const directories = ['core', 'runtime', 'gateway', 'cli', 'install', 'tools/artifacts', 'tools/browser', 'tools/host', 'tools/email', 'tools/finance', 'tools/memory', 'tools/web'];
const packages = [];
for (const dir of directories) {
  const source = path.join(root, 'packages', dir);
  packages.push({ dir, source, pkg: JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')) });
}
const byName = new Map(packages.map(p => [p.pkg.name, p.dir]));
for (const { dir, source, pkg } of packages) {
  const dest = path.join(stage, 'packages', dir);
  await mkdir(dest, { recursive: true });
  for (const asset of pkg.files || ['dist']) {
    try { await cp(path.join(source, asset), path.join(dest, asset), { recursive: true }); }
    catch (error) { if (error.code === 'ENOENT') throw new Error(`${source}/${asset} is missing. Build the workspace before assembling a release.`); throw error; }
  }
  const dependencies = Object.fromEntries(Object.entries(pkg.dependencies || {}).map(([name, version]) => [name,
    byName.has(name) ? `file:${path.relative(dest, path.join(stage, 'packages', byName.get(name)))}` : version]));
  const staged = { ...pkg, private: true, scripts: {}, devDependencies: {}, dependencies };
  // A packaged install has exactly one entry point: the @buddi/install launcher.
  // @buddi/cli declares `bin.buddi` too, so without this the winner of
  // node_modules/.bin/buddi would depend on npm's ordering. Only the bin link
  // is dropped; the modules themselves still ship.
  if (pkg.name !== '@buddi/install') delete staged.bin;
  await writeFile(path.join(dest, 'package.json'), JSON.stringify(staged, null, 2));
}
await cp(path.join(root, 'packages/web/dist'), path.join(stage, 'packages/web/dist'), { recursive: true });
for (const asset of ['examples/agents', 'examples/skills']) await cp(path.join(root, asset), path.join(stage, asset), { recursive: true });
// The launcher, the supervisor and the managed cluster ship as one built
// package (@buddi/install), not as loose scripts copied out of this checkout.
await chmod(path.join(stage, LAUNCHER), 0o755);
const product = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const dependencies = Object.fromEntries(packages.map(({ dir, pkg }) => [pkg.name, `file:packages/${dir}`]));
// Direct imports by the bootstrap and existing CLI. Internal packages remain separate modules.
Object.assign(dependencies, { dotenv: '^16.4.7', pg: '^8.13.1' });
const manifest = {
  name: 'buddi', version: product.version, type: 'module', description: 'Your personal agents, on your computer',
  engines: { node: '>=22' }, bin: { buddi: LAUNCHER },
  files: ['packages', 'examples'], dependencies,
  bundledDependencies: Object.keys(dependencies),
  optionalDependencies: Object.fromEntries(['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'windows-x64'].map(platform => [`@embedded-postgres/${platform}`, BINARY_VERSION])),
};
await writeFile(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2));
const install = spawnSync('npm', ['install', '--omit=dev', '--omit=optional', '--ignore-scripts', '--install-links', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });
if (install.status !== 0) throw new Error(`Release dependency installation failed. Staging preserved: ${stage}`);
const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json'], { cwd: stage, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
if (packed.status !== 0) throw new Error(packed.stderr);
const filename = JSON.parse(packed.stdout)[0].filename;
console.log(`Release: ${path.join(stage, filename)}`);
