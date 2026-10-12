import { describe, expect, it } from 'vitest';
import { JOB_FAILED_MARKER, WINDOWS_BOOTSTRAP, WINDOWS_SUPERVISOR, commandEnv, hostShell, runCommand, shellArgv, stopWindowsCommand, windowsCommandScript, windowsStdin } from './process.js';

describe('host commands on Windows (simulated)', () => {
  it('runs an in-memory supervisor in Windows PowerShell 5.1: no file, and the command never on the command line', () => {
    const argv = shellArgv('win32', 'Get-Date -Format o', { SystemRoot: 'C:\\Windows' });
    expect(argv).toEqual(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_BOOTSTRAP]);
    // A fixed bootstrap with nothing for a command line to quote; the rest arrives on stdin.
    expect(WINDOWS_BOOTSTRAP).not.toContain('"');
    const [supervisor, command, rest] = windowsStdin('Get-Date -Format o').split('\n');
    expect(Buffer.from(supervisor!, 'base64').toString('utf8')).toBe(WINDOWS_SUPERVISOR);
    expect(Buffer.from(command!, 'base64').toString('utf8')).toBe(windowsCommandScript('Get-Date -Format o'));
    expect(rest).toBe('');
    expect(argv.join(' ')).not.toContain('Get-Date');
    expect(argv.join(' ')).not.toMatch(/-File|\.ps1|\.dll/);
    expect(hostShell('win32')).toEqual({ name: 'powershell.exe', label: 'Windows PowerShell 5.1 (powershell.exe)' });
    expect(hostShell('linux').name).toBe('/bin/bash');
  });
  it('joins a kill-on-close job before reading the command, and runs nothing when it cannot (fail closed)', () => {
    const s = WINDOWS_SUPERVISOR;
    expect(s).not.toMatch(/Add-Type|LoadFrom|LoadFile|Assembly\]::Load/);
    expect(s).toContain('0x2000');
    const joined = s.indexOf('AssignProcessToJobObject($__buddiJob');
    const failed = s.indexOf(`exit 125`);
    const read = s.indexOf('ReadToEnd()');
    expect(joined).toBeGreaterThan(0);
    expect(joined).toBeLessThan(failed);
    expect(failed).toBeLessThan(read);
    expect(s).toContain(`'${JOB_FAILED_MARKER}'`);
  });
  it('gives the last statement\'s status: $? first, a native code only when it failed', () => {
    const script = windowsCommandScript('cmd /c exit 7; Write-Output recovered');
    const lines = script.split('\r\n');
    expect(lines.slice(0, 5)).toEqual(['cmd /c exit 7; Write-Output recovered', '$__buddiLastOk = $?', 'if ($__buddiLastOk) { exit 0 }',
      'if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }', 'exit 1']);
  });
  it('confirms a stop only on an observed exit, escalating to taskkill when terminating is not enough', async () => {
    // Terminating the supervisor ends it: no taskkill.
    let killed = 0;
    let exit!: () => void;
    let exited = new Promise<void>((r) => { exit = r; });
    expect(await stopWindowsCommand({ terminate: () => exit(), exited, taskkill: async () => { killed += 1; return 0; }, boundMs: 50 })).toBe(true);
    expect(killed).toBe(0);
    // It does not end: taskkill, awaited, and it does.
    exited = new Promise<void>((r) => { exit = r; });
    expect(await stopWindowsCommand({ terminate: () => { throw new Error('access denied'); }, exited, taskkill: async () => { killed += 1; exit(); return 0; }, boundMs: 50 })).toBe(true);
    expect(killed).toBe(1);
    // Nothing ends it: not confirmed.
    expect(await stopWindowsCommand({ terminate: () => undefined, exited: new Promise(() => undefined), taskkill: async () => 128, boundMs: 50 })).toBe(false);
    // A taskkill that hangs is bounded too.
    expect(await stopWindowsCommand({ terminate: () => undefined, exited: new Promise(() => undefined), taskkill: () => new Promise(() => undefined), boundMs: 50 })).toBe(false);
  });
  it('passes the system and profile variables and the owner\'s PATH, never credentials', () => {
    const env = commandEnv({ SystemRoot: 'C:\\Windows', Path: 'C:\\Python312;C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\o', TEMP: 'C:\\Users\\o\\AppData\\Local\\Temp',
      DATABASE_URL: 'secret', OPENAI_API_KEY: 'secret', BUDDI_VAULT: 'secret', NODE_OPTIONS: '--inspect' }, 'win32');
    expect(env).toMatchObject({ SystemRoot: 'C:\\Windows', PATH: 'C:\\Python312;C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\o', TEMP: 'C:\\Users\\o\\AppData\\Local\\Temp' });
    for (const key of ['DATABASE_URL', 'OPENAI_API_KEY', 'BUDDI_VAULT', 'NODE_OPTIONS', 'HOME']) expect(env).not.toHaveProperty(key);
  });
});

// The real thing, on a Windows computer: a command, a native failure, a timeout
// that ends a child, a background program ended with its command. Not on the
// GitHub runner, where powershell.exe alone takes 18 to 60+ seconds to start
// (measured): it would test the runner, not this. Run on a Windows VM.
describe.runIf(process.platform === 'win32' && !process.env.CI)('host command processes on Windows', () => {
  const base = { cwd: process.cwd(), timeoutMs: 20_000, env: process.env };
  it('runs PowerShell and reports a native failure', { timeout: 60_000 }, async () => {
    const hello = await runCommand({ ...base, command: 'Write-Output "hello"' });
    expect(hello, JSON.stringify(hello)).toMatchObject({ state: 'completed', exitCode: 0, stdout: expect.stringContaining('hello') });
    expect((await runCommand({ ...base, command: 'cmd /c exit 7' })).exitCode).toBe(7);
    // A stale native code does not outlive a later success; an explicit exit is kept.
    expect(await runCommand({ ...base, command: "cmd /c exit 7; Write-Output 'recovered'" })).toMatchObject({ exitCode: 0, stdout: expect.stringContaining('recovered') });
    expect((await runCommand({ ...base, command: 'Write-Output a; exit 3' })).exitCode).toBe(3);
    // Unicode both ways, and a command with every kind of quote.
    expect((await runCommand({ ...base, command: `Write-Output "café ✓ 'q' \`"dq\`""` })).stdout).toContain(`café ✓ 'q' "dq"`);
    // A program that is not installed fails, with PowerShell's sentence on stderr.
    const missing = await runCommand({ ...base, command: 'pandoc-not-installed in.md -o out.docx' });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('is not recognized');
    // Plain text, never CLIXML.
    expect(missing.stderr).not.toContain('CLIXML');
    expect(hello.stderr).toBe('');
  });
  it('times out and ends the whole tree', { timeout: 60_000 }, async () => {
    const started = Date.now();
    const result = await runCommand({ ...base, timeoutMs: 1500, command: 'Start-Process -NoNewWindow -FilePath powershell.exe -ArgumentList "-NoProfile","-Command","Start-Sleep 60"; Start-Sleep 60' });
    expect(result.state).toBe('timed-out');
    expect(Date.now() - started).toBeLessThan(15_000);
  });
  it('stops on cancel and at the output cap', { timeout: 60_000 }, async () => {
    const controller = new AbortController();
    const pending = runCommand({ ...base, command: 'Start-Sleep 60', signal: controller.signal });
    setTimeout(() => controller.abort(), 4000);
    expect((await pending).state).toBe('cancelled');
    const noisy = await runCommand({ ...base, command: 'while ($true) { Write-Output ("x" * 1000) }' });
    expect(noisy.state).toBe('output-limit');
    expect(Buffer.byteLength(noisy.stdout)).toBeLessThanOrEqual(65536);
  });
  it('ends a background program with the command that started it', { timeout: 60_000 }, async () => {
    const result = await runCommand({ ...base, command: '(Start-Process -PassThru -WindowStyle Hidden -FilePath powershell.exe -ArgumentList "-NoProfile","-Command","Start-Sleep 60").Id' });
    expect(result, JSON.stringify(result)).toMatchObject({ state: 'completed', exitCode: 0 });
    const pid = Number(result.stdout.trim());
    expect(pid).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1000));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

const base = { cwd: '/tmp', timeoutMs: 3000, env: process.env };
// Host execution is macOS and Linux only (process.ts refuses Windows).
describe.skipIf(process.platform === 'win32')('host command processes', () => {
  it('returns stdout, stderr and nonzero status honestly', async () => {
    expect(await runCommand({ ...base, command: 'printf hello; printf problem >&2; exit 7' }))
      .toMatchObject({ state: 'completed', stdout: 'hello', stderr: 'problem', exitCode: 7 });
  });
  it('does not inherit application credentials or shell startup variables', () => {
    const env = commandEnv({ HOME: '/tmp', DATABASE_URL: 'secret', OPENAI_API_KEY: 'secret', BASH_ENV: '/tmp/evil', NODE_OPTIONS: '--inspect' });
    expect(env.HOME).toBe('/tmp');
    expect(env).not.toHaveProperty('DATABASE_URL'); expect(env).not.toHaveProperty('BASH_ENV');
    expect(env).not.toHaveProperty('OPENAI_API_KEY'); expect(env).not.toHaveProperty('NODE_OPTIONS');
  });
  it('closes stdin so a prompt cannot hang waiting for a password', async () => {
    expect((await runCommand({ ...base, command: 'read answer; printf "read:%s" "$?"' })).stdout).toBe('read:1');
  });
  it('times out and kills children including those ignoring TERM', async () => {
    const started = Date.now();
    const result = await runCommand({ ...base, timeoutMs: 100, command: 'trap "" TERM; sleep 30 & wait' });
    expect(result.state).toBe('timed-out'); expect(Date.now() - started).toBeLessThan(2500);
  });
  it('aborts a running process and refuses pre-aborted work', async () => {
    const controller = new AbortController();
    const pending = runCommand({ ...base, command: 'sleep 30', signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect((await pending).state).toBe('cancelled');
    expect(() => runCommand({ ...base, command: 'true', signal: controller.signal })).toThrow();
  });
  it('caps output and terminates noisy commands', async () => {
    const result = await runCommand({ ...base, command: 'yes output' });
    expect(result.state).toBe('output-limit'); expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(65536);
  });
  it('cleans up background children even after the parent exits', async () => {
    const started = Date.now();
    const result = await runCommand({ ...base, command: 'sleep 30 & printf done' });
    expect(result.stdout).toBe('done'); expect(Date.now() - started).toBeLessThan(2500);
  });
});
