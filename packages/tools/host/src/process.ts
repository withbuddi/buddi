import { spawn } from 'node:child_process';

export interface CommandResult {
  state: 'completed' | 'cancelled' | 'timed-out' | 'output-limit';
  exitCode: number | null; signal: string | null; stdout: string; stderr: string;
}
/** No inherited API keys/database credentials, login scripts, or stdin prompts.
 * This is hygiene, NOT isolation: the process still has the user's file access. */
export function commandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (env[key]) out[key] = env[key];
  }
  out.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  out.PYTHONUNBUFFERED = '1';
  out.PIP_DISABLE_PIP_VERSION_CHECK = '1';
  return out;
}

export function runCommand(input: {
  command: string; cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv;
  signal?: AbortSignal; onOutput?: (stdout: string, stderr: string) => void;
  /** A confinement the shell runs inside (`sandbox-exec -p …`, `bwrap …`): argv before /bin/bash. */
  wrap?: readonly string[];
  /** Set after the hygiene env (a script's TMPDIR in its working folder). */
  extraEnv?: NodeJS.ProcessEnv;
}): Promise<CommandResult> {
  input.signal?.throwIfAborted();
  if (process.platform === 'win32') throw new Error('Host execution currently requires macOS or Linux.');
  return new Promise((resolve, reject) => {
    const shell = ['/bin/bash', '--noprofile', '--norc', '-c', input.command];
    const argv = input.wrap && input.wrap.length > 0 ? [...input.wrap, ...shell] : shell;
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: input.cwd, env: { ...commandEnv(input.env), ...(input.extraEnv ?? {}) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    let state: CommandResult['state'] = 'completed';
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* Already gone. */ } }
    };
    const stop = (reason: CommandResult['state']): void => {
      if (state !== 'completed') return;
      state = reason;
      killGroup('SIGTERM');
      hardKill = setTimeout(() => killGroup('SIGKILL'), 500);
    };
    const abort = (): void => stop('cancelled');
    const timeout = setTimeout(() => stop('timed-out'), input.timeoutMs);
    input.signal?.addEventListener('abort', abort, { once: true });
    if (input.signal?.aborted) abort();
    const capture = (kind: 'stdout' | 'stderr', bytes: Buffer): void => {
      const current = kind === 'stdout' ? stdout : stderr;
      const limit = 64 * 1024;
      const next = Buffer.concat([current, bytes.subarray(0, Math.max(0, limit - current.length))]);
      if (kind === 'stdout') stdout = next; else stderr = next;
      input.onOutput?.(stdout.toString('utf8'), stderr.toString('utf8'));
      if (current.length + bytes.length > limit) stop('output-limit');
    };
    child.stdout.on('data', (bytes: Buffer) => capture('stdout', bytes));
    child.stderr.on('data', (bytes: Buffer) => capture('stderr', bytes));
    const cleanup = (): void => {
      clearTimeout(timeout);
      if (hardKill) clearTimeout(hardKill);
      input.signal?.removeEventListener('abort', abort);
      // Do not leave background children running after a command exits.
      killGroup('SIGKILL');
    };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('exit', () => { killGroup('SIGKILL'); });
    child.once('close', (exitCode, signal) => {
      cleanup();
      resolve({ state, exitCode, signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    });
  });
}
