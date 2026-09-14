/**
 * `buddi service` — run `buddi serve` in the background, supervised.
 *
 * One interface, two implementations: macOS launchd (the one this is built and
 * used on) and a systemd *user* unit for Linux, written to the same spec but
 * untested — it is best-effort, and says so when it runs.
 *
 * Nothing here knows what the service does; it only knows how to keep a node
 * process alive and where its log goes.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, ENV_FILE, LOG_DIR, REPO_ROOT, SERVE_ENTRY } from '../paths.js';
import { run } from '../proc.js';
import {
  buildPlist,
  buildSystemdUnit,
  parseLaunchctlPrint,
  parseSystemctlShow,
  SERVICE_LABEL,
  type UnitSpec,
} from './units.js';

export * from './units.js';

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  /** Where the unit file lives, whether or not it is there. */
  unitPath: string;
  detail: string;
}

export interface ServiceManager {
  /** 'launchd' | 'systemd' */
  readonly kind: string;
  readonly unitPath: string;
  readonly logFile: string;
  readonly errorFile: string;
  install(): Promise<string[]>;
  uninstall(): Promise<string[]>;
  /** Load the installed unit and run it. Idempotent; never writes the unit. */
  start(): Promise<string[]>;
  /** Unload it. The unit file stays, so `start` (or a login) brings it back. */
  stop(): Promise<string[]>;
  status(): Promise<ServiceStatus>;
  restart(): Promise<string[]>;
}

/** What `serve` cannot start without. Checked before a unit is ever written. */
export const REQUIRED_ENV = ['DATABASE_URL', 'TELEGRAM_BOT_TOKEN'] as const;
export const CREDENTIAL_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'] as const;

/** Parse `.env` shallowly: `KEY=value` lines, no interpolation, no quotes removed. */
export function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    out[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return out;
}

/** The names that are missing or empty. Empty result means the unit may be written. */
export function missingRequiredEnv(env: Record<string, string>): string[] {
  const missing: string[] = REQUIRED_ENV.filter((k) => !env[k] || env[k].trim() === '');
  if (!CREDENTIAL_ENV.some((k) => env[k] && env[k].trim() !== '')) {
    missing.push(`${CREDENTIAL_ENV[0]} or ${CREDENTIAL_ENV[1]}`);
  }
  return missing;
}

/** A `pnpm serve` / `node …/serve.js` already running would fight over the bot. */
export async function findRunningServe(): Promise<number[]> {
  const res = await run('pgrep', ['-f', 'gateway/dist/serve.js']);
  if (res.code !== 0) return [];
  return res.stdout
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
}

function unitSpec(label: string, logFile: string, errorFile: string): UnitSpec {
  const nodePath = process.execPath;
  const nodeDir = path.dirname(nodePath);
  return {
    label,
    nodePath,
    serveEntry: SERVE_ENTRY,
    workingDirectory: REPO_ROOT,
    logFile,
    errorFile,
    path: [nodeDir, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(
      ':',
    ),
  };
}

/** Shared preflight: the unit is never written when the service could not start. */
async function preflight(notes: string[]): Promise<void> {
  if (!existsSync(SERVE_ENTRY)) {
    throw new Error(`${SERVE_ENTRY} does not exist — run "pnpm -r build" first`);
  }
  const missing = missingRequiredEnv(readEnvFile(ENV_FILE));
  if (missing.length > 0) {
    throw new Error(
      `${ENV_FILE} is missing ${missing.join(', ')} — run "buddi init" before installing the service`,
    );
  }
  const running = await findRunningServe();
  if (running.length > 0) {
    notes.push(
      `warning: serve is already running (pid ${running.join(', ')}). Two pollers fight over ` +
        'the same bot — stop that one (Ctrl-C in its shell) before the service starts.',
    );
  }
  mkdirSync(LOG_DIR, { recursive: true });
}

/* ------------------------------------------------------------------ *
 * macOS — launchd LaunchAgent
 * ------------------------------------------------------------------ */

class LaunchdManager implements ServiceManager {
  readonly kind = 'launchd';
  readonly unitPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  readonly logFile = path.join(LOG_DIR, 'serve.log');
  readonly errorFile = path.join(LOG_DIR, 'serve.err');

  get #domain(): string {
    return `gui/${process.getuid?.() ?? 501}`;
  }

  get #target(): string {
    return `${this.#domain}/${SERVICE_LABEL}`;
  }

  async install(): Promise<string[]> {
    const notes: string[] = [];
    await preflight(notes);
    mkdirSync(path.dirname(this.unitPath), { recursive: true });
    writeFileSync(this.unitPath, buildPlist(unitSpec(SERVICE_LABEL, this.logFile, this.errorFile)));
    notes.push(`wrote ${this.unitPath}`);

    // An already-loaded job must be booted out first; a fresh machine has none.
    await run('launchctl', ['bootout', this.#target]);
    const res = await run('launchctl', ['bootstrap', this.#domain, this.unitPath]);
    if (res.code !== 0) {
      throw new Error(
        `launchctl bootstrap failed (${res.code}): ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }
    notes.push(`launchctl bootstrap ${this.#domain} — the service starts now and at every login`);
    notes.push(`logs: ${this.logFile} (buddi service logs)`);
    return notes;
  }

  async uninstall(): Promise<string[]> {
    const notes: string[] = [];
    const res = await run('launchctl', ['bootout', this.#target]);
    notes.push(
      res.code === 0
        ? `launchctl bootout ${this.#target} — the service is stopped and will not start at login`
        : `the service was not loaded (${res.stderr.trim() || 'nothing to boot out'})`,
    );
    if (existsSync(this.unitPath)) {
      rmSync(this.unitPath);
      notes.push(`removed ${this.unitPath}`);
    } else {
      notes.push(`no plist at ${this.unitPath}`);
    }
    notes.push(`kept the logs in ${LOG_DIR}`);
    return notes;
  }

  /**
   * `bootstrap`, not `kickstart`: after a crash-loop launchd leaves the job
   * loaded-but-dead, and after `stop` it is not loaded at all. Bootstrapping
   * covers both, and a job that is already up says so instead of erroring.
   */
  async start(): Promise<string[]> {
    if (!existsSync(this.unitPath)) {
      throw new Error('the service is not installed — run "buddi service install" first');
    }
    const before = await this.status();
    if (before.running) return [`${SERVICE_LABEL} is already running${before.pid ? ` (pid ${before.pid})` : ''}`];
    const res = await run('launchctl', ['bootstrap', this.#domain, this.unitPath]);
    if (res.code !== 0) {
      // Already loaded but not running (the crash-loop case): kick it.
      const kick = await run('launchctl', ['kickstart', '-k', this.#target]);
      if (kick.code !== 0) {
        throw new Error(
          `could not start ${SERVICE_LABEL}: ${res.stderr.trim() || res.stdout.trim()}`,
        );
      }
      return [`kickstarted ${SERVICE_LABEL} (it was loaded but not running)`];
    }
    return [`launchctl bootstrap ${this.#domain} — ${SERVICE_LABEL} is running`];
  }

  /**
   * `bootout` stops it *and* unloads it, which is the only way to stop a job
   * with `KeepAlive`: anything softer is restarted a second later. The plist
   * stays where it is — removal is `uninstall`.
   */
  async stop(): Promise<string[]> {
    const res = await run('launchctl', ['bootout', this.#target]);
    return [
      res.code === 0
        ? `launchctl bootout ${this.#target} — stopped (the plist is still there; \`buddi service start\` runs it again)`
        : `the service was not loaded (${res.stderr.trim() || 'nothing to boot out'})`,
    ];
  }

  async status(): Promise<ServiceStatus> {
    const installed = existsSync(this.unitPath);
    const res = await run('launchctl', ['print', this.#target]);
    if (res.code !== 0) {
      return {
        installed,
        running: false,
        unitPath: this.unitPath,
        detail: installed ? 'plist present, job not loaded' : 'not installed',
      };
    }
    const parsed = parseLaunchctlPrint(res.stdout);
    return {
      installed,
      running: parsed.running,
      ...(parsed.pid !== undefined ? { pid: parsed.pid } : {}),
      unitPath: this.unitPath,
      detail: parsed.running
        ? `running${parsed.pid ? ` (pid ${parsed.pid})` : ''}`
        : 'loaded but not running',
    };
  }

  async restart(): Promise<string[]> {
    if (!existsSync(this.unitPath)) {
      throw new Error('the service is not installed — run "buddi service install" first');
    }
    const res = await run('launchctl', ['kickstart', '-k', this.#target]);
    if (res.code !== 0) {
      throw new Error(
        `launchctl kickstart failed (${res.code}): ${res.stderr.trim() || res.stdout.trim()}`,
      );
    }
    return [`restarted ${SERVICE_LABEL}`];
  }
}

/* ------------------------------------------------------------------ *
 * Linux — systemd user unit (best effort, untested)
 * ------------------------------------------------------------------ */

class SystemdManager implements ServiceManager {
  readonly kind = 'systemd';
  readonly unitName = `${SERVICE_LABEL}.service`;
  readonly unitPath = path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'),
    'systemd',
    'user',
    `${SERVICE_LABEL}.service`,
  );
  readonly logFile = path.join(LOG_DIR, 'serve.log');
  readonly errorFile = path.join(LOG_DIR, 'serve.err');

  async install(): Promise<string[]> {
    const notes = ['note: the systemd implementation is untested — report what it does.'];
    await preflight(notes);
    mkdirSync(path.dirname(this.unitPath), { recursive: true });
    writeFileSync(
      this.unitPath,
      buildSystemdUnit(unitSpec(SERVICE_LABEL, this.logFile, this.errorFile)),
    );
    notes.push(`wrote ${this.unitPath}`);
    await run('systemctl', ['--user', 'daemon-reload']);
    const res = await run('systemctl', ['--user', 'enable', '--now', this.unitName]);
    if (res.code !== 0) {
      throw new Error(`systemctl enable --now failed (${res.code}): ${res.stderr.trim()}`);
    }
    notes.push(`systemctl --user enable --now ${this.unitName}`);
    notes.push('run `loginctl enable-linger $USER` if it must survive logout');
    return notes;
  }

  async uninstall(): Promise<string[]> {
    const notes: string[] = [];
    const res = await run('systemctl', ['--user', 'disable', '--now', this.unitName]);
    notes.push(
      res.code === 0
        ? `systemctl --user disable --now ${this.unitName}`
        : `the unit was not active (${res.stderr.trim() || 'nothing to disable'})`,
    );
    if (existsSync(this.unitPath)) {
      rmSync(this.unitPath);
      notes.push(`removed ${this.unitPath}`);
    } else {
      notes.push(`no unit file at ${this.unitPath}`);
    }
    await run('systemctl', ['--user', 'daemon-reload']);
    notes.push(`kept the logs in ${LOG_DIR}`);
    return notes;
  }

  async start(): Promise<string[]> {
    if (!existsSync(this.unitPath)) {
      throw new Error('the service is not installed — run "buddi service install" first');
    }
    const res = await run('systemctl', ['--user', 'start', this.unitName]);
    if (res.code !== 0) throw new Error(`systemctl start failed (${res.code}): ${res.stderr}`);
    return [`systemctl --user start ${this.unitName}`];
  }

  async stop(): Promise<string[]> {
    const res = await run('systemctl', ['--user', 'stop', this.unitName]);
    return [
      res.code === 0
        ? `systemctl --user stop ${this.unitName} (the unit stays enabled)`
        : `the unit was not running (${res.stderr.trim() || 'nothing to stop'})`,
    ];
  }

  async status(): Promise<ServiceStatus> {
    const installed = existsSync(this.unitPath);
    const res = await run('systemctl', [
      '--user',
      'show',
      this.unitName,
      '--property=ActiveState',
      '--property=SubState',
      '--property=MainPID',
    ]);
    if (res.code !== 0) {
      return {
        installed,
        running: false,
        unitPath: this.unitPath,
        detail: installed ? 'unit present, systemctl could not read it' : 'not installed',
      };
    }
    const parsed = parseSystemctlShow(res.stdout);
    return {
      installed,
      running: parsed.running,
      ...(parsed.pid !== undefined ? { pid: parsed.pid } : {}),
      unitPath: this.unitPath,
      detail: parsed.running
        ? `running${parsed.pid ? ` (pid ${parsed.pid})` : ''}`
        : installed
          ? 'installed, not running'
          : 'not installed',
    };
  }

  async restart(): Promise<string[]> {
    const res = await run('systemctl', ['--user', 'restart', this.unitName]);
    if (res.code !== 0) throw new Error(`systemctl restart failed (${res.code}): ${res.stderr}`);
    return [`restarted ${this.unitName}`];
  }
}

export class UnsupportedPlatformError extends Error {}

export function createServiceManager(platform: string = process.platform): ServiceManager {
  if (platform === 'darwin') return new LaunchdManager();
  if (platform === 'linux') return new SystemdManager();
  throw new UnsupportedPlatformError(
    `buddi service supports macOS (launchd) and Linux (systemd user units), not ${platform}. ` +
      'Run `buddi serve` under whatever supervisor this platform has.',
  );
}

/** `buddi service logs` — follow the log until Ctrl-C. Never returns normally. */
export async function followLogs(manager: ServiceManager): Promise<void> {
  mkdirSync(LOG_DIR, { recursive: true });
  for (const file of [manager.logFile, manager.errorFile]) {
    if (!existsSync(file)) writeFileSync(file, '');
  }
  console.log(`tail -f ${manager.logFile} ${manager.errorFile}  (Ctrl-C to stop)`);
  await new Promise<void>((resolve) => {
    const child = spawn('tail', ['-n', '80', '-F', manager.logFile, manager.errorFile], {
      stdio: 'inherit',
    });
    child.on('exit', () => resolve());
    child.on('error', (err) => {
      console.error(`could not tail the log: ${err.message}`);
      resolve();
    });
  });
}

export { DATA_DIR };
