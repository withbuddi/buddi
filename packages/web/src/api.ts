/**
 * The one place the page talks to the server.
 *
 * Every request is same-origin and carries the session cookie the ticket
 * exchange set. Every *write* additionally echoes the CSRF cookie back in a
 * header — the double-submit half of the protection; the server checks the
 * Origin for the other half. Nothing here ever touches a third-party host.
 */
import type { ViewDescriptor } from './canvas/types';
import type {
  AgentsResponse,
  ChatConversation,
  ConversationListItem,
  UploadedAttachment,
  GroupView,
} from './chat/types';

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

/**
 * A multipart upload. Same rules as every other write — same origin, the CSRF
 * header echoed back — but the browser sets `Content-Type` itself so the
 * boundary is right.
 */
export function upload<T>(path: string, form: FormData): Promise<T> {
  return request<T>(`/api${path}`, {
    method: 'POST',
    headers: { [CSRF_HEADER]: csrfToken() },
    body: form,
  });
}

export function del<T>(path: string): Promise<T> {
  return request<T>(`/api${path}`, {
    method: 'DELETE',
    headers: { [CSRF_HEADER]: csrfToken() },
  });
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

export interface HomeStat { label: string; value: string; note?: string; tone?: 'good' | 'warning' | 'critical' }
export interface HomeRow { title: string; sub?: string; side?: string; tone?: 'good' | 'critical' }
export interface HomeBlock { id: string; title: string; note?: string; stats: HomeStat[]; rows: HomeRow[]; rowsTitle?: string; sensitive?: boolean }

export interface Overview {
  now: string;
  timezone: string;
  paused: boolean;
  /** What the installed plugins put on Home, already formatted, in their order. */
  home: HomeBlock[];
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
  permissionScopes?: ('conversation' | 'always')[];
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

/**
 * One action an agent offered the owner, still on the table.
 *
 * The same row Telegram draws as a button. `prompt` is shown rather than
 * hidden: the owner should be able to read what a chip will ask before they
 * click it, and there is nothing here that is not theirs to see.
 */
export interface OfferRow {
  id: string;
  agentId: string;
  conversationId: string | null;
  label: string;
  prompt: string;
  createdAt: string;
  expiresAt: string;
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
  snoozedAt: string | null;
}

/**
 * First run, as the server sees it: where the record stands and what the
 * wizard still has to ask for (`packages/gateway/src/web/onboarding.ts`).
 */
export interface OnboardingView {
  state: 'pending' | 'in-progress' | 'done' | 'skipped';
  stepsDone: string[];
  needs: { owner: boolean; model: boolean; agent: boolean };
}

/** What the gateway found when it asked Ollama, here, a second ago. */
export interface OllamaProbe {
  running: boolean;
  models: string[];
  /** Where to get it. It travels as data so this bundle names no outside host. */
  downloadUrl: string;
}

/** Telegram, as this installation stands: a token, a surface, a phone. */
export interface TelegramStatus {
  configured: boolean;
  running: boolean;
  paired: boolean;
}
export interface SavedTelegramToken extends TelegramStatus {
  /** The token is kept, but this buddi has to be started again to use it. */
  restartNeeded: boolean;
  botUsername: string | null;
}
export interface PairingOffer {
  code: string;
  link: string;
  expiresAt: string;
}

/** What writing the first agent answers with: the row, as /api/agents shapes it. */
export interface CreatedAgent {
  agent: AgentRow | null;
  id: string;
  handle: string;
  file: string;
  /** False when the file is written but the running catalog could not reload. */
  live: boolean;
  /** The model account it was given, when there was exactly one to give. */
  accountId: string | null;
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
  /** Who it may hand work to. */
  delegates: string[];
  /** A shipped example: read-only until Agent Father makes a private copy. */
  isExample: boolean;
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
  /** Reasoning before the answer: on, off, or null for the model's default. */
  thinking: 'on' | 'off' | null;
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

export interface ProvidersView {
  vault: { kind: string; locked: boolean; advice: string };
  providers: Array<ProviderModels & { activeCredential: string; credentials: Array<{ name: string; configured: boolean; source: string }>;
    test: { state: string; message: string; checkedAt: string } | null }>;
}

export interface AgentsView {
  providerAccounts?: ProviderAccountsView;
  agents: AgentRow[];
  engines: AgentEngine[];
  providers: ProviderModels[];
}

export interface ProviderAccount {
  id: string; label: string; kind: 'anthropic' | 'openai' | 'openai-compatible' | 'codex';
  auth: 'api-key' | 'none' | 'legacy-subscription-token' | 'chatgpt' | 'anthropic-oauth'; baseUrl: string;
  defaultModel: string; enabled: boolean; revision: number; configured: boolean;
  refreshable: boolean; tokenExpiresAt: string | null; subscriptionRenewsAt: string | null;
  assignedAgents: string[]; test: { state: string; message: string; checkedAt: string; httpStatus?: number | null; retryAt?: string | null } | null;
  removalPending?: boolean;
  reconnectRequired?: boolean;
  login?: { state: 'pending' | 'connected' | 'failed' | 'cancelled'; verificationUrl?: string; userCode?: string; expiresAt?: string; message?: string; attemptId?: string } | null;
}
export interface ProviderAccountsView {
  codexEnabled?: boolean;
  anthropicOAuthEnabled?: boolean;
  vault: { kind: string; locked: boolean; advice: string };
  accounts: ProviderAccount[];
  bindings: Array<{ agentId: string; accountId: string; model: string }>;
}
export type SaveProviderAccount = Pick<ProviderAccount, 'label' | 'kind' | 'auth' | 'baseUrl' | 'defaultModel' | 'enabled'> & {
  id?: string; revision?: number; secret?: string;
};

/**
 * One agent, whole — `GET /api/agents/:id/profile`.
 *
 * The shape is the server's (`packages/gateway/src/web/profile.ts`). Nothing
 * here is domain vocabulary: a family is whatever plugin the server says
 * shipped the tool, and a tier is the platform's own word for whether a call
 * runs or stops for the owner.
 */
export interface AgentProfileTool {
  name: string;
  description: string;
  tier: string;
  /** The call stops and becomes an approval. The panel leads with this. */
  gated: boolean;
}

export interface AgentProfileFamily {
  family: string;
  tools: AgentProfileTool[];
  gated: number;
}

export interface AgentProfile {
  id: string;
  handle: string;
  name: string;
  description: string;
  isDefault: boolean;
  source: string;
  file: string;
  available: boolean;
  unavailableReason?: string;
  roles: string[];
  engine: {
    provider: string;
    model: string;
    maxTurns: number;
    language: string;
    credentialKind: string;
    /** The variable the credential is read from. Never a value. */
    credentialEnv: string;
  };
  tools: AgentProfileFamily[];
  toolCount: number;
  gatedCount: number;
  skills: Array<{
    name: string;
    description?: string;
    provenance: string;
    scope: string;
    file: string;
  }>;
  delegates: Array<{
    id: string;
    handle: string;
    name: string;
    description: string;
    available: boolean;
  }>;
  /** Where a change goes, resolved by role. Absent when nothing claims it. */
  changeVia?: {
    agentId: string;
    handle: string;
    name: string;
    prompt: string;
    available: boolean;
  };
  note: string;
}

/** One file in the library (docs/files.md). */
export interface LibraryEntry {
  id: string;
  filename: string | null;
  mime: string;
  family: 'image' | 'pdf' | 'table' | 'text' | 'code' | 'audio' | 'video' | 'archive' | 'file';
  sizeBytes: number;
  createdAt: string;
  origin: 'uploaded' | 'produced' | 'unknown';
  agentId: string | null;
  deleted: boolean;
  contexts: number;
  context: { agentId: string | null; groupName: string | null } | null;
}
export interface LibraryContext {
  conversationId: string;
  kind: 'uploaded' | 'produced' | 'reused';
  agentId: string | null;
  conversationAgentId: string;
  groupId: string | null;
  groupName: string | null;
  at: string;
}

/** The owner, as every agent is told about them. All of it may be empty. */
export interface OwnerView {
  preferredName: string | null;
  timezone: string | null;
  language: string | null;
  about: string | null;
  displayName: string | null;
  /** The zone this host runs in, offered as the default. */
  detectedTimezone: string;
  /** Every zone the host knows, for the picker. */
  zones: string[];
}
export interface OwnerPatch {
  preferredName?: string | null;
  timezone?: string | null;
  language?: string | null;
  about?: string | null;
}

export interface MemoryPreference {
  key: string;
  value: string;
  /** `shared` or an agent id. */
  scope: string;
  revision: number;
  updatedAt: string | null;
}
export interface MemoryNote {
  id: string;
  content: string;
  kind: string;
  scope: string;
  createdAt: string | null;
  expiresAt: string | null;
  createdByAgent: string | null;
  sourceConversationId: string | null;
}
export interface MemoryView {
  preferences: MemoryPreference[];
  notes: MemoryNote[];
}

/**
 * The supervisor's own report, verbatim. A packaged installation has one; a
 * developer checkout does not, and then `supervised` is false and there is
 * nothing to show.
 */
export interface ServiceStatus {
  phase?: string;
  supervisorPid: number;
  installRoot: string;
  nodePath: string;
  database: string;
  databasePid: number | null;
  gateway: string;
  gatewayPid: number | null;
}

export interface ServiceView {
  supervised: boolean;
  status?: ServiceStatus;
  /** A stop or a restart that was accepted; it takes this page down with it. */
  pending?: 'stop' | 'restart';
}

export interface EngineChange {
  provider?: string;
  model?: string;
  maxTurns?: number;
  language?: string;
  /** `null` removes the setting: back to the model's default. */
  thinking?: 'on' | 'off' | null;
}

/* ------------------------------------------------------------------ *
 * The chat surface, from `packages/gateway/src/web/chat.ts`.
 * ------------------------------------------------------------------ */

export const chatApi = {
  agents: () => get<AgentsResponse>('/chat/agents'),
  /**
   * The view descriptors of every installed plugin: data saying how a tool's
   * result should be drawn. The page ships no plugin code; this is the only
   * thing that makes a plugin's output look like anything in particular.
   */
  views: () => get<{ views: ViewDescriptor[] }>('/chat/views'),
  conversations: (agentId: string, limit?: number) =>
    get<{ conversations: ConversationListItem[] }>(`/chat/${encodeURIComponent(agentId)}/conversations`, { limit }),
  startConversation: (agentId: string) =>
    post<{ conversationId: string }>(`/chat/${encodeURIComponent(agentId)}/conversations`),
  conversation: (id: string) => get<ChatConversation>(`/chat/conversations/${encodeURIComponent(id)}`),
  send: (agentId: string, body: { conversationId?: string; text: string; attachmentIds?: string[] }) =>
    post<{
      conversationId: string;
      runId: string;
      /**
       * The thread the page was in had ended (idle, or too long), and this
       * message opened a new one. `note` is the line the owner reads; the page
       * follows `conversationId` either way.
       */
      boundary?: { note: string; previousConversationId: string };
    }>(`/chat/${encodeURIComponent(agentId)}/messages`, body),
  answerQuestion: (id: string, body: { answer: string; optionId?: string }) =>
    post<{ conversationId: string; runId: string }>(
      `/chat/questions/${encodeURIComponent(id)}/answer`,
      body,
    ),
  cancel: (conversationId: string) =>
    post<unknown>(`/chat/conversations/${encodeURIComponent(conversationId)}/cancel`),
  attach: (file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return upload<UploadedAttachment>('/chat/attachments', form);
  },
  /** A file taken back out of the tray before it was sent. Refused if a message carries it. */
  discardAttachment: (artifactId: string) => del<null>(`/artifacts/${encodeURIComponent(artifactId)}`),
  /* ---- groups ---- */
  groups: () => get<{ groups: GroupView[] }>('/groups'),
  group: (id: string) => get<GroupView & { latestConversationId: string | null; openRequest: { id: string; state: string; awaitingAgentId: string | null; budgetReserved: number; budgetTotal: number } | null }>(`/groups/${encodeURIComponent(id)}`),
  createGroup: (body: { name: string; coordinator: string; members: string[] }) => post<GroupView>('/groups', body),
  archiveGroup: (id: string) => post<null>(`/groups/${encodeURIComponent(id)}/archive`),
  groupConversations: (id: string) => get<{ conversations: ConversationListItem[] }>(`/groups/${encodeURIComponent(id)}/conversations`),
  startGroupConversation: (id: string) => post<{ conversationId: string }>(`/groups/${encodeURIComponent(id)}/conversations`),
  sendToGroup: (id: string, body: { conversationId?: string; text: string; attachmentIds?: string[] }) =>
    post<{ conversationId: string; runId: string; requestId: string; rolledOver?: boolean }>(`/groups/${encodeURIComponent(id)}/messages`, body),
  /** The SSE endpoint for one conversation's run. */
  streamUrl: (conversationId: string) =>
    `/api/chat/conversations/${encodeURIComponent(conversationId)}/stream`,
};

export const api = {
  providers: () => get<ProvidersView>('/providers'),
  providerAccounts: () => get<ProviderAccountsView>('/provider-accounts'),
  probeModels: (body: { kind: 'anthropic' | 'openai' | 'openai-compatible'; auth: 'api-key' | 'none'; baseUrl?: string; secret?: string }) =>
    post<{ models: Array<{ id: string; name: string; isDefault: boolean; thinks?: boolean }>; truncated: boolean }>('/provider-accounts/probe-models', body),
  accountModels: (id: string, refresh = false) => post<{ models: Array<{ id: string; name: string; isDefault: boolean; thinks?: boolean }>; truncated: boolean }>(`/provider-accounts/${encodeURIComponent(id)}/models`, { refresh }),
  saveProviderAccount: (body: SaveProviderAccount) => post<{ id: string; warning?: string }>('/provider-accounts/save', body),
  testProviderAccount: (id: string) => post<{ state: string; message: string }>(`/provider-accounts/${encodeURIComponent(id)}/test`),
  removeProviderAccount: (id: string, revision: number) => post(`/provider-accounts/${encodeURIComponent(id)}/remove`, { revision }),
  codexAccountAction: (id: string, action: 'login' | 'cancel-login' | 'logout', revision: number) => post(`/provider-accounts/${encodeURIComponent(id)}/${action}`, { revision }),
  anthropicAccountAction: (id: string, action: 'login' | 'complete-login' | 'cancel-login' | 'logout', revision: number, input?: { attemptId: string; code: string }) => post(`/provider-accounts/${encodeURIComponent(id)}/anthropic/${action}`, { revision, ...input }),
  assignProviderAccount: (agent: string, accountId: string, model: string) => post<{ changed: string[]; note: string }>(`/agents/${encodeURIComponent(agent)}/account`, { accountId, model }),
  configureProvider: (kind: string, body: { credentialKind: string; defaultModel: string }) => post<ProvidersView>(`/providers/${encodeURIComponent(kind)}/settings`, body),
  saveCredential: (name: string, value: string) => post<ProvidersView>(`/providers/credentials/${encodeURIComponent(name)}/save`, { value }),
  removeCredential: (name: string) => post<ProvidersView>(`/providers/credentials/${encodeURIComponent(name)}/remove`),
  testProvider: (kind: string) => post<{ state: string; message: string }>(`/providers/${encodeURIComponent(kind)}/test`),
  browserProfiles: (app: string) => get<{ profiles: Array<{ directory: string; name: string }> }>('/host/browser-profiles', { app }),
  installedApps: () => get<{ apps: Array<{ id: string; name: string; path: string }> }>('/host/apps'),
  browser: (scope?: { agentId: string; conversationId: string }) => get<BrowserStatus>(`/browser${scope ? `?agentId=${encodeURIComponent(scope.agentId)}&conversationId=${encodeURIComponent(scope.conversationId)}` : ''}`),
  browserControl: (action: 'stop' | 'takeover' | 'resume' | 'release', sessionId?: string) => post<BrowserStatus>(`/browser/${action}`, sessionId === undefined ? {} : { sessionId }),
  browserSettings: (settings: ControlSettings) => post<BrowserStatus>('/browser/settings', settings),
  computerPermissions: (prompt = false) => post<BrowserStatus>('/browser/permissions', { prompt }),
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
  /**
   * One action by id, whole: the envelope it is bound to and the preview the
   * tool itself rendered. The approval canvas draws from this rather than
   * hunting for the row in the list — a decided action leaves the pending list
   * the moment it is decided, and the canvas still has to show it.
   *
   * Wrapped in `{ action }`, the same shape the approve and reject routes
   * answer with, so the canvas reads one field whichever call produced it.
   */
  approval: (id: string): Promise<ApprovalRow> =>
    get<{ action: ApprovalRow }>(`/approvals/${encodeURIComponent(id)}`).then(
      (body) => body.action,
    ),
  offers: () => get<{ offers: OfferRow[] }>('/offers'),
  reminders: () => get<{ reminders: ReminderRow[] }>('/reminders'),
  sentinels: () => get<SentinelsView>('/sentinels'),
  snoozeAlert: (key: string, snoozed: boolean) => post<{ key: string; snoozedAt: string | null }>(`/alerts/${encodeURIComponent(key)}/snooze`, { snoozed }),
  agents: () => get<AgentsView>('/agents'),
  /**
   * What one agent is: its grant with every tool's tier, its engine, its
   * skills, its delegates. A read; there is no counterpart that writes.
   */
  /* ---- files: the library over the artifact store ---- */
  library: (query: { q?: string; origin?: string; family?: string; cursor?: string; limit?: number }) =>
    get<{ entries: LibraryEntry[]; next: string | null }>('/artifacts', query),
  libraryEntry: (id: string, contextsOffset = 0) =>
    get<{ entry: LibraryEntry; contexts: LibraryContext[]; contextsTotal: number; contextsOffset: number; available: boolean }>(`/artifacts/${encodeURIComponent(id)}`, contextsOffset ? { contexts: contextsOffset } : {}),
  /* ---- first run ---- */
  onboarding: () => get<OnboardingView>('/onboarding'),
  onboardingStep: (step: string) => post<OnboardingView>('/onboarding/step', { step }),
  completeOnboarding: () => post<OnboardingView>('/onboarding/complete'),
  skipOnboarding: () => post<OnboardingView>('/onboarding/skip'),
  createFirstAgent: (body: { name: string; handle: string; description: string; avatar?: string; accountId?: string }) =>
    post<CreatedAgent>('/onboarding/agent', body),
  /**
   * Is Ollama running on the machine buddi runs on?
   *
   * Asked of the gateway, never of `localhost:11434` from here: this page
   * reaches no host but its own, and the answer is about that machine anyway.
   */
  ollama: () => get<OllamaProbe>('/onboarding/ollama'),
  /* ---- Telegram, from the first-run thread ---- */
  telegram: () => get<TelegramStatus>('/telegram'),
  saveTelegramToken: (token: string) => post<SavedTelegramToken>('/telegram/token', { token }),
  telegramPairing: () => post<PairingOffer>('/telegram/pairing'),
  /* ---- the owner ---- */
  owner: () => get<OwnerView>('/owner'),
  setOwner: (patch: OwnerPatch) => post<OwnerView>('/owner', patch),
  /* ---- memory ---- */
  memory: () => get<MemoryView>('/memory'),
  setPreference: (body: { key: string; value: string; scope: string }) => post<MemoryPreference>('/memory/preferences', body),
  forgetPreference: (body: { key: string; scope: string }) => post<null>('/memory/preferences/forget', body),
  updateNote: (id: string, change: { content?: string; scope?: string; kind?: string }) => post<MemoryNote>(`/memory/notes/${encodeURIComponent(id)}`, change),
  forgetNote: (id: string) => post<null>(`/memory/notes/${encodeURIComponent(id)}/forget`),
  setDelegates: (id: string, delegates: string[]) => post<{ delegates: string[] }>(`/agents/${encodeURIComponent(id)}/delegates`, { delegates }),
  agentProfile: (id: string) => get<AgentProfile>(`/agents/${encodeURIComponent(id)}/profile`),

  host: (agentId?: string, conversationId?: string) => get<HostState>('/host', { agentId, conversationId }),
  stopHost: (agentId: string, conversationId: string) => post<{ stopped: number }>('/host/stop', { agentId, conversationId }),
  revokeHost: (id: string) => post<{ revoked: boolean }>('/host/revoke', { id }),
  decide: (id: string, decision: 'approve' | 'reject', permissionScope?: 'once' | 'conversation' | 'always') =>
    post<{ action: ApprovalRow; execution: { state: string; message?: string } | null }>(
      `/approvals/${encodeURIComponent(id)}/${decision}`,
      permissionScope ? { permissionScope } : undefined,
    ),
  setPaused: (paused: boolean) => post<{ paused: boolean }>('/pause', { paused }),
  service: () => get<ServiceView>('/service'),
  /**
   * Start, stop or restart the gateway through the supervisor. A `stop` or a
   * `restart` is *accepted* rather than completed: it ends the gateway serving
   * this page, so the answer arrives before the action does — and `buddi` in a
   * terminal, not this page, is what starts a gateway that is down.
   */
  serviceAction: (action: 'start' | 'stop' | 'restart') => post<ServiceView>(`/service/${action}`),
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
  takeOffer: (id: string) =>
    post<{ id: string; label: string; jobId: string | null }>(
      `/offers/${encodeURIComponent(id)}/take`,
    ),
  cancelReminder: (id: string) =>
    post<{ id: string; state: string }>(`/reminders/${encodeURIComponent(id)}/cancel`, {
      reason: 'cancelled from the dashboard',
    }),
};

export interface HostState {
  permissions: { id: string; agentId: string; conversationId: string; toolVersion: string }[];
  runs: { actionId: string; agentId: string; conversationId: string; command: string; cwd: string; stdout: string; stderr: string }[];
}

export interface ControlSettings { mode: 'computer' | 'playwright'; browserApp: string; allowedApps: string[]; browserProfile?: string }
export interface BrowserStatus {
  mode?: 'computer' | 'playwright';
  settings?: ControlSettings;
  permissions?: { supported: boolean; accessibility: boolean; screenRecording: boolean; message?: string };
  state: 'unavailable' | 'idle' | 'starting' | 'running' | 'paused' | 'stopped' | 'expired' | 'error';
  enabled: boolean;
  busy: boolean;
  session?: { id: string; agentId: string; conversationId: string; requestId: string; task: string; expiresAt: string; steps: number; maxSteps: number };
  page?: { id: string; url: string; title: string; capturedAt: string; tabs: Array<{ id: string; url: string; title: string }> };
  lastAction?: string;
  message?: string;
  hasScreenshot: boolean;
  sessions?: BrowserStatus[];
}
