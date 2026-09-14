import { describe, expect, it } from 'vitest';
import { DB_UNREACHABLE, DOCKER_DOWN, dockerState } from './db-cmd.js';
import type { RunResult } from './proc.js';

/** A `run` that answers from a table instead of spawning anything. */
function fakeRun(answers: Record<string, RunResult>) {
  return async (command: string, args: string[] = []): Promise<RunResult> => {
    const key = [command, ...args].join(' ');
    const hit = Object.entries(answers).find(([prefix]) => key.startsWith(prefix));
    return hit?.[1] ?? { code: 1, stdout: '', stderr: 'unexpected call' };
  };
}

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' });

describe('dockerState', () => {
  it('reports the engine version when the daemon answers', async () => {
    const state = await dockerState(
      fakeRun({
        'docker --version': ok('Docker version 27.3.1, build ce1223035a\n'),
        'docker info': ok('27.3.1\n'),
      }) as never,
    );
    expect(state.state).toBe('running');
    expect(state.detail).toContain('Docker version 27.3.1');
    expect(state.detail).toContain('engine 27.3.1');
  });

  it('calls a client without a daemon stopped — the post-reboot case', async () => {
    const state = await dockerState(
      fakeRun({
        'docker --version': ok('Docker version 27.3.1, build ce1223035a\n'),
        'docker info': {
          code: 1,
          stdout: '',
          stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
        },
      }) as never,
    );
    expect(state).toEqual({ state: 'stopped', detail: DOCKER_DOWN });
    expect(state.detail).toBe('Docker is not running (open -a Docker)');
  });

  it('reports an absent binary as absent, not as a stopped daemon', async () => {
    const state = await dockerState(
      fakeRun({ 'docker --version': { code: 127, stdout: '', stderr: 'ENOENT' } }) as never,
    );
    expect(state.state).toBe('absent');
  });
});

describe('DB_UNREACHABLE', () => {
  it('is the one line the rows below the database share', () => {
    expect(DB_UNREACHABLE).toBe('skipped: database unreachable');
  });
});
