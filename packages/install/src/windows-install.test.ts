/** The Windows install's command, its task, and the setup's own program, with the disk injected where it can be. */
import { mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { pointAt, windowsSetupName } from './app-layout.js';
import { buildSuperviseScript } from './windows-task.js';
import { recoverySentence } from './upgrade.js';
import {
  NODE_COPY_DIR_VAR, UNINSTALL_NODE_PREFIX, WINDOWS_COMMAND_MARKER, buildWindowsCommand, cleanupNodeCopyCommand, insideFolder, readWindowsInstallerRecord,
  windowsBundledNode, windowsCommandData, windowsCommandOwnedBy, windowsInstallEnvironment, windowsTaskSpec,
} from './windows-install.js';
import { newestArchive, npmShimRunsBuddi, parseSetupArgs, setupPlan, uninstallSummary } from './windows-setup.js';

const data = 'C:\\Users\\owner\\AppData\\Local\\buddi';

describe('buddi.cmd', () => {
  test('runs the bundled node and current\'s launcher with the layout, and says so when it is missing', () => {
    const text = buildWindowsCommand(data);
    const lines = text.split('\r\n');
    expect(lines[0]).toBe('@echo off');
    expect(lines[1]?.startsWith(WINDOWS_COMMAND_MARKER)).toBe(true);
    expect(lines).toContain(`set "BUDDI_DATA_DIR=${data}"`);
    expect(lines).toContain(`set "BUDDI_APP_LAYOUT=${data}\\releases"`);
    expect(lines).toContain('set "BUDDI_WINDOWS_INSTALL=1"');
    expect(lines).toContain(`set "npm_config_cache=${data}\\cache\\npm"`);
    expect(lines).toContain('set "PATH=%BUDDI_DATA_DIR%\\node;%PATH%"');
    expect(lines.filter(line => line !== '').at(-1)).toBe('"%BUDDI_NODE%" "%BUDDI_DATA_DIR%\\releases\\current\\packages\\install\\dist\\launcher.js" %*');
    expect(text).toContain('exit /b 127');
    // ASCII: no code page dance.
    expect(text).not.toContain('chcp');
  });

  test('uninstall runs a copy of node from TEMP: Windows will not remove the folder a running node.exe is in', () => {
    const lines = buildWindowsCommand(data).split('\r\n');
    const check = lines.findIndex(line => line.startsWith('if /i not "%~1"=="uninstall"'));
    expect(check).toBeGreaterThan(0);
    expect(lines[check + 1]).toBe(`set "BUDDI_NODE_COPY=%TEMP%\\${UNINSTALL_NODE_PREFIX}%RANDOM%%RANDOM%"`);
    expect(lines[check + 2]).toContain('copy /y "%BUDDI_NODE%" "%BUDDI_NODE_COPY%\\node.exe"');
  });

  test('a data folder with letters outside English is read in UTF-8 and the code page put back before node runs', () => {
    const zoe = 'C:\\Users\\Zoë\\AppData\\Local\\buddi';
    const lines = buildWindowsCommand(zoe).split('\r\n');
    const utf8 = lines.indexOf('chcp 65001 >nul');
    const named = lines.indexOf(`set "BUDDI_DATA_DIR=${zoe}"`);
    const back = lines.indexOf('chcp %BUDDI_CODEPAGE% >nul');
    expect(utf8).toBeGreaterThan(0);
    expect(utf8).toBeLessThan(named);
    expect(back).toBeGreaterThan(named);
    expect(back).toBeLessThan(lines.findIndex(line => line.startsWith('"%BUDDI_NODE%"')));
  });

  test('a percent sign stays literal, and a quote is refused', () => {
    expect(buildWindowsCommand('D:\\100%\\buddi')).toContain('set "BUDDI_DATA_DIR=D:\\100%%\\buddi"');
    expect(windowsCommandData(buildWindowsCommand('D:\\100%\\buddi'))).toBe('D:\\100%\\buddi');
    expect(() => buildWindowsCommand('D:\\a"b')).toThrow(/quote/);
  });

  test('is this installation\'s only while it carries the marker and names this data folder, in any case', () => {
    const text = buildWindowsCommand(data);
    expect(windowsCommandData(text)).toBe(data);
    expect(windowsCommandOwnedBy(text, data)).toBe(true);
    expect(windowsCommandOwnedBy(text, data.toUpperCase())).toBe(true);
    expect(windowsCommandOwnedBy(text, 'D:\\other\\buddi')).toBe(false);
    expect(windowsCommandOwnedBy(text.replace(WINDOWS_COMMAND_MARKER, 'rem'), data)).toBe(false);
    expect(windowsCommandOwnedBy(undefined, data)).toBe(false);
  });
});

describe('the task', () => {
  test('runs the bundled node and current through the junction, with the layout and the node first on PATH', () => {
    const spec = windowsTaskSpec({ data, label: 'com.buddi.install.abc', exists: file => file === windowsBundledNode(data), extra: { BUDDI_WEB_PORT: '4417' } });
    expect(spec.nodePath).toBe(`${data}\\node\\node.exe`);
    expect(spec.entry).toBe(`${data}\\releases\\current\\packages\\install\\dist\\launcher.js`);
    expect(spec.environment).toEqual({ ...windowsInstallEnvironment(data), BUDDI_WEB_PORT: '4417' });
    expect(spec.pathPrefix).toBe(`${data}\\node`);
    const script = buildSuperviseScript({ ...spec, logFile: `${data}\\logs\\service.log` }).split('\r\n');
    expect(script).toContain(`set "PATH=${data}\\node;%PATH%"`);
    expect(script.at(-2)).toBe(`"${data}\\node\\node.exe" "${data}\\releases\\current\\packages\\install\\dist\\launcher.js" supervise >> "${data}\\logs\\service.log" 2>&1`);
  });

  test('refuses without the bundled node rather than run the machine\'s', () => {
    expect(() => windowsTaskSpec({ data, label: 'x', exists: () => false })).toThrow(/bundled Node is missing at .*node\.exe/);
  });
});

describe('installer.json and the node copy', () => {
  test('reads only absolute paths', () => {
    expect(readWindowsInstallerRecord(JSON.stringify({ command: 'C:\\P\\bin\\buddi.cmd', uninstaller: 'C:\\P\\unins000.exe' }))).toEqual({ command: 'C:\\P\\bin\\buddi.cmd', uninstaller: 'C:\\P\\unins000.exe' });
    expect(readWindowsInstallerRecord(JSON.stringify({ command: 'buddi.cmd', uninstaller: 3 }))).toEqual({});
    expect(readWindowsInstallerRecord('not json')).toEqual({});
    expect(readWindowsInstallerRecord(undefined)).toEqual({});
  });

  test('inside a folder, ignoring case on Windows', () => {
    expect(insideFolder(`${data}\\node\\node.exe`, data, 'win32')).toBe(true);
    expect(insideFolder(`${data.toUpperCase()}\\NODE\\NODE.EXE`, data, 'win32')).toBe(true);
    expect(insideFolder(`${data}-other\\node.exe`, data, 'win32')).toBe(false);
    expect(insideFolder('/a/b/c', '/a/b', 'linux')).toBe(true);
    expect(insideFolder('/a/B/c', '/a/b', 'linux')).toBe(false);
  });

  test('a node copy in TEMP is removed after it exits; any other node is left alone', () => {
    const tmp = 'C:\\Users\\owner\\AppData\\Local\\Temp';
    const cleanup = cleanupNodeCopyCommand(`${tmp}\\${UNINSTALL_NODE_PREFIX}abc123\\node.exe`, 'C:\\Windows', tmp);
    // wscript (a windowed program, no window with //B), a script that waits half a second between tries; the folder in a variable.
    const dir = `${tmp}\\${UNINSTALL_NODE_PREFIX}abc123`;
    const file = `${tmp}\\buddi-cleanup-${UNINSTALL_NODE_PREFIX}abc123.js`;
    expect(cleanup?.command).toBe('C:\\Windows\\System32\\wscript.exe');
    expect(cleanup?.args).toEqual(['//B', '//NoLogo', '//E:JScript', file]);
    expect(cleanup?.env).toEqual({ [NODE_COPY_DIR_VAR]: dir });
    expect(cleanup?.script.file).toBe(file);
    expect(cleanup?.script.text).toContain('WScript.Sleep(500)');
    expect(cleanup?.script.text).toContain(`Environment("Process")("${NODE_COPY_DIR_VAR}")`);
    expect(cleanup?.script.text).not.toContain(dir);
    expect(cleanupNodeCopyCommand(`${data}\\node\\node.exe`, 'C:\\Windows', tmp)).toBeUndefined();
    expect(cleanupNodeCopyCommand(`D:\\${UNINSTALL_NODE_PREFIX}x\\node.exe`, 'C:\\Windows', tmp)).toBeUndefined();
  });
});

describe('the junctions', () => {
  // On Windows these are junctions; elsewhere the same calls make symlinks, so the replace path is tested anywhere.
  test('current is replaced by a new link, never by following the old one', async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'buddi-junction-')));
    try {
      await mkdir(path.join(dir, 'buddi-1'));
      await mkdir(path.join(dir, 'buddi-2'));
      await writeFile(path.join(dir, 'buddi-1', 'keep'), 'x');
      await pointAt(path.join(dir, 'current'), path.join(dir, 'buddi-1'), 'win32');
      expect(path.resolve(dir, await readlink(path.join(dir, 'current')))).toBe(path.join(dir, 'buddi-1'));
      await pointAt(path.join(dir, 'current'), path.join(dir, 'buddi-2'), 'win32');
      expect(path.resolve(dir, await readlink(path.join(dir, 'current')))).toBe(path.join(dir, 'buddi-2'));
      expect(await readFile(path.join(dir, 'buddi-1', 'keep'), 'utf8')).toBe('x');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  test('a link that is not there yet is simply made', async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'buddi-junction-')));
    try {
      await mkdir(path.join(dir, 'buddi-1'));
      await symlink(path.join(dir, 'buddi-1'), path.join(dir, 'previous.tmp-stale')).catch(() => {});
      await pointAt(path.join(dir, 'previous'), path.join(dir, 'buddi-1'), 'win32');
      expect(path.resolve(dir, await readlink(path.join(dir, 'previous')))).toBe(path.join(dir, 'buddi-1'));
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('the setup program', () => {
  test('takes the setup\'s command line and nothing else', () => {
    expect(parseSetupArgs(['install', '--bundle', 'B', '--data', 'D', '--bin', 'X', '--no-start', '--log', 'L', '--result', 'R'])).toEqual({
      command: 'install', bundle: 'B', data: 'D', bin: 'X', noStart: true, skipBackup: false, keepData: false, log: 'L', result: 'R',
    });
    expect(parseSetupArgs(['uninstall', '--data', 'D', '--summary', 'S'])).toMatchObject({ command: 'uninstall', data: 'D', summary: 'S' });
    expect(() => parseSetupArgs(['install', '--data', 'D'])).toThrow(/--bundle and --bin/);
    expect(() => parseSetupArgs(['uninstall'])).toThrow(/--data is required/);
    expect(() => parseSetupArgs(['install', '--force'])).toThrow(/unknown option --force/);
    expect(() => parseSetupArgs(['repair'])).toThrow(/usage/);
  });

  test('a first install takes no backup', () => {
    expect(setupPlan({ existing: false, newVersion: '0.1.0-pre.55', sameRelease: false, skipBackup: false })).toEqual({ kind: 'fresh', backup: 'none', old: 'none' });
  });

  test('an upgrade backs up with the release under current, and records where it came from', () => {
    expect(setupPlan({ existing: true, oldRoot: 'R', oldVersion: '0.1.0-pre.54', newVersion: '0.1.0-pre.55', sameRelease: false, skipBackup: false }))
      .toEqual({ kind: 'upgrade', backup: 'take', old: 'release', from: '0.1.0-pre.54' });
  });

  test('the same release again is a refresh: no backup, nothing switched', () => {
    expect(setupPlan({ existing: true, oldRoot: 'R', oldVersion: '0.1.0-pre.55', newVersion: '0.1.0-pre.55', sameRelease: true, skipBackup: false }))
      .toMatchObject({ kind: 'reinstall', backup: 'none' });
  });

  test('npm\'s copy serving this folder is moved over with a backup; one serving another folder cannot back it up', () => {
    expect(setupPlan({ existing: true, newVersion: '0.1.0-pre.55', sameRelease: false, npm: { version: '0.1.0-pre.53', serves: true }, skipBackup: false }))
      .toEqual({ kind: 'move', backup: 'take', old: 'npm', from: '0.1.0-pre.53' });
    expect(setupPlan({ existing: true, newVersion: '0.1.0-pre.55', sameRelease: false, npm: { version: '0.1.0-pre.53', serves: false }, skipBackup: false }))
      .toMatchObject({ kind: 'move', backup: 'refuse', old: 'none' });
    expect(setupPlan({ existing: true, newVersion: '0.1.0-pre.55', sameRelease: false, skipBackup: true }))
      .toMatchObject({ backup: 'skipped' });
  });

  test('the newest archive, never its envelope or passphrase file', () => {
    expect(newestArchive([
      { name: 'buddi-backup-1.tar.gz.age', mtimeMs: 1 },
      { name: 'buddi-backup-2.tar.gz.age', mtimeMs: 2 },
      { name: 'buddi-backup-2.tar.gz.json', mtimeMs: 3 },
      { name: 'buddi-backup-2.tar.gz.age.passphrase.txt', mtimeMs: 4 },
      { name: 'notes', mtimeMs: 5 },
    ])).toBe('buddi-backup-2.tar.gz.age');
    expect(newestArchive([])).toBeUndefined();
  });

  test('npm\'s buddi.cmd is recognised by what it runs', () => {
    expect(npmShimRunsBuddi('@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@withbuddi\\buddi\\packages\\install\\dist\\launcher.js" %*\r\n')).toBe(true);
    expect(npmShimRunsBuddi('"$basedir/node_modules/@withbuddi/buddi/packages/install/dist/launcher.js"')).toBe(true);
    expect(npmShimRunsBuddi(buildWindowsCommand(data))).toBe(false);
    expect(npmShimRunsBuddi(undefined)).toBe(false);
  });

  test('keeps the lines of buddi uninstall the owner must not lose', () => {
    const output = [
      'This removes buddi from this machine:',
      '  - the data directory C:\\x',
      'The backup is C:\\Users\\o\\buddi-backups\\buddi-backup-1.tar.gz.age. It stays: uninstall does not touch that folder.',
      'Your backup passphrase, which opens the backups and is about to leave this machine\'s vault: a b c d e f',
      'It is also in C:\\Users\\o\\buddi-backups\\buddi-backup-1.tar.gz.age.passphrase.txt (only you can read it).',
      'buddi is removed. To install it again, download the setup from https://withbuddi.com',
    ].join('\r\n');
    expect(uninstallSummary(output)).toHaveLength(4);
    expect(uninstallSummary(output)[0]).toMatch(/^The backup is /);
  });

  test('a failed upgrade names the setup of the version to go back to', () => {
    const sentence = recoverySentence({ from: '0.1.0-pre.54', to: '0.1.0-pre.55', startedAt: '', finishedAt: '', outcome: 'failed', step: 'migrating', error: 'boom', backup: 'buddi-backup-1.tar.gz.age' }, { windows: true });
    expect(sentence).toContain(`Run ${windowsSetupName('0.1.0-pre.54')} (from https://github.com/withbuddi/buddi/releases/tag/v0.1.0-pre.54)`);
    expect(sentence).toContain('buddi backup restore buddi-backup-1.tar.gz.age');
  });
});

describe('the setup program, run', () => {
  test('runs when node names it through current (a junction), not only by its own path', async () => {
    const { runAsProgram } = await import('./windows-setup.js');
    const real = (file: string): string => file.replace('\\current\\', '\\buddi-0.1.0-pre.55\\node_modules\\@withbuddi\\buddi\\');
    const self = 'C:\\d\\releases\\buddi-0.1.0-pre.55\\node_modules\\@withbuddi\\buddi\\packages\\install\\dist\\windows-setup.js';
    expect(runAsProgram('C:\\d\\releases\\current\\packages\\install\\dist\\windows-setup.js', self, real)).toBe(true);
    expect(runAsProgram(self.toUpperCase(), self, file => file)).toBe(true);
    expect(runAsProgram('C:\\other.js', self, real)).toBe(false);
    expect(runAsProgram(undefined, self, real)).toBe(false);
  });
});
