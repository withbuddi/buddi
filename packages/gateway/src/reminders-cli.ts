/**
 * `buddi reminders` — the owner's view of what the agents put on the clock.
 *
 * An agent can now ask to be woken later. That is only acceptable if the owner
 * can see every such promise and end any of it from one command, without
 * knowing which agent made it — which is all this file is.
 */
import {
  cancelReminder,
  listReminders,
  localDateTimeString,
  timezoneFromEnv,
  type Reminder,
} from '@buddi/core';
import type { Pool } from 'pg';
import { createWiringAsync, loadEnvironment } from './bootstrap.js';

export const USAGE = `buddi reminders — one-off nudges the agents set

  buddi reminders                 every pending reminder, soonest first
  buddi reminders --agent <id>    just that agent's
  buddi reminders --all           include fired, cancelled and expired ones
  buddi reminders cancel <id>     cancel a pending one`;

export type RemindersCommand =
  | { action: 'list'; agentId?: string; all: boolean }
  | { action: 'cancel'; id: string }
  | { action: 'help' };

/** Pure argument parsing — the only part worth a unit test. */
export function parseRemindersArgs(argv: string[]): RemindersCommand {
  const [head, ...rest] = argv;
  if (head === 'help' || head === '--help' || head === '-h') return { action: 'help' };

  if (head === 'cancel') {
    const id = rest[0];
    if (!id) throw new Error('buddi reminders cancel needs a reminder id');
    if (rest.length > 1) throw new Error(`unexpected argument: ${rest[1]}`);
    return { action: 'cancel', id };
  }

  const argv2 = head === undefined ? [] : argv;
  const command: { action: 'list'; agentId?: string; all: boolean } = { action: 'list', all: false };
  for (let i = 0; i < argv2.length; i += 1) {
    const arg = argv2[i] as string;
    if (arg === '--all') {
      command.all = true;
      continue;
    }
    if (arg === '--agent') {
      const value = argv2[i + 1];
      if (value === undefined) throw new Error('--agent needs an agent id');
      i += 1;
      command.agentId = value;
      continue;
    }
    throw new Error(`unknown option for buddi reminders: ${arg}`);
  }
  return command;
}

/** One reminder as a line the owner can act on: the id comes first. */
export function formatReminder(reminder: Reminder, timezone: string): string {
  const state = reminder.state === 'pending' ? '' : ` [${reminder.state}]`;
  const lines = [
    `${reminder.id}${state}`,
    `  due:   ${localDateTimeString(reminder.dueAt, timezone)}`,
    `  agent: ${reminder.agentId}`,
    `  text:  ${reminder.text}`,
  ];
  if (reminder.cancelReason) lines.push(`  why:   ${reminder.cancelReason}`);
  return lines.join('\n');
}

export async function listCommand(
  pool: Pool,
  timezone: string,
  opts: { agentId?: string; all: boolean },
): Promise<void> {
  const reminders = await listReminders(pool, {
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.all ? {} : { state: 'pending' as const }),
    limit: 200,
  });
  if (reminders.length === 0) {
    console.log(
      opts.all ? 'no reminders' : 'no pending reminders (buddi reminders --all for the history)',
    );
    return;
  }
  for (const reminder of reminders) console.log(formatReminder(reminder, timezone));
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  let command: RemindersCommand;
  try {
    command = parseRemindersArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
    return;
  }
  if (command.action === 'help') {
    console.log(USAGE);
    return;
  }

  await loadEnvironment();
  const wiring = await createWiringAsync(process.env);
  const { pool } = wiring;
  const timezone = timezoneFromEnv(process.env);
  try {
    if (command.action === 'list') {
      await listCommand(pool, timezone, {
        ...(command.agentId ? { agentId: command.agentId } : {}),
        all: command.all,
      });
      return;
    }
    const cancelled = await cancelReminder(pool, command.id, 'cancelled by the owner (buddi reminders)');
    if (!cancelled) {
      console.error(`no pending reminder ${command.id}`);
      process.exitCode = 1;
      return;
    }
    console.log(`cancelled ${cancelled.id} — ${cancelled.text}`);
  } finally {
    await pool.end();
  }
}
