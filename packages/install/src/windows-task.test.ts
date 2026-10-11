import { describe, expect, test } from 'vitest';
import path from 'node:path';
import { buildSuperviseScript, buildTaskXml, followLogsCommand, registerWindowsTask, taskXmlBytes, windowsTaskScript } from './windows-task.js';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { answeredBySupervisor, nameSupervisorPipe, supervisorSocket } from './supervisor.js';

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
      'chcp 65001 >nul',
      'rem Written by buddi. Task Scheduler runs it at logon to start the supervisor.',
      'set "BUDDI_DATA_DIR=C:\\Users\\me\\AppData\\Local\\buddi"',
      'set "BUDDI_WEB_PORT=4417"',
      '"C:\\Users\\me\\AppData\\Local\\node\\node.exe" "C:\\Users\\me\\AppData\\Local\\node\\node_modules\\@withbuddi\\buddi\\packages\\install\\dist\\launcher.js" supervise >> "C:\\Users\\me\\AppData\\Local\\buddi\\logs\\supervisor.log" 2>&1',
      '',
    ]);
  });

  test('a non-ASCII path is written as UTF-8 after switching cmd to UTF-8', () => {
    const text = buildSuperviseScript({ nodePath: 'C:\\Users\\Zoë\\node\\node.exe', entry: 'C:\\l.js', logFile: 'C:\\Users\\Zoë\\s.log', environment: { BUDDI_DATA_DIR: 'C:\\Users\\Zoë\\AppData\\Local\\buddi' } });
    const lines = text.split('\r\n');
    expect(lines.indexOf('chcp 65001 >nul')).toBeLessThan(lines.findIndex(line => line.includes('Zoë')));
    expect(Buffer.from(text, 'utf8').toString('utf8')).toContain('set "BUDDI_DATA_DIR=C:\\Users\\Zoë\\AppData\\Local\\buddi"');
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
    expect(xml).toContain('<Arguments>--headless &quot;C:\\Windows\\System32\\cmd.exe&quot; /d /s /c &quot;&quot;C:\\Users\\me\\AppData\\Local\\buddi\\service\\supervise.cmd&quot;&quot;</Arguments>');
    // A profile with ( ) & keeps its path whole.
    const odd = buildTaskXml({ user: 'PC\\me', script: 'C:\\Users\\Jane (Work) & Co\\buddi\\service\\supervise.cmd', workingDirectory: 'C:\\Users\\Jane (Work) & Co', systemRoot: 'C:\\Windows' });
    expect(odd).toContain('/d /s /c &quot;&quot;C:\\Users\\Jane (Work) &amp; Co\\buddi\\service\\supervise.cmd&quot;&quot;</Arguments>');
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

  test('the control socket is a named pipe whose random name and secret the live supervisor keeps in the data directory', async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'buddi-pipe-'));
    // No supervisor has named one yet: a fresh name each time, which nobody answers.
    const none = supervisorSocket(data, 'win32');
    expect(none).toMatch(/^\\\\\.\\pipe\\buddi-supervisor-none-[0-9a-f]{32}$/);
    expect(supervisorSocket(data, 'win32')).not.toBe(none);
    const secret = await nameSupervisorPipe(data, 'win32');
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    // Named, but no live supervisor holds the lock: still nobody's.
    expect(supervisorSocket(data, 'win32')).toMatch(/buddi-supervisor-none-/);
    await writeFile(path.join(data, 'supervisor.lock'), String(process.pid));
    const named = supervisorSocket(data, 'win32');
    expect(named).toMatch(/^\\\\\.\\pipe\\buddi-supervisor-[0-9a-f]{32}$/);
    expect(supervisorSocket(data, 'win32')).toBe(named);
    // An answer counts only with the secret.
    expect(answeredBySupervisor(data, { 'x-buddi-supervisor': secret }, 'win32')).toBe(true);
    expect(answeredBySupervisor(data, {}, 'win32')).toBe(false);
    expect(answeredBySupervisor(data, { 'x-buddi-supervisor': 'f'.repeat(64) }, 'win32')).toBe(false);
    expect(answeredBySupervisor(data, {}, 'darwin')).toBe(true);
    // Each start, a new one.
    await nameSupervisorPipe(data, 'win32');
    expect(supervisorSocket(data, 'win32')).not.toBe(named);
    // A dead supervisor's lock: nobody's again.
    await writeFile(path.join(data, 'supervisor.lock'), '999999999');
    expect(supervisorSocket(data, 'win32')).toMatch(/buddi-supervisor-none-/);
    // Something else in the file is not taken for a name.
    await writeFile(path.join(data, 'supervisor.lock'), String(process.pid));
    await writeFile(path.join(data, 'supervisor.pipe'), '..\\other');
    expect(supervisorSocket(data, 'win32')).toMatch(/buddi-supervisor-none-/);
    expect(supervisorSocket('/data', 'darwin')).toBe(path.join('/data', 'supervisor.sock'));
  });

  test('service logs follows every file, named in the environment', () => {
    const { args, env } = followLogsCommand(['C:\\b\\logs\\supervisor.log', "C:\\Jane's (Work)\\logs\\gateway.log"]);
    expect(env.BUDDI_FOLLOW).toBe("C:\\b\\logs\\supervisor.log\nC:\\Jane's (Work)\\logs\\gateway.log");
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const script = Buffer.from(args[3]!, 'base64').toString('utf16le');
    expect(script).toContain('-split "`n"');
    expect(script).toContain('foreach ($f in $files)');
    expect(script).not.toContain('Jane');
  });
});
