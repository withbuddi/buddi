/**
 * The dashboard's reads — the event log and everything hanging off it.
 *
 * ARCHITECTURE.md, "Secrets and operations": *«Observability is the event log:
 * run/step/action ids, queue age, ingest lag, retry counts, approval age,
 * provider usage.»* So this file adds no state of its own and computes nothing
 * the system does not already record: every number below is a row somewhere,
 * read back with a `select`.
 *
 * Nothing here writes. Nothing here reaches a model.
 */
import {
  getActiveSchedule,
  listJobs,
  listMissions,
  listOccurrences,
  listPendingActions,
  listReminders,
  countJobsByState,
  isPaused,
  nextAfter,
  pendingDigestItems,
  toActionRecord,
  type AgentCatalog,
  type ActionRecord,
  type Job,
  type JobState,
  type ToolContext,
  type ToolRegistry,
} from '@buddi/core';
import { ROLE_OVERVIEW } from '../agents/roles.js';
import type { Pool } from 'pg';
import { lastNotification } from '../missions-cli.js';

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
  usage: { input: number; output: number };
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
    const u = usage.get(id) ?? { input: 0, output: 0, runs: 0 };
    return {
      id,
      agentId: r.agent_id,
      createdAt: new Date(r.created_at).toISOString(),
      messageCount: Number(r.message_count),
      lastMessageAt: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
      opening: openings.get(id) ?? null,
      runs: u.runs,
      usage: { input: u.input, output: u.output },
    };
  });
}

async function usageByConversation(
  pool: Pool,
  ids: readonly string[],
): Promise<Map<string, { input: number; output: number; runs: number }>> {
  const out = new Map<string, { input: number; output: number; runs: number }>();
  if (ids.length === 0) return out;
  const { rows } = await pool.query(
    `select conversation_id,
            count(*)::int as runs,
            coalesce(sum((payload->'usage'->>'input')::bigint), 0)::bigint as input,
            coalesce(sum((payload->'usage'->>'output')::bigint), 0)::bigint as output
       from core.events
      where kind = 'run.finished' and conversation_id = any($1::uuid[])
      group by conversation_id`,
    [ids],
  );
  for (const row of rows) {
    out.set(String(row.conversation_id), {
      runs: Number(row.runs),
      input: Number(row.input),
      output: Number(row.output),
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
      order by conversation_id, created_at asc, id asc`,
    [ids],
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
}

export interface TranscriptRun {
  startedAt: string | null;
  finishedAt: string | null;
  turns: number | null;
  stopped: string | null;
  usage: { input: number; output: number };
  actionId: string | null;
  resumed: boolean;
}

export interface Transcript {
  id: string;
  agentId: string;
  createdAt: string;
  messages: TranscriptMessage[];
  runs: TranscriptRun[];
  usage: { input: number; output: number };
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

  const { rows: messages } = await pool.query(
    `select id, role, content, created_at from core.messages
      where conversation_id = $1::uuid
      order by created_at asc, id asc`,
    [conversationId],
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
      usage: {
        input: Number(payload.usage?.input ?? 0),
        output: Number(payload.usage?.output ?? 0),
      },
      actionId: typeof payload.actionId === 'string' ? payload.actionId : (open?.actionId ?? null),
      resumed: open?.resumed ?? false,
    };
    if (open) Object.assign(open, finished);
    else runs.push(finished);
  }

  const usage = runs.reduce(
    (acc, run) => ({ input: acc.input + run.usage.input, output: acc.output + run.usage.output }),
    { input: 0, output: 0 },
  );

  return {
    id: String(conversation.id),
    agentId: conversation.agent_id,
    createdAt: new Date(conversation.created_at).toISOString(),
    messages: messages.map((m) => ({
      id: String(m.id),
      role: m.role,
      createdAt: new Date(m.created_at).toISOString(),
      blocks: toBlocks(m.content),
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
        spec && mission.enabled
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
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

export async function readJobs(
  pool: Pool,
  opts: { state?: JobState | undefined; kind?: string | undefined; limit?: number } = {},
): Promise<{ jobs: JobView[]; counts: Record<JobState, number>; paused: boolean }> {
  const jobs = await listJobs(pool, {
    ...(opts.state ? { state: opts.state } : {}),
    ...(opts.kind ? { kind: opts.kind } : {}),
    limit: opts.limit ?? DEFAULT_LIMIT,
  });
  return {
    jobs: jobs.map(toJobView),
    counts: await countJobsByState(pool),
    paused: await isPaused(pool),
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
            a.canonical_args, a.envelope, a.args_hash, a.preview, a.expires_at,
            a.policy_version, a.created_at,
            ap.state, ap.decided_by, ap.decided_via, ap.decided_at,
            ap.claimed_by, ap.claimed_at, ap.outcome, ap.updated_at
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
 * Sentinels
 * ------------------------------------------------------------------ */

export interface SentinelsView {
  installed: Array<{ id: string; description: string; every: number }>;
  runs: Array<{ sentinelId: string; lastRunAt: string; lastError: string | null }>;
  open: SentinelFindingView[];
  resolved: SentinelFindingView[];
  digest: Array<{
    id: string;
    findingKey: string;
    severity: string;
    title: string;
    detail: string;
    createdAt: string;
  }>;
}

export interface SentinelFindingView {
  key: string;
  sentinelId: string;
  severity: string;
  title: string;
  detail: string;
  data: unknown;
  firstSeenAt: string;
  lastSeenAt: string;
  cooldownUntil: string | null;
  deliveredAt: string | null;
  resolvedAt: string | null;
}

export async function readSentinels(
  pool: Pool,
  registry: ToolRegistry,
  limit = 50,
): Promise<SentinelsView> {
  const installed = registry
    .manifests()
    .flatMap((m) => m.sentinels ?? [])
    .map((s) => ({ id: s.id, description: s.description, every: s.every }));

  const { rows: runs } = await pool.query(
    `select sentinel_id, last_run_at, last_error from core.sentinel_runs order by sentinel_id`,
  );
  const { rows: findings } = await pool.query(
    `select key, sentinel_id, severity, title, detail, data, first_seen_at, last_seen_at,
            cooldown_until, delivered_at, resolved_at
       from core.sentinel_findings
      order by (resolved_at is null) desc, last_seen_at desc
      limit $1`,
    [limit * 2],
  );
  const digest = await pendingDigestItems(pool, limit);

  const views = findings.map(
    (r): SentinelFindingView => ({
      key: r.key,
      sentinelId: r.sentinel_id,
      severity: r.severity,
      title: r.title,
      detail: r.detail,
      data: r.data ?? null,
      firstSeenAt: new Date(r.first_seen_at).toISOString(),
      lastSeenAt: new Date(r.last_seen_at).toISOString(),
      cooldownUntil: r.cooldown_until ? new Date(r.cooldown_until).toISOString() : null,
      deliveredAt: r.delivered_at ? new Date(r.delivered_at).toISOString() : null,
      resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
    }),
  );

  return {
    installed,
    runs: runs.map((r) => ({
      sentinelId: r.sentinel_id,
      lastRunAt: new Date(r.last_run_at).toISOString(),
      lastError: r.last_error ?? null,
    })),
    open: views.filter((f) => f.resolvedAt === null),
    resolved: views.filter((f) => f.resolvedAt !== null).slice(0, limit),
    digest: digest.map((d) => ({
      id: d.id,
      findingKey: d.findingKey,
      severity: d.severity,
      title: d.title,
      detail: d.detail,
      createdAt: d.createdAt.toISOString(),
    })),
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
  skills: Array<{ name: string; provenance: string; file: string }>;
  /**
   * The provider, named — kind, model and *which environment variable* holds
   * the credential. Never the credential: the dashboard reports the
   * authorization decision, it does not disclose the secret behind it.
   */
  provider: { kind: string; model: string; credentialKind: string; credentialEnv: string };
}

export function readAgents(catalog: AgentCatalog): AgentView[] {
  return catalog.list().flatMap((summary) => {
    const agent = catalog.get(summary.id);
    if (!agent) return [];
    const credential = agent.provider.credential as { kind?: string; env?: string };
    return [
      {
        id: agent.id,
        handle: agent.handle,
        name: agent.name,
        description: agent.description,
        isDefault: agent.isDefault,
        model: agent.model,
        maxTurns: agent.maxTurns,
        language: agent.language,
        tools: agent.tools,
        skills: agent.skills.map((s) => ({
          name: s.name,
          provenance: s.provenance,
          file: s.file,
        })),
        provider: {
          kind: agent.provider.kind,
          model: agent.provider.model,
          credentialKind: credential?.kind ?? 'unknown',
          credentialEnv: credential?.env ?? 'unknown',
        },
      },
    ];
  });
}

/* ------------------------------------------------------------------ *
 * Overview
 * ------------------------------------------------------------------ */

/**
 * The money block. `available` is false whenever this installation cannot
 * produce it — no finance tools, or no agent claiming the `overview` role —
 * and `note` then says what to install or declare rather than showing zeros.
 */
export interface OverviewFinance {
  available: boolean;
  currency: string | null;
  cashTotal: number | null;
  netWorth: number | null;
  totalDebt: number | null;
  /** The next fortnight, day by day: only the days something happens. */
  upcoming: Array<{
    date: string;
    balance: number;
    events: Array<{ name: string; amount: number }>;
  }>;
  minBalance: number | null;
  minBalanceDate: string | null;
  breachesFloor: boolean;
  note?: string;
}

export interface Overview {
  now: string;
  timezone: string;
  paused: boolean;
  finance: OverviewFinance;
  approvals: { pending: number; oldestPendingAt: string | null };
  jobs: Record<JobState, number>;
  missions: { total: number; enabled: number; nextRun: string | null };
  reminders: { pending: number; nextDueAt: string | null };
  sentinels: {
    lastRunAt: string | null;
    openUrgent: number;
    openInfo: number;
    errors: Array<{ sentinelId: string; error: string }>;
  };
  mail: Array<{ sourceId: string; lastRunAt: string; lastError: string | null }>;
}

/** The horizon the landing page shows. Two weeks is what a person plans in. */
export const OVERVIEW_HORIZON_DAYS = 14;

export async function readOverview(deps: {
  pool: Pool;
  registry: ToolRegistry;
  /** Consulted for the `overview` role; absent means "no roles here". */
  catalog?: AgentCatalog;
  ctx: ToolContext;
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
         where resolved_at is null and severity = 'urgent') as open_urgent,
       (select count(*)::int from core.sentinel_findings
         where resolved_at is null and severity = 'info') as open_info`,
  );
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
    finance: await readFinance(deps),
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
      openUrgent: Number(sentinelRows[0]?.open_urgent ?? 0),
      openInfo: Number(sentinelRows[0]?.open_info ?? 0),
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

/** Said as a fact about the install, with the thing to do about it. */
export const FINANCE_PLUGIN_MISSING_NOTE =
  'No installed plugin reports balances here. Install a plugin that provides them (packages/tools/finance ships one) and run pnpm db:migrate.';

const EMPTY_FINANCE: OverviewFinance = {
  available: false,
  currency: null,
  cashTotal: null,
  netWorth: null,
  totalDebt: null,
  upcoming: [],
  minBalance: null,
  minBalanceDate: null,
  breachesFloor: false,
};

/**
 * The money numbers, through the registry.
 *
 * Deliberately *not* a query against `finance.*`: core with zero plugins
 * installed is a valid running state, so the dashboard asks the registry for
 * the same read-only tools an agent would call, and an installation without the
 * finance plugin simply reports `available: false` instead of failing.
 */
export async function readFinance(deps: {
  registry: ToolRegistry;
  catalog?: AgentCatalog;
  ctx: ToolContext;
}): Promise<OverviewFinance> {
  const { registry, ctx } = deps;
  // Two conditions, both about *this* installation: somebody has to be able to
  // read the numbers, and somebody has to be answerable for them.
  const overview = deps.catalog?.agentForRole(ROLE_OVERVIEW);
  if (overview !== undefined && !overview.ok) {
    return { ...EMPTY_FINANCE, note: overview.problem.message };
  }
  if (!registry.has('finance.list_accounts')) {
    return { ...EMPTY_FINANCE, note: FINANCE_PLUGIN_MISSING_NOTE };
  }

  const accounts = await registry.invoke('finance.list_accounts', {}, ctx);
  if (!accounts.ok) return { ...EMPTY_FINANCE, note: accounts.message };
  const a = accounts.output as Record<string, any>;

  const finance: OverviewFinance = {
    ...EMPTY_FINANCE,
    available: true,
    currency: a.currency ?? null,
    cashTotal: numberOrNull(a.cashTotal),
    netWorth: numberOrNull(a.netWorth),
    totalDebt: numberOrNull(a.totalLiabilities),
    upcoming: [],
  };

  if (registry.has('finance.project_cashflow')) {
    const projection = await registry.invoke(
      'finance.project_cashflow',
      { horizonDays: OVERVIEW_HORIZON_DAYS, includeBaseline: false },
      ctx,
    );
    if (projection.ok) {
      const p = projection.output as Record<string, any>;
      finance.minBalance = numberOrNull(p.minBalance);
      finance.minBalanceDate = typeof p.minBalanceDate === 'string' ? p.minBalanceDate : null;
      finance.breachesFloor = p.breachesFloor === true;
      finance.upcoming = Array.isArray(p.days)
        ? p.days
            .filter((d: any) => Array.isArray(d?.events) && d.events.length > 0)
            .map((d: any) => ({
              date: String(d.date),
              balance: Number(d.balance ?? 0),
              events: (d.events as any[]).map((e) => ({
                name: String(e?.name ?? ''),
                amount: Number(e?.amount ?? 0),
              })),
            }))
        : [];
    } else {
      finance.note = projection.message;
    }
  }

  return finance;
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
