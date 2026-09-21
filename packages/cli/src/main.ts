#!/usr/bin/env node
/**
 * `buddi` — the one command.
 *
 * This file is a dispatcher and nothing else. Every subcommand is implemented
 * somewhere it already belonged: `chat`/`ask`/`agents` and `missions` are the
 * gateway's own entry points, called as functions; `serve` is the gateway's
 * `main`; `migrate` is the gateway's `migrateInstalled` over core's
 * `runMigrations`. The binary adds only what has nowhere else to live — `init`,
 * `doctor`, `service`, `telegram`, `backup`.
 *
 * The repo root comes from this module's location (see `paths.ts`), never from
 * `process.cwd()`, so the global binary behaves the same from any directory.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPool } from '@buddi/core';
import {
  describeDatabaseError,
  hydrateSecrets,
  migrateInstalled,
  requireDatabase,
  runChatCli,
  runMissionsCli,
  runNudgesCli,
  runPluginsCli,
  runRemindersCli,
  runServe,
} from '@buddi/gateway';
import { parseArgs, USAGE, UsageError, type Command, type ServiceAction } from './args.js';
import { runBackup } from './backup/index.js';
import { runDashboard } from './dashboard-cmd.js';
import { runDb } from './db-cmd.js';
import { collectChecks, exitCodeFor, renderTable, summarize } from './doctor.js';
import { createProbes } from './doctor-probes.js';
import { runInit } from './init.js';
import { jobsCancel, jobsList, jobsRetry, jobsRetryAll, pause, resume } from './jobs-cmd.js';
import { loadEnvironment, REPO_ROOT } from './paths.js';
import { createServiceManager, followLogs } from './service/index.js';
import { runTelegram } from './telegram-cmd.js';
import { runUpgrade } from './upgrade.js';
import { runVault } from './vault-cmd.js';

/** Apply core's migrations and every installed plugin's. Same work as `pnpm db:migrate`. */
export async function migrate(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set — run `buddi init`');
    return 1;
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

async function service(action: ServiceAction): Promise<number> {
  const manager = createServiceManager();
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

export async function dispatch(command: Command): Promise<number> {
  switch (command.kind) {
    case 'help':
      console.log(USAGE);
      return 0;
    case 'version': {
      console.log('buddi 0.1.0');
      return 0;
    }
    case 'chat-cli': {
      await loadEnvironment();
      // `buddi agents` reads files and edits files: it is the one command in
      // this group that must still work with the database down — that is often
      // exactly when an owner is trying to see what is configured.
      if (command.argv[0] !== 'agents') {
        const blocked = await requireDatabase(process.env.DATABASE_URL);
        if (blocked !== 0) return blocked;
      }
      await runChatCli(command.argv);
      return process.exitCode === undefined ? 0 : Number(process.exitCode);
    }
    case 'missions': {
      await loadEnvironment();
      const blocked = await requireDatabase(process.env.DATABASE_URL);
      if (blocked !== 0) return blocked;
      await runMissionsCli(command.argv);
      return 0;
    }
    case 'reminders': {
      await loadEnvironment();
      const blocked = await requireDatabase(process.env.DATABASE_URL);
      if (blocked !== 0) return blocked;
      await runRemindersCli(command.argv);
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
      return runPluginsCli(command.argv);
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
      return runBackup(command, process.env);
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
      return service(command.action);
    case 'dashboard':
      await loadEnvironment();
      return runDashboard(command.action);
    case 'telegram': {
      await loadEnvironment();
      const blocked = await requireDatabase(process.env.DATABASE_URL);
      if (blocked !== 0) return blocked;
      // `pair` talks to Telegram, so the bot token has to be a token and not
      // the `<vault>` marker `vault import-env` leaves in `.env`.
      await hydrateSecrets(process.env);
      return runTelegram(command.action, command.deviceId);
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
          });
      }
    }
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let command: Command;
  try {
    command = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }
  return dispatch(command);
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
      process.exit(1);
    });
}
