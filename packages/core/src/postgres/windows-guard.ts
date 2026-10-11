/**
 * Windows: a clean database shutdown when the owner signs out or restarts.
 *
 * Nothing in Node hears a sign-out there. libuv maps no console event to
 * CTRL_LOGOFF or CTRL_SHUTDOWN, the task's processes have no window for
 * WM_ENDSESSION, and a process without one is simply terminated at the end of
 * the session, Postgres with it: the next start then reads "database system
 * was not properly shut down; automatic recovery in progress".
 *
 * So a small window-owning helper (Windows PowerShell, compiled C# through
 * Add-Type, present on every Windows 10 and 11) runs beside the postmaster.
 * It asks to be told first (SetProcessShutdownParameters 0x2FF, the top of
 * the range applications may use), and when the session really ends it sends
 * the postmaster a fast shutdown the way `pg_ctl stop -m fast` does on Windows
 * — the signal number on the postmaster's `pgsignal_<pid>` pipe — and waits
 * for it to exit before returning. Starting pg_ctl itself at that moment fails
 * (a console program cannot start while the session is ending, 0xC0000142).
 * The helper leaves by itself when the postmaster it watches is gone.
 *
 * No administrator rights, no group policy shutdown script, no service.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System; using System.Diagnostics; using System.IO; using System.IO.Pipes; using System.Runtime.InteropServices; using System.Windows.Forms;
public class BuddiDatabaseGuard : NativeWindow {
  [DllImport("kernel32.dll")] static extern bool SetProcessShutdownParameters(uint level, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool ShutdownBlockReasonCreate(IntPtr h, string reason);
  [DllImport("user32.dll")] static extern bool ShutdownBlockReasonDestroy(IntPtr h);
  readonly string cluster, log; readonly int postmaster; bool stopped;
  public BuddiDatabaseGuard(string cluster, int postmaster, string log) {
    this.cluster = cluster; this.postmaster = postmaster; this.log = log;
    SetProcessShutdownParameters(0x2FF, 0);
    CreateHandle(new CreateParams());
  }
  void Note(string line) { try { File.AppendAllText(log, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " buddi: " + line + Environment.NewLine); } catch {} }
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x11) { ShutdownBlockReasonCreate(Handle, "Stopping buddi's database"); m.Result = (IntPtr)1; return; }
    if (m.Msg == 0x16) { if (m.WParam != IntPtr.Zero) Stop(); ShutdownBlockReasonDestroy(Handle); m.Result = IntPtr.Zero; return; }
    base.WndProc(ref m);
  }
  void Stop() {
    if (stopped) return; stopped = true;
    try {
      int pid = int.Parse(File.ReadAllLines(Path.Combine(cluster, "postmaster.pid"))[0].Trim());
      if (pid != postmaster) return;
      Note("the Windows session is ending: a fast shutdown of the database (postmaster " + pid + ")");
      using (var pipe = new NamedPipeClientStream(".", "pgsignal_" + pid, PipeDirection.InOut)) {
        pipe.Connect(5000); pipe.ReadMode = PipeTransmissionMode.Message; pipe.WriteByte(2); pipe.Flush(); pipe.ReadByte();
      }
      Note(Process.GetProcessById(pid).WaitForExit(25000) ? "the database stopped for the end of the session" : "the database was still stopping after 25 seconds");
    } catch (Exception e) { Note("the database could not be stopped for the end of the session: " + e.Message); }
  }
}
'@
$postmaster = [int]$env:BUDDI_GUARD_POSTMASTER
$guard = New-Object BuddiDatabaseGuard $env:BUDDI_GUARD_CLUSTER, $postmaster, $env:BUDDI_GUARD_LOG
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({ if (-not (Get-Process -Id $postmaster -ErrorAction SilentlyContinue)) { [System.Windows.Forms.Application]::Exit() } })
$timer.Start()
[System.Windows.Forms.Application]::Run()
`;

/** The arguments PowerShell runs the guard with: the script travels encoded, so nothing in it is quoted for a command line. */
export function guardArguments(): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')];
}

export interface DatabaseGuardOptions {
  cluster: string;
  postmaster: number;
  /** Where the guard notes what it did: the postmaster's own log. */
  logFile: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Start the guard for a running postmaster. Detached, so it is in no job of
 * the supervisor's and outlives it: the postmaster does too (cluster.ts). A
 * failure to start it costs only the clean shutdown at sign-out, so it is
 * reported, never thrown.
 */
export function startDatabaseGuard({ cluster, postmaster, logFile, env }: DatabaseGuardOptions, report: (line: string) => void): void {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const child = spawn(powershell, guardArguments(), {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...env, BUDDI_GUARD_CLUSTER: cluster, BUDDI_GUARD_POSTMASTER: String(postmaster), BUDDI_GUARD_LOG: logFile },
    });
    child.once('error', error => report(`The database's sign-out guard did not start (${error.message}); a Windows restart will not stop the database cleanly.`));
    child.unref();
  } catch (error) {
    report(`The database's sign-out guard did not start (${(error as Error).message}); a Windows restart will not stop the database cleanly.`);
  }
}
