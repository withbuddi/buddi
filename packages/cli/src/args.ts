/**
 * `buddi` argument parsing — pure, and the only part of the dispatcher worth a
 * unit test.
 *
 * The binary owns the *first* word (and, for the grouped commands, the second);
 * everything after it is handed to the module that already implements it. That
 * is why `chat`, `ask`, `agents` and `missions` keep their own option parsing:
 * this file must not learn `--resume`.
 */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const SERVICE_ACTIONS = ['install', 'uninstall', 'status', 'logs', 'restart'] as const;
export type ServiceAction = (typeof SERVICE_ACTIONS)[number];

export const TELEGRAM_ACTIONS = ['pair', 'devices', 'unpair'] as const;
export type TelegramAction = (typeof TELEGRAM_ACTIONS)[number];

export type Command =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'serve' }
  /** Delegated verbatim to the gateway's chat CLI, command word included. */
  | { kind: 'chat-cli'; argv: string[] }
  /** Delegated verbatim to the gateway's missions CLI. */
  | { kind: 'missions'; argv: string[] }
  | { kind: 'migrate' }
  | { kind: 'init' }
  | { kind: 'doctor' }
  | { kind: 'service'; action: ServiceAction }
  | { kind: 'telegram'; action: TelegramAction; deviceId?: string };

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
  if (head === 'migrate') return { kind: 'migrate' };
  if (head === 'init') return { kind: 'init' };
  if (head === 'doctor') return { kind: 'doctor' };

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

export const USAGE = `buddi — your personal agents, one command

  buddi init                 set this machine up (interactive, idempotent)
  buddi doctor               check every moving part and say what is wrong

  buddi chat                 talk to the default agent
  buddi chat --agent <handle>  ... to a specific agent, by @handle or id
  buddi chat --resume <id> | --last
  buddi ask "<question>"     one turn, then exit
  buddi agents               every agent installed under agents/

  buddi serve                run the Telegram surface + scheduler in this shell
  buddi service install      run it in the background, at login
  buddi service uninstall|status|logs|restart

  buddi telegram pair        a QR code + deep link that pairs a device
  buddi telegram devices     every paired device
  buddi telegram unpair <id>

  buddi missions list|add-friday-recap|run-now <id>|enable <id>|disable <id>
  buddi migrate              apply core + plugin migrations

In chat: /quit to exit, /tools to list tools, /id to print the conversation id.`;
