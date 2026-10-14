/**
 * Running a compose program confined (docs/files.md, "Composed documents").
 *
 * The boundary is the OS sandbox skill scripts run under — `sandbox-exec`
 * on macOS, bubblewrap on Linux (`ctx.buddi.confinement`, the host
 * plugin's): network denied, nothing of the owner's readable, no other
 * process. Without one compose does not run, Windows included: Node's
 * permission model is not a boundary by itself (an SQL `ATTACH` through
 * `node:sqlite` is outside its checks).
 *
 * Inside it, defence in depth:
 *
 *  - **Node's permission model**: a child `node --permission` that may read
 *    only its work folder and the real folders of the allowed libraries
 *    (`libraries.ts`); no `--allow-fs-write`, child processes, workers,
 *    addons, WASI or inspector; on Node 25+ no network either;
 *    `--disallow-code-generation-from-strings`; a 384 MB heap. Only a Node
 *    with this year's permission-model fixes (`NODE_FLOORS`).
 *  - **The runner** (`runner.ts`) lets a program and its library load only
 *    `COMPOSE_BUILTINS` of Node's built-ins, and removes what reaches around
 *    that (`process.getBuiltinModule`, `binding`, `dlopen`, `report`, the
 *    network globals) before the program runs.
 *  - **Limits**: 20 s on the clock and 30 s of CPU, the process group's
 *    resident memory sampled every 100 ms and the group killed past 512 MB
 *    (the heap limit does not count Buffers), on Linux a 1 GB data limit
 *    too; at most 20 MB back on fd 3, framed and checked; 64 KB of stdout
 *    and of stderr kept (their tail). The child gets `PATH` and nothing else
 *    of buddi's environment: no keys.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OFFICE_PREVIEW_BYTES, type ConfinementArea } from '@buddi/core/plugin';
import { libraryClosure, type ComposeKind } from './libraries.js';
import { RUNNER_SOURCE } from './runner.js';

export const COMPOSE_LIMITS = {
  timeoutMs: 20_000,
  heapMb: 384,
  /** The process group's resident memory, at most: Buffers live outside the heap. */
  rssMb: 512,
  /** CPU seconds (`ulimit -t`), a backstop behind the wall clock. */
  cpuSeconds: 30,
  /** Linux's data-segment limit (`ulimit -d`), which bounds what malloc and Buffers can take. */
  dataMb: 1024,
  /** The file a program may return: what a preview draws (`OFFICE_PREVIEW_BYTES`). */
  outputBytes: OFFICE_PREVIEW_BYTES,
  programBytes: 200 * 1024,
  /** What is kept of stdout and of stderr, each: the tail. */
  consoleBytes: 64 * 1024,
  attachmentsBytes: 20 * 1024 * 1024,
  /** Runs at once in the whole service. */
  concurrent: 4,
} as const;

/** The Node that also denies the network by itself (`--permission` without `--allow-net`). */
const NETWORK_DENIED_FROM = 25;

/**
 * The oldest patch of each release line compose runs on: the July 2026
 * security releases, which fixed the permission model's path matching
 * (CVE-2026-58043), its report writes (CVE-2026-58039) and trace writes
 * (CVE-2026-56847). A line not named (odd, end-of-life ones) does not run;
 * a later even line does. `module.registerHooks` is in all of them.
 */
export const NODE_FLOORS: Readonly<Record<number, string>> = { 22: '22.23.2', 24: '24.18.1', 26: '26.5.1' };

/** The built-ins a program and its library may load: what docx and pptxgenjs were traced to use, and nothing with I/O. */
export const COMPOSE_BUILTINS = ['buffer', 'events', 'path', 'stream', 'string_decoder', 'url', 'util'] as const;

export interface ComposeAvailability {
  available: boolean;
  /** The OS sandbox this computer offers, or null. */
  confinement: ConfinementArea['kind'];
  /** This Node denies the network under `--permission` too. */
  networkDenied: boolean;
  nodeVersion: string;
  /** Why compose is off, when it is: one sentence for the agent and the doctor. */
  reason?: string;
  /** What holds when it runs, for the doctor. */
  detail: string;
}

const parse = (v: string): number[] => v.replace(/^v/, '').split('.').map((n) => Number(n) || 0);
const atLeast = (have: number[], want: number[]): boolean => {
  for (let i = 0; i < 3; i++) if ((have[i] ?? 0) !== (want[i] ?? 0)) return (have[i] ?? 0) > (want[i] ?? 0);
  return true;
};

/** Whether this Node has the permission model's security fixes, or why not. */
export function nodeFloorProblem(nodeVersion: string): string | null {
  const have = parse(nodeVersion);
  const major = have[0]!;
  const floor = NODE_FLOORS[major];
  const newest = Math.max(...Object.keys(NODE_FLOORS).map(Number));
  if (floor !== undefined) return atLeast(have, parse(floor)) ? null : `Composed documents need Node ${floor} or newer on the ${major}.x line (its permission-model security fixes); this buddi runs on Node ${nodeVersion}.`;
  if (major > newest) return null;
  return `Composed documents need a maintained Node with this year's permission-model fixes (${Object.values(NODE_FLOORS).join(', ')} or newer); this buddi runs on Node ${nodeVersion}.`;
}

/**
 * Whether compose can run here. `confinement` is the OS sandbox this
 * computer has (`ctx.buddi.confinement.kind`); without one it is off.
 */
export function composeAvailability(opts: { confinement: ConfinementArea['kind']; platform?: NodeJS.Platform; nodeVersion?: string }): ComposeAvailability {
  const platform = opts.platform ?? process.platform;
  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  const confinement = opts.confinement;
  const networkDenied = parse(nodeVersion)[0]! >= NETWORK_DENIED_FROM;
  const base = { confinement, networkDenied, nodeVersion };
  if (confinement === null) {
    const reason = platform === 'win32'
      ? 'Composed documents need an OS sandbox to run a program in, and Windows has none buddi can use yet (Windows support is planned); agents write Word files from Markdown instead.'
      : platform === 'linux'
        ? 'Composed documents need an OS sandbox to run a program in: install bubblewrap (`apt install bubblewrap`) and restart buddi; until then agents write Word files from Markdown.'
        : 'Composed documents need an OS sandbox to run a program in, and this computer has none; agents write Word files from Markdown instead.';
    return { ...base, available: false, reason, detail: reason };
  }
  const floor = nodeFloorProblem(nodeVersion);
  if (floor) return { ...base, available: false, reason: floor, detail: floor };
  const os = confinement === 'macos-sandbox' ? 'the macOS sandbox' : 'bubblewrap';
  return { ...base, available: true, detail: `programs run inside ${os} under Node ${nodeVersion}'s permission model: no writes, processes or network` };
}

/** One image the program is handed in `ctx.files`. */
export interface ComposeAttachment {
  fileId: string;
  name: string;
  mime: string;
  /** What `docx`'s ImageRun calls the format: png, jpg, gif, bmp. */
  type: string;
  width: number | null;
  height: number | null;
  bytes: Buffer;
}

/** How a run ended, as the model is told it. */
export type ComposeErrorCode = 'program_error' | 'forbidden' | 'timeout' | 'memory' | 'too_large' | 'unavailable';

export type ComposeRun =
  | { ok: true; bytes: Buffer; console: { stdout: string; stderr: string } }
  | { ok: false; code: ComposeErrorCode; message: string; console: { stdout: string; stderr: string } };

interface ChildError { name?: string; message?: string; code?: string; permission?: string; builtin?: string; stack?: string; shape?: boolean; tooLarge?: boolean }

/** The tail of what a stream wrote, at most `limit` bytes. */
class Tail {
  #chunks: Buffer[] = [];
  #size = 0;
  #cut = false;
  constructor(readonly limit: number) {}
  push(chunk: Buffer): void {
    this.#chunks.push(chunk);
    this.#size += chunk.length;
    while (this.#size > this.limit && this.#chunks.length > 1) { this.#size -= this.#chunks.shift()!.length; this.#cut = true; }
  }
  text(): string {
    let out = Buffer.concat(this.#chunks);
    if (out.length > this.limit) { out = out.subarray(out.length - this.limit); this.#cut = true; }
    return (this.#cut ? '…' : '') + out.toString('utf8');
  }
}

/** Every buddi path a message may carry, replaced: the work folder by nothing, any other absolute path by `<buddi>`. */
export function scrubPaths(text: string, work: string): string {
  const url = `file://${work.split(path.sep).join('/')}/`;
  return text
    .split(url).join('')
    .split(`${work}${path.sep}`).join('')
    .split(work).join('.')
    .replace(/file:\/\/\/[^\s'")]+/g, '<buddi>')
    .replace(/(^|[\s'"(])(?:\/(?:Users|home|private|var|opt|usr|Applications|tmp|Library|root)\/[^\s'")]*|[A-Za-z]:\\[^\s'")]*)/g, '$1<buddi>');
}

/** What a denied access was, said as what the program tried to do. */
const ATTEMPT: Record<string, string> = {
  FileSystemRead: 'read a file outside its library',
  FileSystemWrite: 'write a file',
  ChildProcess: 'start another process',
  WorkerThreads: 'start a worker thread',
  Net: 'use the network',
  Inspector: 'open the inspector',
  Addon: 'load a native addon',
  WASI: 'use WASI',
  Builtin: 'load a part of Node it may not use',
  Code: 'load code from somewhere other than its library (a data: URL, say)',
};

/**
 * The program's error as the model can fix it: its message, and the stack
 * cut to `program.mjs`'s own frames with their line and column — never a
 * path of buddi's.
 */
function childFailure(error: ChildError, work: string): { code: ComposeErrorCode; message: string } {
  if (error.tooLarge) return { code: 'too_large', message: `the program returned more than ${COMPOSE_LIMITS.outputBytes / 1024 / 1024} MB; a document that large is not previewed or sent. Use smaller images.` };
  if (error.code === 'ERR_ACCESS_DENIED') {
    const what = error.permission === 'Builtin' && error.builtin ? `load node:${error.builtin}` : ATTEMPT[error.permission ?? ''] ?? 'reach outside its sandbox';
    return { code: 'forbidden', message: `the program tried to ${what}; a compose program may only use its library and return the file's bytes (images come in ctx.files).` };
  }
  if (error.name === 'EvalError' && /code generation from strings/i.test(error.message ?? '')) {
    return { code: 'forbidden', message: 'the program tried to evaluate code from a string (eval, new Function); a compose program may only use its library and return the file\'s bytes.' };
  }
  const frames = String(error.stack ?? '').split('\n').slice(1)
    .filter((line) => line.includes('program.mjs'))
    .map((line) => `  ${scrubPaths(line.trim(), work).replace(/(?:\.\/)?program\.mjs:(\d+):(\d+)/, 'program.mjs:$1:$2').replace(/^at Module\.default /, 'at default ')}`)
    .slice(0, 6);
  const head = `${error.name && error.name !== 'Error' ? `${error.name}: ` : ''}${scrubPaths(error.message ?? 'the program failed', work)}`;
  const syntax = error.name === 'SyntaxError' && frames.length === 0 ? syntaxPosition(error.stack ?? '', work) : '';
  return { code: 'program_error', message: [head + syntax, ...frames].join('\n') };
}

/** A syntax error's position, which Node prints before the message rather than as a frame. */
function syntaxPosition(stack: string, work: string): string {
  const match = /program\.mjs:(\d+)(?::(\d+))?/.exec(scrubPaths(stack, work));
  return match ? ` (program.mjs:${match[1]}${match[2] ? `:${match[2]}` : ''})` : '';
}

/** The flags the child Node runs under: nothing granted but reading its folder and the libraries. */
export function nodeFlags(work: string, grants: readonly string[], opts: { networkDenied: boolean; heapMb: number }): string[] {
  return [
    '--permission',
    `--allow-fs-read=${work}`,
    ...grants.map((dir) => `--allow-fs-read=${dir}`),
    '--disallow-code-generation-from-strings',
    `--max-old-space-size=${opts.heapMb}`,
    // Node 25+ warns at start that localStorage has no file; there is no storage to give.
    ...(opts.networkDenied ? ['--no-experimental-webstorage'] : []),
  ];
}

let running = 0;
const waiting: Array<() => void> = [];
const byConversation = new Map<string, Promise<unknown>>();

/** One run at a time per conversation, `concurrent` in the whole service. */
async function slot<T>(conversation: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = conversation ? byConversation.get(conversation) : undefined;
  const mine = (async () => {
    if (before) await before.catch(() => {});
    if (running >= COMPOSE_LIMITS.concurrent) await new Promise<void>((resolve) => waiting.push(resolve));
    running++;
    try { return await fn(); } finally { running--; waiting.shift()?.(); }
  })();
  if (conversation) {
    byConversation.set(conversation, mine);
    void mine.finally(() => { if (byConversation.get(conversation) === mine) byConversation.delete(conversation); }).catch(() => {});
  }
  return mine;
}

/**
 * Run one program in a fresh work folder under `root` (the plugin's own
 * data folder), and remove the folder after, under the layers
 * `availability` names.
 */
export async function runCompose(input: {
  kind: ComposeKind;
  program: string;
  attachments: readonly ComposeAttachment[];
  root: string;
  conversationId?: string;
  availability: ComposeAvailability;
  /** The OS sandbox's argv for a work folder (`ctx.buddi.confinement.argv`). */
  confine: ConfinementArea['argv'];
  limits?: { timeoutMs?: number; heapMb?: number; rssMb?: number };
}): Promise<ComposeRun> {
  const availability = input.availability;
  const quiet = { stdout: '', stderr: '' };
  if (!availability.available || availability.confinement === null) return { ok: false, code: 'unavailable', message: availability.reason ?? 'composed documents are off here', console: quiet };
  return slot(input.conversationId, async () => {
    await mkdir(input.root, { recursive: true });
    const work = path.join(await realpath(input.root), `run-${randomUUID()}`);
    await mkdir(work);
    try {
      return await runIn(work, input, availability, input.confine);
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  });
}

async function runIn(
  work: string,
  input: { kind: ComposeKind; program: string; attachments: readonly ComposeAttachment[]; limits?: { timeoutMs?: number; heapMb?: number; rssMb?: number } },
  availability: ComposeAvailability,
  confine: ConfinementArea['argv'],
): Promise<ComposeRun> {
  const closure = libraryClosure();
  const attachments = input.attachments.map((a, i) => ({
    fileId: a.fileId, name: a.name, mime: a.mime, type: a.type, width: a.width, height: a.height, file: `attachment-${i + 1}`,
  }));
  await Promise.all(input.attachments.map((a, i) => writeFile(path.join(work, `attachment-${i + 1}`), a.bytes)));
  await writeFile(path.join(work, 'program.mjs'), input.program);
  await writeFile(path.join(work, 'run.mjs'), RUNNER_SOURCE);
  // The plan goes on fd 4, never into the work folder: it names buddi's install paths.
  const plan = JSON.stringify({
    kind: input.kind, top: closure.top, deps: closure.deps, attachments, maxBytes: COMPOSE_LIMITS.outputBytes, builtins: COMPOSE_BUILTINS,
  });

  const timeoutMs = input.limits?.timeoutMs ?? COMPOSE_LIMITS.timeoutMs;
  const heapMb = input.limits?.heapMb ?? COMPOSE_LIMITS.heapMb;
  const rssMb = input.limits?.rssMb ?? COMPOSE_LIMITS.rssMb;
  const node = [process.execPath, ...nodeFlags(work, closure.grants, { networkDenied: availability.networkDenied, heapMb }), path.join(work, 'run.mjs')];
  // Inside the sandbox, the shell sets the CPU (and on Linux the data) limit and becomes Node.
  const ulimits = [`ulimit -t ${COMPOSE_LIMITS.cpuSeconds}`, ...(process.platform === 'linux' ? [`ulimit -d ${COMPOSE_LIMITS.dataMb * 1024}`] : [])].join(' && ');
  const argv = [...confine(work, { readable: closure.grants, fork: false }), '/bin/sh', '-c', `${ulimits} && exec "$@"`, 'compose', ...node];
  const stdout = new Tail(COMPOSE_LIMITS.consoleBytes);
  const stderr = new Tail(COMPOSE_LIMITS.consoleBytes);
  const console = (): { stdout: string; stderr: string } => ({ stdout: scrubPaths(stdout.text(), work), stderr: scrubPaths(stderr.text(), work) });

  return new Promise<ComposeRun>((resolve) => {
    // Its own process group, so the whole of it — the sandbox, the shell, Node — is measured and killed together.
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: work,
      env: { PATH: process.env.PATH ?? '', NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let received = 0;
    let ended: { code: ComposeErrorCode; message: string } | null = null;
    let closed = false;
    const stop = (why: { code: ComposeErrorCode; message: string }): void => {
      if (ended === null) ended = why;
      killGroup(child);
    };
    const timer = setTimeout(() => stop({ code: 'timeout', message: `the program ran for more than ${timeoutMs / 1000} s and was stopped. Keep it to building the document: no loops waiting on anything.` }), timeoutMs);
    const tooMuchMemory = { code: 'memory' as const, message: `the program used more than ${rssMb} MB of memory and was stopped. Build the document with less held at once (smaller images, fewer copies of large buffers).` };
    // The watchdog: the group's resident memory every 100 ms, the whole group killed past the cap.
    const watch = async (): Promise<void> => {
      while (!closed && ended === null) {
        const rss = child.pid === undefined ? null : await groupRss(child.pid).catch(() => null);
        if (rss !== null && rss > rssMb * 1024 * 1024) { stop(tooMuchMemory); return; }
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    void watch();
    child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
    const planIn = child.stdio[4] as NodeJS.WritableStream;
    planIn.on('error', () => {});
    planIn.end(plan);
    const out = child.stdio[3] as NodeJS.ReadableStream;
    out.on('data', (chunk: Buffer) => {
      received += chunk.length;
      // One frame header, the bytes, and a little room: past that the child is not the runner talking.
      if (received > COMPOSE_LIMITS.outputBytes + 64 * 1024) {
        stop({ code: 'too_large', message: `the program returned more than ${COMPOSE_LIMITS.outputBytes / 1024 / 1024} MB; a document that large is not previewed or sent. Use smaller images.` });
        return;
      }
      chunks.push(chunk);
    });
    out.on('error', () => {});
    child.on('error', (err) => stop({ code: 'unavailable', message: `the program could not be started (${err.message})` }));
    child.on('close', (exitCode, signal) => {
      closed = true;
      clearTimeout(timer);
      // Whatever the child wrote, nothing it sent may throw here: a malformed answer is the program's error.
      try {
        resolve(settle(Buffer.concat(chunks), exitCode, signal));
      } catch {
        resolve({ ok: false, code: 'program_error', message: 'the program sent buddi something that is not a file or an error.', console: console() });
      }
    });
    const settle = (sent: Buffer, exitCode: number | null, signal: NodeJS.Signals | null): ComposeRun => {
      if (ended) return { ok: false, ...ended, console: console() };
      const frame = readFrame(sent);
      if (frame.kind === 'bytes' && exitCode === 0) return { ok: true, bytes: frame.bytes, console: console() };
      if (frame.kind === 'error') return { ok: false, ...childFailure(frame.error, work), console: console() };
      if (frame.kind === 'invalid') return { ok: false, code: 'program_error', message: `the program sent buddi something that is not a file or an error (${frame.why}).`, console: console() };
      const err = stderr.text();
      if (/heap limit|heap out of memory|Allocation failed|Failed to allocate memory/i.test(err)) return { ok: false, ...tooMuchMemory, console: console() };
      if (signal === 'SIGXCPU') return { ok: false, code: 'timeout', message: `the program used more than ${COMPOSE_LIMITS.cpuSeconds} s of CPU and was stopped.`, console: console() };
      // The runner did not get to say anything: a syntax error Node printed itself, or a crash.
      const syntax = /SyntaxError: [^\n]+/.exec(err);
      if (syntax) return { ok: false, code: 'program_error', message: `${scrubPaths(syntax[0], work)}${syntaxPosition(err, work)}`, console: console() };
      return { ok: false, code: 'program_error', message: `the program stopped without returning a file (exit ${exitCode ?? signal ?? 'unknown'}).`, console: console() };
    };
  });
}

/** Kill the child's whole process group: the sandbox, the shell and Node. */
function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
}

/**
 * The resident memory of every process in group `pgid`, in bytes: `ps` on
 * macOS (one call over all processes, summed by group), `/proc` on Linux.
 * `process.resourceUsage` describes buddi, not the child.
 */
export async function groupRss(pgid: number): Promise<number | null> {
  if (process.platform === 'linux') {
    let total = 0;
    for (const entry of await readdir('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const stat = await readFile(`/proc/${entry}/stat`, 'utf8').catch(() => '');
      // pid (comm) state ppid pgrp …: the command may hold spaces and parentheses, so read after the last ')'.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) !== pgid) continue;
      const status = await readFile(`/proc/${entry}/status`, 'utf8').catch(() => '');
      const rss = /^VmRSS:\s+(\d+) kB/m.exec(status);
      if (rss) total += Number(rss[1]) * 1024;
    }
    return total;
  }
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-A', '-o', 'pgid=,rss='], { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(null);
      let total = 0;
      for (const line of out.split('\n')) {
        const [group, rss] = line.trim().split(/\s+/).map(Number);
        if (group === pgid && Number.isFinite(rss)) total += rss! * 1024;
      }
      resolve(total);
    });
  });
}

type Frame =
  | { kind: 'bytes'; bytes: Buffer }
  | { kind: 'error'; error: ChildError }
  | { kind: 'none' }
  | { kind: 'invalid'; why: string };

const ERROR_FIELDS = ['name', 'message', 'code', 'permission', 'builtin', 'stack'] as const;

/**
 * What fd 3 carried, checked: exactly one whole frame, `B` with the file's
 * bytes or `E` with an error object whose fields are short strings (and two
 * flags). Anything else — a type, a length or a payload the runner never
 * writes — is `invalid`, never a throw: a program can write fd 3 itself.
 */
export function readFrame(sent: Buffer): Frame {
  if (sent.length === 0) return { kind: 'none' };
  if (sent.length < 5) return { kind: 'invalid', why: 'a cut-off frame' };
  const type = sent.subarray(0, 1).toString('latin1');
  const length = sent.readUInt32BE(1);
  if (type !== 'B' && type !== 'E') return { kind: 'invalid', why: 'an unknown frame' };
  if (sent.length !== 5 + length) return { kind: 'invalid', why: sent.length < 5 + length ? 'a cut-off frame' : 'more than one frame' };
  const payload = sent.subarray(5);
  if (type === 'B') {
    if (length === 0 || length > COMPOSE_LIMITS.outputBytes) return { kind: 'invalid', why: 'a file of the wrong size' };
    return { kind: 'bytes', bytes: payload };
  }
  if (length > 256 * 1024) return { kind: 'invalid', why: 'an error too long' };
  let parsed: unknown;
  try { parsed = JSON.parse(payload.toString('utf8')); } catch { return { kind: 'invalid', why: 'an error that is not JSON' }; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'invalid', why: 'an error that is not an object' };
  const record = parsed as Record<string, unknown>;
  const error: ChildError = {};
  for (const key of ERROR_FIELDS) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') return { kind: 'invalid', why: `an error whose ${key} is not text` };
    error[key] = value.slice(0, 16 * 1024);
  }
  if (record.shape === true) error.shape = true;
  if (record.tooLarge === true) error.tooLarge = true;
  return { kind: 'error', error };
}
