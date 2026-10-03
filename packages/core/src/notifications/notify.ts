/**
 * The one call that reaches the owner, and the tick that keeps its promises
 * (docs/notifications.md).
 *
 * `notifyOwner` writes the row and routes it:
 *
 *   now     the owner is on the dashboard → shown there; if nobody has seen it
 *           in ten minutes, the default channel anyway. Away → the default
 *           channel at once. A focus (focus.ts) holds what its mode holds
 *           until it ends; approvals and questions always go.
 *   today   held until the end of the owner's day, then one message for all.
 *   digest  stored; the recap reads it.
 *
 * `notificationsTick` does the later half: escalations, the end of a focus
 * (one message for what waited), the end of the day. Every transition is one UPDATE guarded by the
 * state it leaves, so two ticks never send one row twice.
 */
import { getOwnerProfile } from '../onboarding/store.js';
import type { Queryable } from '../owner.js';
import { scrubText } from '../secrets/scrub.js';
import { isKnownTimezone, localDateString, nextLocalTime, timezoneFromEnv } from '../time.js';
import { channelFor, deliverTo } from './channels.js';
import { activeFocus, FOCUS_LABELS, focusEnd, focusHolds, heldKinds, scheduledFocus, type FocusDuration } from './focus.js';
import { notificationTopic, sameTopic, TOPIC_WINDOW_MS } from './topic.js';
import {
  NOTIFICATION_COLUMNS,
  presentSurfaces,
  readNotificationSettings,
  toNotification,
  writeFocus,
} from './store.js';
import {
  ALWAYS_REACH,
  NOTIFICATION_KINDS,
  NOTIFICATION_URGENCIES,
  type DeliverableMessage,
  type FocusMode,
  type FocusSetting,
  type FocusState,
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

type Route =
  | { state: 'shown'; dueAt: Date; channel: 'dashboard' }
  | { state: 'held'; dueAt: Date | null; heldFor?: FocusMode }
  | { state: 'stored' }
  | { state: 'deliver' };

/**
 * Where a message goes, before any channel is asked. Exported for the
 * routing table's tests; `notifyOwner` is the one caller.
 */
export function route(
  message: Pick<OwnerMessage, 'kind' | 'urgency'>,
  ctx: {
    now: Date;
    timezone: string;
    settings: NotificationSettings;
    onDashboard: boolean;
    focus: FocusState | null;
    /** Skip the on-dashboard hold (`OwnerMessage.immediate`). A focus still holds. */
    immediate?: boolean;
  },
): Route {
  const always = ALWAYS_REACH.has(message.kind);
  if (!always && ctx.settings.perKind[message.kind] === 'off') return { state: 'stored' };
  if (message.urgency === 'digest') return { state: 'stored' };
  if (message.urgency === 'today') {
    return { state: 'held', dueAt: nextLocalTime(ctx.now, ctx.timezone, ctx.settings.endOfDay) };
  }
  if (ctx.onDashboard && !ctx.immediate) {
    return { state: 'shown', dueAt: new Date(ctx.now.getTime() + ESCALATE_AFTER_MS), channel: 'dashboard' };
  }
  if (ctx.focus && focusHolds(ctx.focus.mode, message.kind, message.urgency)) {
    return { state: 'held', dueAt: ctx.focus.until ? new Date(ctx.focus.until) : null, heldFor: ctx.focus.mode };
  }
  return { state: 'deliver' };
}

/** "@scout: ", the prefix an agent's own message carries on every channel. */
export function agentSignature(message: Pick<OwnerMessage, 'agentHandle' | 'agentId'>): string {
  const handle = (message.agentHandle ?? message.agentId ?? 'agent').trim().replace(/^@+/, '') || 'agent';
  return `@${handle}: `;
}

/** One line of an end-of-day or end-of-focus message. An agent's own message is already signed. */
function summaryLine(row: OwnerNotification): string {
  return row.kind === 'agent' ? `- ${row.title}` : `- ${row.agentId ?? row.pluginId ?? 'buddi'}: ${row.title}`;
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

const UUID_AUDIO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    ...(row.action ? { action: row.action } : {}),
    ...(row.audio ? { audio: row.audio } : {}),
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
  const kind = await channelFor(settings, row.kind);
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
  const action = message.action?.trim() ? scrubText(message.action.trim().replace(/\s*\n\s*/g, ' ')) : null;

  // The unsent row this key already has, if any: it is updated, not repeated.
  let existing: OwnerNotification | null = null;
  let fires = 0;
  if (dedupeKey) {
    const { rows } = await db.query(
      `select ${NOTIFICATION_COLUMNS} from core.owner_notifications
        where dedupe_key = $1 and sent_at is null and state in ('shown', 'held', 'stored', 'failed')
          -- A question the owner answered is settled: asking again is a new row.
          and answer is null
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

  // The same thing from another agent (or unkeyed, again): folded into the
  // open row that already says it, and never delivered a second time.
  // Approvals and questions carry their own action and are never folded.
  const topic = always || message.kind === 'agent' ? null : notificationTopic({ title: baseTitle, text, agentId: message.agentId ?? null }) || null;
  // An agent's own message is never folded: it says it is from that agent.
  // A message carrying a voice note is its own: folding would lose the recording.
  const audio = typeof message.audio === 'string' && UUID_AUDIO.test(message.audio) ? message.audio : null;
  if (!existing && topic && message.kind !== 'agent' && action === null && audio === null) {
    const folded = await foldIntoTopic(db, { ...message, title: baseTitle, text, dedupeKey, topic }, now);
    if (folded) return folded;
  }

  // The rate rule. Approvals and questions are never lowered.
  let urgency = message.urgency;
  let lowered = existing?.lowered ?? false;
  if (!always && urgency === 'now' && dedupeKey && (lowered || fires + 1 > RATE_LIMIT_PER_HOUR)) {
    urgency = 'today';
    lowered = true;
  }
  // An agent's own message is signed, on every channel: it cannot pass for buddi.
  const signed = message.kind === 'agent' ? `${agentSignature(message)}${baseTitle}` : baseTitle;
  const title = lowered ? `${signed} ${LOWERED_SENTENCE}` : signed;

  const onDashboard = (await presentSurfaces(db, now)).includes(DASHBOARD_SURFACE);
  const focus = activeFocus(settings, now, timezone);
  let next = route(
    { kind: message.kind, urgency },
    { now, timezone, settings, onDashboard, focus, immediate: message.immediate === true },
  );
  // A repeat shown on the dashboard keeps the clock it started, unless the
  // owner had already seen the earlier one: then the new content is unseen.
  if (next.state === 'shown' && existing?.state === 'shown' && existing.seenAt === null && existing.dueAt) {
    next = { ...next, dueAt: new Date(existing.dueAt) };
  }
  const state: NotificationState = next.state === 'deliver' ? 'sending' : next.state;
  const dueAt = 'dueAt' in next ? next.dueAt : null;
  const channel = next.state === 'shown' ? 'dashboard' : null;
  const heldFor = next.state === 'held' ? next.heldFor ?? null : null;
  const offers = JSON.stringify(message.offers ?? []);

  let row: OwnerNotification;
  if (existing) {
    const { rows } = await db.query(
      `update core.owner_notifications
          set urgency = $2, title = $3, text = $4, link = $5, offers = $6::jsonb, agent_id = coalesce($7, agent_id),
              topic = coalesce($15, topic), plugin_id = coalesce($8, plugin_id), action_id = coalesce($9::uuid, action_id), state = $10, due_at = $11,
              channel = $12, fired_count = fired_count + 1, lowered = $13,
              seen_at = case when $17 then null else seen_at end, error = null, updated_at = $14,
              held_for = $16, action = $18, audio = $19::uuid
        where id = $1 and sent_at is null and state in ('shown', 'held', 'stored', 'failed') and answer is null
        returning ${NOTIFICATION_COLUMNS}`,
      [existing.id, urgency, title, text, message.link?.route ?? null, offers, message.agentId ?? null,
        message.pluginId ?? null, message.actionId ?? null, state, dueAt, channel, lowered, now, topic, heldFor,
        // Something that asks for the owner now comes back unseen, and so
        // does a new or changed action whatever its urgency: a request the
        // owner has not seen yet is not settled by having read an earlier
        // one. A quiet line (today, digest) that says more, or a retry with
        // the same action, is updated where it is: reading it again is not news.
        urgency === 'now' || (action !== null && action !== (existing.action ?? null)), action, audio],
    );
    if (rows[0]) row = toNotification(rows[0]);
    else existing = null; // Sent between the read and the write: this is a new message after all.
  }
  if (!existing) {
    const { rows } = await db.query(
      `insert into core.owner_notifications
         (kind, urgency, title, text, link, offers, dedupe_key, agent_id, plugin_id, action_id, state, due_at, channel,
          lowered, created_at, updated_at, topic, held_for, action, audio)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::uuid, $11, $12, $13, $14, $15, $15, $16, $17, $18, $19::uuid)
       returning ${NOTIFICATION_COLUMNS}`,
      [message.kind, urgency, title, text, message.link?.route ?? null, offers, dedupeKey, message.agentId ?? null,
        message.pluginId ?? null, message.actionId ?? null, state, dueAt, channel, lowered, now, topic, heldFor, action, audio],
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

/**
 * Fold a message into the open row with the same topic, if there is one: a
 * row not acted on, written or refreshed in the last 48 hours, from any agent,
 * that is not an approval or a question and does not carry this message's own
 * key (that one the key rule handles). The row keeps its state, so what was
 * sent is not sent again and what is waiting keeps waiting; it gains the
 * other agent under `also_from`, the new title and text when they say more,
 * and the new time. Null when nothing matches.
 */
async function foldIntoTopic(
  db: Queryable,
  message: Omit<OwnerMessage, 'text' | 'dedupeKey'> & { text: string | null; dedupeKey: string | null; topic: string },
  now: Date,
): Promise<NotifyResult | null> {
  const { rows } = await db.query(
    `select ${NOTIFICATION_COLUMNS} from core.owner_notifications
      where topic is not null and acted_at is null and created_at > $1 and kind not in ('approval', 'question')
        and not (dedupe_key is not null and dedupe_key = coalesce($2, ''))
      order by created_at desc limit 50`,
    [new Date(now.getTime() - TOPIC_WINDOW_MS), message.dedupeKey],
  );
  const match = rows.map(toNotification).find((r) => sameTopic(r.topic, message.topic));
  if (!match) return null;
  const from = message.agentId ?? message.pluginId ?? null;
  const also = from && from !== (match.agentId ?? match.pluginId) && !match.alsoFrom.includes(from) ? from : null;
  const longer = `${message.title}\n${message.text ?? ''}`.trim().length > `${match.title}\n${match.text ?? ''}`.trim().length;
  const { rows: updated } = await db.query(
    `update core.owner_notifications
        set title = case when $2 then $3 else title end,
            text = case when $2 then $4 else text end,
            also_from = case when $5::text is null then also_from else array_append(also_from, $5::text) end,
            fired_count = fired_count + 1, created_at = $6, updated_at = $6
      where id = $1 and acted_at is null
      returning ${NOTIFICATION_COLUMNS}`,
    [match.id, longer, message.title, message.text, also, now],
  );
  if (!updated[0]) return null; // Acted on between the read and the write: a new message after all.
  const row = toNotification(updated[0]);
  return { id: row.id, state: row.state, channel: row.channel, error: row.error, deduped: true, lowered: row.lowered };
}

/** What one tick did. */
export interface NotificationsTickResult {
  escalated: number;
  endOfDay: number;
  /** Rows told in the one message at the end of a focus. */
  focusEnded: number;
  failed: number;
}

/**
 * The later half of routing: runs on the gateway's 60-second loop.
 *
 * 1. Focus: a `now` row that falls due while a focus holds its kind waits
 *    for the end of the focus; when the focus ends, what waited goes out as
 *    one message (`settleFocus`).
 * 2. Escalation: a `now` row shown on the dashboard and not seen goes to its
 *    channel.
 * 3. End of the day: every held `today` row goes out as one message.
 */
export async function notificationsTick(db: Queryable, deps: NotifyDeps, now: Date = deps.now?.() ?? new Date()): Promise<NotificationsTickResult> {
  const timezone = await ownerTimezone(db, deps);
  const settings = await readNotificationSettings(db);
  const outcome: NotificationsTickResult = { escalated: 0, endOfDay: 0, focusEnded: 0, failed: 0 };

  const settled = await settleFocus(db, settings, timezone, now);
  outcome.focusEnded = settled.told;
  outcome.failed += settled.failed;

  // A row held by a focus waits for `settleFocus`, never for its own `due_at`.
  const { rows: claimed } = await db.query(
    `update core.owner_notifications set state = 'sending', updated_at = $1
      where urgency = 'now' and due_at <= $1 and acted_at is null
        and ((state = 'shown' and seen_at is null) or (state = 'held' and held_for is null))
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
    const kind = await channelFor(settings);
    const message: DeliverableMessage = {
      id: `today:${localDateString(now, timezone)}`,
      kind: 'recap',
      urgency: 'today',
      title: `Today, ${rows.length} ${rows.length === 1 ? 'thing' : 'things'}:`,
      text: rows.map(summaryLine).join('\n'),
      parts: rows.map(toDeliverable),
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

/**
 * Keep held rows in step with the focus in force, and say what waited when
 * it ends.
 *
 * While a focus is on, a `now` row of a kind it holds that falls due on the
 * dashboard unseen is held too, and every row it holds is dated to its end
 * (a longer or shorter focus moves them all). Rows held by a focus that no
 * longer holds them (it ended, was turned off, or became Urgent only) go out
 * as one message on the owner's channel, "While you were in Do not disturb:
 * 4 things.", one line each, and are marked sent in it; nothing held,
 * nothing said. Rows the owner already dealt with are left out.
 */
export async function settleFocus(
  db: Queryable,
  settings: NotificationSettings,
  timezone: string,
  now: Date,
): Promise<{ told: number; failed: number }> {
  const focus = activeFocus(settings, now, timezone);
  const holding = focus ? heldKinds(focus.mode) : [];
  if (focus && holding.length > 0) {
    await db.query(
      `update core.owner_notifications set state = 'held', due_at = $2, held_for = $3, updated_at = $1
        where urgency = 'now' and acted_at is null and kind = any($4::text[])
          and ((state = 'shown' and seen_at is null and due_at <= $1) or (state = 'held' and held_for is not null))`,
      [now, focus.until, focus.mode, holding],
    );
  }
  await db.query(
    `update core.owner_notifications set state = 'stored', updated_at = $1
      where state = 'held' and held_for is not null and acted_at is not null and not (kind = any($2::text[]))`,
    [now, holding],
  );
  const { rows: claimed } = await db.query(
    `update core.owner_notifications set state = 'sending', updated_at = $1
      where state = 'held' and held_for is not null and acted_at is null and not (kind = any($2::text[]))
      returning ${NOTIFICATION_COLUMNS}`,
    [now, holding],
  );
  if (claimed.length === 0) return { told: 0, failed: 0 };
  const rows = claimed.map(toNotification).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const mode: FocusMode = rows.some((r) => r.heldFor === 'do-not-disturb') ? 'do-not-disturb' : 'urgent-only';
  const message: DeliverableMessage = {
    id: `focus:${now.toISOString()}`,
    kind: 'recap',
    urgency: 'now',
    title: focusSummaryTitle(mode, rows.length),
    text: rows.map(summaryLine).join('\n'),
    parts: rows.map(toDeliverable),
  };
  const kind = await channelFor(settings);
  const answer = kind === null || kind === 'off' ? { ok: false as const, error: 'no channel' } : await deliverTo(kind, message);
  const ids = rows.map((r) => r.id);
  if (answer.ok) {
    await db.query(
      `update core.owner_notifications set state = 'sent', channel = $2, sent_at = $3, error = null, updated_at = $3
        where id = any($1::uuid[]) and state = 'sending'`,
      [ids, kind, now],
    );
    return { told: rows.length, failed: 0 };
  }
  await db.query(
    `update core.owner_notifications set state = 'failed', channel = $2, error = $3, updated_at = $4
      where id = any($1::uuid[]) and state = 'sending'`,
    [ids, kind === 'off' ? null : kind, answer.error, now],
  );
  return { told: 0, failed: rows.length };
}

/** "While you were in Do not disturb: 4 things." */
export function focusSummaryTitle(mode: FocusMode, count: number): string {
  return `While you were in ${FOCUS_LABELS[mode]}: ${count} ${count === 1 ? 'thing' : 'things'}.`;
}

/** The focus in force now, for the owner menu and /focus; null when none is. */
export async function readFocusState(db: Queryable, deps: NotifyDeps = {}): Promise<FocusState | null> {
  const now = deps.now?.() ?? new Date();
  return activeFocus(await readNotificationSettings(db), now, await ownerTimezone(db, deps));
}

/**
 * Switch the manual focus: a mode for a duration (`1h`, `3h`, `tomorrow`,
 * `indefinite`), or `normal` to turn it off. Turning off while a schedule is
 * on keeps it off until that schedule ends: a manual choice wins while it
 * lasts. Held rows are settled at once, so turning off says what waited now,
 * not at the next tick. Throws for a mode or duration that is not one.
 */
export async function setFocus(
  db: Queryable,
  deps: NotifyDeps,
  input: { mode: FocusMode; duration?: FocusDuration; by: FocusSetting['by'] },
): Promise<FocusState | null> {
  const now = deps.now?.() ?? new Date();
  const timezone = await ownerTimezone(db, deps);
  const settings = await readNotificationSettings(db);
  let focus: FocusSetting | null;
  if (input.mode === 'normal') {
    const scheduled = scheduledFocus(settings.schedules, now, timezone);
    focus = scheduled ? { mode: 'normal', until: scheduled.until, startedAt: now.toISOString(), by: input.by } : null;
  } else if (input.mode === 'urgent-only' || input.mode === 'do-not-disturb') {
    const end = focusEnd(input.duration ?? 'indefinite', now, timezone);
    if (end === undefined) throw new Error(`"${String(input.duration)}" is not a duration (1h, 3h, tomorrow or indefinite)`);
    focus = { mode: input.mode, until: end?.toISOString() ?? null, startedAt: now.toISOString(), by: input.by };
  } else {
    throw new Error(`"${String(input.mode)}" is not a focus mode`);
  }
  await writeFocus(db, focus);
  const next = { ...settings, focus };
  await settleFocus(db, next, timezone, now);
  return activeFocus(next, now, timezone);
}
