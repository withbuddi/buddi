/**
 * The owner's mail settings, readable and writable from a chat.
 *
 * There is one setting today — how many days a message body is kept — and it is
 * a preference, not an effect: it writes one row in this plugin's own schema and
 * nothing leaves the machine, so both tools sit at tier `auto`. Changing it does
 * not purge anything on the spot; the daily `email.retention` pass is what acts
 * on it, and a *longer* window never brings back a body that is already gone.
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

const getInput = z.object({});

/** Counts that make the setting concrete when the owner asks about it. */
async function summarise(
  db: Parameters<typeof loadSettings>[0],
): Promise<{ retentionDays: number; default: number; purgedMessages: number }> {
  const settings = await loadSettings(db);
  const { rows } = await db.query<{ n: string }>(
    `select count(*)::int as n from email.messages where body_purged_at is not null`,
  );
  return {
    retentionDays: settings.retentionDays,
    default: DEFAULT_RETENTION_DAYS,
    purgedMessages: Number(rows[0]?.n ?? 0),
  };
}

export const getSettings: ToolDefinition<z.infer<typeof getInput>, unknown> = {
  name: 'email.get_settings',
  description:
    "Read the owner's mail settings: how many days a message body is kept before it is purged (default 90), and how many messages have already had their body purged. Headers, the snippet and triage decisions are kept forever and are not affected.",
  tier: 'auto',
  input: getInput,
  async execute(_input, ctx) {
    return summarise(ctx.db);
  },
};

const setInput = z.object({
  retentionDays: z
    .number()
    .int()
    .min(MIN_RETENTION_DAYS)
    .max(MAX_RETENTION_DAYS)
    .describe(
      `How many days to keep message bodies before purging them (default ${DEFAULT_RETENTION_DAYS}, between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS}).`,
    ),
});

export const setSettings: ToolDefinition<z.infer<typeof setInput>, unknown> = {
  name: 'email.set_settings',
  description:
    'Set how many days message bodies are kept before they are purged. Headers, snippets and triage decisions are always kept. Shortening the window takes effect on the next daily pass; lengthening it cannot bring back a body that was already purged.',
  tier: 'auto',
  input: setInput,
  async execute(input, ctx) {
    await setRetentionDays(ctx.db, input.retentionDays, ctx.now());
    return summarise(ctx.db);
  },
};
