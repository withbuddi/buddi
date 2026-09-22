/**
 * The numbers a goal can watch in the mail.
 *
 * Both are counts of rows this plugin already ingested, read through the
 * definitions that are already the plugin's: `UNREAD_SQL` is the predicate
 * `email.list_recent` filters on, and `countWaitingOnMe` is the watcher's own
 * query with `count(*)` where its findings would be. That matters more than it
 * looks: a goal is checked for months, and an owner working an inbox down must
 * be counting the same thing the list shows him and the same thing the watcher
 * wakes him about — two definitions of "unread" would be two different weeks.
 *
 * `asOf` is the **last sync**, never now. Mail arrives when the poller runs,
 * so a count read at four in the morning is true of whenever the mailbox was
 * last read; stamping it `now` would draw a week of confident, flat data over
 * a poller that had been failing since Tuesday. An installation with no
 * mailbox, or one that has never synced, has no number at all: `null`, and the
 * check records *not measurable*.
 */
import type { MetricDefinition, ToolContext } from '@buddi/core';
import { z } from 'zod';
import { lastSyncByAccount, listAccounts } from './config.js';
import { UNREAD_SQL } from './mail.js';
import { countWaitingOnMe } from './sentinels/waiting-on-me.js';
import { accountScope } from './tools/shared.js';

/**
 * When mail last landed in one of these accounts.
 *
 * The newest of them, because the question is "how current is this count" and
 * the count spans all of them. `null` when not one has ever synced.
 */
async function lastSync(ctx: ToolContext, accountIds: readonly string[]): Promise<Date | null> {
  const synced = await lastSyncByAccount(ctx.db);
  const times = accountIds
    .map((id) => synced.get(id) ?? null)
    .filter((at): at is string => at !== null)
    .map((at) => new Date(at))
    .filter((at) => !Number.isNaN(at.getTime()));
  if (times.length === 0) return null;
  return new Date(Math.max(...times.map((at) => at.getTime())));
}

const ACCOUNT = z
  .string()
  .min(1)
  .describe(
    'Which mailbox to count, by its address or its id — the same way every other email tool names one. ' +
      'Leave it out to count every mailbox this installation has, which is usually what a goal means.',
  );

/**
 * How much unopened mail is sitting there.
 *
 * Inbound only. A message the owner sent is in the table too (the Sent folder
 * is ingested), it carries whatever flags that folder gave it, and it is not
 * something anybody has to read — counting it would make the number go *up*
 * when the owner answered somebody.
 */
export const inboxUnread: MetricDefinition = {
  id: 'email.inbox_unread',
  description:
    'How many arrived messages the mailbox has not marked as read — the same "unread" email.list_recent ' +
    'filters on, counted across every mailbox unless you name one. As of the last time mail was synced, ' +
    'which may not be now.',
  unit: 'count',
  direction: 'down',
  params: z.object({ account: ACCOUNT.optional() }),
  async measure(params, ctx) {
    const { account } = params as { account?: string };
    // No mailbox at all is not an inbox of zero: there is nothing to count.
    // A mailbox *named* that does not exist is a different matter, and
    // `accountScope` throws its own sentence for it.
    if ((await listAccounts(ctx.db)).length === 0) return null;
    const scope = await accountScope(ctx.db, account);
    const asOf = await lastSync(ctx, scope.ids);
    // Never synced: every count here would be a count of nothing having
    // happened yet, dated to a moment that does not exist.
    if (asOf === null) return null;
    const { rows } = await ctx.db.query(
      `select count(*)::int as n from email.messages
        where account_id = any($1::uuid[]) and direction = 'in' and ${UNREAD_SQL}`,
      [scope.ids],
    );
    return {
      value: Number((rows[0] as { n: unknown } | undefined)?.n ?? 0),
      asOf,
      note: scope.only
        ? scope.only.address
        : `across ${scope.accounts.length} mailbox${scope.accounts.length === 1 ? '' : 'es'}`,
    };
  },
};

/**
 * How many conversations are waiting on the owner.
 *
 * Exactly what the `email.waiting-on-me` watcher counts, from the watcher's
 * own query and the owner's own `waitingDays`: threads whose last message came
 * in, older than the setting and newer than a month, from somebody the owner
 * has written to before, not silenced and not muted.
 */
export const waitingOnMe: MetricDefinition = {
  id: 'email.waiting_on_me',
  description:
    'How many conversations have been waiting on you longer than your setting — the same ones the ' +
    'email.waiting-on-me watcher reports, from people you have written to before. As of the last time ' +
    'mail was synced.',
  unit: 'count',
  direction: 'down',
  params: z.object({}),
  async measure(_params, ctx) {
    const accounts = await listAccounts(ctx.db);
    if (accounts.length === 0) return null;
    const asOf = await lastSync(
      ctx,
      accounts.map((a) => a.id),
    );
    if (asOf === null) return null;
    return {
      value: await countWaitingOnMe(ctx.db, ctx.now()),
      asOf,
      note: 'conversations whose last word was theirs',
    };
  },
};

export const emailMetrics: MetricDefinition[] = [inboxUnread, waitingOnMe];
