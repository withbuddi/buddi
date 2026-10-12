/**
 * The Windows install (`buddi-<version>-windows-x64-setup.exe`, apps/windows),
 * as the launcher sees it: the `buddi.cmd` the setup puts on PATH, the task
 * script for that layout, and which command belongs to which installation.
 * The counterpart of linux-install.ts. Pure functions with the disk injected,
 * so the tests run on any machine.
 *
 * The layout is the Linux install's, under the data directory:
 *
 *     <data>\node\                      node.exe, npm.cmd and npm, VERSION, and
 *     <data>\node\vcruntime\            the Visual C++ runtime Postgres needs (copied beside it)
 *     <data>\releases\buddi-<v>\        npm's prefix for a release
 *     <data>\releases\current, previous junctions into them
 *
 * and the setup's own files (the command, the icon, its uninstaller) in
 * `%LOCALAPPDATA%\Programs\buddi`.
 *
 * Node builtins only, and nothing of buddi's but leaf modules: the launcher
 * and uninstall.ts import it before the environment is set (environment.ts).
 */
import { copyFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_LAYOUT_VAR, WINDOWS_INSTALL_VAR, currentLauncher } from './app-layout.js';
import { cmdLiteral } from './windows-task.js';

const win = path.win32;

/** The marker line the setup writes into the `buddi.cmd` it puts on PATH. */
export const WINDOWS_COMMAND_MARKER = 'rem buddi-windows-install';

/** The bundled node the Windows install runs: `<data>\node\node.exe`, never the machine's. */
export function windowsBundledNode(data: string): string {
  return win.join(data, 'node', 'node.exe');
}

/** Where the bundle keeps the Visual C++ runtime DLLs, beside node (see prepareBinaries in @buddi/core). */
export function vcRuntimeDir(nodeDir: string): string {
  return win.join(nodeDir, 'vcruntime');
}

/** What every process of the Windows install runs with, PATH aside. */
export function windowsInstallEnvironment(data: string): Record<string, string> {
  return {
    BUDDI_DATA_DIR: data,
    [APP_LAYOUT_VAR]: win.join(data, 'releases'),
    [WINDOWS_INSTALL_VAR]: '1',
    npm_config_cache: win.join(data, 'cache', 'npm'),
  };
}

/** The Windows install's PATH: the bundled node first (npm's scripts run `node`). */
export function windowsInstallPath(data: string, inherited: string | undefined): string {
  return [win.join(data, 'node'), ...(inherited ? [inherited] : [])].join(';');
}

/**
 * The `buddi.cmd` the setup writes. A batch file, not a PowerShell script:
 * PowerShell finds it through PATHEXT whatever its script policy says, and
 * cmd runs it as it is. It never changes with an upgrade: it names `current`.
 *
 * cmd reads a batch file in the console's code page, so a data folder with
 * letters outside English is read in UTF-8 (the file's encoding) and the
 * owner's code page is put back before node runs; an ASCII path needs neither.
 */
export function buildWindowsCommand(data: string): string {
  const ascii = /^[\x20-\x7e]*$/.test(data);
  const env = windowsInstallEnvironment(data);
  const lines = [
    '@echo off',
    `${WINDOWS_COMMAND_MARKER}: written by the buddi setup. It runs the buddi in BUDDI_DATA_DIR below.`,
    'setlocal DisableDelayedExpansion',
    ...(ascii ? [] : ['for /f "tokens=2 delims=:." %%c in (\'chcp\') do set "BUDDI_CODEPAGE=%%c"', 'chcp 65001 >nul']),
    ...Object.entries(env).map(([key, value]) => `set "${key}=${cmdLiteral(value)}"`),
    ...(ascii ? [] : ['chcp %BUDDI_CODEPAGE% >nul', 'set "BUDDI_CODEPAGE="']),
    // `buddi uninstall` removes the folder node.exe runs from, which Windows
    // refuses while it runs: that one command runs a copy of it from TEMP.
    'set "BUDDI_NODE=%BUDDI_DATA_DIR%\\node\\node.exe"',
    'if /i not "%~1"=="uninstall" goto checked',
    `set "BUDDI_NODE_COPY=%TEMP%\\${UNINSTALL_NODE_PREFIX}%RANDOM%%RANDOM%"`,
    'if exist "%BUDDI_NODE%" mkdir "%BUDDI_NODE_COPY%" && copy /y "%BUDDI_NODE%" "%BUDDI_NODE_COPY%\\node.exe" >nul && set "BUDDI_NODE=%BUDDI_NODE_COPY%\\node.exe"',
    ':checked',
    'if exist "%BUDDI_DATA_DIR%\\node\\node.exe" if exist "%BUDDI_DATA_DIR%\\releases\\current\\packages\\install\\dist\\launcher.js" goto run',
    'echo buddi: the installation in %BUDDI_DATA_DIR% is incomplete. Run the buddi setup again: https://withbuddi.com 1>&2',
    'exit /b 127',
    ':run',
    'set "PATH=%BUDDI_DATA_DIR%\\node;%PATH%"',
    // The last line: node's exit status is the command's.
    '"%BUDDI_NODE%" "%BUDDI_DATA_DIR%\\releases\\current\\packages\\install\\dist\\launcher.js" %*',
  ];
  return lines.join('\r\n') + '\r\n';
}

/** The data folder a `buddi.cmd` written by the setup runs, or undefined when it is not one. */
export function windowsCommandData(text: string): string | undefined {
  if (!text.includes(WINDOWS_COMMAND_MARKER)) return undefined;
  const line = text.split(/\r?\n/).find(l => l.startsWith('set "BUDDI_DATA_DIR='));
  if (line === undefined || !line.endsWith('"')) return undefined;
  return line.slice('set "BUDDI_DATA_DIR='.length, -1).replace(/%%/g, '%');
}

/** Is this command the setup's, for this data folder? Windows paths ignore case. */
export function windowsCommandOwnedBy(text: string | undefined, data: string, real: (file: string) => string = file => file): boolean {
  if (text === undefined) return false;
  const named = windowsCommandData(text);
  if (named === undefined) return false;
  const norm = (file: string): string => { try { return real(win.resolve(file)).toLowerCase(); } catch { return win.resolve(file).toLowerCase(); } };
  return norm(named) === norm(data);
}

export interface WindowsTaskSpec {
  nodePath: string;
  entry: string;
  environment: Record<string, string>;
  pathPrefix: string;
}

/**
 * What the task runs: the bundled node and `current`'s launcher, named
 * through the junction so an upgrade's switch needs no new task. Throws when
 * the bundled node is not there.
 */
export function windowsTaskSpec(opts: { data: string; label: string; exists: (file: string) => boolean; extra?: Record<string, string> }): WindowsTaskSpec {
  const nodePath = windowsBundledNode(opts.data);
  if (!opts.exists(nodePath)) throw new Error(`the bundled Node is missing at ${nodePath}; run the buddi setup again`);
  const env = windowsInstallEnvironment(opts.data);
  return {
    nodePath,
    entry: currentLauncher(env[APP_LAYOUT_VAR] as string).split('/').join('\\'),
    environment: { ...env, ...(opts.extra ?? {}) },
    pathPrefix: win.dirname(nodePath),
  };
}

/** What the setup records in `<data>\installer.json` once an install stands. */
export interface WindowsInstallerRecord {
  version: string;
  arch: string;
  /** `buddi.cmd`, where the setup wrote it. */
  command: string;
  data: string;
  /** The setup's uninstaller (`unins000.exe`), which removes the Apps & Features entry, the Start menu item and PATH. */
  uninstaller?: string;
  installedAt: string;
}

/** `installer.json`, read leniently: an absolute command and uninstaller, or nothing. */
export function readWindowsInstallerRecord(text: string | undefined): { command?: string; uninstaller?: string } {
  if (text === undefined) return {};
  let parsed: { command?: unknown; uninstaller?: unknown };
  try { parsed = JSON.parse(text) as typeof parsed; } catch { return {}; }
  const absolute = (value: unknown): string | undefined => typeof value === 'string' && win.isAbsolute(value) ? value : undefined;
  const command = absolute(parsed.command);
  const uninstaller = absolute(parsed.uninstaller);
  return { ...(command === undefined ? {} : { command }), ...(uninstaller === undefined ? {} : { uninstaller }) };
}

/** Set by the setup's uninstaller when it runs `buddi uninstall`: it removes its own entry afterwards. */
export const SETUP_UNINSTALL_VAR = 'BUDDI_SETUP_UNINSTALL';

/** How the setup's uninstaller is started from `buddi uninstall`: quietly, with no question left to ask. */
export const SETUP_UNINSTALL_ARGS = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'];

/** The folder name a copy of node for `buddi uninstall` gets in TEMP. */
export const UNINSTALL_NODE_PREFIX = 'buddi-uninstall-';

/** Is `file` the folder `dir` or inside it? Windows paths ignore case. */
export function insideFolder(file: string, dir: string, platform: NodeJS.Platform | string = process.platform): boolean {
  const p = platform === 'win32' ? win : path.posix;
  const norm = (value: string): string => { const resolved = p.resolve(value); return platform === 'win32' ? resolved.toLowerCase() : resolved; };
  const f = norm(file);
  const d = norm(dir).replace(/[\\/]+$/, '');
  return f === d || f.startsWith(d + p.sep);
}

/**
 * A node that does not run from inside the data folder: Windows will not
 * remove a folder whose program is running, and the Windows install's node
 * is `<data>\node\node.exe`. A copy goes to a folder of its own in TEMP, which
 * `cleanupNodeCopyCommand` removes once that node has exited. Elsewhere, and
 * for a node outside the folder, the node as it is.
 */
export function nodeOutsideData(data: string, execPath: string = process.execPath, platform: NodeJS.Platform | string = process.platform, tmp: string = os.tmpdir()): string {
  if (platform !== 'win32' || !insideFolder(execPath, data, platform)) return execPath;
  const dir = mkdtempSync(path.join(tmp, UNINSTALL_NODE_PREFIX));
  const copy = path.join(dir, 'node.exe');
  copyFileSync(execPath, copy);
  return copy;
}

/**
 * When this node is such a copy: the hidden cmd line that removes its folder
 * a few seconds after it has exited (it cannot remove itself while it runs).
 */
export function cleanupNodeCopyCommand(execPath: string, systemRoot: string, tmp: string = os.tmpdir()): { command: string; args: string[] } | undefined {
  const dir = win.dirname(execPath);
  if (!win.basename(dir).startsWith(UNINSTALL_NODE_PREFIX) || !insideFolder(dir, tmp, 'win32')) return undefined;
  if (/["%]/.test(dir)) return undefined;
  return {
    command: win.join(systemRoot, 'System32', 'cmd.exe'),
    args: ['/d', '/c', `ping -n 6 127.0.0.1 >nul & rmdir /s /q "${dir}"`],
  };
}
