import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface CommandResult {
  state: 'completed' | 'cancelled' | 'timed-out' | 'output-limit';
  exitCode: number | null; signal: string | null; stdout: string; stderr: string;
}

/**
 * The shell host commands run in, by platform: the one place the tool's
 * description, the approval envelope, system.info and the runner read.
 * Windows: Windows PowerShell 5.1 (`powershell.exe`, on every Windows 10 and
 * 11), never pwsh, so the model can count on one dialect.
 */
export interface HostShell {
  /** What the envelope names. */
  name: string;
  /** The dialect, for the model and system.info. */
  label: string;
}
export function hostShell(platform: NodeJS.Platform = process.platform): HostShell {
  return platform === 'win32'
    ? { name: 'powershell.exe', label: 'Windows PowerShell 5.1 (powershell.exe)' }
    : { name: '/bin/bash', label: 'Bash (/bin/bash)' };
}

/** What a Windows program needs to find the system, the profile and temp. Nothing else is passed. */
const WINDOWS_KEYS = ['SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles',
  'CommonProgramFiles(x86)', 'CommonProgramW6432', 'PUBLIC', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'LANG', 'LC_ALL'];

/** A variable whatever its case: Windows names are case-insensitive, a copied env object is not. */
function lookup(env: NodeJS.ProcessEnv, key: string): string | undefined {
  if (env[key] !== undefined) return env[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() === lower) return v;
  return undefined;
}

/** No inherited API keys/database credentials, login scripts, or stdin prompts.
 * This is hygiene, NOT isolation: the process still has the user's file access. */
export function commandEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  if (platform === 'win32') {
    for (const key of WINDOWS_KEYS) {
      const value = lookup(env, key);
      if (value) out[key] = value;
    }
    // The owner's own PATH: where python, git and the rest were installed. No fixed list fits Windows.
    const pathValue = lookup(env, 'PATH');
    if (pathValue) out.PATH = pathValue;
  } else {
    for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL']) {
      if (env[key]) out[key] = env[key];
    }
    out.PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  }
  out.PYTHONUNBUFFERED = '1';
  out.PIP_DISABLE_PIP_VERSION_CHECK = '1';
  return out;
}

/**
 * Before the command: PowerShell puts itself in a new job object that kills
 * every process in it when its last handle closes. PowerShell holds that
 * handle, so when it exits (done, or killed) a program the command left
 * running in the background goes with it — what a process group does on
 * POSIX. No administrator rights. Where it cannot (a policy refuses Add-Type),
 * the command still runs, and taskkill /T still ends the tree on a stop.
 */
const WINDOWS_JOB = String.raw`try {
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class BuddiHostJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long A; public long B; public uint LimitFlags; public UIntPtr C; public UIntPtr D; public uint E; public UIntPtr F; public uint G; public uint H; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Basic; public Io Io; public UIntPtr A; public UIntPtr B; public UIntPtr C; public UIntPtr D; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended info, uint size);
  [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  static IntPtr held;
  public static bool Enter() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) return false;
    var info = new Extended(); info.Basic.LimitFlags = 0x2000; // KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended)))) return false;
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) return false;
    held = job; return true;
  }
}
'@
[void][BuddiHostJob]::Enter()
} catch { }`;

/**
 * The script a Windows command runs as: its children in a kill-on-close job,
 * UTF-8 out, no progress records, and a native program's failure as the exit
 * code (PowerShell itself would exit 0). Run with -File, so nothing in the
 * command is quoted for a command line.
 */
export function powershellScript(command: string): string {
  return [
    WINDOWS_JOB,
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '$OutputEncoding = [System.Text.Encoding]::UTF8',
    '$global:LASTEXITCODE = 0',
    command,
    'if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    '',
  ].join('\r\n');
}

/** The argv a command runs as (on Windows, the script file it was written to). */
export function shellArgv(platform: NodeJS.Platform, command: string, env: NodeJS.ProcessEnv, scriptFile?: string): string[] {
  if (platform === 'win32') {
    const systemRoot = lookup(env, 'SystemRoot') ?? 'C:\\Windows';
    return [path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptFile ?? ''];
  }
  return ['/bin/bash', '--noprofile', '--norc', '-c', command];
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
  const windows = process.platform === 'win32';
  // A confinement wraps a POSIX shell; Windows has none (bundle scripts are refused before this).
  if (windows && input.wrap && input.wrap.length > 0) throw new Error('A confined script cannot run on Windows.');
  if (!windows) return spawnCommand(input, false, undefined);
  return runWindows(input);
}

async function runWindows(input: Parameters<typeof runCommand>[0]): Promise<CommandResult> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'buddi-host-'));
  try {
    const script = path.join(dir, 'command.ps1');
    // With a BOM: Windows PowerShell 5.1 reads a file without one in the ANSI code page.
    await writeFile(script, `\ufeff${powershellScript(input.command)}`, { encoding: 'utf8', mode: 0o600 });
    return await spawnCommand(input, true, script);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function spawnCommand(input: Parameters<typeof runCommand>[0], windows: boolean, scriptFile: string | undefined): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const shell = shellArgv(windows ? 'win32' : process.platform, input.command, input.env, scriptFile);
    const argv = input.wrap && input.wrap.length > 0 ? [...input.wrap, ...shell] : shell;
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: input.cwd, env: { ...commandEnv(input.env), ...(input.extraEnv ?? {}) },
      // POSIX: its own process group, killed as one. Windows: no console window; the job and taskkill end the tree.
      detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    let state: CommandResult['state'] = 'completed';
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    let treeKilled = false;
    const killGroup = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
      if (windows) {
        // Windows has no TERM to wait out: the tree at once, while its root still runs.
        if (treeKilled || child.exitCode !== null || child.signalCode !== null) return;
        treeKilled = true;
        killTree(child.pid, input.env);
        return;
      }
      try { process.kill(-child.pid, signal); } catch { /* Already gone. */ }
    };
    const stop = (reason: CommandResult['state']): void => {
      if (state !== 'completed') return;
      state = reason;
      killGroup('SIGTERM');
      if (!windows) hardKill = setTimeout(() => killGroup('SIGKILL'), 500);
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
      // Do not leave background children running after a command exits
      // (POSIX: the group; Windows: the job closed with PowerShell).
      if (!windows) killGroup('SIGKILL');
    };
    child.once('error', (error) => { cleanup(); reject(error); });
    child.once('exit', () => { if (!windows) killGroup('SIGKILL'); });
    child.once('close', (exitCode, signal) => {
      cleanup();
      resolve({ state, exitCode, signal, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') });
    });
  });
}

/** End a Windows process and every process under it (`taskkill /T /F`). */
function killTree(pid: number, env: NodeJS.ProcessEnv): void {
  const systemRoot = lookup(env, 'SystemRoot') ?? 'C:\\Windows';
  const fallback = (): void => { try { process.kill(pid); } catch { /* Already gone. */ } };
  try {
    const killer = spawn(path.win32.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    killer.once('error', fallback);
  } catch { fallback(); }
}
