#!/usr/bin/env node
/**
 * The Windows setup's own program (apps/windows/buddi.iss runs it with the
 * bundle's node): the counterpart of scripts/install.sh, in TypeScript
 * because Inno Setup's Pascal is no place for a backup, a lock and a
 * rollback. Two commands:
 *
 *   windows-setup.js install --bundle <dir> --data <dir> --bin <dir> [--uninstaller <exe>]
 *                            [--no-start] [--skip-backup] [--log <file>] [--result <file>]
 *   windows-setup.js uninstall --data <dir> [--keep-data] [--log <file>] [--summary <file>] [--result <file>]
 *
 * `install` puts the unpacked bundle (scripts/release/windows-bundle.sh) where
 * the Linux install puts its own, under the data directory (windows-install.ts):
 * `node\` (the runtime, swapped only when it holds another Node),
 * `releases\buddi-<v>\` with `current` and `previous` junctions, and
 * `buddi.cmd` in the setup's bin folder. Whenever there is data already, the
 * buddi that serves it takes a backup first, then stops (Windows will not
 * replace files a running program holds), and the switch is recorded the way
 * buddi's own upgrade records it, so a failed migration says how to get back.
 * A new release that does not start puts the old one back. An npm install
 * (`npm install -g @withbuddi/buddi`) serving the same data folder is moved
 * over and then removed; one serving another folder is left alone.
 *
 * `uninstall` is `buddi uninstall --yes` run from the setup's uninstaller (with
 * the node it copied out of the data folder), its words kept for the
 * uninstaller to show.
 *
 * The setup cannot read a console it hides, so everything said goes to the
 * log, and the exit status to the result file as well (conhost, which keeps
 * the console hidden, does not pass it on).
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentLauncher, pointAt, pruneReleases, releaseDir, releaseRoot, takeReleasesLock } from './app-layout.js';
import { KEPT_FOR_REINSTALL_FILE, keptForReinstall, launchAgentLabel, lockHolder } from './environment.js';
import { answeredBySupervisor, supervisorSocket } from './supervisor.js';
import { SETUP_UNINSTALL_VAR, buildWindowsCommand, insideFolder, windowsBundledNode, windowsCommandOwnedBy, windowsInstallEnvironment, windowsInstallPath } from './windows-install.js';
import type { WindowsInstallerRecord } from './windows-install.js';

const win = path.win32;
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

export interface SetupArgs {
  command: 'install' | 'uninstall';
  bundle?: string;
  data?: string;
  bin?: string;
  uninstaller?: string;
  noStart: boolean;
  skipBackup: boolean;
  keepData: boolean;
  log?: string;
  result?: string;
  summary?: string;
}

/** The command line the setup passes. Anything else is refused. */
export function parseSetupArgs(argv: readonly string[]): SetupArgs {
  const [command, ...rest] = argv;
  if (command !== 'install' && command !== 'uninstall') throw new Error(`usage: windows-setup.js install|uninstall …, not ${JSON.stringify(command ?? '')}`);
  const out: SetupArgs = { command, noStart: false, skipBackup: false, keepData: false };
  const valued = { '--bundle': 'bundle', '--data': 'data', '--bin': 'bin', '--uninstaller': 'uninstaller', '--log': 'log', '--result': 'result', '--summary': 'summary' } as const;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (arg === '--no-start') out.noStart = true;
    else if (arg === '--skip-backup') out.skipBackup = true;
    else if (arg === '--keep-data') out.keepData = true;
    else if (arg in valued) {
      const value = rest[++i];
      if (value === undefined || value === '') throw new Error(`${arg} needs a value`);
      out[valued[arg as keyof typeof valued]] = value;
    } else throw new Error(`unknown option ${arg}`);
  }
  if (out.data === undefined) throw new Error('--data is required');
  if (command === 'install' && (out.bundle === undefined || out.bin === undefined)) throw new Error('install needs --bundle and --bin');
  return out;
}

/* ------------------------------------------------------------------ *
 * What to do, from what is there
 * ------------------------------------------------------------------ */

export interface SetupFacts {
  /** `<data>\installation.json` is there. */
  existing: boolean;
  /** The release `current` resolves to, and its version. */
  oldRoot?: string;
  oldVersion?: string;
  newVersion: string;
  /** `current` already is this bundle's release. */
  sameRelease: boolean;
  /** An npm copy on PATH, and whether it serves this data folder. */
  npm?: { version?: string; serves: boolean };
  skipBackup: boolean;
  /** The data an uninstall with "Keep my data" left (environment.ts keptForReinstall). */
  kept?: boolean;
}

export interface SetupPlan {
  kind: 'fresh' | 'reinstall' | 'upgrade' | 'move';
  /**
   * `take`: back up with the buddi there now; `kept`: data a keep-data
   * uninstall left, whose buddi is gone (its last backup is in its backups
   * folder, and the install leaves the folder as it is); `refuse`: data that
   * nothing here can back up.
   */
  backup: 'none' | 'take' | 'skipped' | 'kept' | 'refuse';
  /** Which buddi serves the data now: the release under `current`, npm's copy, or none. */
  old: 'release' | 'npm' | 'none';
  /** The version recorded as `from` in the upgrade marker. */
  from?: string;
}

export function setupPlan(f: SetupFacts): SetupPlan {
  const old = f.oldRoot !== undefined ? 'release' : f.npm?.serves === true ? 'npm' : 'none';
  const from = f.oldVersion ?? (old === 'npm' ? f.npm?.version : undefined);
  const kind = f.sameRelease ? 'reinstall' : f.oldRoot !== undefined ? 'upgrade' : f.existing ? 'move' : 'fresh';
  let backup: SetupPlan['backup'] = 'none';
  if (f.existing && !f.sameRelease) backup = f.skipBackup ? 'skipped' : old !== 'none' ? 'take' : f.kept ? 'kept' : 'refuse';
  return { kind, backup, old, ...(from === undefined ? {} : { from }) };
}

/** The newest archive in `<data>\backups` (not an envelope or a passphrase file). */
export function newestArchive(names: Array<{ name: string; mtimeMs: number }>): string | undefined {
  const archives = names.filter(entry => entry.name.startsWith('buddi-backup-') && !/\.(json|txt)$/i.test(entry.name));
  archives.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return archives[0]?.name;
}

/** Does npm's `buddi.cmd` shim run `@withbuddi/buddi` from beside it? */
export function npmShimRunsBuddi(text: string | undefined): boolean {
  return text !== undefined && /node_modules[\\/]@withbuddi[\\/]buddi[\\/]/i.test(text);
}

/** The lines of `buddi uninstall`'s output the owner must keep: where the backup is, and its passphrase. */
export function uninstallSummary(output: string): string[] {
  return output.split(/\r?\n/).map(line => line.trim())
    .filter(line => /^(The backup is |A copy is |Your backup passphrase|It is also in |buddi is removed)/.test(line));
}

/* ------------------------------------------------------------------ *
 * The effects
 * ------------------------------------------------------------------ */

export class Said {
  lines: string[] = [];
  constructor(private readonly file: string | undefined) {
    // A byte order mark, so the setup reads the log as UTF-8 (C:\Users\Zoë).
    if (file !== undefined) { try { writeFileSync(file, '\ufeff'); } catch { /* the log is a courtesy */ } }
  }
  say(line: string): void {
    this.lines.push(line);
    process.stdout.write(`${line}\n`);
    this.record(line);
  }
  /** Into the log only: what helps a report, not the owner (a stack). */
  record(line: string): void {
    if (this.file !== undefined) { try { appendFileSync(this.file, `${line}\r\n`); } catch { /* as above */ } }
  }
}

export class SetupError extends Error {}

export interface Run { code: number; output: string }

function runProgram(command: string, args: string[], env: NodeJS.ProcessEnv, opts: { verbatim?: boolean; timeoutMs?: number } = {}): Promise<Run> {
  return new Promise(resolve => {
    let output = '';
    const child = spawn(command, args, { env, cwd: os.homedir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(opts.verbatim ? { windowsVerbatimArguments: true } : {}) });
    const timer = setTimeout(() => { child.kill(); }, opts.timeoutMs ?? 10 * 60_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });
    child.once('error', error => { clearTimeout(timer); resolve({ code: 127, output: output + error.message }); });
    child.once('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, output }); });
  });
}

/** Ask this data folder's supervisor, as the launcher does (its pipe, its secret). */
function askSupervisor<T>(data: string, method: string, route: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: supervisorSocket(data), path: route, method, headers: { host: 'localhost' }, timeout: 25_000 }, res => {
      if (!answeredBySupervisor(data, res.headers)) { res.resume(); reject(new Error('not this installation\'s supervisor')); return; }
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200 && res.statusCode !== 202) {
          const refusal = (() => { try { return (JSON.parse(text) as { error?: string }).error; } catch { return undefined; } })();
          reject(new Error(refusal ?? `the supervisor answered ${res.statusCode}`));
          return;
        }
        try { resolve(JSON.parse(text) as T); } catch { reject(new Error('the supervisor answered with something that is not JSON')); }
      });
    });
    req.once('timeout', () => req.destroy(new Error('the supervisor did not answer')));
    req.once('error', reject);
    req.end();
  });
}

/** Does the pid on the first line of this file (supervisor.lock, postmaster.pid) name a live process? */
function pidAlive(file: string): boolean {
  let pid: number;
  try { pid = Number(readFileSync(file, 'utf8').split('\n')[0]!.trim()); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Stop the supervisor on its pipe (never a kill: that skips the database's shutdown), and wait for it and its Postgres. */
async function stopSupervisor(data: string): Promise<void> {
  if (lockHolder(data) === undefined) return;
  await askSupervisor(data, 'POST', '/exit');
  for (let waited = 0; lockHolder(data) !== undefined || pidAlive(path.join(data, 'postgres', 'postmaster.pid')); waited += 250) {
    if (waited >= 120_000) throw new SetupError('buddi did not stop within two minutes, so nothing was changed.');
    await sleep(250);
  }
}

/**
 * A rename, retried while Windows says the folder is busy (an antivirus
 * scanning what was just unpacked holds files for a moment), else a copy:
 * where the bundle sits on another drive, or the folder stays held.
 */
async function move(from: string, to: string, attempts = 8): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try { await rename(from, to); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EXDEV' || ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && attempt >= attempts)) break;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error;
      await sleep(250 * attempt);
    }
  }
  await rm(to, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
  await cp(from, to, { recursive: true, verbatimSymlinks: true });
  await rm(from, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
}

const real = (file: string): string | undefined => { try { return realpathSync(file); } catch { return undefined; } };
const versionOf = (root: string): string | undefined => {
  try { return (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string }).version; } catch { return undefined; }
};

/**
 * Everything `install` does to processes, as seams: the real ones below, fakes
 * in the tests (windows-setup.test.ts), so the backup, the stop, the marker,
 * the swap, the rollback and the takeover are tested on a folder, anywhere.
 */
export interface InstallDeps {
  /** The supervisor answering for this data folder: its install root, or undefined when none answers. */
  status(data: string): Promise<{ installRoot?: string } | undefined>;
  /** Stop that supervisor on its pipe and wait for it and its database. */
  stop(data: string): Promise<void>;
  /** Run a release's launcher with the bundled node and the Windows install's environment. */
  runRelease(data: string, root: string, argv: string[]): Promise<Run>;
  /** Run npm's `buddi.cmd` for this data folder. */
  runNpm(cmd: string, data: string, argv: string[]): Promise<Run>;
  /** The folders on PATH, where npm's `buddi.cmd` is looked for. */
  pathDirs(): string[];
  /** The scripts of every other buddi task on this machine (Task Scheduler), their text. */
  otherTaskScripts(data: string): Promise<string[]>;
}

const realDeps: InstallDeps = {
  status: data => askSupervisor<{ installRoot?: string }>(data, 'GET', '/status').catch(() => undefined),
  stop: stopSupervisor,
  runRelease: (data, root, argv) => runProgram(windowsBundledNode(data), [path.join(root, 'packages', 'install', 'dist', 'launcher.js'), ...argv],
    { ...process.env, ...windowsInstallEnvironment(data), PATH: windowsInstallPath(data, process.env.PATH ?? process.env.Path), Path: undefined }, { timeoutMs: 5 * 60_000 }),
  runNpm: (cmd, data, argv) => runProgram(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${cmd}" ${argv.join(' ')}"`], { ...process.env, BUDDI_DATA_DIR: data }, { verbatim: true }),
  pathDirs: () => (process.env.Path ?? process.env.PATH ?? '').split(';').filter(Boolean),
  otherTaskScripts: async data => {
    const own = launchAgentLabel(data).toLowerCase();
    const listed = await runProgram('schtasks.exe', ['/Query', '/FO', 'CSV', '/NH'], process.env);
    const names = [...new Set(listed.output.split(/\r?\n/).map(line => line.split(',')[0]?.replace(/"/g, '').trim() ?? '')
      .filter(name => /\\com\.buddi\.install\.[0-9a-f]+$/i.test(name) && !name.toLowerCase().endsWith(own)))];
    const scripts: string[] = [];
    for (const name of names) {
      const xml = await runProgram('schtasks.exe', ['/Query', '/TN', name, '/XML'], process.env);
      const script = /call &quot;(.+?)&quot;|call "(.+?)"/.exec(xml.output);
      const file = script?.[1] ?? script?.[2];
      if (file !== undefined) { try { scripts.push(readFileSync(file, 'utf8')); } catch { scripts.push(''); } }
    }
    return scripts;
  },
};

/** Does any of these task scripts run something from inside this package folder? */
export function scriptsUse(scripts: string[], pkg: string): boolean {
  const needle = pkg.toLowerCase();
  return scripts.some(text => text.toLowerCase().includes(needle));
}

export async function install(args: SetupArgs, said: Said, deps: InstallDeps = realDeps): Promise<number> {
  const say = (line: string): void => said.say(line);
  const bundle = path.resolve(args.bundle as string);
  const bin = path.resolve(args.bin as string);
  const runtime = path.join(bundle, 'runtime');
  const release = path.join(bundle, 'release');
  if (!existsSync(path.join(runtime, 'node.exe')) || !existsSync(path.join(releaseRoot(release), 'packages', 'install', 'dist', 'launcher.js'))) {
    throw new SetupError(`${bundle} is not a buddi Windows bundle. Nothing was changed.`);
  }
  const newVersion = readFileSync(path.join(bundle, 'VERSION'), 'utf8').trim();
  if (!VERSION_RE.test(newVersion)) throw new SetupError(`the bundle names no buddi version ("${newVersion}"). Nothing was changed.`);
  say(`buddi ${newVersion}, Node ${readFileSync(path.join(runtime, 'VERSION'), 'utf8').trim()}`);

  /* Where. One spelling of the data folder: the one installation.json was given, when it is the same folder. */
  let data = path.resolve(args.data as string);
  await mkdir(data, { recursive: true });
  const named = (() => { try { return (JSON.parse(readFileSync(path.join(data, 'installation.json'), 'utf8')) as { dataDir?: unknown }).dataDir; } catch { return undefined; } })();
  if (typeof named === 'string' && named !== data && real(named)?.toLowerCase() === real(data)?.toLowerCase()) data = named;
  const releases = path.join(data, 'releases');
  const nodeDir = path.join(data, 'node');
  const command = path.join(bin, 'buddi.cmd');

  /* What is there now. */
  const currentLink = path.join(releases, 'current');
  const previousLink = path.join(releases, 'previous');
  const oldRoot = existsSync(path.join(currentLink, 'packages', 'install', 'dist', 'launcher.js')) ? real(currentLink) : undefined;
  const oldVersion = oldRoot === undefined ? undefined : versionOf(oldRoot);
  const oldPrev = existsSync(previousLink) ? real(previousLink) : undefined;
  const existing = existsSync(path.join(data, 'installation.json'));
  const newDir = releaseDir(releases, newVersion);
  const newRoot = releaseRoot(newDir);
  const sameRelease = oldRoot !== undefined && real(newRoot)?.toLowerCase() === oldRoot.toLowerCase();

  /* npm's buddi on PATH (`npm install -g @withbuddi/buddi`), and whether it serves this data folder. */
  let npm: { cmd: string; prefix: string; pkg: string; version?: string; serves: boolean } | undefined;
  for (const dir of deps.pathDirs()) {
    const cmd = path.join(dir, 'buddi.cmd');
    if (insideFolder(cmd, bin) || !existsSync(cmd)) continue;
    const text = (() => { try { return readFileSync(cmd, 'utf8'); } catch { return undefined; } })();
    if (windowsCommandOwnedBy(text, data) || !npmShimRunsBuddi(text)) continue;
    const pkg = path.join(dir, 'node_modules', '@withbuddi', 'buddi');
    if (!existsSync(path.join(pkg, 'package.json'))) continue;
    let serves = false;
    if (existing && oldRoot === undefined) {
      const script = (() => { try { return readFileSync(path.join(data, 'service', 'supervise.cmd'), 'utf8'); } catch { return ''; } })();
      const status = await deps.status(data);
      serves = scriptsUse([script], pkg) || (real(pkg) !== undefined && scriptsUse([script], real(pkg) as string))
        || (status?.installRoot !== undefined && insideFolder(status.installRoot, real(pkg) ?? pkg));
    }
    npm = { cmd, prefix: dir, pkg, ...(versionOf(pkg) === undefined ? {} : { version: versionOf(pkg) as string }), serves };
    break;
  }

  const kept = existing && oldRoot === undefined && keptForReinstall(data);
  const plan = setupPlan({ existing, kept, ...(oldRoot === undefined ? {} : { oldRoot }), ...(oldVersion === undefined ? {} : { oldVersion }), newVersion, sameRelease, ...(npm === undefined ? {} : { npm: { serves: npm.serves, ...(npm.version === undefined ? {} : { version: npm.version }) } }), skipBackup: args.skipBackup });
  if (plan.kind === 'reinstall') say(`buddi ${newVersion} is installed already; refreshing the runtime, the command and the service.`);
  else if (plan.kind === 'upgrade') say(`Upgrading buddi ${oldVersion ?? ''} to ${newVersion}.`.replace('  ', ' '));
  else if (plan.kind === 'move' && plan.backup === 'kept') say(`Reinstalling buddi on the data kept in ${data}.`);
  else if (plan.kind === 'move') say(`Moving the buddi in ${data} onto this install; its data stays.`);

  /** The buddi serving this folder now, as a program: what takes the backup, and what a rollback starts again. */
  const oldBuddi = (argv: string[]): Promise<Run> => plan.old === 'release'
    ? deps.runRelease(data, oldRoot as string, argv)
    : deps.runNpm(npm!.cmd, data, argv);

  /* The backup, before anything changes. */
  let archive: string | undefined;
  if (plan.backup === 'refuse') {
    throw new SetupError(`${data} holds a buddi installation, but no buddi here can back it up first (no release under ${releases}, no npm copy serving it). Nothing was changed. To go on without a backup, run the setup with /SKIPBACKUP.`);
  }
  if (plan.backup === 'skipped') say(`No backup of ${data} before the switch (asked for).`);
  if (plan.backup === 'kept') {
    const names = (() => { try { return readdirSync(path.join(data, 'backups')).map(name => ({ name, mtimeMs: statSync(path.join(data, 'backups', name)).mtimeMs })); } catch { return []; } })();
    const last = newestArchive(names);
    say(`No new backup first: the buddi that wrote this data was removed, and only it could back up its database as it is. ${last !== undefined ? `The last backup it took is ${path.join(data, 'backups', last)}.` : 'It left no backup in its backups folder.'} The install leaves the data folder as it is; buddi ${newVersion} starts on it.`);
  }
  if (plan.backup === 'take') {
    if (await deps.status(data) === undefined) {
      say('Starting the installed buddi briefly for the backup.');
      const brief = await oldBuddi(['--no-service', '--no-open']);
      if (brief.code !== 0) { say(brief.output.trim()); throw new SetupError('the installed buddi would not start for the backup, so nothing was changed. To go on without one, run the setup with /SKIPBACKUP.'); }
    }
    say('Taking a backup first.');
    const taken = await oldBuddi(['backup', 'create']);
    if (taken.code !== 0) { say(taken.output.trim().split(/\r?\n/).slice(-5).join('\n')); throw new SetupError('the backup before the switch failed, so nothing was changed.'); }
    const names = (() => { try { return readdirSync(path.join(data, 'backups')).map(name => ({ name, mtimeMs: statSync(path.join(data, 'backups', name)).mtimeMs })); } catch { return []; } })();
    const newest = newestArchive(names);
    if (newest !== undefined) { archive = path.join(data, 'backups', newest); say(`Backup: ${archive}`); }
  }

  /* Windows will not replace a runtime or a release that a running buddi holds: the old one stops first. */
  const runtimeChanges = !existsSync(path.join(nodeDir, 'node.exe'))
    || (() => { try { return readFileSync(path.join(nodeDir, 'VERSION'), 'utf8').trim() !== readFileSync(path.join(runtime, 'VERSION'), 'utf8').trim(); } catch { return true; } })();
  if (!sameRelease || runtimeChanges) {
    try { await deps.stop(data); }
    catch (error) { throw new SetupError(`buddi could not be stopped for the switch (${(error as Error).message.replace(/\.$/, '')}). Nothing was changed; run the setup again when it has finished what it is doing.`); }
  }

  /* Put it in place, under the releases lock buddi's own upgrade takes too. */
  const unlock = await takeReleasesLock(releases);
  const nodeOld = `${nodeDir}.old`;
  let started = false;
  try {
    // What an earlier setup could not clean up (a scanner held a file): any unpacked bundle but this one. Under the lock, so never a running setup's.
    for (const name of readdirSync(data)) {
      if (name.startsWith('.install-') && !insideFolder(bundle, path.join(data, name))) await rm(path.join(data, name), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
    }
    /*
     * Every change from here is undone, last first, if anything after it
     * fails: the files, the links, the command, the state, and then the buddi
     * that served this folder before is started again.
     */
    const undo: Array<{ what: string; run: () => Promise<void> }> = [];
    try {
      if (!sameRelease) {
        const there = real(newDir);
        const used = there !== undefined && [oldRoot, oldPrev].some(root => root !== undefined && insideFolder(root, there));
        if (!used) {
          await rm(newDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
          await move(release, newDir);
          undo.push({ what: `the new release ${newDir}`, run: () => rm(newDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }) });
        }
      }
      if (runtimeChanges) {
        /*
         * Copied, never renamed: this program runs on the bundle's node.exe,
         * and Windows will not rename a folder whose program is running. The
         * copy goes beside the old runtime first, so the swap is two renames.
         */
        const nodeNew = `${nodeDir}.new`;
        await rm(nodeOld, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
        await rm(nodeNew, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
        await cp(runtime, nodeNew, { recursive: true });
        const hadRuntime = existsSync(nodeDir);
        if (hadRuntime) await move(nodeDir, nodeOld);
        undo.push({ what: `the runtime ${nodeDir}`, run: async () => {
          await rm(nodeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
          if (hadRuntime) await move(nodeOld, nodeDir);
        } });
        await move(nodeNew, nodeDir);
      }

      /* The switch, recorded as buddi's own upgrade records it: the new release's first start finishes it. */
      if (!sameRelease && existing && plan.from !== undefined) {
        const file = path.join(data, 'installation.json');
        const before = await readFile(file, 'utf8');
        const state = JSON.parse(before) as Record<string, unknown>;
        state.phase = 'upgrading';
        state.upgrade = { from: plan.from, to: newVersion, startedAt: new Date().toISOString(), ...(archive === undefined ? {} : { backup: path.basename(archive) }) };
        undo.push({ what: `the state in ${file}`, run: async () => { await writeFile(`${file}.tmp`, before, { mode: 0o600 }); await rename(`${file}.tmp`, file); } });
        await writeFile(`${file}.tmp`, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      }
      if (!sameRelease) {
        undo.push({ what: `the links in ${releases}`, run: async () => {
          if (oldRoot !== undefined) await pointAt(currentLink, oldRoot);
          else await unlink(currentLink).catch(() => {});
          if (oldPrev !== undefined) await pointAt(previousLink, oldPrev);
          else await unlink(previousLink).catch(() => {});
        } });
        if (oldRoot !== undefined) await pointAt(previousLink, oldRoot);
        await pointAt(currentLink, newRoot);
      }

      /* The command: the bundled node, `current`, this data folder. Never rewritten by an upgrade. */
      const commandBefore = (() => { try { return readFileSync(command, 'utf8'); } catch { return undefined; } })();
      undo.push({ what: `the command ${command}`, run: async () => {
        if (commandBefore === undefined) await rm(command, { force: true });
        else await writeFile(command, commandBefore);
      } });
      await mkdir(bin, { recursive: true });
      await writeFile(`${command}.tmp`, buildWindowsCommand(data));
      await rename(`${command}.tmp`, command);

      /* Start it: the new release writes and starts the Task Scheduler task (and stops anything still running). */
      if (args.noStart) {
        say(`Installed. Start it with: ${command}`);
      } else {
        say('Starting buddi.');
        const start = await deps.runRelease(data, currentLinkRoot(releases), ['--no-open']);
        for (const line of start.output.split(/\r?\n/)) if (line.trim() !== '' && !/^(Dashboard: |The link is good)/.test(line)) say(`  ${line}`);
        if (start.code !== 0) throw new SetupError(`buddi ${newVersion} did not start (it exited with ${start.code})`);
        started = true;
      }
    } catch (error) {
      const why = error instanceof SetupError ? error.message : `the install stopped: ${(error as Error).message.split('\n')[0]}`;
      say(`${why}. Putting back what was there.`);
      if (!(error instanceof SetupError)) said.record(String((error as Error).stack ?? error));
      // Whatever runs now is the failed one (or nothing): it stops before its files go.
      await deps.stop(data).catch(err => say(`(it would not stop: ${(err as Error).message})`));
      for (const step of undo.reverse()) await step.run().catch(err => say(`(could not put back ${step.what}: ${(err as Error).message})`));
      if (plan.old !== 'none' && !sameRelease) {
        // npm's buddi or the old release writes its own service again (its task script) and starts it.
        const back = await oldBuddi(['--no-open']);
        say(back.code === 0 ? `Back on ${plan.from ?? 'the version before'}, running.` : `${plan.from ?? 'The version before'} did not come back either. See ${path.join(data, 'logs', 'supervisor.log')}.`);
        if (archive !== undefined) say(`If ${newVersion} changed the database before it failed, ${plan.from ?? 'the old version'} may refuse it; restore the backup taken first: buddi backup restore ${archive}`);
      } else if (sameRelease && oldRoot !== undefined) {
        const back = await deps.runRelease(data, oldRoot, ['--no-open']);
        say(back.code === 0 ? `Back on ${newVersion} as it was, running.` : `buddi did not come back. See ${path.join(data, 'logs', 'supervisor.log')}.`);
      }
      throw new SetupError(`${why}. What was there before is back; see ${path.join(data, 'logs', 'supervisor.log')}.`);
    }
  } finally {
    await unlock();
  }

  /* Past this point the install stands: a failure is said, never undone. */
  const record: WindowsInstallerRecord = { version: newVersion, arch: 'windows-x64', command, data, ...(args.uninstaller === undefined ? {} : { uninstaller: path.resolve(args.uninstaller) }), installedAt: new Date().toISOString() };
  await writeFile(path.join(data, 'installer.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 }).catch(err => say(`(could not write installer.json: ${(err as Error).message})`));
  // The data is an installation's again.
  await rm(path.join(data, KEPT_FOR_REINSTALL_FILE), { force: true }).catch(() => {});
  await pruneReleases(releases).catch(err => say(`(an old release could not be removed yet: ${(err as Error).message}; it goes at the next install)`));
  await rm(nodeOld, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => { say(`(${nodeOld} is still in use; it goes at the next install.)`); });

  /*
   * npm's copy would answer `buddi` before this one on PATH. Removed only once
   * this install serves the same data folder, runs, and no other buddi task on
   * this machine runs that package; otherwise, the line that removes it.
   */
  if (npm !== undefined) {
    const others = started && npm.serves ? await deps.otherTaskScripts(data).catch(() => undefined) : undefined;
    const elsewhere = others === undefined || scriptsUse(others, npm.pkg) || (real(npm.pkg) !== undefined && scriptsUse(others, real(npm.pkg) as string));
    if (started && npm.serves && !elsewhere) {
      const shims = ['buddi.cmd', 'buddi.ps1', 'buddi'].map(name => path.join(npm!.prefix, name)).filter(file => npmShimRunsBuddi((() => { try { return readFileSync(file, 'utf8'); } catch { return undefined; } })()));
      try {
        await rm(npm.pkg, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
        for (const shim of shims) await rm(shim, { force: true });
        say(`Removed the npm copy of buddi (${npm.pkg}): this install serves its data now, and nothing else ran it.`);
      } catch (error) {
        say(`The npm copy of buddi at ${npm.pkg} could not be removed (${(error as Error).message}); remove it with: npm uninstall -g @withbuddi/buddi`);
      }
    } else {
      say(`An npm copy of buddi is at ${npm.cmd}. It was left alone (${started && npm.serves ? 'another buddi installation on this computer runs it' : 'it may serve another installation'}); once you no longer need it: npm uninstall -g @withbuddi/buddi`);
    }
  }
  say(`buddi ${newVersion} is installed in ${data}. ${command} runs it; buddi doctor checks it; Settings → Apps removes it (keeping one last backup).`);
  return 0;
}

/** The release `current` names, as a path through the link (the launcher resolves it). */
function currentLinkRoot(releases: string): string {
  return path.join(releases, 'current');
}

/** What the setup alone puts in the data folder, before buddi first starts. */
export const NEVER_STARTED_PARTS = ['node', 'releases', 'installer.json', 'cache', 'logs'];

async function uninstall(args: SetupArgs, said: Said): Promise<number> {
  const data = path.resolve(args.data as string);
  const launcher = currentLauncher(path.join(data, 'releases'));
  if (!existsSync(launcher)) { said.say(`No buddi release in ${data}; nothing for buddi uninstall to do.`); return 0; }
  /*
   * Installed (/NOSTART) and never started: no installation, nothing to back
   * up, and `buddi uninstall` rightly refuses a folder that is not one. Only
   * the program the setup put there goes, and the folder if that leaves it empty.
   */
  if (!existsSync(path.join(data, 'installation.json')) && !existsSync(path.join(data, 'postgres'))) {
    for (const part of NEVER_STARTED_PARTS) await rm(path.join(data, part), { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    if (readdirSync(data).length === 0) await rm(data, { recursive: true, force: true });
    said.say(`buddi was never started here; removed the program from ${data}.`);
    return 0;
  }
  const env = { ...process.env, ...windowsInstallEnvironment(data), PATH: windowsInstallPath(data, process.env.PATH ?? process.env.Path), Path: undefined, [SETUP_UNINSTALL_VAR]: '1' };
  const run = await runProgram(process.execPath, [launcher, 'uninstall', '--yes', ...(args.keepData ? ['--keep-data'] : [])], env, { timeoutMs: 30 * 60_000 });
  // The six words go to the summary the uninstaller shows, never into a log (Inno Setup's /LOG copies this one).
  for (const line of run.output.split(/\r?\n/)) if (line.trim() !== '') said.say(/^Your backup passphrase/.test(line.trim()) ? 'Your backup passphrase: shown on screen and kept beside the backup, not in this log.' : line);
  if (args.summary !== undefined) {
    const lines = uninstallSummary(run.output);
    // A blank line between them: the uninstaller shows them as they are.
    try { writeFileSync(args.summary, `\ufeff${lines.join('\r\n\r\n')}\r\n`); } catch { /* the log has it all */ }
  }
  return run.code;
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: SetupArgs;
  try { args = parseSetupArgs(argv); }
  catch (error) { console.error(`windows-setup: ${(error as Error).message}`); return 2; }
  const said = new Said(args.log);
  let code: number;
  try {
    code = args.command === 'install' ? await install(args, said) : await uninstall(args, said);
  } catch (error) {
    // The owner reads one sentence with a next step; the stack goes to the log only.
    const plain = error instanceof SetupError ? error.message
      : `something unexpected went wrong (${(error as Error).message?.split('\n')[0] ?? String(error)}). Nothing you need is lost: run the setup again, and if it fails the same way, send the log below.`;
    said.say(`buddi setup: ${plain}`);
    if (!(error instanceof SetupError)) said.record(String((error as Error).stack ?? error));
    if (args.summary !== undefined) { try { writeFileSync(args.summary, `\ufeff${plain.charAt(0).toUpperCase()}${plain.slice(1)}\r\n`); } catch { /* the log says it */ } }
    code = 1;
  }
  if (args.result !== undefined) { try { writeFileSync(args.result, `${code}\r\n`); } catch { /* the log says it */ } }
  return code;
}

/** Is this module the program node was asked to run? Named through `current` (a junction) it is still this file; Windows paths ignore case. */
export function runAsProgram(argv1: string | undefined, self: string, resolve: (file: string) => string = file => { try { return realpathSync(file); } catch { return path.resolve(file); } }): boolean {
  return argv1 !== undefined && resolve(argv1).toLowerCase() === resolve(self).toLowerCase();
}

if (runAsProgram(process.argv[1], fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error); process.exitCode = 1; });
}
