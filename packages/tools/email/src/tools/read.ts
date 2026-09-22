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
import { isUnread, quoted, UNTRUSTED_NOTICE } from '../mail.js';
import {
  buildSearch,
  narrows,
  qualify,
  windowNote,
  DATE_PATTERN,
  WHEN,
} from '../search.js';
import { loadSettings, purgedBodyNote } from '../retention.js';
import { MESSAGE_COLUMNS, toMessage } from '../rows.js';
import {
  ACCOUNT_ARG,
  accountScope,
  boundedLimit,
  DEFAULT_LIMIT,
  latestTriage,
  MAX_LIMIT,
  requireMessage,
  UUID,
  type AccountScope,
} from './shared.js';

/**
 * How a listing names the accounts it looked in.
 *
 * `account` stays on the result and means what it always meant — the mailbox
 * this answer is about — but only when the answer *is* about one. Across
 * several it is null and `accounts` is the list, because a single address
 * there would be a lie about where the rows came from, and every row carries
 * its own `account` anyway.
 */
function scopeSummary(scope: AccountScope): { account: string | null; accounts: string[] } {
  return {
    account: scope.only?.address ?? null,
    accounts: scope.accounts.map((a) => a.address),
  };
}

const LIMIT = z
  .number()
  .int()
  .positive()
  .max(MAX_LIMIT)
  .describe(`How many messages to return (default ${DEFAULT_LIMIT}, most ${MAX_LIMIT}).`);

const listRecentInput = z.object({
  account: ACCOUNT_ARG.optional(),
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
    'List recent messages in the inbox, newest first: sender, subject, date, a short snippet, whether it is unread, whether it has attachments, which of the owner\'s mailboxes it arrived in, and what triage decided about it if anything has. Every mailbox is searched unless you name one with `account`. Use it to see what has arrived; use email.read for the full body of one message.',
  tier: 'auto',
  input: listRecentInput,
  async execute(input, ctx) {
    const scope = await accountScope(ctx.db, input.account);
    const limit = boundedLimit(input.limit);
    const params: unknown[] = [scope.ids];
    const where = ['account_id = any($1::uuid[])'];
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
        // Which of the owner's mailboxes this landed in. On its own row,
        // because two accounts make the same sender a different message.
        account: scope.byId.get(message.accountId)?.address ?? null,
        from: message.from,
        subject: message.subject,
        date: message.date,
        snippet: message.snippet,
        unread: isUnread(message.flags),
        hasAttachments: message.hasAttachments,
        triage: await latestTriage(ctx.db, message.id),
      });
    }
    return { ...scopeSummary(scope), count: messages.length, messages };
  },
};

const readInput = z.object({
  id: UUID.describe('The message id from email.list_recent or email.search.'),
  account: ACCOUNT_ARG.optional(),
});

export const readMessage: ToolDefinition<z.infer<typeof readInput>, unknown> = {
  name: 'email.read',
  description:
    'Read one message in full: which conversation it belongs to, every header that matters, the complete text body, and the attachments it carries (filename, type and size — the bytes are not downloaded). A body older than the retention window is no longer stored: the headers, the snippet and the triage decision still come back, with a note saying the body was purged. Reading never marks the message as read in the owner\'s mailbox.',
  tier: 'auto',
  input: readInput,
  async execute(input, ctx) {
    const scope = await accountScope(ctx.db, input.account);
    const message = await requireMessage(ctx.db, input.id);
    // A message already names its own account, so `account` here is a check
    // rather than a filter: naming a mailbox and being handed a message from
    // another one is the one answer this tool must never give.
    const account = scope.byId.get(message.accountId);
    if (!account) {
      throw new Error(
        `email.read: message ${message.id} did not arrive in ${scope.accounts.map((a) => a.address).join(', ')}`,
      );
    }
    // A purged body is a fact to state, not a gap to paper over: the tool says
    // the text is gone and why, and hands back everything that is kept.
    const purged = message.bodyPurgedAt !== null;
    const retention = purged ? await loadSettings(ctx.db) : null;
    return {
      id: message.id,
      account: account.address,
      messageId: message.messageId,
      // The conversation it belongs to: what email.read_thread and a thread
      // rule are named by. `threadKey` is the raw header it was threaded on.
      thread: message.threadId,
      threadKey: message.threadKey,
      direction: message.direction,
      from: message.from,
      to: message.to,
      // Who else is on this message. It decides whether a reply to the sender
      // alone is the right one, so it is part of reading the message.
      cc: message.cc,
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

/**
 * The filters, in one place, so the tool and the page share their words.
 *
 * Every one of them is optional and every one of them narrows — there is no
 * filter here that widens the scope, which stays whatever `account` allows.
 */
const FROM_FILTER = z
  .string()
  .min(3)
  .describe(
    'Only mail from this sender: a whole address (an exact match) or a bare domain like `acme.com` (which also matches its subdomains).',
  );

const SINCE_FILTER = z
  .string()
  .regex(DATE_PATTERN, 'expected a YYYY-MM-DD date')
  .describe('Only mail received on or after this day (YYYY-MM-DD).');

const UNTIL_FILTER = z
  .string()
  .regex(DATE_PATTERN, 'expected a YYYY-MM-DD date')
  .describe('Only mail received on or before this day (YYYY-MM-DD), the whole day included.');

const searchInput = z.object({
  account: ACCOUNT_ARG.optional(),
  query: z
    .string()
    .min(2)
    .optional()
    .describe(
      'Text to look for in the subject, the sender, or the body. Case-insensitive substring. Optional when at least one filter is given.',
    ),
  from: FROM_FILTER.optional(),
  since: SINCE_FILTER.optional(),
  until: UNTIL_FILTER.optional(),
  thread: UUID.optional().describe('Only messages in this conversation (the id from email.list_threads).'),
  direction: z
    .enum(['in', 'out'])
    .optional()
    .describe("'in' for mail that arrived, 'out' for mail the owner sent."),
  hasAttachments: z
    .boolean()
    .optional()
    .describe('True for messages that carry attachments, false for those that do not.'),
  limit: LIMIT.optional(),
});

export const search: ToolDefinition<z.infer<typeof searchInput>, unknown> = {
  name: 'email.search',
  description:
    'Search ingested mail. Give `query` for a case-insensitive substring of the subject, the sender or the body, and narrow it with any of `from` (a whole address, or a bare domain which also matches its subdomains), `since` and `until` (YYYY-MM-DD, against when the mail was received), `thread` (one conversation), `direction` (`in` or `out`), and `hasAttachments`. `query` may be left out when at least one filter is given — `from: "acme.com", hasAttachments: true` is a search. Newest first, across every mailbox unless you name one with `account`. With a `query` and no filter at all only the last 90 days are searched, and the answer says so. Use it to find the earlier message a new one refers to.',
  tier: 'auto',
  input: searchInput,
  async execute(input, ctx) {
    const scope = await accountScope(ctx.db, input.account);
    const limit = boundedLimit(input.limit);
    const filters = {
      ...(input.query !== undefined ? { query: input.query } : {}),
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.since !== undefined ? { since: input.since } : {}),
      ...(input.until !== undefined ? { until: input.until } : {}),
      ...(input.thread !== undefined ? { thread: input.thread } : {}),
      ...(input.direction !== undefined ? { direction: input.direction } : {}),
      ...(input.hasAttachments !== undefined ? { hasAttachments: input.hasAttachments } : {}),
    };
    // A search with neither text nor a filter is "every message you have",
    // which is what email.list_recent is for and says so.
    if ((input.query ?? '').trim() === '' && !narrows(filters)) {
      throw new Error(
        'email.search needs either `query` or at least one filter (`from`, `since`, `until`, `thread`, `direction`, `hasAttachments`); use email.list_recent to see the newest mail.',
      );
    }
    const built = buildSearch(scope.ids, filters, ctx.now());
    const { rows } = await ctx.db.query(
      `select ${qualify(MESSAGE_COLUMNS, 'm')} from email.messages m
        where ${built.where}
        order by ${WHEN} desc nulls last, m.uid desc
        limit $${built.params.length + 1}`,
      [...built.params, limit],
    );
    const messages = rows.map(toMessage).map((m) => ({
      id: m.id,
      account: scope.byId.get(m.accountId)?.address ?? null,
      // The conversation this belongs to, so a hit can be read in context
      // with email.read_thread rather than on its own.
      thread: m.threadId,
      direction: m.direction,
      from: m.from,
      subject: m.subject,
      date: m.date,
      // Fenced: a snippet is the sender's own words, and a search result is
      // read by a model. See `quoted` in mail.ts.
      snippet: quoted(m.snippet ?? ''),
      unread: isUnread(m.flags),
      hasAttachments: m.hasAttachments,
    }));
    return {
      ...scopeSummary(scope),
      query: input.query ?? null,
      filters,
      count: messages.length,
      messages,
      ...(built.windowed && built.windowFrom ? { window: windowNote(built.windowFrom) } : {}),
      note: UNTRUSTED_NOTICE,
    };
  },
};
