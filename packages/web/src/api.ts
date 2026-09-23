/**
 * The one place the page talks to the server.
 *
 * Every request is same-origin and carries the session cookie the ticket
 * exchange set. Every *write* additionally echoes the CSRF cookie back in a
 * header — the double-submit half of the protection; the server checks the
 * Origin for the other half. Nothing here ever touches a third-party host.
 */
import type { ViewDescriptor } from './canvas/types';
import type { PageActResult, PluginPageDescriptor, PluginWorkspaceFiles } from './pages/types';
import type {
  AgentHoldBack,
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

export function csrfToken(): string {
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

/**
 * An archive, sent as the body it is.
 *
 * Not multipart: the gateway streams this request straight to a file under
 * `<data>/incoming/` without buffering it, and an archive is measured in
 * gigabytes. So the two small strings that go with it — the passphrase, and
 * the typed-back confirmation — travel as headers, which is also what keeps
 * them out of the URL and therefore out of any log. The name is sanitised
 * because a header may hold nothing but Latin-1, and because the server uses
 * only its suffix anyway; it never becomes a path.
 */
export function sendFile<T>(
  path: string,
  file: File,
  fallbackName: string,
  headers: Record<string, string> = {},
): Promise<T> {
  const name = file.name.replace(/[^\w.-]+/g, '_').slice(-120) || fallbackName;
  return request<T>(`/api${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      [CSRF_HEADER]: csrfToken(),
      'X-Filename': name,
      ...headers,
    },
    body: file,
  });
}

export function sendArchive<T>(
  path: string,
  file: File,
  fields: { passphrase?: string | undefined; confirm?: string | undefined },
): Promise<T> {
  return sendFile<T>(path, file, 'backup.tar.gz', {
    ...(fields.passphrase ? { 'X-Backup-Passphrase': fields.passphrase } : {}),
    ...(fields.confirm ? { 'X-Backup-Confirm': fields.confirm } : {}),
  });
}

/**
 * Changing part of something that already exists: what the body leaves out is
 * left exactly as it was. A group's name without restating its membership.
 */
export function patch<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(`/api${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', [CSRF_HEADER]: csrfToken() },
    body: JSON.stringify(body ?? {}),
  });
}

/** Replacing a whole setting the server keeps one of: the schedule, the passphrase. */
export function put<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>(`/api${path}`, {
    method: 'PUT',
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
  messages: Array<{ id: string; role: string; createdAt: string; blocks: TranscriptBlock[]; speaker?: string }>;
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

/** One control the tool offered the owner on this approval. */
export interface OwnerChoiceRow {
  key: string;
  label: string;
  options: string[];
  default: string;
}

export interface ApprovalRow {
  permissionScopes?: ('conversation' | 'always')[];
  /** Controls to draw above the buttons. Empty for almost every action. */
  choices?: OwnerChoiceRow[];
  /** What the owner picked, once decided. */
  ownerChoices?: Record<string, string> | null;
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
  /** When the owner said no to it. Only ever set on a row under the fold. */
  dismissedAt?: string | null;
  /** When its moment passed without anybody deciding. Also fold-only. */
  lapsedAt?: string | null;
  /** Which of the three lapse conditions fired. */
  lapseReason?: 'owner-moved-on' | 'rolled-over' | 'agent-removed' | null;
}

/**
 * One thing an agent learned and proposed, as the inbox draws it.
 *
 * `untrusted` and `sources` come from the run, never from the agent: they are
 * the web pages, mail and files that were in its context when it proposed.
 */
export interface ProposalRow {
  id: string;
  kind: 'skill' | 'policy' | 'change';
  agent: string;
  title: string;
  why: string;
  /** The text the owner may correct before keeping. Null for a policy. */
  editable: string | null;
  payload: Record<string, unknown>;
  conversationId: string | null;
  turn: number | null;
  runId: string | null;
  untrusted: boolean;
  sources: string[];
  state: 'open' | 'kept' | 'discarded' | 'expired';
  createdAt: string;
  decidedAt: string | null;
  reason: string | null;
  /** For a kept one: what keeping did, or when it will. */
  note: string | null;
}

/** What a lapse is called on the page, in the owner's words. */
export function lapseSentence(row: OfferRow): string {
  if (row.dismissedAt) return 'You said no to this one.';
  switch (row.lapseReason) {
    case 'owner-moved-on':
      return 'The conversation moved on.';
    case 'rolled-over':
      return 'That conversation ended.';
    case 'agent-removed':
      return 'That agent is no longer here.';
    default:
      return 'It lapsed.';
  }
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
  installed: Array<{
    id: string;
    description: string;
    every: number;
    /** False when the owner has switched this watcher off. It does not run. */
    enabled: boolean;
  }>;
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
  /**
   * What the steps cannot say: the conversation the owner met their assistant
   * in, and the account they chose while meeting it. A reload reads both.
   */
  details: { conversationId?: string; accountId?: string };
  needs: { owner: boolean; model: boolean; agent: boolean };
}

/** What the gateway found when it asked Ollama, here, a second ago. */
export interface OllamaProbe {
  running: boolean;
  models: string[];
  /** Where to get it. It travels as data so this bundle names no outside host. */
  downloadUrl: string;
  /** Where an account for it points — also data, for the same reason. */
  baseUrl: string;
  /** Where Ollama's hosted service answers, for the card that offers it. */
  cloudBaseUrl: string;
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
  /** Why it is not talking yet, when buddi had something to say about it. */
  note?: string | undefined;
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
  /** Capabilities it answers for, in declaration order. */
  roles: string[];
  /** An emoji, or an image file name inside the agent's folder. */
  avatar?: string;
  /** Its own colour, `#rrggbb`. */
  accent?: string;
  skills: Array<{ name: string; provenance: string; file: string }>;
  /** Who it may hand work to. */
  delegates: string[];
  /** A shipped example: read-only until Agent Father makes a private copy. */
  isExample: boolean;
  /** Set when a granted tool family is not installed here; `tools` is empty. */
  heldBack?: AgentHoldBack;
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
  /** Set when a granted tool family is not installed here. */
  heldBack?: AgentHoldBack;
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

/**
 * Which agent a chat that names nobody lands on.
 *
 * An installation record, not a flag in an agent file: the picker on the
 * Agents page writes it, and both the dashboard and Telegram read the same
 * row. `problem` is what the *files* still disagree about, which the picker
 * turns into one sentence — the choice recorded here wins over all of them.
 */
export interface DefaultAgentView {
  defaultAgentId: string | null;
  problem?: { code: 'multiple-defaults' | 'no-default-agent'; agents: string[]; message: string };
  choices: Array<{ id: string; handle: string; name: string; available: boolean }>;
}

export interface AgentsView {
  providerAccounts?: ProviderAccountsView;
  agents: AgentRow[];
  engines: AgentEngine[];
  providers: ProviderModels[];
  default?: DefaultAgentView;
}

/** The front matter the runtime reads, as the agent's page edits it. */
/**
 * Every installed tool, for the picker on the Setup tab —
 * `GET /api/agents/:id/tools`. The shape is the server's
 * (`packages/gateway/src/web/tool-picker.ts`): which group a tool is in, what a
 * whole group saves as, which tools are never grantable here, which are core
 * and what a plugin suggests are all decided there, so the page names no tool.
 */
export interface PickerTool {
  name: string;
  description: string;
  tier: string;
  gated: boolean;
  grantable: boolean;
  core: boolean;
}

export interface PickerGroup {
  plugin: string;
  glob?: string;
  tools: PickerTool[];
}

export interface ToolPickerView {
  id: string;
  groups: PickerGroup[];
  granted: string[];
  suggested?: { plugin: string; label: string; tools: Array<{ name: string; description: string }> };
}

export interface AgentFileEdit {
  name?: string;
  handle?: string;
  description?: string;
  avatar?: string;
  accent?: string;
  tools?: string[];
  roles?: string[];
  maxTurns?: number;
  language?: string;
  persona?: string;
}

export interface ProviderAccount {
  id: string; label: string; kind: 'anthropic' | 'openai' | 'openai-compatible' | 'codex';
  auth: 'api-key' | 'none' | 'legacy-subscription-token' | 'chatgpt' | 'anthropic-oauth'; baseUrl: string;
  defaultModel: string; enabled: boolean; revision: number; configured: boolean;
  /** The owner's context-window override, in tokens, or null for automatic. */
  contextWindowTokens?: number | null;
  /** What the server would assume for `defaultModel`: the field's placeholder. */
  detectedContextWindowTokens?: number;
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
  id?: string; revision?: number; secret?: string; contextWindowTokens?: number | null;
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
  /** Set when a granted tool family is not installed here. */
  heldBack?: AgentHoldBack;
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

/* ------------------------------------------------------------------ *
 * The version, and upgrading to the next one.
 * ------------------------------------------------------------------ */

/** One upgrade this installation has been through, newest last. */
export interface UpgradeAttempt {
  from: string;
  to: string;
  startedAt: string;
  finishedAt?: string;
  outcome: 'done' | 'failed' | 'rolled-back';
  /** The backup taken before it started, which is the way back from a bad one. */
  backup?: string;
  error?: string;
  /** Where it stopped, when it stopped: backup, installing, migrating. */
  step?: string;
}

/** Signing in through Tailscale, as the System panel draws it. */
export interface TailscaleView {
  enabled: boolean;
  login: string;
  /** Is a local `tailscaled` there to ask? */
  available: boolean;
  /** Who this machine is signed in to Tailscale as, so the field can prefill. */
  self: { login: string; name: string } | null;
  /** Did this very request come through the tailnet proxy? */
  proxied: boolean;
  /** The `tailscale serve` command, with this installation's own ports in it. */
  serveCommand: string;
}

export interface VersionView {
  current: string;
  latest?: string;
  checkedAt?: string;
  checkEnabled: boolean;
  updateAvailable: boolean;
  /** The last check that did not get an answer. Never fatal, always said. */
  error?: string;
  history: UpgradeAttempt[];
  supervised: boolean;
  /** A developer checkout, which upgrades with git rather than with this page. */
  checkout: boolean;
}

/** An upgrade in flight, as the supervisor reports it while it still can. */
export interface UpgradeJob {
  id: string;
  phase: string;
  phases?: string[];
  detail?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

/* ------------------------------------------------------------------ *
 * Backups and recovery, from the supervisor through the gateway.
 * ------------------------------------------------------------------ */

/** One archive in `<data>/backups`. Callers send the name back, never a path. */
export interface BackupArchive {
  name: string;
  createdAt: string;
  bytes: number;
  encrypted: boolean;
  /** Null for a plain archive: there is no envelope to have an opinion about. */
  envelopeOk: boolean | null;
}

export interface BackupsView {
  dir: string;
  archives: BackupArchive[];
  /**
   * What a restore has to be confirmed with, when the server offers it. The
   * guard itself lives on the server; this only lets the panel say the word
   * out loud instead of asking for one the owner has to guess.
   */
  database?: string;
  /** False in a developer checkout, where a restore has no supervisor to run it. */
  supervised?: boolean;
}

/** The phases a backup or restore passes through, in order. */
export type BackupPhase =
  | 'stopping'
  | 'snapshot'
  | 'database'
  | 'recovery'
  | 'files'
  | 'starting'
  | 'encrypt'
  | 'done'
  | 'failed'
  | 'rolled-back';

export interface BackupJob {
  id: string;
  kind: string;
  phase: BackupPhase | string;
  detail?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  report?: unknown;
  /** A backup that was made but could not be copied to the folder tier. */
  copyLate?: boolean;
}

export interface BackupSchedule {
  /**
   * False where the schedule is not the supervisor's to keep: a checkout's
   * backups are a launchd or systemd unit, and the page says so rather than
   * offering a switch that would change nothing.
   */
  supervised?: boolean;
  error?: string;
  enabled: boolean;
  /** Local time, `HH:MM`. */
  time: string;
  keep: number;
  encryptLocal: boolean;
  copyTo: string | null;
  lastRunAt?: string | null;
}

/** What a restored installation still needs a person for. */
export interface RecoveryView {
  active: boolean;
  restoredAt: string | null;
  archive: string | null;
  checklist: {
    secrets: Array<{ name: string; kind: 'account' | 'telegram' | 'plugin'; settingsRoute: string }>;
    plugins: Array<{ name: string; version: string; source: string; installed: boolean }>;
    pending: { jobs: number; missions: number; approvals: number; telegramChats: number };
    grants: Array<{ id: string; agent: string; tool: string; scope: string; description: string }>;
  };
}

/* ------------------------------------------------------------------ *
 * Plugins, from `packages/gateway/src/web/plugins.ts`.
 * ------------------------------------------------------------------ */

/** Where an installed plugin came from. The same three the record keeps. */
export type PluginSource =
  | { kind: 'directory'; path: string }
  | { kind: 'registry'; name: string; version: string; registry?: string }
  | { kind: 'tarball'; path: string };

/** Where an agent a plugin proposes stands against the owner's own copy. */
export interface PluginDrift {
  state:
    | 'not-accepted'
    | 'up-to-date'
    | 'proposal-changed'
    | 'owner-edited'
    | 'owner-edited-and-proposal-changed'
    | 'gone';
  message: string;
}

export interface PluginUnlock {
  id: string;
  handle: string;
  drift: PluginDrift;
}

export interface InstalledPluginView {
  name: string;
  version: string;
  source: PluginSource;
  publisher?: string;
  integrity?: string;
  installedAt: string;
  contribution: { tools: number; sentinels: number; views: number; agents: number };
  unlocks: PluginUnlock[];
  loaded: boolean;
  /** Why its entry point did not load. Set only when `loaded` is false. */
  error?: string;
}

/**
 * The plan the *first* approval produces.
 *
 * `drift` is the list of differences between what the package's prose claims
 * and what its manifest actually declares. A non-empty one is the whole reason
 * a second approval exists.
 */
export interface PluginPlan {
  contribution?: unknown;
  drift: string[];
  agents: PluginUnlock[];
}

/** A package fetched and read, but not yet imported or installed. */
export interface StagedPluginView {
  id: string;
  name: string;
  version: string;
  source: PluginSource;
  publisher?: string;
  integrity?: string;
  /**
   * The hash of the unpacked tree — the package, its dependencies, and the
   * links npm wrote among them. The integrity above says what was fetched;
   * this says what is on disk, and approving re-checks it.
   */
  stagedHash?: string;
  /** The name of the file the owner uploaded, when this stage came from one. */
  uploadedName?: string;
  dependencies: { count: number; withScripts: string[] };
  /** The package's own words about itself, from its buddi.md. Never checked. */
  claims: { schema?: string; hosts: string[]; text: string; missing: boolean };
  /** Lifecycle scripts the package itself declares. */
  scripts: string[];
  /** Set when this stage came from an update: what it would replace. */
  previous?: { name: string; version: string };
  plan?: PluginPlan;
  state: 'staged' | 'approved' | 'planned';
}

/**
 * A plugin buddi ships with.
 *
 * Read-only on the page: nothing installed it and nothing can remove it. It is
 * here so the list of tools an agent can reach has one place that names all of
 * them, rather than only the ones the owner added.
 */
export interface BuiltInPluginView {
  name: string;
  version: string;
  contribution: { tools: number; sentinels: number; views: number; agents: number };
  description?: string;
}

export interface PluginsView {
  /** Shown above the install field, verbatim, and never paraphrased. */
  trust: string;
  installed: InstalledPluginView[];
  /** Optional while the gateway that sends it is still landing. */
  builtIn?: BuiltInPluginView[];
  staged: StagedPluginView[];
  restartNeeded: boolean;
  /** True in a developer checkout, where a restart is a command and not a button. */
  checkout: boolean;
  /** Set when this build has no plugin engine at all. */
  unavailable?: string;
}

export interface PluginJob {
  id: string;
  kind: 'stage' | 'update';
  phase: 'fetching' | 'installing-dependencies' | 'reading' | 'done' | 'failed';
  error?: string;
  stagedId?: string;
  startedAt: string;
  finishedAt?: string;
}

export interface PluginApproval {
  /** Present when the drift still has to be read; absent once it is installed. */
  plan?: PluginPlan;
  /** The record that was written. Present only once it is installed. */
  installed?: { name: string; version: string };
  restartNeeded?: boolean;
  /** Migration filenames applied, and why none were when that is the answer. */
  migrations?: string[];
  migrationProblem?: string;
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
  send: (agentId: string, body: { conversationId?: string; text: string; attachmentIds?: string[]; opening?: boolean }) =>
    post<{
      conversationId: string;
      runId: string;
      /** The agent was working: this went into that run, under `pendingId`. */
      queued?: boolean;
      pendingId?: string;
    }>(`/chat/${encodeURIComponent(agentId)}/messages`, body),
  answerQuestion: (id: string, body: { answer: string; optionId?: string; skipped?: boolean }) =>
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
  updateGroup: (id: string, body: { name?: string; coordinator?: string; members?: string[] }) =>
    patch<GroupView>(`/groups/${encodeURIComponent(id)}`, body),
  // Archived, never deleted: the room leaves the rail and keeps its transcript.
  archiveGroup: (id: string) => del<null>(`/groups/${encodeURIComponent(id)}`),
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
  /**
   * The way into a preview: a URL on the preview origin carrying a
   * single-use ticket. It is asked for per panel and never stored — the
   * ticket is good for five minutes and once.
   */
  previewLink: (plugin: string, name: string) =>
    get<{ url: string }>(`/preview/${encodeURIComponent(plugin)}/${encodeURIComponent(name)}/link`),
  /**
   * Is this preview being served right now? Asked while a process that was
   * not listening yet is starting, so its tab opens when it is. Not rate
   * limited like `previewLink`, and mints nothing.
   */
  previewCheck: (plugin: string, name: string) =>
    get<{ ok: boolean; absoluteAssets: boolean }>(`/preview/${encodeURIComponent(plugin)}/${encodeURIComponent(name)}/check`),
  extension: () => get<ExtensionState>('/extension'),
  pairExtension: (code: string) => post<ExtensionState>('/extension/pair', { code }),
  forgetExtension: () => del<ExtensionState>('/extension/pair'),
  session: () => get<{ csrf: string; timezone: string; host: string; port: number; version?: string; signedInThrough?: 'ticket' | 'local' | 'tailscale'; tailscaleName?: string; tailscaleLogin?: string }>('/session'),
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
  /** What is on the table, and under `closed` what was refused or lapsed this week. */
  offers: () => get<{ offers: OfferRow[]; closed: OfferRow[] }>('/offers'),
  /** The owner said no to one. Starts nothing; the row stays for the record. */
  dismissOffer: (id: string) =>
    post<{ id: string; dismissedAt: string }>(`/offers/${encodeURIComponent(id)}/dismiss`, {}),
  /** The owner cleared exactly the displayed offers. */
  dismissOffers: (ids: readonly string[]) =>
    post<{ dismissed: number }>('/offers/dismiss-all', { ids }),
  /** Open proposals, and under `closed` what was kept, discarded or expired this week. */
  proposals: () => get<{ open: ProposalRow[]; closed: ProposalRow[] }>('/proposals'),
  /** Keep one, optionally with the owner's corrected text. */
  keepProposal: (id: string, text?: string) =>
    post<{ proposal: ProposalRow; applied: boolean; note: string }>(
      `/proposals/${encodeURIComponent(id)}/keep`,
      text === undefined ? {} : { text },
    ),
  /** Discard one, with the owner's reason when they gave one. */
  discardProposal: (id: string, reason?: string) =>
    post<{ proposal: ProposalRow }>(
      `/proposals/${encodeURIComponent(id)}/discard`,
      reason ? { reason } : {},
    ),
  reminders: () => get<{ reminders: ReminderRow[] }>('/reminders'),
  sentinels: () => get<SentinelsView>('/sentinels'),
  /**
   * Switch one watcher off, or back on. Off means it does not run at all; what
   * it already found stays where it is rather than reading as resolved.
   */
  setSentinelEnabled: (id: string, enabled: boolean) =>
    post<{ sentinelId: string; enabled: boolean }>(
      `/sentinels/${encodeURIComponent(id)}/enabled`,
      { enabled },
    ),
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
  onboardingStep: (step: string, learned: { conversationId?: string; accountId?: string } = {}) =>
    post<OnboardingView>('/onboarding/step', { step, ...learned }),
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
  /**
   * Change the assistant after it exists — its name, face or purpose.
   *
   * A separate route because writing the *first* agent is refused once there
   * is one, and "change either, or keep them" has to keep working.
   */
  updateFirstAgent: (body: { name?: string; description?: string; avatar?: string }) =>
    post<CreatedAgent>('/onboarding/agent/update', body),
  /**
   * Give the assistant the brain the thread just tested — and move whatever
   * was following it onto the same account, in one call.
   */
  bindBrain: (body: { accountId: string; model: string }) =>
    post<{ assistant: string | null; followed: string[] }>('/onboarding/brain', body),
  /* ---- plugin pages: descriptors, reads, writes ---- */
  /**
   * The screens the installed plugins contribute. Data, like the canvas's
   * views: the page owns the components and learns from here which of them go
   * where — an installation without a plugin is served none of its screen.
   */
  pages: () => get<{ pages: PluginPageDescriptor[]; files?: PluginWorkspaceFiles[] }>('/pages'),
  /** One plugin page query. Every parameter is a string; the plugin's schema decides. */
  pageQuery: <T = unknown>(plugin: string, query: string, params: Record<string, string> = {}) =>
    get<{ data: T }>(`/pages/${encodeURIComponent(plugin)}/${encodeURIComponent(query)}`, params),
  /**
   * The same route, as a URL for the browser to load itself: a query that
   * answers with bytes (an image, a PDF, a download) rather than data.
   */
  pageFileUrl: (plugin: string, query: string, params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== '')).toString();
    return `/api/pages/${encodeURIComponent(plugin)}/${encodeURIComponent(query)}${qs ? `?${qs}` : ''}`;
  },
  /**
   * One write from a plugin page: a tool of that plugin, invoked as the owner.
   * An `auto` tool answers with its result; a `gated` one with the id of the
   * approval the owner now has to decide.
   */
  pageAct: (plugin: string, body: { tool: string; args?: Record<string, unknown> }) =>
    post<PageActResult>(`/pages/${encodeURIComponent(plugin)}/act`, body),
  /* ---- Telegram, from the first-run thread ---- */
  telegram: () => get<TelegramStatus>('/telegram'),
  saveTelegramToken: (token: string) => post<SavedTelegramToken>('/telegram/token', { token }),
  telegramPairing: () => post<PairingOffer>('/telegram/pairing'),
  /* ---- the owner ---- */
  owner: () => get<OwnerView>('/owner'),
  setOwner: (patch: OwnerPatch) => post<OwnerView>('/owner', patch),
  /* ---- memory ---- */
  /** Everything, or — with an agent id — what that agent sees: shared plus its own. */
  memory: (agentId?: string) => get<MemoryView>(agentId ? `/memory?agent=${encodeURIComponent(agentId)}` : '/memory'),
  setPreference: (body: { key: string; value: string; scope: string }) => post<MemoryPreference>('/memory/preferences', body),
  forgetPreference: (body: { key: string; scope: string }) => post<null>('/memory/preferences/forget', body),
  updateNote: (id: string, change: { content?: string; scope?: string; kind?: string }) => post<MemoryNote>(`/memory/notes/${encodeURIComponent(id)}`, change),
  forgetNote: (id: string) => post<null>(`/memory/notes/${encodeURIComponent(id)}/forget`),
  setDelegates: (id: string, delegates: string[]) => post<{ delegates: string[] }>(`/agents/${encodeURIComponent(id)}/delegates`, { delegates }),
  agentProfile: (id: string) => get<AgentProfile>(`/agents/${encodeURIComponent(id)}/profile`),

  host: (agentId?: string, conversationId?: string) => get<HostState>('/host', { agentId, conversationId }),
  stopHost: (agentId: string, conversationId: string) => post<{ stopped: number }>('/host/stop', { agentId, conversationId }),
  revokeHost: (id: string) => post<{ revoked: boolean }>('/host/revoke', { id }),
  decide: (
    id: string,
    decision: 'approve' | 'reject',
    permissionScope?: 'once' | 'conversation' | 'always',
    // What the owner set on the card's controls. The server checks every key
    // and value against what the action declared; nothing here is trusted.
    ownerChoices?: Record<string, string>,
  ) =>
    post<{
      action: ApprovalRow;
      /** `result` is the tool's own output, when it ran and succeeded. */
      execution: { state: string; message?: string; result?: unknown } | null;
    }>(
      `/approvals/${encodeURIComponent(id)}/${decision}`,
      permissionScope || ownerChoices
        ? { ...(permissionScope ? { permissionScope } : {}), ...(ownerChoices ? { ownerChoices } : {}) }
        : undefined,
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
  /* ---- the version, and upgrading ---- */
  version: () => get<VersionView>('/version'),
  /** Ask the registry now. The only outbound call this page can cause. */
  checkVersion: () => post<VersionView>('/version/check'),
  setVersionCheck: (enabled: boolean) => put<VersionView>('/version/check', { enabled }),
  /* ---- signing in through Tailscale ---- */
  tailscale: () => get<TailscaleView>('/tailscale'),
  setTailscale: (change: { enabled: boolean; login: string }) => put<TailscaleView>('/tailscale', change),
  /**
   * Start an upgrade. Accepted rather than completed, like a restart: it takes
   * a backup, installs the new version and restarts buddi under this page.
   */
  startUpgrade: (version?: string) => post<{ job: UpgradeJob }>('/upgrade', version === undefined ? {} : { version }),
  upgradeJob: (id: string) => get<UpgradeJob>(`/upgrade/jobs/${encodeURIComponent(id)}`),
  /* ---- backups and recovery ---- */
  backups: () => get<BackupsView>('/backups'),
  startBackup: (encrypt: boolean) => post<{ job: BackupJob }>('/backups', { encrypt }),
  verifyArchive: (name: string) => post<{ job: BackupJob }>('/backups/verify', { name }),
  /**
   * Restore an archive this installation already holds.
   *
   * `confirm` is the typed-back guard, checked on the server: a target with
   * anything in it refuses without it. A checkout has no supervisor to stop
   * the gateway, and answers 409 with what to run instead.
   */
  restoreArchive: (body: { name: string; passphrase?: string; confirm?: string }) =>
    post<{ job: BackupJob }>('/backups/restore', body),
  /** The same restore, from a file on the owner's own machine. */
  restoreUpload: (file: File, fields: { passphrase?: string; confirm?: string }) =>
    sendArchive<{ job: BackupJob }>('/backups/restore', file, fields),
  backupJob: (id: string) => get<BackupJob>(`/backups/jobs/${encodeURIComponent(id)}`),
  backupSchedule: () => get<BackupSchedule>('/backups/schedule'),
  setBackupSchedule: (schedule: BackupSchedule) => put<BackupSchedule>('/backups/schedule', schedule),
  backupPassphrase: () => get<{ passphrase: string }>('/backups/passphrase'),
  setBackupPassphrase: (passphrase: string) => put<{ passphrase: string }>('/backups/passphrase', { passphrase }),
  /* ---- plugins ---- */
  plugins: () => get<PluginsView>('/plugins'),
  stagePlugin: (spec: string) => post<{ job: PluginJob }>('/plugins/stage', { spec }),
  /**
   * The same stage, from a .tgz on the owner's own machine.
   *
   * Sent as the body it is, like a backup archive: the gateway streams it to
   * disk and stages it from there, so this answers with the same job as
   * `stagePlugin` and is followed the same way.
   */
  uploadPlugin: (file: File) => sendFile<{ job: PluginJob }>('/plugins/upload', file, 'plugin.tgz'),
  pluginJob: (id: string) => get<PluginJob>(`/plugins/jobs/${encodeURIComponent(id)}`),
  /**
   * Approve a staged package.
   *
   * `integrity` is the hash the card showed, sent back so the approval can
   * only ever mean the package that was read about. `acknowledgeDrift` comes
   * from the second card and nowhere else: it says the owner read the list of
   * differences between the package's claim and its manifest.
   */
  approveStaged: (id: string, body: { integrity?: string; acknowledgeDrift?: boolean }) =>
    post<PluginApproval>(`/plugins/staged/${encodeURIComponent(id)}/approve`, body),
  rejectStaged: (id: string) => post<{ rejected: string }>(`/plugins/staged/${encodeURIComponent(id)}/reject`),
  updatePlugin: (name: string, version?: string) =>
    post<{ job: PluginJob }>(`/plugins/${encodeURIComponent(name)}/update`, version ? { version } : {}),
  /** `purge` drops the plugin's schema, and the server asks for the name back. */
  uninstallPlugin: (name: string, body: { purge?: boolean; confirm?: string }) =>
    post<{ name: string; purged: boolean; notes: string[]; restartNeeded: boolean }>(
      `/plugins/${encodeURIComponent(name)}/uninstall`,
      body,
    ),
  /**
   * Accept an agent a plugin proposes, as the owner.
   *
   * Gated, so what comes back is an approval id and its preview: the page
   * draws the card and the owner decides there. A `result` instead would mean
   * the tool was not gated, which it is.
   */
  acceptPluginAgent: (plugin: string, agent: string) =>
    post<{ approvalId?: string; preview?: string; result?: unknown }>(
      `/plugins/${encodeURIComponent(plugin)}/agents/${encodeURIComponent(agent)}/accept`,
    ),
  recovery: () => get<RecoveryView>('/recovery'),
  leaveRecovery: (body: { dropPending: boolean; keepGrants: string[] }) =>
    post<{ accepted?: boolean }>('/recovery/leave', body),
  /**
   * The restore first run offers, before a single question has been answered.
   * No typed-back guard: there is nothing in this installation to lose.
   */
  firstRunRestore: (file: File, passphrase: string) =>
    sendArchive<{ job: BackupJob }>('/onboarding/restore', file, { passphrase }),
  setMissionEnabled: (id: string, enabled: boolean) =>
    post<{ id: string; enabled: boolean }>(`/missions/${encodeURIComponent(id)}/enabled`, { enabled }),
  setMisfirePolicy: (id: string, misfirePolicy: string, deadlineMinutes?: number | null) =>
    post<unknown>(`/missions/${encodeURIComponent(id)}/schedule`, {
      misfirePolicy,
      ...(deadlineMinutes === undefined ? {} : { deadlineMinutes }),
    }),
  retryJob: (id: string) => post<{ job: JobRow }>(`/jobs/${encodeURIComponent(id)}/retry`),
  cancelJob: (id: string) => post<{ job: JobRow }>(`/jobs/${encodeURIComponent(id)}/cancel`),
  setDefaultAgent: (agentId: string) =>
    post<DefaultAgentView & { note: string }>('/agents/default', { agentId }),
  agentTools: (id: string) => get<ToolPickerView>(`/agents/${encodeURIComponent(id)}/tools`),
  updateAgentFile: (id: string, change: AgentFileEdit) =>
    post<{ id: string; handle: string; file: string; tools: string[]; changed: string[]; personaChanged: boolean; live: boolean; message: string }>(
      `/agents/${encodeURIComponent(id)}/file`,
      change,
    ),
  setAgentEngine: (id: string, change: EngineChange) =>
    post<{ agent: AgentEngine; changed: string[]; note: string }>(
      `/agents/${encodeURIComponent(id)}/engine`,
      change,
    ),
  /**
   * Take one of the things an agent offered.
   *
   * The request names an id — never a prompt. `conversationId` is the thread
   * the page has open, and it only decides *where the owner is looking*: a chip
   * taken in its own conversation runs there, as a turn they can watch, and
   * anything else goes on the queue exactly as it did.
   */
  takeOffer: (id: string, conversationId?: string) =>
    post<{ id: string; label: string; jobId: string | null; conversationId?: string; runId?: string }>(
      `/offers/${encodeURIComponent(id)}/take`,
      conversationId ? { conversationId } : {},
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

export type BrowserMode = 'computer' | 'playwright' | 'extension';
export interface ControlSettings { mode: BrowserMode; browserApp: string; allowedApps: string[]; browserProfile?: string }
/** "Your browser": the Chrome extension, as the gateway sees it. */
export interface ExtensionState {
  connected: boolean;
  /** A browser is waiting for the owner to type the code it is showing. */
  pending: boolean;
  /** The unpacked folder to point "Load unpacked" at. */
  path: string;
  pairedAt?: string;
  extension?: string;
  lastSeenAt?: string;
}
export interface BrowserStatus {
  mode?: BrowserMode;
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
  /** Take over only: whether this screen can be driven from the dashboard. */
  hand?: boolean;
  /** Why it cannot, in the mode's own words. */
  handMessage?: string;
  sessions?: BrowserStatus[];
}
