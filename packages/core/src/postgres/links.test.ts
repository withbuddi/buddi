/**
 * The links `pg-symlinks.json` describes, made without the package's
 * postinstall script — the script npm 11 holds back, which is how an upgrade
 * once left Postgres dying in the loader. Platform-neutral: the same shape
 * ships `.dylib` links on macOS and `.so` links on Linux.
 */
import { lstat, mkdir, mkdtemp, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { hydratePostgresLinks } from './links.js';

const MANIFEST = [
  { source: 'native/lib/libicuuc.77.1.dylib', target: 'native/lib/libicuuc.77.dylib' },
  { source: 'native/lib/libicuuc.77.1.dylib', target: 'native/lib/libicuuc.dylib' },
  { source: 'native/lib/libpq.so.5.18', target: 'native/lib/libpq.so.5' },
];

async function fixture(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'buddi-pglinks-'));
  await mkdir(path.join(dir, 'native/lib'), { recursive: true });
  await writeFile(path.join(dir, 'native/lib/libicuuc.77.1.dylib'), 'icu');
  await writeFile(path.join(dir, 'native/lib/libpq.so.5.18'), 'pq');
  await writeFile(path.join(dir, 'native/pg-symlinks.json'), JSON.stringify(MANIFEST));
  return dir;
}

describe('hydratePostgresLinks', () => {
  test('creates every link the manifest names, relative to its own directory', async () => {
    const dir = await fixture();
    expect((await hydratePostgresLinks(dir)).sort()).toEqual(['native/lib/libicuuc.77.dylib', 'native/lib/libicuuc.dylib', 'native/lib/libpq.so.5']);
    expect(await readlink(path.join(dir, 'native/lib/libicuuc.77.dylib'))).toBe('libicuuc.77.1.dylib');
    expect(await readlink(path.join(dir, 'native/lib/libpq.so.5'))).toBe('libpq.so.5.18');
    expect(await readFile(path.join(dir, 'native/lib/libicuuc.dylib'), 'utf8')).toBe('icu');
  });

  test('is idempotent', async () => {
    const dir = await fixture();
    await hydratePostgresLinks(dir);
    expect(await hydratePostgresLinks(dir)).toEqual([]);
  });

  test('works on a copy of native/ too, where the manifest sits at the top', async () => {
    const dir = await fixture();
    expect(await hydratePostgresLinks(path.join(dir, 'native'))).toHaveLength(3);
    expect(await readlink(path.join(dir, 'native/lib/libpq.so.5'))).toBe('libpq.so.5.18');
  });

  test('leaves a correct link and a real file alone', async () => {
    const dir = await fixture();
    await symlink('libicuuc.77.1.dylib', path.join(dir, 'native/lib/libicuuc.77.dylib'));
    await writeFile(path.join(dir, 'native/lib/libpq.so.5'), 'a real file');
    expect(await hydratePostgresLinks(dir)).toEqual(['native/lib/libicuuc.dylib']);
    expect((await lstat(path.join(dir, 'native/lib/libpq.so.5'))).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(dir, 'native/lib/libpq.so.5'), 'utf8')).toBe('a real file');
  });

  test('replaces a broken link, and one that leads out of the tree', async () => {
    const dir = await fixture();
    await symlink('nowhere.dylib', path.join(dir, 'native/lib/libicuuc.77.dylib'));
    // What an older `fs.cp` copy left: an absolute link into another tree.
    const elsewhere = await fixture();
    await symlink(path.join(elsewhere, 'native/lib/libpq.so.5.18'), path.join(dir, 'native/lib/libpq.so.5'));
    expect((await hydratePostgresLinks(dir)).sort()).toEqual(['native/lib/libicuuc.77.dylib', 'native/lib/libicuuc.dylib', 'native/lib/libpq.so.5']);
    expect(await readlink(path.join(dir, 'native/lib/libicuuc.77.dylib'))).toBe('libicuuc.77.1.dylib');
    expect(await readlink(path.join(dir, 'native/lib/libpq.so.5'))).toBe('libpq.so.5.18');
  });

  test('a missing or unreadable manifest is nothing to do', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'buddi-pglinks-'));
    expect(await hydratePostgresLinks(dir)).toEqual([]);
    await mkdir(path.join(dir, 'native'));
    await writeFile(path.join(dir, 'native/pg-symlinks.json'), 'not json');
    expect(await hydratePostgresLinks(dir)).toEqual([]);
  });

  test('never writes outside the tree, nor a link to a file that is not there', async () => {
    const dir = await fixture();
    await writeFile(path.join(dir, 'native/pg-symlinks.json'), JSON.stringify([
      { source: 'native/lib/libpq.so.5.18', target: '../../escape' },
      { source: 'native/lib/missing.so.1.0', target: 'native/lib/missing.so.1' },
    ]));
    expect(await hydratePostgresLinks(dir)).toEqual([]);
  });
});
