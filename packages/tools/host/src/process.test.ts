import { describe, expect, it } from 'vitest';
import { commandEnv, runCommand } from './process.js';

const base = { cwd: '/tmp', timeoutMs: 3000, env: process.env };
describe('host command processes', () => {
  it('returns stdout, stderr and nonzero status honestly', async () => {
    expect(await runCommand({ ...base, command: 'printf hello; printf problem >&2; exit 7' }))
      .toMatchObject({ state: 'completed', stdout: 'hello', stderr: 'problem', exitCode: 7 });
  });
  it('does not inherit application credentials or shell startup variables', () => {
    const env = commandEnv({ HOME: '/tmp', DATABASE_URL: 'secret', ANTHROPIC_API_KEY: 'secret', BASH_ENV: '/tmp/evil', NODE_OPTIONS: '--inspect' });
    expect(env.HOME).toBe('/tmp');
    expect(env).not.toHaveProperty('DATABASE_URL'); expect(env).not.toHaveProperty('BASH_ENV');
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY'); expect(env).not.toHaveProperty('NODE_OPTIONS');
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
