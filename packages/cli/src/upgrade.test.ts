/**
 * `buddi upgrade` — the order, and the four ways it stops.
 *
 * Nothing here runs `pnpm`, `git`, `docker` or launchd: every child process is
 * a recorded call and every service move is a spy, so what is asserted is the
 * *sequence* — which is the entire reason this is a command rather than a
 * paragraph in the README.
 */
import { describe, expect, it, vi } from 'vitest';
import { upgradeReport } from './upgrade.js';

/** A spawn that succeeds, recording what it was asked to run. */
function fakeSpawn(codeFor: (command: string, args: string[]) => number = () => 0): {
  spawn: (command: string, args: string[]) => Promise<number>;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    spawn: async (command: string, args: string[]) => {
      // The node entry is an absolute path; the interesting word is the verb.
      const label = command.endsWith('node') || command === process.execPath ? 'buddi' : command;
      calls.push([label, ...args.filter((a) => !a.endsWith('main.js'))].join(' '));
      return codeFor(command, args);
    },
  };
}

const noGit = async () => ({ code: 1, stdout: '' });

function fakeService(installed: boolean, running: boolean) {
  return {
    status: vi.fn(async () => ({ installed, running })),
    stop: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
  };
}

describe('upgradeReport', () => {
  it('backs up, stops the service, installs, builds, migrates, restarts, checks', async () => {
    const { spawn, calls } = fakeSpawn();
    const service = fakeService(true, true);

    const report = await upgradeReport({
      spawn,
      capture: noGit,
      service,
      out: () => {},
    });

    expect(report.code).toBe(0);
    expect(calls).toEqual([
      'buddi backup create',
      'pnpm install',
      'pnpm -r build',
      'buddi migrate',
      'buddi doctor',
    ]);
    // The service stops before the schema moves and starts after it has.
    expect(service.stop).toHaveBeenCalledTimes(1);
    expect(service.start).toHaveBeenCalledTimes(1);
    expect(report.serviceWasRunning).toBe(true);
  });

  /**
   * `buddi migrate` and not `pnpm db:migrate`: the former is core's migrations
   * *and every installed plugin's*, so a plugin schema is never left a version
   * behind the code that reads it.
   */
  it('migrates through the command that also migrates plugins', async () => {
    const { spawn, calls } = fakeSpawn();
    await upgradeReport({ spawn, capture: noGit, out: () => {} });
    expect(calls).toContain('buddi migrate');
    expect(calls.some((c) => c.includes('db:migrate'))).toBe(false);
  });

  it('never fetches — the checkout is the owner\'s', async () => {
    const { spawn, calls } = fakeSpawn();
    const capture = vi.fn(async (_command: string, _args: string[]) => ({
      code: 0,
      stdout: 'abc1234 a commit\n',
    }));
    const out: string[] = [];

    await upgradeReport({ spawn, capture, service: fakeService(false, false), out: (l) => out.push(l) });

    expect(calls.some((c) => c.startsWith('git'))).toBe(false);
    // It reads git, to say where you are; it never writes to it.
    expect(
      capture.mock.calls.every(([, args]) => args[0] === 'log' || args[0] === 'status'),
    ).toBe(true);
    expect(out.join('\n')).toContain('It does not fetch');
    expect(out.join('\n')).toContain('abc1234');
  });

  it('installs a service that was not running back into not running', async () => {
    const service = fakeService(true, false);
    const report = await upgradeReport({
      spawn: fakeSpawn().spawn,
      capture: noGit,
      service,
      out: () => {},
    });
    expect(service.stop).not.toHaveBeenCalled();
    expect(service.start).not.toHaveBeenCalled();
    expect(report.serviceWasRunning).toBe(false);
  });

  /* -------------------------------------------------------------- *
   * Failing halfway
   * -------------------------------------------------------------- */

  /**
   * The migration is the one step that cannot be taken back, so it does not run
   * without an archive in front of it. A failed backup therefore stops the run
   * before it has touched anything at all.
   */
  it('stops before everything when the backup fails', async () => {
    const { spawn, calls } = fakeSpawn((_, args) => (args.includes('backup') ? 1 : 0));
    const service = fakeService(true, true);
    const out: string[] = [];

    const report = await upgradeReport({ spawn, capture: noGit, service, out: (l) => out.push(l) });

    expect(report.code).toBe(1);
    expect(calls).toEqual(['buddi backup create']);
    expect(service.stop).not.toHaveBeenCalled();
    expect(out.join('\n')).toContain('--no-backup');
  });

  it('skips the archive on --no-backup and says so', async () => {
    const { spawn, calls } = fakeSpawn();
    await upgradeReport({ spawn, capture: noGit, backup: false, out: () => {} });
    expect(calls).toEqual(['pnpm install', 'pnpm -r build', 'buddi migrate', 'buddi doctor']);
  });

  it('does not migrate when the build failed, and puts the service back', async () => {
    const { spawn, calls } = fakeSpawn((command, args) =>
      command === 'pnpm' && args.includes('build') ? 2 : 0,
    );
    const service = fakeService(true, true);
    const out: string[] = [];

    const report = await upgradeReport({ spawn, capture: noGit, service, out: (l) => out.push(l) });

    expect(report.code).toBe(1);
    expect(calls).toEqual(['buddi backup create', 'pnpm install', 'pnpm -r build']);
    // A failed upgrade is a working old installation, not a stopped one.
    expect(service.start).toHaveBeenCalledTimes(1);
    expect(out.join('\n')).toContain('the database is untouched');
  });

  it('does not build when the install failed', async () => {
    const { spawn, calls } = fakeSpawn((command, args) =>
      command === 'pnpm' && args[0] === 'install' ? 1 : 0,
    );
    const report = await upgradeReport({ spawn, capture: noGit, out: () => {} });
    expect(report.code).toBe(1);
    expect(calls).toEqual(['buddi backup create', 'pnpm install']);
  });

  /**
   * New code built, schema not migrated, is the one combination to never leave
   * running — so this is the single failure that deliberately does *not* start
   * the service again, and says why.
   */
  it('leaves the service down when the migration failed, and says why', async () => {
    const { spawn, calls } = fakeSpawn((_, args) => (args.includes('migrate') ? 1 : 0));
    const service = fakeService(true, true);
    const out: string[] = [];

    const report = await upgradeReport({ spawn, capture: noGit, service, out: (l) => out.push(l) });

    expect(report.code).toBe(1);
    expect(calls).toEqual([
      'buddi backup create',
      'pnpm install',
      'pnpm -r build',
      'buddi migrate',
    ]);
    expect(out.join('\n')).toContain('do not start');
    expect(out.join('\n')).toContain('backup taken at the start');
  });

  /**
   * The upgrade itself succeeded; the doctor found a warning. That is a
   * configuration question, and the wording says so rather than implying the
   * upgrade failed — but the exit code still carries it, so a script notices.
   */
  it('reports a doctor failure as a finished upgrade with something to look at', async () => {
    const { spawn } = fakeSpawn((_, args) => (args.includes('doctor') ? 1 : 0));
    const out: string[] = [];
    const report = await upgradeReport({ spawn, capture: noGit, out: (l) => out.push(l) });
    expect(report.code).toBe(1);
    expect(out.join('\n')).toContain('the upgrade');
    expect(out.join('\n')).toContain('completed');
  });

  it('survives a service manager that throws at every step', async () => {
    const service = {
      status: async () => {
        throw new Error('launchctl: Operation not permitted');
      },
      stop: async () => {
        throw new Error('nope');
      },
      start: async () => {
        throw new Error('nope');
      },
    };
    const report = await upgradeReport({
      spawn: fakeSpawn().spawn,
      capture: noGit,
      service,
      out: () => {},
    });
    expect(report.code).toBe(0);
  });

  it('notes local edits rather than refusing to run over them', async () => {
    const out: string[] = [];
    await upgradeReport({
      spawn: fakeSpawn().spawn,
      capture: async (_c, args) =>
        args[0] === 'status'
          ? { code: 0, stdout: ' M packages/cli/src/init.ts\n M README.md\n' }
          : { code: 0, stdout: 'abc1234 a commit\n' },
      out: (l) => out.push(l),
    });
    expect(out.join('\n')).toContain('2 tracked file(s) have local edits');
  });
});
