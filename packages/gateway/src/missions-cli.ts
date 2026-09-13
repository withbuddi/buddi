#!/usr/bin/env node
/**
 * `buddi missions` — mission registration and manual runs.
 *
 * Registration is idempotent: `add-friday-recap` upserts the mission and points
 * it at a fresh schedule revision, so running it twice leaves one mission and
 * one active schedule. `run-now` writes a pending occurrence and lets the
 * scheduler claim it in the normal way; `--inline` runs it here instead, prints
 * the delivered text, and — unlike a scheduled run — reports an unpaired owner
 * chat as a skipped delivery rather than a failure.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  finishOccurrence,
  getActiveSchedule,
  getMission,
  listMissions,
  listOccurrences,
  nextAfter,
  setMissionEnabled,
  setSchedule,
  toOccurrence,
  upsertMission,
  type Occurrence,
  type OccurrenceState,
} from '@buddi/core';
import type { Pool } from 'pg';
import { createWiring, loadEnv } from './bootstrap.js';
import { createMissionExecutor } from './missions/execute.js';
import {
  FRIDAY_RECAP_CRON,
  FRIDAY_RECAP_ID,
  FRIDAY_RECAP_MISSION,
  timezoneFromEnv,
} from './missions/recap.js';
import { notifyOwner } from './telegram/notify.js';

const USAGE = `buddi missions — scheduled missions

  buddi missions list                     every mission, its schedule and next run
  buddi missions add-friday-recap         register (or refresh) the weekly recap
  buddi missions run-now <id>             queue an occurrence for now
  buddi missions run-now <id> --inline    run it here and print the text
  buddi missions enable <id>
  buddi missions disable <id>

Timezone comes from BUDDI_TZ (default America/New_York).`;

export type MissionsCommand =
  | 'list'
  | 'add-friday-recap'
  | 'run-now'
  | 'enable'
  | 'disable'
  | 'help';

export type ParsedMissionsArgs = {
  command: MissionsCommand;
  missionId?: string;
  inline: boolean;
};

/**
 * Pure argument parsing — the only part of this CLI worth a unit test.
 * `pnpm missions run-now x -- --inline` passes the separator through; ignore it.
 */
export function parseMissionsArgs(argv: string[]): ParsedMissionsArgs {
  const [raw, ...rest] = argv;
  const commands: MissionsCommand[] = [
    'list',
    'add-friday-recap',
    'run-now',
    'enable',
    'disable',
  ];
  const command = commands.find((c) => c === raw) ?? 'help';
  const parsed: ParsedMissionsArgs = { command, inline: false };
  for (const arg of rest) {
    if (arg === '--') continue;
    if (arg === '--inline') {
      parsed.inline = true;
      continue;
    }
    if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
    if (parsed.missionId !== undefined) {
      throw new Error(`unexpected argument: ${arg}`);
    }
    parsed.missionId = arg;
  }
  if (
    (command === 'run-now' || command === 'enable' || command === 'disable') &&
    parsed.missionId === undefined
  ) {
    throw new Error(`buddi missions ${command} needs a mission id`);
  }
  if (parsed.inline && command !== 'run-now') {
    throw new Error('--inline only applies to run-now');
  }
  return parsed;
}

/* ------------------------------------------------------------------ *
 * Occurrences created by hand
 * ------------------------------------------------------------------ */

const OCCURRENCE_COLUMNS =
  'id, mission_id, schedule_revision, scheduled_at, state, claimed_at, finished_at, run_conversation_id, error';

/**
 * Insert a manual occurrence. The unique key is
 * (mission_id, schedule_revision, scheduled_at), so a second run in the same
 * second returns the existing row rather than a duplicate.
 */
export async function insertOccurrence(
  pool: Pool,
  missionId: string,
  revision: number,
  at: Date,
  state: OccurrenceState,
): Promise<Occurrence> {
  const { rows } = await pool.query(
    `insert into core.occurrences (mission_id, schedule_revision, scheduled_at, state, claimed_at)
     values ($1, $2, $3, $4, case when $4 = 'claimed' then now() else null end)
     on conflict (mission_id, schedule_revision, scheduled_at) do update
       set state = excluded.state, claimed_at = excluded.claimed_at
     returning ${OCCURRENCE_COLUMNS}`,
    [missionId, revision, at.toISOString(), state],
  );
  return toOccurrence(rows[0]);
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

async function commandList(pool: Pool, now: Date): Promise<void> {
  const missions = await listMissions(pool);
  if (missions.length === 0) {
    console.log('no missions registered (buddi missions add-friday-recap)');
    return;
  }
  for (const mission of missions) {
    const spec = await getActiveSchedule(pool, mission.id);
    const history = await listOccurrences(pool, mission.id, 1);
    const last = history[0];
    console.log(`${mission.id} — ${mission.name}`);
    console.log(`  agent: ${mission.agentId}`);
    console.log(`  enabled: ${mission.enabled}`);
    if (spec) {
      const next = mission.enabled ? nextAfter(spec.cron, now, spec.timezone) : null;
      console.log(
        `  schedule: ${spec.cron} ${spec.timezone} (rev ${spec.revision}, misfire ${spec.misfirePolicy})`,
      );
      console.log(
        `  next run: ${next ? next.toISOString() : mission.enabled ? '(never)' : '(disabled)'}`,
      );
    } else {
      console.log('  schedule: (none)');
    }
    console.log(
      `  last occurrence: ${
        last
          ? `${last.scheduledAt.toISOString()} ${last.state}${last.error ? ` — ${last.error}` : ''}`
          : '(none)'
      }`,
    );
  }
}

async function commandAddFridayRecap(pool: Pool, env: NodeJS.ProcessEnv): Promise<void> {
  const timezone = timezoneFromEnv(env);
  const mission = await upsertMission(pool, FRIDAY_RECAP_MISSION);
  const existing = await getActiveSchedule(pool, mission.id);
  if (
    existing &&
    existing.cron === FRIDAY_RECAP_CRON &&
    existing.timezone === timezone &&
    existing.misfirePolicy === 'coalesce'
  ) {
    console.log(
      `mission ${mission.id} up to date (${existing.cron} ${existing.timezone}, rev ${existing.revision})`,
    );
    return;
  }
  const spec = await setSchedule(pool, mission.id, {
    cron: FRIDAY_RECAP_CRON,
    timezone,
    misfirePolicy: 'coalesce',
  });
  console.log(
    `mission ${mission.id} registered: ${spec.cron} ${spec.timezone} (rev ${spec.revision}, misfire ${spec.misfirePolicy})`,
  );
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

export async function main(): Promise<void> {
  let args: ParsedMissionsArgs;
  try {
    args = parseMissionsArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (args.command === 'help') {
    console.log(USAGE);
    return;
  }

  loadEnv();
  let wiring;
  try {
    wiring = createWiring(process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  const { pool, now } = wiring;

  try {
    if (args.command === 'list') {
      await commandList(pool, now());
      return;
    }
    if (args.command === 'add-friday-recap') {
      await commandAddFridayRecap(pool, process.env);
      return;
    }

    const missionId = args.missionId as string;
    if (args.command === 'enable' || args.command === 'disable') {
      const updated = await setMissionEnabled(pool, missionId, args.command === 'enable');
      if (!updated) {
        console.error(`no such mission "${missionId}"`);
        process.exitCode = 1;
        return;
      }
      console.log(`mission ${updated.id} ${updated.enabled ? 'enabled' : 'disabled'}`);
      return;
    }

    // run-now
    const mission = await getMission(pool, missionId);
    if (!mission) {
      console.error(`no such mission "${missionId}" (buddi missions list)`);
      process.exitCode = 1;
      return;
    }
    const spec = await getActiveSchedule(pool, mission.id);
    const revision = spec?.revision ?? 0;

    if (!args.inline) {
      const occurrence = await insertOccurrence(pool, mission.id, revision, now(), 'pending');
      console.log(
        `queued occurrence ${occurrence.id} for ${mission.id} at ${occurrence.scheduledAt.toISOString()} — the scheduler will pick it up (pnpm serve)`,
      );
      return;
    }

    const occurrence = await insertOccurrence(pool, mission.id, revision, now(), 'claimed');
    const execute = createMissionExecutor({
      pool,
      registry: wiring.registry,
      provider: wiring.provider,
      ctx: wiring.ctx,
      env: process.env,
      now,
      deliver: (text) => notifyOwner(text, { pool, env: process.env }),
      requireDelivery: false,
      onToolCall: (name, input) => console.error(`⚙ ${name} ${JSON.stringify(input)}`),
    });

    try {
      const result = await execute(occurrence, mission);
      await finishOccurrence(pool, occurrence.id, {
        state: 'succeeded',
        runConversationId: result.conversationId,
      });
      console.log(`\n--- ${mission.id} (${result.text.length} chars) ---\n`);
      console.log(result.text);
      console.log(
        `\n--- ${
          result.delivered
            ? `delivered to chat ${result.chatId}`
            : `delivery skipped: ${result.skipped}`
        } ---`,
      );
      console.log(`conversation: ${result.conversationId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finishOccurrence(pool, occurrence.id, { state: 'failed', error: message });
      throw err;
    }
  } finally {
    await pool.end();
  }
}

if (invokedDirectly()) {
  main().catch((err) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    process.exit(1);
  });
}
