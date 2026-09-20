/**
 * `buddi backup schedule` — a nightly backup, supervised by the OS.
 *
 * Deliberately **not** a mission and **not** a loop inside `buddi serve`. A
 * backup that only runs while the thing being backed up is healthy is the one
 * backup you cannot rely on: a crash-looping service would quietly stop taking
 * them, and the night you need one is exactly the night it did not run. So it
 * is a second, independent launchd agent (`com.buddi.backup`), and
 * `buddi service` stays about the server.
 *
 * It runs `buddi backup create --prune`, so pruning is part of the same job:
 * one thing to install, one thing that cannot drift.
 */
import { mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BACKUP_DIR, CLI_ENTRY, LOG_DIR, REPO_ROOT } from '../paths.js';
import { run } from '../proc.js';
import { escapeXml, parseLaunchctlPrint } from '../service/units.js';
import { DEFAULT_KEEP, DIR_MODE } from '@buddi/core';

export const BACKUP_LABEL = 'com.buddi.backup';

/** 03:30 local: after midnight jobs, before anyone is awake to be interrupted. */
export const BACKUP_HOUR = 3;
export const BACKUP_MINUTE = 30;

export interface BackupUnitSpec {
  label: string;
  nodePath: string;
  /** Absolute path to `packages/cli/dist/main.js`. */
  cliEntry: string;
  workingDirectory: string;
  logFile: string;
  errorFile: string;
  path: string;
  hour: number;
  minute: number;
  keep: number;
}

/**
 * The plist. `StartCalendarInterval` rather than `StartInterval`: launchd runs a
 * missed calendar job once the machine wakes, which is the behaviour a laptop
 * needs — a `StartInterval` job on a closed lid simply never happens.
 */
export function buildBackupPlist(spec: BackupUnitSpec): string {
  const e = escapeXml;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${e(spec.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${e(spec.nodePath)}</string>
    <string>${e(spec.cliEntry)}</string>
    <string>backup</string>
    <string>create</string>
    <string>--prune</string>
    <string>${spec.keep}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${e(spec.workingDirectory)}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${spec.hour}</integer>
    <key>Minute</key>
    <integer>${spec.minute}</integer>
  </dict>
  <key>RunAtLoad</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${e(spec.logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${e(spec.errorFile)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${e(spec.path)}</string>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`;
}

/** The Linux counterpart: a systemd user timer plus the oneshot it triggers. */
export function buildBackupTimer(spec: BackupUnitSpec): { service: string; timer: string } {
  const hhmm = `${String(spec.hour).padStart(2, '0')}:${String(spec.minute).padStart(2, '0')}:00`;
  return {
    service: `[Unit]
Description=buddi — nightly backup

[Service]
Type=oneshot
ExecStart=${spec.nodePath} ${spec.cliEntry} backup create --prune ${spec.keep}
WorkingDirectory=${spec.workingDirectory}
Environment=PATH=${spec.path}
StandardOutput=append:${spec.logFile}
StandardError=append:${spec.errorFile}
`,
    timer: `[Unit]
Description=buddi — nightly backup at ${hhmm}

[Timer]
OnCalendar=*-*-* ${hhmm}
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

export interface ScheduleStatus {
  installed: boolean;
  /** Whether the OS has the job loaded, not whether a backup ran. */
  loaded: boolean;
  unitPath: string;
  detail: string;
}

export interface BackupScheduler {
  readonly kind: string;
  readonly unitPath: string;
  readonly logFile: string;
  readonly errorFile: string;
  install(keep: number): Promise<string[]>;
  uninstall(): Promise<string[]>;
  status(): Promise<ScheduleStatus>;
}

function specFor(logFile: string, errorFile: string, keep: number): BackupUnitSpec {
  const nodePath = process.execPath;
  return {
    label: BACKUP_LABEL,
    nodePath,
    cliEntry: CLI_ENTRY,
    workingDirectory: REPO_ROOT,
    logFile,
    errorFile,
    path: [
      path.dirname(nodePath),
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(':'),
    hour: BACKUP_HOUR,
    minute: BACKUP_MINUTE,
    keep,
  };
}

class LaunchdBackupScheduler implements BackupScheduler {
  readonly kind = 'launchd';
  readonly unitPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${BACKUP_LABEL}.plist`);
  readonly logFile = path.join(LOG_DIR, 'backup.log');
  readonly errorFile = path.join(LOG_DIR, 'backup.err');

  get #domain(): string {
    return `gui/${process.getuid?.() ?? 501}`;
  }

  get #target(): string {
    return `${this.#domain}/${BACKUP_LABEL}`;
  }

  async install(keep: number): Promise<string[]> {
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`${CLI_ENTRY} does not exist — run "pnpm -r build" first`);
    }
    mkdirSync(LOG_DIR, { recursive: true });
    mkdirSync(BACKUP_DIR, { recursive: true, mode: DIR_MODE });
    mkdirSync(path.dirname(this.unitPath), { recursive: true });
    writeFileSync(this.unitPath, buildBackupPlist(specFor(this.logFile, this.errorFile, keep)));

    await run('launchctl', ['bootout', this.#target]);
    const res = await run('launchctl', ['bootstrap', this.#domain, this.unitPath]);
    if (res.code !== 0) {
      throw new Error(
        `launchctl bootstrap failed (${res.code}): ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }
    return [
      `wrote ${this.unitPath}`,
      `a backup runs every night at ${String(BACKUP_HOUR).padStart(2, '0')}:${String(BACKUP_MINUTE).padStart(2, '0')} local, keeping ${keep}`,
      `archives: ${BACKUP_DIR}`,
      `log: ${this.logFile}`,
      'it is a separate job from `buddi service` on purpose — a backup must not depend on the server being healthy',
    ];
  }

  async uninstall(): Promise<string[]> {
    const notes: string[] = [];
    const res = await run('launchctl', ['bootout', this.#target]);
    notes.push(
      res.code === 0
        ? `launchctl bootout ${this.#target} — no more nightly backups`
        : `the job was not loaded (${res.stderr.trim() || 'nothing to boot out'})`,
    );
    if (existsSync(this.unitPath)) {
      rmSync(this.unitPath);
      notes.push(`removed ${this.unitPath}`);
    } else {
      notes.push(`no plist at ${this.unitPath}`);
    }
    notes.push(`kept every archive in ${BACKUP_DIR}`);
    return notes;
  }

  async status(): Promise<ScheduleStatus> {
    const installed = existsSync(this.unitPath);
    const res = await run('launchctl', ['print', this.#target]);
    if (res.code !== 0) {
      return {
        installed,
        loaded: false,
        unitPath: this.unitPath,
        detail: installed ? 'plist present, job not loaded' : 'not installed',
      };
    }
    const parsed = parseLaunchctlPrint(res.stdout);
    return {
      installed,
      loaded: true,
      unitPath: this.unitPath,
      detail: parsed.running
        ? 'loaded (a backup is running right now)'
        : `loaded — next run ${String(BACKUP_HOUR).padStart(2, '0')}:${String(BACKUP_MINUTE).padStart(2, '0')} local`,
    };
  }
}

class SystemdBackupScheduler implements BackupScheduler {
  readonly kind = 'systemd';
  readonly #dir = path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
    'systemd',
    'user',
  );
  readonly unitPath = path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
    'systemd',
    'user',
    `${BACKUP_LABEL}.timer`,
  );
  readonly logFile = path.join(LOG_DIR, 'backup.log');
  readonly errorFile = path.join(LOG_DIR, 'backup.err');

  async install(keep: number): Promise<string[]> {
    const notes = ['note: the systemd implementation is untested — report what it does.'];
    if (!existsSync(CLI_ENTRY)) {
      throw new Error(`${CLI_ENTRY} does not exist — run "pnpm -r build" first`);
    }
    mkdirSync(LOG_DIR, { recursive: true });
    mkdirSync(BACKUP_DIR, { recursive: true, mode: DIR_MODE });
    mkdirSync(this.#dir, { recursive: true });
    const units = buildBackupTimer(specFor(this.logFile, this.errorFile, keep));
    writeFileSync(path.join(this.#dir, `${BACKUP_LABEL}.service`), units.service);
    writeFileSync(this.unitPath, units.timer);
    await run('systemctl', ['--user', 'daemon-reload']);
    const res = await run('systemctl', ['--user', 'enable', '--now', `${BACKUP_LABEL}.timer`]);
    if (res.code !== 0) {
      throw new Error(`systemctl enable --now failed (${res.code}): ${res.stderr.trim()}`);
    }
    notes.push(`wrote ${this.unitPath}`, `a backup runs nightly, keeping ${keep}`);
    return notes;
  }

  async uninstall(): Promise<string[]> {
    const notes: string[] = [];
    const res = await run('systemctl', ['--user', 'disable', '--now', `${BACKUP_LABEL}.timer`]);
    notes.push(
      res.code === 0
        ? `systemctl --user disable --now ${BACKUP_LABEL}.timer`
        : `the timer was not active (${res.stderr.trim() || 'nothing to disable'})`,
    );
    for (const file of [this.unitPath, path.join(this.#dir, `${BACKUP_LABEL}.service`)]) {
      if (existsSync(file)) {
        rmSync(file);
        notes.push(`removed ${file}`);
      }
    }
    await run('systemctl', ['--user', 'daemon-reload']);
    notes.push(`kept every archive in ${BACKUP_DIR}`);
    return notes;
  }

  async status(): Promise<ScheduleStatus> {
    const installed = existsSync(this.unitPath);
    const res = await run('systemctl', [
      '--user',
      'show',
      `${BACKUP_LABEL}.timer`,
      '--property=ActiveState',
      '--property=NextElapseUSecRealtime',
    ]);
    const loaded = res.code === 0 && /ActiveState=active/.test(res.stdout);
    return {
      installed,
      loaded,
      unitPath: this.unitPath,
      detail: loaded ? 'timer active' : installed ? 'timer present, not active' : 'not installed',
    };
  }
}

export class UnsupportedScheduleError extends Error {}

export function createBackupScheduler(platform: string = process.platform): BackupScheduler {
  if (platform === 'darwin') return new LaunchdBackupScheduler();
  if (platform === 'linux') return new SystemdBackupScheduler();
  throw new UnsupportedScheduleError(
    `buddi backup schedule supports macOS (launchd) and Linux (systemd timers), not ${platform}. ` +
      `Run \`buddi backup create --prune ${DEFAULT_KEEP}\` from whatever scheduler this platform has.`,
  );
}
