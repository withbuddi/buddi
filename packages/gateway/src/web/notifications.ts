/**
 * The dashboard's side of notifications (docs/notifications.md): the list,
 * "seen", the settings the Notifications page edits, and presence.
 *
 *   GET  /api/notifications?limit=20        the newest rows
 *   POST /api/notifications/:id/seen        the page drew it, or the owner opened it
 *   GET  /api/notifications/settings        the settings, and the channels there are
 *   PUT  /api/notifications/settings        the whole settings value, replaced
 *   POST /api/presence { state }            `active` every 30 s while the page is
 *                                           visible and focused; `away` on blur or hide
 *
 * Presence is its own small POST rather than a frame on the chat stream: the
 * stream is per conversation and opened only while a chat is on screen, and
 * the owner is present on Home and Settings too.
 */
import {
  listChannels,
  listNotifications,
  markSeen,
  parseNotificationSettings,
  presenceTouch,
  readNotificationSettings,
  writeNotificationSettings,
  type Queryable,
} from '@buddi/core';

export interface NotificationsRouteReply {
  status: number;
  body: unknown;
}

/** The surface name the dashboard's presence is kept under. */
export const WEB_PRESENCE_SURFACE = 'web';

export async function listNotificationsRoute(pool: Queryable, limit: string | null): Promise<NotificationsRouteReply> {
  const n = limit === null ? 20 : Number(limit);
  return { status: 200, body: { notifications: await listNotifications(pool, { limit: Number.isFinite(n) ? n : 20 }) } };
}

export async function markSeenRoute(pool: Queryable, id: string, now: Date): Promise<NotificationsRouteReply> {
  return (await markSeen(pool, id, now))
    ? { status: 200, body: { ok: true } }
    : { status: 404, body: { error: 'There is no such notification.' } };
}

export async function notificationSettingsRoute(
  pool: Queryable,
  method: 'GET' | 'PUT',
  body?: unknown,
): Promise<NotificationsRouteReply> {
  if (method === 'PUT') {
    const parsed = parseNotificationSettings(body);
    if (!parsed.ok) return { status: 400, body: { error: parsed.message } };
    await writeNotificationSettings(pool, parsed.settings);
  }
  return { status: 200, body: { settings: await readNotificationSettings(pool), channels: listChannels() } };
}

export async function presenceRoute(pool: Queryable, body: Record<string, unknown>, now: Date): Promise<NotificationsRouteReply> {
  const state = body.state;
  if (state !== 'active' && state !== 'away') return { status: 400, body: { error: '`state` must be "active" or "away".' } };
  await presenceTouch(pool, WEB_PRESENCE_SURFACE, now, state);
  return { status: 200, body: { ok: true } };
}
