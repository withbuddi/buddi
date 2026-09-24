/**
 * The number a goal can watch in the mail.
 *
 * One, for now: how many conversations are waiting on the owner. It is the
 * `email.waiting-on-me` watcher's own query with `count(*)` where its findings
 * would be — the same waiting age, the same "you have written to them before",
 * the same silenced senders, the same thirty-day ceiling, the same enabled
 * mailboxes — because an owner working the pile down must be counting what the
 * watcher wakes him about. Two definitions would be two different weeks.
 *
 * And how many messages in the inbox are unread (`email.inbox_unread`). That
 * one could not exist while a message's `flags` were written once at ingest
 * and never again — the count would only climb, whatever the owner read. The
 * inbox poll now re-reads FLAGS for the newest `FLAG_SYNC_WINDOW` rows each
 * pass (`sources/inbox-poll.ts`), and the count is taken over exactly those
 * rows, so it says what the server said at the last sync.
 *
 * **`asOf` is the last sync, and the stalest one.** Not `now`: mail is as
 * current as the last poll, and a count stamped with the present would paper
 * over a poller that stopped on Tuesday. Not the newest sync either, when
 * several mailboxes are in scope — an aggregate is only as fresh as its
 * stalest part. And a mailbox that has never completed a poll makes the whole
 * answer `null`: we do not know what is in it, so we do not know the count.
 */
import type { MetricDefinition, ToolContext } from '@buddi/core';
import { z } from 'zod';
import { findAccount, lastSyncedByAccount, listAccounts } from './config.js';
import { UNREAD_SQL } from './mail.js';
import { FLAG_SYNC_WINDOW } from './sources/inbox-poll.js';
import { countWaitingOnMe } from './sentinels/waiting-on-me.js';

/**
 * How current the answer is: the *stalest* completed poll among these
 * accounts, or `null` if any of them has never finished one.
 */
export async function stalestSync(
  ctx: ToolContext,
  accountIds: readonly string[],
): Promise<Date | null> {
  if (accountIds.length === 0) return null;
  const synced = await lastSyncedByAccount(ctx.db);
  let stalest: Date | null = null;
  for (const id of accountIds) {
    const at = synced.get(id) ?? null;
    // One mailbox nobody has managed to read makes the whole count unknown:
    // the number would be "everything except whatever is in there".
    if (at === null) return null;
    if (stalest === null || at.getTime() < stalest.getTime()) stalest = at;
  }
  return stalest;
}

/**
 * How many conversations are waiting on the owner.
 *
 * Exactly what the `email.waiting-on-me` watcher counts, from the watcher's
 * own query and the owner's own `waitingDays`: threads whose last message came
 * in, older than the setting and newer than a month, from somebody the owner
 * has written to before, in a mailbox that is switched on, with no live ignore
 * policy on the sender.
 */
export const waitingOnMe: MetricDefinition = {
  id: 'email.waiting_on_me',
  description:
    'How many conversations have been waiting on you longer than your setting — the same ones the ' +
    'email.waiting-on-me watcher reports, from people you have written to before. As of the last time ' +
    'your mail was synced, which may not be now.',
  unit: 'count',
  direction: 'down',
  params: z.object({}),
  async measure(_params, ctx) {
    const accounts = await listAccounts(ctx.db);
    // No mailbox is not an inbox at peace; there is nothing to count.
    if (accounts.length === 0) return null;
    const asOf = await stalestSync(
      ctx,
      accounts.map((a) => a.id),
    );
    if (asOf === null) return null;
    return {
      value: await countWaitingOnMe(ctx.db, ctx.now()),
      asOf,
      note:
        accounts.length === 1
          ? 'conversations whose last word was theirs'
          : `conversations whose last word was theirs, across ${accounts.length} mailboxes`,
    };
  },
};

/**
 * Unread messages in the inbox of these accounts, over the rows the flag
 * re-sync keeps current: per account, the newest `FLAG_SYNC_WINDOW` messages
 * of the inbox folder's current generation, with `\Seen` unset.
 *
 * A message archived or deleted elsewhere keeps the flags it last had (the
 * schema has no "still in the inbox" field), so one archived unread still
 * counts until it falls out of the window.
 */
export async function countInboxUnread(
  ctx: ToolContext,
  accountIds: readonly string[],
): Promise<number> {
  const { rows } = await ctx.db.query(
    `select coalesce(sum(w.n), 0)::int as n
       from email.folders f
       cross join lateral (
         select count(*) filter (where ${UNREAD_SQL}) as n
           from (select flags from email.messages
                  where folder_id = f.id and uidvalidity = f.uidvalidity
                  order by uid desc
                  limit $2) m
       ) w
      where f.kind = 'inbox' and f.synced and f.account_id = any ($1::uuid[])`,
    [accountIds, FLAG_SYNC_WINDOW],
  );
  return Number((rows[0] as { n?: unknown } | undefined)?.n ?? 0);
}

/**
 * How many messages in the inbox are unread: all enabled mailboxes, or one.
 *
 * `\Seen` as the server had it at the last poll — read on the phone at nine,
 * counted as read by the poll after. `asOf` is that poll, the stalest one
 * when several mailboxes are counted together.
 */
export const inboxUnread: MetricDefinition = {
  id: 'email.inbox_unread',
  description:
    'How many messages in your inbox are unread — all your mailboxes together, or one if you name it ' +
    '(its address). Read or unread as your mail server had it at the last sync, so a message you read ' +
    'on your phone stops counting within a poll. Counts the newest ' +
    `${FLAG_SYNC_WINDOW.toLocaleString('en-US')} messages of each inbox.`,
  unit: 'count',
  direction: 'down',
  params: z.object({ account: z.string().trim().min(1).optional() }),
  async measure(params, ctx) {
    const { account } = (params ?? {}) as { account?: string };
    const accounts = account
      ? await findAccount(ctx.db, account).then((a) => (a ? [a] : []))
      : await listAccounts(ctx.db);
    // No mailbox — or one named that is not here — is nothing to count.
    if (accounts.length === 0) return null;
    const ids = accounts.map((a) => a.id);
    const asOf = await stalestSync(ctx, ids);
    if (asOf === null) return null;
    return {
      value: await countInboxUnread(ctx, ids),
      asOf,
      note:
        accounts.length === 1
          ? `unread in ${accounts[0]?.address}`
          : `unread across ${accounts.length} inboxes`,
    };
  },
};

export const emailMetrics: MetricDefinition[] = [waitingOnMe, inboxUnread];
