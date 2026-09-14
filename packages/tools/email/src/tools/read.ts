/**
 * Reading mail: list, read, search.
 *
 * Tier `auto`, and legitimately so — every one of these is a read over rows the
 * source already ingested. Nothing here touches IMAP, so nothing here can set a
 * flag: "read mail must not mutate flags" is enforced by the ingest path being
 * the only thing that talks to a mailbox at all.
 *
 * What comes back is *quoted evidence*, not instructions. A message body is
 * attacker-controlled text; the persona is what holds that line, and these
 * tools simply never dress it up as anything else.
 */
import type { ToolDefinition } from '@buddi/core';
import { z } from 'zod';
import { isUnread } from '../mail.js';
import { loadSettings, purgedBodyNote } from '../retention.js';
import { MESSAGE_COLUMNS, toMessage } from '../rows.js';
import {
  boundedLimit,
  DEFAULT_LIMIT,
  latestTriage,
  MAX_LIMIT,
  requireAccount,
  requireMessage,
  UUID,
} from './shared.js';

const LIMIT = z
  .number()
  .int()
  .positive()
  .max(MAX_LIMIT)
  .describe(`How many messages to return (default ${DEFAULT_LIMIT}, most ${MAX_LIMIT}).`);

const listRecentInput = z.object({
  limit: LIMIT.optional(),
  unreadOnly: z
    .boolean()
    .optional()
    .describe('Only messages the mailbox has not marked as read.'),
  since: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date')
    .optional()
    .describe('Only messages dated on or after this day (YYYY-MM-DD).'),
});

export const listRecent: ToolDefinition<z.infer<typeof listRecentInput>, unknown> = {
  name: 'email.list_recent',
  description:
    'List recent messages in the inbox, newest first: sender, subject, date, a short snippet, whether it is unread, whether it has attachments, and what triage decided about it if anything has. Use it to see what has arrived; use email.read for the full body of one message.',
  tier: 'auto',
  input: listRecentInput,
  async execute(input, ctx) {
    const account = await requireAccount(ctx.db);
    const limit = boundedLimit(input.limit);
    const params: unknown[] = [account.id];
    const where = ['account_id = $1'];
    if (input.since) {
      params.push(input.since);
      where.push(`date >= $${params.length}::date`);
    }
    if (input.unreadOnly) {
      where.push(`not (flags @> '["\\\\Seen"]'::jsonb)`);
    }
    params.push(limit);
    const { rows } = await ctx.db.query(
      `select ${MESSAGE_COLUMNS} from email.messages
        where ${where.join(' and ')}
        order by date desc nulls last, uid desc
        limit $${params.length}`,
      params,
    );
    const messages = [];
    for (const row of rows) {
      const message = toMessage(row);
      messages.push({
        id: message.id,
        from: message.from,
        subject: message.subject,
        date: message.date,
        snippet: message.snippet,
        unread: isUnread(message.flags),
        hasAttachments: message.hasAttachments,
        triage: await latestTriage(ctx.db, message.id),
      });
    }
    return { account: account.address, count: messages.length, messages };
  },
};

const readInput = z.object({
  id: UUID.describe('The message id from email.list_recent or email.search.'),
});

export const readMessage: ToolDefinition<z.infer<typeof readInput>, unknown> = {
  name: 'email.read',
  description:
    'Read one message in full: every header that matters, the complete text body, and the attachments it carries (filename, type and size — the bytes are not downloaded). A body older than the retention window is no longer stored: the headers, the snippet and the triage decision still come back, with a note saying the body was purged. Reading never marks the message as read in the owner\'s mailbox.',
  tier: 'auto',
  input: readInput,
  async execute(input, ctx) {
    const message = await requireMessage(ctx.db, input.id);
    // A purged body is a fact to state, not a gap to paper over: the tool says
    // the text is gone and why, and hands back everything that is kept.
    const purged = message.bodyPurgedAt !== null;
    const retention = purged ? await loadSettings(ctx.db) : null;
    return {
      id: message.id,
      messageId: message.messageId,
      threadKey: message.threadKey,
      from: message.from,
      to: message.to,
      subject: message.subject,
      date: message.date,
      // Kept forever, and the only text left once a body is purged.
      snippet: message.snippet,
      unread: isUnread(message.flags),
      flags: message.flags,
      hasAttachments: message.hasAttachments,
      attachments: message.attachments,
      bodyText: purged ? null : message.bodyText,
      bodyPurged: purged,
      ...(purged && retention
        ? {
            bodyPurgedAt: message.bodyPurgedAt,
            retentionDays: retention.retentionDays,
            note: purgedBodyNote(retention.retentionDays, message.bodyPurgedAt),
          }
        : {}),
      triage: await latestTriage(ctx.db, message.id),
    };
  },
};

const searchInput = z.object({
  query: z
    .string()
    .min(2)
    .describe('Text to look for in the subject, the sender, or the body. Case-insensitive.'),
  limit: LIMIT.optional(),
});

export const search: ToolDefinition<z.infer<typeof searchInput>, unknown> = {
  name: 'email.search',
  description:
    'Search ingested mail by a piece of text — a sender, a word in the subject, a phrase in the body. Case-insensitive substring match, newest first. Use it to find the earlier message a new one refers to.',
  tier: 'auto',
  input: searchInput,
  async execute(input, ctx) {
    const account = await requireAccount(ctx.db);
    const limit = boundedLimit(input.limit);
    // Escape the LIKE metacharacters: a query containing % is a literal search
    // for a percent sign, not a wildcard the model can widen.
    const needle = `%${input.query.replace(/([\\%_])/g, '\\$1')}%`;
    const { rows } = await ctx.db.query(
      `select ${MESSAGE_COLUMNS} from email.messages
        where account_id = $1
          and (subject ilike $2 escape '\\'
               or from_addr ilike $2 escape '\\'
               or body_text ilike $2 escape '\\')
        order by date desc nulls last, uid desc
        limit $3`,
      [account.id, needle, limit],
    );
    const messages = rows.map(toMessage).map((m) => ({
      id: m.id,
      from: m.from,
      subject: m.subject,
      date: m.date,
      snippet: m.snippet,
      unread: isUnread(m.flags),
      hasAttachments: m.hasAttachments,
    }));
    return { query: input.query, count: messages.length, messages };
  },
};
