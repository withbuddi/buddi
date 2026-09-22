/**
 * The owner's mail settings, readable and writable from a chat.
 *
 * Three settings now, and all three are preferences rather than effects: each
 * writes one row in this plugin's own schema and nothing leaves the machine, so
 * both tools sit at tier `auto`.
 *
 *  - `retentionDays` — how long a message body is kept. Changing it purges
 *    nothing on the spot; the daily `email.retention` pass acts on it, and a
 *    *longer* window never brings back a body that is already gone.
 *  - `waitingDays` — how long a conversation may wait on the owner before
 *    `email.waiting-on-me` says so (docs/specs/email.md §7).
 *  - `dateConfidence` — how sure the date parser has to be before
 *    `email.date-stated` raises a finding.
 *
 * The two watcher settings change what the *watchers* do on their next tick.
 * Nothing here runs a watcher, and nothing here speaks to the owner.
 */
import type { ToolDefinition } from '@buddi/core';
import { z } from 'zod';
import {
  DEFAULT_RETENTION_DAYS,
  loadSettings,
  MAX_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  setRetentionDays,
} from '../retention.js';
import {
  DEFAULT_DATE_CONFIDENCE,
  DEFAULT_WAITING_DAYS,
  MAX_DATE_CONFIDENCE,
  MAX_WAITING_DAYS,
  MIN_DATE_CONFIDENCE,
  MIN_WAITING_DAYS,
  loadWatcherSettings,
  setWatcherSettings,
} from '../watchers.js';

const getInput = z.object({});

/** Counts that make the settings concrete when the owner asks about them. */
async function summarise(db: Parameters<typeof loadSettings>[0]): Promise<{
  retentionDays: number;
  default: number;
  purgedMessages: number;
  waitingDays: number;
  dateConfidence: number;
  defaults: { retentionDays: number; waitingDays: number; dateConfidence: number };
}> {
  const settings = await loadSettings(db);
  const watchers = await loadWatcherSettings(db);
  const { rows } = await db.query<{ n: string }>(
    `select count(*)::int as n from email.messages where body_purged_at is not null`,
  );
  return {
    retentionDays: settings.retentionDays,
    default: DEFAULT_RETENTION_DAYS,
    purgedMessages: Number(rows[0]?.n ?? 0),
    waitingDays: watchers.waitingDays,
    dateConfidence: watchers.dateConfidence,
    defaults: {
      retentionDays: DEFAULT_RETENTION_DAYS,
      waitingDays: DEFAULT_WAITING_DAYS,
      dateConfidence: DEFAULT_DATE_CONFIDENCE,
    },
  };
}

export const getSettings: ToolDefinition<z.infer<typeof getInput>, unknown> = {
  name: 'email.get_settings',
  description:
    "Read the owner's mail settings: how many days a message body is kept before it is purged (default 90), " +
    'how many messages have already had their body purged, and the two watcher settings — how many days a ' +
    'conversation may wait on the owner before the waiting-on-me watcher reports it (default 2), and how sure ' +
    'the date parser must be before a stated date raises a finding (default 0.6). Headers, the snippet and ' +
    'triage decisions are kept forever and are not affected by any of them.',
  tier: 'auto',
  input: getInput,
  async execute(_input, ctx) {
    return summarise(ctx.db);
  },
};

const setInput = z
  .object({
    retentionDays: z
      .number()
      .int()
      .min(MIN_RETENTION_DAYS)
      .max(MAX_RETENTION_DAYS)
      .optional()
      .describe(
        `How many days to keep message bodies before purging them (default ${DEFAULT_RETENTION_DAYS}, between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}).`,
      ),
    waitingDays: z
      .number()
      .int()
      .min(MIN_WAITING_DAYS)
      .max(MAX_WAITING_DAYS)
      .optional()
      .describe(
        `How many days a conversation may wait on the owner before the waiting-on-me watcher reports it (default ${DEFAULT_WAITING_DAYS}, between ${MIN_WAITING_DAYS} and ${MAX_WAITING_DAYS}). A week or more is reported as urgent whatever this says.`,
      ),
    dateConfidence: z
      .number()
      .min(MIN_DATE_CONFIDENCE)
      .max(MAX_DATE_CONFIDENCE)
      .optional()
      .describe(
        `How sure the date parser must be before a stated date raises a finding (default ${DEFAULT_DATE_CONFIDENCE}, between ${MIN_DATE_CONFIDENCE} and ${MAX_DATE_CONFIDENCE}). An unambiguous date with "deadline" beside it scores about 0.8; a bare "9/8" scores 0.3.`,
      ),
  })
  .refine(
    (input) =>
      input.retentionDays !== undefined ||
      input.waitingDays !== undefined ||
      input.dateConfidence !== undefined,
    { message: 'Name at least one setting to change.' },
  );

export const setSettings: ToolDefinition<z.infer<typeof setInput>, unknown> = {
  name: 'email.set_settings',
  description:
    'Change one or more of the mail settings: how long message bodies are kept, how long a conversation may ' +
    'wait on the owner before the waiting-on-me watcher reports it, and how sure the date parser must be. ' +
    'Headers, snippets and triage decisions are always kept. Shortening the retention window takes effect on ' +
    'the next daily pass; lengthening it cannot bring back a body that was already purged. The watcher ' +
    'settings take effect on the next tick of the watcher they belong to.',
  tier: 'auto',
  input: setInput,
  async execute(input, ctx) {
    if (input.retentionDays !== undefined) {
      await setRetentionDays(ctx.db, input.retentionDays, ctx.now());
    }
    if (input.waitingDays !== undefined || input.dateConfidence !== undefined) {
      await setWatcherSettings(
        ctx.db,
        {
          ...(input.waitingDays === undefined ? {} : { waitingDays: input.waitingDays }),
          ...(input.dateConfidence === undefined ? {} : { dateConfidence: input.dateConfidence }),
        },
        ctx.now(),
      );
    }
    return summarise(ctx.db);
  },
};
