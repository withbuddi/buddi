/**
 * The record behind every notification, the owner's presence, and the
 * Notifications page's settings. Plain reads and guarded writes; routing
 * lives in `notify.ts`.
 */
import type { Offer } from '../offers/types.js';
import type { Queryable } from '../owner.js';
import { LOCAL_TIME } from '../time.js';
import {
  ALWAYS_REACH,
  NOTIFICATION_KINDS,
  type NotificationKind,
  type NotificationSettings,
  type OwnerNotification,
} from './types.js';

/** "Present" is active on some surface within this long. */
export const PRESENCE_WINDOW_MS = 2 * 60_000;

/** When the day's held items go out when the owner has not said. */
export const DEFAULT_END_OF_DAY = '18:00';

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  defaultChannel: null,
  perKind: {},
  quietStart: null,
  quietEnd: null,
  endOfDay: DEFAULT_END_OF_DAY,
};

const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);

export const NOTIFICATION_COLUMNS =
  'id, kind, urgency, title, text, link, offers, dedupe_key, agent_id, plugin_id, action_id, state, due_at, ' +
  'channel, fired_count, lowered, created_at, sent_at, seen_at, acted_at, error';

export function toNotification(row: Record<string, any>): OwnerNotification {
  return {
    id: String(row.id),
    kind: row.kind,
    urgency: row.urgency,
    title: row.title,
    text: row.text ?? null,
    link: row.link ?? null,
    offers: Array.isArray(row.offers) ? (row.offers as Offer[]) : [],
    dedupeKey: row.dedupe_key ?? null,
    agentId: row.agent_id ?? null,
    pluginId: row.plugin_id ?? null,
    actionId: row.action_id === null || row.action_id === undefined ? null : String(row.action_id),
    state: row.state,
    dueAt: iso(row.due_at),
    channel: row.channel ?? null,
    firedCount: Number(row.fired_count ?? 1),
    lowered: row.lowered === true,
    createdAt: iso(row.created_at) as string,
    sentAt: iso(row.sent_at),
    seenAt: iso(row.seen_at),
    actedAt: iso(row.acted_at),
    error: row.error ?? null,
  };
}

/* ------------------------------------------------------------------ *
 * Reads and marks
 * ------------------------------------------------------------------ */

/** The newest first; at most 100. */
export async function listNotifications(db: Queryable, opts: { limit?: number } = {}): Promise<OwnerNotification[]> {
  const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 20) || 20));
  const { rows } = await db.query(
    `select ${NOTIFICATION_COLUMNS} from core.owner_notifications order by created_at desc, id limit $1`,
    [limit],
  );
  return rows.map(toNotification);
}

/** One row, or null. */
export async function getNotification(db: Queryable, id: string): Promise<OwnerNotification | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query(`select ${NOTIFICATION_COLUMNS} from core.owner_notifications where id = $1`, [id]);
  return rows[0] ? toNotification(rows[0]) : null;
}

/** The `digest` rows written since `since`, oldest first: what the recap may read. */
export async function listDigestNotifications(db: Queryable, since: Date): Promise<OwnerNotification[]> {
  const { rows } = await db.query(
    `select ${NOTIFICATION_COLUMNS} from core.owner_notifications
      where urgency = 'digest' and created_at >= $1 order by created_at, id`,
    [since],
  );
  return rows.map(toNotification);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The owner saw it: the dashboard drew it, or they opened its link. The first
 * time counts; a row seen before it escalated never escalates. False when
 * there is no such row.
 */
export async function markSeen(db: Queryable, id: string, now: Date = new Date()): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const { rows } = await db.query(
    `update core.owner_notifications set seen_at = coalesce(seen_at, $2), updated_at = $2
      where id = $1 returning id`,
    [id, now],
  );
  return rows.length > 0;
}

/** The owner did what it asked. Acted implies seen. */
export async function markActed(db: Queryable, id: string, now: Date = new Date()): Promise<boolean> {
  if (!UUID.test(id)) return false;
  const { rows } = await db.query(
    `update core.owner_notifications
        set acted_at = coalesce(acted_at, $2), seen_at = coalesce(seen_at, $2), updated_at = $2
      where id = $1 returning id`,
    [id, now],
  );
  return rows.length > 0;
}

/** Every row about this approval is acted on: the owner decided it, wherever. */
export async function markActedForAction(db: Queryable, actionId: string, now: Date = new Date()): Promise<number> {
  if (!UUID.test(actionId)) return 0;
  const { rows } = await db.query(
    `update core.owner_notifications
        set acted_at = coalesce(acted_at, $2), seen_at = coalesce(seen_at, $2), updated_at = $2
      where action_id = $1 and acted_at is null returning id`,
    [actionId, now],
  );
  return rows.length;
}

/* ------------------------------------------------------------------ *
 * Presence
 * ------------------------------------------------------------------ */

/** A surface says the owner is there (`active`) or has left it (`away`). */
export async function presenceTouch(
  db: Queryable,
  surface: string,
  now: Date = new Date(),
  state: 'active' | 'away' = 'active',
): Promise<void> {
  if (state === 'active') {
    await db.query(
      `insert into core.owner_presence (surface, last_active_at, away_at, updated_at) values ($1, $2, null, $2)
       on conflict (surface) do update set last_active_at = excluded.last_active_at, away_at = null, updated_at = $2`,
      [surface, now],
    );
  } else {
    await db.query(
      `insert into core.owner_presence (surface, last_active_at, away_at, updated_at) values ($1, $2, $2, $2)
       on conflict (surface) do update set away_at = $2, updated_at = $2`,
      [surface, now],
    );
  }
}

/** The surfaces the owner is active on now: within two minutes, and not away since. */
export async function presentSurfaces(db: Queryable, now: Date = new Date()): Promise<string[]> {
  const { rows } = await db.query(
    `select surface from core.owner_presence
      where last_active_at > $1 and (away_at is null or away_at < last_active_at)
      order by surface`,
    [new Date(now.getTime() - PRESENCE_WINDOW_MS)],
  );
  return rows.map((r) => String(r.surface));
}

/** Is the owner active anywhere? Advisory: it picks where a message goes first, never whether. */
export async function ownerPresent(db: Queryable, now: Date = new Date()): Promise<boolean> {
  return (await presentSurfaces(db, now)).length > 0;
}

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

export async function readNotificationSettings(db: Queryable): Promise<NotificationSettings> {
  const { rows } = await db.query(
    `select default_channel, per_kind, quiet_start, quiet_end, end_of_day from core.notification_settings where id`,
  );
  const row = rows[0];
  if (!row) return { ...DEFAULT_NOTIFICATION_SETTINGS, perKind: {} };
  const perKind: NotificationSettings['perKind'] = {};
  if (row.per_kind && typeof row.per_kind === 'object') {
    for (const [k, v] of Object.entries(row.per_kind as Record<string, unknown>)) {
      if ((NOTIFICATION_KINDS as readonly string[]).includes(k) && typeof v === 'string' && v !== '') {
        perKind[k as NotificationKind] = v;
      }
    }
  }
  return {
    defaultChannel: row.default_channel ?? null,
    perKind,
    quietStart: row.quiet_start ?? null,
    quietEnd: row.quiet_end ?? null,
    endOfDay: row.end_of_day ?? DEFAULT_END_OF_DAY,
  };
}

/**
 * Check a whole settings value the page sent. Returns the settings to store,
 * or the sentence that says what is wrong.
 */
export function parseNotificationSettings(
  input: unknown,
): { ok: true; settings: NotificationSettings } | { ok: false; message: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, message: 'Settings must be an object.' };
  const o = input as Record<string, unknown>;
  const optionalTime = (v: unknown, name: string): string | null | Error => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !LOCAL_TIME.test(v.trim())) return new Error(`${name} must be a time like 22:00.`);
    return v.trim();
  };
  const defaultChannel = o.defaultChannel === undefined || o.defaultChannel === null || o.defaultChannel === ''
    ? null
    : typeof o.defaultChannel === 'string' ? o.defaultChannel.trim() : undefined;
  if (defaultChannel === undefined) return { ok: false, message: 'defaultChannel must be a channel or empty.' };
  const perKind: NotificationSettings['perKind'] = {};
  if (o.perKind !== undefined && o.perKind !== null) {
    if (typeof o.perKind !== 'object' || Array.isArray(o.perKind)) return { ok: false, message: 'perKind must be an object.' };
    for (const [k, v] of Object.entries(o.perKind as Record<string, unknown>)) {
      if (!(NOTIFICATION_KINDS as readonly string[]).includes(k)) return { ok: false, message: `${k} is not a kind of notification.` };
      if (v === null || v === '' || v === 'default') continue;
      if (typeof v !== 'string') return { ok: false, message: `perKind.${k} must be a channel, "default" or "off".` };
      if (v === 'off' && ALWAYS_REACH.has(k as NotificationKind)) {
        return { ok: false, message: 'Approvals and questions cannot be turned off.' };
      }
      perKind[k as NotificationKind] = v;
    }
  }
  const quietStart = optionalTime(o.quietStart, 'Quiet hours start');
  if (quietStart instanceof Error) return { ok: false, message: quietStart.message };
  const quietEnd = optionalTime(o.quietEnd, 'Quiet hours end');
  if (quietEnd instanceof Error) return { ok: false, message: quietEnd.message };
  if ((quietStart === null) !== (quietEnd === null)) return { ok: false, message: 'Quiet hours need both a start and an end.' };
  if (quietStart !== null && quietStart === quietEnd) return { ok: false, message: 'Quiet hours cannot start and end at the same time.' };
  const endOfDay = optionalTime(o.endOfDay, 'The end of the day');
  if (endOfDay instanceof Error) return { ok: false, message: endOfDay.message };
  return {
    ok: true,
    settings: { defaultChannel, perKind, quietStart, quietEnd, endOfDay: endOfDay ?? DEFAULT_END_OF_DAY },
  };
}

/** Replace the settings, whole. */
export async function writeNotificationSettings(db: Queryable, settings: NotificationSettings): Promise<void> {
  await db.query(
    `insert into core.notification_settings (id, default_channel, per_kind, quiet_start, quiet_end, end_of_day, updated_at)
     values (true, $1, $2::jsonb, $3, $4, $5, now())
     on conflict (id) do update set default_channel = excluded.default_channel, per_kind = excluded.per_kind,
       quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end, end_of_day = excluded.end_of_day,
       updated_at = now()`,
    [settings.defaultChannel, JSON.stringify(settings.perKind), settings.quietStart, settings.quietEnd, settings.endOfDay],
  );
}
