#!/usr/bin/env node
/**
 * `buddi` — the one command.
 *
 * This file is a dispatcher and nothing else. Every subcommand is implemented
 * somewhere it already belonged: `chat`/`ask`/`agents` and `missions` are the
 * gateway's own entry points, called as functions; `serve` is the gateway's
 * `main`; `migrate` is the gateway's `migrateInstalled` over core's
 * `runMigrations`. The binary adds only what has nowhere else to live — `init`,
 * `doctor`, `status`, `service`, `telegram`, `backup` — and the help, which is
 * drawn from the command table in `commands.ts`, like the reference page.
 *
 * The repo root comes from this module's location (see `paths.ts`), never from
 * `process.cwd()`, so the global binary behaves the same from any directory.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { compareVersions, createPool, timezoneFromEnv } from '@buddi/core';
import {
  createWiringAsync,
  currentVersion,
  DatabaseUnreachableError,
  describeDatabaseError,
  gatewayCatalog,
  hydrateSecrets,
  migrateInstalled,
  parseAgentsArgs,
  parseChatArgs,
  parseMissionsArgs,
  parseNudgesArgs,
  parsePluginsArgs,
  parseRemindersArgs,
  probeDatabase,
  readAgentAttention,
  readUpgradeFile,
  recapMissionId,
  requireDatabase,
  runChatCli,
  runMissionsCli,
  runNudgesCli,
  runPluginsCli,
  runRemindersCli,
  runServe,
  supervisorCall,
} from '@buddi/gateway';
import { parseArgs, UsageError, type Command, type ServiceAction } from './args.js';
import {
  appliesHere,
  COMMANDS,
  commandWords,
  entriesUnder,
  entryFor,
  installKind,
  jsonFromEnv,
  nearestCommand,
  renderCommandHelp,
  renderGroupHelp,
  renderHelp,
  type InstallKind,
} from './commands.js';
import { collectStatus, renderStatus, startedAt, supervisorSocketPath, type ServiceState } from './status.js';
import { colorOn, helpStyle } from './style.js';
import { runBackup } from './backup/index.js';
import { runDashboard } from './dashboard-cmd.js';
import { runDb } from './db-cmd.js';
import { collectChecks, exitCodeFor, renderTable, summarize } from './doctor.js';
import { createProbes } from './doctor-probes.js';
import { runInit } from './init.js';
import { jobsCancel, jobsList, jobsRetry, jobsRetryAll, pause, resume } from './jobs-cmd.js';
import { DATA_DIR, loadEnv, loadEnvironment, REPO_ROOT } from './paths.js';
import { runMcp } from './mcp/server.js';
import { createServiceManager, followLogs } from './service/index.js';
import { runTelegram } from './telegram-cmd.js';
import { runUpgrade } from './upgrade.js';
import { runVault } from './vault-cmd.js';

/** Apply core's migrations and every installed plugin's. Same work as `pnpm db:migrate`. */
export async function migrate(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set. Run buddi init to write it.');
    return 3;
  }
  const pool = createPool(url);
  try {
    // An installed plugin whose migrations will not apply is that plugin
    // failing to load, not this command failing (docs/install.md §7): it is
    // named here and by `buddi plugins list`, and core's own migrations and
    // the compiled-in plugins' still throw.
    const { applied, problems } = await migrateInstalled(pool);
    if (applied.length === 0) console.log('migrations: up to date');
    for (const m of applied) console.log(`applied ${m.schema}/${m.filename}`);
    for (const problem of problems) {
      console.error(`plugin ${problem.name} was not loaded: ${problem.message}`);
    }
    return problems.length > 0 ? 1 : 0;
  } finally {
    await pool.end();
  }
}

export async function doctor(): Promise<number> {
  const probes = createProbes(process.env);
  try {
    console.log(`buddi doctor — ${REPO_ROOT}\n`);
    const checks = await collectChecks(probes);
    console.log(renderTable(checks));
    console.log(`\n${summarize(checks)}`);
    return exitCodeFor(checks);
  } finally {
    await probes.close();
  }
}

async function service(action: ServiceAction, json = false): Promise<number> {
  const manager = createServiceManager();
  if (json && action !== 'logs' && action !== 'install' && action !== 'uninstall') {
    // The state after the verb, for a script: the manager's own view.
    if (action !== 'status') {
      await (action === 'start' ? manager.start() : action === 'stop' ? manager.stop() : manager.restart());
    }
    const state = await manager.status();
    console.log(JSON.stringify(state, null, 2));
    return state.running || action === 'stop' ? 0 : 1;
  }
  if (action === 'status') {
    const status = await manager.status();
    console.log(`${manager.kind}: ${status.detail}`);
    console.log(`  unit: ${status.unitPath}${status.installed ? '' : ' (absent)'}`);
    console.log(`  log:  ${manager.logFile}`);
    return status.running ? 0 : 1;
  }
  if (action === 'logs') {
    await followLogs(manager);
    return 0;
  }
  const notes =
    action === 'install'
      ? await manager.install()
      : action === 'uninstall'
        ? await manager.uninstall()
        : action === 'start'
          ? await manager.start()
          : action === 'stop'
            ? await manager.stop()
            : await manager.restart();
  for (const note of notes) console.log(note);
  return 0;
}

/** What `main` works out before dispatching: the JSON switch and the argv a delegate re-parses. */
export interface DispatchOptions {
  json?: boolean;
  env?: NodeJS.ProcessEnv;
}

/** `--json` goes back on the argv of the commands whose own parser reads it. */
function withJson(argv: string[], json: boolean): string[] {
  return json ? [...argv, '--json'] : argv;
}

export async function dispatch(command: Command, opts: DispatchOptions = {}): Promise<number> {
  const json = opts.json === true;
  const env = opts.env ?? process.env;
  switch (command.kind) {
    case 'help':
      return printHelp(command.topic ?? [], env);
    case 'version': {
      console.log(`buddi ${await currentVersion(env)}`);
      return 0;
    }
    case 'status':
      await loadEnvironment();
      return status(json, env);
    case 'chat-cli': {
      await loadEnvironment();
      // `buddi agents` reads files and edits files: it is the one command in
      // this group that must still work with the database down — that is often
      // exactly when an owner is trying to see what is configured.
      if (command.argv[0] !== 'agents') {
        const blocked = await requireDatabase(process.env.DATABASE_URL);
        if (blocked !== 0) return blocked;
      }
      await runChatCli(withJson(command.argv, json));
      return process.exitCode === undefined ? 0 : Number(process.exitCode);
    }
    case 'missions': {
      await loadEnvironment();
      const blocked = await requireDatabase(process.env.DATABASE_URL);
      if (blocked !== 0) return blocked;
      await runMissionsCli(withJson(command.argv, json));
      return process.exitCode === undefined ? 0 : Number(process.exitCode);
    }
    case 'reminders': {
      await loadEnvironment();
      const blocked = await requireDatabase(process.env.DATABASE_URL);
      if (blocked !== 0) return blocked;
      await runRemindersCli(withJson(command.argv, json));
      return process.exitCode === undefined ? 0 : Number(process.exitCode);
    }
    case 'nudges': {
      await loadEnvironment();
      const blocked = await requireDatabase(process.env.DATABASE_URL);
      if (blocked !== 0) return blocked;
      await runNudgesCli(command.argv);
      return process.exitCode === undefined ? 0 : Number(process.exitCode);
    }
    case 'serve':
      await loadEnvironment();
      await runServe();
      return 0;
    case 'plugins': {
      await loadEnvironment();
      return runPluginsCli(withJson(command.argv, json));
    }
    case 'migrate': {
      await loadEnvironment();
      const blocked = await requireDatabase(process.env.DATABASE_URL);
      if (blocked !== 0) return blocked;
      return migrate();
    }
    case 'db':
      await loadEnvironment();
      return runDb(command.action, process.env);
    case 'backup':
      // No `requireDatabase` gate: `list`, `verify` and `prune` are exactly the
      // commands an owner reaches for when the database is down, and `create`
      // and `restore` talk to Postgres through the container themselves and say
      // so in their own words.
      await loadEnvironment();
      return runBackup(json ? { ...command, json: true } : command, process.env);
    case 'init':
      await loadEnvironment();
      return runInit({ yes: command.yes });
    case 'doctor':
      await loadEnvironment();
      return doctor();
    case 'upgrade': {
      await loadEnvironment();
      const manager = createServiceManager();
      return runUpgrade({
        backup: command.backup,
        service: {
          status: () => manager.status(),
          stop: () => manager.stop(),
          start: () => manager.start(),
        },
      });
    }
    case 'service':
      await loadEnvironment();
      return service(command.action, json);
    case 'dashboard':
      await loadEnvironment();
      return runDashboard(command.action);
    case 'mcp':
      // Only `.env`: the dashboard's host and port, and the credential names
      // whose values are cut from every result. No database, no plugins, and
      // nothing on stdout, which belongs to the protocol.
      loadEnv();
      return runMcp();
    case 'browser':
      // No database and no environment: it only looks on disk, or runs Playwright's installer.
      return runBrowser(command.action);
    case 'telegram': {
      await loadEnvironment();
      const blocked = await requireDatabase(process.env.DATABASE_URL);
      if (blocked !== 0) return blocked;
      // `pair` talks to Telegram, so the bot token has to be a token and not
      // the `<vault>` marker `vault import-env` leaves in `.env`.
      await hydrateSecrets(process.env);
      return runTelegram(command.action, command.deviceId, process.env, json);
    }
    case 'vault':
      await loadEnvironment();
      return runVault(command.action, command.name);
    case 'pause': {
      await loadEnvironment();
      const blocked = await requireDatabase(process.env.DATABASE_URL);
      if (blocked !== 0) return blocked;
      return pause();
    }
    case 'resume': {
      await loadEnvironment();
      const blocked = await requireDatabase(process.env.DATABASE_URL);
      if (blocked !== 0) return blocked;
      return resume();
    }
    case 'jobs': {
      await loadEnvironment();
      const blocked = await requireDatabase(process.env.DATABASE_URL);
      if (blocked !== 0) return blocked;
      switch (command.action) {
        case 'retry':
          return jobsRetry(command.jobId);
        case 'retry-all':
          return jobsRetryAll({
            ...(command.state ? { state: command.state } : {}),
            ...(command.kind_ ? { kind: command.kind_ } : {}),
            ...(command.limit ? { limit: command.limit } : {}),
          });
        case 'cancel':
          return jobsCancel(command.jobId);
        default:
          return jobsList({
            ...(command.state ? { state: command.state } : {}),
            ...(command.kind_ ? { kind: command.kind_ } : {}),
            ...(command.limit ? { limit: command.limit } : {}),
            ...(json ? { json: true } : {}),
          });
      }
    }
  }
}

/**
 * Check a delegated command's own words before anything loads, so a typo
 * there is a usage error (2) like one here, and not a failure (1) found later.
 */
function checkDelegated(command: Command, json: boolean): void {
  const argv = 'argv' in command ? withJson(command.argv, json) : [];
  try {
    if (command.kind === 'chat-cli') {
      if (argv[0] === 'agents') parseAgentsArgs(argv.slice(1));
      else parseChatArgs(argv);
    } else if (command.kind === 'missions') parseMissionsArgs(argv);
    else if (command.kind === 'plugins') parsePluginsArgs(argv);
    else if (command.kind === 'reminders') parseRemindersArgs(argv);
    else if (command.kind === 'nudges') parseNudgesArgs(argv);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

/** A usage error, said with the nearest command when the words were wrong. */
function usageFailure(argv: string[], err: UsageError, kind: InstallKind): number {
  const entry = entryFor(argv);
  const nearest = nearestCommand(argv, kind);
  const typed = commandWords(argv).join(' ');
  if (nearest !== undefined && nearest !== entry?.name && nearest !== typed) {
    console.error(`${err.message.replace(/\.?$/, '.')} Did you mean buddi ${nearest}?`);
  } else {
    console.error(err.message);
    if (entry !== undefined && entry.name !== '') console.error(`Run buddi help ${entry.name} for its usage.`);
    else console.error('Run buddi help for every command.');
  }
  return 2;
}

/** `buddi help [words…]`: the list, one command's page, or a group's commands. */
function printHelp(topic: string[], env: NodeJS.ProcessEnv): number {
  const kind = installKind(env);
  const style = helpStyle(colorOn(env));
  if (topic.length === 0) {
    console.log(renderHelp(COMMANDS, kind, style));
    return 0;
  }
  const name = topic.join(' ');
  const exact = COMMANDS.find((e) => e.name === name);
  if (exact) {
    console.log(renderCommandHelp(exact, COMMANDS, kind, style));
    return 0;
  }
  if (entriesUnder(name).some((e) => appliesHere(e, kind))) {
    console.log(renderGroupHelp(name, COMMANDS, kind, style));
    return 0;
  }
  const prefix = entryFor(topic);
  if (prefix && prefix.name !== '') {
    console.log(renderCommandHelp(prefix, COMMANDS, kind, style));
    return 0;
  }
  const nearest = nearestCommand(topic, kind);
  console.error(`buddi ${name} is not a command.${nearest ? ` Did you mean buddi ${nearest}?` : ' Run buddi help for every command.'}`);
  return 2;
}

/** `buddi status`: read each part, say each in a sentence, never throw. */
async function status(json: boolean, env: NodeJS.ProcessEnv): Promise<number> {
  const kind = installKind(env);
  await hydrateSecrets(env).catch(() => {});
  const report = await collectStatus({
    install: kind,
    version: () => currentVersion(env),
    service: async (): Promise<{ state: ServiceState; detail: string }> => {
      if (kind === 'packaged') {
        const reply = await supervisorCall(supervisorSocketPath(DATA_DIR), '/status', 'GET', undefined, 3_000).catch(() => null);
        if (reply === null || reply.status !== 200) return { state: 'not-installed', detail: 'the supervisor is not answering' };
        const body = reply.body as { gateway?: string; gatewayPid?: number | null };
        if (body.gateway !== 'running') return { state: 'stopped', detail: `the gateway is ${body.gateway ?? 'stopped'}` };
        const since = body.gatewayPid ? await startedAt(body.gatewayPid) : undefined;
        return { state: 'running', detail: since ? `running since ${since}` : 'running' };
      }
      const state = await createServiceManager().status();
      if (!state.installed) return { state: 'not-installed', detail: state.detail };
      if (!state.running) return { state: 'stopped', detail: state.detail };
      const since = state.pid ? await startedAt(state.pid) : undefined;
      return { state: 'running', detail: since ? `running since ${since}` : state.detail };
    },
    probeDatabase: () => probeDatabase(env.DATABASE_URL),
    describeDatabaseError: (err) => (err instanceof Error ? err.message : describeDatabaseError(err, env.DATABASE_URL)),
    agents: async () => {
      // With the database up, the catalog the service runs: provider accounts
      // included, as `buddi agents` reads it. Without it, the files alone.
      const wiring = await createWiringAsync(env).catch(() => undefined);
      const catalog = wiring?.catalog ?? gatewayCatalog(env);
      await wiring?.pool.end().catch(() => {});
      return catalog.list().flatMap((summary) => {
        const agent = catalog.get(summary.id);
        if (!agent) return [];
        return [
          {
            handle: agent.handle,
            id: agent.id,
            available: agent.availability.ok,
            ...(agent.availability.ok ? {} : { reason: agent.availability.problem.message }),
          },
        ];
      });
    },
    attention: async () => {
      const pool = createPool(env.DATABASE_URL as string);
      try {
        const snapshot = await readAgentAttention(pool);
        return {
          approvals: snapshot.agents.reduce((sum, a) => sum + a.approvals, 0),
          questions: snapshot.agents.filter((a) => a.question !== null).length,
        };
      } finally {
        await pool.end().catch(() => {});
      }
    },
    lastRecapAt: async () => {
      const mission = recapMissionId();
      if (mission === undefined) return null;
      const pool = createPool(env.DATABASE_URL as string);
      try {
        const { rows } = await pool.query(
          `select created_at from core.events
            where kind = 'mission.delivered' and payload->>'missionId' = $1
            order by created_at desc limit 1`,
          [mission],
        );
        return rows[0] ? new Date(rows[0].created_at) : null;
      } finally {
        await pool.end().catch(() => {});
      }
    },
    update: async () => {
      const file = await readUpgradeFile(env);
      const latest = file?.check.latest;
      if (!file || latest === undefined) return { available: false };
      return (compareVersions(latest, file.current) ?? 0) > 0 ? { available: true, latest } : { available: false };
    },
  });
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderStatus(report, timezoneFromEnv(env)));
  return report.database.reachable ? 0 : 3;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const kind = installKind(env);

  // `buddi <command> --help` is `buddi help <command>`.
  if (argv.length > 1 && argv.slice(1).some((a) => a === '--help' || a === '-h') && argv[0] !== 'help') {
    return printHelp(commandWords(argv), env);
  }

  // `--json` belongs to the reads; `BUDDI_JSON=1` turns it on for them alone.
  const entry = entryFor(argv);
  let args = argv;
  let json = false;
  if (argv.includes('--json')) {
    if (entry === undefined || entry.json === undefined) {
      const named = entry?.name ? `buddi ${entry.name}` : `buddi ${commandWords(argv).join(' ')}`.trim();
      console.error(`${named} has no --json output. Run buddi help for the commands that do.`);
      return 2;
    }
    json = true;
    args = argv.filter((a) => a !== '--json');
  } else if (entry?.json !== undefined && jsonFromEnv(env)) {
    json = true;
  }

  let command: Command;
  try {
    command = parseArgs(args);
    checkDelegated(command, json);
  } catch (err) {
    if (err instanceof UsageError) return usageFailure(argv, err, kind);
    throw err;
  }

  // One tree everywhere; what does not apply here says what to do instead.
  if (entry !== undefined && !appliesHere(entry, kind) && command.kind !== 'help') {
    console.error(entry.elsewhere ?? `buddi ${entry.name} does not apply here.`);
    return 2;
  }
  return dispatch(command, { json, env });
}

/** Exit 3 for a database that is not there; 1 for everything else. */
export function exitCodeForError(err: unknown): number {
  if (err instanceof DatabaseUnreachableError) return 3;
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 3 : 1;
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main()
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((err) => {
      // A bare `AggregateError:` is what a dead database used to print. Never
      // again: every throw leaves this binary as a sentence.
      console.error(describeDatabaseError(err, process.env.DATABASE_URL));
      process.exit(exitCodeForError(err));
    });
}

/**
 * `buddi browser install|status`: Playwright's installer for Chromium, from
 * the copy the browser plugin depends on, streamed to this terminal.
 */
async function runBrowser(action: 'install' | 'status'): Promise<number> {
  const { browserLine, detectBrowser, installBrowser, installDepsCommand, noSandboxMessage } = await import('@buddi/gateway');
  if (action === 'status') { console.log(browserLine(detectBrowser())); return 0; }
  console.log('Installing Chromium for the agents\' own browser (about 150 MB).');
  const outcome = await installBrowser({ inherit: true });
  if (!outcome.ok) { console.error(`buddi: the browser install failed: ${outcome.detail}`); return 1; }
  console.log(browserLine(detectBrowser()));
  if (process.platform === 'linux') {
    console.log(`If the browser will not start for missing libraries, run once: ${installDepsCommand()}`);
    console.log(`If it says it has no usable sandbox: ${noSandboxMessage()}`);
  }
  return 0;
}
