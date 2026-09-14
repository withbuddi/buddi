#!/usr/bin/env node
/**
 * `buddi` — the one command.
 *
 * This file is a dispatcher and nothing else. Every subcommand is implemented
 * somewhere it already belonged: `chat`/`ask`/`agents` and `missions` are the
 * gateway's own entry points, called as functions; `serve` is the gateway's
 * `main`; `migrate` is core's `runMigrations` over the gateway's installed
 * manifests. The binary adds only what has nowhere else to live — `init`,
 * `doctor`, `service`, `telegram`.
 *
 * The repo root comes from this module's location (see `paths.ts`), never from
 * `process.cwd()`, so the global binary behaves the same from any directory.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPool, runMigrations } from '@buddi/core';
import {
  describeDatabaseError,
  hydrateSecrets,
  installedManifests,
  requireDatabase,
  runChatCli,
  runMissionsCli,
  runRemindersCli,
  runServe,
} from '@buddi/gateway';
import { parseArgs, USAGE, UsageError, type Command, type ServiceAction } from './args.js';
import { runDashboard } from './dashboard-cmd.js';
import { runDb } from './db-cmd.js';
import { collectChecks, exitCodeFor, renderTable, summarize } from './doctor.js';
import { createProbes } from './doctor-probes.js';
import { runInit } from './init.js';
import { jobsCancel, jobsList, jobsRetry, pause, resume } from './jobs-cmd.js';
import { loadEnv, REPO_ROOT } from './paths.js';
import { createServiceManager, followLogs } from './service/index.js';
import { runTelegram } from './telegram-cmd.js';
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
    const applied = await runMigrations(pool, installedManifests());
    if (applied.length === 0) console.log('migrations: up to date');
    for (const m of applied) console.log(`applied ${m.schema}/${m.filename}`);
    return 0;
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
      loadEnv();
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
      loadEnv();
      const blocked = await requireDatabase(process.env.DATABASE_URL);
      if (blocked !== 0) return blocked;
      await runMissionsCli(command.argv);
      return 0;
    }
    case 'reminders': {
      loadEnv();
      const blocked = await requireDatabase(process.env.DATABASE_URL);
      if (blocked !== 0) return blocked;
      await runRemindersCli(command.argv);
      return process.exitCode === undefined ? 0 : Number(process.exitCode);
    }
    case 'serve':
      loadEnv();
      await runServe();
      return 0;
    case 'migrate': {
      loadEnv();
      const blocked = await requireDatabase(process.env.DATABASE_URL);
      if (blocked !== 0) return blocked;
      return migrate();
    }
    case 'db':
      loadEnv();
      return runDb(command.action, process.env);
    case 'init':
      loadEnv();
      return runInit();
    case 'doctor':
      loadEnv();
      return doctor();
    case 'service':
      loadEnv();
      return service(command.action);
    case 'dashboard':
      loadEnv();
      return runDashboard(command.action);
    case 'telegram': {
      loadEnv();
      const blocked = await requireDatabase(process.env.DATABASE_URL);
      if (blocked !== 0) return blocked;
      // `pair` talks to Telegram, so the bot token has to be a token and not
      // the `<vault>` marker `vault import-env` leaves in `.env`.
      await hydrateSecrets(process.env);
      return runTelegram(command.action, command.deviceId);
    }
    case 'vault':
      loadEnv();
      return runVault(command.action, command.name);
    case 'pause': {
      loadEnv();
      const blocked = await requireDatabase(process.env.DATABASE_URL);
      if (blocked !== 0) return blocked;
      return pause();
    }
    case 'resume': {
      loadEnv();
      const blocked = await requireDatabase(process.env.DATABASE_URL);
      if (blocked !== 0) return blocked;
      return resume();
    }
    case 'jobs': {
      loadEnv();
      const blocked = await requireDatabase(process.env.DATABASE_URL);
      if (blocked !== 0) return blocked;
      switch (command.action) {
        case 'retry':
          return jobsRetry(command.jobId);
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
