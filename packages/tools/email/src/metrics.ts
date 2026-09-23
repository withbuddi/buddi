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
 * **Why there is no `email.inbox_unread` here.** A message's `flags` are
 * written once, at ingest, and never re-synced (`sources/inbox-poll.ts`: the
 * fetch is a peek, and the insert is `on conflict … do nothing`). A count over
 * them therefore only ever climbs, whatever the owner reads, so a goal on it
 * would be settled `missed` for an inbox somebody had actually emptied. The
 * metric is worth having and needs an IMAP flag re-sync first; until then it
 * does not exist, which is the honest version of not having it.
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
import { lastSyncedByAccount, listAccounts } from './config.js';
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

export const emailMetrics: MetricDefinition[] = [waitingOnMe];
