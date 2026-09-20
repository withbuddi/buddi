/**
 * The one thing that has to be true before `tar -xzf` runs as this process:
 * every member of the archive lands inside the directory we point it at.
 *
 * A restore is the moment an archive from somewhere else — a laptop, a USB
 * stick, an upload — is handed to a process that can write anywhere, so the
 * member list is read first and anything that could escape is a refusal.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { archiveSafetyProblems, createArchive, listMembers, spawnCapture } from './archive.js';

describe('the member list, before anything is unpacked', () => {
  let dir: string;
  let stage: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'buddi-archive-'));
    stage = path.join(dir, 'stage');
    await mkdir(path.join(stage, 'db'), { recursive: true });
    await writeFile(path.join(stage, 'manifest.json'), '{}\n');
    await writeFile(path.join(stage, 'db', 'core.events.copy'), '');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes an archive this build wrote', async () => {
    const archive = path.join(dir, 'good.tar.gz');
    await createArchive(stage, archive);
    expect(await archiveSafetyProblems(archive)).toEqual([]);
    expect(await listMembers(archive)).toContain('manifest.json');
  });

  it('refuses a member that climbs out of the extraction directory', async () => {
    // Written with `tar` directly: `createArchive` cannot produce this, which
    // is the point — such an archive did not come from buddi.
    await writeFile(path.join(dir, 'evil.txt'), 'somebody else\n');
    const archive = path.join(dir, 'escape.tar.gz');
    const res = await spawnCapture('tar', ['-czf', archive, '-C', stage, '.', '-C', dir, '../evil.txt']);
    // bsdtar and GNU tar disagree about relative `-C` hops; fall back to the
    // transform every tar has when the direct form is refused.
    if (res.code !== 0) {
      await spawnCapture('tar', [
        '-czf',
        archive,
        '-C',
        dir,
        '-s',
        '|^evil|../evil|',
        'evil.txt',
      ]);
    }
    const problems = await archiveSafetyProblems(archive);
    expect(problems.join()).toContain('climbs out');
  });

  it('refuses an archive that holds a link', async () => {
    await symlink('/etc/passwd', path.join(stage, 'sneaky'));
    const archive = path.join(dir, 'link.tar.gz');
    await createArchive(stage, archive);
    expect((await archiveSafetyProblems(archive)).join()).toContain('link');
  });
});
