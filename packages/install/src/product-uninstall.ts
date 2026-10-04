/**
 * Uninstall from the product: Settings → System's "Remove buddi from this
 * Mac" and buddi.app's buddi → Uninstall buddi…, as the supervisor serves it.
 *
 * Three verbs on the control socket:
 *
 *  - `GET /uninstall`: what goes, named for the owner (the data directory,
 *    the keychain namespace, the background service, buddi.app).
 *  - `POST /uninstall/backup`: the last backup, followed to the end, moved out
 *    to `~/buddi-backups` with its envelope, and `<archive>.passphrase.txt`
 *    (0600) written beside it. The job's report carries the six words, so the
 *    page can show them, with Copy, before anything is deleted.
 *  - `POST /uninstall`: the removal itself, once the owner ticked "I wrote it
 *    down". It is `buddi uninstall --yes --no-backup --i-have-the-passphrase`
 *    (the backup and the words are already taken care of) run by someone who
 *    outlives this supervisor:
 *      - buddi.app: the supervisor writes `<data>/uninstall.json` and exits
 *        with `APP_UNINSTALL_EXIT`; the app runs the launcher's uninstall,
 *        moves itself to the Trash and quits.
 *      - npm: a detached launcher process (under `systemd-run --user` when
 *        systemd runs this supervisor, so `disable --now` cannot take it with
 *        the unit's cgroup), logging to `~/buddi-backups/uninstall-<stamp>.log`.
 *
 * Every effect is injected; the supervisor wires the real ones.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { passphraseFileFor, passphraseFileText } from '@buddi/core/uninstall';
import { keptBackupsDir } from './uninstall.js';
import { UNINSTALL_REQUEST_FILE } from './environment.js';

/** buddi.app reads this exit status as "run the uninstall, trash yourself, quit". */
export const APP_UNINSTALL_EXIT = 76;

/** The file that tells buddi.app what the owner chose, beside `installation.json`. */
export const UNINSTALL_REQUEST = UNINSTALL_REQUEST_FILE;

export interface UninstallPlanView {
  data: string;
  keychain?: string;
  service?: string;
  app?: string;
  backups: string;
  /** buddi.app is the one that finishes it (and moves itself to the Trash). */
  appFinishes: boolean;
}

export interface UninstallJob {
  id: string;
  kind: 'uninstall-backup';
  phase: string;
  phases: string[];
  detail?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  report?: { archive: string; passphraseFile?: string; passphrase?: string };
}

export interface BackupLike {
  create(encrypt: boolean | undefined): { id: string } | { status: number; error: string };
  job(id: string): { phase: string; detail?: string; error?: string; finishedAt?: string; report?: unknown } | undefined;
  passphrase(): Promise<string>;
  dir: string;
}

export interface ProductUninstallDeps {
  data: string;
  home: string;
  plan: () => UninstallPlanView;
  backup: BackupLike;
  exists: (file: string) => boolean;
  move: (from: string, to: string) => Promise<void>;
  writePrivate: (file: string, text: string) => Promise<void>;
  /** buddi.app: write the request and leave with `APP_UNINSTALL_EXIT`. */
  appFinishes: boolean;
  /** Write `<data>/uninstall.json`. */
  writeRequest: (request: { keepData: boolean; at: string }) => Promise<void>;
  /** Leave so the app can finish (the supervisor's orderly shutdown, then exit 76). */
  exitForApp: () => void;
  /** Start the detached `buddi uninstall`, which outlives this process. */
  spawnUninstall: (args: string[], log: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface ProductUninstall {
  plan(): UninstallPlanView;
  keepLast(): UninstallJob | { status: number; error: string };
  job(id: string): UninstallJob | undefined;
  start(input: { keepData: boolean }): { status: number; error?: string };
  busy(): boolean;
}

/** How long a finished job keeps the six words for the page to show: as long as the plan's token. */
export const PASSPHRASE_HELD_MS = 30 * 60_000;

function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
}

export function createProductUninstall(deps: ProductUninstallDeps): ProductUninstall {
  const jobs = new Map<string, UninstallJob>();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = deps.now ?? (() => new Date());
  let running: UninstallJob | undefined;
  let removing = false;

  const phase = (job: UninstallJob, name: string, detail?: string): void => {
    job.phase = name;
    if (job.phases[job.phases.length - 1] !== name) job.phases.push(name);
    if (detail === undefined) delete job.detail; else job.detail = detail;
  };

  const run = async (job: UninstallJob): Promise<void> => {
    const started = deps.backup.create(true);
    if ('status' in started) throw new Error(started.error);
    for (;;) {
      const state = deps.backup.job(started.id);
      if (state === undefined) throw new Error('the backup job went missing');
      phase(job, 'backup', state.detail ?? state.phase);
      if (state.finishedAt !== undefined) {
        const name = (state.report as { archive?: unknown } | undefined)?.archive;
        if (state.phase !== 'done' || typeof name !== 'string') throw new Error(`the last backup did not finish: ${state.error ?? 'no reason given'}`);
        const archive = path.join(deps.backup.dir, name);
        const kept = path.join(keptBackupsDir(deps.home), name);
        phase(job, 'keeping', `moving it to ${keptBackupsDir(deps.home)}`);
        await deps.move(archive, kept);
        const envelope = archive.replace(/\.age$/, '.json');
        if (envelope !== archive && deps.exists(envelope)) await deps.move(envelope, kept.replace(/\.age$/, '.json'));
        const report: NonNullable<UninstallJob['report']> = { archive: kept };
        if (kept.endsWith('.age')) {
          const phrase = await deps.backup.passphrase();
          const file = passphraseFileFor(kept);
          await deps.writePrivate(file, passphraseFileText(phrase, name));
          report.passphraseFile = file;
          report.passphrase = phrase;
        }
        job.report = report;
        return;
      }
      await sleep(500);
    }
  };

  /*
   * The words live in a job's report only while the page needs them: until
   * the removal starts, a new plan is asked for (the dialog opened again, or
   * closed and reopened), or PASSPHRASE_HELD_MS after the job finished. They
   * are in <archive>.passphrase.txt beside the archive after that.
   */
  const forgetWords = (job: UninstallJob): void => {
    if (job.report?.passphrase !== undefined) delete job.report.passphrase;
  };
  const forgetAllWords = (): void => { for (const job of jobs.values()) forgetWords(job); };
  const expire = (job: UninstallJob): UninstallJob => {
    if (job.finishedAt !== undefined && now().getTime() - Date.parse(job.finishedAt) >= PASSPHRASE_HELD_MS) forgetWords(job);
    return job;
  };

  return {
    plan() {
      forgetAllWords();
      return deps.plan();
    },
    busy: () => removing || (running !== undefined && running.finishedAt === undefined),
    job: id => {
      const job = jobs.get(id);
      return job === undefined ? undefined : expire(job);
    },
    keepLast() {
      if (removing) return { status: 409, error: 'buddi is being removed.' };
      if (running && running.finishedAt === undefined) return running;
      const job: UninstallJob = { id: randomUUID(), kind: 'uninstall-backup', phase: 'starting', phases: ['starting'], startedAt: now().toISOString() };
      jobs.set(job.id, job);
      running = job;
      void run(job).then(
        () => {
          phase(job, 'done');
          job.finishedAt = now().toISOString();
          setTimeout(() => forgetWords(job), PASSPHRASE_HELD_MS).unref?.();
        },
        (error: unknown) => { job.error = error instanceof Error ? error.message : String(error); phase(job, 'failed'); job.finishedAt = now().toISOString(); },
      );
      return job;
    },
    start({ keepData }) {
      if (removing) return { status: 409, error: 'buddi is already being removed.' };
      const kept = running?.phase === 'done' ? running.report : undefined;
      if (kept === undefined) return { status: 409, error: 'Take the last backup first: the passphrase has to be with you before anything is deleted.' };
      removing = true;
      forgetAllWords();
      const args = ['uninstall', '--yes', '--no-backup', '--i-have-the-passphrase', ...(keepData ? ['--keep-data'] : [])];
      if (deps.appFinishes) {
        void deps.writeRequest({ keepData, at: now().toISOString() }).then(() => deps.exitForApp(), () => { removing = false; });
      } else {
        deps.spawnUninstall(args, path.join(keptBackupsDir(deps.home), `uninstall-${stamp(now())}.log`));
      }
      return { status: 202 };
    },
  };
}
