/**
 * Running other programs.
 *
 * Everything the CLI shells out to (launchctl, docker, pnpm, pgrep) is a
 * best-effort probe: a missing binary is an answer, not a crash. `run` never
 * throws — it reports the exit code, and 127 means "not installed".
 */
import { spawn } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(
  command: string,
  args: string[] = [],
  opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 30_000);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout?.on('data', (d) => (stdout += String(d)));
    child.stderr?.on('data', (d) => (stderr += String(d)));
    child.on('error', (err) => {
      clearTimeout(timer);
      // ENOENT: the program is not installed. 127 is the shell's word for it.
      resolve({ code: 127, stdout, stderr: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Run a command inheriting the terminal — for `pnpm -r build` and friends. */
export function runInherit(
  command: string,
  args: string[],
  opts: { cwd?: string } = {},
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: opts.cwd ?? process.cwd(), stdio: 'inherit' });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** First line of `<cmd> --version`, or null when the command is not installed. */
export async function versionOf(command: string, args: string[] = ['--version']): Promise<string | null> {
  const res = await run(command, args, { timeoutMs: 15_000 });
  if (res.code !== 0) return null;
  const line = (res.stdout || res.stderr).split('\n')[0]?.trim();
  return line && line !== '' ? line : null;
}
