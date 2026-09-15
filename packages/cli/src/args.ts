/**
 * `buddi` argument parsing — pure, and the only part of the dispatcher worth a
 * unit test.
 *
 * The binary owns the *first* word (and, for the grouped commands, the second);
 * everything after it is handed to the module that already implements it. That
 * is why `chat`, `ask`, `agents` and `missions` keep their own option parsing:
 * this file must not learn `--resume`.
 */

import { DEFAULT_KEEP } from './backup/manifest.js';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const SERVICE_ACTIONS = [
  'install',
  'uninstall',
  'start',
  'stop',
  'status',
  'logs',
  'restart',
] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

/**
 * The postgres container: `docker compose up -d postgres` and friends, plus
 * `secure` — the one-time migration off the shipped password.
 */
export const DB_ACTIONS = ['up', 'down', 'status', 'secure'] as const;
export type DbAction = (typeof DB_ACTIONS)[number];

export const VAULT_ACTIONS = ['set', 'get', 'delete', 'list', 'import-env'] as const;
export type VaultAction = (typeof VAULT_ACTIONS)[number];

/** `buddi dashboard` — open it, print just the ticket, or explain the off switch. */
export const DASHBOARD_ACTIONS = ['open', 'token', 'off'] as const;
export type DashboardAction = (typeof DASHBOARD_ACTIONS)[number];

export const TELEGRAM_ACTIONS = ['pair', 'devices', 'unpair'] as const;
export type TelegramAction = (typeof TELEGRAM_ACTIONS)[number];

/** `buddi backup` — the installation's own copy of itself. */
export const BACKUP_ACTIONS = ['create', 'list', 'verify', 'restore', 'prune', 'schedule'] as const;
export type BackupAction = (typeof BACKUP_ACTIONS)[number];

/** `buddi backup schedule` — the nightly job, separate from `buddi service`. */
export const BACKUP_SCHEDULE_ACTIONS = ['install', 'uninstall', 'status'] as const;
export type BackupScheduleAction = (typeof BACKUP_SCHEDULE_ACTIONS)[number];

/** Job states `buddi jobs --state` accepts; the same set core's queue uses. */
export const JOB_STATE_NAMES = [
  'pending',
  'leased',
  'succeeded',
  'failed',
  'suspended',
  'cancelled',
] as const;
export type JobStateName = (typeof JOB_STATE_NAMES)[number];

export type Command =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'serve' }
  /** Delegated verbatim to the gateway's chat CLI, command word included. */
  | { kind: 'chat-cli'; argv: string[] }
  /** Delegated verbatim to the gateway's missions CLI. */
  | { kind: 'missions'; argv: string[] }
  /** Install, uninstall, list and inspect plugins. The gateway's CLI owns it. */
  | { kind: 'plugins'; argv: string[] }
  /** One-off reminders the agents set. Delegated to the gateway's CLI. */
  | { kind: 'reminders'; argv: string[] }
  /** The first-run arc: what it has sent, and the switch. */
  | { kind: 'nudges'; argv: string[] }
  | { kind: 'migrate' }
  /** `--yes`: ask nothing, take every default, skip what needs typing. */
  | { kind: 'init'; yes: boolean }
  | { kind: 'doctor' }
  | { kind: 'service'; action: ServiceAction }
  | { kind: 'db'; action: DbAction }
  | { kind: 'telegram'; action: TelegramAction; deviceId?: string }
  /** The local dashboard over the event log. */
  | { kind: 'dashboard'; action: DashboardAction }
  /** Secrets in the OS keychain; the name is optional only for `list`. */
  | { kind: 'vault'; action: VaultAction; name?: string }
  /** Global pause control (ARCHITECTURE.md, "Queue, concurrency, recovery"). */
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'jobs'; action: 'list'; state?: JobStateName; kind_?: string; limit?: number }
  | { kind: 'jobs'; action: 'retry' | 'cancel'; jobId: string }
  /**
   * `buddi jobs retry --all` — the answer to a wave. An outage kills jobs in
   * bulk and retyping twelve ids is not an inspection path.
   */
  | { kind: 'jobs'; action: 'retry-all'; state?: JobStateName; kind_?: string; limit?: number }
  /**
   * Backups. One shape for six verbs: the options are few, they do not overlap,
   * and a discriminated union per verb would be six types nobody reads.
   */
  | {
      kind: 'backup';
      action: BackupAction;
      /** `create --out <dir>`; default `<data dir>/backups`. */
      out?: string;
      /** `create --no-artifacts`. */
      noArtifacts?: boolean;
      /** `create --prune [n]` — what the nightly job passes. */
      prune?: number;
      /** `prune --keep n` / `schedule install --keep n`. */
      keep?: number;
      /** The archive `verify` and `restore` act on. */
      archive?: string;
      /** `restore --into <database>`. */
      into?: string;
      yes?: boolean;
      force?: boolean;
      scheduleAction?: BackupScheduleAction;
    };

/** Commands the gateway's chat CLI owns; it re-parses the whole slice. */
const CHAT_COMMANDS = new Set(['chat', 'ask', 'agents']);

export function parseArgs(argv: string[]): Command {
  const [head, ...rest] = argv;

  if (head === undefined || head === 'help' || head === '--help' || head === '-h') {
    return { kind: 'help' };
  }
  if (head === '--version' || head === '-v' || head === 'version') return { kind: 'version' };

  if (CHAT_COMMANDS.has(head)) return { kind: 'chat-cli', argv };
  if (head === 'serve') {
    if (rest.length > 0) throw new UsageError(`buddi serve takes no arguments (got ${rest[0]})`);
    return { kind: 'serve' };
  }
  if (head === 'missions') return { kind: 'missions', argv: rest };
  if (head === 'plugins') return { kind: 'plugins', argv: rest };
  if (head === 'reminders') return { kind: 'reminders', argv: rest };
  if (head === 'nudges') return { kind: 'nudges', argv: rest };
  if (head === 'migrate') return { kind: 'migrate' };
  if (head === 'init') {
    let yes = false;
    for (const arg of rest) {
      if (arg === '--yes' || arg === '-y') yes = true;
      else throw new UsageError(`unknown option for buddi init: ${arg} (expected --yes)`);
    }
    return { kind: 'init', yes };
  }
  // `status` is what a person types when they want to know if it works; it is
  // the doctor under another name rather than a second, thinner report.
  if (head === 'doctor' || head === 'status') return { kind: 'doctor' };

  if (head === 'db') {
    const action = rest[0];
    if (action === undefined) {
      throw new UsageError(`buddi db needs one of: ${DB_ACTIONS.join(', ')}`);
    }
    if (!(DB_ACTIONS as readonly string[]).includes(action)) {
      throw new UsageError(`unknown db action: ${action} (expected ${DB_ACTIONS.join(', ')})`);
    }
    if (rest.length > 1) throw new UsageError(`unexpected argument: ${rest[1]}`);
    return { kind: 'db', action: action as DbAction };
  }

  if (head === 'pause') {
    if (rest.length > 0) throw new UsageError(`buddi pause takes no arguments (got ${rest[0]})`);
    return { kind: 'pause' };
  }
  if (head === 'resume') {
    if (rest.length > 0) throw new UsageError(`buddi resume takes no arguments (got ${rest[0]})`);
    return { kind: 'resume' };
  }
  if (head === 'jobs') return parseJobs(rest);
  if (head === 'backup') return parseBackup(rest);

  if (head === 'service') {
    const action = rest[0];
    if (action === undefined) {
      throw new UsageError(`buddi service needs one of: ${SERVICE_ACTIONS.join(', ')}`);
    }
    if (!(SERVICE_ACTIONS as readonly string[]).includes(action)) {
      throw new UsageError(
        `unknown service action: ${action} (expected ${SERVICE_ACTIONS.join(', ')})`,
      );
    }
    if (rest.length > 1) throw new UsageError(`unexpected argument: ${rest[1]}`);
    return { kind: 'service', action: action as ServiceAction };
  }

  if (head === 'vault') {
    const action = rest[0];
    if (action === undefined) {
      throw new UsageError(`buddi vault needs one of: ${VAULT_ACTIONS.join(', ')}`);
    }
    if (!(VAULT_ACTIONS as readonly string[]).includes(action)) {
      throw new UsageError(
        `unknown vault action: ${action} (expected ${VAULT_ACTIONS.join(', ')})`,
      );
    }
    const needsName = action === 'set' || action === 'get' || action === 'delete';
    const name = rest[1];
    if (needsName && !name) throw new UsageError(`buddi vault ${action} needs a secret name`);
    if (!needsName && name) throw new UsageError(`unexpected argument: ${name}`);
    if (rest.length > 2) throw new UsageError(`unexpected argument: ${rest[2]}`);
    // A value is never an argument: it would land in shell history. `set`
    // prompts with the terminal's echo off instead.
    return { kind: 'vault', action: action as VaultAction, ...(name ? { name } : {}) };
  }

  if (head === 'dashboard') {
    // No sub-verbs: the bare command is what a person types, and the two flags
    // are the two other things they might want.
    if (rest.length === 0) return { kind: 'dashboard', action: 'open' };
    if (rest.length > 1) throw new UsageError(`unexpected argument: ${rest[1]}`);
    const flag = rest[0];
    if (flag === '--token') return { kind: 'dashboard', action: 'token' };
    if (flag === '--off') return { kind: 'dashboard', action: 'off' };
    throw new UsageError(
      `unknown option for buddi dashboard: ${flag} (expected --token or --off)`,
    );
  }

  if (head === 'telegram') {
    const action = rest[0];
    if (action === undefined) {
      throw new UsageError(`buddi telegram needs one of: ${TELEGRAM_ACTIONS.join(', ')}`);
    }
    if (!(TELEGRAM_ACTIONS as readonly string[]).includes(action)) {
      throw new UsageError(
        `unknown telegram action: ${action} (expected ${TELEGRAM_ACTIONS.join(', ')})`,
      );
    }
    if (action === 'unpair') {
      const deviceId = rest[1];
      if (!deviceId) throw new UsageError('buddi telegram unpair needs a device id');
      if (rest.length > 2) throw new UsageError(`unexpected argument: ${rest[2]}`);
      return { kind: 'telegram', action: 'unpair', deviceId };
    }
    if (rest.length > 1) throw new UsageError(`unexpected argument: ${rest[1]}`);
    return { kind: 'telegram', action: action as TelegramAction };
  }

  throw new UsageError(`unknown command: ${head} (run "buddi help")`);
}

/**
 * `buddi jobs` — a listing by default, or one of the two verbs that take an id.
 * Ids may be abbreviated to the prefix the listing prints.
 */
function parseJobs(rest: string[]): Command {
  const [verb, ...args] = rest;

  if (verb === 'retry' && args[0] === '--all') {
    const command: {
      kind: 'jobs';
      action: 'retry-all';
      state?: JobStateName;
      kind_?: string;
      limit?: number;
    } = { kind: 'jobs', action: 'retry-all' };
    for (let i = 1; i < args.length; i += 1) {
      const arg = args[i];
      const value = args[i + 1];
      if (arg !== '--state' && arg !== '--kind' && arg !== '--limit') {
        throw new UsageError(`unknown option for buddi jobs retry --all: ${arg}`);
      }
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      i += 1;
      if (arg === '--state') {
        if (!(JOB_STATE_NAMES as readonly string[]).includes(value)) {
          throw new UsageError(
            `unknown job state: ${value} (expected ${JOB_STATE_NAMES.join(', ')})`,
          );
        }
        command.state = value as JobStateName;
      } else if (arg === '--kind') {
        command.kind_ = value;
      } else {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new UsageError(`--limit needs a positive integer`);
        command.limit = n;
      }
    }
    return command;
  }

  if (verb === 'retry' || verb === 'cancel') {
    const jobId = args[0];
    if (!jobId) throw new UsageError(`buddi jobs ${verb} needs a job id`);
    if (args.length > 1) throw new UsageError(`unexpected argument: ${args[1]}`);
    return { kind: 'jobs', action: verb, jobId };
  }

  const command: { kind: 'jobs'; action: 'list'; state?: JobStateName; kind_?: string; limit?: number } =
    { kind: 'jobs', action: 'list' };
  const argv = verb === undefined ? [] : rest;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--state' || arg === '--kind' || arg === '--limit') {
      const value = argv[i + 1];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      i += 1;
      if (arg === '--state') {
        if (!(JOB_STATE_NAMES as readonly string[]).includes(value)) {
          throw new UsageError(
            `unknown job state: ${value} (expected ${JOB_STATE_NAMES.join(', ')})`,
          );
        }
        command.state = value as JobStateName;
      } else if (arg === '--kind') {
        command.kind_ = value;
      } else {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new UsageError(`--limit needs a positive integer`);
        command.limit = n;
      }
      continue;
    }
    throw new UsageError(`unknown option for buddi jobs: ${arg}`);
  }
  return command;
}

/**
 * `buddi backup <verb> …`.
 *
 * `--keep` and `--prune` take an integer of at least 1: `--keep 0` reads like
 * "delete every backup I have", and a prune that does that on a typo is not a
 * feature. `--prune` alone means the default retention.
 */
function parseBackup(rest: string[]): Command {
  const action = rest[0];
  if (action === undefined) {
    throw new UsageError(`buddi backup needs one of: ${BACKUP_ACTIONS.join(', ')}`);
  }
  if (!(BACKUP_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(`unknown backup action: ${action} (expected ${BACKUP_ACTIONS.join(', ')})`);
  }
  const command: Extract<Command, { kind: 'backup' }> = {
    kind: 'backup',
    action: action as BackupAction,
  };
  const args = rest.slice(1);

  const positive = (raw: string | undefined, flag: string): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      throw new UsageError(`${flag} needs an integer of at least 1 (got ${raw ?? 'nothing'})`);
    }
    return n;
  };

  // `verify` and `restore` take the archive as the one positional argument.
  if (action === 'verify' || action === 'restore') {
    const archive = args[0];
    if (archive === undefined || archive.startsWith('-')) {
      throw new UsageError(`buddi backup ${action} needs the path to an archive`);
    }
    command.archive = archive;
    args.shift();
  }
  if (action === 'schedule') {
    const sub = args[0];
    if (sub !== undefined && !sub.startsWith('-')) {
      if (!(BACKUP_SCHEDULE_ACTIONS as readonly string[]).includes(sub)) {
        throw new UsageError(
          `unknown backup schedule action: ${sub} (expected ${BACKUP_SCHEDULE_ACTIONS.join(', ')})`,
        );
      }
      command.scheduleAction = sub as BackupScheduleAction;
      args.shift();
    } else {
      command.scheduleAction = 'status';
    }
  }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (arg === '--out' && action === 'create') {
      const value = args[i + 1];
      if (value === undefined) throw new UsageError('--out needs a directory');
      command.out = value;
      i += 1;
    } else if (arg === '--no-artifacts' && action === 'create') {
      command.noArtifacts = true;
    } else if (arg === '--prune' && action === 'create') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('-')) command.prune = DEFAULT_KEEP;
      else {
        command.prune = positive(value, '--prune');
        i += 1;
      }
    } else if (arg === '--keep' && (action === 'prune' || action === 'schedule')) {
      command.keep = positive(args[i + 1], '--keep');
      i += 1;
    } else if (arg === '--into' && action === 'restore') {
      const value = args[i + 1];
      if (value === undefined) throw new UsageError('--into needs a database name');
      command.into = value;
      i += 1;
    } else if (arg === '--yes' && action === 'restore') {
      command.yes = true;
    } else if (arg === '--force' && action === 'restore') {
      command.force = true;
    } else {
      throw new UsageError(`unknown option for buddi backup ${action}: ${arg}`);
    }
  }
  return command;
}

export const USAGE = `buddi — your personal agents, one command

  buddi init                 set this machine up (interactive, idempotent)
  buddi init --yes           the same, asking nothing: for scripts and CI
  buddi doctor               check every moving part and say what is wrong
  buddi status               the same report, under the name you reached for

  buddi db up                start the postgres container (after a reboot)
  buddi db down|status
  buddi db secure            give the database a generated password, kept in the vault

  buddi chat                 talk to the default agent
  buddi chat --agent <handle>  ... to a specific agent, by @handle or id
  buddi chat --resume <id> | --last
  buddi ask "<question>"     one turn, then exit
  buddi agents               every agent, its engine and whether it can run
  buddi agents show <handle>   one agent in full: tools, skills, engine, last run
  buddi agents set <handle> [--provider p] [--model m] [--max-turns n]
  buddi agents models        the model catalogue, and what this machine can reach
  buddi agents test <handle> one cheap live turn on that agent's provider
  buddi agents migrate       move agents/ and skills/ into your private directory

  buddi serve                run the Telegram surface + scheduler in this shell
  buddi service install      run it in the background, at login
  buddi service start|stop   load/unload it without touching the plist
  buddi service uninstall|status|logs|restart

  buddi dashboard            open the local dashboard (one-time link)
  buddi dashboard --token    print just the one-time token
  buddi dashboard --off      how to turn the dashboard off

  buddi telegram pair        a QR code + deep link that pairs a device
  buddi telegram devices     every paired device
  buddi telegram unpair <id>

  buddi pause                stop claiming work (running jobs finish)
  buddi resume               start claiming again
  buddi jobs [--state <s>] [--kind <k>] [--limit <n>]
  buddi jobs retry <id> | buddi jobs cancel <id>
  buddi jobs retry --all [--kind <k>]   run every dead job again

  buddi backup create        one archive: database, private agents, artifacts
  buddi backup create --out <dir> --no-artifacts
  buddi backup list          every archive, newest first
  buddi backup verify <archive>   checksums + manifest, no database needed
  buddi backup restore <archive> [--into <db>] [--yes] [--force]
  buddi backup prune [--keep n]   default keep ${DEFAULT_KEEP}
  buddi backup schedule install|uninstall|status   nightly at 03:30, prune included

  buddi vault set <NAME>      keep a secret in the OS keychain (prompts, hidden)
  buddi vault get <NAME>|delete <NAME>|list
  buddi vault import-env      move .env secrets into the keychain

  buddi missions list|add-defaults|add-friday-recap|run-now <id>|enable <id>|disable <id>
  buddi reminders [--agent <id>] [--all]      one-off nudges the agents set
  buddi reminders cancel <id>
  buddi nudges status|stop|resume             the first-run arc and its budget
  buddi plugins list|info <name>            what is installed, and what each one brought
  buddi plugins install <directory> [--yes] read what a plugin contributes, then install it
  buddi plugins uninstall <name> [--yes]    remove it; its database schema is kept
  buddi migrate              apply core + plugin migrations

In chat: /quit to exit, /tools to list tools, /id to print the conversation id.`;
