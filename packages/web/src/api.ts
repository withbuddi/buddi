/**
 * The one place the page talks to the server.
 *
 * Every request is same-origin and carries the session cookie the ticket
 * exchange set. Every *write* additionally echoes the CSRF cookie back in a
 * header — the double-submit half of the protection; the server checks the
 * Origin for the other half. Nothing here ever touches a third-party host.
 */
import { displayFormats, usesTwelveHours, type TokenUsage } from './format';
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

/**
 * The CSRF cookie is named after the port (`buddi_csrf_<port>`), because a
 * browser keeps one cookie of a name per host and ignores the port — two
 * buddis on one machine would otherwise read each other's. The gateway names
 * it after the port this page was loaded on, so this page's is the one named
 * after `location.port`.
 */
export const CSRF_COOKIE_PREFIX = 'buddi_csrf';
export const CSRF_HEADER = 'x-buddi-csrf';
/** A window event: the roster changed (a picture, say); re-read it now rather than in 15 s. */
export const AGENTS_CHANGED = 'buddi:agents-changed';
/** A window event: focus or the queue's pause changed here; the footer and the banner re-read now. */
export const STATUS_CHANGED = 'buddi:status-changed';
const statusChanged = <T,>(result: T): T => {
  window.dispatchEvent(new Event(STATUS_CHANGED));
  return result;
};

/**
 * A window event: the server answered 423 — this session is locked (the
 * lock screen, docs/dashboard.md). The lock gate puts the lock screen up.
 */
export const LOCKED = 'buddi:locked';

/** What a write refused by the CSRF gate tells the owner. */
export const STALE_COOKIES = "This page's sign-in no longer matches its cookies. Reload the page and try again.";

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

/**
 * This page's CSRF value, or '' when it has none.
 *
 * The exact-port cookie is the answer. Only when there is none, and exactly
 * one `buddi_csrf*` cookie on this host, is that one taken: a proxy that
 * rewrites Host on the way in (the gateway then names the cookie after its
 * own port) still works. With two or more there is no telling which is ours,
 * and guessing would send another buddi's token; the write then fails with
 * the sentence `request` gives a 403.
 */
export function csrfToken(): string {
  const port = Number(location.port) || (location.protocol === 'https:' ? 443 : 80);
  const own = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE_PREFIX}_${port}=([^;]*)`));
  if (own?.[1]) return decodeURIComponent(own[1]);
  const any = [...document.cookie.matchAll(new RegExp(`(?:^|; )${CSRF_COOKIE_PREFIX}(?:_\\d+)?=([^;]*)`, 'g'))];
  return any.length === 1 && any[0]?.[1] ? decodeURIComponent(any[0][1]) : '';
}

/*
 * Whether buddi answers at all, as the page's own requests find out.
 *
 * "Not answering" is narrow on purpose: no response (the tailnet is off, the
 * Mac is asleep, nothing listens on the port), or a 502/503 that is not
 * buddi's own — the proxy in front of it (`tailscale serve`) saying there is
 * nobody behind it. A 503 buddi sends with a sentence is an answer. Anything
 * that answers is proof of life. The shell reads this for the "Lost buddi"
 * bar (src/shell/Unreachable.tsx).
 */
export const UNREACHABLE = "buddi isn't answering.";
let downSince: number | null = null;
const linkListeners = new Set<() => void>();

function noteLink(up: boolean): void {
  if (up === (downSince === null)) return;
  downSince = up ? null : Date.now();
  for (const listener of linkListeners) listener();
}

/** When the requests stopped getting answers, or null while they get them. */
export function linkDownSince(): number | null {
  return downSince;
}

/** Called whenever the link goes down or comes back. Returns the unsubscribe. */
export function onLinkChange(listener: () => void): () => void {
  linkListeners.add(listener);
  return () => linkListeners.delete(listener);
}

/** For tests: a link that answers. */
export function resetLink(): void {
  downSince = null;
}

/** The error means nobody is there to answer, as opposed to an answer that says no. */
export function isUnreachable(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status === 502 || error.status === 503) && error.message === UNREACHABLE;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      redirect: 'error',
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
    });
  } catch (error) {
    // A request the page itself called off is not the network's doing.
    if ((error as { name?: string } | null)?.name === 'AbortError' || init.signal?.aborted) throw error;
    noteLink(false);
    throw new ApiError(0, UNREACHABLE, error);
  }
  if (res.status === 401) {
    noteLink(true);
    throw new ApiError(401, 'This session has expired. Run `buddi dashboard` for a fresh link.');
  }
  if (res.status === 423) {
    // Locked: nothing of the app is drawn until the PIN is typed.
    noteLink(true);
    window.dispatchEvent(new Event(LOCKED));
    throw new ApiError(423, 'This dashboard is locked.');
  }
  const text = await res.text();
  const body: unknown = text === '' ? null : safeJson(text);
  const stated = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : undefined;
  if ((res.status === 502 || res.status === 503) && stated === undefined) {
    noteLink(false);
    throw new ApiError(res.status, UNREACHABLE, body);
  }
  noteLink(true);
  if (!res.ok) {
    // A bare 403 on a write is the gateway's origin and CSRF gate: this page's
    // cookies no longer match the session it holds. A 403 that says why is
    // shown as it is.
    const method = (init.method ?? 'GET').toUpperCase();
    const message =
      stated ??
      (res.status === 403 && method !== 'GET' && method !== 'HEAD'
        ? STALE_COOKIES
        : `request failed (${res.status})`);
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

/** One tip on Home: a sentence and one action. */
/** An agent as a new agent's strip names it. */
export interface IntroAgent {
  id: string;
  handle: string;
  name: string;
  /** The front desk, named "the front desk". */
  frontDesk?: true;
}

/** GET /api/agents/:id/intro: the strip a new agent's chat opens with, once. */
export type AgentIntro =
  | { show: false }
  | { show: true; id: string; handle: string; asks: 'everyone' | IntroAgent[]; askedBy: IntroAgent[] };

export interface TipView {
  id: string;
  text: string;
  action: { label: string; route: string };
}

/** One row of the Tips list: a tip and where it stands today. */
export interface TipListRow extends TipView {
  status: 'today' | 'holding' | 'quiet' | 'dismissed' | 'shown';
  dismissedAt?: string;
  holdsSince?: string;
  shownAt?: string;
}

/**
 * How this browser reads a clock, when the owner left Time on Auto: the
 * gateway formats widget times (the World clock, a calendar) and cannot know.
 * Nothing when the owner picked 12- or 24-hour; the gateway applies that.
 */
function hourCycle(): { hour?: string } {
  return displayFormats().time === 'auto' ? { hour: usesTwelveHours() ? '12' : '24' } : {};
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

/** One line beside Home's date. `icon` is a tile icon, or `dot` for one outside the set. */
export interface HomeGlance {
  id: string;
  title: string;
  plugin: string;
  icon: string;
  text: string;
  link?: { plugin: string; page: string; place: 'rail' | 'settings' };
  /** The same glance as a card for the right of the greeting, already formatted. Absent from an older gateway or plugin. */
  card?: HomeGlanceCard;
  hidden: boolean;
}

export interface HomeGlanceCard {
  value: string;
  caption?: string;
  trend?: { label: string; points: number[] };
  foot?: string;
}

/* ---- Home's widgets (gateway web/widgets.ts) ---- */

export type WidgetSize = 'small' | 'medium';

/** The vocabulary a plugin fills; already formatted, cut to size by the gateway. */
export type WidgetBody =
  | { kind: 'stat'; icon?: string; value: string; caption?: string; trend?: { label?: string; points: number[] }; foot?: string }
  /**
   * A row's `image.src` (1.27) is buddi's own path to the plugin's kept image, drawn at both sizes;
   * `max: 5` asks for five denser rows at medium, `wrap` lets a title take two lines.
   */
  | { kind: 'list'; rows: Array<{ title: string; sub?: string; side?: string; tone?: 'good' | 'critical'; image?: { src?: string; label?: string } }>; more?: string; max?: 3 | 5; wrap?: boolean }
  | { kind: 'strip'; icon?: string; value?: string; caption?: string; items: Array<{ label: string; icon?: string; value: string }> }
  | { kind: 'progress'; value: string; caption?: string; ratio: number; foot?: string; tone?: 'accent' | 'good' | 'warning' | 'critical' }
  | { kind: 'text'; icon?: string; text: string; sub?: string }
  /** Analog faces the page ticks itself: the owner's zone, then up to four faces. */
  | { kind: 'clocks'; home: string; clocks: Array<{ label: string; zone: string; latitude?: number; longitude?: number }>; time?: '12h' | '24h' };

export type WidgetSurface = 'home' | 'lock';

/** One choice of a select or multiselect. */
export interface WidgetSettingOption {
  value: string;
  label: string;
}

/** A setting a widget declares, from the fixed vocabulary (core widget-settings.ts). */
export type WidgetSettingField = {
  key: string;
  label: string;
  hint?: string;
  inTitle?: boolean;
} & (
  | { kind: 'select'; options?: WidgetSettingOption[]; dynamic?: true; default?: string }
  | { kind: 'multiselect'; options?: WidgetSettingOption[]; dynamic?: true; default?: string[] }
  | { kind: 'toggle'; default?: boolean }
  | { kind: 'text'; placeholder?: string; max?: number; default?: string }
  | { kind: 'place'; multiple?: boolean }
  | { kind: 'timeFormat' }
);

/** A place setting's value, as kept: the owner's place by id, or a town found by name. */
export type WidgetPlaceValue = { place: string } | { label: string; name: string; latitude: number; longitude: number; timezone: string | null };

export interface WidgetInfo {
  id: string;
  plugin: string;
  title: string;
  sizes: WidgetSize[];
  link?: { plugin: string; page: string; place: 'rail' | 'settings' };
  sensitive?: boolean;
  /** What each placement of it can set; absent when nothing. */
  settings?: WidgetSettingField[];
  /** buddi's own (the World clock): no plugin behind it. */
  builtIn?: true;
}

export interface WidgetView {
  state: 'ok' | 'empty' | 'stale' | 'error';
  body?: WidgetBody;
  updatedAt?: string;
  error?: string;
}

/** One widget on one surface, at a size, with its own settings. */
export interface WidgetPlacement {
  /** Absent on one the page just added: the gateway names it on save. */
  key: string;
  widget: string;
  size: WidgetSize;
  settings: Record<string, unknown>;
  /** "Weather · Work". */
  label?: string;
}

export interface WidgetsAnswer {
  available: WidgetInfo[];
  home: WidgetPlacement[];
  lock: WidgetPlacement[];
  arranged: { home: boolean; lock: boolean };
  /** By placement key, for the surface asked. */
  views: Record<string, WidgetView>;
}

/** The settings sheet: the fields with their choices read now, and the owner's places. */
export interface WidgetSettingsSheet {
  widget: string;
  fields: WidgetSettingField[];
  places: Array<{ id: string; label: string; name: string; timezone: string | null }>;
  timeFormat: '12h' | '24h' | null;
}

/** Only what the owner can act on; `total` is the rail's badge. */
export interface NeedsYouCounts {
  approvals: number;
  questions: number;
  urgent: number;
  failed: number;
  proposals: number;
  /** Messages that carry an action (an agent's `owner.notify` with one). */
  asks: number;
  agentsToSetUp: number;
  signIns: number;
  recovery: number;
  total: number;
}

export interface Overview {
  now: string;
  timezone: string;
  paused: boolean;
  /** What the installed plugins put on Home, already formatted, in their order. */
  home: HomeBlock[];
  /** The glances beside the date, hidden ones included and marked. Absent from an older gateway. */
  glances?: HomeGlance[];
  approvals: { pending: number; oldestPendingAt: string | null };
  jobs: Record<string, number>;
  missions: { total: number; enabled: number; nextRun: string | null };
  reminders: { pending: number; nextDueAt: string | null };
  sentinels: {
    lastRunAt: string | null;
    /** Decisions waiting: rows on the Alerts page, a group counted once. */
    openUrgent: number;
    openInfo: number;
    /** The first few decisions in the owner's words. Absent from an older gateway. */
    decisions?: Array<{ id: string; title: string; count: number }>;
    errors: Array<{ sentinelId: string; error: string }>;
  };
  mail: Array<{ sourceId: string; lastRunAt: string; lastError: string | null }>;
  /** What the owner closed on Home, slot → the version closed. Absent from an older gateway. */
  dismissed?: Record<string, string>;
  /** Agent runs in progress in the dashboard's conversations right now. Absent from an older gateway. */
  /**
   * What needs the owner, counted once by the gateway (web/needs-you.ts):
   * Home's counts line and the rail's badge read it. Absent from an older gateway.
   */
  needsYou?: NeedsYouCounts;
  running?: number;
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
  usage: TokenUsage;
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
    usage: TokenUsage;
    actionId: string | null;
    resumed: boolean;
  }>;
  usage: TokenUsage;
}

export interface MissionRow {
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
    /** False: it follows the owner's zone (Settings → Profile). Absent from an older gateway. */
    timezoneExplicit?: boolean;
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
  /** An agent's watch: when it is done, in the agent's words. */
  stopWhen?: string;
  /** When it switches itself off; absent when it runs until stopped. */
  endsAt?: string;
  /** When it did switch itself off at its end. */
  endedAt?: string;
  /** Runs in a row that told the owner nothing. */
  quietRuns?: number;
  /** Set while "Still useful?" waits for Keep or Stop. */
  stillUsefulAskedAt?: string;
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
  /** A failed job that stopped asking: when, and `owner` or `auto` (quiet after 14 days). Absent from an older gateway. */
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Failed jobs that broke the same way (GET /api/jobs/failures). */
export interface FailureGroup {
  key: string;
  label: string;
  /** Why, in plain words for the owner. */
  reason: string;
  /** The cause has plausibly gone away: Retry is the primary action. */
  likelyFixed: boolean;
  count: number;
  firstAt: string;
  lastAt: string;
  agents: Array<{ id: string; name: string | null }>;
  jobs: Array<{ job: JobRow; agentId: string | null; agentName: string | null; missionId: string | null; missionName: string | null }>;
}

/** Which failed jobs a bulk write is about. */
export type JobPick = { ids: string[] } | { group: string; dismissed?: boolean } | { all: true };

/** One control the tool offered the owner on this approval. */
export interface OwnerChoiceRow {
  key: string;
  label: string;
  options: string[];
  default: string;
}

export interface ApprovalRow {
  permissionScopes?: ('conversation' | 'always')[];
  /** The card's heading in the owner's words, from the preview or the tool's description; never the dotted id. */
  ask?: string;
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

/** An agent a plugin offers on Home, while nobody has one with its id. */
export interface AgentOfferRow {
  plugin: string;
  agent: string;
  handle: string;
  name: string;
  description: string;
  /** The plugin's one line: why the owner would want it. */
  text: string;
}

/* ---- the agent catalogue (`/api/catalogue`, agent-catalogue.md §5) ---- */

/** The catalogue's categories, in the order the chips are drawn. */
export const CATALOGUE_CATEGORIES = ['work', 'money', 'home', 'health', 'learning', 'life'] as const;
export type CatalogueCategory = (typeof CATALOGUE_CATEGORIES)[number];

/** Something a package needs that is not here: a plugin (with its one fix) or a mailbox / a drawing account. */
export type CatalogueMissing =
  | { kind: 'plugin'; name: string; range: string; fix: 'install' | 'enable' | 'update'; installed?: string; title: string; listed: boolean; byBuddi: boolean; version?: string }
  | { kind: 'need'; name: 'mailbox' | 'image-account'; fix: 'mailbox' | 'accounts' };

/** Where an installed package stands against the listing: `edited` means the owner changed its file. */
export type CatalogueDrift = 'current' | 'update' | 'edited' | 'edited-update';

/** One listed agent package with where it stands here. */
export interface CatalogueAgent {
  name: string;
  version: string;
  handle: string;
  title: string;
  pitch: string;
  description: string;
  about: string;
  category: CatalogueCategory | string;
  trust: string;
  author: { name: string; url?: string };
  requires: Record<string, string>;
  optional: Record<string, string>;
  /** `mailbox`, `mailbox?` (better with one), `image-account`. */
  needs: string[];
  tools: string[];
  missions: Array<{ id: string; name: string; cron: string; when: string; prompt: string }>;
  fills: Array<{ id: string; kind: string; label: string; optional: boolean; default: string }>;
  examples: string[];
  /** Its text skills: the file name (no `.md`), its description, and its text to open. */
  skills: CatalogueSkill[];
  changes: string;
  replaces: string[];
  /** The picture on withbuddi.com, shown through `api.marketAssetUrl`. */
  avatar: string | null;
  page: string | null;
  claims?: { tools?: Array<{ name: string; tier?: string; ownerOnly?: boolean }> } & Record<string, unknown>;
  state: 'ready' | 'needs' | 'installed' | 'unavailable';
  missing?: CatalogueMissing[];
  installed?: { agentId: string; handle: string; version: string; drift: CatalogueDrift; via?: string };
  reason?: string;
  /** Add works now: nothing missing, or only By-buddi plugins it installs on the way. */
  addable: boolean;
}

/** One skill a package carries. */
export interface CatalogueSkill {
  name: string;
  description: string;
  text: string;
}

/** An agent an installed plugin proposes, shown "From <plugin>"; added through the plugin's own accept. */
export interface CataloguePluginAgent {
  plugin: string;
  pluginVersion: string;
  agent: string;
  handle: string;
  name: string;
  description: string;
  text: string;
  state: 'installed' | 'ready';
}

export interface CatalogueView {
  fetchedAt?: string;
  /** The kept copy, answered because withbuddi.com did not answer just now. */
  stale?: boolean;
  agents: CatalogueAgent[];
  fromPlugins: CataloguePluginAgent[];
  /** Agents added from the catalogue that it no longer lists: they keep working. */
  delisted: Array<{ agentId: string; handle: string; name?: string; package: string; version?: string }>;
  /** A mailbox is connected here, so a card that reads mail can say "Uses your mailbox". */
  mailbox?: boolean;
  /** No list and no copy: the sentence to show. */
  unavailable?: string;
  problems?: string[];
}

/** One pick the install sheet asks, with its default and, for a mailbox or calendar, the choices. */
export interface CatalogueFill {
  id: string;
  kind: 'mailbox' | 'calendar' | 'place' | 'time' | 'text' | string;
  label: string;
  optional?: boolean;
  mission?: string;
  value: string;
  choices?: string[];
}

/** What adding a package would do (`POST /api/catalogue/:name/plan`), writing nothing. */
export interface CataloguePlan {
  name: string;
  version: string;
  title: string;
  plugins: Array<{ name: string; title: string; version: string | null; byBuddi: boolean; fix: string }>;
  /** What holds it back that it cannot install on the way. */
  blocked: CatalogueMissing[];
  handle: string;
  fills: CatalogueFill[];
  tools: Array<{ name: string; tier: string; description?: string }>;
  missions: Array<{ id: string; name: string; cron: string; enabled: boolean; prompt: string }>;
  preview: string | null;
  /** The fingerprint of exactly this plan; absent while a plugin it needs is missing. */
  plan?: string;
  note?: string;
}

export type CatalogueStepState = 'waiting' | 'fetching' | 'reading' | 'installing' | 'loading' | 'adding' | 'confirm' | 'done' | 'failed';

/** The install job (`GET /api/catalogue/jobs/:id`). */
export interface CatalogueJob {
  id: string;
  name: string;
  version: string;
  title: string;
  /** `confirm`: what resolved once its plugins loaded is not the grant the sheet showed; the owner answers. */
  state: 'running' | 'confirm' | 'done' | 'failed';
  steps: Array<{ kind: 'plugin' | 'agent'; name: string; title: string; state: CatalogueStepState; reason?: string }>;
  agent?: { id: string; handle: string; name: string };
  /** The approval the agent step recorded: still open when the job waits on it. */
  approvalId?: string;
  /** With `confirm`: the whole grant as it resolved, and the tools the sheet did not show. */
  confirm?: { tools: Array<{ name: string; tier: string; description?: string }>; unshown: string[]; preview: string };
  error?: string;
  startedAt: string;
  finishedAt?: string;
}

/** The update sheet (`POST /api/catalogue/:name/update/plan`). */
export interface CatalogueUpdatePlan {
  /** The fingerprint of this plan: the update approves exactly it, or answers 409. */
  plan: string;
  agentId: string;
  handle: string;
  name: string;
  title: string;
  fromVersion: string;
  version: string;
  changes: string;
  via?: string;
  /** The owner changed the file: nothing is touched unless they replace it. */
  edited: boolean;
  /** Skills of the owner's own that a package skill of the same name would replace (they count as edits). */
  replacesOwn?: string[];
  /** Skills the earlier version wrote that this one dropped: they go to the trash. */
  retires?: string[];
  /** A tool or a required plugin was added: the approval lists the reach. */
  widened: boolean;
  added: Array<{ name: string; tier: string; description?: string }>;
  removed: string[];
  /** The persona's lines that differ, `- ` in the file and `+ ` in the new version. */
  personaDiff: string[];
  missionsAdded: Array<{ id: string; name: string; cron: string; enabled: boolean; prompt: string }>;
  /** Missions it already has that take the package's new settings (what it reads first, how long it reports). */
  missionsChanged?: Array<{ id: string; name: string; words: string }>;
  preview: string | null;
}

/** What removing an agent does (`GET /api/agents/:id/remove`): nothing changes until it is confirmed. */
export interface AgentRemovePreview {
  id: string;
  handle: string;
  name: string;
  pausesMissions: Array<string | { id?: string; name?: string }>;
  unusedPlugins: string[];
  /** Handles of the agents whose delegate list names it; removal takes it off them. Absent from an older gateway. */
  handedWorkBy?: string[];
  preview: string | null;
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
  /** Who decided it: the owner, or (a rule) its plugin keeping it itself. Absent on an older gateway. */
  decidedBy?: 'owner' | 'auto' | null;
  /** A rule's kind in its plugin's terms, and how the owner reads it: open cards of one kind are grouped. */
  ruleKind?: string | null;
  ruleKindLabel?: string | null;
  reason: string | null;
  /** For a kept one: what keeping did, or when it will. */
  note: string | null;
  /** Sentences of it that also appear in the untrusted text that was in view. Highlighted on the card. */
  echoes?: string[];
  /**
   * The learned skill of that name the agent has now. Open: the proposal is
   * its next version, drawn as a diff against `steps`. Kept: `live` when this
   * proposal is the version that loads now.
   */
  skill?: { name: string; version: number; proposal: string; steps: string; live: boolean } | null;
  /**
   * A change to the agent's own file, open: that part as the file says it now,
   * the tools the proposed list adds to the grant, and the refusal keeping it
   * as proposed would meet.
   */
  change?: { part: 'instructions' | 'tools'; current: string | null; added: string[]; refusal: string | null } | null;
}

/** One kind's count over the week, and up to three names. */
export interface DigestTally {
  count: number;
  names: string[];
}

/** The weekly learning digest, as the last run recorded it. */
export interface DigestRow {
  at: string;
  since: string;
  memory: DigestTally;
  skills: DigestTally;
  rules: DigestTally;
  changes: DigestTally;
  open: number;
  /** Times a kept learned rule acted this week, per plugin; null when nothing records it. */
  stopped: { total: number; byPlugin: Record<string, number> } | null;
  /** The owner's reactions on Telegram this week, per agent, and the 👎 notes. */
  feedback?: {
    byAgent: Record<string, { up: number; down: number; neutral: number }>;
    notes: Array<{ agentId: string; note: string }>;
  };
  /** The agents the reactions name, by id, as the owner knows them. */
  agentNames?: Record<string, string>;
  delivered: boolean;
  /** The week in the owner's words, one line per kind with something in it. Absent from an older gateway. */
  summary?: DigestLine[];
}

/** One line of the digest: "Remembered 18 things", and where to look. */
export interface DigestLine {
  key: string;
  text: string;
  link?: { label: string; route: string };
}

/** When the digest runs: day 0 is Sunday. */
export interface DigestSchedule {
  day: number;
  hour: number;
  timezone: string;
  next: string | null;
}

/** One skill an agent loads, on its sheet's Skills tab. */
export interface AgentSkillRow {
  name: string;
  description: string;
  scope: 'private' | 'shared';
  provenance: 'owner' | 'agent' | 'imported';
  source: string | null;
  file: string;
  body: string;
  learned: {
    title: string;
    agent: string;
    conversation: string | null;
    runId: string | null;
    turn: number | null;
    sources: string[];
    untrusted: boolean;
    proposal: string;
    keptAt: string;
    version: number;
    edited: boolean;
    versions: number[];
    versionsDir: string;
  } | null;
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
  /** What they found, as the owner reads it (gateway web/alerts.ts). Never a brief. */
  alerts: AlertsView;
}

export interface AlertItem {
  key: string;
  line: string;
  subject: { id: string; label: string } | null;
  note: string;
  firstSeenAt: string;
  /** Inside a group of many: this finding's own actions (Send, Discard, its own Open). */
  actions?: AlertAction[];
}

export type AlertAction =
  | { kind: 'open'; label: string; plugin: string | null; page?: string; item?: string; place?: 'files' }
  | { kind: 'run'; label: string; key: string; index: number; confirm?: string; tone?: 'danger' }
  | {
      kind: 'fill';
      label: string;
      title: string;
      fields: Array<{ key: string; index: number; label: string; type: 'number' | 'text' | 'date'; value: string | number | null; hint: string | null }>;
    }
  | { kind: 'ask'; label: string | null }
  | { kind: 'dismiss'; label: string };

/** One row of the Alerts page: a finding, or several of one kind. */
export interface AlertGroup {
  id: string;
  sentinelId: string;
  plugin: string | null;
  kind: string;
  title: string;
  line: string | null;
  urgent: boolean;
  since: string;
  agentId: string | null;
  keys: string[];
  items: AlertItem[];
  actions: AlertAction[];
  stop: { scope: 'subject' | 'kind'; label: string };
  snoozedUntil: string | null;
  resolvedAt: string | null;
}

export interface AlertsView {
  open: AlertGroup[];
  snoozed: AlertGroup[];
  resolved: AlertGroup[];
  recap: { count: number; missionId: string | null; nextAt: string | null; groups: AlertGroup[] };
  mutes: Array<{ id: string; sentinelId: string; label: string; createdAt: string }>;
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
  details: {
    conversationId?: string;
    accountId?: string;
    /** Chapter 3: the outcomes the owner asked buddi to take on; empty is "just an assistant". */
    takeOn?: string[];
    /** Chapter 4: which of its rows were done. */
    reach?: OnboardingReach;
  };
  needs: { owner: boolean; model: boolean; agent: boolean };
  /**
   * The tiles chapter 3 offers, as the gateway decided: only those whose
   * plugins withbuddi.com lists (My mail always). The page draws these alone.
   */
  offers?: string[];
}

/** Chapter 4 of first run, as the record keeps it. */
export interface OnboardingReach {
  phone?: boolean;
  mailbox?: boolean;
  app?: boolean;
  browser?: boolean;
}

/** One plugin chapter 3 is bringing in, as `GET /api/onboarding/take-on` says. */
export interface TakeOnPlugin {
  plugin: string;
  title: string;
  jobId?: string;
  state: 'fetching' | 'reading' | 'installing' | 'ready' | 'failed';
  reason?: string;
  wakesOnRestart?: boolean;
}

/** Chapter 3's progress and the handover card's "Things still waiting". */
export interface TakeOnView {
  tiles: string[];
  plugins: TakeOnPlugin[];
  running: boolean;
  waiting: string[];
}

/**
 * The Ollama Cloud model a new device-key account thinks with, when ollama.com
 * still offers it; otherwise the first it lists. A model name, not an address.
 */
export const OLLAMA_CLOUD_MODEL = 'gpt-oss:120b';

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
  /** The machine: installed or not, how to install it, which model suits it. Absent from an older gateway. */
  machine?: OllamaMachine;
  /** A model fetch started from the first run, as it stands. */
  pull?: OllamaPull | null;
}

/** What the gateway knows about the machine Ollama would run on. */
export interface OllamaMachine {
  platform: string;
  memoryGb: number;
  gpu: 'apple' | 'nvidia' | 'amd' | 'none';
  installed: boolean;
  recommended: { model: string; sizeGb: number };
  /** Where to download it, and the one command that installs it here (shown, never run by buddi). */
  install: { url: string; command?: string };
  /** Too little memory or no usable graphics chip: Ollama Cloud would be the better first brain. */
  cloudSuggested: boolean;
}

/** A model fetch into the local Ollama. */
export interface OllamaPull {
  model: string;
  state: 'pulling' | 'done' | 'failed';
  completed: number;
  total: number;
  status: string;
  error?: string;
}

/** What the gateway found when it asked mlxh, here, a moment ago (`GET /api/onboarding/mlxh`). */
export interface MlxhProbe {
  running: boolean;
  /** Where an account for it points — data, so this bundle names no host. */
  baseUrl: string;
  /** `mlxh serve` with no model: every installed model loads on demand. */
  manager: boolean;
  /** `kind` is only known for a loaded model. */
  models: Array<{ id: string; loaded: boolean; kind?: 'language' | 'image' }>;
  /** The server's own limit when it reports one; 0 means off. */
  maxPromptTokens?: number;
  workerIdleTimeoutS?: number;
  version?: string;
}

/* ---- notifications (docs/notifications.md) ---- */

export const NOTIFICATION_KINDS = ['approval', 'question', 'watcher', 'reminder', 'failure', 'recap', 'plugin', 'agent'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** One row of `core.owner_notifications`, as `GET /api/notifications` answers it. */
export interface NotificationRow {
  id: string;
  kind: NotificationKind;
  urgency: 'now' | 'today' | 'digest';
  title: string;
  text: string | null;
  /** A dashboard route. */
  link: string | null;
  agentId: string | null;
  pluginId: string | null;
  actionId: string | null;
  /** What it asks the owner to do; null for information. */
  action?: string | null;
  /** The gateway's one rule: an approval, a question, or a message with an action. Absent from an older gateway. */
  needsOwner?: boolean;
  state: 'shown' | 'held' | 'stored' | 'sending' | 'sent' | 'failed';
  dueAt: string | null;
  /** The channel kind it went to, `dashboard` when shown there, else null. */
  channel: string | null;
  /** Other agents that said the same thing, folded into this row. */
  alsoFrom?: string[];
  createdAt: string;
  sentAt: string | null;
  seenAt: string | null;
  actedAt: string | null;
  error: string | null;
}

/** A way buddi reaches the owner, as the gateway registered it. */
export interface NotificationChannel {
  kind: string;
  label: string;
  where?: string;
  can: { offers: boolean; attachments: boolean; markdown: boolean };
}

export interface NotificationSettings {
  /** A channel kind, or null for the first one there is. */
  defaultChannel: string | null;
  /** kind → a channel kind or `off`; a kind left out takes the default. */
  perKind: Partial<Record<NotificationKind, string>>;
  /** When a focus turns itself on; what quiet hours were is the first. */
  schedules: FocusSchedule[];
  endOfDay: string;
  /** The manual focus, as stored; read only here, switched with `api.setFocus`. */
  focus?: unknown;
  /** Messages from your agents (`owner.notify`); on or off is `perKind.agent`. */
  agents?: AgentMessageSettings;
}

export interface AgentMessageSettings {
  /** The highest urgency an agent may use; `today` holds every message for the end of the day. */
  maxUrgency: 'now' | 'today';
  /** Agent ids whose messages are refused. */
  muted: string[];
}

export type FocusMode = 'normal' | 'urgent-only' | 'do-not-disturb';
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface FocusSchedule {
  mode: Exclude<FocusMode, 'normal'>;
  days: Weekday[];
  from: string;
  to: string;
}

/** The focus in force now, manual or scheduled. */
/** The lock screen's state (GET /api/lock). */
export interface LockState {
  /** A PIN is set: the lock screen is on. */
  pin: boolean;
  locked: boolean;
  lockedAt: string | null;
  /** `owner`: Lock now. `idle`: nobody used it for the delay. `start`: the session began while a PIN was set. */
  reason: 'owner' | 'idle' | 'start' | null;
  /** 1, 5, 15 or 60; null is never. */
  delayMinutes: 1 | 5 | 15 | 60 | null;
  background: LockBackground;
  /** The owner's picture, when there is one. */
  image: string | null;
  /** Its portrait version, drawn on a phone, when there is one. */
  imagePortrait?: string | null;
  /** No try is checked before this moment. */
  waitUntil: string | null;
  /** Wrong tries left before a wait; null while none were wrong. */
  triesLeft: number | null;
  /** The lock screen's clock as chosen (Settings → Lock screen → What it shows). */
  clock?: LockClock;
}

/** The lock screen's clock: the time and date the owner's way unless picked, and a second zone. */
export interface LockClock {
  time: 'profile' | '12h' | '24h';
  date: 'profile' | 'short' | 'long' | 'iso' | 'off';
  zone: { place: string } | { label: string; timezone: string } | null;
}

/** The clock with the Profile applied: null is Auto. */
export interface LockClockView {
  time: '12h' | '24h' | null;
  date: 'short' | 'long' | 'iso' | 'off' | null;
  zone: { label: string; timezone: string } | null;
}

/**
 * Earth (the default) is the photo the dashboard ships; field (Buddi) and the four colours are gradients; image is the
 * owner's picture; `picture:<id>` is one of the pictures in `backgrounds/manifest.json` (shell/backgrounds.ts).
 */
export type LockBackground = 'earth' | 'field' | 'dawn' | 'sea' | 'moss' | 'dusk' | 'image' | `picture:${string}`;

/** What the lock screen draws (GET /api/lock/screen): counts only, and the widgets that are not sensitive. */
export interface LockScreenData extends LockState {
  now: string;
  timezone: string;
  owner: string | null;
  approvals: number;
  /** Everything else that needs the owner, by the same rule as Home's counts and the rail's badge. */
  needs: number;
  focus: FocusState | null;
  widgets: Array<{ key: string; id: string; title: string; size: WidgetSize; view: { state: 'ok' | 'stale'; body: WidgetBody; updatedAt?: string } }>;
  clockView?: LockClockView;
  /** What is running, and the newer one the supervisor has ready: the status bar's answer. */
  version?: { current: string; latest?: string; updateAvailable: boolean };
}

export interface FocusState {
  mode: Exclude<FocusMode, 'normal'>;
  /** ISO; null until turned off. */
  until: string | null;
  startedAt: string | null;
  by: 'dashboard' | 'telegram' | 'schedule';
}

/** `1h`, `3h`, `tomorrow` (the next 08:00), `indefinite`. */
export type FocusDuration = '1h' | '3h' | 'tomorrow' | 'indefinite';

export interface NotificationSettingsView {
  settings: NotificationSettings;
  channels: NotificationChannel[];
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
/** The bot this installation talks through. */
export interface TelegramBot {
  configured: boolean;
  running: boolean;
  /** Without the @; null when there is no token or Telegram did not say. */
  username: string | null;
}
/** One paired phone. */
export interface TelegramDevice {
  id: string;
  name: string | null;
  userId: string;
  pairedAt: string | null;
  lastSeenAt: string | null;
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
  /** The uploaded picture's URL, when there is one; `avatar` stays the fallback. */
  picture?: string;
  skills: Array<{ name: string; provenance: string; file: string }>;
  /** Who it may hand work to. Empty when `asksEveryone` is set. */
  delegates: string[];
  /**
   * Set when it may ask every agent rather than a list: the front desk and the
   * maker by default (`front-desk`, `maker`), or a list that says `"*"`.
   */
  asksEveryone?: 'front-desk' | 'maker' | 'list';
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
  /** The file sets no `maxTurns`: `maxTurns` is the built-in default. Optional: an older server does not send it. */
  maxTurnsIsDefault?: boolean;
  /** The built-in steps-per-reply budget. */
  defaultMaxTurns?: number;
  language: string;
  /** Reasoning before the answer: on, off, or null for the model's default. */
  thinking: 'on' | 'off' | null;
  /** Idle time before a fresh conversation. Optional: an older server does not send it. */
  idleRollover?: IdleRollover;
  /** Where it may look (`browser:` in agent.md). Optional: an older server does not send it. */
  browser?: 'auto' | BrowserRoute;
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
  /** The agents that came from the catalogue, by id, with drift against the kept list. */
  catalogue?: Record<string, AgentCatalogueProvenance>;
}

/** Where an agent from the catalogue stands (`GET /api/agents` → `catalogue`): no catalogue fetch needed. */
export interface AgentCatalogueProvenance {
  source: 'market';
  package: string;
  title: string;
  /** The version written (with `via`, the older agent's own). */
  version: string;
  /** The version the kept list has; null with no copy, or delisted. */
  latest: string | null;
  drift: CatalogueDrift;
  /** No longer in the catalogue: it keeps working, no update will come. */
  delisted: boolean;
  via?: string;
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
  auth: 'api-key' | 'none' | 'chatgpt' | 'anthropic-oauth' | 'device-key'; baseUrl: string;
  defaultModel: string; enabled: boolean; revision: number; configured: boolean;
  /** The owner's context-window override, in tokens, or null for automatic. */
  contextWindowTokens?: number | null;
  /** What the server would assume for `defaultModel`: the field's placeholder. */
  detectedContextWindowTokens?: number;
  /** Whose that number is: the provider's own model list, or buddi's table for the model name. */
  detectedContextWindowSource?: 'provider' | 'table' | 'mlxh';
  refreshable: boolean; tokenExpiresAt: string | null; subscriptionRenewsAt: string | null;
  assignedAgents: string[]; test: AccountTest | null;
  removalPending?: boolean;
  reconnectRequired?: boolean;
  login?: { state: 'pending' | 'connected' | 'failed' | 'cancelled'; verificationUrl?: string; userCode?: string; expiresAt?: string; message?: string; attemptId?: string; deviceName?: string; /** ChatGPT, once connected: the address it signed in with. */ account?: string } | null;
  /** Ollama Cloud with a device key: which device, and which ollama.com account it is connected to. */
  device?: OllamaDevice | null;
  /** A limit its provider set, while it stands: a daily quota used up, or a burst window it named. */
  rateLimit?: AccountRateLimit | null;
}
export interface AccountRateLimit {
  scope: 'day' | 'burst';
  /** When it lifts. */
  until: string;
  /** The quota's size, when the provider said it ("limit: 20"). */
  limit: number | null;
  unit: 'requests' | 'tokens' | null;
  freeTier: boolean;
  /** Who set it, in the owner's words: "Gemini". */
  provider: string | null;
  model: string | null;
}
export interface OllamaDevice { deviceName: string; username: string | null; connectedAt: string | null }
/** One poll of an Ollama connect attempt. */
export type OllamaPoll =
  | { state: 'connected'; username: string; deviceName: string }
  | { state: 'waiting'; expiresAt: string }
  | { state: 'failed'; message: string };
export interface OllamaConnect { state: 'pending'; attemptId: string; verificationUrl: string; deviceName: string; expiresAt: string }
export interface ProviderAccountsView {
  codexEnabled?: boolean;
  anthropicOAuthEnabled?: boolean;
  /** Gemini through Google's OpenAI-compatible endpoint: where it answers, and where a key is made. */
  gemini?: { baseUrl: string; keyUrl: string };
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
  /** One line per granted plugin the owner disabled: "finance is disabled, so its tools are out." */
  disabled?: string[];
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
  /** What the file was handed in with, or the label an agent filed a document under. */
  caption: string | null;
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
  /** How times and dates read; null is Auto. */
  timeFormat?: '12h' | '24h' | null;
  dateFormat?: 'short' | 'long' | 'iso' | null;
  /** For letters, forms and bookings. */
  fullName?: string | null;
  pronouns?: string | null;
  /** Day and month, the year optional. */
  birthday?: DayMonthView | null;
  /** The owner's places, in their order. */
  places?: OwnerPlaceView[];
  /** The zone this host runs in, offered as the default. */
  detectedTimezone: string;
  /** Every zone the host knows, for the picker. */
  zones: string[];
}
/** One of the owner's places (Settings → Profile). */
export interface OwnerPlaceView {
  id: string;
  label: string;
  address: string | null;
  /** What the place finder matched: "Lyon, Auvergne-Rhône-Alpes, France". */
  name: string;
  latitude: number;
  longitude: number;
  timezone: string | null;
}
/** One answer from the place finder. */
export interface FoundPlaceView {
  name: string;
  latitude: number;
  longitude: number;
  timezone?: string;
}
/** A yearly date: a birthday, an anniversary. */
export interface DayMonthView {
  day: number;
  month: number;
  year: number | null;
}

/** One of the owner's people (Settings → Memory → People). */
export interface PersonRow {
  id: string;
  name: string;
  relationship: string | null;
  addressAs: string | null;
  birthday: DayMonthView | null;
  anniversary: DayMonthView | null;
  notes: string | null;
  createdBy: string;
  updatedAt: string | null;
  /** The soonest date, counted in the owner's zone. */
  next: { what: 'birthday' | 'anniversary'; inDays: number; turning: number | null } | null;
  /** Whether its reminder missions are on; null without a date. */
  reminders: boolean | null;
}

export interface PersonPatch {
  id?: string;
  name: string;
  relationship: string | null;
  addressAs: string | null;
  birthday: DayMonthView | null;
  anniversary: DayMonthView | null;
  notes: string | null;
  reminders?: boolean;
}

/** Home on the owner's birthday. */
export interface BirthdayGlanceView {
  today: boolean;
  /** The owner's local date. */
  date: string;
  name: string | null;
  age: number | null;
  note: string | null;
  from: string | null;
  image: string | null;
}

export interface OwnerPatch {
  fullName?: string | null;
  pronouns?: string | null;
  birthday?: DayMonthView | null;
  timeFormat?: '12h' | '24h' | null;
  dateFormat?: 'short' | 'long' | 'iso' | null;
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
  /** A launchd job with no control socket: supervised, with nothing to control from here. */
  supervisor?: 'launchd';
  label?: string;
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
/** One owner API token, as Settings lists it: never the token, only its last four characters. */
export interface ApiTokenView {
  id: string;
  name: string;
  hint: string;
  scope: 'owner';
  createdVia: 'dashboard' | 'cli';
  createdAt: string;
  lastUsedAt: string | null;
}

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

/** "Sign in from elsewhere": a provider's row (specs/trusted-access.md §6.6). */
export type AccessState = 'off' | 'needs-setup' | 'waiting' | 'ready' | 'unanswered';
export interface AccessProviderRow {
  id: 'tailscale' | 'cloudflare-access' | 'withbuddi';
  title: string;
  identity: 'login' | 'device';
  proxy: 'this-machine' | 'elsewhere';
  enabled: boolean;
  status: { state: AccessState; sentence: string };
}
export interface AccessView {
  /** Did this very request come through a provider? Then the whole block is read-only. */
  proxied: boolean;
  providers: AccessProviderRow[];
}
/** Signing in through Cloudflare Access, as its row draws it. */
export interface CloudflareAccessView {
  enabled: boolean;
  teamDomain: string;
  aud: string;
  email: string;
  publicOrigin: string;
  status: { state: AccessState; sentence: string };
  /** Where cloudflared must point: the ingress listener, never the dashboard's port. */
  ingressPort: number;
  listening: boolean;
  lastVisit: { at: string; email: string } | null;
  setup: { steps: Array<{ text: string; command?: string }>; fields: Array<{ key: string; label: string; hint?: string; placeholder?: string }> };
  proxied: boolean;
  /** On Save, what fetching the team's signing keys said. */
  test?: { ok: boolean; keys: number; error?: string };
}
export interface CloudflareAccessChange {
  enabled: boolean;
  teamDomain: string;
  aud: string;
  email: string;
  publicOrigin: string;
}
export interface CloudflareAccessTest {
  ok: boolean;
  keys: number;
  teamDomain: string;
  sentence: string;
  listening: boolean;
  ingressPort: number | null;
}

/** "Set it up for me": one run of the Cloudflare setup, as the checklist draws it. */
export type CloudflareSetupStepId = 'token' | 'tunnel' | 'route' | 'dns' | 'access' | 'save' | 'connector' | 'healthy' | 'test';
export interface CloudflareSetupProgress {
  state: 'idle' | 'running' | 'waiting' | 'done' | 'failed' | 'stopped' | 'removing' | 'removed';
  host: string;
  email: string;
  steps: Array<{ id: CloudflareSetupStepId; state: 'next' | 'now' | 'done' | 'failed'; text: string; why?: string }>;
  /** The one line buddi never runs itself; it holds the tunnel's connector token. Only without a supervisor, or for the system service. */
  install: { command: string; note: string } | null;
  /** The connector buddi's supervisor runs (or Cloudflare's system service it uses). Absent from an older gateway. */
  connector?: CloudflareConnector | null;
  error: string | null;
  url: string | null;
  removed: string[];
  uninstall: string | null;
  /** It stopped at something of buddi's name that buddi didn't make: "Use it anyway" runs again with adopt. */
  adoptable?: boolean;
}
export interface CloudflareConnector {
  state: 'running' | 'starting' | 'stopped' | 'missing-binary' | 'system-daemon';
  mode: 'buddi' | 'system';
  detail?: string;
  /** The Homebrew line, when cloudflared is missing on a Mac with brew. */
  brew?: string;
  /** Cloudflare's system service is installed: the line that removes it, and why. */
  systemDaemon?: { file: string; command: string; why: string };
  log?: string;
}
/** A domain (Cloudflare zone) the setup token can see. */
export interface CloudflareZone { id: string; name: string }

export interface CloudflareSetupView {
  progress: CloudflareSetupProgress;
  tokenStored: boolean;
  record: { host: string; email: string; zone: string; teamDomain: string } | null;
  permissions: string[];
  /** Cloudflare's token page, pre-filled with those permissions. */
  tokenUrl?: string;
  ingressPort: number;
}

export interface VersionView {
  current: string;
  latest?: string;
  /** What changes in `latest`, as its release published it (markdown). */
  latestNotes?: string;
  checkedAt?: string;
  checkEnabled: boolean;
  updateAvailable: boolean;
  /** The last check that did not get an answer. Never fatal, always said. */
  error?: string;
  /** A newer version npm names but does not serve yet: not offered, and the sentence that says so. */
  processing?: { version: string; message: string };
  history: UpgradeAttempt[];
  supervised: boolean;
  /** A developer checkout, which upgrades with git rather than with this page. */
  checkout: boolean;
  /** buddi.app runs this installation: the way back from a failed upgrade is its menu, not a terminal. */
  app?: boolean;
  /** The dashboard build the gateway is serving (`build.json`), to compare with this page's own. */
  web?: string;
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

/** Remove buddi from this Mac: what goes, and the token the next two calls bring back. */
export type UninstallPlan =
  | { available: false; reason: string }
  | { available: true; data: string; keychain?: string; service?: string; app?: string; backups: string; appFinishes: boolean; token: string };

export interface UninstallJob {
  id: string;
  kind: 'uninstall-backup';
  phase: string;
  detail?: string;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  report?: { archive: string; passphraseFile?: string; passphrase?: string };
}

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
    /** `label` says what it is in words; `accountId` names the model account it belongs to. */
    secrets: Array<{
      name: string;
      kind: 'account' | 'telegram' | 'plugin' | 'email' | 'connection';
      label?: string;
      accountId?: string;
      mailboxId?: string;
      connectionId?: string;
      /** An OAuth sign-in: the fix is "Sign in again", not a pasted key. */
      signIn?: boolean;
      settingsRoute: string;
    }>;
    /** `install` is `<npm>@<version>` when the plugin came from a registry. */
    plugins: Array<{
      name: string;
      version: string;
      source: string;
      installed: boolean;
      /** Installed since the gateway started; it loads at the next restart. */
      loadsAtRestart?: boolean;
      install?: string;
      /** Data the restore kept for it; `note` is the sentence to show. */
      waiting?: { rows: number; note: string };
    }>;
    /** Kept tables not loaded because the installed table already had rows. Older gateways omit it. */
    keptTables?: Array<{ schema: string; table: string; rows: number; sentence: string }>;
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

/** Who made a plugin: its manifest's `author`, or its package.json's. */
export interface PluginAuthorView {
  name: string;
  url?: string;
}

export interface InstalledPluginView {
  name: string;
  /** For a folder install, the folder's package.json version now. */
  version: string;
  /** A folder install whose version moved on since: the version it was installed as. */
  installedAs?: string;
  source: PluginSource;
  publisher?: string;
  author?: PluginAuthorView;
  /** Its manifest's own one paragraph, when it wrote one and loaded. */
  description?: string;
  /** The hosts it talks to, from its manifest (and the connections made since). Absent when it did not load. */
  network?: Array<{ host: string; why: string }>;
  /** What it reaches in buddi beyond itself, in the staged card's words. Absent when it did not load. */
  uses?: Array<{ use: string; words: string }>;
  integrity?: string;
  installedAt: string;
  contribution: { tools: number; sentinels: number; views: number; agents: number };
  unlocks: PluginUnlock[];
  loaded: boolean;
  /** Installed or updated since this buddi started: the next restart loads this version. */
  loadsAtRestart?: true;
  /** `false` when the owner disabled it: installed, kept, not loaded. */
  enabled?: false;
  /** Why its entry point did not load. Set only when `loaded` is false. */
  error?: string;
  /** Loaded, but it says it cannot do anything yet: what to do first, and the page where. */
  setup?: { ready: false; note?: string; page?: PluginPageRef };
  /** Held back by what it requires: each need in the row's words. */
  needs?: PluginNeedView[];
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
/** One of a plugin's pages, by id and where it lives. */
export interface PluginPageRef {
  id: string;
  place: 'rail' | 'settings';
}

/** What a plugin lacks of one it requires (docs/plugins.md §2.10). */
export interface PluginNeedView {
  plugin: string;
  range: string;
  /** The range in words: "0.2 or newer". */
  rangeWords?: string;
  state: 'missing' | 'disabled' | 'failed' | 'range' | 'waiting' | 'setup';
  installed?: string;
  note?: string;
  page?: PluginPageRef;
  /** "Needs weather", "Needs setup in weather". */
  words: string;
}

/** A staged package's requirement, with where it stands here. */
export interface PluginRequirementView {
  plugin: string;
  range: string;
  /** The range in words: "0.2 or newer". */
  rangeWords?: string;
  state: 'ok' | PluginNeedView['state'];
  installed?: string;
  words: string;
}

export interface StagedPluginView {
  id: string;
  name: string;
  version: string;
  /** When it was read. Only the newest, read minutes ago, opens as the full card. */
  createdAt?: string;
  /** When the owner first saw its full card or pressed Review. An opened stage is kept a day. */
  openedAt?: string;
  /** When the sweep deletes it if nobody decides: two hours unopened, a day opened. */
  expiresAt?: string;
  source: PluginSource;
  publisher?: string;
  /** From its package.json: the manifest cannot be read before approval. */
  author?: PluginAuthorView;
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
  /**
   * The plugin name it declares (`buddi.name`, or its package name). Absent
   * when it declares none: the manifest's name is read at approval.
   */
  installsAs?: string;
  /** It lists @buddi/core as a dependency; buddi provides its own instead. */
  coreAsDependency?: boolean;
  /** The package's own words about itself, from its buddi.md. Never checked. */
  claims: { schema?: string; hosts: string[]; text: string; missing: boolean };
  /** Lifecycle scripts the package itself declares. */
  scripts: string[];
  /** Set when this stage came from an update: what it would replace. */
  previous?: { name: string; version: string };
  /** Where the installed one came from, when this update takes it from somewhere else. */
  previousSource?: PluginSource;
  /**
   * What it reaches in buddi beyond itself, from its package.json, one plain
   * line each. On an update, `added` marks what the installed version did not
   * declare and `dropped` is what it no longer does. Optional while the
   * gateway that sends it is still landing.
   */
  /** The plugins it needs, each with where it stands here. */
  requires?: PluginRequirementView[];
  uses?: {
    areas: Array<{ use: string; words: string; added: boolean }>;
    dropped: Array<{ use: string; words: string }>;
  };
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
  author?: PluginAuthorView;
  /** What leaves the machine: the hosts it declared, the connected services included. */
  network?: Array<{ host: string; why: string }>;
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

/** The market's categories, in the order Browse draws them. */
export type MarketCategory = 'days' | 'money' | 'home' | 'voice' | 'work' | 'other';

/**
 * One listing from withbuddi.com/plugins/index.json, as the gateway passes it
 * on: the entry as the site wrote it, plus what this installation knows about
 * it (`installed`, `update`, `usesWords`).
 */
/** A listed widget: Browse's Widgets shelf and the previews on a listing. */
export interface MarketWidgetView {
  id: string;
  title: string;
  sizes: WidgetSize[];
  sensitive?: true;
  /** How many settings each placement has. */
  settings: number;
  preview?: Partial<Record<WidgetSize, WidgetBody>>;
}

export interface MarketEntryView {
  name: string;
  npm: string;
  version: string;
  title: string;
  summary: string;
  category: MarketCategory;
  trust: 'by-buddi' | 'reviewed';
  pricing: { kind: 'free' | 'paid' | 'subscription'; vendor?: string; trialDays?: number; note?: string };
  author?: PluginAuthorView;
  page?: string;
  reviewed?: { version: string; on?: string; covered?: string };
  /** A URL under withbuddi.com/plugins/; the page draws `iconSvg` instead of fetching it. */
  icon?: string;
  /** The icon, fetched and sanitised by the gateway to plain shapes: drawn inline in the tile's colour. */
  iconSvg?: string;
  /** URLs under withbuddi.com/plugins/, shown through `api.marketAssetUrl`. */
  screenshots?: string[];
  license?: string;
  claims?: {
    package?: { dependencies?: { count: number; withScripts: string[] } };
    manifest?: {
      network?: Array<{ host: string; why?: string }>;
      tools?: Array<{ name: string; tier?: string }>;
      sentinels?: unknown[];
      agents?: unknown[];
    };
  };
  /** The areas it reaches in buddi, in the staged card's words. */
  usesWords?: Array<{ use: string; words: string }>;
  /** The widgets it brings, checked by the gateway; `preview` is the plugin's sample per size. */
  widgets?: MarketWidgetView[];
  /** Set when it is installed here: the installed version and the name it is installed under. */
  installed?: { version: string; name?: string };
  /** The listed version, when it is newer than the installed one. */
  update?: string;
}

export interface MarketView {
  fetchedAt?: string;
  /** The last copy, answered because withbuddi.com did not answer this time. */
  stale?: boolean;
  plugins: MarketEntryView[];
  /** Why there is no list: withbuddi.com was not reachable and nothing was kept. */
  unavailable?: string;
}

/** One folder on the gateway's machine, for "A directory I built". */
export interface PluginFolderView {
  name: string;
  path: string;
  /** It holds a package.json. */
  plugin: boolean;
}

export interface PluginFoldersView {
  path: string;
  /** One level up; `null` at the home directory, where the list stops. */
  parent: string | null;
  home: string;
  folders: PluginFolderView[];
  truncated?: true;
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
  /** `null` removes the setting: back to three hours. */
  idleRollover?: IdleRollover | null;
  /** Where it may look; `auto` lets the runtime choose. */
  browser?: 'auto' | BrowserRoute;
}

/** How long a chat may sit idle before the next message starts a fresh one. */
export type IdleRollover = '3h' | '1d' | '1w' | 'never';

/* ------------------------------------------------------------------ *
 * Secrets: the owner vault (docs/owner-secrets.md §6), from
 * `packages/gateway/src/web/secrets.ts`. There is no read path for a value:
 * a secret is a name, its bindings and its use record, and the writes are the
 * ownerOnly tools the act route invokes as the owner.
 * ------------------------------------------------------------------ */

/** How a binding runs: strictest first. A binding is never looser than its kind's maxRule. */
export type SecretRule = 'every-time' | 'first-time' | 'pre-approved';

export interface SecretBindingView {
  kind: string;
  /** Plain JSON: an origin, a bundle id or an account id as a string, `{ host, header }`, `{ workspace, variable }` or `{ origin, field }` for the rest. */
  target: unknown;
  rule: SecretRule;
  /** When the owner approved the first use under a `first-time` rule. */
  firstApprovedAt: string | null;
  /** True for an account kind (`<plugin>.account`): the plugin's process holds the value while its connection lives. */
  heldByPlugin: boolean;
}

/** What became of one use, as `core.secret_uses` records it. */
export type SecretUseOutcome = 'delivered' | 'held' | 'pending' | 'refused' | 'failed';

export interface SecretUseRow {
  at: string;
  secret: string;
  kind: string;
  target: unknown;
  plugin: string | null;
  agent: string | null;
  outcome: SecretUseOutcome;
  detail: string | null;
}

/** A row elsewhere in buddi whose credential this secret is (`packages/gateway/src/web/secrets.ts`). */
export type SecretUserView =
  /** `loginFailedAt`: the mail server turned the password down then, until a login works again. */
  | { kind: 'mailbox'; id: string; address: string; provider: string; auth: 'app-password' | 'xoauth2'; loginFailedAt: string | null }
  | { kind: 'model-account'; id: string; label: string; auth: string }
  | { kind: 'connection'; id: string; name: string; variable: string | null };

/** One secret on the page, display-ready; never a value. */
export interface SecretListingView {
  name: string;
  totp: boolean;
  bindings: SecretBindingView[];
  /** `detail`: the sentence the use was recorded with — a refusal's reason, a failed delivery's error. */
  lastUse: { at: string; kind: string; target: unknown; agentId: string | null; outcome: SecretUseOutcome; detail?: string | null } | null;
  /** Whether the vault holds a value for it; null when the vault cannot say. */
  hasValue?: boolean | null;
  /** What holds it: the mailbox, model account or connection whose credential it is. */
  usedBy?: SecretUserView[];
  /** Nothing can reach it any more: a suggestion to remove it, never a removal. */
  unused?: boolean;
  /** Whether anything holds it could not be checked (a lookup failed): never offered for removal. */
  usageUnknown?: boolean;
  /** A login buddi kept from the owner's own sign-in: the site, the user name (not a secret) and when. */
  login?: { site: string; username: string; savedAt: string };
}

/** A sign-in the owner just made on a page they hold, waiting for Save, Not now or Never. Never the password. */
export interface LoginSeen { id: string; site: string; username: string; /** A login kept for this site and user name already: Save replaces its value. */ update?: boolean }
export type LoginDecision = 'save' | 'later' | 'never';
export interface LoginAnswer { outcome: 'saved' | 'dismissed' | 'never' | 'gone'; saved?: { name: string; site: string; username: string; savedAt: string } }

export interface SecretsView {
  secrets: SecretListingView[];
  /** The destination kinds the installed plugins register, with the loosest rule each allows. */
  destinations: Array<{ kind: string; plugin: string; maxRule: SecretRule }>;
  /** buddi's own keys, by name: read-only here, scrubbed like everything else. */
  ownKeys: string[];
}

export type SecretWriteTool = 'secrets.put' | 'secrets.rename' | 'secrets.rebind' | 'secrets.delete' | 'secrets.scrub_history';

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
  /** Take the carried-over note out of a conversation, page and context both. */
  deleteCarryOver: (id: string) => del<null>(`/chat/conversations/${encodeURIComponent(id)}/carry-over`),
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
  /** Talking to buddi: the uploaded recording heard, through the speech plugin as the owner. */
  transcribe: (body: { artifactId: string; conversationId?: string }) =>
    post<{ text: string; language?: string }>('/speech/transcribe', body),
  /** A reply spoken; the page fetches `audioUrl` and plays it. */
  say: (body: { text: string; conversationId?: string }) =>
    post<{ artifactId: string; audioUrl: string; mime: string }>('/speech/say', body),
  /** A file taken back out of the tray before it was sent. Refused if a message carries it. */
  discardAttachment: (artifactId: string) => del<null>(`/artifacts/${encodeURIComponent(artifactId)}`),
  /* ---- groups ---- */
  groups: () => get<{ groups: GroupView[] }>('/groups'),
  group: (id: string) => get<GroupView & { latestConversationId: string | null; openRequest: { id: string; state: string; awaitingAgentId: string | null; budgetReserved: number; budgetTotal: number } | null; history?: { conversations: number; messages: number } }>(`/groups/${encodeURIComponent(id)}`),
  createGroup: (body: { name: string; coordinator: string; members: string[] }) => post<GroupView>('/groups', body),
  updateGroup: (id: string, body: { name?: string; coordinator?: string; members?: string[] }) =>
    patch<GroupView>(`/groups/${encodeURIComponent(id)}`, body),
  /** Deleted softly: gone from every list now, back with `restoreGroup` until `undoUntil`, then for good. */
  deleteGroup: (id: string) => del<{ undoUntil: string }>(`/groups/${encodeURIComponent(id)}`),
  restoreGroup: (id: string) => post<GroupView>(`/groups/${encodeURIComponent(id)}/restore`),
  /** Its conversations go; the group, its members and its memory stay. */
  clearGroup: (id: string) => post<{ conversations: number }>(`/groups/${encodeURIComponent(id)}/clear`),
  groupConversations: (id: string) => get<{ conversations: ConversationListItem[] }>(`/groups/${encodeURIComponent(id)}/conversations`),
  startGroupConversation: (id: string) => post<{ conversationId: string }>(`/groups/${encodeURIComponent(id)}/conversations`),
  sendToGroup: (id: string, body: { conversationId?: string; text: string; attachmentIds?: string[] }) =>
    post<{ conversationId: string; runId: string; requestId: string; rolledOver?: boolean }>(`/groups/${encodeURIComponent(id)}/messages`, body),
  /** The SSE endpoint for one conversation's run. */
  streamUrl: (conversationId: string) =>
    `/api/chat/conversations/${encodeURIComponent(conversationId)}/stream`,
};

/** What a connection test answers. */
/**
 * One connection test: the ready prompt's answer as one sentence. On a
 * failure the sentence says what to do; the HTTP code, the retry time and the
 * provider's own words (scrubbed of the key) are for Details only.
 */
export type AccountTest = {
  state: string; message: string; checkedAt: string; httpStatus?: number | null; retryAt?: string | null;
  model?: string; reply?: string; elapsedMs?: number; tokens?: number; billing?: 'key' | 'plan' | null; detail?: string | null;
};
export type ConnectionVerdict = Omit<AccountTest, 'checkedAt'> & { checkedAt?: string };

/**
 * Whether a connection test says the key itself was refused (401/403).
 * A limit or an outage is not a refusal: the key may be fine and the model wrong.
 */
export function keyRefused(verdict: ConnectionVerdict): boolean {
  return verdict.httpStatus === 401 || verdict.httpStatus === 403 || verdict.state === 'authentication-error' || verdict.state === 'access-denied';
}

export const api = {
  providers: () => get<ProvidersView>('/providers'),
  providerAccounts: () => get<ProviderAccountsView>('/provider-accounts'),
  probeModels: (body: { kind: 'anthropic' | 'openai' | 'openai-compatible'; auth: 'api-key' | 'none'; baseUrl?: string; secret?: string }) =>
    post<{ models: Array<{ id: string; name: string; isDefault: boolean; thinks?: boolean }>; truncated: boolean }>('/provider-accounts/probe-models', body),
  accountModels: (id: string, refresh = false) => post<{ models: Array<{ id: string; name: string; isDefault: boolean; thinks?: boolean; image?: boolean }>; truncated: boolean; source?: 'provider' | 'built-in'; fetchedAt?: string }>(`/provider-accounts/${encodeURIComponent(id)}/models`, { refresh }),
  saveProviderAccount: (body: SaveProviderAccount) => post<{ id: string; warning?: string }>('/provider-accounts/save', body),
  testProviderAccount: (id: string) => post<ConnectionVerdict>(`/provider-accounts/${encodeURIComponent(id)}/test`),
  removeProviderAccount: (id: string, revision: number) => post(`/provider-accounts/${encodeURIComponent(id)}/remove`, { revision }),
  codexAccountAction: (id: string, action: 'login' | 'cancel-login' | 'logout', revision: number) => post(`/provider-accounts/${encodeURIComponent(id)}/${action}`, { revision }),
  /** Ollama Cloud with a device key: start a connection, ask once whether it went through, or remove the key. */
  ollamaConnect: (id: string, revision: number) => post<OllamaConnect>(`/provider-accounts/${encodeURIComponent(id)}/ollama/connect`, { revision }),
  ollamaPoll: (id: string, attemptId: string) => post<OllamaPoll>(`/provider-accounts/${encodeURIComponent(id)}/ollama/poll`, { attemptId }),
  ollamaDisconnect: (id: string, revision: number) => post<{ removed: true; unpaired: boolean; note: string }>(`/provider-accounts/${encodeURIComponent(id)}/ollama/disconnect`, { revision }),
  anthropicAccountAction: (id: string, action: 'login' | 'complete-login' | 'cancel-login' | 'logout', revision: number, input?: { attemptId: string; code: string }) => post(`/provider-accounts/${encodeURIComponent(id)}/anthropic/${action}`, { revision, ...input }),
  assignProviderAccount: (agent: string, accountId: string, model: string) => post<{ changed: string[]; note: string }>(`/agents/${encodeURIComponent(agent)}/account`, { accountId, model }),
  configureProvider: (kind: string, body: { credentialKind: string; defaultModel: string }) => post<ProvidersView>(`/providers/${encodeURIComponent(kind)}/settings`, body),
  saveCredential: (name: string, value: string) => post<ProvidersView>(`/providers/credentials/${encodeURIComponent(name)}/save`, { value }),
  removeCredential: (name: string) => post<ProvidersView>(`/providers/credentials/${encodeURIComponent(name)}/remove`),
  testProvider: (kind: string) => post<{ state: string; message: string }>(`/providers/${encodeURIComponent(kind)}/test`),
  browser: (scope?: { agentId: string; conversationId: string }) => get<BrowserStatus>(`/browser${scope ? `?agentId=${encodeURIComponent(scope.agentId)}&conversationId=${encodeURIComponent(scope.conversationId)}` : ''}`),
  browserControl: (action: 'stop' | 'takeover' | 'resume' | 'release', sessionId?: string, options?: { forever?: boolean }) => post<BrowserStatus>(`/browser/${action}`, { ...(sessionId === undefined ? {} : { sessionId }), ...(options?.forever ? { forever: true } : {}) }),
  /** `forgetSignInSite` removes one site from the owner's list and the learned one alike. */
  browserSettings: (settings: Partial<ControlSettings> & { forgetSignInSite?: string }) => post<BrowserStatus>('/browser/settings', settings),
  browserPin: (conversationId: string, route: 'auto' | BrowserRoute) => post<BrowserStatus>('/browser/pin', { conversationId, route }),
  /** "Save this login?" answered: the question's id and the owner's word. The password never leaves the host. */
  browserLogin: (id: string, decision: LoginDecision) => post<LoginAnswer>('/browser/login', { id, decision }),
  browserCard: (conversationId: string, answer: string) => post<{ answered?: string; status: BrowserStatus }>('/browser/card', { conversationId, answer }),
  browserInstall: () => post<BrowserStatus>('/browser/install', {}),
  /** Launch the agents' browser once and close it: does it start here? */
  browserCheck: () => post<BrowserLaunchCheck>('/browser/check', {}),
  /** The agents' downloads area: what it holds and its caps. */
  browserDownloads: () => get<BrowserDownloads>('/browser/downloads'),
  /** Empty the agents' downloads area; the copies in Files stay. */
  clearBrowserDownloads: () => post<BrowserDownloads>('/browser/downloads/clear', {}),
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
  session: () => get<{ csrf: string; timezone: string; timeFormat?: '12h' | '24h' | null; dateFormat?: 'short' | 'long' | 'iso' | null; host: string; port: number; platform?: string; version?: string; signedInThrough?: 'ticket' | 'local' | 'tailscale' | 'cloudflare-access' | 'withbuddi'; provider?: string; providerSubject?: string; tailscaleName?: string; tailscaleLogin?: string }>('/session'),
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
  /** Agents a plugin offers on Home while nobody has them (`SuggestedAgent.offer`). */
  agentOffers: () => get<{ offers: AgentOfferRow[] }>('/agent-offers'),
  /** The starter team and the plugin agents, as "Add a teammate" draws them. */
  /* ---- the agent catalogue ---- */
  /** The listed agents with where each stands here; `refresh` asks withbuddi.com again past the day-old copy. */
  catalogue: (refresh = false) => get<CatalogueView>(`/catalogue${refresh ? '?refresh=1' : ''}`),
  cataloguePlan: (name: string, body: { fills?: Record<string, string>; handle?: string; missionsOn?: string[] } = {}) =>
    post<CataloguePlan>(`/catalogue/${encodeURIComponent(name)}/plan`, body),
  /** The owner's click on Add is the approval; answers the job at once. */
  catalogueInstall: (name: string, body: { version: string; fills?: Record<string, string>; handle?: string; missionsOn?: string[]; plan?: string; tools?: string[] }) =>
    post<{ jobId: string }>(`/catalogue/${encodeURIComponent(name)}/install`, body),
  catalogueJob: (id: string) => get<CatalogueJob>(`/catalogue/jobs/${encodeURIComponent(id)}`),
  /** The owner's answer to a job stopped at `confirm`. */
  catalogueConfirm: (id: string, approve: boolean) => post<CatalogueJob>(`/catalogue/jobs/${encodeURIComponent(id)}/confirm`, { approve }),
  catalogueUpdatePlan: (name: string, agentId: string) => post<CatalogueUpdatePlan>(`/catalogue/${encodeURIComponent(name)}/update/plan`, { agentId }),
  /** Update, or with `replace` "Replace my changes": the click is the approval. Refused (409) for an edited file without `replace`. */
  catalogueUpdate: (name: string, agentId: string, plan: string, replace = false) =>
    post<{ approvalId: string | null; result: unknown }>(`/catalogue/${encodeURIComponent(name)}/update`, { agentId, plan, ...(replace ? { replace: true } : {}) }),
  agentRemovePreview: (id: string) => get<AgentRemovePreview>(`/agents/${encodeURIComponent(id)}/remove`),
  /** Remove from team: the click is the approval; its folder goes to the trash. */
  removeAgent: (id: string) => post<{ approvalId: string | null; result: unknown }>(`/agents/${encodeURIComponent(id)}/remove`),
  /** Home stops offering this one. It stays on the Plugins page. */
  dismissAgentOffer: (plugin: string, agent: string) =>
    post<{ dismissed: boolean }>(`/agent-offers/${encodeURIComponent(plugin)}/${encodeURIComponent(agent)}/dismiss`, {}),
  /** Open proposals, and under `closed` what was kept, discarded or expired this week. */
  proposals: () =>
    get<{
      open: ProposalRow[];
      closed: ProposalRow[];
      digest?: { latest: DigestRow | null; schedule: DigestSchedule };
    }>('/proposals'),
  /** Move the weekly digest to another day and hour, in the installation's zone. */
  setDigestSchedule: (day: number, hour: number) =>
    post<{ schedule: DigestSchedule }>('/proposals/digest-schedule', { day, hour }),
  /** Keep one, optionally with the owner's corrected text. */
  keepProposal: (id: string, text?: string) =>
    post<{ proposal: ProposalRow; applied: boolean; note: string }>(
      `/proposals/${encodeURIComponent(id)}/keep`,
      text === undefined ? {} : { text },
    ),
  /** Keep several open rule cards in one action ("Keep all"). */
  keepAllProposals: (ids: string[]) =>
    post<{ kept: number; failed: number; skipped: number; note: string }>('/proposals/keep-all', { ids }),
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
  /** Hide one Home glance, or show it again. */
  /** The widgets: what is offered, both surfaces' placements, each placement of `surface` now. */
  widgets: (surface: WidgetSurface = 'home') => get<WidgetsAnswer>('/widgets', { ...(surface === 'lock' ? { surface } : {}), ...hourCycle() }),
  /** Keep one surface's placements; answers as `widgets(surface)`. */
  saveWidgets: (surface: WidgetSurface, placements: Array<Omit<WidgetPlacement, 'key' | 'label'> & { key?: string }>) =>
    put<WidgetsAnswer>(`/widgets/${surface}`, { placements: placements.map(({ key, widget, size, settings }) => ({ ...(key ? { key } : {}), widget, size, settings })) }),
  /** A widget's fields with their choices read now: the settings sheet. */
  widgetSettings: (widget: string) => get<WidgetSettingsSheet>(`/widgets/settings/${encodeURIComponent(widget)}`),
  /** The body unsaved settings give: the sheet's live preview. */
  previewWidget: (placement: { widget: string; size: WidgetSize; settings: Record<string, unknown> }) =>
    post<{ view: WidgetView; label: string }>('/widgets/preview', { ...placement, ...hourCycle() }),
  refreshWidget: (key: string, surface: WidgetSurface = 'home') =>
    post<WidgetsAnswer>(`/widgets/${encodeURIComponent(key)}/refresh${surface === 'lock' ? '?surface=lock' : ''}`),
  /** Close one thing on Home until it changes (`token` is the version closed), or show it again (null). */
  homeDismiss: (slot: string, token: string | null) =>
    post<{ dismissed: Record<string, string> }>('/home/dismiss', { slot, token }),
  setGlanceHidden: (id: string, hidden: boolean) =>
    post<{ id: string; hidden: boolean }>(`/home/glances/${encodeURIComponent(id)}/hidden`, { hidden }),
  /** The plugin rail pages the owner hid, as `<plugin>:<page>`. */
  rail: () => get<{ hidden: string[] }>('/rail'),
  /** Hide one plugin rail page from the rail, or show it again. */
  setRailHidden: (plugin: string, page: string, hidden: boolean) =>
    post<{ plugin: string; page: string; hidden: boolean }>(
      `/rail/pages/${encodeURIComponent(plugin)}/${encodeURIComponent(page)}/hidden`,
      { hidden },
    ),
  /** Snooze alerts ("Not now": `days`; "Not needed": none), or wake them (Clear all's Undo). */
  snoozeAlerts: (keys: string[], snoozed: boolean, days?: number) =>
    post<{ keys: string[] }>('/alerts/snooze', { keys, snoozed, ...(days !== undefined ? { days } : {}) }),
  /** "Stop telling me this": the alert's subject, or its whole kind. */
  muteAlert: (key: string, scope: 'subject' | 'kind') => post<{ id: string; label: string }>('/alerts/mute', { key, scope }),
  unmuteAlert: (id: string) => post<{ removed: true }>(`/alerts/mutes/${encodeURIComponent(id)}/remove`, {}),
  /** Run what alerts declared: a run, or a fill with the typed value. */
  actOnAlerts: (entries: Array<{ key: string; action: number; value?: string | number }>) =>
    post<{ results: Array<{ key: string; result?: unknown; approvalId?: string; error?: string }> }>('/alerts/act', { entries }),
  /** Ask the agent that answers for these alerts; answers the conversation it started. */
  askAboutAlerts: (keys: string[]) => post<{ agentId: string; conversationId: string; runId: string }>('/alerts/ask', { keys }),
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
  onboardingStep: (step: string, learned: { conversationId?: string; accountId?: string; reach?: OnboardingReach } = {}) =>
    post<OnboardingView>('/onboarding/step', { step, ...learned }),
  /** Chapter 3: record the outcomes and start their installs in the background. */
  takeOn: (tiles: string[]) => post<{ jobs: Array<{ plugin: string; jobId: string }> }>('/onboarding/take-on', { tiles }),
  takeOnProgress: () => get<TakeOnView>('/onboarding/take-on'),
  completeOnboarding: () => post<OnboardingView>('/onboarding/complete'),
  skipOnboarding: () => post<OnboardingView>('/onboarding/skip'),
  /** `instructions` is the persona, written as the file's body; an empty `description` takes its first sentence. */
  createFirstAgent: (body: { name: string; handle: string; description: string; instructions?: string; avatar?: string; accountId?: string }) =>
    post<CreatedAgent>('/onboarding/agent', body),
  /**
   * Is Ollama running on the machine buddi runs on?
   *
   * Asked of the gateway, never of `localhost:11434` from here: this page
   * reaches no host but its own, and the answer is about that machine anyway.
   */
  ollama: () => get<OllamaProbe>('/onboarding/ollama'),
  /** Fetch a model into the local Ollama; progress through `ollamaPullState`. */
  ollamaPull: (model: string) => post<{ pull: OllamaPull }>('/onboarding/ollama/pull', { model }),
  ollamaPullState: () => get<{ pull: OllamaPull | null }>('/onboarding/ollama/pull'),
  /** Is mlxh running on the machine buddi runs on? Asked of the gateway, as Ollama is. */
  mlxh: () => get<MlxhProbe>('/onboarding/mlxh'),
  /**
   * Change the assistant after it exists — its name, face or purpose.
   *
   * A separate route because writing the *first* agent is refused once there
   * is one, and "change either, or keep them" has to keep working.
   */
  /** The assistant's persona as the wizard's purpose field shows it; 404 before there is one. */
  firstAgentPersona: () => get<{ id: string; persona: string; generated: boolean }>('/onboarding/agent'),
  updateFirstAgent: (body: { name?: string; description?: string; instructions?: string; avatar?: string }) =>
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
  /* ---- …and from Settings → Notifications ---- */
  telegramBot: () => get<TelegramBot>('/telegram/bot'),
  telegramDevices: () => get<{ devices: TelegramDevice[] }>('/telegram/devices'),
  unpairTelegramDevice: (id: string) => del<null>(`/telegram/devices/${encodeURIComponent(id)}`),
  /* ---- notifications, and whether the owner is here ---- */
  notifications: (limit = 20) => get<{ notifications: NotificationRow[] }>('/notifications', { limit }),
  /** The open messages that ask the owner for something: Home's Needs you. */
  notificationsNeedingYou: () => get<{ notifications: NotificationRow[] }>('/notifications', { needs: 1 }),
  notificationSeen: (id: string) => post<{ ok: true }>(`/notifications/${encodeURIComponent(id)}/seen`),
  notificationSettings: () => get<NotificationSettingsView>('/notifications/settings'),
  saveNotificationSettings: (settings: NotificationSettings) => put<NotificationSettingsView>('/notifications/settings', settings),
  focus: () => get<{ focus: FocusState | null }>('/notifications/focus'),
  /** The lock screen (docs/dashboard.md, "Lock screen"). */
  lockState: () => get<LockState>('/lock'),
  lockScreen: () => get<LockScreenData>('/lock/screen', hourCycle()),
  lockNow: (reason: 'owner' | 'idle' = 'owner', idleForMs?: number) =>
    post<LockState>('/lock', { reason, ...(reason === 'idle' && idleForMs !== undefined ? { idleForMs: Math.max(0, Math.round(idleForMs)) } : {}) }),
  unlock: (pin: string) => post<LockState>('/lock/unlock', { pin }),
  lockActivity: () => post<null>('/lock/activity'),
  setPin: (pin: string, current?: string) => put<LockState>('/lock/pin', current === undefined ? { pin } : { pin, current }),
  removePin: (current: string) => post<LockState>('/lock/pin/remove', { current }),
  setLockSettings: (settings: { delayMinutes?: LockState['delayMinutes']; background?: LockBackground; clock?: LockClock }) => put<LockState>('/lock/settings', settings),
  uploadLockBackground: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return upload<LockState>('/lock/background', form);
  },
  removeLockBackground: () => del<LockState>('/lock/background'),
  uploadLockPortrait: (file: File) => {
    const form = new FormData();
    form.append('file', file);
    return upload<LockState>('/lock/background/portrait', form);
  },
  removeLockPortrait: () => del<LockState>('/lock/background/portrait'),
  setFocus: (mode: FocusMode, duration?: FocusDuration) =>
    put<{ focus: FocusState | null }>('/notifications/focus', duration ? { mode, duration } : { mode }).then(statusChanged),
  testChannel: (channel: string) => post<{ ok: true }>('/notifications/test', { channel }),
  setAgentMuted: (agentId: string, muted: boolean) =>
    post<{ agents: AgentMessageSettings }>('/notifications/agent-mute', { agentId, muted }),
  /* ---- tips, behind Home's lightbulb (docs/dashboard.md, Home) ---- */
  /** Today's tip, or null: at most one a day. */
  currentTip: (preview?: string) => get<{ tip: TipView | null; preview?: boolean }>(preview ? `/tips/current?preview=${encodeURIComponent(preview)}` : '/tips/current'),
  /**
   * The bulb's stack: today's tip first, then every other one that holds and
   * is not dismissed (ready ones before those in their cooldown); `dismissed`
   * counts the dismissed ones that hold. `peek` keeps today's and the ready
   * ones only and marks nothing shown (for the bulb's dot, before the stack is opened).
   */
  tipQueue: (preview?: string, peek?: boolean) => get<{ tips: TipView[]; dismissed?: number; preview?: boolean }>(
    preview ? `/tips/queue?preview=${encodeURIComponent(preview)}` : peek ? '/tips/queue?peek=1' : '/tips/queue',
  ),
  /** Every tip and where it stands; reads only. */
  tips: () => get<{ tips: TipListRow[] }>('/tips'),
  /** The dismissed tips the queue counts, for the empty stack's "Bring back" list; reads only. */
  dismissedTips: () => get<{ tips: Array<TipView & { dismissedAt?: string }> }>('/tips/dismissed'),
  /** "Bring back": forget a dismissal. */
  restoreTip: (id: string) => post<{ ok: true }>(`/tips/${encodeURIComponent(id)}/restore`),
  /** "Not this again": the tip never comes back. */
  dismissTip: (id: string) => post<{ ok: true }>(`/tips/${encodeURIComponent(id)}/dismiss`),
  /** ×: not now; it may come back after its cooldown. */
  laterTip: (id: string) => post<{ ok: true }>(`/tips/${encodeURIComponent(id)}/later`),
  /** The dashboard opened a page; the gateway keeps one mark a day per page. */
  tipsSeenPage: (page: string) => post<{ ok: true }>('/tips/seen-page', { page }),
  /** `active` while the page is in front, `away` when it leaves (docs/notifications.md). */
  presence: (state: 'active' | 'away') => post<{ ok: true }>('/presence', { state }),
  /* ---- the owner ---- */
  owner: () => get<OwnerView>('/owner'),
  setOwner: (patch: OwnerPatch) => post<OwnerView>('/owner', patch),
  findPlace: (address: string) => post<{ found: FoundPlaceView[] }>('/owner/places/find', { address }),
  savePlace: (place: Omit<OwnerPlaceView, 'id' | 'timezone'> & { id?: string; timezone: string | null }) =>
    post<{ place: OwnerPlaceView; places: OwnerPlaceView[] }>('/owner/places', place),
  removePlace: (id: string) => post<{ places: OwnerPlaceView[] }>('/owner/places/remove', { id }),
  /* ---- memory ---- */
  /** Everything, or — with an agent id — what that agent sees: shared plus its own. */
  memory: (agentId?: string) => get<MemoryView>(agentId ? `/memory?agent=${encodeURIComponent(agentId)}` : '/memory'),
  setPreference: (body: { key: string; value: string; scope: string }) => post<MemoryPreference>('/memory/preferences', body),
  forgetPreference: (body: { key: string; scope: string }) => post<null>('/memory/preferences/forget', body),
  updateNote: (id: string, change: { content?: string; scope?: string; kind?: string }) => post<MemoryNote>(`/memory/notes/${encodeURIComponent(id)}`, change),
  forgetNote: (id: string) => post<null>(`/memory/notes/${encodeURIComponent(id)}/forget`),
  people: () => get<{ people: PersonRow[]; today: string }>('/memory/people'),
  savePerson: (person: PersonPatch) => post<{ person: PersonRow; people: PersonRow[] }>('/memory/people', person),
  forgetPerson: (id: string) => post<{ people: PersonRow[] }>(`/memory/people/${encodeURIComponent(id)}/forget`),
  restorePerson: (id: string) => post<{ people: PersonRow[] }>(`/memory/people/${encodeURIComponent(id)}/restore`),
  birthday: () => get<BirthdayGlanceView>('/owner/birthday'),
  /** A new agent's first-open strip: whether it is due, and both directions of delegation. */
  agentIntro: (id: string) => get<AgentIntro>(`/agents/${encodeURIComponent(id)}/intro`),
  /** Close that strip for good. */
  dismissAgentIntro: (id: string) => post<{ ok: true }>(`/agents/${encodeURIComponent(id)}/intro/dismiss`),
  setDelegates: (id: string, delegates: string[]) => post<{ delegates: string[]; asksEveryone?: 'front-desk' | 'maker' | 'list' }>(`/agents/${encodeURIComponent(id)}/delegates`, { delegates }),
  agentProfile: (id: string) => get<AgentProfile>(`/agents/${encodeURIComponent(id)}/profile`),
  /** Every skill the agent loads; learned ones with their version and provenance. */
  agentSkills: (id: string) =>
    get<{ agent: string; writable: boolean; skills: AgentSkillRow[] }>(`/agents/${encodeURIComponent(id)}/skills`),
  /** Remove a learned skill: its current file goes, its versions stay. */
  removeSkill: (id: string, name: string) =>
    post<{ ok: true; name: string; version: number; proposal: string }>(
      `/agents/${encodeURIComponent(id)}/skills/${encodeURIComponent(name)}/remove`,
      {},
    ),

  host: (agentId?: string, conversationId?: string) => get<HostState>('/host', { agentId, conversationId }),
  /* ---- Connections: remote MCP servers (docs/connections.md) ---- */
  connections: () => get<ConnectionsView>('/connections'),
  connection: (id: string) => get<ConnectionView>(`/connections/${id}`),
  addConnection: (url: string, name?: string) =>
    post<{ connection: ConnectionView; signIn: 'none' | 'dynamic' | 'manual' }>('/connections', { url, ...(name ? { name } : {}) }),
  /** A program on this computer: recorded, not started; the review starts it. */
  addProgram: (form: ProgramForm) =>
    post<{ connection: ConnectionView; signIn: 'none' }>('/connections', { transport: 'stdio', ...form }),
  updateProgram: (id: string, form: ProgramForm) => post<ConnectionView>(`/connections/${id}/program`, form),
  connectionConsent: (id: string, clientId?: string) =>
    post<{ authorizeUrl: string; redirectUri: string }>(`/connections/${id}/consent`, clientId ? { clientId } : {}),
  /** Sign in with a pasted token: the gateway tries it on the server before it keeps it. */
  connectionToken: (id: string, input: { token: string; header: string; prefix: string }) =>
    post<{ id: string; reconnected: boolean; name: string; connection: ConnectionView }>(`/connections/${id}/token`, input),
  /** Ask for a device code; the connection's `device` says when it is approved. */
  connectionDevice: (id: string) =>
    post<{ userCode: string; verificationUri: string; expiresAt: string; interval: number; connection: ConnectionView }>(`/connections/${id}/device`, {}),
  connectionCallback: (input: { state: string; code?: string; error?: string }) =>
    post<{ id: string; reconnected: boolean; name: string; cli?: boolean }>('/connections/callback', input),
  connectionReview: (id: string) => get<ConnectionReview>(`/connections/${id}/review`),
  saveConnectionReview: (id: string, input: { slug?: string; hash: string }) => post<ConnectionView>(`/connections/${id}/review`, input),
  grantConnection: (id: string, agents: string[], exact = false) =>
    post<{ granted: string[]; failed: Array<{ agent: string; message: string }>; connection: ConnectionView }>(`/connections/${id}/grant`, exact ? { agents, exact: true } : { agents }),
  /** One agent's switch: give it the connection or take it away, touching only that agent's file. */
  setConnectionHolder: (id: string, agentId: string, held: boolean) =>
    post<{ agent: string; held: boolean; connection: ConnectionView }>(`/connections/${id}/holders/${encodeURIComponent(agentId)}`, { held }),
  disconnect: (id: string) => del<{ id: string; name: string; touched: string[] }>(`/connections/${id}`),
  /** The connections that need the owner, a sentence each: Home's line and the Settings dot. */
  connectionSignals: () => get<{ signals: ConnectionSignal[] }>('/connections/signals'),
  /** A connection's registered tools, and which gated ones may have their approval remembered. */
  connectionTools: (id: string) => get<{ connection: string | null; tools: ConnectionToolView[] }>(`/connections/${id}/tools`),
  /** An agent's gated connection tools, remembered or not. */
  rememberedApprovals: (agentId: string) => get<{ agent: string; tools: RememberedApproval[] }>(`/connections/remembered/${encodeURIComponent(agentId)}`),
  setRememberedApproval: (agent: string, tool: string, remember: boolean) =>
    post<{ agent: string; tool: string; remembered: boolean }>('/connections/remembered', { agent, tool, remember }),
  /* ---- secrets: the owner vault (docs/owner-secrets.md §6) ---- */
  /** The page's one read: the secrets, the destinations the plugins register, buddi's own keys. */
  secrets: () => get<SecretsView>('/secrets'),
  /** The use log, newest first — one secret's when a name is given. */
  secretUses: (name?: string, limit?: number) => get<{ uses: SecretUseRow[] }>('/secrets/uses', { name, limit }),
  /**
   * One owner write: the ownerOnly tool `tool` invoked as the owner with
   * `args`. The answer is the tool's own output; a refusal is a 4xx whose body
   * carries the error, which `post` turns into an ApiError.
   */
  secretsAct: (tool: SecretWriteTool, args: Record<string, unknown>) => post<{ result: unknown }>('/secrets/act', { tool, args }),
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
  setPaused: (paused: boolean) => post<{ paused: boolean }>('/pause', { paused }).then(statusChanged),
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
  tailscale: () => get<TailscaleView>('/access/tailscale'),
  setTailscale: (change: { enabled: boolean; login: string }) => put<TailscaleView>('/access/tailscale', change),
  /* ---- signing in from elsewhere ---- */
  access: () => get<AccessView>('/access'),
  cloudflareAccess: () => get<CloudflareAccessView>('/access/cloudflare-access'),
  setCloudflareAccess: (change: CloudflareAccessChange) => put<CloudflareAccessView>('/access/cloudflare-access', change),
  testCloudflareAccess: (change: { teamDomain: string }) => post<CloudflareAccessTest>('/access/cloudflare-access/test', change),
  cloudflareSetup: () => get<CloudflareSetupView>('/access/cloudflare-access/setup'),
  cloudflareZones: (input: { token?: string } = {}) => post<{ zones: CloudflareZone[] }>('/access/cloudflare-access/zones', input),
  startCloudflareSetup: (input: { token?: string; host: string; email: string; zone?: string; adopt?: boolean; useSystemDaemon?: boolean }) => post<CloudflareSetupView>('/access/cloudflare-access/setup', input),
  stopCloudflareSetup: () => post<CloudflareSetupView>('/access/cloudflare-access/setup/stop'),
  removeCloudflareSetup: (input: { token?: string } = {}) => post<CloudflareSetupView>('/access/cloudflare-access/setup/remove', input),
  /** Forget the kept Cloudflare API token (the owner secret); it stays valid in Cloudflare. */
  forgetCloudflareToken: () => post<CloudflareSetupView>('/access/cloudflare-access/setup/forget-token'),
  /* ---- owner API tokens (docs/api.md, "Authentication") ---- */
  apiTokens: () => get<{ tokens: ApiTokenView[] }>('/api-tokens'),
  /** The answer's `token` is the only time the token itself exists outside the program that will use it. */
  createApiToken: (name: string) => post<{ token: string; apiToken: ApiTokenView }>('/api-tokens', { name }),
  revokeApiToken: (id: string) => del<unknown>(`/api-tokens/${encodeURIComponent(id)}`),
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
  /** The passphrase behind the lock-screen PIN (none needed when no PIN is set). */
  revealBackupPassphrase: (pin?: string) => post<{ passphrase: string }>('/backups/passphrase/reveal', pin === undefined ? {} : { pin }),
  /* ---- buddi.app's command line tool ---- */
  cliTool: () => get<{ available: boolean; installed: string[]; reason?: string }>('/system/cli'),
  installCliTool: () => post<{ file: string; lines: string[] }>('/system/cli', {}),
  /* ---- remove buddi from this Mac ---- */
  uninstallPlan: () => get<UninstallPlan>('/system/uninstall'),
  uninstallBackup: (token: string) => post<{ job: UninstallJob }>('/system/uninstall/backup', { token }),
  uninstallJob: (id: string) => get<UninstallJob>(`/system/uninstall/jobs/${encodeURIComponent(id)}`),
  uninstall: (body: { token: string; wroteItDown: true; keepData: boolean }) => post<{ accepted: true }>('/system/uninstall', body),
  /** Home's card after the first encrypted backup, until "I saved it". */
  passphraseNotice: () => get<{ show: false } | { show: true; passphrase: string } | { show: true; needsPin: true }>('/backups/passphrase/notice'),
  acknowledgePassphrase: () => post<{ acknowledgedAt: string }>('/backups/passphrase/notice', {}),
  setBackupPassphrase: (passphrase: string) => put<{ passphrase: string }>('/backups/passphrase', { passphrase }),
  /* ---- plugins ---- */
  plugins: () => get<PluginsView>('/plugins'),
  /** The plugin list from withbuddi.com, through the gateway; `refresh` asks again past its day-old copy. */
  market: (refresh = false) => get<MarketView>(`/market${refresh ? '?refresh=1' : ''}`),
  /** A listing's picture (a screenshot), through the gateway: the page never fetches withbuddi.com itself. */
  marketAssetUrl: (url: string) => `/api/market/asset?url=${encodeURIComponent(url)}`,
  /** The folders in one folder on the gateway's machine, from the owner's home down; no path is the home. */
  pluginFolders: (path?: string) => get<PluginFoldersView>('/plugins/folders', path ? { path } : {}),
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
  /** The owner looked at it: its full card shown, or Review pressed. Keeps it a day instead of two hours. */
  openedStaged: (id: string) => post<{ opened: string }>(`/plugins/staged/${encodeURIComponent(id)}/opened`),
  /**
   * Stage the next version. `from` names the npm package to take it from
   * when the installed one came from elsewhere (a directory, a file) and is
   * now listed on withbuddi.com: the record moves to the registry on approval.
   */
  updatePlugin: (name: string, version?: string, from?: string) =>
    post<{ job: PluginJob }>(`/plugins/${encodeURIComponent(name)}/update`, {
      ...(version ? { version } : {}),
      ...(from ? { from } : {}),
    }),
  /** Disable or enable an installed plugin; it takes effect at once, `restartFor` says what a restart must finish. */
  setPluginEnabled: (name: string, enabled: boolean) =>
    post<{ name: string; enabled: boolean; changed: boolean; missions: string[]; notes: string[]; restartNeeded: boolean; restartFor?: string; loadProblem?: string }>(
      `/plugins/${encodeURIComponent(name)}/${enabled ? 'enable' : 'disable'}`,
      {},
    ),
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
    post<{
      /** The approval the owner's click decided; absent when it was already there. */
      approvalId?: string | null;
      /** The agent, created now or already on the roster. */
      agent: { id: string; handle: string; name: string };
      already?: boolean;
    }>(
      `/plugins/${encodeURIComponent(plugin)}/agents/${encodeURIComponent(agent)}/accept`,
    ),
  recovery: () => get<RecoveryView>('/recovery'),
  leaveRecovery: (body: { dropPending: boolean; keepGrants: string[] }) =>
    post<{ accepted?: boolean; restarting?: boolean }>('/recovery/leave', body),
  /**
   * The restore first run offers, before a single question has been answered.
   * No typed-back guard: there is nothing in this installation to lose.
   */
  firstRunRestore: (file: File, passphrase: string) =>
    sendArchive<{ job: BackupJob }>('/onboarding/restore', file, { passphrase }),
  setMissionEnabled: (id: string, enabled: boolean) =>
    post<{ id: string; enabled: boolean }>(`/missions/${encodeURIComponent(id)}/enabled`, { enabled }),
  keepMission: (id: string) => post<{ id: string; enabled: boolean }>(`/missions/${encodeURIComponent(id)}/keep`, {}),
  /** Keep or Stop on "Still useful?": the first answer from any surface decides. */
  answerStillUseful: (id: string, answer: 'keep' | 'stop') =>
    post<{ id: string; enabled: boolean; outcome: string }>(`/missions/${encodeURIComponent(id)}/still-useful`, { answer }),
  setMisfirePolicy: (id: string, misfirePolicy: string, deadlineMinutes?: number | null) =>
    post<unknown>(`/missions/${encodeURIComponent(id)}/schedule`, {
      misfirePolicy,
      ...(deadlineMinutes === undefined ? {} : { deadlineMinutes }),
    }),
  retryJob: (id: string) => post<{ job: JobRow }>(`/jobs/${encodeURIComponent(id)}/retry`),
  cancelJob: (id: string) => post<{ job: JobRow }>(`/jobs/${encodeURIComponent(id)}/cancel`),
  jobFailures: () => get<{ open: FailureGroup[]; dismissed: FailureGroup[] }>('/jobs/failures'),
  // The footer's "N failed" re-reads at once rather than on its next poll.
  dismissJobs: (pick: JobPick) => post<{ ids: string[] }>('/jobs/dismiss', pick).then(statusChanged),
  undismissJobs: (ids: string[]) => post<{ ids: string[] }>('/jobs/undismiss', { ids }).then(statusChanged),
  retryJobs: (pick: JobPick) => post<{ jobs: JobRow[] }>('/jobs/retry', pick).then(statusChanged),
  setDefaultAgent: (agentId: string) =>
    post<DefaultAgentView & { note: string }>('/agents/default', { agentId }),
  agentTools: (id: string) => get<ToolPickerView>(`/agents/${encodeURIComponent(id)}/tools`),
  /** The agent's file as written: its front matter and its persona, the body below it. */
  agentFile: (id: string) =>
    get<{ id: string; file: string; frontmatter: Record<string, unknown>; persona: string }>(`/agents/${encodeURIComponent(id)}/file`),
  /** The owner's picture for an agent: a PNG, GIF or SVG of at most 1 MB, re-encoded server side. */
  uploadAgentPicture: (id: string, file: File) => {
    const form = new FormData();
    form.append('file', file, file.name);
    return upload<{ picture: string; side: number; source: 'png' | 'gif' | 'svg'; note?: string }>(`/agents/${encodeURIComponent(id)}/avatar`, form);
  },
  removeAgentPicture: (id: string) => del<void>(`/agents/${encodeURIComponent(id)}/avatar`),
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
  /** `/quiet` from the composer; answers the sentence to show. */
  quiet: (arg: string) => post<{ text: string }>('/quiet', { arg }),
  takeOffer: (id: string, conversationId?: string) =>
    post<{ id: string; label: string; jobId: string | null; conversationId?: string; runId?: string; agentId?: string }>(
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
/** Where agents may look: permissions, not a mode (docs/browser.md). The own browser is always allowed. */
export interface ControlSettings {
  version: 2;
  yourChrome: boolean;
  /** Your apps, when the Computer plugin provides them; its own page keeps the list of apps. */
  yourApps: 'off' | 'ask' | 'on';
  signInSites: string[];
  defaultRoute: 'auto' | 'own' | 'chrome' | 'apps';
  stopExpiryMinutes: number;
  /** How long a mission waits on a browser card for the owner before it ends as "needed you", in minutes. */
  missionWaitMinutes?: number;
  maxOwnPages: number;
  showWindow: boolean;
}
export type BrowserRoute = 'own' | 'chrome' | 'apps';
/** One route's switch and health. */
export interface BrowserRouteStatus {
  kind: BrowserRoute;
  allowed: boolean;
  available: boolean;
  provider: string;
  /** Apps: a plugin provides the route here; false, the page offers the Computer plugin instead. */
  installed?: boolean;
  label?: string;
  message?: string;
  repair?: 'install' | 'permissions' | 'pair' | 'helper' | 'sandbox';
  paired?: boolean;
  connected?: boolean;
  /** Chrome: `paired` and `connected` in one word. Optional: an older gateway does not send it. */
  link?: 'unpaired' | 'closed' | 'connected';
  mode?: 'off' | 'ask' | 'on';
}
/** A browser card the run is parked on, waiting for the owner. */
export interface BrowserOwnerCard {
  kind: 'uncertain' | 'budget' | 'sign-in' | 'code' | 'human' | 'stopped';
  /** The title, a newline, the line: what Telegram sends. */
  question: string;
  /** The same words split, from a gateway that has them. */
  title?: string;
  line?: string;
  options: Array<{ label: string; hint?: string; recommended?: boolean }>;
  site?: string;
}
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
  /** This buddi's own version, to compare with the extension's. Optional: an older gateway does not send it. */
  buddi?: string;
  /** The oldest extension this buddi works with, in Chrome's numeric scheme (`0.1.0.24`). Optional: an older gateway does not send it. */
  extensionMinimum?: string;
  /** The dashboard moved port after this pairing (another program took the old one): pair again with the new address. */
  portMoved?: { from: number; to: number };
  /** buddi runs from a source checkout, where "Install unpacked" is worth offering. Optional: an older gateway does not send it. */
  checkout?: boolean;
}
export interface BrowserStatus {
  mode?: BrowserMode;
  /** Where the selected page looks. */
  route?: BrowserRoute;
  routes?: BrowserRouteStatus[];
  needsOwner?: BrowserOwnerCard;
  /** A global Stop that holds. */
  stop?: { at: string; until?: string };
  pin?: string;
  /** Sites buddi added to "needs your sign-in" itself, beside `settings.signInSites`. */
  learnedSignInSites?: string[];
  settings?: ControlSettings;
  state: 'unavailable' | 'idle' | 'starting' | 'running' | 'paused' | 'stopped' | 'expired' | 'error';
  enabled: boolean;
  busy: boolean;
  session?: { id: string; agentId: string; conversationId: string; requestId: string; task: string; expiresAt: string; steps: number; maxSteps: number };
  page?: { id: string; url: string; title: string; capturedAt: string; tabs: Array<{ id: string; url: string; title: string }>; appId?: string };
  lastAction?: string;
  message?: string;
  hasScreenshot: boolean;
  /** Take over only: whether this screen can be driven from the dashboard. */
  hand?: boolean;
  /** Why it cannot, in the mode's own words. */
  handMessage?: string;
  /** Take over only: `browser-offline` is "Your browser" with the extension not connected. */
  handReason?: 'browser-offline';
  /**
   * The owner holds the page where it is: a page in their Chrome was brought
   * to the front there, so no frame comes. Draw "it's in your Chrome" with
   * Give it back (`resume`), not a picture. Absent: take-over streams as before.
   */
  held?: { by: 'owner'; where: 'chrome' };
  /** The owner's Chrome and this buddi: not paired, paired but closed, or connected. Optional: an older gateway does not send it. */
  chrome?: 'unpaired' | 'closed' | 'connected';
  sessions?: BrowserStatus[];
  /** The agents' own browser on this machine. Own-browser mode only. */
  browser?: {
    engine: 'chromium' | 'chrome' | 'none';
    headless: boolean;
    problem?: 'missing-libraries' | 'no-sandbox';
    message?: string;
    /**
     * The install started from the dashboard. `progress` is the installer
     * read into numbers, for a bar; `line` is buddi's sentence at the end.
     */
    install?: { state: 'running' | 'done' | 'failed'; line?: string; progress?: BrowserInstallProgress };
  };
}

/** Where a browser install stands, in numbers — never the installer's text. */
export interface BrowserInstallProgress {
  phase: 'downloading' | 'installing' | 'done' | 'failed';
  /** Percent of the current download, 0–100. */
  percent: number;
  /** What is being fetched: `Chromium`. */
  what: string;
  /** Which download it is on, from 1. */
  download: number;
}

/** Whether the agents' browser opened and closed once, and what to do when it did not. */
/** `GET /api/browser/downloads`: the agents' downloads area. */
export interface BrowserDownloads {
  bytes: number;
  files: number;
  agents: Array<{ agent: string; bytes: number; files: number }>;
  fileCap: number;
  agentCap: number;
  retentionDays: number;
}

export type BrowserLaunchCheck =
  | { ok: true }
  | { ok: false; message: string; command?: string; problem?: 'missing-libraries' | 'no-sandbox' | 'no-browser' };

/* ------------------------------------------------------------------ *
 * Connections (docs/connections.md)
 * ------------------------------------------------------------------ */

export type ConnectionState = 'connected' | 'needs-reconnect' | 'unreachable' | 'pending-review' | 'needs-review';

/** A connection that needs the owner (`GET /connections/signals`). */
export interface ConnectionSignal {
  id: string;
  name: string;
  state: 'needs-reconnect' | 'needs-review';
  sentence: string;
}

/** One registered connection tool, as the grant screen offers remembering it. */
export interface ConnectionToolView {
  tool: string;
  tier: 'auto' | 'gated';
  rememberable: boolean;
  /** Why it cannot be remembered, when it cannot. */
  why: string | null;
}

/** One of an agent's gated connection tools (its Access page). */
export interface RememberedApproval {
  tool: string;
  connection: string;
  rememberable: boolean;
  why: string | null;
  remembered: boolean;
}

export interface ConnectionView {
  id: string;
  slug: string | null;
  name: string;
  url: string;
  host: string;
  state: ConnectionState;
  /** How it signs in: not at all, the service's own page, or a token you pasted. */
  authKind: 'none' | 'oauth' | 'token';
  signedIn: boolean;
  toolCount: number;
  /** `mcp.<slug>.*`, what an agent's grant names; null before review. */
  grant: string | null;
  serverName: string | null;
  serverVersion: string | null;
  reviewedAt: string | null;
  /** While unreachable: since when (buddi retries it in the background). */
  unreachableSince?: string | null;
  /** Reviewed tools the server changed or dropped since: they wait for another review. */
  heldTools?: number;
  /** Agents whose files grant this connection's tools. */
  agents: string[];
  /** A device sign-in that is waiting, or ended in the last ten minutes. */
  device?: ConnectionDevice;
  /** `http` for a server at an address, `stdio` for a program on this computer. */
  transport?: 'http' | 'stdio';
  /** A program's command, arguments and variables (never a secret's value). */
  program?: ConnectionProgram;
  /** A program being started (a first download can take a minute or two). */
  phase?: 'starting';
  /** The last lines a program wrote to stderr when it last failed. */
  stderr?: string[];
}

/** A program on this computer, as the row and the review show it. */
export interface ConnectionProgram {
  command: string;
  args: string[];
  /** The command line in full. */
  line: string;
  env: Array<{ name: string; secret: boolean; value?: string }>;
  /** Its command, arguments or variables' names changed since the review. */
  changedSinceReview: boolean;
}

/** What "A program on this computer" sends. A secret left empty on a change keeps its value. */
export interface ProgramForm {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string; secret: boolean }>;
}

/** A code the owner types on the service's site (the OAuth device flow). */
export interface ConnectionDevice {
  state: 'waiting' | 'done' | 'failed';
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  /** Failed: why, in one sentence. */
  reason?: string;
}

export interface ConnectionCard {
  id: string;
  name: string;
  blurb: string;
  url: string;
  verified: boolean;
  /** The service offers no dynamic registration: the owner brings a client id. */
  clientIdRequired?: boolean;
  /** Which way of signing in the screen offers first, and where a token is made. */
  auth?: {
    recommended: 'device' | 'token' | 'oauth';
    /** buddi's own app on the service: a code typed on its site. */
    device?: { clientId: string; deviceEndpoint: string; scopes: string[] };
    tokenPage?: string;
    tokenHint?: string;
  };
}

export interface ConnectionsView {
  connections: ConnectionView[];
  catalog: ConnectionCard[];
  /** Who may be given a connection's tools, the front desk first. */
  agents: Array<{ id: string; name: string; handle: string; frontDesk: boolean }>;
  /** Whether this installation has a vault to keep sign-ins in. */
  vault: boolean;
  /** Whether a pasted token can be kept (the owner's secrets are available). */
  tokens?: boolean;
  callbackPath: string;
}

export interface ConnectionReviewTool {
  name: string;
  fullName: string;
  description: string;
  tier: 'auto' | 'gated';
  destructive: boolean;
  annotated: boolean;
  problem: string | null;
  /** Against the last review. */
  change?: 'added' | 'changed' | null;
}

export interface ConnectionReview {
  connection: ConnectionView;
  slug: string;
  slugEditable: boolean;
  host: string;
  hash: string;
  tools: ConnectionReviewTool[];
  annotatedNothing: boolean;
  /** What changed since the last review, by the server's names; null on a first review. */
  changes?: { added: string[]; changed: string[]; removed: string[] } | null;
  /** A program: what runs, in full. */
  program?: ConnectionProgram;
}
