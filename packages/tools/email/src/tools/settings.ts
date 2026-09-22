/**
 * The owner's mail settings, readable and writable from a chat.
 *
 * Six settings now, and every one of them is a preference rather than an
 * effect: each writes one row in this plugin's own schema and nothing leaves
 * the machine, so both tools sit at tier `auto`.
 *
 *  - `retentionDays` — how long a message body is kept. Changing it purges
 *    nothing on the spot; the daily `email.retention` pass acts on it, and a
 *    *longer* window never brings back a body that is already gone.
 *
 * And the five the watchers read (docs/specs/email.md §7), one per watcher that
 * has a number to be told:
 *
 *  - `waitingDays` — how long a conversation may wait on the owner before
 *    `email.waiting-on-me` says so.
 *  - `dateConfidence` — how sure the date parser has to be before
 *    `email.date-stated` raises a finding.
 *  - `promisedDays` — how long a promise of the owner's, or a draft written for
 *    him, may sit unsent before `email.promised-reply` says so.
 *  - `receiptConfidence` — how sure the classifier has to be before
 *    `email.receipt-or-bill` calls something a receipt.
 *  - `nudgeDays` — how long the owner waits for an answer before
 *    `email.unanswered-by-them` offers to draft a nudge.
 *
 * The watcher settings change what the *watchers* do on their next tick.
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
  DEFAULT_NUDGE_DAYS,
  DEFAULT_PROMISED_DAYS,
  DEFAULT_RECEIPT_CONFIDENCE,
  DEFAULT_WAITING_DAYS,
  MAX_DATE_CONFIDENCE,
  MAX_NUDGE_DAYS,
  MAX_PROMISED_DAYS,
  MAX_RECEIPT_CONFIDENCE,
  MAX_WAITING_DAYS,
  MIN_DATE_CONFIDENCE,
  MIN_NUDGE_DAYS,
  MIN_PROMISED_DAYS,
  MIN_RECEIPT_CONFIDENCE,
  MIN_WAITING_DAYS,
  loadWatcherSettings,
  setWatcherSettings,
  type WatcherSettingsPatch,
} from '../watchers.js';

const getInput = z.object({});

/** Counts that make the settings concrete when the owner asks about them. */
async function summarise(db: Parameters<typeof loadSettings>[0]): Promise<{
  retentionDays: number;
  default: number;
  purgedMessages: number;
  waitingDays: number;
  dateConfidence: number;
  promisedDays: number;
  receiptConfidence: number;
  nudgeDays: number;
  defaults: {
    retentionDays: number;
    waitingDays: number;
    dateConfidence: number;
    promisedDays: number;
    receiptConfidence: number;
    nudgeDays: number;
  };
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
    promisedDays: watchers.promisedDays,
    receiptConfidence: watchers.receiptConfidence,
    nudgeDays: watchers.nudgeDays,
    defaults: {
      retentionDays: DEFAULT_RETENTION_DAYS,
      waitingDays: DEFAULT_WAITING_DAYS,
      dateConfidence: DEFAULT_DATE_CONFIDENCE,
      promisedDays: DEFAULT_PROMISED_DAYS,
      receiptConfidence: DEFAULT_RECEIPT_CONFIDENCE,
      nudgeDays: DEFAULT_NUDGE_DAYS,
    },
  };
}

export const getSettings: ToolDefinition<z.infer<typeof getInput>, unknown> = {
  name: 'email.get_settings',
  description:
    "Read the owner's mail settings: how many days a message body is kept before it is purged (default 90), " +
    'how many messages have already had their body purged, and the five watcher settings — how long a ' +
    'conversation may wait on the owner (default 2 days), how sure the date parser must be (default 0.6), ' +
    'how long a promise or an unsent draft may sit (default 3 days), how sure the receipt classifier must be ' +
    '(default 0.7), and how long the owner waits for an answer before a nudge is offered (default 5 days). ' +
    'Headers, the snippet and triage decisions are kept forever and are not affected by any of them.',
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
    promisedDays: z
      .number()
      .int()
      .min(MIN_PROMISED_DAYS)
      .max(MAX_PROMISED_DAYS)
      .optional()
      .describe(
        `How many days a promise of yours, or a draft written for you, may sit unsent before the promised-reply watcher reports it (default ${DEFAULT_PROMISED_DAYS}, between ${MIN_PROMISED_DAYS} and ${MAX_PROMISED_DAYS}). A week or more is reported as urgent whatever this says.`,
      ),
    receiptConfidence: z
      .number()
      .min(MIN_RECEIPT_CONFIDENCE)
      .max(MAX_RECEIPT_CONFIDENCE)
      .optional()
      .describe(
        `How sure the classifier must be before a message is reported as a receipt or a bill (default ${DEFAULT_RECEIPT_CONFIDENCE}, between ${MIN_RECEIPT_CONFIDENCE} and ${MAX_RECEIPT_CONFIDENCE}). "Invoice" in the subject with a total beside it scores about 0.95; "your order" in a body alone scores 0.4.`,
      ),
    nudgeDays: z
      .number()
      .int()
      .min(MIN_NUDGE_DAYS)
      .max(MAX_NUDGE_DAYS)
      .optional()
      .describe(
        `How many days you wait for an answer before the unanswered-by-them watcher offers to draft a nudge (default ${DEFAULT_NUDGE_DAYS}, between ${MIN_NUDGE_DAYS} and ${MAX_NUDGE_DAYS}). It never sends one.`,
      ),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Name at least one setting to change.',
  });

export const setSettings: ToolDefinition<z.infer<typeof setInput>, unknown> = {
  name: 'email.set_settings',
  description:
    'Change one or more of the mail settings: how long message bodies are kept, and the five numbers the ' +
    'watchers read — the waiting window, the date confidence, the promise window, the receipt confidence and ' +
    'the nudge window. Headers, snippets and triage decisions are always kept. Shortening the retention ' +
    'window takes effect on the next daily pass; lengthening it cannot bring back a body that was already ' +
    'purged. The watcher settings take effect on the next tick of the watcher they belong to.',
  tier: 'auto',
  input: setInput,
  async execute(input, ctx) {
    if (input.retentionDays !== undefined) {
      await setRetentionDays(ctx.db, input.retentionDays, ctx.now());
    }
    const patch: WatcherSettingsPatch = {
      ...(input.waitingDays === undefined ? {} : { waitingDays: input.waitingDays }),
      ...(input.dateConfidence === undefined ? {} : { dateConfidence: input.dateConfidence }),
      ...(input.promisedDays === undefined ? {} : { promisedDays: input.promisedDays }),
      ...(input.receiptConfidence === undefined
        ? {}
        : { receiptConfidence: input.receiptConfidence }),
      ...(input.nudgeDays === undefined ? {} : { nudgeDays: input.nudgeDays }),
    };
    if (Object.keys(patch).length > 0) {
      await setWatcherSettings(ctx.db, patch, ctx.now());
    }
    return summarise(ctx.db);
  },
};
