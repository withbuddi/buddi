import { spawn, type ChildProcess } from 'node:child_process';
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

/** What the supervisor writes to stderr, and exits 125 with, when it could not set up the job. Nothing ran. */
export const JOB_FAILED_MARKER = 'BUDDI-HOST-JOB-FAILED: ';
const JOB_FAILED_EXIT = 125;

/**
 * The PowerShell that runs a Windows command, handed over stdin from this
 * process's memory (no file anywhere for anyone to swap). It puts itself in a new job object that
 * kills every process in it when its last handle closes — the handle only it
 * holds — so when it exits (done, or killed by buddi) every program the
 * command started goes with it, as a process group does on POSIX. The job is
 * made through a P/Invoke defined in memory (Reflection.Emit): no compiler, no
 * DLL on disk, no administrator rights. If it cannot be made and joined, the
 * command does not run (fail closed). Only then is the command read, from
 * stdin (base64 UTF-8; stdin is then at end, as a closed one), and run in
 * this same process.
 */
export const WINDOWS_SUPERVISOR = String.raw`$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
try {
  $__buddiType = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'BuddiHostJob'), [Reflection.Emit.AssemblyBuilderAccess]::Run).DefineDynamicModule('BuddiHostJob').DefineType('BuddiHostJob', 'Public, Class')
  foreach ($__buddiDef in @(
    @('CreateJobObjectW', [IntPtr], [Type[]]@([IntPtr], [IntPtr])),
    @('SetInformationJobObject', [bool], [Type[]]@([IntPtr], [int], [IntPtr], [uint32])),
    @('AssignProcessToJobObject', [bool], [Type[]]@([IntPtr], [IntPtr]))
  )) {
    $__buddiMethod = $__buddiType.DefinePInvokeMethod($__buddiDef[0], 'kernel32.dll', [Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard, $__buddiDef[1], $__buddiDef[2], [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $__buddiMethod.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
  }
  $__buddiNative = $__buddiType.CreateType()
  $__buddiJob = $__buddiNative::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero)
  if ($__buddiJob -eq [IntPtr]::Zero) { throw 'CreateJobObject failed' }
  # JOBOBJECT_EXTENDED_LIMIT_INFORMATION: LimitFlags at offset 16 on 32- and 64-bit alike.
  $__buddiSize = if ([IntPtr]::Size -eq 8) { 144 } else { 112 }
  $__buddiInfo = [Runtime.InteropServices.Marshal]::AllocHGlobal($__buddiSize)
  for ($__buddiI = 0; $__buddiI -lt $__buddiSize; $__buddiI++) { [Runtime.InteropServices.Marshal]::WriteByte($__buddiInfo, $__buddiI, 0) }
  [Runtime.InteropServices.Marshal]::WriteInt32($__buddiInfo, 16, 0x2000) # KILL_ON_JOB_CLOSE
  if (-not $__buddiNative::SetInformationJobObject($__buddiJob, 9, $__buddiInfo, [uint32]$__buddiSize)) { throw 'SetInformationJobObject failed' }
  [Runtime.InteropServices.Marshal]::FreeHGlobal($__buddiInfo)
  if (-not $__buddiNative::AssignProcessToJobObject($__buddiJob, [IntPtr](-1))) { throw 'AssignProcessToJobObject failed' }
} catch {
  [Console]::Error.WriteLine('${JOB_FAILED_MARKER}' + $_.Exception.Message)
  exit ${JOB_FAILED_EXIT}
}
try {
  $__buddiCommand = [ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())))
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
$global:LASTEXITCODE = 0
. $__buddiCommand
`;

/**
 * The command as the supervisor runs it, with its status as bash would give
 * it: the last statement's. It succeeded: 0. It failed: a native program's
 * code when it set one, else 1 (not found, a cmdlet's error). A stale code from
 * an earlier program never decides.
 */
export function windowsCommandScript(command: string): string {
  return [
    command,
    '$__buddiLastOk = $?',
    'if ($__buddiLastOk) { exit 0 }',
    'if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    'exit 1',
    '',
  ].join('\r\n');
}

/**
 * The fixed bootstrap on the command line: it reads the supervisor from the
 * first line of stdin and runs it. Not -EncodedCommand: with that, Windows
 * PowerShell writes stderr as CLIXML (measured), which no model should read.
 */
export const WINDOWS_BOOTSTRAP = '. ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadLine()))))';

/** The argv a command runs as. On Windows the supervisor and the command go on stdin (`windowsStdin`), not here. */
export function shellArgv(platform: NodeJS.Platform, command: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    const systemRoot = lookup(env, 'SystemRoot') ?? 'C:\\Windows';
    return [path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_BOOTSTRAP];
  }
  return ['/bin/bash', '--noprofile', '--norc', '-c', command];
}

/** What a Windows command's stdin carries: the supervisor, then the command, each base64 UTF-8 on its own line; then it ends. */
export function windowsStdin(command: string): string {
  const line = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
  return `${line(WINDOWS_SUPERVISOR)}\n${line(windowsCommandScript(command))}\n`;
}

/** Settles true when `promise` settles within `ms`, false otherwise. */
function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    promise.then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(true); });
  });
}

/**
 * End a Windows command and everything it started, and say whether that is
 * confirmed. Terminating the supervisor closes the job's only handle, which
 * kills every process in the job. Not gone within the bound: `taskkill /T /F`,
 * awaited and bounded, then wait again. Only an observed exit counts.
 */
export async function stopWindowsCommand(deps: {
  terminate: () => void;
  exited: Promise<unknown>;
  taskkill: () => Promise<number | null>;
  boundMs: number;
}): Promise<boolean> {
  try { deps.terminate(); } catch { /* Already gone, or refused: the exit decides. */ }
  if (await within(deps.exited, deps.boundMs)) return true;
  await within(deps.taskkill().catch(() => null), deps.boundMs);
  return within(deps.exited, deps.boundMs);
}

/** `taskkill /T /F` on a process, with its exit code (null when it could not run). */
function taskkill(pid: number, env: NodeJS.ProcessEnv): Promise<number | null> {
  const systemRoot = lookup(env, 'SystemRoot') ?? 'C:\\Windows';
  return new Promise((resolve) => {
    try {
      const killer = spawn(path.win32.join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('error', () => resolve(null));
      killer.once('exit', (code) => resolve(code));
    } catch { resolve(null); }
  });
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
  return new Promise((resolve, reject) => {
    const shell = shellArgv(process.platform, input.command, input.env);
    const argv = input.wrap && input.wrap.length > 0 ? [...input.wrap, ...shell] : shell;
    const child: ChildProcess & { stdout: NonNullable<ChildProcess['stdout']>; stderr: NonNullable<ChildProcess['stderr']> } = spawn(argv[0] as string, argv.slice(1), {
      cwd: input.cwd, env: { ...commandEnv(input.env), ...(input.extraEnv ?? {}) },
      // POSIX: its own process group, killed as one; stdin closed. Windows: no
      // console window; stdin carries the command, then ends; the job ends the tree.
      detached: !windows, windowsHide: true, stdio: [windows ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    }) as never;
    if (windows && child.stdin) {
      child.stdin.on('error', () => { /* It left before reading: its exit says why. */ });
      child.stdin.end(windowsStdin(input.command));
    }
    const exited = new Promise<void>((done) => child.once('exit', () => done()));
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    let state: CommandResult['state'] = 'completed';
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    let unstoppable = false;
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid) { try { process.kill(-child.pid, signal); } catch { /* Already gone. */ } }
    };
    const stop = (reason: CommandResult['state']): void => {
      if (state !== 'completed') return;
      state = reason;
      if (windows) {
        const pid = child.pid;
        if (!pid) return;
        void stopWindowsCommand({ terminate: () => child.kill(), exited, taskkill: () => taskkill(pid, input.env), boundMs: 5000 })
          .then((stopped) => {
            if (stopped) return;
            unstoppable = true;
            finish();
          });
        return;
      }
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
    let settled = false;
    let pipesTimer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      clearTimeout(timeout);
      if (hardKill) clearTimeout(hardKill);
      if (pipesTimer) clearTimeout(pipesTimer);
      input.signal?.removeEventListener('abort', abort);
      // Do not leave background children running after a command exits
      // (POSIX: the group; Windows: the job, closed with the supervisor).
      if (!windows) killGroup('SIGKILL');
    };
    const finish = (exitCode: number | null = child.exitCode, signal: NodeJS.Signals | null = child.signalCode): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (unstoppable) {
        reject(new Error('The command could not be stopped: Windows did not end it. It may still be running; check Task Manager.'));
        return;
      }
      const err = stderr.toString('utf8');
      if (windows && exitCode === JOB_FAILED_EXIT && err.startsWith(JOB_FAILED_MARKER)) {
        reject(new Error(`Nothing ran: buddi could not contain the command in a Windows job (${err.slice(JOB_FAILED_MARKER.length).trim()}).`));
        return;
      }
      resolve({ state, exitCode, signal, stdout: stdout.toString('utf8'), stderr: err });
    };
    child.once('error', (error) => { if (settled) return; settled = true; cleanup(); reject(error); });
    child.once('exit', () => {
      if (!windows) { killGroup('SIGKILL'); return; }
      // The job ended everything in it with the supervisor, so its pipes close
      // now. Should something outside the job still hold one, do not wait on it.
      pipesTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(); }, 5000);
    });
    child.once('close', (exitCode, signal) => finish(exitCode, signal));
  });
}
