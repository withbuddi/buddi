/**
 * The one call that reaches the owner, and the tick that keeps its promises
 * (docs/notifications.md).
 *
 * `notifyOwner` writes the row and routes it:
 *
 *   now     the owner is on the dashboard → shown there; if nobody has seen it
 *           in ten minutes, the default channel anyway. Away → the default
 *           channel at once. Quiet hours hold it until they end, except
 *           approvals and questions.
 *   today   held until the end of the owner's day, then one message for all.
 *   digest  stored; the recap reads it.
 *
 * `notificationsTick` does the later half: escalations, the end of quiet
 * hours, the end of the day. Every transition is one UPDATE guarded by the
 * state it leaves, so two ticks never send one row twice.
 */
import { getOwnerProfile } from '../onboarding/store.js';
import type { Queryable } from '../owner.js';
import { scrubText } from '../secrets/scrub.js';
import {
  isKnownTimezone,
  localDateString,
  localMinutesOfDay,
  minutesOfLocalTime,
  nextLocalTime,
  timezoneFromEnv,
} from '../time.js';
import { channelFor, deliverTo } from './channels.js';
import {
  NOTIFICATION_COLUMNS,
  presentSurfaces,
  readNotificationSettings,
  toNotification,
} from './store.js';
import {
  ALWAYS_REACH,
  NOTIFICATION_KINDS,
  NOTIFICATION_URGENCIES,
  type DeliverableMessage,
  type NotificationSettings,
  type NotificationState,
  type NotifyDeps,
  type NotifyResult,
  type OwnerMessage,
  type OwnerNotification,
} from './types.js';

/** A `now` message shown on the dashboard goes to the channel after this long unseen. */
export const ESCALATE_AFTER_MS = 10 * 60_000;

/** The rate rule: more than this many fires of one key in an hour lowers `now` to `today`. */
export const RATE_LIMIT_PER_HOUR = 3;

/** Said once, on the title, when the rate rule lowers a message. */
export const LOWERED_SENTENCE = 'This came up more than three times in an hour, so it waits for the end of the day.';

/** The surface whose presence means "shown on the dashboard". */
export const DASHBOARD_SURFACE = 'web';

async function ownerTimezone(db: Queryable, deps: NotifyDeps): Promise<string> {
  try {
    const profile = await getOwnerProfile(db);
    if (profile.timezone && isKnownTimezone(profile.timezone)) return profile.timezone.trim();
  } catch {
    // No owner row yet is not a reason to lose a message.
  }
  return deps.timezone ?? timezoneFromEnv();
}

/** Inside quiet hours at `now`, and the instant they end; null when there are none or it is not quiet. */
export function quietUntil(settings: NotificationSettings, now: Date, timezone: string): Date | null {
  if (!settings.quietStart || !settings.quietEnd) return null;
  const start = minutesOfLocalTime(settings.quietStart);
  const end = minutesOfLocalTime(settings.quietEnd);
  const at = localMinutesOfDay(now, timezone);
  const quiet = start < end ? at >= start && at < end : at >= start || at < end;
  return quiet ? nextLocalTime(now, timezone, settings.quietEnd) : null;
}

type Route =
  | { state: 'shown'; dueAt: Date; channel: 'dashboard' }
  | { state: 'held'; dueAt: Date }
  | { state: 'stored' }
  | { state: 'deliver' };

function route(
  message: Pick<OwnerMessage, 'kind' | 'urgency'>,
  ctx: { now: Date; timezone: string; settings: NotificationSettings; onDashboard: boolean },
): Route {
  const always = ALWAYS_REACH.has(message.kind);
  if (!always && ctx.settings.perKind[message.kind] === 'off') return { state: 'stored' };
  if (message.urgency === 'digest') return { state: 'stored' };
  if (message.urgency === 'today') {
    return { state: 'held', dueAt: nextLocalTime(ctx.now, ctx.timezone, ctx.settings.endOfDay) };
  }
  if (ctx.onDashboard) {
    return { state: 'shown', dueAt: new Date(ctx.now.getTime() + ESCALATE_AFTER_MS), channel: 'dashboard' };
  }
  const quiet = always ? null : quietUntil(ctx.settings, ctx.now, ctx.timezone);
  if (quiet) return { state: 'held', dueAt: quiet };
  return { state: 'deliver' };
}

function checkMessage(message: OwnerMessage): void {
  if (!(NOTIFICATION_KINDS as readonly string[]).includes(message.kind)) {
    throw new Error(`"${String(message.kind)}" is not a kind of notification`);
  }
  if (!(NOTIFICATION_URGENCIES as readonly string[]).includes(message.urgency)) {
    throw new Error(`"${String(message.urgency)}" is not an urgency (now, today or digest)`);
  }
  if (typeof message.title !== 'string' || message.title.trim() === '') throw new Error('a notification needs a title');
  if (message.link && (typeof message.link.route !== 'string' || !message.link.route.startsWith('#/'))) {
    throw new Error('a notification link is a dashboard route, like #/chat/…');
  }
}

function toDeliverable(row: OwnerNotification): DeliverableMessage {
  return {
    id: row.id,
    kind: row.kind,
    urgency: row.urgency,
    title: row.title,
    ...(row.text ? { text: row.text } : {}),
    ...(row.link ? { link: { route: row.link } } : {}),
    ...(row.offers.length > 0 ? { offers: row.offers } : {}),
    ...(row.dedupeKey ? { dedupeKey: row.dedupeKey } : {}),
    ...(row.agentId ? { agentId: row.agentId } : {}),
    ...(row.pluginId ? { pluginId: row.pluginId } : {}),
    ...(row.actionId ? { actionId: row.actionId } : {}),
  };
}

/**
 * Send one claimed row (`state = 'sending'`) and write what came of it. A
 * channel that refuses or throws is written as `error`; nothing is thrown.
 */
async function sendClaimed(
  db: Queryable,
  row: OwnerNotification,
  settings: NotificationSettings,
  now: Date,
): Promise<{ state: NotificationState; channel: string | null; error: string | null }> {
  const kind = channelFor(settings, row.kind);
  if (kind === 'off') {
    await db.query(
      `update core.owner_notifications set state = 'stored', updated_at = $2 where id = $1 and state = 'sending'`,
      [row.id, now],
    );
    return { state: 'stored', channel: null, error: null };
  }
  const outcome = kind === null ? { ok: false as const, error: 'no channel' } : await deliverTo(kind, toDeliverable(row));
  if (outcome.ok) {
    await db.query(
      `update core.owner_notifications set state = 'sent', channel = $2, sent_at = $3, error = null, updated_at = $3
        where id = $1 and state = 'sending'`,
      [row.id, kind, now],
    );
    return { state: 'sent', channel: kind, error: null };
  }
  await db.query(
    `update core.owner_notifications set state = 'failed', channel = $2, error = $3, updated_at = $4
      where id = $1 and state = 'sending'`,
    [row.id, kind, outcome.error, now],
  );
  return { state: 'failed', channel: kind, error: outcome.error };
}

/**
 * Tell the owner something. Writes the row, routes it, and never throws for
 * a channel's sake: a message with nowhere to go is a row with `error`.
 * Throws only for a malformed message, which is the caller's bug.
 */
export async function notifyOwner(db: Queryable, deps: NotifyDeps, message: OwnerMessage): Promise<NotifyResult> {
  checkMessage(message);
  const now = deps.now?.() ?? new Date();
  const timezone = await ownerTimezone(db, deps);
  const settings = await readNotificationSettings(db);
  const always = ALWAYS_REACH.has(message.kind);
  const dedupeKey = message.dedupeKey?.trim() || null;

  // What leaves the machine on a push channel is scrubbed like everything else.
  const baseTitle = scrubText(message.title.trim().replace(/\s*\n\s*/g, ' '));
  const text = message.text?.trim() ? scrubText(message.text.trim()) : null;

  // The unsent row this key already has, if any: it is updated, not repeated.
  let existing: OwnerNotification | null = null;
  let fires = 0;
  if (dedupeKey) {
    const { rows } = await db.query(
      `select ${NOTIFICATION_COLUMNS} from core.owner_notifications
        where dedupe_key = $1 and sent_at is null and state in ('shown', 'held', 'stored', 'failed')
        order by created_at desc limit 1`,
      [dedupeKey],
    );
    existing = rows[0] ? toNotification(rows[0]) : null;
    const counted = await db.query(
      `select coalesce(sum(fired_count), 0)::int as n from core.owner_notifications
        where dedupe_key = $1 and updated_at > $2`,
      [dedupeKey, new Date(now.getTime() - 3_600_000)],
    );
    fires = Number(counted.rows[0]?.n ?? 0);
  }

  // The rate rule. Approvals and questions are never lowered.
  let urgency = message.urgency;
  let lowered = existing?.lowered ?? false;
  if (!always && urgency === 'now' && dedupeKey && (lowered || fires + 1 > RATE_LIMIT_PER_HOUR)) {
    urgency = 'today';
    lowered = true;
  }
  const title = lowered ? `${baseTitle} ${LOWERED_SENTENCE}` : baseTitle;

  const onDashboard = (await presentSurfaces(db, now)).includes(DASHBOARD_SURFACE);
  let next = route({ kind: message.kind, urgency }, { now, timezone, settings, onDashboard });
  // A repeat shown on the dashboard keeps the clock it started, unless the
  // owner had already seen the earlier one: then the new content is unseen.
  if (next.state === 'shown' && existing?.state === 'shown' && existing.seenAt === null && existing.dueAt) {
    next = { ...next, dueAt: new Date(existing.dueAt) };
  }
  const state: NotificationState = next.state === 'deliver' ? 'sending' : next.state;
  const dueAt = 'dueAt' in next ? next.dueAt : null;
  const channel = next.state === 'shown' ? 'dashboard' : null;
  const offers = JSON.stringify(message.offers ?? []);

  let row: OwnerNotification;
  if (existing) {
    const { rows } = await db.query(
      `update core.owner_notifications
          set urgency = $2, title = $3, text = $4, link = $5, offers = $6::jsonb, agent_id = coalesce($7, agent_id),
              plugin_id = coalesce($8, plugin_id), action_id = coalesce($9::uuid, action_id), state = $10, due_at = $11,
              channel = $12, fired_count = fired_count + 1, lowered = $13, seen_at = null, error = null, updated_at = $14
        where id = $1 and sent_at is null and state in ('shown', 'held', 'stored', 'failed')
        returning ${NOTIFICATION_COLUMNS}`,
      [existing.id, urgency, title, text, message.link?.route ?? null, offers, message.agentId ?? null,
        message.pluginId ?? null, message.actionId ?? null, state, dueAt, channel, lowered, now],
    );
    if (rows[0]) row = toNotification(rows[0]);
    else existing = null; // Sent between the read and the write: this is a new message after all.
  }
  if (!existing) {
    const { rows } = await db.query(
      `insert into core.owner_notifications
         (kind, urgency, title, text, link, offers, dedupe_key, agent_id, plugin_id, action_id, state, due_at, channel,
          lowered, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::uuid, $11, $12, $13, $14, $15, $15)
       returning ${NOTIFICATION_COLUMNS}`,
      [message.kind, urgency, title, text, message.link?.route ?? null, offers, dedupeKey, message.agentId ?? null,
        message.pluginId ?? null, message.actionId ?? null, state, dueAt, channel, lowered, now],
    );
    row = toNotification(rows[0]);
  }
  row = row!;

  const result: NotifyResult = {
    id: row.id,
    state: row.state,
    channel: row.channel,
    error: null,
    deduped: existing !== null,
    lowered,
  };
  if (row.state !== 'sending') return result;
  const sent = await sendClaimed(db, row, settings, now);
  return { ...result, ...sent };
}

/** What one tick did. */
export interface NotificationsTickResult {
  escalated: number;
  endOfDay: number;
  failed: number;
}

/**
 * The later half of routing: runs on the gateway's 60-second loop.
 *
 * 1. Quiet hours: a `now` row that falls due while it is quiet (and is not an
 *    approval or a question) waits for the end of them.
 * 2. Escalation: a `now` row shown on the dashboard and not seen, or held
 *    through quiet hours, goes to its channel.
 * 3. End of the day: every held `today` row goes out as one message.
 */
export async function notificationsTick(db: Queryable, deps: NotifyDeps, now: Date = deps.now?.() ?? new Date()): Promise<NotificationsTickResult> {
  const timezone = await ownerTimezone(db, deps);
  const settings = await readNotificationSettings(db);
  const outcome: NotificationsTickResult = { escalated: 0, endOfDay: 0, failed: 0 };

  const quiet = quietUntil(settings, now, timezone);
  if (quiet) {
    await db.query(
      `update core.owner_notifications set state = 'held', due_at = $2, updated_at = $1
        where urgency = 'now' and due_at <= $1 and acted_at is null and kind not in ('approval', 'question')
          and ((state = 'shown' and seen_at is null) or state = 'held')`,
      [now, quiet],
    );
  }

  const { rows: claimed } = await db.query(
    `update core.owner_notifications set state = 'sending', updated_at = $1
      where urgency = 'now' and due_at <= $1 and acted_at is null
        and ((state = 'shown' and seen_at is null) or state = 'held')
      returning ${NOTIFICATION_COLUMNS}`,
    [now],
  );
  for (const raw of claimed) {
    const sent = await sendClaimed(db, toNotification(raw), settings, now);
    if (sent.state === 'sent') outcome.escalated += 1;
    if (sent.state === 'failed') outcome.failed += 1;
  }

  // Held for the end of the day but already dealt with on the dashboard.
  await db.query(
    `update core.owner_notifications set state = 'stored', updated_at = $1
      where state = 'held' and urgency = 'today' and acted_at is not null`,
    [now],
  );
  const { rows: today } = await db.query(
    `update core.owner_notifications set state = 'sending', updated_at = $1
      where state = 'held' and urgency = 'today' and due_at <= $1 and acted_at is null
      returning ${NOTIFICATION_COLUMNS}`,
    [now],
  );
  if (today.length > 0) {
    const rows = today.map(toNotification).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const kind = channelFor(settings);
    const message: DeliverableMessage = {
      id: `today:${localDateString(now, timezone)}`,
      kind: 'recap',
      urgency: 'today',
      title: `Today, ${rows.length} ${rows.length === 1 ? 'thing' : 'things'}:`,
      text: rows.map((r) => `- ${r.agentId ?? r.pluginId ?? 'buddi'}: ${r.title}`).join('\n'),
    };
    const answer = kind === null || kind === 'off' ? { ok: false as const, error: 'no channel' } : await deliverTo(kind, message);
    const ids = rows.map((r) => r.id);
    if (answer.ok) {
      await db.query(
        `update core.owner_notifications set state = 'sent', channel = $2, sent_at = $3, error = null, updated_at = $3
          where id = any($1::uuid[]) and state = 'sending'`,
        [ids, kind, now],
      );
      outcome.endOfDay = rows.length;
    } else {
      await db.query(
        `update core.owner_notifications set state = 'failed', channel = $2, error = $3, updated_at = $4
          where id = any($1::uuid[]) and state = 'sending'`,
        [ids, kind === 'off' ? null : kind, answer.error, now],
      );
      outcome.failed += rows.length;
    }
  }
  return outcome;
}
