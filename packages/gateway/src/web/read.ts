/**
 * The dashboard's reads — the event log and everything hanging off it.
 *
 * docs/architecture.md, "Secrets and operations": *«Observability is the event
 * log: run, step and action ids, queue age, ingest lag, retry counts, approval
 * age, provider usage.»* So this file adds no state of its own and computes nothing
 * the system does not already record: every number below is a row somewhere,
 * read back with a `select`.
 *
 * Nothing here writes. Nothing here reaches a model.
 */
import { addUsage, usageView, type UsageView } from './usage-view.js';
import path from 'node:path';
import { readDelegatesFile } from '../agents/delegation.js';
import {
  getActiveSchedule,
  listJobs,
  listMissions,
  listOccurrences,
  listPendingActions,
  listClosedOffers,
  listOpenOffers,
  sweepLapsedOffers,
  listReminders,
  countJobsByState,
  isPaused,
  nextAfter,
  OPENING_TURN_SPEAKER,
  sentinelIsEnabled,
  sentinelSwitches,
  toActionRecord,
  delegateScope,
  type AgentCatalog,
  type AgentHoldBack,
  type CatalogAgent,
  type ActionRecord,
  type Job,
  type JobState,
  type CoreToolContext,
  type ToolRegistry,
  type HomeBlock,
  type Offer,
  HOME_CARD_LINE_MAX,
  HOME_CARD_TREND_MAX,
  HOME_CARD_VALUE_MAX,
  HOME_GLANCE_MAX,
  TILE_ICONS,
  readWebSetting,
  writeWebSetting,
} from '@buddi/core';
import type { OwnerChoice } from '@buddi/core';
import { listFailureGroups, type FailureGroup, type JobCounts } from '@buddi/core';
import type { Pool } from 'pg';
import { lastNotification } from '../missions-cli.js';
import { CARRIED_OVER_SPEAKER } from '../surfaces/browser-handoff.js';
import { pictureUrl } from '../agents/avatars.js';
import { readAlertDecisions, readAlerts, type AlertsView } from './alerts.js';

/** How many rows a listing returns when the caller names no limit. */
export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 500;

export function boundedLimit(raw: string | null | undefined, fallback = DEFAULT_LIMIT): number {
  const n = raw === null || raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(Math.floor(n), MAX_LIMIT));
}

/* ------------------------------------------------------------------ *
 * Events
 * ------------------------------------------------------------------ */

export interface EventView {
  id: string;
  kind: string;
  conversationId: string | null;
  payload: unknown;
  createdAt: string;
}

export interface EventQuery {
  kind?: string | undefined;
  /** Substring match against the payload's JSON text. */
  q?: string | undefined;
  /** Only events newer than this id — what the 5s poll asks for. */
  since?: string | undefined;
  /** The paging cursor: only events older than this id. */
  before?: string | undefined;
  limit?: number | undefined;
}

export interface EventPage {
  events: EventView[];
  /** Pass back as `before` for the next (older) page. Null at the end. */
  nextCursor: string | null;
  /** The newest id in the log right now, so a poller can resume exactly. */
  latest: string | null;
}

export async function readEvents(pool: Pool, query: EventQuery = {}): Promise<EventPage> {
  const limit = query.limit ?? DEFAULT_LIMIT;
  const { rows } = await pool.query(
    `select id, kind, conversation_id, payload, created_at
       from core.events
      where ($1::text is null or kind = $1)
        and ($2::text is null or payload::text ilike '%' || $2 || '%')
        and ($3::bigint is null or id > $3::bigint)
        and ($4::bigint is null or id < $4::bigint)
      order by id desc
      limit $5`,
    [
      query.kind ?? null,
      query.q ?? null,
      numeric(query.since),
      numeric(query.before),
      limit,
    ],
  );
  const events = rows.map(toEventView);
  const { rows: head } = await pool.query(`select max(id)::text as id from core.events`);
  return {
    events,
    nextCursor: events.length === limit ? (events[events.length - 1]?.id ?? null) : null,
    latest: (head[0]?.id as string | null) ?? null,
  };
}

/** Every kind currently in the log, with how many of each — the filter list. */
export async function readEventKinds(pool: Pool): Promise<Array<{ kind: string; count: number }>> {
  const { rows } = await pool.query(
    `select kind, count(*)::int as n from core.events group by kind order by kind`,
  );
  return rows.map((r) => ({ kind: r.kind as string, count: Number(r.n) }));
}

function numeric(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
}

function toEventView(row: any): EventView {
  return {
    id: String(row.id),
    kind: row.kind,
    conversationId: row.conversation_id === null ? null : String(row.conversation_id),
    payload: row.payload ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * Conversations and transcripts
 * ------------------------------------------------------------------ */

export interface ConversationSummary {
  id: string;
  agentId: string;
  createdAt: string;
  messageCount: number;
  lastMessageAt: string | null;
  /** The first thing the owner (or the mission prompt) said. */
  opening: string | null;
  runs: number;
  usage: UsageView;
}

export async function readConversations(
  pool: Pool,
  limit = 50,
): Promise<ConversationSummary[]> {
  const { rows } = await pool.query(
    `select c.id, c.agent_id, c.created_at,
            count(m.id)::int as message_count,
            max(m.created_at) as last_message_at
       from core.conversations c
       left join core.messages m on m.conversation_id = c.id
      group by c.id
      order by coalesce(max(m.created_at), c.created_at) desc, c.created_at desc
      limit $1`,
    [limit],
  );
  const ids = rows.map((r) => String(r.id));
  const usage = await usageByConversation(pool, ids);
  const openings = await openingByConversation(pool, ids);
  return rows.map((r) => {
    const id = String(r.id);
    const u = usage.get(id) ?? { usage: { input: 0, output: 0 }, runs: 0 };
    return {
      id,
      agentId: r.agent_id,
      createdAt: new Date(r.created_at).toISOString(),
      messageCount: Number(r.message_count),
      lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
      opening: openings.get(id) ?? null,
      runs: u.runs,
      usage: u.usage,
    };
  });
}

async function usageByConversation(
  pool: Pool,
  ids: readonly string[],
): Promise<Map<string, { usage: UsageView; runs: number }>> {
  const out = new Map<string, { usage: UsageView; runs: number }>();
  if (ids.length === 0) return out;
  const { rows } = await pool.query(
    `select conversation_id,
            count(*)::int as runs,
            coalesce(sum((payload->'usage'->>'input')::bigint), 0)::bigint as input,
            coalesce(sum((payload->'usage'->>'output')::bigint), 0)::bigint as output,
            coalesce(sum((payload->'usage'->>'cacheRead')::bigint), 0)::bigint as cache_read,
            coalesce(sum((payload->'usage'->>'cacheWrite')::bigint), 0)::bigint as cache_write
       from core.events
      where kind = 'run.finished' and conversation_id = any($1::uuid[])
      group by conversation_id`,
    [ids],
  );
  for (const row of rows) {
    out.set(String(row.conversation_id), {
      runs: Number(row.runs),
      usage: usageView({ input: row.input, output: row.output, cacheRead: row.cache_read, cacheWrite: row.cache_write }),
    });
  }
  return out;
}

async function openingByConversation(
  pool: Pool,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const { rows } = await pool.query(
    `select distinct on (conversation_id) conversation_id, content
       from core.messages
      where conversation_id = any($1::uuid[]) and role = 'user'
        and speaker is distinct from $2 and speaker is distinct from $3
      order by conversation_id, created_at asc, id asc`,
    [ids, OPENING_TURN_SPEAKER, CARRIED_OVER_SPEAKER],
  );
  for (const row of rows) {
    const text = textOfContent(row.content);
    if (text) out.set(String(row.conversation_id), truncate(text, 160));
  }
  return out;
}

export interface TranscriptBlock {
  type: string;
  /** Present on a text block. */
  text?: string;
  /** Present on a tool_use block. */
  name?: string;
  input?: unknown;
  /** Present on a tool_result block. */
  toolUseId?: string;
  content?: string;
  isError?: boolean;
  /** Present on an artifact_ref block: the reference, never the bytes. */
  ref?: unknown;
}

export interface TranscriptMessage {
  id: string;
  role: string;
  createdAt: string;
  blocks: TranscriptBlock[];
  /**
   * Who spoke, when it was not simply the owner or the agent: a room member,
   * or `approval:resume` for the turn that carries a decided action's result.
   * Activity draws that one as the tool result it is.
   */
  speaker?: string;
}

export interface TranscriptRun {
  startedAt: string | null;
  finishedAt: string | null;
  turns: number | null;
  stopped: string | null;
  usage: UsageView;
  actionId: string | null;
  resumed: boolean;
}

export interface Transcript {
  id: string;
  agentId: string;
  createdAt: string;
  messages: TranscriptMessage[];
  runs: TranscriptRun[];
  usage: UsageView;
}

export async function readConversation(
  pool: Pool,
  conversationId: string,
): Promise<Transcript | null> {
  const { rows: head } = await pool.query(
    `select id, agent_id, created_at from core.conversations where id = $1::uuid`,
    [conversationId],
  );
  const conversation = head[0];
  if (!conversation) return null;

  // The turn first run sent on the owner's behalf is left out here for the
  // same reason the chat leaves it out: it is an instruction to a new
  // assistant, and Activity reads as a record of what the owner did.
  const { rows: messages } = await pool.query(
    `select id, role, content, created_at, speaker from core.messages
      where conversation_id = $1::uuid and speaker is distinct from $2
        and speaker is distinct from $3
      order by created_at asc, id asc`,
    [conversationId, OPENING_TURN_SPEAKER, CARRIED_OVER_SPEAKER],
  );
  const { rows: events } = await pool.query(
    `select kind, payload, created_at from core.events
      where conversation_id = $1::uuid and kind in ('run.started', 'run.resumed', 'run.finished')
      order by id asc`,
    [conversationId],
  );

  const runs: TranscriptRun[] = [];
  for (const event of events) {
    const payload = (event.payload ?? {}) as Record<string, any>;
    if (event.kind === 'run.started' || event.kind === 'run.resumed') {
      runs.push({
        startedAt: new Date(event.created_at).toISOString(),
        finishedAt: null,
        turns: null,
        stopped: null,
        usage: { input: 0, output: 0 },
        actionId: typeof payload.actionId === 'string' ? payload.actionId : null,
        resumed: event.kind === 'run.resumed',
      });
      continue;
    }
    const open = runs.find((r) => r.finishedAt === null) ?? null;
    const finished: TranscriptRun = {
      startedAt: open?.startedAt ?? null,
      finishedAt: new Date(event.created_at).toISOString(),
      turns: typeof payload.turns === 'number' ? payload.turns : null,
      stopped: typeof payload.stopped === 'string' ? payload.stopped : null,
      usage: usageView(payload.usage),
      actionId: typeof payload.actionId === 'string' ? payload.actionId : (open?.actionId ?? null),
      resumed: open?.resumed ?? false,
    };
    if (open) Object.assign(open, finished);
    else runs.push(finished);
  }

  const usage = runs.reduce<UsageView>((acc, run) => addUsage(acc, run.usage), { input: 0, output: 0 });

  return {
    id: String(conversation.id),
    agentId: conversation.agent_id,
    createdAt: new Date(conversation.created_at).toISOString(),
    messages: messages.map((m) => ({
      id: String(m.id),
      role: m.role,
      createdAt: new Date(m.created_at).toISOString(),
      blocks: toBlocks(m.content),
      ...(typeof m.speaker === 'string' && m.speaker !== '' ? { speaker: m.speaker } : {}),
    })),
    runs,
    usage,
  };
}

function toBlocks(raw: unknown): TranscriptBlock[] {
  const value = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!Array.isArray(value)) return [];
  return value.map((block): TranscriptBlock => {
    const b = (block ?? {}) as Record<string, unknown>;
    const type = typeof b.type === 'string' ? b.type : 'unknown';
    switch (type) {
      case 'text':
      case 'thinking':
        return { type, text: String(b.text ?? '') };
      case 'tool_use':
        return { type, name: String(b.name ?? ''), input: b.input ?? null };
      case 'tool_result':
        return {
          type,
          toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : undefined,
          content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? null),
          isError: b.is_error === true,
        };
      default:
        return { type, ref: b };
    }
  });
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}

function textOfContent(raw: unknown): string {
  return toBlocks(raw)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
    .trim();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/* ------------------------------------------------------------------ *
 * Missions
 * ------------------------------------------------------------------ */

export interface MissionView {
  id: string;
  name: string;
  agentId: string;
  prompt: string;
  enabled: boolean;
  /** "paused: finance is disabled", when a disabled plugin paused it. */
  pausedReason?: string;
  alwaysDeliver: boolean;
  createdAt: string;
  schedule: {
    cron: string;
    timezone: string;
    revision: number;
    misfirePolicy: string;
    deadlineMinutes: number | null;
  } | null;
  nextRun: string | null;
  occurrences: Array<{
    id: string;
    scheduledAt: string;
    state: string;
    finishedAt: string | null;
    error: string | null;
    runConversationId: string | null;
  }>;
  lastNotification: { kind: string; at: string; reason?: string; chars?: number } | null;
}

export async function readMissions(pool: Pool, now: Date): Promise<MissionView[]> {
  const missions = await listMissions(pool);
  const out: MissionView[] = [];
  for (const mission of missions) {
    const spec = await getActiveSchedule(pool, mission.id);
    const occurrences = await listOccurrences(pool, mission.id, 10);
    const notification = await lastNotification(pool, mission.id);
    out.push({
      id: mission.id,
      name: mission.name,
      agentId: mission.agentId,
      prompt: mission.prompt,
      enabled: mission.enabled,
      ...(mission.pausedReason === null ? {} : { pausedReason: mission.pausedReason }),
      alwaysDeliver: mission.alwaysDeliver,
      createdAt: mission.createdAt.toISOString(),
      schedule: spec
        ? {
            cron: spec.cron,
            timezone: spec.timezone,
            revision: spec.revision,
            misfirePolicy: spec.misfirePolicy,
            deadlineMinutes: spec.deadlineMinutes,
          }
        : null,
      nextRun:
        spec && mission.enabled && mission.pausedReason === null
          ? (nextAfter(spec.cron, now, spec.timezone)?.toISOString() ?? null)
          : null,
      occurrences: occurrences.map((o) => ({
        id: o.id,
        scheduledAt: o.scheduledAt.toISOString(),
        state: o.state,
        finishedAt: o.finishedAt ? o.finishedAt.toISOString() : null,
        error: o.error,
        runConversationId: o.runConversationId,
      })),
      lastNotification: notification
        ? { ...notification, at: notification.at.toISOString() }
        : null,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

export interface JobView {
  id: string;
  kind: string;
  state: JobState;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  leaseOwner: string | null;
  leaseUntil: string | null;
  lastError: string | null;
  result: unknown;
  conversationId: string | null;
  dedupKey: string | null;
  suspendedReason: string | null;
  /** A failed job that stopped asking for the owner: when, and `owner` or `auto` (by age). */
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export function toJobView(job: Job): JobView {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    payload: job.payload,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    runAfter: job.runAfter.toISOString(),
    leaseOwner: job.leaseOwner,
    leaseUntil: job.leaseUntil ? job.leaseUntil.toISOString() : null,
    lastError: job.lastError,
    result: job.result,
    conversationId: job.conversationId,
    dedupKey: job.dedupKey,
    suspendedReason: job.suspendedReason,
    acknowledgedAt: job.acknowledgedAt ? job.acknowledgedAt.toISOString() : null,
    acknowledgedBy: job.acknowledgedBy,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export async function readJobs(
  pool: Pool,
  opts: { state?: JobState | undefined; kind?: string | undefined; limit?: number; offset?: number; failed?: 'open' | 'dismissed' | undefined; hideDismissed?: boolean } = {},
): Promise<{ jobs: JobView[]; counts: JobCounts; paused: boolean }> {
  const jobs = await listJobs(pool, {
    ...(opts.state ? { state: opts.state } : {}),
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.failed ? { failed: opts.failed } : {}),
    ...(opts.hideDismissed ? { hideDismissed: true } : {}),
    limit: opts.limit ?? DEFAULT_LIMIT,
    ...(opts.offset ? { offset: opts.offset } : {}),
  });
  return {
    jobs: jobs.map(toJobView),
    counts: await countJobsByState(pool),
    paused: await isPaused(pool),
  };
}

/** One job in a failure group, with who it ran for. */
export interface FailedJobView {
  job: JobView;
  agentId: string | null;
  agentName: string | null;
  missionId: string | null;
  missionName: string | null;
}

/** Failed jobs that broke the same way (core/src/queue/failures.ts). */
export interface FailureGroupView {
  key: string;
  label: string;
  reason: string;
  likelyFixed: boolean;
  count: number;
  firstAt: string;
  lastAt: string;
  agents: Array<{ id: string; name: string | null }>;
  jobs: FailedJobView[];
}

function toFailureGroupView(g: FailureGroup, nameOf: (id: string) => string | null): FailureGroupView {
  return {
    key: g.key,
    label: g.label,
    reason: g.reason,
    likelyFixed: g.likelyFixed,
    count: g.count,
    firstAt: g.firstAt.toISOString(),
    lastAt: g.lastAt.toISOString(),
    agents: g.agentIds.map((id) => ({ id, name: nameOf(id) })),
    jobs: g.jobs.map((j) => ({
      job: toJobView(j.job),
      agentId: j.agentId,
      agentName: j.agentId ? nameOf(j.agentId) : null,
      missionId: j.missionId,
      missionName: j.missionName,
    })),
  };
}

/**
 * Activity → Jobs' decisions: the failed jobs still asking for the owner,
 * grouped by cause, and the dismissed ones (by him, or quiet by age) apart.
 */
export async function readJobFailures(
  pool: Pool,
  now: Date,
  nameOf: (agentId: string) => string | null = () => null,
): Promise<{ open: FailureGroupView[]; dismissed: FailureGroupView[] }> {
  const [open, dismissed] = await Promise.all([
    listFailureGroups(pool, { which: 'open', now }),
    listFailureGroups(pool, { which: 'dismissed', now, limit: 200 }),
  ]);
  return {
    open: open.map((g) => toFailureGroupView(g, nameOf)),
    dismissed: dismissed.map((g) => toFailureGroupView(g, nameOf)),
  };
}

/* ------------------------------------------------------------------ *
 * Approvals
 * ------------------------------------------------------------------ */

export interface ApprovalView {
  id: string;
  tool: string;
  toolVersion: string;
  agentId: string;
  conversationId: string | null;
  jobId: string | null;
  /** The preview the *tool* rendered before the approval existed. */
  preview: string;
  /** The full effect envelope the approval is bound to. */
  envelope: unknown;
  canonicalArgs: unknown;
  /**
   * The controls the tool offered the owner, if any: one select per entry on
   * the card, defaults preselected. Empty for almost every action.
   */
  choices: OwnerChoice[];
  /** What the owner picked, once they have decided. Null while pending. */
  ownerChoices: Record<string, string> | null;
  argsHash: string;
  policyVersion: number;
  state: string;
  decidedBy: string | null;
  decidedVia: string | null;
  decidedAt: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  outcome: unknown;
}

export function toApprovalView(action: ActionRecord): ApprovalView {
  return {
    id: action.id,
    tool: action.tool,
    toolVersion: action.toolVersion,
    agentId: action.agentId,
    conversationId: action.conversationId,
    jobId: action.jobId,
    preview: action.preview,
    envelope: action.envelope,
    canonicalArgs: action.canonicalArgs,
    choices: action.choices,
    ownerChoices: action.ownerChoices,
    argsHash: action.argsHash,
    policyVersion: action.policyVersion,
    state: action.state,
    decidedBy: action.decidedBy,
    decidedVia: action.decidedVia,
    decidedAt: action.decidedAt ? action.decidedAt.toISOString() : null,
    expiresAt: action.expiresAt.toISOString(),
    createdAt: action.createdAt.toISOString(),
    updatedAt: action.updatedAt.toISOString(),
    outcome: action.outcome,
  };
}

export async function readApprovals(
  pool: Pool,
  now: Date,
  limit = 50,
): Promise<{ pending: ApprovalView[]; recent: ApprovalView[] }> {
  const pending = await listPendingActions(pool, { now });
  const { rows } = await pool.query(
    `select a.id, a.tool, a.tool_version, a.agent_id, a.conversation_id, a.job_id,
            a.canonical_args, a.envelope, a.choices, a.args_hash, a.preview, a.expires_at,
            a.policy_version, a.created_at,
            ap.state, ap.decided_by, ap.decided_via, ap.decided_at,
            ap.claimed_by, ap.claimed_at, ap.owner_choices, ap.outcome, ap.updated_at
       from core.actions a
       join core.approvals ap on ap.action_id = a.id
      order by a.created_at desc
      limit $1`,
    [limit],
  );
  return {
    pending: pending.map(toApprovalView),
    recent: rows.map((row) => toApprovalView(toActionRecord(row))),
  };
}

/* ------------------------------------------------------------------ *
 * Reminders
 * ------------------------------------------------------------------ */

export async function readReminders(pool: Pool, limit = 100): Promise<unknown[]> {
  const reminders = await listReminders(pool, { limit });
  return reminders.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    conversationId: r.conversationId,
    dueAt: r.dueAt.toISOString(),
    text: r.text,
    context: r.context,
    state: r.state,
    createdAt: r.createdAt.toISOString(),
    firedAt: r.firedAt ? r.firedAt.toISOString() : null,
    cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null,
    cancelReason: r.cancelReason,
  }));
}

/* ------------------------------------------------------------------ *
 * Offered actions
 * ------------------------------------------------------------------ */

/**
 * What an agent has offered the owner and nobody has taken yet — plus, under
 * the fold, what was refused or went stale in the last week.
 *
 * The dashboard draws these as chips. Same rows Telegram draws as buttons —
 * there is one store, not a per-surface copy, so an offer taken on the phone
 * is gone from the dashboard on its next poll.
 *
 * The read is also where an offer lapses. A sweep runs first, marking the ones
 * whose moment has passed — the owner typed the next message, the conversation
 * rolled over, the agent was removed — so the list below is what is genuinely
 * on the table rather than everything ever offered. Doing it here rather than
 * on a timer means there is no scheduler to get wrong and nothing to run on an
 * installation nobody is looking at; the gateway sweeps once at start so
 * Telegram sees the same truth without waiting for a dashboard visit.
 *
 * A sweep that fails is logged by the caller's error handling and never fails
 * the read: a list of offers is worth more than a list of nothing.
 */
export async function readOffers(
  pool: Pool,
  now: Date,
  limit = 20,
  opts: { agentIds?: readonly string[] | undefined } = {},
): Promise<{ offers: unknown[]; closed: unknown[] }> {
  await sweepLapsedOffers(pool, { now, ...(opts.agentIds ? { agentIds: opts.agentIds } : {}) })
    .catch(() => 0);
  const offers = await listOpenOffers(pool, { now, limit });
  const closed = await listClosedOffers(pool, { now, limit });
  return { offers: offers.map(offerView), closed: closed.map(offerView) };
}

function offerView(o: Offer): unknown {
  return {
    id: o.id,
    agentId: o.agentId,
    conversationId: o.conversationId,
    label: o.label,
    // Shown on hover: the owner should be able to see what tapping it asks for
    // before they tap it. There is no hidden instruction here.
    prompt: o.prompt,
    createdAt: o.createdAt,
    expiresAt: o.expiresAt,
    dismissedAt: o.dismissedAt,
    lapsedAt: o.lapsedAt,
    lapseReason: o.lapseReason,
  };
}

/* ------------------------------------------------------------------ *
 * Sentinels
 * ------------------------------------------------------------------ */

export interface SentinelsView {
  installed: Array<{
    id: string;
    description: string;
    every: number;
    /** False when the owner has switched this watcher off on the page. */
    enabled: boolean;
  }>;
  runs: Array<{ sentinelId: string; lastRunAt: string; lastError: string | null }>;
  /**
   * What they found, shaped for the owner (alerts.ts): decisions grouped, the
   * recap's notes counted, owner lines only — a finding's brief is never sent.
   */
  alerts: AlertsView;
}

export async function readSentinels(
  pool: Pool,
  registry: ToolRegistry,
  now: Date = new Date(),
): Promise<SentinelsView> {
  // The owner's switches. Absent means on, so a fresh installation shows every
  // watcher on with no rows behind it.
  const switches = await sentinelSwitches(pool);
  const installed = registry
    .manifests()
    .flatMap((m) => m.sentinels ?? [])
    .map((s) => ({
      id: s.id,
      description: s.description,
      every: s.every,
      enabled: sentinelIsEnabled(switches, s.id),
    }));

  const { rows: runs } = await pool.query(
    `select sentinel_id, last_run_at, last_error from core.sentinel_runs order by sentinel_id`,
  );

  return {
    installed,
    runs: runs.map((r) => ({
      sentinelId: r.sentinel_id,
      lastRunAt: new Date(r.last_run_at).toISOString(),
      lastError: r.last_error ?? null,
    })),
    alerts: await readAlerts(pool, registry, now),
  };
}

/* ------------------------------------------------------------------ *
 * Agents
 * ------------------------------------------------------------------ */

export interface AgentView {
  id: string;
  handle: string;
  name: string;
  description: string;
  isDefault: boolean;
  model: string;
  maxTurns: number;
  language: string;
  tools: string[];
  /** Capabilities it answers for, in declaration order. A front-matter field. */
  roles: string[];
  /** An emoji, or an image file name inside the agent's folder. */
  avatar?: string;
  /** Its own colour, `#rrggbb`. */
  accent?: string;
  /** The uploaded picture's URL, when there is one; `avatar` is the fallback. */
  picture?: string;
  skills: Array<{ name: string; provenance: string; file: string }>;
  /** Who it may hand work to: its allowlist, restricted to agents that exist. */
  delegates: string[];
  /**
   * Set when it may ask everyone rather than a list: `front-desk` or `maker`
   * when that role opens it by default (no file), `list` when its file says
   * `"*"`. `delegates` is empty then.
   */
  asksEveryone?: 'front-desk' | 'maker' | 'list';
  /** True when the file is a shipped example, which the dashboard will not edit. */
  isExample: boolean;
  /**
   * Set when a tool family this agent was granted is not installed here: the
   * agent is listed, greyed and cannot run until the plugin is installed.
   * `tools` is empty while it is set.
   */
  heldBack?: AgentHoldBack;
  /**
   * The provider, named — kind, model and *which environment variable* holds
   * the credential. Never the credential: the dashboard reports the
   * authorization decision, it does not disclose the secret behind it.
   */
  provider: { kind: string; model: string; credentialKind: string; credentialEnv: string };
}

function safeDelegates(agentId: string, agentsDir: string): string[] | undefined {
  try { return readDelegatesFile(agentId, agentsDir); } catch { return []; }
}

/** The Access page's view of an allowlist: everyone (and why), or the ids that exist. */
function delegationView(catalog: AgentCatalog, agent: CatalogAgent): Pick<AgentView, 'delegates' | 'asksEveryone'> {
  const scope = delegateScope(agent, safeDelegates(agent.id, path.dirname(path.dirname(agent.file))));
  return scope.kind === 'everyone'
    ? { delegates: [], asksEveryone: scope.because }
    : { delegates: scope.ids.filter((id) => catalog.get(id) !== undefined) };
}

export function readAgents(catalog: AgentCatalog, pictures: ReadonlyMap<string, string> = new Map()): AgentView[] {
  /*
   * The agents, and then the files that were read and refused — an agent
   * claiming a reserved id. They are in no roster and answer to no handle, so
   * the page is the only place they appear; without this the owner's file
   * would simply have vanished.
   */
  return [
    ...catalog.list().flatMap((summary) => {
      const agent = catalog.get(summary.id);
      return agent ? [agentView(catalog, agent, pictures)] : [];
    }),
    ...(catalog.refused?.() ?? []).map((agent) => agentView(catalog, agent, pictures)),
  ];
}

function agentView(catalog: AgentCatalog, agent: CatalogAgent, pictures: ReadonlyMap<string, string>): AgentView {
  const credential = agent.provider.credential as { kind?: string; env?: string };
  return {
        id: agent.id,
        handle: agent.handle,
        name: agent.name,
        description: agent.description,
        isDefault: agent.isDefault,
        model: agent.model,
        maxTurns: agent.maxTurns,
        language: agent.language,
        tools: agent.tools,
        roles: [...agent.roles],
        ...(agent.avatar === undefined ? {} : { avatar: agent.avatar }),
        ...(agent.accent === undefined ? {} : { accent: agent.accent }),
        ...(pictures.has(agent.id) ? { picture: pictureUrl(agent.id, pictures.get(agent.id)!) } : {}),
        skills: agent.skills.map((s) => ({
          name: s.name,
          provenance: s.provenance,
          file: s.file,
        })),
        ...delegationView(catalog, agent),
        isExample: agent.source === 'example',
        ...(agent.heldBack === undefined ? {} : { heldBack: agent.heldBack }),
        provider: {
          kind: agent.provider.kind,
          model: agent.provider.model,
          credentialKind: credential?.kind ?? 'unknown',
          credentialEnv: agent.provider.accountId ?? credential?.env ?? 'unknown',
        },
  };
}

/* ------------------------------------------------------------------ *
 * Overview
 * ------------------------------------------------------------------ */

export interface Overview {
  now: string;
  timezone: string;
  paused: boolean;
  /** What the installed plugins put on Home, in registration order. */
  home: HomeBlock[];
  /**
   * The one-line glances beside the date, in plugin order, hidden ones
   * included and marked: Home draws the first three shown, Settings lists
   * them all with a switch each.
   */
  glances: HomeGlanceView[];
  approvals: { pending: number; oldestPendingAt: string | null };
  jobs: Record<JobState, number>;
  missions: { total: number; enabled: number; nextRun: string | null };
  reminders: { pending: number; nextDueAt: string | null };
  sentinels: {
    lastRunAt: string | null;
    /** Decisions waiting: urgent rows on the Alerts page, a group counted once. */
    openUrgent: number;
    openInfo: number;
    /** The first few decisions in the owner's words, for Home's Needs you. */
    decisions: Array<{ id: string; title: string; count: number }>;
    errors: Array<{ sentinelId: string; error: string }>;
  };
  mail: Array<{ sourceId: string; lastRunAt: string; lastError: string | null }>;
  /**
   * Agent runs in progress in the dashboard's conversations right now, for the
   * footer's "N agents working". Added by the web server, which owns the runs;
   * absent where nothing does.
   */
  running?: number;
}

export async function readOverview(deps: {
  pool: Pool;
  registry: ToolRegistry;
  /** Consulted for the `overview` role; absent means "no roles here". */
  catalog?: AgentCatalog;
  ctx: CoreToolContext;
  timezone: string;
  now: Date;
}): Promise<Overview> {
  const { pool, now } = deps;

  const [paused, jobs, pendingActions, missions, reminders] = await Promise.all([
    isPaused(pool),
    countJobsByState(pool),
    listPendingActions(pool, { now }),
    listMissions(pool),
    listReminders(pool, { state: 'pending', limit: 200 }),
  ]);

  let nextMissionRun: Date | null = null;
  for (const mission of missions) {
    if (!mission.enabled) continue;
    const spec = await getActiveSchedule(pool, mission.id);
    if (!spec) continue;
    const next = nextAfter(spec.cron, now, spec.timezone);
    if (next && (nextMissionRun === null || next < nextMissionRun)) nextMissionRun = next;
  }

  const { rows: sentinelRows } = await pool.query(
    `select
       (select max(last_run_at) from core.sentinel_runs) as last_run_at,
       (select count(*)::int from core.sentinel_findings
         where resolved_at is null and snoozed_at is null and severity = 'info') as open_info`,
  );
  // The same decisions the Alerts page lists: urgent, not snoozed, not
  // silenced, a group once. Info findings wait for the recap and are not here.
  const decisions = await readAlertDecisions(pool, deps.registry, now);
  const { rows: sentinelErrors } = await pool.query(
    `select sentinel_id, last_error from core.sentinel_runs where last_error is not null`,
  );
  const { rows: sources } = await pool.query(
    `select source_id, last_run_at, last_error from core.source_runs order by source_id`,
  );

  return {
    now: now.toISOString(),
    timezone: deps.timezone,
    paused,
    home: await readHome(deps),
    glances: await readGlances(deps),
    approvals: {
      pending: pendingActions.length,
      oldestPendingAt: pendingActions[0]?.createdAt.toISOString() ?? null,
    },
    jobs,
    missions: {
      total: missions.length,
      enabled: missions.filter((m) => m.enabled).length,
      nextRun: nextMissionRun ? nextMissionRun.toISOString() : null,
    },
    reminders: {
      pending: reminders.length,
      nextDueAt: reminders[0]?.dueAt.toISOString() ?? null,
    },
    sentinels: {
      lastRunAt: sentinelRows[0]?.last_run_at
        ? new Date(sentinelRows[0].last_run_at).toISOString()
        : null,
      openUrgent: decisions.length,
      openInfo: Number(sentinelRows[0]?.open_info ?? 0),
      decisions: decisions.slice(0, 3).map((d) => ({ id: d.id, title: d.title, count: d.keys.length })),
      errors: sentinelErrors.map((r) => ({
        sentinelId: r.sentinel_id,
        error: String(r.last_error),
      })),
    },
    mail: sources.map((r) => ({
      sourceId: r.source_id,
      lastRunAt: new Date(r.last_run_at).toISOString(),
      lastError: r.last_error ?? null,
    })),
  };
}

/**
 * Every Home block the installed plugins contribute, produced now.
 *
 * A block that fails still appears, with the failure as its note, so the owner
 * sees that a plugin had a problem rather than a page that silently lost a
 * section. Core with zero plugins produces an empty list, which is a valid
 * running state.
 */
export async function readHome(deps: { registry: ToolRegistry; ctx: CoreToolContext }): Promise<HomeBlock[]> {
  const blocks: HomeBlock[] = [];
  for (const contribution of deps.registry.home()) {
    // A glance is drawn beside the date, not as a block (`readGlances`).
    if (contribution.placement === 'glance') continue;
    try {
      const block = await contribution.produce(deps.ctx);
      if (block) blocks.push(block);
    } catch (err) {
      blocks.push({ id: contribution.id, title: contribution.title, note: err instanceof Error ? err.message : String(err), stats: [], rows: [] });
    }
  }
  return blocks;
}



/* ------------------------------------------------------------------ *
 * Glances
 * ------------------------------------------------------------------ */

/** The `core.web_settings` key the owner's Home choices are kept under. */
export const HOME_SETTINGS_KEY = 'home';

interface HomeSettings {
  /** Glance ids the owner hid. */
  hiddenGlances?: string[];
}

/** One glance, as Home and Settings draw it. The link is resolved here, where the pages are known. */
export interface HomeGlanceView {
  id: string;
  /** The contribution's title: what Settings lists it as. */
  title: string;
  plugin: string;
  icon: string;
  text: string;
  link?: { plugin: string; page: string; place: 'rail' | 'settings' };
  /** The glance as a card, checked and cut to size (`cardOf`). */
  card?: HomeGlanceCardView;
  hidden: boolean;
}

export interface HomeGlanceCardView {
  value: string;
  caption?: string;
  trend?: { label: string; points: number[] };
  foot?: string;
}

/** A line cut to `max` characters with an ellipsis; nothing for a blank or a non-string. */
function cutLine(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const text = value.trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * A plugin's card, as the page may draw it: a figure it must have, lines cut
 * to size, and a trend of two or more finite numbers (the first
 * `HOME_CARD_TREND_MAX`). Anything else is dropped rather than drawn wrong.
 */
export function cardOf(card: unknown): HomeGlanceCardView | undefined {
  if (!card || typeof card !== 'object') return undefined;
  const c = card as Record<string, unknown>;
  const value = cutLine(c.value, HOME_CARD_VALUE_MAX);
  if (!value) return undefined;
  const caption = cutLine(c.caption, HOME_CARD_LINE_MAX);
  const foot = cutLine(c.foot, HOME_CARD_LINE_MAX);
  const t = c.trend as { label?: unknown; points?: unknown } | undefined;
  const points = t && Array.isArray(t.points)
    ? t.points.slice(0, HOME_CARD_TREND_MAX).filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : [];
  const label = t ? cutLine(t.label, HOME_CARD_LINE_MAX) : undefined;
  return {
    value,
    ...(caption ? { caption } : {}),
    ...(points.length >= 2 ? { trend: { label: label ?? '', points } } : {}),
    ...(foot ? { foot } : {}),
  };
}

async function readHomeSettings(pool: Pick<Pool, 'query'>): Promise<HomeSettings> {
  try {
    const value = await readWebSetting<HomeSettings>(pool as never, HOME_SETTINGS_KEY);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function hiddenOf(settings: HomeSettings): Set<string> {
  const list = settings.hiddenGlances;
  return new Set(Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : []);
}

const ICONS: ReadonlySet<string> = new Set(TILE_ICONS);

/**
 * Every glance the installed plugins contribute, produced now, side by side.
 *
 * Unlike a block, a glance that fails is left out: a line beside the date has
 * no room for an error, and a missing temperature is not news. Text past the
 * limit is cut with an ellipsis; an icon outside the set becomes the dot the
 * page draws for one; a link to a page the plugin does not have is dropped.
 */
export async function readGlances(deps: {
  pool: Pick<Pool, 'query'>;
  registry: ToolRegistry;
  ctx: CoreToolContext;
}): Promise<HomeGlanceView[]> {
  const hidden = hiddenOf(await readHomeSettings(deps.pool));
  const pages = deps.registry.pages();
  const produced = await Promise.all(
    deps.registry.home().map(async (contribution): Promise<HomeGlanceView | null> => {
      if (contribution.placement !== 'glance') return null;
      const plugin = deps.registry.homePlugin(contribution.id) ?? contribution.id.split('.')[0] ?? '';
      try {
        const glance = await contribution.produce(deps.ctx);
        if (!glance || typeof glance.text !== 'string' || glance.text.trim() === '') return null;
        const text = glance.text.trim();
        const card = cardOf(glance.card);
        const page = glance.link?.route?.page;
        const target = page === undefined ? undefined : pages.find((p) => p.plugin === plugin && p.id === page);
        return {
          id: contribution.id,
          title: contribution.title,
          plugin,
          icon: ICONS.has(glance.icon) ? glance.icon : 'dot',
          text: text.length > HOME_GLANCE_MAX ? `${text.slice(0, HOME_GLANCE_MAX - 1).trimEnd()}…` : text,
          ...(target ? { link: { plugin, page: target.id, place: target.place } } : {}),
          ...(card ? { card } : {}),
          hidden: hidden.has(contribution.id),
        };
      } catch {
        return null;
      }
    }),
  );
  return produced.filter((g): g is HomeGlanceView => g !== null);
}

/** Hide or show one glance. The id must name a glance an installed plugin contributes. */
export async function setGlanceHidden(
  deps: { pool: Pick<Pool, 'query'>; registry: ToolRegistry },
  id: string,
  hide: boolean,
): Promise<{ status: number; body: unknown }> {
  const known = deps.registry.home().some((c) => c.placement === 'glance' && c.id === id);
  if (!known) return { status: 404, body: { error: `no glance is installed with the id ${id}` } };
  const settings = await readHomeSettings(deps.pool);
  const hidden = hiddenOf(settings);
  if (hide) hidden.add(id);
  else hidden.delete(id);
  await writeWebSetting(deps.pool as never, HOME_SETTINGS_KEY, { ...settings, hiddenGlances: [...hidden] });
  return { status: 200, body: { id, hidden: hide } };
}
