/**
 * The dashboard's side of notifications (docs/notifications.md): the list,
 * "seen", the settings the Notifications page edits, and presence.
 *
 *   GET  /api/notifications?limit=20        the newest rows
 *   POST /api/notifications/:id/seen        the page drew it, or the owner opened it
 *   GET  /api/notifications/settings        the settings, and the channels there are
 *   PUT  /api/notifications/settings        the whole settings value, replaced
 *   POST /api/notifications/test { channel } one line through that channel, now
 *   POST /api/presence { state }            `active` every 30 s while the page is
 *                                           visible and focused; `away` on blur or hide
 *
 * Presence is its own small POST rather than a frame on the chat stream: the
 * stream is per conversation and opened only while a chat is on screen, and
 * the owner is present on Home and Settings too.
 */
import {
  deliverTo,
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

/** What "Send a test" sends: one line, nothing to act on. */
export const TEST_MESSAGE_TITLE = 'A test from buddi. This is where your messages will arrive.';

/**
 * "Send a test": one line straight through the named channel. Not a
 * notification: it skips the routing, quiet hours and the record, so a test
 * never shows in the last twenty or waits for the morning.
 */
export async function testChannelRoute(body: Record<string, unknown>, now: Date): Promise<NotificationsRouteReply> {
  const channel = typeof body.channel === 'string' ? body.channel.trim() : '';
  if (!channel) return { status: 400, body: { error: '`channel` must name a channel.' } };
  if (!listChannels().some((c) => c.kind === channel)) return { status: 404, body: { error: 'There is no such channel.' } };
  const sent = await deliverTo(channel, { id: `test:${now.getTime()}`, kind: 'recap', urgency: 'now', title: TEST_MESSAGE_TITLE });
  return sent.ok
    ? { status: 200, body: { ok: true } }
    : { status: 502, body: { error: `The test did not go through: ${sent.error}.` } };
}
