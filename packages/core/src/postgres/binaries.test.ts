/**
 * The binaries an upgrade leaves behind, when nothing ran an install script.
 *
 * `npm install --ignore-scripts` is how this repository installs everything,
 * upgrades included (`packages/install/src/upgrade.ts`), so the per-platform
 * Postgres package arrives as the files in its tarball and nothing else: the
 * `native/` tree and the `pg-symlinks.json` beside it, with none of the links
 * it describes actually created. Making those links is this module's job, and
 * this is the test that says so.
 */
import { chmod, mkdir, mkdtemp, readlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { BINARY_VERSION, prepareBinaries } from './binaries.js';

/** The package as npm unpacks it with scripts off: files, no symlinks. */
async function fakePackage(): Promise<{ root: string; dataDir: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'buddi-binroot-'));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'buddi-bindata-'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'buddi', version: '0.1.0' }));
  const pkg = path.join(root, 'node_modules', `@embedded-postgres/${process.platform}-${process.arch}`);
  await mkdir(path.join(pkg, 'native/bin'), { recursive: true });
  await mkdir(path.join(pkg, 'native/lib'), { recursive: true });
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: `@embedded-postgres/${process.platform}-${process.arch}`, version: BINARY_VERSION, main: 'dist/index.js' }));
  // Upstream's entry point sits one directory below `native/`, which is how
  // the module finds the binaries without depending on the package.
  await mkdir(path.join(pkg, 'dist'), { recursive: true });
  await writeFile(path.join(pkg, 'dist/index.js'), 'module.exports = {};');
  for (const name of ['initdb', 'postgres', 'pg_ctl']) {
    const file = path.join(pkg, 'native/bin', name);
    await writeFile(file, '#!/bin/sh\necho "18.4"\n');
    await chmod(file, 0o755);
  }
  await writeFile(path.join(pkg, 'native/lib/libpq.so.5.18'), 'not really a library');
  // Upstream's manifest: the link is the target, the file is the source.
  await writeFile(path.join(pkg, 'native/pg-symlinks.json'), JSON.stringify([
    { source: 'native/lib/libpq.so.5.18', target: 'native/lib/libpq.so.5' },
  ]));
  return { root, dataDir };
}

describe('the runtime copy of the Postgres binaries', () => {
  test('creates the symlinks the package only describes, with no install script anywhere', async () => {
    const { root, dataDir } = await fakePackage();
    const bin = await prepareBinaries({ root, dataDir, env: process.env });
    expect(bin).toBe(path.join(dataDir, 'runtime', `postgres-${BINARY_VERSION}-${process.platform}-${process.arch}`, 'bin'));
    const link = path.join(path.dirname(bin), 'lib/libpq.so.5');
    expect(await readlink(link)).toBe('libpq.so.5.18');
    // And again on a copy that is already there: nothing throws on EEXIST.
    await expect(prepareBinaries({ root, dataDir, env: process.env })).resolves.toBe(bin);
  });

  test('says which package is missing rather than failing obscurely', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'buddi-binroot-'));
    const dataDir = await mkdtemp(path.join(os.tmpdir(), 'buddi-bindata-'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'buddi', version: '0.1.0' }));
    await expect(prepareBinaries({ root, dataDir, env: process.env })).rejects.toThrow(/Postgres binaries missing/);
  });
});
