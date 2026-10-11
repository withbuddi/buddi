import { describe, expect, test } from 'vitest';
import path from 'node:path';
import { buildSuperviseScript, buildTaskXml, registerWindowsTask, taskXmlBytes, windowsTaskScript } from './windows-task.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nameSupervisorPipe, supervisorSocket } from './supervisor.js';

describe('the Windows service', () => {
  test('the script sets the environment and appends the supervisor to its log', () => {
    const text = buildSuperviseScript({
      nodePath: 'C:\\Users\\me\\AppData\\Local\\node\\node.exe',
      entry: 'C:\\Users\\me\\AppData\\Local\\node\\node_modules\\@withbuddi\\buddi\\packages\\install\\dist\\launcher.js',
      environment: { BUDDI_DATA_DIR: 'C:\\Users\\me\\AppData\\Local\\buddi', BUDDI_WEB_PORT: '4417' },
      logFile: 'C:\\Users\\me\\AppData\\Local\\buddi\\logs\\supervisor.log',
    });
    expect(text.split('\r\n')).toEqual([
      '@echo off',
      'rem Written by buddi. Task Scheduler runs it at logon to start the supervisor.',
      'set "BUDDI_DATA_DIR=C:\\Users\\me\\AppData\\Local\\buddi"',
      'set "BUDDI_WEB_PORT=4417"',
      '"C:\\Users\\me\\AppData\\Local\\node\\node.exe" "C:\\Users\\me\\AppData\\Local\\node\\node_modules\\@withbuddi\\buddi\\packages\\install\\dist\\launcher.js" supervise >> "C:\\Users\\me\\AppData\\Local\\buddi\\logs\\supervisor.log" 2>&1',
      '',
    ]);
  });

  test('a percent sign stays literal, and a quote is refused', () => {
    const base = { nodePath: 'C:\\node.exe', entry: 'C:\\l.js', logFile: 'C:\\s.log' };
    expect(buildSuperviseScript({ ...base, environment: { BUDDI_DATA_DIR: 'C:\\100%\\buddi' } })).toContain('set "BUDDI_DATA_DIR=C:\\100%%\\buddi"');
    expect(() => buildSuperviseScript({ ...base, environment: { BUDDI_DATA_DIR: 'C:\\a"b' } })).toThrow(/quote/);
  });

  test('the task starts at the owner\'s logon, unelevated, headless, never time-limited', () => {
    const script = windowsTaskScript('C:\\Users\\me\\AppData\\Local\\buddi');
    expect(script).toBe('C:\\Users\\me\\AppData\\Local\\buddi\\service\\supervise.cmd');
    const xml = buildTaskXml({ user: 'PC\\me & co', script, workingDirectory: 'C:\\Users\\me\\AppData\\Local\\buddi', systemRoot: 'C:\\Windows' });
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<UserId>PC\\me &amp; co</UserId>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
    expect(xml).toContain('<Command>C:\\Windows\\System32\\conhost.exe</Command>');
    expect(xml).toContain('<Arguments>--headless &quot;C:\\Windows\\System32\\cmd.exe&quot; /d /c &quot;C:\\Users\\me\\AppData\\Local\\buddi\\service\\supervise.cmd&quot;</Arguments>');
    const bytes = taskXmlBytes(xml);
    expect([...bytes.subarray(0, 2)]).toEqual([0xff, 0xfe]);
  });

  test('registering replaces the task, ends a running copy and starts it', async () => {
    const calls: string[] = [];
    await registerWindowsTask(async (cmd, args) => { calls.push([cmd, ...args].join(' ')); if (args[0] === '/End') throw new Error('not running'); }, 'com.buddi.install.abc', 'C:\\d\\service\\task.xml');
    expect(calls).toEqual([
      'schtasks.exe /Create /TN com.buddi.install.abc /XML C:\\d\\service\\task.xml /F',
      'schtasks.exe /End /TN com.buddi.install.abc',
      'schtasks.exe /Run /TN com.buddi.install.abc',
    ]);
  });

  test('the control socket is a named pipe whose random name the supervisor keeps in the data directory', async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'buddi-pipe-'));
    // No supervisor has named one yet: a fresh name each time, which nobody answers.
    const none = supervisorSocket(data, 'win32');
    expect(none).toMatch(/^\\\\\.\\pipe\\buddi-supervisor-none-[0-9a-f]{32}$/);
    expect(supervisorSocket(data, 'win32')).not.toBe(none);
    await nameSupervisorPipe(data, 'win32');
    const named = supervisorSocket(data, 'win32');
    expect(named).toMatch(/^\\\\\.\\pipe\\buddi-supervisor-[0-9a-f]{32}$/);
    expect(supervisorSocket(data, 'win32')).toBe(named);
    // Each start, a new one.
    await nameSupervisorPipe(data, 'win32');
    expect(supervisorSocket(data, 'win32')).not.toBe(named);
    // Something else in the file is not taken for a name.
    await writeFile(path.join(data, 'supervisor.pipe'), '..\\other');
    expect(supervisorSocket(data, 'win32')).toMatch(/buddi-supervisor-none-/);
    expect(supervisorSocket('/data', 'darwin')).toBe(path.join('/data', 'supervisor.sock'));
  });
});
