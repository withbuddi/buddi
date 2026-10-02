/**
 * An agent tells the owner something itself: the core half of `owner.notify`
 * (docs/notifications.md, "Messages from your agents").
 *
 * A thin layer over `notifyOwner`. It adds what only an agent's own message
 * needs: the owner's switch, the highest urgency they allow, a per-agent
 * mute, two per-agent limits, the key scoped to the agent, the interactive
 * exception, and a sentence the agent can repeat truthfully about where the
 * message went. Everything else is the owner's routing, unchanged.
 */
import type { Queryable } from '../owner.js';
import { channelFor, listChannels } from './channels.js';
import { FOCUS_LABELS } from './focus.js';
import { ESCALATE_AFTER_MS, notifyOwner } from './notify.js';
import { readNotificationSettings } from './store.js';
import type { FocusMode, NotifyDeps, NotifyResult } from './types.js';

/** Per agent: more `now` messages than this in an hour are lowered to `today`. */
export const AGENT_NOW_PER_HOUR = 6;
/** Per agent: more messages than this in a day are refused. */
export const AGENT_MESSAGES_PER_DAY = 20;

export const AGENT_TITLE_MAX = 80;
export const AGENT_TEXT_MAX = 1000;
export const AGENT_ACTION_MAX = 80;

export interface AgentMessage {
  agentId: string;
  /** What the owner types to reach it; the message is signed with it. Falls back to the id. */
  agentHandle?: string;
  title: string;
  text?: string;
  urgency?: 'now' | 'today';
  /** A dashboard route (`#/…`). */
  link?: string;
  /**
   * What the owner is asked to do, in a few words ("Confirm with the bank?").
   * With it the message sits in Needs you until the owner deals with it;
   * without it the message is information (`needsOwner`).
   */
  action?: string;
  /** The agent's own dedupe key; stored as `agent:<id>:<key>`. */
  key?: string;
  /** The owner is in the conversation that asked: a `now` message skips the on-dashboard hold. */
  interactive?: boolean;
}

export type AgentNotifyOutcome =
  | 'sent'
  | 'shown'
  | 'today'
  | 'lowered-limit'
  | 'lowered-rate'
  | 'lowered-settings'
  | 'focus'
  | 'off'
  | 'failed'
  | 'muted'
  | 'daily-limit';

export interface AgentNotifyResult {
  /** False when nothing was written: muted, or over the daily limit. */
  ok: boolean;
  outcome: AgentNotifyOutcome;
  /** Where it went, in words the agent can repeat to the owner. */
  delivered: string;
  id?: string;
  /** An earlier unsent message with the same key took it. */
  updated?: boolean;
}

/** `agent:<id>:<key>`: an agent's key never collides with another agent's or core's. */
export function agentDedupeKey(agentId: string, key: string): string {
  return `agent:${agentId}:${key}`;
}

/** A dashboard route, or the sentence saying why it is not one. */
export function checkAgentLink(link: string): string | null {
  const route = link.trim();
  if (!route.startsWith('#/')) return 'a link is a dashboard route like #/chat/…; an outside address may go in the text instead';
  if (/\s/.test(route) || route.includes('//')) return 'a link is a dashboard route like #/chat/…, with no spaces and no address in it';
  return null;
}

async function channelLabel(kind: string | null): Promise<string | null> {
  if (!kind || kind === 'off') return null;
  const found = (await listChannels()).find((c) => c.kind === kind);
  return found?.label ?? kind;
}

async function counts(db: Queryable, agentId: string, now: Date): Promise<{ nowLastHour: number; lastDay: number }> {
  const { rows } = await db.query(
    `select count(*) filter (where urgency = 'now' and created_at > $2)::int as now_hour,
            count(*)::int as day
       from core.owner_notifications
      where kind = 'agent' and agent_id = $1 and created_at > $3`,
    [agentId, new Date(now.getTime() - 3_600_000), new Date(now.getTime() - 86_400_000)],
  );
  return { nowLastHour: Number(rows[0]?.now_hour ?? 0), lastDay: Number(rows[0]?.day ?? 0) };
}

/**
 * Tell the owner something, from an agent. Never throws for a channel's sake;
 * throws only for a malformed message (a missing agent or title), which is the
 * caller's bug. The tool checks lengths and the link before this.
 */
export async function notifyFromAgent(db: Queryable, deps: NotifyDeps, message: AgentMessage): Promise<AgentNotifyResult> {
  const agentId = message.agentId.trim();
  if (agentId === '') throw new Error('an agent message needs the agent it is from');
  const handle = (message.agentHandle ?? agentId).trim().replace(/^@+/, '') || agentId;
  const now = deps.now?.() ?? new Date();
  const settings = await readNotificationSettings(db);

  if (settings.agents.muted.includes(agentId)) {
    return {
      ok: false,
      outcome: 'muted',
      delivered: `refused: the owner has muted messages from @${handle}. Do not try another way to reach them.`,
    };
  }
  const counted = await counts(db, agentId, now);
  if (counted.lastDay >= AGENT_MESSAGES_PER_DAY) {
    return {
      ok: false,
      outcome: 'daily-limit',
      delivered: `refused: you already sent ${AGENT_MESSAGES_PER_DAY} messages today, the daily limit. Nothing was sent.`,
    };
  }

  let urgency: 'now' | 'today' = message.urgency ?? 'now';
  let lowered: 'limit' | 'settings' | null = null;
  if (urgency === 'now' && settings.agents.maxUrgency === 'today') {
    urgency = 'today';
    lowered = 'settings';
  } else if (urgency === 'now' && counted.nowLastHour >= AGENT_NOW_PER_HOUR) {
    urgency = 'today';
    lowered = 'limit';
  }

  const key = message.key?.trim();
  const result = await notifyOwner(db, deps, {
    kind: 'agent',
    urgency,
    title: message.title,
    ...(message.text?.trim() ? { text: message.text } : {}),
    ...(message.link ? { link: { route: message.link.trim() } } : {}),
    ...(message.action?.trim() ? { action: message.action.trim() } : {}),
    ...(key ? { dedupeKey: agentDedupeKey(agentId, key) } : {}),
    agentId,
    agentHandle: handle,
    ...(message.interactive && urgency === 'now' ? { immediate: true } : {}),
  });
  return describeOutcome(result, { urgency, lowered, settings, heldFor: result.state === 'held' && !result.lowered && urgency === 'now' ? await heldFor(db, result.id) : null });
}

async function heldFor(db: Queryable, id: string): Promise<FocusMode | null> {
  const { rows } = await db.query(`select held_for from core.owner_notifications where id = $1`, [id]);
  return (rows[0]?.held_for as FocusMode | undefined) ?? null;
}

async function describeOutcome(
  result: NotifyResult,
  ctx: {
    urgency: 'now' | 'today';
    lowered: 'limit' | 'settings' | null;
    settings: Awaited<ReturnType<typeof readNotificationSettings>>;
    heldFor: FocusMode | null;
  },
): Promise<AgentNotifyResult> {
  const base = { ok: true, id: result.id, ...(result.deduped ? { updated: true } : {}) };
  const again = result.deduped ? 'updated your earlier message with this key; ' : '';
  const said = (outcome: AgentNotifyOutcome, sentence: string): AgentNotifyResult => ({
    ...base,
    outcome,
    delivered: `${again}${sentence}`,
  });
  switch (result.state) {
    case 'sent':
      return said('sent', `sent to ${(await channelLabel(result.channel)) ?? 'the owner'}`);
    case 'sending':
      return said('sent', `being sent to ${(await channelLabel(result.channel)) ?? 'the owner'}`);
    case 'shown': {
      const label = await channelLabel(await channelFor(ctx.settings, 'agent'));
      const minutes = Math.round(ESCALATE_AFTER_MS / 60_000);
      return said(
        'shown',
        label
          ? `shown on the dashboard, and sent to ${label} if unseen in ${minutes} minutes`
          : 'shown on the dashboard; there is no channel to send it to if it stays unseen',
      );
    }
    case 'held': {
      if (ctx.heldFor) {
        return said('focus', `held while the owner is in ${FOCUS_LABELS[ctx.heldFor]}; it goes out when that ends`);
      }
      if (ctx.lowered === 'limit') {
        return said('lowered-limit', `lowered to today: you sent more than ${AGENT_NOW_PER_HOUR} of these this hour; it will be in today's end-of-day message`);
      }
      if (result.lowered) {
        return said('lowered-rate', "lowered to today: this came up more than three times in an hour; it will be in today's end-of-day message");
      }
      if (ctx.lowered === 'settings') {
        return said('lowered-settings', "lowered to today by the owner's settings; it will be in today's end-of-day message");
      }
      return said('today', `in today's end-of-day message, at ${ctx.settings.endOfDay} on the owner's clock`);
    }
    case 'stored':
      return said('off', 'not sent: messages from agents are off. It is kept in the owner\'s notification list');
    case 'failed':
    default:
      return said('failed', `not sent: ${result.error ?? 'no channel took it'}. It is kept in the owner's notification list`);
  }
}
