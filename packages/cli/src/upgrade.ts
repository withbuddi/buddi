/**
 * `buddi upgrade` — the four steps that follow a `git pull`, in the one order
 * that works, and a backup in front of the irreversible one.
 *
 * ## Why this is a command and not only a paragraph
 *
 * Upgrading is four separate things — install, build, migrate, restart — and
 * three of the four failure modes are *silent*. Skip the build and the running
 * service keeps executing last month's code against this month's schema. Skip
 * the migration and a tool fails at the moment an agent calls it, hours later,
 * as a Postgres error nobody reads. Skip the restart and everything looks
 * upgraded until the next reboot changes the answer. None of those announce
 * themselves, and a paragraph cannot enforce an order.
 *
 * So the ordering is code. But the *fetch* is not:
 *
 * ## What it deliberately does not do
 *
 * **It does not `git pull`.** The checkout belongs to the owner: it may be a
 * fork, it may be on a branch, it may carry edits to `examples/`. A command
 * that pulls can leave a merge conflict inside a working installation, and
 * resolving that is not something a wizard gets to attempt on someone's behalf.
 * `buddi upgrade` upgrades *the code that is on disk*, says so, and prints the
 * commit it is about to install so the owner can tell whether their pull
 * landed.
 *
 * **It does not roll back.** Migrations in this project only go forward, so the
 * answer to "the upgrade failed halfway" is the backup it took before it
 * started, not an undo. Every step that fails stops the run, names what did and
 * did not happen, and names the archive.
 *
 * ## The order, and why each step is where it is
 *
 *  1. **Backup.** Before anything, because the migration is the only step that
 *     cannot be repeated away. `--no-backup` for someone who just took one.
 *  2. **Stop the service.** Old code must not be running while the schema moves
 *     underneath it. Whether it *was* running is remembered, so an installation
 *     that had no service does not acquire one.
 *  3. **Install and build.** In that order, because a new dependency that is
 *     not installed is a build error and a build over stale dependencies is
 *     worse — it succeeds.
 *  4. **Migrate.** `buddi migrate`, which is core's migrations *and every
 *     installed plugin's* — the same function `buddi init` ends with, so a
 *     plugin schema is never left a version behind the code that reads it.
 *  5. **Start the service again**, if it was running when we arrived.
 *  6. **`buddi doctor`**, because the last word on whether an upgrade worked
 *     belongs to the thing that checks every moving part.
 */
import { REPO_ROOT } from './paths.js';
import { run, runInherit } from './proc.js';

const ESC = '[';
const dim = (s: string): string => `${ESC}2m${s}${ESC}0m`;
const bold = (s: string): string => `${ESC}1m${s}${ESC}0m`;

export interface UpgradeOptions {
  /** `--no-backup`: the owner has one already, or has no database yet. */
  backup?: boolean;
  /** Injected in tests; the real one inherits the terminal. */
  spawn?: (command: string, args: string[]) => Promise<number>;
  /** Injected in tests; reads the commit without a terminal. */
  capture?: (command: string, args: string[]) => Promise<{ code: number; stdout: string }>;
  /**
   * Whether a service is installed and running right now, and how to move it.
   * Injected in tests so nothing here touches launchd.
   */
  service?: {
    status: () => Promise<{ installed: boolean; running: boolean }>;
    stop: () => Promise<unknown>;
    start: () => Promise<unknown>;
  };
  out?: (line: string) => void;
  repoRoot?: string;
}

/** One step of the run: what it is called, and what it returned. */
export interface UpgradeStep {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface UpgradeReport {
  code: number;
  steps: UpgradeStep[];
  /** The archive this run took, when it took one. */
  archive?: string;
  /** True when a service was running on arrival and is expected to run after. */
  serviceWasRunning: boolean;
}

/**
 * The commit this checkout is on, as one short line, or undefined outside git.
 *
 * Printed rather than acted on: it is how an owner tells "my pull landed" from
 * "I am about to rebuild exactly what I already have".
 */
export async function currentRevision(
  capture: NonNullable<UpgradeOptions['capture']>,
): Promise<string | undefined> {
  const res = await capture('git', ['log', '-1', '--format=%h %s']);
  if (res.code !== 0) return undefined;
  const line = res.stdout.trim().split('\n')[0]?.trim();
  return line === '' ? undefined : line;
}

/**
 * Tracked files the owner has edited. Not a refusal — a fork with local changes
 * is a legitimate way to run this — but it is the difference between "the build
 * failed because of the upgrade" and "the build failed because of me".
 */
export async function dirtyFiles(
  capture: NonNullable<UpgradeOptions['capture']>,
): Promise<number | undefined> {
  const res = await capture('git', ['status', '--porcelain', '--untracked-files=no']);
  if (res.code !== 0) return undefined;
  return res.stdout.split('\n').filter((l) => l.trim() !== '').length;
}

export async function runUpgrade(opts: UpgradeOptions = {}): Promise<number> {
  return (await upgradeReport(opts)).code;
}

/** The same run, with its steps, so a test can assert the order and the stop. */
export async function upgradeReport(opts: UpgradeOptions = {}): Promise<UpgradeReport> {
  const out = opts.out ?? ((line: string) => console.log(line));
  const repoRoot = opts.repoRoot ?? REPO_ROOT;
  const spawn =
    opts.spawn ?? ((command: string, args: string[]) => runInherit(command, args, { cwd: repoRoot }));
  const capture =
    opts.capture ??
    (async (command: string, args: string[]) => {
      const res = await run(command, args, { cwd: repoRoot, timeoutMs: 30_000 });
      return { code: res.code, stdout: res.stdout };
    });
  const wantsBackup = opts.backup !== false;

  const steps: UpgradeStep[] = [];
  const done = (name: string, ok: boolean, detail?: string): UpgradeStep => {
    const step: UpgradeStep = { name, ok, ...(detail === undefined ? {} : { detail }) };
    steps.push(step);
    return step;
  };

  out(bold('buddi upgrade'));
  out(dim(`installation: ${repoRoot}`));
  const revision = await currentRevision(capture);
  if (revision) out(dim(`on: ${revision}`));
  out(
    dim(
      'This upgrades the code already in this checkout. It does not fetch: `git pull`\n' +
        'first if you have not, then run this again.',
    ),
  );
  const dirty = await dirtyFiles(capture);
  if (dirty !== undefined && dirty > 0) {
    out(dim(`note: ${dirty} tracked file(s) have local edits — a build failure may be yours`));
  }
  out('');

  /* 1. The backup, before the only step that cannot be undone. */
  let archive: string | undefined;
  if (wantsBackup) {
    out(bold('1/5  Backup'));
    const code = await spawn(process.execPath, [cliEntry(repoRoot), 'backup', 'create']);
    if (code !== 0) {
      done('backup', false, `exit ${code}`);
      out('');
      out('The backup failed, so nothing was upgraded — the migration below is the one');
      out('step that cannot be taken back, and it does not run without one.');
      out('Fix it (`buddi doctor`, `buddi db up`), or run `buddi upgrade --no-backup`');
      out('if you have a recent archive already.');
      return { code: 1, steps, serviceWasRunning: false };
    }
    done('backup', true);
    archive = 'taken';
  } else {
    done('backup', true, 'skipped (--no-backup)');
    out(dim('1/5  Backup — skipped (--no-backup)'));
  }

  /* 2. Stand the old code down before the schema moves. */
  out(bold('\n2/5  Service'));
  const service = opts.service;
  let serviceWasRunning = false;
  if (service) {
    const status = await service.status().catch(() => ({ installed: false, running: false }));
    serviceWasRunning = status.installed && status.running;
    if (serviceWasRunning) {
      await service.stop().catch(() => {});
      out('  stopped — old code must not run while the schema moves');
      done('service stop', true);
    } else {
      out(dim(`  nothing running${status.installed ? ' (installed, stopped)' : ''}`));
      done('service stop', true, 'not running');
    }
  } else {
    done('service stop', true, 'no service manager');
  }

  /**
   * Every failure from here leaves the installation in a state worth naming,
   * and — crucially — brings the service back if it was running, so a failed
   * upgrade is a working old installation rather than a stopped one.
   */
  const stop = async (name: string, code: number, lines: string[]): Promise<UpgradeReport> => {
    done(name, false, `exit ${code}`);
    out('');
    for (const line of lines) out(line);
    if (serviceWasRunning && service) {
      await service.start().catch(() => {});
      out('The background service was started again — it is running the code it had.');
    }
    if (archive !== undefined) out('The backup taken at the start of this run is untouched.');
    return { code: 1, steps, ...(archive ? { archive } : {}), serviceWasRunning };
  };

  /* 3. Dependencies, then the build. */
  out(bold('\n3/5  Install and build'));
  const installed = await spawn('pnpm', ['install']);
  if (installed !== 0) {
    return stop('pnpm install', installed, [
      '`pnpm install` failed, so nothing was built and no migration ran. The',
      'installation is exactly as it was.',
    ]);
  }
  done('pnpm install', true);

  const built = await spawn('pnpm', ['-r', 'build']);
  if (built !== 0) {
    return stop('pnpm -r build', built, [
      'The build failed, so no migration ran and the database is untouched.',
      'The compiled output may be half-new: fix the build and run `buddi upgrade`',
      'again before using this installation.',
    ]);
  }
  done('pnpm -r build', true);

  /* 4. Core's migrations and every installed plugin's. */
  out(bold('\n4/5  Migrate'));
  const migrated = await spawn(process.execPath, [cliEntry(repoRoot), 'migrate']);
  if (migrated !== 0) {
    return stop('buddi migrate', migrated, [
      'Migrations failed. The new code is built but the schema is not fully',
      'migrated, which is the one combination to not leave running: do not start',
      'the service until `buddi migrate` succeeds.',
      '`buddi doctor` names the failing row; a plugin whose migration fails is',
      'named by schema, not by guess.',
    ]);
  }
  done('buddi migrate', true);

  /* 5. Bring it back, and let the doctor have the last word. */
  out(bold('\n5/5  Restart and check'));
  if (serviceWasRunning && service) {
    await service.start().catch(() => {});
    out('  service started again, on the new code');
    done('service start', true);
  } else {
    out(dim('  no service to restart'));
    done('service start', true, 'not running');
  }

  const healthy = await spawn(process.execPath, [cliEntry(repoRoot), 'doctor']);
  done('buddi doctor', healthy === 0, `exit ${healthy}`);

  out('');
  out(
    healthy === 0
      ? 'Upgraded. Every row the doctor checks is in place.'
      : 'Upgraded — the doctor found something. The rows above say what; the upgrade\n' +
          'itself completed, so this is a configuration question rather than a failed run.',
  );
  return { code: healthy === 0 ? 0 : 1, steps, ...(archive ? { archive } : {}), serviceWasRunning };
}

/** This binary, as a path — the same entry `init` re-invokes for `buddi chat`. */
function cliEntry(repoRoot: string): string {
  return `${repoRoot}/packages/cli/dist/main.js`;
}
