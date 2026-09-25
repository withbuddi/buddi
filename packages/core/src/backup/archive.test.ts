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
import { gzipSync } from 'node:zlib';
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
    // Written by hand: `createArchive` cannot produce this, which is the
    // point — such an archive did not come from buddi. A raw ustar header
    // rather than `tar`, because GNU tar strips a leading `../` from what it
    // is told to add (and from what it lists), and bsdtar does not.
    const archive = path.join(dir, 'escape.tar.gz');
    await writeFile(archive, rawTarGz([{ name: '../evil.txt', body: 'somebody else\n' }]));
    const problems = await archiveSafetyProblems(archive);
    expect(problems.join()).toContain('climbs out');
    expect(await listMembers(archive)).toEqual(['../evil.txt']);
  });

  it('reads the name any tar would write: ustar prefixes and pax paths', async () => {
    const long = `${'d'.repeat(60)}/${'f'.repeat(60)}.txt`;
    const archive = path.join(dir, 'long.tar.gz');
    await writeFile(archive, rawTarGz([{ name: long, body: 'x', pax: true }]));
    expect(await listMembers(archive)).toEqual([long]);
  });

  it('refuses an archive that holds a link', async () => {
    await symlink('/etc/passwd', path.join(stage, 'sneaky'));
    const archive = path.join(dir, 'link.tar.gz');
    await createArchive(stage, archive);
    expect((await archiveSafetyProblems(archive)).join()).toContain('link');
  });
});

/** A gzipped tar built by hand: ustar headers, one per entry, and an optional pax path record. */
function rawTarGz(entries: Array<{ name: string; body: string; pax?: boolean }>): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, type: string): Buffer => {
    const block = Buffer.alloc(512);
    block.write(name.slice(0, 100), 0, 'utf8');
    block.write('0000644\0', 100, 'latin1');
    block.write('0000000\0', 108, 'latin1');
    block.write('0000000\0', 116, 'latin1');
    block.write(size.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
    block.write('00000000000\0', 136, 'latin1');
    block.write('        ', 148, 'latin1');
    block.write(type, 156, 'latin1');
    block.write('ustar\0', 257, 'latin1');
    block.write('00', 263, 'latin1');
    let sum = 0;
    for (const b of block) sum += b;
    block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
    return block;
  };
  const padded = (data: Buffer): Buffer => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  for (const entry of entries) {
    if (entry.pax) {
      const record = ` path=${entry.name}\n`;
      const length = String(record.length + String(record.length + 2).length).length + record.length;
      const line = `${length}${record}`;
      const data = Buffer.from(line, 'utf8');
      blocks.push(header('./PaxHeader', data.length, 'x'), padded(data));
    }
    const data = Buffer.from(entry.body, 'utf8');
    blocks.push(header(entry.pax ? entry.name.slice(0, 99) : entry.name, data.length, '0'), padded(data));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
