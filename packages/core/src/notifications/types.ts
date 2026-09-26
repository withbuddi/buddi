/**
 * Reaching the owner: the message, the record, the channel (docs/notifications.md).
 *
 * A surface is where the owner talks to buddi; a channel is how buddi reaches
 * them when they are not looking. Core owns "reach the owner"; a channel only
 * carries. Types only.
 */
import type { Offer } from '../offers/types.js';

export const NOTIFICATION_KINDS = ['approval', 'question', 'watcher', 'reminder', 'failure', 'recap', 'plugin'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const NOTIFICATION_URGENCIES = ['now', 'today', 'digest'] as const;
export type NotificationUrgency = (typeof NOTIFICATION_URGENCIES)[number];

/** Kinds the owner asked for by starting the run: never quiet, never off. */
export const ALWAYS_REACH: ReadonlySet<NotificationKind> = new Set(['approval', 'question']);

/** The one call's argument. */
export interface OwnerMessage {
  kind: NotificationKind;
  urgency: NotificationUrgency;
  /** One line: the whole message on a small channel. */
  title: string;
  /** A few lines, markdown-light. */
  text?: string;
  /** A dashboard place: `#/chat/…`, `#/settings/…`. */
  link?: { route: string };
  /** Offers a report already stored; a channel that has buttons draws them. */
  offers?: readonly Offer[];
  /** "This thing, again": an unsent row with the same key is updated, not duplicated. */
  dedupeKey?: string;
  agentId?: string;
  /** Stamped by the host for a plugin's call; a plugin never sets it. */
  pluginId?: string;
  /** Core only: the approval this message asks about, drawn as a card where a channel can. */
  actionId?: string;
}

/** Where a row is in its life. See migration 043. */
export type NotificationState = 'shown' | 'held' | 'stored' | 'sending' | 'sent' | 'failed';

/** One row of `core.owner_notifications`. */
export interface OwnerNotification {
  id: string;
  kind: NotificationKind;
  urgency: NotificationUrgency;
  title: string;
  text: string | null;
  link: string | null;
  offers: Offer[];
  dedupeKey: string | null;
  agentId: string | null;
  pluginId: string | null;
  actionId: string | null;
  state: NotificationState;
  dueAt: string | null;
  channel: string | null;
  firedCount: number;
  lowered: boolean;
  createdAt: string;
  sentAt: string | null;
  seenAt: string | null;
  actedAt: string | null;
  error: string | null;
}

/** What a channel is handed: the message as stored, with its row's id. */
export interface DeliverableMessage extends OwnerMessage {
  /** The row's id; `today:<date>` for the end-of-day message, which is many rows. */
  id: string;
}

/** A way to reach the owner, registered by whoever owns the transport. */
export interface OwnerChannel {
  /** `telegram.chat`, `local.notification`, `email.self`, `<plugin>.<what>`. Never `dashboard`. */
  kind: string;
  /**
   * What Settings shows. Null, or a promise of null, when the channel has
   * nothing to carry a message through now (a plugin's with no account): it
   * is then neither listed nor picked.
   */
  describe(): ChannelDescription | null | Promise<ChannelDescription | null>;
  can: { offers: boolean; attachments: boolean; markdown: boolean };
  /**
   * Which channel is the default when the owner picked none: the lowest
   * first, then the order they were registered. Absent is 100.
   */
  priority?: number;
  /**
   * `{ id }` once the transport took it. `'refused'`, or `{ refused }` with a
   * sentence saying why, when it did not: the reason is what the row's
   * `error` says.
   */
  deliver(message: DeliverableMessage): Promise<ChannelAnswer>;
}

/** A channel as Settings names it: "Telegram, @your_bot". */
export interface ChannelDescription {
  label: string;
  where?: string;
}

/** What a channel's `deliver` answers. */
export type ChannelAnswer = { id: string } | 'refused' | { refused: string };

/** The Notifications page's values, defaults filled in. */
export interface NotificationSettings {
  /** A channel kind, or null for the first one registered. */
  defaultChannel: string | null;
  /** kind → a channel kind, or `off`. Approvals and questions are never off. */
  perKind: Partial<Record<NotificationKind, string>>;
  /** `HH:MM`, the owner's clock; both or neither. */
  quietStart: string | null;
  quietEnd: string | null;
  /** `HH:MM`; when the day's held items go out. */
  endOfDay: string;
}

/** What one call did. */
export interface NotifyResult {
  id: string;
  state: NotificationState;
  /** The channel kind it went to, `dashboard` when shown there, else null. */
  channel: string | null;
  error: string | null;
  /** An unsent row with the same key took it. */
  deduped: boolean;
  /** The rate rule lowered it from `now` to `today`. */
  lowered: boolean;
}

export interface NotifyDeps {
  now?: () => Date;
  /** The zone when the owner profile names none. Defaults to `BUDDI_TZ`, else New York. */
  timezone?: string;
  log?: (line: string) => void;
}
