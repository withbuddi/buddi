/**
 * Every `buddi` command, in one table.
 *
 * `buddi help`, `buddi help <command>`, `buddi <command> --help` and the
 * reference page (`docs/cli.md`, rendered by `scripts/docs/cli.mjs`) are all
 * drawn from this array, and a test walks it against the parser, so the words
 * an owner reads cannot drift from the words the binary accepts.
 *
 * The same tree answers in a source checkout and in a packaged install. What
 * does not apply where it runs is left out of the help and, when typed anyway,
 * answers with `elsewhere`: one sentence saying what to do instead.
 *
 * Pure data and pure functions: nothing here imports the gateway, so the
 * reference script can load it without an installation behind it.
 */

export const GROUPS = ['Everyday', 'Agents', 'Reach', 'Operate', 'Develop'] as const;
export type Group = (typeof GROUPS)[number];

/** Where a command means something. */
export type Applies = 'both' | 'checkout' | 'packaged';

/** What this `buddi` is running from. */
export type InstallKind = 'checkout' | 'packaged';

export interface CommandFlag {
  flag: string;
  meaning: string;
}

export interface CommandEntry {
  /** The words after `buddi`: `backup create`. The bare command is `''`. */
  name: string;
  group: Group;
  /** One sentence, ending with a period. */
  summary: string;
  /** The full form, starting with `buddi`. */
  usage: string;
  flags: CommandFlag[];
  example?: string;
  /** Codes beyond 0, 1 and 2, or a sharper meaning for one of them. */
  exitCodes?: Array<{ code: number; meaning: string }>;
  applies: Applies;
  /** Present when `--json` works: the fields it prints. */
  json?: string;
  /** What a hidden command answers where it does not apply. */
  elsewhere?: string;
}

const JSON_FLAG: CommandFlag = { flag: '--json', meaning: 'Print JSON instead of text. BUDDI_JSON=1 does the same.' };

const NEEDS_DATABASE = { code: 3, meaning: 'The database is not reachable, or not configured.' };

const CHECKOUT_ONLY = (what: string, instead: string): string =>
  `buddi ${what} is for a source checkout. ${instead}`;

export const COMMANDS: readonly CommandEntry[] = [
  /* ---------------------------------------------------------------- Everyday */
  {
    name: '',
    group: 'Everyday',
    summary: 'Open the dashboard. In a packaged install the first run sets everything up.',
    usage: 'buddi',
    flags: [],
    example: 'buddi',
    applies: 'both',
  },
  {
    name: 'status',
    group: 'Everyday',
    summary: 'One screen: version, service, database, agents, what needs you, and whether a newer buddi is out.',
    usage: 'buddi status [--json]',
    flags: [JSON_FLAG],
    example: 'buddi status',
    exitCodes: [{ code: 3, meaning: 'The database is not reachable. The rest of the report is still printed.' }],
    applies: 'both',
    json:
      '{ version, install, service: { state, detail }, database: { reachable, error? }, ' +
      'agents: { ready: [{ handle, id }], unavailable: [{ handle, id, reason }] }, ' +
      'needsYou: { approvals, questions } | null, lastRecapAt | null, ' +
      'update: { available, latest? } }. service.state is running, stopped, not-installed or unknown.',
  },
  {
    name: 'ask',
    group: 'Everyday',
    summary: 'Ask one question, print the answer, and exit. Made for scripts.',
    usage: 'buddi ask "<question>" [--agent <handle>] [--resume <id> | --last] [--file <path>] [--wait <seconds>] [--json]',
    flags: [
      { flag: '--agent <handle>', meaning: 'Ask this agent, by handle or id, instead of the default one.' },
      { flag: '--resume <id>', meaning: 'Continue that conversation. With no question, it finishes a run that stopped for an approval you have since given.' },
      { flag: '--last', meaning: 'Continue the most recent conversation with that agent.' },
      { flag: '--file <path>', meaning: 'Attach a file. It is kept in the library like a file dropped on the dashboard.' },
      { flag: '--wait <seconds>', meaning: 'When the run stops for an approval, wait this long for you to give it elsewhere, then finish.' },
      JSON_FLAG,
    ],
    example: 'buddi ask "what did I spend on food last month?" --agent ledger',
    exitCodes: [
      { code: 3, meaning: 'The run stopped for an approval, the agent does not exist or cannot run, or the database is not reachable.' },
    ],
    applies: 'both',
    json:
      '{ text, runId, conversationId, artifacts: [{ id, filename }] }, plus pendingActionId when the run stopped for an approval. ' +
      'With no question as an argument and stdin not a terminal, stdin is the question.',
  },
  {
    name: 'chat',
    group: 'Everyday',
    summary: 'Talk with an agent in the terminal. /help inside lists what you can type.',
    usage: 'buddi chat [--agent <handle>] [--resume <id> | --last] [--quiet]',
    flags: [
      { flag: '--agent <handle>', meaning: 'Talk to this agent, by handle or id.' },
      { flag: '--resume <id>', meaning: 'Continue that conversation.' },
      { flag: '--last', meaning: 'Continue the most recent conversation with that agent.' },
      { flag: '--quiet', meaning: 'No footer after each answer.' },
    ],
    example: 'buddi chat --agent ledger --last',
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
  },
  {
    name: 'dashboard',
    group: 'Everyday',
    summary: 'Open the dashboard with a sign-in link that is good for five minutes.',
    usage: 'buddi dashboard [--token | --off | --install-app | --uninstall-app]',
    flags: [
      { flag: '--token', meaning: 'Print only the five-minute ticket.' },
      { flag: '--off', meaning: 'Say how to turn the dashboard off.' },
      { flag: '--install-app', meaning: 'Put a double-clickable Buddi Dashboard in ~/Applications.' },
      { flag: '--uninstall-app', meaning: 'Remove it.' },
    ],
    example: 'buddi dashboard --token',
    applies: 'both',
  },

  /* ------------------------------------------------------------------ Agents */
  {
    name: 'agents',
    group: 'Agents',
    summary: 'List every agent, its engine, and whether it can run.',
    usage: 'buddi agents [list] [--json]',
    flags: [JSON_FLAG],
    example: 'buddi agents',
    applies: 'both',
    json: '[{ handle, id, isDefault, provider, model, credential, available, unavailableReason?, roles, source }]',
  },
  {
    name: 'agents show',
    group: 'Agents',
    summary: 'Show one agent in full: engine, tools, skills and its last run.',
    usage: 'buddi agents show <handle> [--json]',
    flags: [JSON_FLAG],
    example: 'buddi agents show ledger',
    exitCodes: [{ code: 3, meaning: 'No agent has that handle or id.' }],
    applies: 'both',
    json:
      '{ handle, id, name, description, isDefault, source, file, provider, model, accountId?, ' +
      'credential: { kind, env }, available, unavailableReason?, maxTurns, language, roles, tools, ' +
      'skills: [{ name, provenance }], capabilities, lastRun: { at, provider, model, servedModel?, turns, stopped, input, output } | null }',
  },
  {
    name: 'agents set',
    group: 'Agents',
    summary: "Change an agent's account, model, turn budget or language.",
    usage: 'buddi agents set <handle> [--account <id>] [--model <id>] [--max-turns <n>] [--language mirror|en|fr]',
    flags: [
      { flag: '--account <id>', meaning: 'Run it on this provider account, from the dashboard\'s Providers page.' },
      { flag: '--provider anthropic|openai', meaning: 'Where its conversations go, on an agent without an account.' },
      { flag: '--model <id>', meaning: "Checked against that provider's models." },
      { flag: '--max-turns <n>', meaning: 'How many steps one run may take.' },
      { flag: '--language mirror|en|fr', meaning: 'Which language it answers in.' },
    ],
    example: 'buddi agents set ledger --max-turns 20',
    exitCodes: [{ code: 3, meaning: 'No agent has that handle or id.' }],
    applies: 'both',
  },
  {
    name: 'agents models',
    group: 'Agents',
    summary: 'List the models this build knows, and which of them this machine can reach.',
    usage: 'buddi agents models [--provider anthropic|openai] [--json]',
    flags: [{ flag: '--provider anthropic|openai', meaning: 'Only that provider.' }, JSON_FLAG],
    example: 'buddi agents models --provider anthropic',
    applies: 'both',
    json: '[{ kind, credentialEnv, credentialKind, usable, problem?, defaultModel, defaultFrom, defaultEnv, prefixes, models: [{ id, note }] }]',
  },
  {
    name: 'agents test',
    group: 'Agents',
    summary: "Run one cheap live turn on an agent's provider, to prove it answers.",
    usage: 'buddi agents test <handle> [--prompt "<text>"]',
    flags: [{ flag: '--prompt "<text>"', meaning: 'Ask this instead of the one-word default.' }],
    example: 'buddi agents test ledger',
    exitCodes: [{ code: 3, meaning: 'No agent has that handle or id.' }],
    applies: 'both',
  },
  {
    name: 'agents migrate',
    group: 'Agents',
    summary: 'Move agents/ and skills/ out of the checkout and into your private directory.',
    usage: 'buddi agents migrate [--dry-run]',
    flags: [{ flag: '--dry-run', meaning: 'Say what would move, and move nothing.' }],
    example: 'buddi agents migrate --dry-run',
    applies: 'checkout',
    elsewhere: CHECKOUT_ONLY('agents migrate', 'A packaged install keeps its agents in its data directory already.'),
  },
  {
    name: 'missions list',
    group: 'Agents',
    summary: 'List every scheduled mission, its schedule, its next run and its last one.',
    usage: 'buddi missions list [--json]',
    flags: [JSON_FLAG],
    example: 'buddi missions list',
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
    json:
      '[{ id, name, agentId, enabled, alwaysDeliver, proposedBy, schedule: { cron, timezone, revision, misfirePolicy } | null, ' +
      'nextRunAt | null, lastOccurrence: { scheduledAt, state, error } | null, lastNotification: { kind, at, reason?, chars? } | null }]',
  },
  {
    name: 'missions add-defaults',
    group: 'Agents',
    summary: 'Register every mission the installed plugins suggest.',
    usage: 'buddi missions add-defaults',
    flags: [],
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
  },
  {
    name: 'missions add-recap',
    group: 'Agents',
    summary: 'Register the recap mission, or refresh it.',
    usage: 'buddi missions add-recap',
    flags: [],
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
  },
  {
    name: 'missions add-friday-recap',
    group: 'Agents',
    summary: 'The same as buddi missions add-recap, under its older name.',
    usage: 'buddi missions add-friday-recap',
    flags: [],
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
  },
  {
    name: 'missions run-now',
    group: 'Agents',
    summary: 'Queue a run of a mission for now, or run it here with --inline.',
    usage: 'buddi missions run-now <id> [--inline]',
    flags: [{ flag: '--inline', meaning: 'Run it in this terminal and print what it would deliver.' }],
    example: 'buddi missions run-now recap --inline',
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
  },
  {
    name: 'missions enable',
    group: 'Agents',
    summary: 'Turn a mission back on.',
    usage: 'buddi missions enable <id>',
    flags: [],
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
  },
  {
    name: 'missions disable',
    group: 'Agents',
    summary: 'Turn a mission off. Its schedule is kept.',
    usage: 'buddi missions disable <id>',
    flags: [],
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
  },
  {
    name: 'reminders',
    group: 'Agents',
    summary: 'List the one-off reminders the agents have set, soonest first.',
    usage: 'buddi reminders [--agent <id>] [--all] [--json]',
    flags: [
      { flag: '--agent <id>', meaning: "Only that agent's." },
      { flag: '--all', meaning: 'Include the ones that fired, were cancelled or expired.' },
      JSON_FLAG,
    ],
    example: 'buddi reminders --all',
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
    json: '[{ id, state, dueAt, agentId, text, cancelReason? }]',
  },
  {
    name: 'reminders cancel',
    group: 'Agents',
    summary: 'Cancel a pending reminder.',
    usage: 'buddi reminders cancel <id>',
    flags: [],
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
  },
  {
    name: 'nudges',
    group: 'Agents',
    summary: 'Say what the first-run arc has sent, and whether it is still running.',
    usage: 'buddi nudges [status]',
    flags: [],
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
  },
  {
    name: 'nudges stop',
    group: 'Agents',
    summary: 'Stop the first-run arc until you ask for it back.',
    usage: 'buddi nudges stop',
    flags: [],
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
  },
  {
    name: 'nudges resume',
    group: 'Agents',
    summary: 'Start the first-run arc again.',
    usage: 'buddi nudges resume',
    flags: [],
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
  },
  {
    name: 'plugins list',
    group: 'Agents',
    summary: 'List what is installed, its version, and whether it is healthy.',
    usage: 'buddi plugins list [--json]',
    flags: [JSON_FLAG],
    example: 'buddi plugins list',
    applies: 'both',
    json: '[{ name, version, origin, health, detail }]. origin is built-in or installed; health is ok, warn or fail.',
  },
  {
    name: 'plugins info',
    group: 'Agents',
    summary: 'Show what a plugin is, what it brought, and what it proposes.',
    usage: 'buddi plugins info <name>',
    flags: [],
    applies: 'both',
  },
  {
    name: 'plugins install',
    group: 'Agents',
    summary: 'Stage a plugin and read what it claims, then approve it with --yes.',
    usage: 'buddi plugins install <spec> [--yes --integrity <hash>] [--registry <url>]',
    flags: [
      { flag: '--yes', meaning: 'Approve it: import it, plan it, install it.' },
      { flag: '--integrity <hash>', meaning: 'The hash the staged card printed. A package from npm or a .tgz is never approved without it.' },
      { flag: '--registry <url>', meaning: 'Fetch from this npm registry.' },
    ],
    example: 'buddi plugins install @you/buddi-plugin-finance',
    exitCodes: [{ code: 3, meaning: 'Staged, not installed: approve it with --yes --integrity <hash>.' }],
    applies: 'both',
  },
  {
    name: 'plugins update',
    group: 'Agents',
    summary: 'Stage the next version of a plugin; --yes --integrity approves it.',
    usage: 'buddi plugins update <name> [--version <v>] [--yes --integrity <hash>]',
    flags: [
      { flag: '--version <v>', meaning: 'This version instead of the newest.' },
      { flag: '--yes', meaning: 'Approve it.' },
      { flag: '--integrity <hash>', meaning: 'The hash the staged card printed.' },
    ],
    applies: 'both',
  },
  {
    name: 'plugins staged',
    group: 'Agents',
    summary: 'List what is staged and waiting for you.',
    usage: 'buddi plugins staged',
    flags: [],
    applies: 'both',
  },
  {
    name: 'plugins approve',
    group: 'Agents',
    summary: 'Approve a staged plugin by its staging id.',
    usage: 'buddi plugins approve <id> [--integrity <hash>] [--acknowledge-drift]',
    flags: [
      { flag: '--integrity <hash>', meaning: 'The hash the staged card printed.' },
      { flag: '--acknowledge-drift', meaning: 'Approve it although what is on disk changed since it was staged.' },
    ],
    applies: 'both',
  },
  {
    name: 'plugins reject',
    group: 'Agents',
    summary: 'Delete a stage and everything it fetched.',
    usage: 'buddi plugins reject <id>',
    flags: [],
    applies: 'both',
  },
  {
    name: 'plugins uninstall',
    group: 'Agents',
    summary: 'Say what removing a plugin would do; --yes removes it and keeps its data.',
    usage: 'buddi plugins uninstall <name> [--yes] [--detach-agents] [--purge --confirm <name>]',
    flags: [
      { flag: '--yes', meaning: 'Remove it. Its database schema is kept.' },
      { flag: '--detach-agents', meaning: 'Also take its tools out of the agents that were given them.' },
      { flag: '--purge --confirm <name>', meaning: 'Also drop its schema and everything in it. This cannot be undone.' },
    ],
    applies: 'both',
  },
  {
    name: 'plugins init',
    group: 'Agents',
    summary: 'Write a new plugin you can build and install.',
    usage: 'buddi plugins init <name> [--dir <path>]',
    flags: [{ flag: '--dir <path>', meaning: 'Write it here instead of ./<name>.' }],
    example: 'buddi plugins init weather',
    applies: 'both',
  },
  {
    name: 'plugins dev',
    group: 'Agents',
    summary: "Watch a plugin's dist/ and restart buddi when it changes.",
    usage: 'buddi plugins dev <dir>',
    flags: [],
    example: 'buddi plugins dev ./weather',
    applies: 'both',
  },

  /* ------------------------------------------------------------------- Reach */
  {
    name: 'telegram pair',
    group: 'Reach',
    summary: 'Show a QR code and a link that pair a phone with your agents.',
    usage: 'buddi telegram pair',
    flags: [],
    exitCodes: [{ code: 3, meaning: 'The database is not reachable, or no Telegram bot is configured.' }],
    applies: 'both',
  },
  {
    name: 'telegram devices',
    group: 'Reach',
    summary: 'List every paired device.',
    usage: 'buddi telegram devices [--json]',
    flags: [JSON_FLAG],
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
    json: '[{ id, surface, label, externalUserId, externalChatId, pairedAt, lastSeenAt }]',
  },
  {
    name: 'telegram unpair',
    group: 'Reach',
    summary: 'Unpair a device, so it can no longer reach your agents.',
    usage: 'buddi telegram unpair <id>',
    flags: [],
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
  },
  {
    name: 'mcp',
    group: 'Reach',
    summary: 'Run buddi as an MCP server over stdio, for Claude Code or any MCP client.',
    usage: 'buddi mcp',
    flags: [],
    example: 'claude mcp add buddi -- buddi mcp',
    applies: 'both',
  },

  /* ----------------------------------------------------------------- Operate */
  {
    name: 'doctor',
    group: 'Operate',
    summary: 'Check every moving part and say what is wrong.',
    usage: 'buddi doctor',
    flags: [],
    example: 'buddi doctor',
    applies: 'both',
  },
  {
    name: 'upgrade',
    group: 'Operate',
    summary: 'Back up, move to the new version, migrate, and restart.',
    usage: 'buddi upgrade [--no-backup]',
    flags: [{ flag: '--no-backup', meaning: 'In a source checkout, skip the archive it takes first. A packaged upgrade always takes one.' }],
    example: 'buddi upgrade',
    applies: 'both',
  },
  {
    name: 'version',
    group: 'Operate',
    summary: 'Print the version, with the commit in a source checkout.',
    usage: 'buddi version',
    flags: [],
    applies: 'both',
  },
  {
    name: 'service status',
    group: 'Operate',
    summary: 'Say whether the background service is running.',
    usage: 'buddi service status [--json]',
    flags: [JSON_FLAG],
    exitCodes: [{ code: 1, meaning: 'It is not running.' }],
    applies: 'both',
    json:
      "The service's state. Packaged: { phase, supervisorPid, installRoot, nodePath, database, databasePid, gateway, gatewayPid, current?, upgrading? }. " +
      'Source checkout: { installed, running, pid?, unitPath, detail }.',
  },
  {
    name: 'service start',
    group: 'Operate',
    summary: 'Start the background service.',
    usage: 'buddi service start [--json]',
    flags: [JSON_FLAG],
    applies: 'both',
    json:
      "The service's state. Packaged: { phase, supervisorPid, installRoot, nodePath, database, databasePid, gateway, gatewayPid, current?, upgrading? }. " +
      'Source checkout: { installed, running, pid?, unitPath, detail }.',
  },
  {
    name: 'service stop',
    group: 'Operate',
    summary: 'Stop the background service. Running work finishes first.',
    usage: 'buddi service stop [--json]',
    flags: [JSON_FLAG],
    applies: 'both',
    json:
      "The service's state. Packaged: { phase, supervisorPid, installRoot, nodePath, database, databasePid, gateway, gatewayPid, current?, upgrading? }. " +
      'Source checkout: { installed, running, pid?, unitPath, detail }.',
  },
  {
    name: 'service restart',
    group: 'Operate',
    summary: 'Restart the background service, to load a change.',
    usage: 'buddi service restart [--json]',
    flags: [JSON_FLAG],
    applies: 'both',
    json:
      "The service's state. Packaged: { phase, supervisorPid, installRoot, nodePath, database, databasePid, gateway, gatewayPid, current?, upgrading? }. " +
      'Source checkout: { installed, running, pid?, unitPath, detail }.',
  },
  {
    name: 'service logs',
    group: 'Operate',
    summary: "Follow the service's log. Ctrl-C stops following.",
    usage: 'buddi service logs',
    flags: [],
    applies: 'both',
  },
  {
    name: 'service install',
    group: 'Operate',
    summary: 'Install the background service, started at login.',
    usage: 'buddi service install',
    flags: [],
    applies: 'checkout',
    elsewhere: CHECKOUT_ONLY('service install', 'A packaged install sets up its service the first time you run buddi.'),
  },
  {
    name: 'service uninstall',
    group: 'Operate',
    summary: 'Remove the background service. Your data stays.',
    usage: 'buddi service uninstall',
    flags: [],
    applies: 'checkout',
    elsewhere: CHECKOUT_ONLY('service uninstall', 'A packaged install stops with buddi service stop, and buddi uninstall removes it.'),
  },
  {
    name: 'uninstall',
    group: 'Operate',
    summary: 'Remove buddi from this machine: the service, the data, the secrets. It lists everything first and asks.',
    usage: 'buddi uninstall [--yes] [--keep-data] [--no-backup]',
    flags: [
      { flag: '--yes', meaning: 'Do not ask.' },
      { flag: '--keep-data', meaning: 'Keep the data directory and the secrets that open it, for a reinstall.' },
      { flag: '--no-backup', meaning: 'Skip the last backup it takes first.' },
    ],
    example: 'buddi uninstall',
    exitCodes: [{ code: 1, meaning: 'Something listed could not be removed, or nothing was: the question was not answered yes, the backup failed, or the data directory is not an installation.' }],
    applies: 'both',
  },
  {
    name: 'backup create',
    group: 'Operate',
    summary: 'Write one archive of this installation: the database, your agents and skills, and your files.',
    usage: 'buddi backup create [--encrypt] [--out <dir>] [--no-artifacts] [--prune [n]]',
    flags: [
      { flag: '--encrypt', meaning: 'Seal it with your backup passphrase from the vault. A packaged install always does.' },
      { flag: '--out <dir>', meaning: 'Write it here instead of the backups directory. Source checkout only.' },
      { flag: '--no-artifacts', meaning: 'Leave the files out. Source checkout only.' },
      { flag: '--prune [n]', meaning: 'Then keep only the newest n archives.' },
    ],
    example: 'buddi backup create --encrypt',
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
  },
  {
    name: 'backup list',
    group: 'Operate',
    summary: 'List every archive, newest first.',
    usage: 'buddi backup list [--json]',
    flags: [JSON_FLAG],
    example: 'buddi backup list',
    applies: 'both',
    json: '{ dir, archives: [{ name, bytes, at }] }, newest first; at is an ISO time.',
  },
  {
    name: 'backup verify',
    group: 'Operate',
    summary: 'Check that an archive is whole and can be restored.',
    usage: 'buddi backup verify <archive> [--passphrase "<words>"]',
    flags: [{ flag: '--passphrase "<words>"', meaning: 'For an encrypted archive from another machine.' }],
    example: 'buddi backup verify buddi-backup-20260914-033000.tar.gz.age',
    applies: 'both',
  },
  {
    name: 'backup restore',
    group: 'Operate',
    summary: 'Put an archive back. It asks you to type a word first.',
    usage: 'buddi backup restore <archive> [--into <db>] [--files] [--yes] [--force] [--passphrase "<words>"]',
    flags: [
      { flag: '--into <db>', meaning: 'Restore the database only, into this one.' },
      { flag: '--files', meaning: 'Also restore agents, skills and files.' },
      { flag: '--yes', meaning: 'Do not ask.' },
      { flag: '--force', meaning: 'Restore over a database that has data in it.' },
      { flag: '--passphrase "<words>"', meaning: 'For an encrypted archive. Without it: the vault, then a prompt.' },
    ],
    applies: 'both',
  },
  {
    name: 'backup prune',
    group: 'Operate',
    summary: 'Delete old archives and keep the newest ones.',
    usage: 'buddi backup prune [--keep <n>]',
    flags: [{ flag: '--keep <n>', meaning: 'How many to keep.' }],
    applies: 'both',
  },
  {
    name: 'backup schedule',
    group: 'Operate',
    summary: 'The nightly backup at 03:30, prune included: status, install or uninstall.',
    usage: 'buddi backup schedule [status | install | uninstall] [--keep <n>]',
    flags: [{ flag: '--keep <n>', meaning: 'How many archives the nightly prune keeps.' }],
    applies: 'checkout',
    elsewhere: CHECKOUT_ONLY('backup schedule', 'A packaged install sets its nightly backup on the dashboard, in Settings → Backup.'),
  },
  {
    name: 'vault set',
    group: 'Operate',
    summary: 'Keep a secret in the vault. It asks for the value with the typing hidden.',
    usage: 'buddi vault set <NAME>',
    flags: [],
    example: 'buddi vault set ANTHROPIC_API_KEY',
    applies: 'both',
  },
  {
    name: 'vault get',
    group: 'Operate',
    summary: 'Print a secret from the vault.',
    usage: 'buddi vault get <NAME>',
    flags: [],
    applies: 'both',
  },
  {
    name: 'vault delete',
    group: 'Operate',
    summary: 'Remove a secret from the vault.',
    usage: 'buddi vault delete <NAME>',
    flags: [],
    applies: 'both',
  },
  {
    name: 'vault list',
    group: 'Operate',
    summary: 'List the names of the secrets in the vault, never their values.',
    usage: 'buddi vault list',
    flags: [],
    applies: 'both',
  },
  {
    name: 'vault import-env',
    group: 'Operate',
    summary: 'Move the secrets in .env into the vault.',
    usage: 'buddi vault import-env',
    flags: [],
    applies: 'both',
  },
  {
    name: 'browser',
    group: 'Operate',
    summary: "Say which browser the agents' own browser uses here.",
    usage: 'buddi browser [status]',
    flags: [],
    applies: 'both',
  },
  {
    name: 'browser install',
    group: 'Operate',
    summary: "Download Chromium for the agents' own browser, about 150 MB.",
    usage: 'buddi browser install',
    flags: [],
    applies: 'both',
  },
  {
    name: 'jobs',
    group: 'Operate',
    summary: 'List the work queue: what is waiting, running and failed.',
    usage: 'buddi jobs [--state <state>] [--kind <kind>] [--limit <n>] [--json]',
    flags: [
      { flag: '--state <state>', meaning: 'Only pending, leased, succeeded, failed, suspended or cancelled jobs.' },
      { flag: '--kind <kind>', meaning: 'Only jobs of this kind.' },
      { flag: '--limit <n>', meaning: 'At most n jobs. The default is 20.' },
      JSON_FLAG,
    ],
    example: 'buddi jobs --state failed',
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
    json:
      '{ paused, counts: { pending, leased, succeeded, failed, suspended, cancelled }, ' +
      'jobs: [{ id, state, kind, attempts, maxAttempts, createdAt, runAfter, leaseOwner, suspendedReason, lastError }] }',
  },
  {
    name: 'jobs retry',
    group: 'Operate',
    summary: 'Run a failed job again, or every failed job with --all.',
    usage: 'buddi jobs retry <id> | --all [--kind <kind>] [--state <state>] [--limit <n>]',
    flags: [
      { flag: '--all', meaning: 'Every dead job, not one.' },
      { flag: '--kind <kind>', meaning: 'With --all: only jobs of this kind.' },
    ],
    example: 'buddi jobs retry --all --kind mission-run',
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
  },
  {
    name: 'jobs cancel',
    group: 'Operate',
    summary: 'Cancel a job that has not run yet.',
    usage: 'buddi jobs cancel <id>',
    flags: [],
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
  },
  {
    name: 'pause',
    group: 'Operate',
    summary: 'Stop taking new work. What is running finishes.',
    usage: 'buddi pause',
    flags: [],
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
  },
  {
    name: 'resume',
    group: 'Operate',
    summary: 'Start taking work again.',
    usage: 'buddi resume',
    flags: [],
    exitCodes: [NEEDS_DATABASE],
    applies: 'both',
  },

  /* ----------------------------------------------------------------- Develop */
  {
    name: 'init',
    group: 'Develop',
    summary: 'Set a source checkout up: .env, the database, the service. Safe to run again.',
    usage: 'buddi init [--yes]',
    flags: [{ flag: '--yes', meaning: 'Ask nothing and take every default, for scripts and CI.' }],
    example: 'buddi init --yes',
    applies: 'checkout',
    elsewhere: CHECKOUT_ONLY('init', 'A packaged install sets itself up the first time you run buddi.'),
  },
  {
    name: 'db up',
    group: 'Develop',
    summary: 'Start the Postgres container of a source checkout.',
    usage: 'buddi db up',
    flags: [],
    applies: 'checkout',
    elsewhere: CHECKOUT_ONLY('db', 'A packaged install runs its own database; buddi status says whether it is up.'),
  },
  {
    name: 'db down',
    group: 'Develop',
    summary: 'Stop the Postgres container.',
    usage: 'buddi db down',
    flags: [],
    applies: 'checkout',
    elsewhere: CHECKOUT_ONLY('db', 'A packaged install runs its own database; buddi status says whether it is up.'),
  },
  {
    name: 'db status',
    group: 'Develop',
    summary: 'Say whether the Postgres container is running.',
    usage: 'buddi db status',
    flags: [],
    applies: 'checkout',
    elsewhere: CHECKOUT_ONLY('db', 'A packaged install runs its own database; buddi status says whether it is up.'),
  },
  {
    name: 'db secure',
    group: 'Develop',
    summary: 'Give the database a generated password, kept in the vault.',
    usage: 'buddi db secure',
    flags: [],
    applies: 'checkout',
    elsewhere: CHECKOUT_ONLY('db', 'A packaged install runs its own database; buddi status says whether it is up.'),
  },
  {
    name: 'migrate',
    group: 'Develop',
    summary: "Apply core's migrations and every installed plugin's.",
    usage: 'buddi migrate',
    flags: [],
    exitCodes: [NEEDS_DATABASE],
    applies: 'checkout',
    elsewhere: CHECKOUT_ONLY('migrate', 'A packaged install migrates when it starts and when it upgrades.'),
  },
  {
    name: 'serve',
    group: 'Develop',
    summary: 'Run the gateway in this terminal instead of the service.',
    usage: 'buddi serve',
    flags: [],
    applies: 'checkout',
    elsewhere: CHECKOUT_ONLY('serve', 'A packaged install runs in the background; buddi service status says how it is.'),
  },
];

/* ------------------------------------------------------------------ *
 * Where this buddi runs
 * ------------------------------------------------------------------ */

/**
 * A packaged install or a source checkout.
 *
 * The launcher (`@buddi/install`'s `environment()`) writes
 * `BUDDI_INSTALL_ROOT` before it hands anything to this package, and nothing
 * else does; a checkout finds its root from `pnpm-workspace.yaml` instead.
 */
export function installKind(env: NodeJS.ProcessEnv = process.env): InstallKind {
  const root = env.BUDDI_INSTALL_ROOT?.trim();
  return root ? 'packaged' : 'checkout';
}

export function appliesHere(entry: CommandEntry, kind: InstallKind): boolean {
  return entry.applies === 'both' || entry.applies === kind;
}

/** `BUDDI_JSON=1` is `--json` for a cron line. */
export function jsonFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.BUDDI_JSON?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes';
}

/* ------------------------------------------------------------------ *
 * Finding the entry an argv means
 * ------------------------------------------------------------------ */

const WORD = /^[a-z][a-z0-9-]*$/;

/** The command words at the front of an argv: `backup create` out of `backup create --encrypt`. */
export function commandWords(argv: readonly string[]): string[] {
  const words: string[] = [];
  for (const arg of argv) {
    if (!WORD.test(arg) || words.length === 3) break;
    words.push(arg);
  }
  return words;
}

/** The entry an argv is for: the longest run of leading words that names one. */
export function entryFor(
  argv: readonly string[],
  table: readonly CommandEntry[] = COMMANDS,
): CommandEntry | undefined {
  const words = commandWords(argv);
  // Unknown words never fall back to the bare command: only no words at all is `buddi`.
  for (let n = words.length; n >= (words.length === 0 ? 0 : 1); n -= 1) {
    const name = words.slice(0, n).join(' ');
    const hit = table.find((e) => e.name === name);
    if (hit) return hit;
  }
  return undefined;
}

/** The entries under a first word, when that word is a group like `backup`. */
export function entriesUnder(prefix: string, table: readonly CommandEntry[] = COMMANDS): CommandEntry[] {
  return table.filter((e) => e.name.startsWith(`${prefix} `));
}

/* ------------------------------------------------------------------ *
 * Did you mean
 * ------------------------------------------------------------------ */

/** Edits between two words, a swap of neighbours counting as one (`stauts`). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = d[i] as number[];
      const up = d[i - 1] as number[];
      row[j] = Math.min((up[j] as number) + 1, (row[j - 1] as number) + 1, (up[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        row[j] = Math.min(row[j] as number, ((d[i - 2] as number[])[j - 2] as number) + 1);
      }
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

/**
 * The command nearest to what was typed, when one is near enough to be worth
 * saying. Compared against the first word alone and the first two, so both
 * `buddi stauts` and `buddi backup craete` find their way.
 */
export function nearestCommand(
  argv: readonly string[],
  kind: InstallKind,
  table: readonly CommandEntry[] = COMMANDS,
): string | undefined {
  const words = argv.filter((a) => !a.startsWith('-')).slice(0, 2);
  if (words.length === 0) return undefined;
  // Two words first (`backup craete`), then the first alone (`stauts`, `bakup`).
  const attempts = words.length > 1 ? [words.join(' '), words[0] as string] : [words[0] as string];
  for (const typed of attempts) {
    let best: { name: string; score: number } | undefined;
    for (const entry of table) {
      if (entry.name === '' || !appliesHere(entry, kind)) continue;
      const parts = entry.name.split(' ');
      // A single typed word is measured against the command's first word, so
      // `bakup` finds the backup group and answers with its first command.
      const target = typed.includes(' ') ? entry.name : (parts[0] as string);
      if (typed.includes(' ') && parts.length < 2) continue;
      const score = editDistance(typed, target);
      if (best === undefined || score < best.score) best = { name: entry.name, score };
    }
    if (best !== undefined && best.score <= Math.max(1, Math.floor(typed.length / 3))) return best.name;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

/** `buddi backup verify <archive>`: the usage up to its first option. */
export function shortUsage(entry: CommandEntry): string {
  const out: string[] = [];
  for (const token of entry.usage.split(' ')) {
    if (token.startsWith('[') || token.startsWith('-') || token === '|') break;
    out.push(token);
  }
  return out.join(' ');
}

export interface HelpStyle {
  bold(text: string): string;
  dim(text: string): string;
}

const PLAIN: HelpStyle = { bold: (t) => t, dim: (t) => t };

/** `buddi help`: every command that applies here, grouped, one line each. */
export function renderHelp(
  table: readonly CommandEntry[],
  kind: InstallKind,
  style: HelpStyle = PLAIN,
): string {
  const shown = table.filter((e) => appliesHere(e, kind));
  const width = Math.max(...shown.map((e) => shortUsage(e).length));
  const out: string[] = ['buddi: your personal agents, one command.'];
  for (const group of GROUPS) {
    const entries = shown.filter((e) => e.group === group);
    if (entries.length === 0) continue;
    out.push('', style.bold(group));
    for (const entry of entries) {
      out.push(`  ${shortUsage(entry).padEnd(width)}  ${style.dim(entry.summary)}`);
    }
  }
  out.push('', 'buddi help <command> prints its flags, an example and its exit codes.');
  return out.join('\n');
}

const BASE_EXIT_CODES: ReadonlyArray<{ code: number; meaning: string }> = [
  { code: 0, meaning: 'Done.' },
  { code: 1, meaning: 'It failed; the message says why.' },
  { code: 2, meaning: 'The command was not typed right.' },
];

export function exitCodesOf(entry: CommandEntry): Array<{ code: number; meaning: string }> {
  const merged = new Map<number, string>(BASE_EXIT_CODES.map((c) => [c.code, c.meaning]));
  for (const extra of entry.exitCodes ?? []) merged.set(extra.code, extra.meaning);
  return [...merged.entries()].sort((a, b) => a[0] - b[0]).map(([code, meaning]) => ({ code, meaning }));
}

/** `buddi help <command>` and `buddi <command> --help`. */
export function renderCommandHelp(
  entry: CommandEntry,
  table: readonly CommandEntry[] = COMMANDS,
  kind: InstallKind = 'checkout',
  style: HelpStyle = PLAIN,
): string {
  const out: string[] = [style.bold(entry.usage === 'buddi' ? 'buddi' : shortUsage(entry)), '', entry.summary];
  if (!appliesHere(entry, kind) && entry.elsewhere) out.push('', entry.elsewhere);
  out.push('', style.bold('Usage'), `  ${entry.usage}`);
  if (entry.flags.length > 0) {
    const width = Math.max(...entry.flags.map((f) => f.flag.length));
    out.push('', style.bold('Flags'));
    for (const f of entry.flags) out.push(`  ${f.flag.padEnd(width)}  ${f.meaning}`);
  }
  if (entry.example) out.push('', style.bold('Example'), `  ${entry.example}`);
  if (entry.json) out.push('', style.bold('JSON'), `  ${entry.json}`);
  out.push('', style.bold('Exit codes'));
  for (const c of exitCodesOf(entry)) out.push(`  ${c.code}  ${c.meaning}`);
  const related = entry.name === '' ? [] : entriesUnder(entry.name, table).filter((e) => appliesHere(e, kind));
  if (related.length > 0) {
    out.push('', style.bold('See also'));
    for (const r of related) out.push(`  ${shortUsage(r)}`);
  }
  return out.join('\n');
}

/** `buddi help backup`: the commands under a word that is not a command itself. */
export function renderGroupHelp(
  prefix: string,
  table: readonly CommandEntry[],
  kind: InstallKind,
  style: HelpStyle = PLAIN,
): string {
  const entries = entriesUnder(prefix, table).filter((e) => appliesHere(e, kind));
  const width = Math.max(...entries.map((e) => shortUsage(e).length));
  return [
    ...entries.map((e) => `  ${shortUsage(e).padEnd(width)}  ${style.dim(e.summary)}`),
    '',
    `buddi help ${prefix} <command> prints one of them in full.`,
  ].join('\n');
}

/* ------------------------------------------------------------------ *
 * The reference page
 * ------------------------------------------------------------------ */

const GROUP_NOTES: Record<Group, string> = {
  Everyday: 'What you type most days.',
  Agents: 'Your agents, what they have scheduled, and the plugins they use.',
  Reach: 'The ways your agents reach you, and the ways you reach them.',
  Operate: 'Keeping buddi running: the service, upgrades, backups, secrets and the work queue.',
  Develop: 'Only in a source checkout. A packaged install does not list them.',
};

/**
 * `docs/cli.md`, without its frontmatter: the script adds that, and the test
 * compares what follows it.
 */
export function renderReference(table: readonly CommandEntry[] = COMMANDS): string {
  const out: string[] = [
    '# The buddi command line',
    '',
    'Every command, grouped the way `buddi help` groups them. The same words work in a',
    'packaged install and in a source checkout; what does not apply where you run it is',
    'left out of `buddi help`, and says what to do instead when typed. `buddi help <command>`',
    'and `buddi <command> --help` print one command with an example and its exit codes.',
    '',
    'This page is generated from the command table (`packages/cli/src/commands.ts`) by',
    '`pnpm docs:cli`; a test fails when the two differ.',
    '',
    '## What it is for',
    '',
    '`buddi` runs your agents and keeps them running: it starts the service, checks on it,',
    'backs it up and upgrades it. It is also a way to talk to your agents without the',
    'dashboard, from a terminal or a script, and to pair the phone you reach them from.',
    '',
    '## Examples',
    '',
    '- `buddi status`: a few short sentences: the version, whether the service is running',
    '  and the database reachable, which agents can run, what needs you, and whether a',
    '  newer buddi is out.',
    '- `buddi ask "Any reminder today?" --json`: one object with the answer in `text`, the',
    '  `runId` and `conversationId`, and any files the run saved in `artifacts`.',
    '- `buddi chat --agent @ledger`: a conversation in the terminal. It opens with the',
    '  agent\'s name, the conversation id, its provider and model, and',
    '  `/help for commands, /quit to leave`.',
    '- `buddi backup create`: the path of the archive it wrote, its size and how long it',
    '  took, what is inside, and the `buddi backup verify` line to check it.',
    '- `buddi telegram pair`: a QR code, the link to open on the phone and a code, valid',
    '  for ten minutes.',
    '',
    '## Exit codes and output',
    '',
    '- `0` done, `1` failed, `2` the command was not typed right, `3` it needs something',
    '  first: the database is not reachable, the agent does not exist, an approval is',
    '  waiting.',
    '- Answers go to stdout and diagnostics to stderr. Colour only on a terminal, and',
    '  never with `NO_COLOR` set.',
    '- `--json` on the commands that read prints one object or one array with the',
    '  fields listed below. `BUDDI_JSON=1` does the same, for a cron line; commands that',
    '  change something ignore it.',
  ];
  for (const group of GROUPS) {
    out.push('', `## ${group}`, '', GROUP_NOTES[group], '');
    for (const entry of table.filter((e) => e.group === group)) {
      const only = entry.applies === 'checkout' && group !== 'Develop' ? ' Source checkout only.' : '';
      out.push(`- \`${entry.usage}\`: ${entry.summary}${only}`);
      for (const f of entry.flags) out.push(`  - \`${f.flag}\`: ${f.meaning}`);
      if (entry.json) out.push(`  - JSON: ${entry.json}`);
    }
  }
  return `${out.join('\n')}\n`;
}
