#!/usr/bin/env node
/**
 * `buddi missions` — mission registration and manual runs.
 *
 * Registration is idempotent: `add-recap` upserts the mission and points
 * it at a fresh schedule revision, so running it twice leaves one mission and
 * one active schedule. `run-now` writes a pending occurrence and lets the
 * scheduler claim it in the normal way; `--inline` runs it here instead, prints
 * the delivered text, and — unlike a scheduled run — reports an unpaired owner
 * chat as a skipped delivery rather than a failure.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CLI_SURFACE,
  finishOccurrence,
  getActiveSchedule,
  getMission,
  listMissions,
  listOccurrences,
  nextAfter,
  registerChannel,
  renderOffers,
  setMissionEnabled,
  toOccurrence,
  type Occurrence,
  type OccurrenceState,
} from '@buddi/core';
import type { Pool } from 'pg';
import { gatewayCatalog } from './agents/catalog.js';
import { createWiringAsync, loadEnvironment } from './bootstrap.js';
import {
  addDefaultMissions,
  planDefaultMissions,
  registerDefault,
  type RegistrationOutcome,
} from './missions/defaults.js';
import { createMissionExecutor } from './missions/execute.js';
import { missionOwnerAgent } from './missions/reminders.js';
import { createDigestPrepare, recapMissionId, timezoneFromEnv } from './missions/recap.js';
import { ownerDeliver } from './owner-notify.js';
import { createTelegramChannel } from './telegram/channel.js';
import { createLocalNotificationChannel } from './channels/local-notification.js';

const USAGE = `buddi missions — scheduled missions

  buddi missions list [--json]            every mission, its schedule and next run
  buddi missions add-defaults             register every mission the installed plugins suggest
  buddi missions add-recap                register (or refresh) the recap mission
  buddi missions add-friday-recap         the same, under its older name
  buddi missions run-now <id>             queue an occurrence for now
  buddi missions run-now <id> --inline    run it here and print the text
  buddi missions enable <id>
  buddi missions disable <id>

Timezone comes from BUDDI_TZ (default America/New_York).`;

export type MissionsCommand =
  | 'list'
  | 'add-defaults'
  | 'add-recap'
  | 'add-friday-recap'
  | 'run-now'
  | 'enable'
  | 'disable'
  | 'help';

export type ParsedMissionsArgs = {
  command: MissionsCommand;
  missionId?: string;
  inline: boolean;
  /** `list --json`. */
  json?: boolean;
};

/**
 * Pure argument parsing — the only part of this CLI worth a unit test.
 * `pnpm missions run-now x -- --inline` passes the separator through; ignore it.
 */
export function parseMissionsArgs(argv: string[]): ParsedMissionsArgs {
  const [raw, ...rest] = argv;
  const commands: MissionsCommand[] = [
    'list',
    'add-defaults',
    'add-recap',
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
    if (arg === '--json') {
      parsed.json = true;
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
  if (parsed.json && command !== 'list') {
    throw new Error('--json only applies to list');
  }
  return parsed;
}

/* ------------------------------------------------------------------ *
 * Occurrences created by hand
 * ------------------------------------------------------------------ */

const OCCURRENCE_COLUMNS =
  'id, mission_id, schedule_revision, scheduled_at, state, claimed_at, finished_at, run_conversation_id, error, payload';

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
  payload?: unknown,
): Promise<Occurrence> {
  const { rows } = await pool.query(
    `insert into core.occurrences (mission_id, schedule_revision, scheduled_at, state, claimed_at, payload)
     values ($1, $2, $3, $4, case when $4 = 'claimed' then now() else null end, $5::jsonb)
     on conflict (mission_id, schedule_revision, scheduled_at) do update
       set state = excluded.state,
           claimed_at = excluded.claimed_at,
           payload = coalesce(excluded.payload, core.occurrences.payload)
     returning ${OCCURRENCE_COLUMNS}`,
    [
      missionId,
      revision,
      at.toISOString(),
      state,
      payload === undefined ? null : JSON.stringify(payload),
    ],
  );
  return toOccurrence(rows[0]);
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/**
 * The last time this mission either spoke or deliberately did not.
 *
 * Read from the event log rather than a column on the mission: "it stayed
 * silent because the projection holds" is a fact about a run, and facts about
 * runs live in `core.events`.
 */
export async function lastNotification(
  pool: Pool,
  missionId: string,
): Promise<{ kind: string; at: Date; reason?: string; chars?: number } | null> {
  const { rows } = await pool.query(
    `select kind, payload, created_at from core.events
     where kind in ('mission.delivered', 'mission.silent')
       and payload->>'missionId' = $1
     order by created_at desc
     limit 1`,
    [missionId],
  );
  const row = rows[0];
  if (!row) return null;
  const payload = (row.payload ?? {}) as { reason?: string; chars?: number };
  return {
    kind: row.kind,
    at: row.created_at,
    ...(payload.reason ? { reason: payload.reason } : {}),
    ...(typeof payload.chars === 'number' ? { chars: payload.chars } : {}),
  };
}

async function commandList(pool: Pool, now: Date, json = false): Promise<void> {
  const missions = await listMissions(pool);
  if (json) {
    const rows = [];
    for (const mission of missions) {
      const spec = await getActiveSchedule(pool, mission.id);
      const last = (await listOccurrences(pool, mission.id, 1))[0];
      const notification = await lastNotification(pool, mission.id);
      const next = spec && mission.enabled ? nextAfter(spec.cron, now, spec.timezone) : null;
      rows.push({
        id: mission.id,
        name: mission.name,
        agentId: mission.agentId,
        enabled: mission.enabled,
        alwaysDeliver: mission.alwaysDeliver,
        proposedBy: missionOwnerAgent(mission.id) ?? null,
        schedule: spec
          ? { cron: spec.cron, timezone: spec.timezone, revision: spec.revision, misfirePolicy: spec.misfirePolicy }
          : null,
        nextRunAt: next ? next.toISOString() : null,
        lastOccurrence: last
          ? { scheduledAt: last.scheduledAt.toISOString(), state: last.state, error: last.error ?? null }
          : null,
        lastNotification: notification ? { ...notification, at: notification.at.toISOString() } : null,
      });
    }
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (missions.length === 0) {
    console.log('no missions registered (buddi missions add-defaults)');
    return;
  }
  for (const mission of missions) {
    const spec = await getActiveSchedule(pool, mission.id);
    const history = await listOccurrences(pool, mission.id, 1);
    const last = history[0];
    // A mission whose id carries `agent:<id>:` was proposed by that agent and
    // approved by the owner, not typed by the owner. Saying so is the whole
    // point of the marker: the list must never blur the two.
    const proposedBy = missionOwnerAgent(mission.id);
    console.log(
      `${mission.id} — ${mission.name}${proposedBy ? ` [proposed by ${proposedBy}, approved by you]` : ''}`,
    );
    console.log(`  agent: ${mission.agentId}`);
    console.log(`  enabled: ${mission.enabled}`);
    console.log(
      `  always deliver: ${mission.alwaysDeliver}${
        mission.alwaysDeliver ? '' : ' (speaks only when it calls mission.report)'
      }`,
    );
    if (spec) {
      const next = mission.enabled ? nextAfter(spec.cron, now, spec.timezone) : null;
      console.log(
        `  schedule: ${spec.cron} ${spec.timezone} (rev ${spec.revision}, misfire ${spec.misfirePolicy})`,
      );
      console.log(
        `  next run: ${next ? next.toISOString() : mission.enabled ? '(never)' : '(disabled)'}`,
      );
    } else {
      console.log('  schedule: (none — enqueued, never scheduled)');
    }
    console.log(
      `  last occurrence: ${
        last
          ? `${last.scheduledAt.toISOString()} ${last.state}${last.error ? ` — ${last.error}` : ''}`
          : '(none)'
      }`,
    );
    const notification = await lastNotification(pool, mission.id);
    console.log(
      `  last notification: ${
        notification
          ? notification.kind === 'mission.delivered'
            ? `delivered ${notification.at.toISOString()} (${notification.chars ?? 0} chars)`
            : `silent ${notification.at.toISOString()} — ${notification.reason ?? '(no reason)'}`
          : '(none)'
      }`,
    );
  }
}

function describeOutcome(outcome: RegistrationOutcome): string {
  if (outcome.schedule === 'skipped') {
    return `mission ${outcome.missionId} skipped — ${outcome.reason}`;
  }
  if (outcome.schedule === 'none') {
    return `mission ${outcome.missionId} registered (no schedule — enqueued on demand)`;
  }
  if (outcome.schedule === 'up-to-date') {
    return `mission ${outcome.missionId} up to date (${outcome.cron} ${outcome.timezone}, rev ${outcome.revision})`;
  }
  return `mission ${outcome.missionId} registered: ${outcome.cron} ${outcome.timezone} (rev ${outcome.revision})`;
}

/**
 * `add-recap` — just the recap mission, whichever one this installation's
 * plugins suggest for the `recap` role. Nothing here names a domain.
 */
async function commandAddRecap(pool: Pool, env: NodeJS.ProcessEnv): Promise<void> {
  const missionId = recapMissionId();
  const plan = planDefaultMissions(gatewayCatalog(env));
  const entry = plan.entries.find((e) => e.mission.id === missionId);
  if (!entry) {
    const skipped = plan.skipped.find((s) => s.missionId === missionId);
    console.error(
      skipped
        ? `recap mission ${skipped.missionId} skipped: ${skipped.reason}`
        : 'no installed plugin suggests a recap mission for the "recap" role',
    );
    process.exitCode = 1;
    return;
  }
  console.log(describeOutcome(await registerDefault(pool, entry, timezoneFromEnv(env))));
}

async function commandAddDefaults(pool: Pool, env: NodeJS.ProcessEnv): Promise<void> {
  const outcomes = await addDefaultMissions(pool, env);
  if (outcomes.length === 0) {
    console.log('no installed plugin suggests a mission, and nothing was registered');
    return;
  }
  for (const outcome of outcomes) {
    console.log(describeOutcome(outcome));
  }
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

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let args: ParsedMissionsArgs;
  try {
    args = parseMissionsArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  if (args.command === 'help') {
    console.log(USAGE);
    return;
  }

  await loadEnvironment();
  let wiring;
  try {
    wiring = await createWiringAsync(process.env);
  } catch (err) {
    // No database to read missions from: something the owner has to start.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(3);
  }
  const { pool, now } = wiring;

  try {
    if (args.command === 'list') {
      await commandList(pool, now(), args.json === true);
      return;
    }
    if (args.command === 'add-recap' || args.command === 'add-friday-recap') {
      await commandAddRecap(pool, process.env);
      return;
    }
    if (args.command === 'add-defaults') {
      await commandAddDefaults(pool, process.env);
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

    if (process.env.TELEGRAM_BOT_TOKEN?.trim()) registerChannel(createTelegramChannel({ pool, env: process.env }));
    const localChannel = createLocalNotificationChannel();
    if (localChannel) registerChannel(localChannel);
    const occurrence = await insertOccurrence(pool, mission.id, revision, now(), 'claimed');
    const execute = createMissionExecutor({
      pool,
      registry: wiring.registry,
      provider: wiring.provider,
      providerFor: wiring.providerFor,
      ctx: wiring.ctx,
      env: process.env,
      now,
      // Through the owner's notifications like any report; strict, so a
      // message no channel took is printed as a skipped delivery. This
      // process registers Telegram's text path itself: it is not `serve`.
      deliver: ownerDeliver(pool, { now, timezone: timezoneFromEnv(), strict: true }),
      requireDelivery: false,
      prepare: createDigestPrepare(pool, { now }),
      onToolCall: (name, input) => console.error(`⚙ ${name} ${JSON.stringify(input)}`),
    });

    try {
      const result = await execute(occurrence, mission);
      await finishOccurrence(pool, occurrence.id, {
        state: 'succeeded',
        runConversationId: result.conversationId,
      });
      console.log(`\n--- ${mission.id} (${result.text.length} chars) ---\n`);
      // The terminal has nothing to tap, and `CLI_SURFACE` is what says so.
      // Rendering goes through the same function every other surface uses, so
      // the owner reads the offers as words rather than losing them entirely.
      console.log(renderOffers(CLI_SURFACE, result.text, result.offers ?? []).text);
      const outcome = result.delivered
        ? `delivered (${result.chatId})`
        : result.skipped
          ? `delivery skipped: ${result.skipped}`
          : `nothing delivered (${result.decision}${result.reason ? `: ${result.reason}` : ''})`;
      console.log(`\n--- ${outcome} ---`);
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
