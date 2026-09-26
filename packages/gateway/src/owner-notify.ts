/**
 * The gateway's callers, moved onto core's `notifyOwner` (docs/notifications.md).
 *
 * Every place that used to send Telegram text directly — a mission's report,
 * a watcher's wake, a reminder, a dead-letter wave, an approval an unattended
 * run is waiting on — now says what kind of thing it is and how urgent, and
 * core decides where it goes. What those callers were promised is kept: the
 * functions here return a string where the old path returned a chat id, and
 * never throw for a channel's sake unless asked to (`strict`, the CLI's
 * `--inline` run, which reports an unreached owner as a skipped delivery).
 */
import {
  notifyOwner,
  type ActionRecord,
  type NotificationKind,
  type NotificationUrgency,
  type NotifyDeps,
  type NotifyResult,
  type Offer,
  type Queryable,
} from '@buddi/core';
import type { Deliver, DeliverContext } from './missions/execute.js';
import { OwnerNotPairedError } from './telegram/notify.js';

/** A notification's title is the text's first line; the rest is its body. */
export function splitOwnerText(text: string): { title: string; text?: string } {
  const trimmed = text.trim();
  const at = trimmed.indexOf('\n');
  if (at === -1) return { title: trimmed };
  const rest = trimmed.slice(at + 1).replace(/^\s*\n/, '').trim();
  return { title: trimmed.slice(0, at).trim(), ...(rest ? { text: rest } : {}) };
}

/** The kind a run's report is, by where the run came from. */
export function kindOfOrigin(origin: DeliverContext['origin'] | undefined): NotificationKind {
  switch (origin) {
    case 'wake':
    case 'source':
      return 'watcher';
    case 'reminder':
      return 'reminder';
    default:
      return 'recap';
  }
}

export interface OwnerNotifyOptions extends NotifyDeps {
  /** Throw `OwnerNotPairedError` when no channel took a message that had to go out. */
  strict?: boolean;
}

function answer(result: NotifyResult, strict: boolean | undefined): string {
  if (strict && result.state === 'failed') throw new OwnerNotPairedError(result.error ?? 'no channel');
  return result.channel ?? result.state;
}

/**
 * A mission's `deliver`: its report as a notification. Every report is `now`,
 * as every report was sent at once before — unless the finding that woke the
 * run asked for `today` (`Finding.notify`); `mission.silent` never reaches this.
 */
export function ownerDeliver(pool: Queryable, opts: OwnerNotifyOptions): Deliver {
  return async (text: string, offers?: readonly Offer[], context?: DeliverContext) => {
    const result = await notifyOwner(pool, opts, {
      kind: kindOfOrigin(context?.origin),
      urgency: context?.notifyUrgency ?? 'now',
      ...splitOwnerText(text),
      ...(offers && offers.length > 0 ? { offers } : {}),
      ...(context?.agentId ? { agentId: context.agentId } : {}),
      ...(context?.dedupeKey ? { dedupeKey: context.dedupeKey } : {}),
      ...(context?.agentId && context.conversationId
        ? { link: { route: `#/chat/${encodeURIComponent(context.agentId)}/${encodeURIComponent(context.conversationId)}` } }
        : {}),
    });
    return answer(result, opts.strict);
  };
}

/** A plain text sender for callers that know their own kind: the dead-letter watch, the learning digest. */
export function ownerText(
  pool: Queryable,
  opts: OwnerNotifyOptions,
  message: { kind: NotificationKind; urgency?: NotificationUrgency; dedupeKey?: string; link?: string },
): (text: string) => Promise<string> {
  return async (text: string) => {
    const result = await notifyOwner(pool, opts, {
      kind: message.kind,
      urgency: message.urgency ?? 'now',
      ...splitOwnerText(text),
      ...(message.dedupeKey ? { dedupeKey: message.dedupeKey } : {}),
      ...(message.link ? { link: { route: message.link } } : {}),
    });
    return answer(result, opts.strict);
  };
}

/**
 * An unattended run is waiting on the owner's approval. On Telegram this is
 * the card with its bound buttons; the row carries the action so any channel
 * that draws cards can draw this one, and deciding it marks the row acted.
 */
export async function notifyApproval(pool: Queryable, opts: NotifyDeps, action: ActionRecord): Promise<NotifyResult> {
  return notifyOwner(pool, opts, {
    kind: 'approval',
    urgency: 'now',
    title: `${action.agentId} needs your approval to run ${action.tool}`,
    ...(action.preview ? { text: action.preview } : {}),
    ...(action.conversationId ? { link: { route: `#/chat/${encodeURIComponent(action.agentId)}/${encodeURIComponent(action.conversationId)}` } } : {}),
    agentId: action.agentId,
    actionId: action.id,
    dedupeKey: `approval:${action.id}`,
  });
}
