/**
 * The background service on Windows: a Task Scheduler task in the owner's own
 * account that starts the supervisor at logon, the counterpart of the macOS
 * LaunchAgent and the Linux systemd user unit.
 *
 * Not a Windows service: one runs as another account (or needs the owner's
 * password stored), away from the owner's %LOCALAPPDATA%, the file vault's key
 * and the browser profiles; and registering one needs an administrator. A task
 * of the owner's needs neither.
 *
 * The task runs `<data>\service\supervise.cmd` (the environment, then node
 * with the launcher's `supervise`, its output appended to the supervisor log)
 * under `conhost.exe --headless`, so no console window opens at logon. The
 * script is what says the service is installed, as the plist and the unit do.
 *
 * Node builtins only, and nothing of buddi's: `launcher.ts` and `uninstall.ts`
 * import it before the environment is set (see environment.ts).
 */
import path from 'node:path';

/** The task's name in the Task Scheduler library: the installation's label. */
export function windowsTaskName(label: string): string {
  return label;
}

/** The script the task runs; its presence is "the service is installed". */
export function windowsTaskScript(data: string): string {
  return path.win32.join(data, 'service', 'supervise.cmd');
}

/** The task definition `schtasks /Create /XML` reads, beside the script. */
export function windowsTaskXmlFile(data: string): string {
  return path.win32.join(data, 'service', 'task.xml');
}

export interface SuperviseScript {
  nodePath: string;
  /** The launcher (`packages/install/dist/launcher.js`). */
  entry: string;
  environment: Record<string, string>;
  logFile: string;
}

/** `%` is the one character cmd expands inside a quoted `set`; doubled, it is literal. */
function cmdLiteral(value: string): string {
  if (/["\r\n]/.test(value)) throw new Error(`A value with a quote or a line break cannot go in a cmd script: ${JSON.stringify(value)}`);
  return value.replace(/%/g, '%%');
}

export function buildSuperviseScript({ nodePath, entry, environment, logFile }: SuperviseScript): string {
  const lines = [
    '@echo off',
    'rem Written by buddi. Task Scheduler runs it at logon to start the supervisor.',
    ...Object.entries(environment).map(([key, value]) => `set "${cmdLiteral(key)}=${cmdLiteral(value)}"`),
    `"${cmdLiteral(nodePath)}" "${cmdLiteral(entry)}" supervise >> "${cmdLiteral(logFile)}" 2>&1`,
  ];
  return lines.join('\r\n') + '\r\n';
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export interface TaskDefinition {
  /** `DOMAIN\user`: the account the task runs as and whose logon starts it. */
  user: string;
  script: string;
  workingDirectory: string;
  /** `%SystemRoot%`, for conhost.exe and cmd.exe. */
  systemRoot: string;
}

/**
 * The task: at the owner's logon, as the owner, with the rights they have
 * without elevation; never stopped for running long or on battery; restarted
 * by Task Scheduler if it fails, and one copy at a time.
 */
export function buildTaskXml({ user, script, workingDirectory, systemRoot }: TaskDefinition): string {
  const system32 = path.win32.join(systemRoot, 'System32');
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Starts buddi (its supervisor, database and dashboard) when you sign in.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(path.win32.join(system32, 'conhost.exe'))}</Command>
      <Arguments>${xml(`--headless "${path.win32.join(system32, 'cmd.exe')}" /d /c "${script}"`)}</Arguments>
      <WorkingDirectory>${xml(workingDirectory)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** schtasks reads a definition file as UTF-16 with its byte order mark. */
export function taskXmlBytes(text: string): Buffer {
  return Buffer.from(`﻿${text}`, 'utf16le');
}

/** How the caller runs a program; only a rejection is read, as for launchctl. */
export type TaskExec = (command: string, args: string[]) => Promise<unknown>;

/**
 * Register (or replace) the task and start it now. A copy still running from
 * before is ended first: `IgnoreNew` would otherwise swallow the start.
 */
export async function registerWindowsTask(exec: TaskExec, name: string, xmlFile: string): Promise<void> {
  await exec('schtasks.exe', ['/Create', '/TN', name, '/XML', xmlFile, '/F']);
  await exec('schtasks.exe', ['/End', '/TN', name]).catch(() => {});
  await exec('schtasks.exe', ['/Run', '/TN', name]);
}
