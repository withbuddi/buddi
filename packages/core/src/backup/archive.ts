/**
 * The archive itself: one gzipped tar, written and read with the `tar` every
 * Unix already has.
 *
 * No npm tar library on purpose. A backup tool that cannot be opened without
 * its own dependency tree is not a backup tool — an owner with this archive, a
 * shell and nothing else must be able to get their data out, and
 * `tar -xzf buddi-backup-….tar.gz` is that guarantee. The flags used here are
 * the intersection of bsdtar (macOS) and GNU tar (Linux).
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { DIR_MODE, memberPathProblem } from './manifest.js';

/** sha256 of a file, streamed — an artifact may be large. */
export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve);
  });
  return hash.digest('hex');
}

export interface WalkedFile {
  /** POSIX path relative to the walk root. */
  rel: string;
  abs: string;
  bytes: number;
}

/** Every regular file under `root`, sorted, with symlinks ignored. */
export async function walkFiles(root: string, prefix = ''): Promise<WalkedFile[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: WalkedFile[] = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === '.DS_Store') continue;
    const abs = path.join(root, entry.name);
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(abs, rel)));
    } else if (entry.isFile()) {
      out.push({ rel, abs, bytes: (await stat(abs)).size });
    }
  }
  return out;
}

export class TarError extends Error {}

interface SpawnResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

/** Spawn, capturing stdout as *bytes* — a tar member is not text. */
export function spawnCapture(
  command: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number; stdoutFile?: string; stdinFile?: string } = {},
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd ?? process.cwd(),
      stdio: [opts.stdinFile ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 600_000);
    if (typeof timer.unref === 'function') timer.unref();

    if (opts.stdoutFile) {
      const sink = createWriteStream(opts.stdoutFile);
      child.stdout?.pipe(sink);
    } else {
      child.stdout?.on('data', (d: Buffer) => chunks.push(d));
    }
    if (opts.stdinFile && child.stdin) {
      createReadStream(opts.stdinFile).pipe(child.stdin);
      child.stdin.on('error', () => {
        /* the child exiting early closes the pipe; the exit code is the answer */
      });
    }
    child.stderr?.on('data', (d) => (stderr += String(d)));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: Buffer.concat(chunks), stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout: Buffer.concat(chunks), stderr });
    });
  });
}

/** `tar -czf <out> -C <stage> .` — one archive of everything staged. */
export async function createArchive(stageDir: string, out: string): Promise<void> {
  await mkdir(path.dirname(out), { recursive: true, mode: DIR_MODE });
  const res = await spawnCapture('tar', ['-czf', out, '-C', stageDir, '.']);
  if (res.code !== 0) {
    throw new TarError(`tar could not write ${out} (exit ${res.code}): ${res.stderr.trim()}`);
  }
}

/**
 * The archive's members as its headers name them: read from the tar stream
 * itself, not from `tar -t`'s listing, because GNU tar silently strips a
 * leading `../` or `/` from what it prints (and from what it extracts) while
 * bsdtar prints the name as stored — the one check that exists to catch such
 * a name cannot depend on which tar is installed. ustar names and prefixes,
 * GNU long names (`L`) and pax `path` records are all honoured, so the name
 * seen here is the name any tar would try to write.
 */
export interface ArchiveMember {
  name: string;
  /** The typeflag byte as a character: `0` or NUL a file, `5` a directory, `2` a symlink, `1` a hard link. */
  type: string;
}

const BLOCK = 512;

function octal(field: Buffer): number {
  const text = field.toString('latin1').replace(/\0.*$/s, '').trim();
  if (text === '') return 0;
  // GNU base-256 for sizes over 8 GB: the high bit set on the first byte.
  if ((field[0]! & 0x80) !== 0) {
    let value = 0;
    for (const byte of field.subarray(1)) value = value * 256 + byte;
    return value;
  }
  return parseInt(text, 8) || 0;
}

function field(block: Buffer, offset: number, length: number): string {
  return block.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/s, '');
}

export async function readMembers(archive: string): Promise<ArchiveMember[]> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    createReadStream(archive)
      .on('error', reject)
      .pipe(createGunzip())
      .on('error', (err) => reject(new TarError(`could not read ${archive}: ${err.message}`)))
      .on('data', (chunk: Buffer) => chunks.push(chunk))
      .on('end', resolve);
  });
  const bytes = Buffer.concat(chunks);
  const members: ArchiveMember[] = [];
  let at = 0;
  let longName: string | undefined;
  let paxPath: string | undefined;
  while (at + BLOCK <= bytes.length) {
    const block = bytes.subarray(at, at + BLOCK);
    at += BLOCK;
    if (block.every((b) => b === 0)) continue; // end-of-archive padding
    const size = octal(block.subarray(124, 12 + 124));
    const type = String.fromCharCode(block[156]!) || '0';
    const dataBlocks = Math.ceil(size / BLOCK);
    const data = bytes.subarray(at, at + size);
    at += dataBlocks * BLOCK;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'x' || type === 'g') {
      // pax records: `<len> <key>=<value>\n`; only `path` matters here.
      for (const record of data.toString('utf8').split('\n')) {
        const m = /^\d+ path=(.*)$/.exec(record);
        if (m && type === 'x') paxPath = m[1];
      }
      continue;
    }
    let name = field(block, 0, 100);
    if (field(block, 257, 6) === 'ustar') {
      const prefix = field(block, 345, 155);
      if (prefix !== '') name = `${prefix}/${name}`;
    }
    if (longName !== undefined) { name = longName; longName = undefined; }
    if (paxPath !== undefined) { name = paxPath; paxPath = undefined; }
    members.push({ name, type: type === '\0' ? '0' : type });
  }
  return members;
}

/** Member names, `./` stripped, directories left out — what `verify` compares. */
export async function listMembers(archive: string): Promise<string[]> {
  return (await readMembers(archive))
    .filter((m) => m.type !== '5' && !m.name.endsWith('/'))
    .map((m) => m.name.replace(/^\.\//, '').trim())
    .filter((name) => name !== '' && name !== '.');
}

/**
 * Everything wrong with an archive's member list, before a byte is unpacked.
 *
 * `tar -xzf` happily writes `../../etc/whatever` and follows a symlink out of
 * the extraction directory, and a restore is the one moment an owner takes an
 * archive from somewhere else — a laptop, a USB stick, an upload — and hands it
 * to a process that can write anywhere. So the member list is read first and
 * anything that could land outside the directory is a refusal, not a warning.
 *
 * Links of any kind are refused wholesale: a buddi backup holds regular files
 * and directories, so a link in one did not come from `createBackup`.
 */
export async function archiveSafetyProblems(archive: string): Promise<string[]> {
  const problems: string[] = [];
  let links = 0;
  for (const member of await readMembers(archive)) {
    if (member.type === '1' || member.type === '2') {
      links += 1;
      continue;
    }
    const relative = member.name.replace(/^\.\//, '').replace(/\/$/, '');
    // `./` itself: the archive's own root, which every tar writes.
    if (relative === '' || relative === '.') continue;
    const problem = memberPathProblem(relative);
    if (problem !== null) problems.push(problem);
  }
  if (links > 0) {
    problems.push(`${links} link(s): a buddi archive holds regular files only`);
  }
  return problems;
}

/** One member's bytes, without unpacking the rest. */
export async function readMember(archive: string, member: string): Promise<Buffer> {
  const res = await spawnCapture('tar', ['-xzOf', archive, `./${member}`]);
  if (res.code !== 0 || res.stdout.length === 0) {
    // bsdtar wants `./name`, GNU tar is happy with either; try the bare form.
    const retry = await spawnCapture('tar', ['-xzOf', archive, member]);
    if (retry.code !== 0) {
      throw new TarError(
        `${member} is not in ${path.basename(archive)} (${retry.stderr.trim() || res.stderr.trim()})`,
      );
    }
    return retry.stdout;
  }
  return res.stdout;
}

/** Unpack the whole archive into `dest` (created if missing, mode 0700). */
export async function extractAll(archive: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true, mode: DIR_MODE });
  const res = await spawnCapture('tar', ['-xzf', archive, '-C', dest]);
  if (res.code !== 0) {
    throw new TarError(`tar could not unpack ${archive} (exit ${res.code}): ${res.stderr.trim()}`);
  }
}

/** Is `tar` on PATH at all? Answered once, so a missing one is a sentence. */
export async function tarAvailable(): Promise<boolean> {
  const res = await spawnCapture('tar', ['--version'], { timeoutMs: 15_000 });
  return res.code === 0;
}
