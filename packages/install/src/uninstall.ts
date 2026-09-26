/**
 * `buddi uninstall`, in a packaged installation: what it removes, in order.
 *
 * The background service first, because it is what keeps the bundled
 * Postgres running: the gateway is stopped through the supervisor, then the
 * unit is unloaded, and the supervisor stops the cluster on its way out. Only
 * once nothing holds the data directory is it deleted. The secrets are the
 * keychain entries under this installation's own service name (the file
 * vault and its key on Linux, which live in the data directory), then the
 * dashboard app, the extension pairing and the Telegram menu.
 *
 * Nothing outside those paths is touched, and a data directory that is not an
 * installation is refused rather than deleted: `BUDDI_DATA_DIR` pointed at the
 * wrong folder must not become `rm -rf` of it.
 *
 * Every effect is injected, so the tests run the whole flow against a fake
 * machine. The launcher wires the real one. No `@buddi/*` value import but the
 * leaf `@buddi/core/uninstall` (see the note at the top of environment.ts).
 */
import path from 'node:path';
import { runUninstallPlan } from '@buddi/core/uninstall';
import type { RemovalStep, UninstallIo, UninstallPlan } from '@buddi/core/uninstall';
import { launchAgentLabel, launchAgentPlist, systemdUnitPath } from './environment.js';

export interface UninstallOptions {
  yes: boolean;
  keepData: boolean;
  backup: boolean;
}

/** The flags `buddi uninstall` takes. Anything else is a usage error. */
export function parseUninstallArgs(args: readonly string[]): UninstallOptions {
  const options: UninstallOptions = { yes: false, keepData: false, backup: true };
  for (const arg of args) {
    if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--keep-data') options.keepData = true;
    else if (arg === '--no-backup') options.backup = false;
    else throw new Error(`unknown option for buddi uninstall: ${arg} (expected --yes, --keep-data or --no-backup)`);
  }
  return options;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface PackagedUninstallDeps {
  data: string;
  home: string;
  platform: NodeJS.Platform | string;
  env: NodeJS.ProcessEnv;
  /** For launchd's `gui/<uid>` domain. */
  uid: number;
  exists: (file: string) => boolean;
  /** Recursive and forceful, like `rm -rf`. Only ever called with a listed path. */
  remove: (file: string) => Promise<void>;
  move: (from: string, to: string) => Promise<void>;
  exec: (command: string, args: string[]) => Promise<ExecResult>;
  supervisor: {
    /** Does this installation's supervisor answer on its socket? */
    answers: () => Promise<boolean>;
    stopGateway: () => Promise<void>;
    /** The supervisor's backup, followed to the end: the archive's full path. */
    backup: () => Promise<string>;
    passphrase: () => Promise<string | undefined>;
  };
  /** The pid in `supervisor.lock` while that process is alive. */
  supervisorPid: () => number | undefined;
  signal: (pid: number, signal: NodeJS.Signals) => void;
  /** The macOS keychain vault. Absent where the vault is the file (Linux). */
  keychain?: {
    service: string;
    names: () => Promise<string[]>;
    purge: (names: string[]) => Promise<void>;
  };
  /**
   * Present when a bot token is at hand. `collect` runs while the database is
   * still up (it reads the paired chats) and returns what clears the menu.
   */
  telegram?: { collect: () => Promise<() => Promise<void>> };
  /** The dashboard app, when it exists and this installation wrote it. */
  app?: string;
  sleep: (ms: number) => Promise<void>;
  io: UninstallIo;
}

/** What the data directory holds, named for the owner: only what is there. */
const CONTENTS: Array<[string[], string]> = [
  [['postgres'], 'the database'],
  [['agents', 'skills'], 'agents and skills'],
  [['artifacts'], 'the files library'],
  [['logs'], 'logs'],
  [['backups'], 'backups'],
  [['browser/engines'], 'the fetched Chromium'],
];

/** Where the last backup goes when the data directory is removed: out of it. */
export function keptBackupsDir(home: string): string {
  return path.join(home, 'buddi-backups');
}

/** A path that is never a data directory, whatever `BUDDI_DATA_DIR` says. */
function tooBroad(data: string, home: string): boolean {
  const resolved = path.resolve(data);
  return !path.isAbsolute(data) || resolved === path.parse(resolved).root || resolved === path.resolve(home) || path.resolve(home).startsWith(`${resolved}${path.sep}`);
}

export const PACKAGE_LINE = 'Now remove the package: npm uninstall -g @withbuddi/buddi';

export async function uninstallPackaged(options: UninstallOptions, deps: PackagedUninstallDeps): Promise<number> {
  const { data, home, io } = deps;
  const join = (...parts: string[]): string => path.join(data, ...parts);
  const hasData = deps.exists(data);
  const isInstallation = hasData && (deps.exists(join('installation.json')) || deps.exists(join('postgres')));
  if (!options.keepData && hasData && (!isInstallation || tooBroad(data, home))) {
    io.error(`${data} is not a buddi installation (it has no installation.json and no postgres folder), so nothing was removed. Check BUDDI_DATA_DIR.`);
    return 1;
  }

  const machine = deps.platform === 'darwin' ? 'this Mac' : 'this machine';
  const steps: RemovalStep[] = [];
  let stopped = true;

  /* The service, and with it the supervisor and the cluster it runs. */
  const label = launchAgentLabel(data);
  const unit = deps.platform === 'darwin' ? launchAgentPlist(data, home)
    : deps.platform === 'linux' ? systemdUnitPath(data, deps.env, home) : undefined;
  const hasUnit = unit !== undefined && deps.exists(unit);
  const pid = deps.supervisorPid();
  if (hasUnit || pid !== undefined) {
    stopped = false;
    const line = !hasUnit ? `the running supervisor (pid ${pid})`
      : deps.platform === 'darwin' ? `the background service: launchd agent ${label} (${unit})`
        : `the background service: systemd user unit ${label}.service (${unit})`;
    steps.push({ line, run: async () => {
      if (await deps.supervisor.answers()) await deps.supervisor.stopGateway().catch(() => {});
      let unloadError: Error | undefined;
      if (hasUnit) unloadError = await unloadService(deps, label).then(() => undefined, (error: Error) => error);
      // A supervisor launchd or systemd did not own (`buddi --no-service`) is asked directly.
      const left = deps.supervisorPid();
      if (left !== undefined && unloadError === undefined) deps.signal(left, 'SIGTERM');
      for (let waited = 0; deps.supervisorPid() !== undefined; waited += 250) {
        if (waited >= 60_000) {
          throw unloadError ?? new Error(`the supervisor (pid ${deps.supervisorPid()}) did not stop within a minute`);
        }
        await deps.sleep(250);
      }
      if (unloadError) throw unloadError;
      if (hasUnit) {
        await deps.remove(unit);
        if (deps.platform === 'linux') await deps.exec('systemctl', ['--user', 'daemon-reload']);
      }
      stopped = true;
    } });
  }

  /* The data directory. */
  if (!options.keepData && hasData) {
    const held = CONTENTS.filter(([names]) => names.some(name => deps.exists(join(name)))).map(([, said]) => said);
    steps.push({
      line: `the data directory ${data}${held.length > 0 ? `: ${list(held)}` : ''}`,
      run: async () => {
        if (!stopped) throw new Error('it was left in place because the service did not stop, and the database may still be running');
        await deps.remove(data);
      },
    });
  }

  /* Secrets. On Linux they are files in the data directory; kept with it by --keep-data. */
  if (!options.keepData) {
    if (deps.keychain) {
      const keychain = deps.keychain;
      let names: string[] = [];
      let unreadable: string | undefined;
      try { names = await keychain.names(); } catch (error) { unreadable = (error as Error).message; }
      if (names.length > 0 || unreadable !== undefined) {
        steps.push({
          line: unreadable !== undefined
            ? `secrets: the keychain entries under ${keychain.service} (they could not be listed: ${unreadable.replace(/\.$/, '')})`
            : `secrets: ${names.length} keychain ${names.length === 1 ? 'entry' : 'entries'} under ${keychain.service}: ${names.join(', ')}`,
          run: async () => {
            if (unreadable !== undefined) throw new Error(unreadable);
            // Again at the time of removal: the last backup may have just made the passphrase entry.
            const now = await keychain.names().catch(() => names);
            await keychain.purge([...new Set([...names, ...now])]);
          },
        });
      }
    } else {
      const files = [join('vault.json'), join('vault-key')].filter(file => deps.exists(file));
      if (files.length > 0) {
        steps.push({
          line: `secrets: the file vault ${join('vault.json')} and its key ${join('vault-key')}`,
          run: async () => { for (const file of files) if (deps.exists(file)) await deps.remove(file); },
        });
      }
    }
  }

  /* The dashboard app. */
  if (deps.app !== undefined) {
    const app = deps.app;
    steps.push({ line: `the dashboard app ${app}`, run: () => deps.remove(app) });
  }

  /* The extension pairing lives in the data directory; --keep-data keeps it. */
  const pairing = join('extension.json');
  if (!options.keepData && deps.exists(pairing)) {
    steps.push({ line: `the extension pairing record ${pairing}`, run: async () => { if (deps.exists(pairing)) await deps.remove(pairing); } });
  }

  /* The Telegram bot's menu: the bot is the owner's, only buddi's menu goes. */
  let clearMenu: (() => Promise<void>) | undefined;
  if (deps.telegram) {
    steps.push({
      line: "the Telegram bot's command menu",
      bestEffort: true,
      run: async () => {
        if (!clearMenu) throw new Error('the paired chats could not be read');
        await clearMenu();
      },
    });
  }

  const notes: string[] = [];
  const backingUp = options.backup && isInstallation && steps.length > 0;
  if (backingUp) {
    notes.push(options.keepData
      ? `First it takes one last backup, into ${join('backups')}.`
      : `First it takes one last backup and moves it to ${keptBackupsDir(home)}, where it stays.`);
  }
  if (options.keepData && hasData) notes.push(`The data directory ${data} stays as it is, with the secrets that open it, for a reinstall.`);

  const plan: UninstallPlan = {
    heading: `This removes buddi from ${machine}:`,
    steps,
    notes,
    last: PACKAGE_LINE,
    prepare: async () => {
      const lines: string[] = [];
      if (backingUp) {
        if (!(await deps.supervisor.answers())) {
          throw new Error('The service is not running, so the last backup could not be taken. Start it with buddi, or run buddi uninstall --no-backup.');
        }
        io.log('Taking one last backup.');
        const archive = await deps.supervisor.backup();
        if (options.keepData) {
          lines.push(`The backup is ${archive}. It stays, with the rest of the data directory.`);
        } else {
          const kept = path.join(keptBackupsDir(home), path.basename(archive));
          await deps.move(archive, kept);
          const envelope = archive.replace(/\.age$/, '.json');
          if (envelope !== archive && deps.exists(envelope)) await deps.move(envelope, path.join(keptBackupsDir(home), path.basename(envelope)));
          lines.push(`The backup is ${kept}. It stays: uninstall does not touch that folder.`);
          if (archive.endsWith('.age')) {
            const phrase = await deps.supervisor.passphrase().catch(() => undefined);
            if (phrase !== undefined) {
              lines.push(`It is locked with your backup passphrase, and the vault that keeps it is going: ${phrase}`);
              lines.push('Write the six words down. Nothing else opens that backup.');
            }
          }
        }
      }
      if (deps.telegram) clearMenu = await deps.telegram.collect().catch(() => undefined);
      return lines;
    },
  };
  return await runUninstallPlan(plan, { yes: options.yes }, io);
}

/** "a, b and c". */
function list(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Stop and unload the service's unit. launchd's `bootout` stops the job and
 * returns while launchd may still be removing it, so it is waited for;
 * systemd's `disable --now` returns when the job has stopped.
 */
async function unloadService(deps: PackagedUninstallDeps, label: string): Promise<void> {
  if (deps.platform === 'darwin') {
    const target = `gui/${deps.uid}/${label}`;
    const out = await deps.exec('launchctl', ['bootout', target]);
    // 3 and 113: launchd has no such job loaded, which is what we want.
    if (out.code !== 0 && out.code !== 3 && out.code !== 113) {
      throw new Error(`launchctl bootout ${target} failed (${out.code}): ${(out.stderr || out.stdout).trim() || 'no detail'}`);
    }
    for (let waited = 0; ; waited += 100) {
      const printed = await deps.exec('launchctl', ['print', target]);
      if (printed.code !== 0) return;
      if (waited >= 20_000) throw new Error(`launchd did not unload ${label} within 20 seconds`);
      await deps.sleep(100);
    }
  }
  const out = await deps.exec('systemctl', ['--user', 'disable', '--now', `${label}.service`]);
  if (out.code !== 0) {
    throw new Error(`systemctl --user disable --now ${label}.service failed (${out.code}): ${(out.stderr || out.stdout).trim() || 'no detail'}`);
  }
}
