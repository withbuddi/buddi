/**
 * The mail's widget on Home (host API 1.17): how many conversations are
 * waiting on the owner — the `email.waiting_on_me` metric's own count, so the
 * widget, the goal and the watcher agree — with the inbox's unread count under
 * it, opening the Mail place. Read-only, like the metrics it shares its reads
 * with; with no mailbox, or one that has never finished a poll, it says so.
 */
import type { WidgetBody, WidgetDefinition } from '@buddi/core/plugin';
import { listAccounts } from './config.js';
import { countInboxUnread, stalestSync } from './metrics.js';
import { countWaitingOnMe } from './sentinels/waiting-on-me.js';

export const waitingWidget: WidgetDefinition = {
  id: 'email.waiting',
  title: 'Waiting on you',
  sizes: ['small'],
  refreshSeconds: 300,
  link: { page: 'mail' },
  async produce(ctx): Promise<WidgetBody | null> {
    const buddi = ctx.buddi!;
    const accounts = await listAccounts(buddi.db);
    if (accounts.length === 0) return { kind: 'text', icon: 'mail', text: 'Add a mailbox on Settings → Email to see who is waiting on you.' };
    const ids = accounts.map((a) => a.id);
    if ((await stalestSync(ctx, ids)) === null) return { kind: 'text', icon: 'mail', text: 'Your mail has not finished its first sync yet.' };
    const waiting = await countWaitingOnMe(buddi.db, buddi.clock.now());
    const unread = await countInboxUnread(ctx, ids);
    return {
      kind: 'stat',
      icon: 'mail',
      value: String(waiting),
      caption: waiting === 1 ? 'conversation waits on you' : 'conversations wait on you',
      foot: `${unread.toLocaleString('en-US')} unread in your inbox`,
    };
  },
};

export const emailWidgets: WidgetDefinition[] = [waitingWidget];
