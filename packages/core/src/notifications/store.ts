/**
 * The record behind every notification, the owner's presence, and the
 * Notifications page's settings. Plain reads and guarded writes; routing
 * lives in `notify.ts`.
 */
import type { Offer } from '../offers/types.js';
import type { Queryable } from '../owner.js';
import { LOCAL_TIME } from '../time.js';
import { parseFocusSchedules, schedulesFromQuietHours, toFocusSchedules, toFocusSetting } from './focus.js';
import {
  ALWAYS_REACH,
  NOTIFICATION_KINDS,
  type AgentMessageSettings,
  type FocusSetting,
  type NotificationKind,
  type NotificationPreferences,
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
  schedules: [],
  endOfDay: DEFAULT_END_OF_DAY,
  focus: null,
  agents: { maxUrgency: 'now', muted: [] },
};

/** The stored `agent_messages` value, defaults filled in; anything malformed reads as the default. */
export function toAgentMessageSettings(value: unknown): AgentMessageSettings {
  const o = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const muted = Array.isArray(o.muted)
    ? [...new Set(o.muted.filter((m): m is string => typeof m === 'string' && m.trim() !== '').map((m) => m.trim()))]
    : [];
  return { maxUrgency: o.maxUrgency === 'today' ? 'today' : 'now', muted };
}

const iso = (v: unknown): string | null =>
  v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v);

export const NOTIFICATION_COLUMNS =
  'id, kind, urgency, title, text, link, offers, dedupe_key, agent_id, plugin_id, action_id, state, due_at, ' +
  'channel, fired_count, lowered, topic, also_from, held_for, created_at, sent_at, seen_at, acted_at, error';

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
    topic: row.topic ?? null,
    alsoFrom: Array.isArray(row.also_from) ? row.also_from.map(String) : [],
    heldFor: row.held_for ?? null,
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

/** Every row carrying this dedupe key is acted on: the thing it asked about was decided. */
export async function markActedForKey(db: Queryable, key: string, now: Date = new Date()): Promise<number> {
  if (key.trim() === '') return 0;
  const { rows } = await db.query(
    `update core.owner_notifications
        set acted_at = coalesce(acted_at, $2), seen_at = coalesce(seen_at, $2), updated_at = $2
      where dedupe_key = $1 and acted_at is null returning id`,
    [key, now],
  );
  return rows.length;
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
    `select default_channel, per_kind, quiet_start, quiet_end, end_of_day, schedules, focus, agent_messages
       from core.notification_settings where id`,
  );
  const row = rows[0];
  if (!row) return { ...DEFAULT_NOTIFICATION_SETTINGS, perKind: {}, schedules: [], agents: toAgentMessageSettings(null) };
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
    // Quiet hours never moved (migration 051 does it) read as the first schedule.
    schedules: toFocusSchedules(row.schedules) ?? schedulesFromQuietHours(row.quiet_start, row.quiet_end),
    endOfDay: row.end_of_day ?? DEFAULT_END_OF_DAY,
    focus: toFocusSetting(row.focus),
    agents: toAgentMessageSettings(row.agent_messages),
  };
}

/**
 * Check a whole settings value the page sent. Returns the settings to store,
 * or the sentence that says what is wrong.
 */
export function parseNotificationSettings(
  input: unknown,
): { ok: true; settings: NotificationPreferences } | { ok: false; message: string } {
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
  const schedules = parseFocusSchedules(o.schedules);
  if (!schedules.ok) return { ok: false, message: schedules.message };
  const endOfDay = optionalTime(o.endOfDay, 'The end of the day');
  if (endOfDay instanceof Error) return { ok: false, message: endOfDay.message };
  let agents: AgentMessageSettings | undefined;
  if (o.agents !== undefined && o.agents !== null) {
    if (typeof o.agents !== 'object' || Array.isArray(o.agents)) return { ok: false, message: 'agents must be an object.' };
    const a = o.agents as Record<string, unknown>;
    if (a.maxUrgency !== undefined && a.maxUrgency !== 'now' && a.maxUrgency !== 'today') {
      return { ok: false, message: 'agents.maxUrgency must be "now" or "today".' };
    }
    if (a.muted !== undefined && !Array.isArray(a.muted)) return { ok: false, message: 'agents.muted must be a list of agent ids.' };
    agents = toAgentMessageSettings(a);
  }
  return {
    ok: true,
    settings: {
      defaultChannel,
      perKind,
      schedules: schedules.schedules,
      endOfDay: endOfDay ?? DEFAULT_END_OF_DAY,
      ...(agents ? { agents } : {}),
    },
  };
}

/** Replace the settings, whole, but for the manual focus, which `writeFocus` owns. */
export async function writeNotificationSettings(db: Queryable, settings: NotificationPreferences): Promise<void> {
  await db.query(
    `insert into core.notification_settings
       (id, default_channel, per_kind, quiet_start, quiet_end, end_of_day, schedules, agent_messages, updated_at)
     values (true, $1, $2::jsonb, null, null, $3, $4::jsonb, $5::jsonb, now())
     on conflict (id) do update set default_channel = excluded.default_channel, per_kind = excluded.per_kind,
       quiet_start = null, quiet_end = null, end_of_day = excluded.end_of_day, schedules = excluded.schedules,
       agent_messages = coalesce($5::jsonb, core.notification_settings.agent_messages),
       updated_at = now()`,
    [settings.defaultChannel, JSON.stringify(settings.perKind), settings.endOfDay, JSON.stringify(settings.schedules),
      settings.agents ? JSON.stringify(settings.agents) : null],
  );
}

/**
 * Mute or unmute one agent's messages (`owner.notify`), leaving the rest of
 * the settings alone: the agent's Tools tab switches this without the page.
 */
export async function setAgentMuted(db: Queryable, agentId: string, muted: boolean): Promise<AgentMessageSettings> {
  const id = agentId.trim();
  if (id === '') throw new Error('an agent id is needed');
  const current = (await readNotificationSettings(db)).agents;
  const next: AgentMessageSettings = {
    ...current,
    muted: muted ? [...new Set([...current.muted, id])] : current.muted.filter((m) => m !== id),
  };
  await db.query(
    `insert into core.notification_settings (id, agent_messages, updated_at) values (true, $1::jsonb, now())
     on conflict (id) do update set agent_messages = excluded.agent_messages, updated_at = now()`,
    [JSON.stringify(next)],
  );
  return next;
}

/** Replace the manual focus; null when none is on. */
export async function writeFocus(db: Queryable, focus: FocusSetting | null): Promise<void> {
  await db.query(
    `insert into core.notification_settings (id, focus, updated_at) values (true, $1::jsonb, now())
     on conflict (id) do update set focus = excluded.focus, updated_at = now()`,
    [focus === null ? null : JSON.stringify(focus)],
  );
}
