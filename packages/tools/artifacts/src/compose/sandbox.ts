/**
 * Running a compose program confined (docs/files.md, "Composed documents").
 *
 * Two layers, both buddi's own:
 *
 *  - **Node's permission model**, inside: a child `node --permission` that
 *    may read only its work folder and the real folders of the allowed
 *    libraries (`libraries.ts`); no `--allow-fs-write`, child processes,
 *    workers, addons, WASI or inspector; on Node 25 and later no network
 *    either (`--allow-net` is absent, so it is denied);
 *    `--disallow-code-generation-from-strings` (no `eval`, no
 *    `new Function`); a 384 MB heap.
 *  - **The OS confinement skill scripts run under**, outside, where there is
 *    one: `sandbox-exec` on macOS, bubblewrap on Linux (`@buddi/tool-host`),
 *    with the network denied and only the system, Node, the libraries and
 *    the work folder readable.
 *
 * With neither the OS layer nor a Node that denies the network, compose is
 * off and says why (`composeAvailability`). Windows on Node 26 runs with the
 * Node layer alone.
 *
 * The child gets `PATH` and nothing else of buddi's environment: no keys.
 * 20 s on the clock (then SIGKILL), at most 20 MB back on fd 3, 64 KB of
 * stdout and of stderr kept (their tail).
 */
import { spawn } from 'node:child_process';
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OFFICE_PREVIEW_BYTES } from '@buddi/core/plugin';
import { confinementArgv, detectConfinement, type Confinement } from '@buddi/tool-host/confinement';
import { libraryClosure, type ComposeKind } from './libraries.js';
import { RUNNER_SOURCE } from './runner.js';

export const COMPOSE_LIMITS = {
  timeoutMs: 20_000,
  heapMb: 384,
  /** The file a program may return: what a preview draws (`OFFICE_PREVIEW_BYTES`). */
  outputBytes: OFFICE_PREVIEW_BYTES,
  programBytes: 200 * 1024,
  /** What is kept of stdout and of stderr, each: the tail. */
  consoleBytes: 64 * 1024,
  attachmentsBytes: 20 * 1024 * 1024,
  /** Runs at once in the whole service. */
  concurrent: 4,
} as const;

/** The Node that can deny the network by itself (`--permission` without `--allow-net`). */
const NETWORK_DENIED_FROM = 25;
/** `module.registerHooks`, in-thread and synchronous, which the runner resolves imports with. */
const NODE_MINIMUM = { major: 22, minor: 15 };

export interface ComposeAvailability {
  available: boolean;
  /** The OS layer this computer offers, or null. */
  confinement: Confinement | null;
  /** This Node denies the network under `--permission`. */
  networkDenied: boolean;
  nodeVersion: string;
  /** Why compose is off, when it is: one sentence for the agent and the doctor. */
  reason?: string;
  /** What holds when it runs, for the doctor. */
  detail: string;
}

/** Whether compose can run here, and under which layers. */
export function composeAvailability(opts: { platform?: NodeJS.Platform; nodeVersion?: string; confinement?: Confinement | null } = {}): ComposeAvailability {
  const platform = opts.platform ?? process.platform;
  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  const confinement = opts.confinement === undefined ? detectConfinement(platform) : opts.confinement;
  const [major = 0, minor = 0] = nodeVersion.split('.').map(Number);
  const networkDenied = major >= NETWORK_DENIED_FROM;
  const base = { confinement, networkDenied, nodeVersion };
  if (major < NODE_MINIMUM.major || (major === NODE_MINIMUM.major && minor < NODE_MINIMUM.minor)) {
    const reason = `Composed documents need Node ${NODE_MINIMUM.major}.${NODE_MINIMUM.minor} or newer; this buddi runs on Node ${nodeVersion}.`;
    return { ...base, available: false, reason, detail: reason };
  }
  if (confinement === null && !networkDenied) {
    const fix = platform === 'linux' ? ' Install bubblewrap (`apt install bubblewrap`), or run buddi on Node 25 or newer.' : ' Run buddi on Node 25 or newer.';
    const reason = `Composed documents are off here: this computer has no sandbox to keep a program off the network, and Node ${nodeVersion} cannot deny it by itself.${fix}`;
    return { ...base, available: false, reason, detail: reason };
  }
  const os = confinement === 'macos-sandbox' ? 'the macOS sandbox' : confinement === 'bwrap' ? 'bubblewrap' : null;
  const detail = os
    ? `programs run under Node ${nodeVersion}'s permission model inside ${os}: no writes, processes or network`
    : `programs run under Node ${nodeVersion}'s permission model only (no OS sandbox on this computer): no writes, processes or network`;
  return { ...base, available: true, detail };
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

interface ChildError { name?: string; message?: string; code?: string; permission?: string; resource?: string; stack?: string; shape?: boolean; tooLarge?: boolean }

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
};

/**
 * The program's error as the model can fix it: its message, and the stack
 * cut to `program.mjs`'s own frames with their line and column — never a
 * path of buddi's.
 */
function childFailure(error: ChildError, work: string): { code: ComposeErrorCode; message: string } {
  if (error.tooLarge) return { code: 'too_large', message: `the program returned more than ${COMPOSE_LIMITS.outputBytes / 1024 / 1024} MB; a document that large is not previewed or sent. Use smaller images.` };
  if (error.code === 'ERR_ACCESS_DENIED') {
    const what = ATTEMPT[error.permission ?? ''] ?? 'reach outside its sandbox';
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
export function nodeFlags(work: string, grants: readonly string[], availability: Pick<ComposeAvailability, 'networkDenied'>): string[] {
  return [
    '--permission',
    `--allow-fs-read=${work}`,
    ...grants.map((dir) => `--allow-fs-read=${dir}`),
    '--disallow-code-generation-from-strings',
    `--max-old-space-size=${COMPOSE_LIMITS.heapMb}`,
    // Node 25+ warns at start that localStorage has no file; there is no storage to give.
    ...(availability.networkDenied ? ['--no-experimental-webstorage'] : []),
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
 * data folder), and remove the folder after. `availability` is passed in
 * tests; otherwise this computer's.
 */
export async function runCompose(input: {
  kind: ComposeKind;
  program: string;
  attachments: readonly ComposeAttachment[];
  root: string;
  conversationId?: string;
  availability?: ComposeAvailability;
  limits?: { timeoutMs?: number; heapMb?: number };
}): Promise<ComposeRun> {
  const availability = input.availability ?? composeAvailability();
  const quiet = { stdout: '', stderr: '' };
  if (!availability.available) return { ok: false, code: 'unavailable', message: availability.reason ?? 'composed documents are off here', console: quiet };
  return slot(input.conversationId, async () => {
    await mkdir(input.root, { recursive: true });
    const work = path.join(await realpath(input.root), `run-${randomUUID()}`);
    await mkdir(work);
    try {
      return await runIn(work, input, availability);
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => {});
    }
  });
}

async function runIn(
  work: string,
  input: { kind: ComposeKind; program: string; attachments: readonly ComposeAttachment[]; limits?: { timeoutMs?: number; heapMb?: number } },
  availability: ComposeAvailability,
): Promise<ComposeRun> {
  const closure = libraryClosure();
  const attachments = input.attachments.map((a, i) => ({
    fileId: a.fileId, name: a.name, mime: a.mime, type: a.type, width: a.width, height: a.height, file: `attachment-${i + 1}`,
  }));
  await Promise.all(input.attachments.map((a, i) => writeFile(path.join(work, `attachment-${i + 1}`), a.bytes)));
  await writeFile(path.join(work, 'program.mjs'), input.program);
  await writeFile(path.join(work, 'run.mjs'), RUNNER_SOURCE);
  await writeFile(path.join(work, 'plan.json'), JSON.stringify({
    kind: input.kind, top: closure.top, deps: closure.deps, attachments, maxBytes: COMPOSE_LIMITS.outputBytes,
  }));

  const timeoutMs = input.limits?.timeoutMs ?? COMPOSE_LIMITS.timeoutMs;
  const heapMb = input.limits?.heapMb ?? COMPOSE_LIMITS.heapMb;
  const flags = nodeFlags(work, closure.grants, availability).map((flag) => flag.startsWith('--max-old-space-size=') ? `--max-old-space-size=${heapMb}` : flag);
  const node = [process.execPath, ...flags, path.join(work, 'run.mjs')];
  const argv = availability.confinement
    ? [...confinementArgv(availability.confinement, work, { readable: closure.grants }), ...node]
    : node;
  const stdout = new Tail(COMPOSE_LIMITS.consoleBytes);
  const stderr = new Tail(COMPOSE_LIMITS.consoleBytes);
  const console = (): { stdout: string; stderr: string } => ({ stdout: scrubPaths(stdout.text(), work), stderr: scrubPaths(stderr.text(), work) });

  return new Promise<ComposeRun>((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: work,
      env: { PATH: process.env.PATH ?? '', NODE_OPTIONS: '' },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let received = 0;
    let ended: { code: ComposeErrorCode; message: string } | null = null;
    const stop = (why: { code: ComposeErrorCode; message: string }): void => {
      if (ended === null) ended = why;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => stop({ code: 'timeout', message: `the program ran for more than ${timeoutMs / 1000} s and was stopped. Keep it to building the document: no loops waiting on anything.` }), timeoutMs);
    child.stdout!.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr!.on('data', (chunk: Buffer) => stderr.push(chunk));
    const out = child.stdio[3] as NodeJS.ReadableStream;
    out.on('data', (chunk: Buffer) => {
      received += chunk.length;
      // A frame header, the bytes, and a little room: past that the child is not the runner talking.
      if (received > COMPOSE_LIMITS.outputBytes + 64 * 1024) {
        stop({ code: 'too_large', message: `the program returned more than ${COMPOSE_LIMITS.outputBytes / 1024 / 1024} MB; a document that large is not previewed or sent. Use smaller images.` });
        return;
      }
      chunks.push(chunk);
    });
    out.on('error', () => {});
    child.on('error', (err) => stop({ code: 'unavailable', message: `the program could not be started (${err.message})` }));
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (ended) return resolve({ ok: false, ...ended, console: console() });
      const frame = firstFrame(Buffer.concat(chunks));
      if (frame?.type === 'B' && exitCode === 0) return resolve({ ok: true, bytes: frame.payload, console: console() });
      if (frame?.type === 'E') {
        let error: ChildError = {};
        try { error = JSON.parse(frame.payload.toString('utf8')) as ChildError; } catch { /* a frame cut short */ }
        return resolve({ ok: false, ...childFailure(error, work), console: console() });
      }
      const err = stderr.text();
      if (/heap limit|heap out of memory|Allocation failed/i.test(err)) {
        return resolve({ ok: false, code: 'memory', message: `the program used more than ${heapMb} MB of memory and was stopped. Build the document with less data held at once (smaller images, fewer copies).`, console: console() });
      }
      // The runner did not get to say anything: a syntax error Node printed itself, or a crash.
      const syntax = /SyntaxError: [^\n]+/.exec(err);
      if (syntax) return resolve({ ok: false, code: 'program_error', message: `${scrubPaths(syntax[0], work)}${syntaxPosition(err, work)}`, console: console() });
      return resolve({ ok: false, code: 'program_error', message: `the program stopped without returning a file (exit ${exitCode ?? signal ?? 'unknown'}).`, console: console() });
    });
  });
}

/** The first whole frame fd 3 carried, or null. */
function firstFrame(buffer: Buffer): { type: string; payload: Buffer } | null {
  if (buffer.length < 5) return null;
  const length = buffer.readUInt32BE(1);
  if (buffer.length < 5 + length) return null;
  return { type: buffer.subarray(0, 1).toString('latin1'), payload: buffer.subarray(5, 5 + length) };
}
