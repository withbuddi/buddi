/**
 * `buddi` argument parsing — pure, and the only part of the dispatcher worth a
 * unit test.
 *
 * The binary owns the *first* word (and, for the grouped commands, the second);
 * everything after it is handed to the module that already implements it. That
 * is why `chat`, `ask`, `agents` and `missions` keep their own option parsing:
 * this file must not learn `--resume`.
 */

import { DEFAULT_KEEP } from '@buddi/core';

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

/**
 * `buddi dashboard` — open it, print just the ticket, explain the off switch,
 * install/remove the double-clickable app that runs `open` for you, or — for a
 * forgotten lock-screen PIN — open it unlocked once, or remove the PIN.
 */
export const DASHBOARD_ACTIONS = ['open', 'token', 'off', 'install-app', 'uninstall-app', 'unlock', 'remove-pin'] as const;
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
  /** `buddi help [command…]`; `topic` is the words after it. */
  | { kind: 'help'; topic?: string[] }
  | { kind: 'version' }
  /** One screen of how this installation is. */
  | { kind: 'status' }
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
  /**
   * `--no-backup`: skip the archive this command otherwise takes before it
   * migrates. There is no `--yes`: the command asks nothing in the first place.
   */
  | { kind: 'upgrade'; backup: boolean }
  /** `buddi uninstall`: `--yes` skips the question, `--keep-data` keeps the data and its secrets. */
  | { kind: 'uninstall'; yes: boolean; keepData: boolean; backup: boolean }
  | { kind: 'service'; action: ServiceAction }
  | { kind: 'db'; action: DbAction }
  | { kind: 'telegram'; action: TelegramAction; deviceId?: string }
  /** The local dashboard over the event log. */
  | { kind: 'dashboard'; action: DashboardAction }
  /** The agents' own browser: `status` says which one is here, `install` downloads Chromium. */
  | { kind: 'browser'; action: 'install' | 'status' }
  /** The local speech models: `install` fetches Whisper, Kokoro or both through the speech plugin; bare says which are here. */
  | { kind: 'speech'; action: 'install' | 'status'; model?: 'whisper' | 'kokoro' }
  /** buddi as an MCP server over stdio, for Claude Code or any MCP client. */
  | { kind: 'mcp' }
  /** Settings → Connections from the terminal, through the running gateway. */
  | { kind: 'connections'; command: ConnectionsCommand }
  /** Secrets in the OS keychain; the name is optional only for `list`. */
  | { kind: 'vault'; action: VaultAction; name?: string }
  /** Global pause control (docs/architecture.md, "Queue, concurrency, recovery"). */
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
      /** `create --encrypt` — write the `.age` form with the vault passphrase. */
      encrypt?: boolean;
      /** `verify|restore --passphrase "<six words>"` for a `.age` archive. */
      passphrase?: string;
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
      /** `restore --files` — restore agents, skills and artifacts too. */
      files?: boolean;
      scheduleAction?: BackupScheduleAction;
    };

export const CONNECTIONS_ACTIONS = ['list', 'add', 'review', 'give', 'remove'] as const;
export type ConnectionsAction = (typeof CONNECTIONS_ACTIONS)[number];

/**
 * `buddi connections …` (docs/connections.md, "From the terminal"). `--json`
 * on `list` and `review` is the output switch and `main` has taken it off by
 * now; on `add` it is the pasted `mcpServers` block, a value.
 */
export type ConnectionsCommand =
  | { action: 'list' }
  | {
      action: 'add';
      /** A card id or an https:// address; absent when `config` gives it. */
      address?: string;
      /** `--json '<mcpServers json>'`. */
      config?: string;
      name?: string;
      /** `--token`: read one with the terminal's echo off. */
      token: boolean;
      /** `--token-stdin`: read one from a pipe. */
      tokenStdin: boolean;
      clientId?: string;
      keep: boolean;
      slug?: string;
      /** `--to`: agent ids or handles; `[]` is `--to nobody`. */
      to?: string[];
      /**
       * `add <name> [--env K=V]... [--secret K]... -- <command> <args…>`: a
       * program on this computer. `address` is then its name. A secret's
       * value is asked for (or read from stdin), never taken from argv.
       */
      program?: { command: string; args: string[]; env: Array<{ name: string; value: string }>; secrets: string[] };
    }
  | { action: 'review'; name: string; keep: boolean; slug?: string }
  | { action: 'give'; name: string; to: string[] }
  | { action: 'remove'; name: string; yes: boolean };

/** `--to a,b` or `--to nobody`. */
function agentList(value: string): string[] {
  const list = value.split(',').map((w) => w.trim()).filter(Boolean);
  if (list.length === 0) throw new UsageError('--to needs agents, comma-separated, or nobody');
  return list.length === 1 && list[0]!.toLowerCase() === 'nobody' ? [] : list;
}

export function parseConnectionsArgs(argv: string[]): ConnectionsCommand {
  const [first, ...all] = argv;
  // `add <name> … -- <command> <args…>`: everything after `--` is the program's, flags included.
  const cut = all.indexOf('--');
  const rest = cut >= 0 ? all.slice(0, cut) : all;
  const programWords = cut >= 0 ? all.slice(cut + 1) : undefined;
  const envPairs: Array<{ name: string; value: string }> = [];
  const secretNames: string[] = [];
  const action = first ?? 'list';
  if (!(CONNECTIONS_ACTIONS as readonly string[]).includes(action)) {
    throw new UsageError(`unknown connections action: ${action} (expected ${CONNECTIONS_ACTIONS.join(', ')})`);
  }
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const valued = new Set(['--name', '--client-id', '--json', '--slug', '--to', '--env', '--secret']);
  const allowed: Record<ConnectionsAction, string[]> = {
    list: [],
    add: ['--name', '--token', '--token-stdin', '--client-id', '--json', '--keep', '--slug', '--to', '--env', '--secret'],
    review: ['--keep', '--slug'],
    give: ['--to'],
    remove: ['--yes', '-y'],
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (!allowed[action as ConnectionsAction].includes(flag)) {
      const known = allowed[action as ConnectionsAction];
      throw new UsageError(`unknown option for buddi connections ${action}: ${flag}${known.length ? ` (expected ${known.filter((f) => f !== '-y').join(', ')})` : ''}`);
    }
    if (valued.has(flag)) {
      const value = inline ?? rest[++i];
      if (value === undefined || value === '') throw new UsageError(`${flag} needs a value`);
      if (flag === '--env') {
        const at = value.indexOf('=');
        const name = at > 0 ? value.slice(0, at) : '';
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new UsageError('--env takes NAME=value');
        envPairs.push({ name, value: value.slice(at + 1) });
      } else if (flag === '--secret') {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new UsageError('--secret takes a variable name; its value is asked for, or read from stdin');
        secretNames.push(value);
      }
      flags.set(flag, value);
    } else {
      flags.set(flag, true);
    }
  }
  const text = (flag: string): string | undefined => { const v = flags.get(flag); return typeof v === 'string' ? v : undefined; };
  const one = (what: string): string => {
    if (positional.length === 0) throw new UsageError(`buddi connections ${action} needs ${what}`);
    if (positional.length > 1) throw new UsageError(`unexpected argument: ${positional[1]}`);
    return positional[0]!;
  };
  switch (action as ConnectionsAction) {
    case 'list':
      if (positional.length > 0) throw new UsageError(`unexpected argument: ${positional[0]}`);
      return { action: 'list' };
    case 'add': {
      if (programWords !== undefined || envPairs.length > 0 || secretNames.length > 0) {
        if (programWords === undefined || programWords.length === 0) throw new UsageError('a program is given after --: buddi connections add <name> -- <command> <args…>');
        if (positional.length !== 1) throw new UsageError('buddi connections add <name> -- <command> <args…> needs one name before --');
        const clash = ['--json', '--token', '--token-stdin', '--client-id'].filter((f) => flags.has(f));
        if (clash.length > 0) throw new UsageError(`${clash.join(', ')} is for a server at an address, not a program`);
        const both = secretNames.filter((n) => envPairs.some((e) => e.name === n));
        if (both.length > 0) throw new UsageError(`${both.join(', ')} is given with --env and --secret; a secret's value is asked for, never written on the line`);
        const to = text('--to');
        return {
          action: 'add',
          address: positional[0]!,
          program: { command: programWords[0]!, args: programWords.slice(1), env: envPairs, secrets: secretNames },
          ...(text('--name') ? { name: text('--name')! } : {}),
          token: false,
          tokenStdin: false,
          keep: flags.has('--keep'),
          ...(text('--slug') ? { slug: text('--slug')! } : {}),
          ...(to !== undefined ? { to: agentList(to) } : {}),
        };
      }
      const config = text('--json');
      if (positional.length > 1) throw new UsageError(`unexpected argument: ${positional[1]}`);
      const address = positional[0];
      if (address === undefined && config === undefined) throw new UsageError('buddi connections add needs a card (github, notion…) or an https:// address, or --json \'<mcpServers json>\'');
      if (address !== undefined && config !== undefined) throw new UsageError('give either an address or --json, not both');
      const ways = ['--token', '--token-stdin', '--client-id'].filter((f) => flags.has(f));
      if (ways.length > 1) throw new UsageError(`choose one way to sign in: ${ways.join(' or ')}`);
      const to = text('--to');
      return {
        action: 'add',
        ...(address !== undefined ? { address } : {}),
        ...(config !== undefined ? { config } : {}),
        ...(text('--name') ? { name: text('--name')! } : {}),
        token: flags.has('--token'),
        tokenStdin: flags.has('--token-stdin'),
        ...(text('--client-id') ? { clientId: text('--client-id')! } : {}),
        keep: flags.has('--keep'),
        ...(text('--slug') ? { slug: text('--slug')! } : {}),
        ...(to !== undefined ? { to: agentList(to) } : {}),
      };
    }
    case 'review':
      return { action: 'review', name: one('a connection\'s name'), keep: flags.has('--keep'), ...(text('--slug') ? { slug: text('--slug')! } : {}) };
    case 'give': {
      const name = one('a connection\'s name');
      const to = text('--to');
      if (to === undefined) throw new UsageError('buddi connections give needs --to <agent,agent> (or --to nobody)');
      return { action: 'give', name, to: agentList(to) };
    }
    case 'remove':
      return { action: 'remove', name: one('a connection\'s name'), yes: flags.has('--yes') || flags.has('-y') };
  }
}

/** Commands the gateway's chat CLI owns; it re-parses the whole slice. */
const CHAT_COMMANDS = new Set(['chat', 'ask', 'agents']);

export function parseArgs(argv: string[]): Command {
  const [head, ...rest] = argv;

  // The bare command opens the dashboard, in a checkout as in a packaged
  // install (where the launcher answers it before this parser runs).
  if (head === undefined) return { kind: 'dashboard', action: 'open' };
  if (head === 'help' || head === '--help' || head === '-h') {
    const topic = rest.filter((word) => !word.startsWith('-'));
    return topic.length > 0 ? { kind: 'help', topic } : { kind: 'help' };
  }
  if (head === '--version' || head === '-v' || head === 'version') {
    if (rest.length > 0) throw new UsageError(`buddi version takes no arguments (got ${rest[0]})`);
    return { kind: 'version' };
  }

  if (CHAT_COMMANDS.has(head)) return { kind: 'chat-cli', argv };
  if (head === 'serve') {
    if (rest.length > 0) throw new UsageError(`buddi serve takes no arguments (got ${rest[0]})`);
    return { kind: 'serve' };
  }
  if (head === 'missions') return { kind: 'missions', argv: rest };
  if (head === 'plugins') return { kind: 'plugins', argv: rest };
  if (head === 'reminders') return { kind: 'reminders', argv: rest };
  if (head === 'nudges') return { kind: 'nudges', argv: rest };
  if (head === 'migrate') {
    if (rest.length > 0) throw new UsageError(`buddi migrate takes no arguments (got ${rest[0]})`);
    return { kind: 'migrate' };
  }
  if (head === 'init') {
    let yes = false;
    for (const arg of rest) {
      if (arg === '--yes' || arg === '-y') yes = true;
      else throw new UsageError(`unknown option for buddi init: ${arg} (expected --yes)`);
    }
    return { kind: 'init', yes };
  }
  if (head === 'status') {
    if (rest.length > 0) throw new UsageError(`buddi status takes no arguments (got ${rest[0]})`);
    return { kind: 'status' };
  }
  if (head === 'doctor') {
    if (rest.length > 0) throw new UsageError(`buddi doctor takes no arguments (got ${rest[0]})`);
    return { kind: 'doctor' };
  }

  if (head === 'upgrade') {
    let backup = true;
    for (const arg of rest) {
      if (arg === '--no-backup') backup = false;
      else throw new UsageError(`unknown option for buddi upgrade: ${arg} (expected --no-backup)`);
    }
    return { kind: 'upgrade', backup };
  }

  if (head === 'uninstall') {
    const command: Extract<Command, { kind: 'uninstall' }> = { kind: 'uninstall', yes: false, keepData: false, backup: true };
    for (const arg of rest) {
      if (arg === '--yes' || arg === '-y') command.yes = true;
      else if (arg === '--keep-data') command.keepData = true;
      else if (arg === '--no-backup') command.backup = false;
      else throw new UsageError(`unknown option for buddi uninstall: ${arg} (expected --yes, --keep-data or --no-backup)`);
    }
    return command;
  }

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

  if (head === 'connections') return { kind: 'connections', command: parseConnectionsArgs(rest) };

  if (head === 'mcp') {
    if (rest.length > 0) throw new UsageError(`unexpected argument: ${rest[0]}`);
    return { kind: 'mcp' };
  }

  if (head === 'dashboard') {
    // No sub-verbs: the bare command is what a person types, and the two flags
    // are the two other things they might want.
    if (rest.length === 0) return { kind: 'dashboard', action: 'open' };
    if (rest.length > 1) throw new UsageError(`unexpected argument: ${rest[1]}`);
    const flag = rest[0];
    if (flag === '--token') return { kind: 'dashboard', action: 'token' };
    if (flag === '--off') return { kind: 'dashboard', action: 'off' };
    if (flag === '--install-app') return { kind: 'dashboard', action: 'install-app' };
    if (flag === '--uninstall-app') return { kind: 'dashboard', action: 'uninstall-app' };
    if (flag === '--unlock') return { kind: 'dashboard', action: 'unlock' };
    if (flag === '--remove-pin') return { kind: 'dashboard', action: 'remove-pin' };
    throw new UsageError(
      `unknown option for buddi dashboard: ${flag} ` +
        '(expected --token, --off, --install-app, --uninstall-app, --unlock or --remove-pin)',
    );
  }

  if (head === 'browser') {
    const action = rest[0] ?? 'status';
    if (action !== 'install' && action !== 'status') {
      throw new UsageError(`unknown browser action: ${action} (expected install or status)`);
    }
    if (rest.length > 1) throw new UsageError(`unexpected argument: ${rest[1]}`);
    return { kind: 'browser', action };
  }

  if (head === 'speech') {
    const action = rest[0] ?? 'status';
    if (action !== 'install' && action !== 'status') {
      throw new UsageError(`unknown speech action: ${action} (expected install or status)`);
    }
    const model = rest[1];
    if (action === 'status' && model !== undefined) throw new UsageError(`unexpected argument: ${model}`);
    if (model !== undefined && model !== 'whisper' && model !== 'kokoro') {
      throw new UsageError(`unknown speech model: ${model} (expected whisper or kokoro)`);
    }
    if (rest.length > 2) throw new UsageError(`unexpected argument: ${rest[2]}`);
    return { kind: 'speech', action, ...(model ? { model } : {}) };
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

  throw new UsageError(`buddi ${head} is not a command.`);
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
    } else if (arg === '--encrypt' && action === 'create') {
      command.encrypt = true;
    } else if (arg === '--passphrase' && (action === 'verify' || action === 'restore')) {
      const value = args[i + 1];
      // Six words with spaces in them: the shell has to be told they are one
      // argument, and a missing quote is the mistake worth naming here.
      if (value === undefined || value.startsWith('-')) {
        throw new UsageError('--passphrase needs the words, quoted: --passphrase "able acid …"');
      }
      command.passphrase = value;
      i += 1;
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
    } else if (arg === '--files' && action === 'restore') {
      command.files = true;
    } else {
      throw new UsageError(`unknown option for buddi backup ${action}: ${arg}`);
    }
  }
  return command;
}
