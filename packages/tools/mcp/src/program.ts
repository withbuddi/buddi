/**
 * A program on this computer (docs/connections.md, "A program on this
 * computer"): an MCP server buddi starts as the owner and speaks to over its
 * standard input and output.
 *
 *  - **Started on demand**, never before the owner pressed Continue on the
 *    form that shows the whole command, and then first only to list its
 *    tools for the review.
 *  - **Its own process group** (`detached`), so stopping it stops whatever
 *    it started too (`npx` runs the server as its child): the group gets
 *    SIGTERM, and SIGKILL a few seconds later if anything is left.
 *  - **A small environment**: PATH (with the directory of the Node buddi runs
 *    on first, so `npx` is the one beside it), HOME, the user, the temporary
 *    directory and the locale, and only the variables the owner named. Secret
 *    ones are read from the vault at start and never written anywhere.
 *  - **Its working directory** is its own, under the data directory.
 *  - **Its stderr** is kept, the last twenty lines, for the connection's row
 *    when it fails. It never reaches a tool result.
 *
 * The SDK's own `StdioClientTransport` starts the program in buddi's process
 * group and kills only the one process, so this is a small transport of its
 * own over the SDK's framing.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { CLIENT_INFO, type Opened } from './session.js';
import type { ProgramSpec } from './store.js';

/** The first start may download the server (`npx -y …`): two minutes. */
export const START_TIMEOUT_MS = 120_000;
/** The lines of stderr kept for the row. */
export const STDERR_LINES = 20;
/** How long a stopped group has between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 3_000;

/** What the owner reads for this connection's address: "this computer". */
export const PROGRAM_HOST = 'this computer';

/** The variables every program gets from buddi's own environment, when set. */
export const BASE_ENV = [
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TZ',
  // Windows needs these to start anything at all.
  'SystemRoot', 'windir', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC',
] as const;

export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** sha256 over what makes the program the one the owner reviewed: the command, its arguments, the variables' names. */
export function specHash(spec: Pick<ProgramSpec, 'command' | 'args'> & { env: ReadonlyArray<{ name: string }> }): string {
  return createHash('sha256')
    .update(JSON.stringify({ command: spec.command, args: spec.args, env: spec.env.map((e) => e.name) }))
    .digest('hex');
}

/** One word as a shell would need it written. */
function quoted(word: string): string {
  if (word !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The command line in full, as the form and the review show it. */
export function commandLine(spec: Pick<ProgramSpec, 'command' | 'args'>): string {
  return [spec.command, ...spec.args].map(quoted).join(' ');
}

/**
 * The program's environment: PATH with the running Node's directory first,
 * the basics from `BASE_ENV`, and the named variables, which win.
 */
export function childEnv(
  named: Readonly<Record<string, string>>,
  base: NodeJS.ProcessEnv = process.env,
  execPath: string = process.execPath,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of BASE_ENV) {
    const value = base[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  const inherited = (base.PATH ?? base.Path ?? '').split(path.delimiter).filter(Boolean);
  const fallback = process.platform === 'win32' ? [] : ['/usr/local/bin', '/usr/bin', '/bin'];
  const dirs = [path.dirname(execPath), ...(inherited.length > 0 ? inherited : fallback)];
  env.PATH = [...new Set(dirs)].join(path.delimiter);
  return { ...env, ...named };
}

/** The last lines a program wrote to stderr, with the secrets it was given taken out. */
export class StderrTail {
  #lines: string[] = [];
  #partial = '';
  constructor(private readonly hide: readonly string[] = [], private readonly max = STDERR_LINES) {}

  push(chunk: Buffer | string): void {
    const text = this.#partial + chunk.toString();
    const parts = text.split(/\r?\n/);
    this.#partial = (parts.pop() ?? '').slice(-2000);
    for (const line of parts) this.#add(line);
  }

  #add(line: string): void {
    let clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
    for (const secret of this.hide) if (secret.length >= 4) clean = clean.split(secret).join('…');
    clean = clean.trimEnd();
    if (clean === '') return;
    this.#lines.push(clean.length > 500 ? `${clean.slice(0, 500)}…` : clean);
    if (this.#lines.length > this.max) this.#lines.splice(0, this.#lines.length - this.max);
  }

  lines(): string[] {
    const out = [...this.#lines];
    if (this.#partial.trim()) {
      const tail = new StderrTail(this.hide, 1);
      tail.push(`${this.#partial}\n`);
      out.push(...tail.lines());
    }
    return out.slice(-this.max);
  }
}

/* ------------------------------------------------------------------ *
 * The groups this process started, stopped when it exits
 * ------------------------------------------------------------------ */

const groups = new Set<number>();
let exitHook = false;

function track(pid: number): void {
  groups.add(pid);
  if (exitHook) return;
  exitHook = true;
  // Nothing asynchronous runs on `exit`: the groups get SIGKILL there, for
  // the case where buddi stops without its orderly shutdown.
  process.once('exit', () => { for (const pid of groups) killGroup(pid, 'SIGKILL'); });
}

/** Signal the whole group; the process alone where groups do not exist. */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/** Whether any process of the group is still alive. */
export function groupAlive(pid: number): boolean {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The groups started and not yet stopped (tests). */
export function liveGroups(): number[] { return [...groups]; }

export interface ProgramOptions {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  cwd: string;
  tail: StderrTail;
}

/** The MCP stdio framing over a program in its own process group. */
export class ProgramTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;
  #child: ChildProcess | undefined;
  #pid: number | undefined;
  #exited: Promise<void> | undefined;
  readonly #buffer = new ReadBuffer();

  constructor(private readonly opts: ProgramOptions) {}

  get pid(): number | undefined { return this.#pid; }

  start(): Promise<void> {
    if (this.#child) throw new Error('The program is already started.');
    return new Promise((resolve, reject) => {
      let started = false;
      const child = spawn(this.opts.command, [...this.opts.args], {
        cwd: this.opts.cwd,
        env: this.opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
        shell: false,
      });
      this.#child = child;
      this.#exited = new Promise((done) => child.once('close', () => done()));
      child.once('error', (error) => {
        const err = (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error(`${this.opts.command} was not found on this computer.`)
          : error;
        if (!started) reject(err);
        this.onerror?.(err);
      });
      child.once('spawn', () => {
        started = true;
        if (child.pid !== undefined) {
          this.#pid = child.pid;
          track(child.pid);
        }
        resolve();
      });
      child.once('close', (code, signal) => {
        // The group stays tracked until `close`: something the program
        // started may outlive it.
        if (code !== null && code !== 0) this.opts.tail.push(`\n(the program stopped with exit code ${code})\n`);
        else if (signal && signal !== 'SIGTERM' && signal !== 'SIGKILL') this.opts.tail.push(`\n(the program stopped on ${signal})\n`);
        this.#child = undefined;
        this.onclose?.();
      });
      child.stdout?.on('data', (chunk: Buffer) => {
        this.#buffer.append(chunk);
        this.#drain();
      });
      child.stderr?.on('data', (chunk: Buffer) => this.opts.tail.push(chunk));
      child.stdin?.on('error', (error) => this.onerror?.(error));
      child.stdout?.on('error', (error) => this.onerror?.(error));
    });
  }

  #drain(): void {
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.#buffer.readMessage();
      } catch (error) {
        // A line that is not JSON-RPC (a banner on stdout): noted, and read past.
        this.opts.tail.push(`\n(a line on its output was not MCP)\n`);
        this.onerror?.(error as Error);
        continue;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.#child?.stdin;
      if (!stdin || stdin.destroyed) { reject(new Error('The program is not running.')); return; }
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once('drain', resolve);
    });
  }

  /** Stop the whole group: SIGTERM, then SIGKILL after the grace period. */
  async close(): Promise<void> {
    const pid = this.#pid;
    const child = this.#child;
    this.#buffer.clear();
    if (child) {
      child.stdin?.end();
      child.stdout?.removeAllListeners('data');
    }
    if (pid === undefined) return;
    killGroup(pid, 'SIGTERM');
    const exited = this.#exited ?? Promise.resolve();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, KILL_GRACE_MS); timer.unref?.(); })]);
    if (timer) clearTimeout(timer);
    // The leader may be gone while something it started lives on in the group.
    if (groupAlive(pid)) killGroup(pid, 'SIGKILL');
    groups.delete(pid);
  }
}

export interface OpenedProgram extends Opened {
  pid: number | undefined;
}

/** Start the program and `initialize` it, and nothing else. */
export async function openProgram(opts: ProgramOptions & { timeoutMs?: number; onExit?: () => void }): Promise<OpenedProgram> {
  const transport = new ProgramTransport(opts);
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: opts.timeoutMs ?? START_TIMEOUT_MS });
  } catch (error) {
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
    throw error;
  }
  let exited = false;
  let closing = false;
  // The program stopped by itself: the session is dead, and the next call starts it again.
  client.onclose = () => {
    exited = true;
    if (!closing) opts.onExit?.();
  };
  return {
    client,
    pid: transport.pid,
    unauthorized: () => null,
    closed: () => exited,
    close: async () => {
      closing = true;
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
    },
  };
}
