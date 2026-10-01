/**
 * The mail's widget on Home (host API 1.17; settings since 1.19): how many
 * conversations need the owner now — the one rule (`needs-you.ts`) with no
 * waiting age, so the number is exactly the Mail page's "Needs a reply" (the
 * watcher and the goal count the same rule past the owner's setting) — with the inbox's
 * unread count under it, opening the Mail place. Each placement picks a
 * mailbox, or all of them. At zero it says so in a sentence rather than a
 * bare 0. Read-only, like the metrics it shares its reads with; with no
 * mailbox, or one that has never finished a poll, it says so.
 */
import type { WidgetBody, WidgetDefinition } from '@buddi/core/plugin';
import { listAccounts } from './config.js';
import { countInboxUnread, stalestSync } from './metrics.js';
import { countNeedsYou } from './sentinels/waiting-on-me.js';

export const waitingWidget: WidgetDefinition = {
  id: 'email.waiting',
  title: 'Waiting on you',
  sizes: ['small'],
  refreshSeconds: 300,
  link: { page: 'mail' },
  settings: [
    {
      key: 'mailbox',
      kind: 'select',
      label: 'Mailbox',
      default: '',
      options: async (ctx) => [
        { value: '', label: 'All mailboxes' },
        ...(await listAccounts(ctx.buddi!.db)).map((a) => ({ value: String(a.id), label: a.address })),
      ],
    },
  ],
  async produce(ctx, request): Promise<WidgetBody | null> {
    const buddi = ctx.buddi!;
    const all = await listAccounts(buddi.db);
    if (all.length === 0) return { kind: 'text', icon: 'mail', text: 'Add a mailbox on Settings → Email to see who is waiting on you.' };
    const chosen = typeof request.settings?.mailbox === 'string' ? request.settings.mailbox : '';
    // A mailbox since removed or switched off is no choice at all: every mailbox.
    const accounts = chosen ? all.filter((a) => String(a.id) === chosen) : [];
    const scope = accounts.length > 0 ? accounts : all;
    const ids = scope.map((a) => a.id);
    if ((await stalestSync(ctx, ids)) === null) return { kind: 'text', icon: 'mail', text: 'Your mail has not finished its first sync yet.' };
    const waiting = await countNeedsYou(buddi.db, buddi.clock.now(), accounts.length > 0 ? ids.map(String) : undefined);
    const unread = await countInboxUnread(ctx, ids);
    const inbox = `${unread.toLocaleString('en-US')} unread in ${accounts.length > 0 ? accounts[0]!.address : 'your inbox'}`;
    // A calm zero: a sentence, not a bare 0.
    if (waiting === 0) return { kind: 'text', icon: 'check', text: 'Nobody’s waiting on you.', sub: inbox };
    return {
      kind: 'stat',
      icon: 'mail',
      value: String(waiting),
      // The title already says "Waiting on you": the caption only names what is counted, so it fits a lock screen tile.
      caption: waiting === 1 ? 'conversation' : 'conversations',
      foot: inbox,
    };
  },
};

export const emailWidgets: WidgetDefinition[] = [waitingWidget];
