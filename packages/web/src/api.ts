/**
 * The one place the page talks to the server.
 *
 * Every request is same-origin and carries the session cookie the ticket
 * exchange set. Every *write* additionally echoes the CSRF cookie back in a
 * header — the double-submit half of the protection; the server checks the
 * Origin for the other half. Nothing here ever touches a third-party host.
 */

export const CSRF_COOKIE = 'buddi_csrf';
export const CSRF_HEADER = 'x-buddi-csrf';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function csrfToken(): string {
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`));
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    redirect: 'error',
    headers: { Accept: 'application/json', ...(init.headers ?? {}) },
  });
  if (res.status === 401) {
    throw new ApiError(401, 'This session has expired. Run `buddi dashboard` for a fresh link.');
  }
  const text = await res.text();
  const body: unknown = text === '' ? null : safeJson(text);
  if (!res.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `request failed (${res.status})`;
    throw new ApiError(res.status, message, body);
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return request<T>(`/api${path}${qs ? `?${qs}` : ''}`);
}

export function post<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: csrfToken() },
    body: JSON.stringify(body ?? {}),
  });
}

/* ------------------------------------------------------------------ *
 * Shapes — exactly what packages/gateway/src/web/read.ts returns.
 * ------------------------------------------------------------------ */

export interface Overview {
  now: string;
  timezone: string;
  paused: boolean;
  finance: {
    available: boolean;
    currency: string | null;
    cashTotal: number | null;
    netWorth: number | null;
    totalDebt: number | null;
    upcoming: Array<{ date: string; balance: number; events: Array<{ name: string; amount: number }> }>;
    minBalance: number | null;
    minBalanceDate: string | null;
    breachesFloor: boolean;
    note?: string;
  };
  approvals: { pending: number; oldestPendingAt: string | null };
  jobs: Record<string, number>;
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

export interface EventRow {
  id: string;
  kind: string;
  conversationId: string | null;
  payload: unknown;
  createdAt: string;
}

export interface EventPage {
  events: EventRow[];
  nextCursor: string | null;
  latest: string | null;
}

export interface ConversationSummary {
  id: string;
  agentId: string;
  createdAt: string;
  messageCount: number;
  lastMessageAt: string | null;
  opening: string | null;
  runs: number;
  usage: { input: number; output: number };
}

export interface TranscriptBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  toolUseId?: string;
  content?: string;
  isError?: boolean;
  ref?: unknown;
}

export interface Transcript {
  id: string;
  agentId: string;
  createdAt: string;
  messages: Array<{ id: string; role: string; createdAt: string; blocks: TranscriptBlock[] }>;
  runs: Array<{
    startedAt: string | null;
    finishedAt: string | null;
    turns: number | null;
    stopped: string | null;
    usage: { input: number; output: number };
    actionId: string | null;
    resumed: boolean;
  }>;
  usage: { input: number; output: number };
}

export interface MissionRow {
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

export interface JobRow {
  id: string;
  kind: string;
  state: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  leaseOwner: string | null;
  lastError: string | null;
  result: unknown;
  conversationId: string | null;
  dedupKey: string | null;
  suspendedReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRow {
  id: string;
  tool: string;
  toolVersion: string;
  agentId: string;
  conversationId: string | null;
  jobId: string | null;
  preview: string;
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
  outcome: unknown;
}

export interface ReminderRow {
  id: string;
  agentId: string;
  dueAt: string;
  text: string;
  context: unknown;
  state: string;
  createdAt: string;
  firedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
}

export interface SentinelsView {
  installed: Array<{ id: string; description: string; every: number }>;
  runs: Array<{ sentinelId: string; lastRunAt: string; lastError: string | null }>;
  open: SentinelFinding[];
  resolved: SentinelFinding[];
  digest: Array<{ id: string; findingKey: string; severity: string; title: string; detail: string; createdAt: string }>;
}

export interface SentinelFinding {
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

export interface AgentRow {
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
  provider: { kind: string; model: string; credentialKind: string; credentialEnv: string };
}

/**
 * One agent's engine, read from the agent *file* rather than from the catalog
 * the server booted with — so a change made a second ago shows immediately, and
 * `restartRequired` is the honest difference between the file and the running
 * surfaces.
 */
export interface AgentEngine {
  id: string;
  handle: string;
  name: string;
  isDefault: boolean;
  provider: string;
  model: string;
  maxTurns: number;
  language: string;
  credentialKind: string;
  credentialEnv: string;
  available: boolean;
  unavailableReason?: string;
  restartRequired: boolean;
}

/** The model catalogue, per provider, with what this machine can reach. */
export interface ProviderModels {
  kind: string;
  credentialEnv: string;
  credentialKind: string;
  usable: boolean;
  problem?: { code: string; message: string };
  defaultModel: string;
  defaultFrom: string;
  defaultEnv: string;
  prefixes: string[];
  models: Array<{ id: string; note: string }>;
}

export interface AgentsView {
  agents: AgentRow[];
  engines: AgentEngine[];
  providers: ProviderModels[];
}

export interface EngineChange {
  provider?: string;
  model?: string;
  maxTurns?: number;
  language?: string;
}

export const api = {
  session: () => get<{ csrf: string; timezone: string; host: string; port: number }>('/session'),
  overview: () => get<Overview>('/overview'),
  events: (q: Record<string, string | number | undefined>) => get<EventPage>('/events', q),
  eventKinds: () => get<{ kinds: Array<{ kind: string; count: number }> }>('/events/kinds'),
  conversations: () => get<{ conversations: ConversationSummary[] }>('/conversations'),
  conversation: (id: string) => get<Transcript>(`/conversations/${encodeURIComponent(id)}`),
  missions: () => get<{ missions: MissionRow[] }>('/missions'),
  jobs: (q: Record<string, string | undefined> = {}) =>
    get<{ jobs: JobRow[]; counts: Record<string, number>; paused: boolean }>('/jobs', q),
  approvals: () => get<{ pending: ApprovalRow[]; recent: ApprovalRow[] }>('/approvals'),
  reminders: () => get<{ reminders: ReminderRow[] }>('/reminders'),
  sentinels: () => get<SentinelsView>('/sentinels'),
  agents: () => get<AgentsView>('/agents'),

  decide: (id: string, decision: 'approve' | 'reject') =>
    post<{ action: ApprovalRow; execution: { state: string; message?: string } | null }>(
      `/approvals/${encodeURIComponent(id)}/${decision}`,
    ),
  setPaused: (paused: boolean) => post<{ paused: boolean }>('/pause', { paused }),
  setMissionEnabled: (id: string, enabled: boolean) =>
    post<{ id: string; enabled: boolean }>(`/missions/${encodeURIComponent(id)}/enabled`, { enabled }),
  setMisfirePolicy: (id: string, misfirePolicy: string, deadlineMinutes?: number | null) =>
    post<unknown>(`/missions/${encodeURIComponent(id)}/schedule`, {
      misfirePolicy,
      ...(deadlineMinutes === undefined ? {} : { deadlineMinutes }),
    }),
  retryJob: (id: string) => post<{ job: JobRow }>(`/jobs/${encodeURIComponent(id)}/retry`),
  cancelJob: (id: string) => post<{ job: JobRow }>(`/jobs/${encodeURIComponent(id)}/cancel`),
  setAgentEngine: (id: string, change: EngineChange) =>
    post<{ agent: AgentEngine; changed: string[]; note: string }>(
      `/agents/${encodeURIComponent(id)}/engine`,
      change,
    ),
  cancelReminder: (id: string) =>
    post<{ id: string; state: string }>(`/reminders/${encodeURIComponent(id)}/cancel`, {
      reason: 'cancelled from the dashboard',
    }),
};
