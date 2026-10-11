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
 * the range applications may use). Asked whether the session may end
 * (WM_QUERYENDSESSION), it sends the postmaster a fast shutdown the way
 * `pg_ctl stop -m fast` does on Windows — the signal number on the
 * postmaster's `pgsignal_<pid>` pipe — and answers "not yet" with a reason
 * on screen while the database stops, never past 15 seconds; when the
 * session does end (WM_ENDSESSION) it waits out what is left of those. Starting pg_ctl itself at that moment fails
 * (a console program cannot start while the session is ending, 0xC0000142).
 * The helper leaves by itself when the postmaster it watches is gone.
 *
 * No administrator rights, no group policy shutdown script, no service.
 */
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System; using System.Diagnostics; using System.IO; using System.IO.Pipes; using System.Runtime.InteropServices; using System.Windows.Forms;
public class BuddiDatabaseGuard : NativeWindow {
  [DllImport("kernel32.dll")] static extern bool SetProcessShutdownParameters(uint level, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool ShutdownBlockReasonCreate(IntPtr h, string reason);
  [DllImport("user32.dll")] static extern bool ShutdownBlockReasonDestroy(IntPtr h);
  const int CapMs = 15000;
  readonly string cluster, log; readonly int postmaster; Stopwatch since;
  public BuddiDatabaseGuard(string cluster, int postmaster, string log) {
    this.cluster = cluster; this.postmaster = postmaster; this.log = log;
    SetProcessShutdownParameters(0x2FF, 0);
    CreateHandle(new CreateParams());
  }
  void Note(string line) { try { File.AppendAllText(log, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff") + " buddi: " + line + Environment.NewLine); } catch {} }
  /** The postmaster this guard watches still runs and still owns the cluster. */
  public bool Live() {
    try {
      if (Process.GetProcessById(postmaster).HasExited) return false;
      return int.Parse(File.ReadAllLines(Path.Combine(cluster, "postmaster.pid"))[0].Trim()) == postmaster;
    } catch { return false; }
  }
  bool Capped() { return since != null && since.ElapsedMilliseconds >= CapMs; }
  protected override void WndProc(ref Message m) {
    // ENDSESSION_CLOSEAPP: not the end of the session but an installer's
    // Restart Manager asking this program to close (Windows Update does).
    // The database is none of its business: the guard closes alone, and the
    // supervisor starts it again.
    if ((m.Msg == 0x11 || m.Msg == 0x16) && (m.LParam.ToInt64() & 0x1) != 0) {
      if (m.Msg == 0x16 && m.WParam != IntPtr.Zero) Application.Exit();
      m.Result = m.Msg == 0x11 ? (IntPtr)1 : IntPtr.Zero; return;
    }
    if (m.Msg == 0x11) {
      // Asked whether the session may end: begin the fast shutdown now, and
      // hold the end (with a reason on screen) while the database stops, up to the cap.
      if (Live() && !Capped()) { Begin(); ShutdownBlockReasonCreate(Handle, "Stopping buddi's database"); m.Result = IntPtr.Zero; return; }
      ShutdownBlockReasonDestroy(Handle); m.Result = (IntPtr)1; return;
    }
    if (m.Msg == 0x16) {
      if (m.WParam != IntPtr.Zero && Live()) { Begin(); while (Live() && !Capped()) System.Threading.Thread.Sleep(100); Note(Live() ? "the database was still stopping when the session ended" : "the database stopped for the end of the session"); }
      ShutdownBlockReasonDestroy(Handle); m.Result = IntPtr.Zero; return;
    }
    base.WndProc(ref m);
  }
  void Begin() {
    if (since != null) return;
    since = Stopwatch.StartNew();
    try {
      Note("the Windows session is ending: a fast shutdown of the database (postmaster " + postmaster + ")");
      // pg_ctl's own way on Windows: the signal number on the postmaster's signal pipe (SIGINT: fast shutdown).
      using (var pipe = new NamedPipeClientStream(".", "pgsignal_" + postmaster, PipeDirection.InOut)) {
        pipe.Connect(3000); pipe.ReadMode = PipeTransmissionMode.Message; pipe.WriteByte(2); pipe.Flush(); pipe.ReadByte();
      }
    } catch (Exception e) { Note("the database could not be asked to stop for the end of the session: " + e.Message); }
  }
  /** Called by the timer: once the database is gone, the end of the session is no longer held. */
  public void Tick() { if (since != null && (!Live() || Capped())) ShutdownBlockReasonDestroy(Handle); }
}
'@
$postmaster = [int]$env:BUDDI_GUARD_POSTMASTER
$guard = New-Object BuddiDatabaseGuard $env:BUDDI_GUARD_CLUSTER, $postmaster, $env:BUDDI_GUARD_LOG
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.add_Tick({ $guard.Tick(); if (-not (Get-Process -Id $postmaster -ErrorAction SilentlyContinue)) { [System.Windows.Forms.Application]::Exit() } })
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
 * Start the guard for a running postmaster: hidden, in the supervisor's job
 * (detached, PowerShell would have no console and leave at once). At the end
 * of a session it is told before the supervisor and the postmaster are
 * stopped, which is all it needs. One that leaves while the postmaster runs
 * (an installer's Restart Manager closed it) is started again. A failure to
 * start it costs only the clean shutdown at sign-out, so it is reported,
 * never thrown. The returned function ends it for good.
 */
export function startDatabaseGuard({ cluster, postmaster, logFile, env }: DatabaseGuardOptions, report: (line: string) => void, respawnMs = 10_000): () => void {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let stopped = false, child: ChildProcess | undefined, timer: NodeJS.Timeout | undefined;
  const alive = (): boolean => { try { process.kill(postmaster, 0); return true; } catch { return false; } };
  const start = (): void => {
    if (stopped || !alive()) return;
    try {
      child = spawn(powershell, guardArguments(), {
        stdio: 'ignore', windowsHide: true,
        env: { ...env, BUDDI_GUARD_CLUSTER: cluster, BUDDI_GUARD_POSTMASTER: String(postmaster), BUDDI_GUARD_LOG: logFile },
      });
      child.once('error', error => report(`The database's sign-out guard did not start (${error.message}); a Windows restart will not stop the database cleanly.`));
      child.once('exit', () => { if (!stopped && alive()) { timer = setTimeout(start, respawnMs); timer.unref(); } });
      child.unref();
    } catch (error) {
      report(`The database's sign-out guard did not start (${(error as Error).message}); a Windows restart will not stop the database cleanly.`);
    }
  };
  start();
  return () => { stopped = true; clearTimeout(timer); };
}
