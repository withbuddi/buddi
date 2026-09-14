/**
 * `list` and `prune` over a real directory: the part `selectForPrune` cannot
 * prove on its own is that only *buddi* archives are ever listed or deleted.
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveName } from './manifest.js';
import { listArchives, pruneArchives } from './prune.js';

describe('listing and pruning archives', () => {
  let dir: string;

  const write = async (at: Date, bytes = 32): Promise<string> => {
    const name = archiveName(at);
    await writeFile(path.join(dir, name), Buffer.alloc(bytes));
    return name;
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'buddi-prune-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists nothing for a directory that does not exist', async () => {
    expect(await listArchives(path.join(dir, 'nope'))).toEqual([]);
  });

  it('lists newest first and reads the time out of the name', async () => {
    const older = await write(new Date(2026, 8, 1, 3, 30, 0));
    const newer = await write(new Date(2026, 8, 14, 3, 30, 0));
    const listed = await listArchives(dir);
    expect(listed.map((a) => a.name)).toEqual([newer, older]);
    expect(new Date(listed[0]!.at).getFullYear()).toBe(2026);
  });

  it('ignores anything that is not a buddi archive', async () => {
    await write(new Date(2026, 8, 14, 3, 30, 0));
    await writeFile(path.join(dir, 'notes.txt'), 'hello');
    await writeFile(path.join(dir, 'backup.tar.gz'), 'x');
    expect((await listArchives(dir)).length).toBe(1);
  });

  it('keeps the newest n and deletes only archives', async () => {
    for (let day = 1; day <= 5; day += 1) await write(new Date(2026, 8, day, 3, 30, 0), 100);
    await writeFile(path.join(dir, 'notes.txt'), 'do not delete me');

    const result = await pruneArchives(2, dir);
    expect(result.kept.length).toBe(2);
    expect(result.removed.length).toBe(3);
    expect(result.freedBytes).toBe(300);

    const left = (await readdir(dir)).sort();
    expect(left).toContain('notes.txt');
    expect(left.filter((f) => f.endsWith('.tar.gz')).length).toBe(2);
    expect(left).toContain(archiveName(new Date(2026, 8, 5, 3, 30, 0)));
  });

  it('removes nothing when there is nothing to remove', async () => {
    await write(new Date(2026, 8, 14, 3, 30, 0));
    const result = await pruneArchives(14, dir);
    expect(result.removed).toEqual([]);
    expect(result.kept.length).toBe(1);
  });
});
