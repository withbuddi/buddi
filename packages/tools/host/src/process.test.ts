import { describe, expect, it } from 'vitest';
import { commandEnv, hostShell, powershellScript, runCommand, shellArgv } from './process.js';

describe('host commands on Windows (simulated)', () => {
  it('runs a script file in Windows PowerShell 5.1, never through a quoted command line', () => {
    const argv = shellArgv('win32', 'Get-Date', { SystemRoot: 'C:\\Windows' }, 'C:\\Temp\\buddi-host-1\\command.ps1');
    expect(argv).toEqual(['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'C:\\Temp\\buddi-host-1\\command.ps1']);
    expect(hostShell('win32')).toEqual({ name: 'powershell.exe', label: 'Windows PowerShell 5.1 (powershell.exe)' });
    expect(hostShell('linux').name).toBe('/bin/bash');
  });
  it('puts the command in a kill-on-close job, with UTF-8 out and a native failure as its exit code', () => {
    const script = powershellScript('pandoc in.md -o out.docx', "C:\\Users\\o'b\\Temp\\buddi-host-job-1.dll");
    expect(script).toContain("Add-Type -Path 'C:\\Users\\o''b\\Temp\\buddi-host-job-1.dll'");
    expect(powershellScript('Get-Date')).not.toContain('BuddiHostJob');
    expect(script).toContain('[Console]::OutputEncoding = [System.Text.Encoding]::UTF8');
    expect(script.indexOf('BuddiHostJob]::Enter()')).toBeLessThan(script.indexOf('pandoc in.md -o out.docx'));
    expect(script.trimEnd().endsWith('if ($LASTEXITCODE -is [int] -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE }\r\nif (-not $buddiLastOk) { exit 1 }')).toBe(true);
  });
  it('passes the system and profile variables and the owner\'s PATH, never credentials', () => {
    const env = commandEnv({ SystemRoot: 'C:\\Windows', Path: 'C:\\Python312;C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\o', TEMP: 'C:\\Users\\o\\AppData\\Local\\Temp',
      DATABASE_URL: 'secret', OPENAI_API_KEY: 'secret', BUDDI_VAULT: 'secret', NODE_OPTIONS: '--inspect' }, 'win32');
    expect(env).toMatchObject({ SystemRoot: 'C:\\Windows', PATH: 'C:\\Python312;C:\\Windows\\System32', USERPROFILE: 'C:\\Users\\o', TEMP: 'C:\\Users\\o\\AppData\\Local\\Temp' });
    for (const key of ['DATABASE_URL', 'OPENAI_API_KEY', 'BUDDI_VAULT', 'NODE_OPTIONS', 'HOME']) expect(env).not.toHaveProperty(key);
  });
});

// The real thing, where it can run: a command, a native failure, and a timeout that ends a child.
describe.runIf(process.platform === 'win32')('host command processes on Windows', () => {
  const base = { cwd: process.cwd(), timeoutMs: 20_000, env: process.env };
  // A cold Add-Type (the job) costs a couple of seconds per command.
  it('runs PowerShell and reports a native failure', { timeout: 60_000 }, async () => {
    const hello = await runCommand({ ...base, command: 'Write-Output "hello"' });
    expect(hello, JSON.stringify(hello)).toMatchObject({ state: 'completed', exitCode: 0, stdout: expect.stringContaining('hello') });
    expect((await runCommand({ ...base, command: 'cmd /c exit 7' })).exitCode).toBe(7);
    // A program that is not installed fails, with PowerShell's sentence on stderr.
    const missing = await runCommand({ ...base, command: 'pandoc-not-installed in.md -o out.docx' });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain('is not recognized');
  });
  it('times out and ends the whole tree', { timeout: 60_000 }, async () => {
    const started = Date.now();
    const result = await runCommand({ ...base, timeoutMs: 1500, command: 'Start-Process -NoNewWindow -FilePath powershell.exe -ArgumentList "-NoProfile","-Command","Start-Sleep 60"; Start-Sleep 60' });
    expect(result.state).toBe('timed-out');
    expect(Date.now() - started).toBeLessThan(15_000);
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
