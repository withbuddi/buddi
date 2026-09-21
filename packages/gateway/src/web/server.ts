/**
 * The dashboard's HTTP server — bound to loopback, CSRF-checked, and CORS-free.
 *
 * ARCHITECTURE.md, "Owner and surface authentication": *«Web UI: session auth,
 * CSRF protection, Origin checks, bound to localhost by default (remote access
 * = explicit authenticated transport).»* The binding is the credential. Each
 * rule runs here before any handler sees a request:
 *
 *   1. **Rate limit.** Failed authentications are counted per address; over
 *      budget is `429` with no body. Valid sessions and fresh, valid tickets
 *      still work, so a stale polling tab cannot lock out the owner.
 *   2. **Open on loopback.** A server bound to a loopback address serves every
 *      request that arrives on one, with no ticket and no expiry: the owner
 *      bookmarks `http://127.0.0.1:4317/` and it works, across restarts and
 *      idle months. The threat a token would answer — a remote party — cannot
 *      reach a loopback socket, and the browser-borne one is answered below and
 *      by the absence of CORS. A session is minted silently when the browser
 *      has none, so the CSRF machinery below works unchanged; nothing the owner
 *      does ever shows an authentication step.
 *   3. **The ticket exchange.** Only on a non-loopback binding (or by explicit
 *      ask): a `?t=` on any GET is verified against the installation's token,
 *      spent once, and answered with a redirect to a clean URL carrying an
 *      HttpOnly session cookie. The token never appears in a log line, an
 *      error, or the redirect target.
 *   4. **The session, when the binding is not loopback.** Anything else without
 *      a live session cookie is `401` with an empty body. Not a message, not a
 *      `WWW-Authenticate`, not a different status for "expired" — one bit, and
 *      no hint.
 *   5. **Writes.** A mutating method additionally needs the double-submit CSRF
 *      header to match its cookie *and* an `Origin`/`Referer` that is the bound
 *      address. Either failing is `403`, empty. This is the rule that survives
 *      open access: a page on another origin can send this server a request,
 *      but it cannot claim to be the dashboard, and it cannot read a single
 *      response back.
 *
 * No `Access-Control-*` header is ever emitted, and `OPTIONS` is refused: a
 * page on another origin gets no preflight and no permission.
 */
import { randomUUID, createHmac } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { continueBrowserTask } from '../surfaces/browser-continuation.js';
import { ProviderSettingsError, type ProviderSettings } from '../providers.js';
import { ProviderAccountError, type ProviderAccounts } from '../provider-accounts.js';
import { listBrowserProfiles, listInstalledApps } from './apps.js';
import { agentSearchPath, EXAMPLES_AGENTS_DIR } from '../agents/catalog.js';
import { setDelegatesFromWeb } from './write.js';
import {
  OnboardingRefusal,
  WEB_ONBOARDING_STEPS,
  WEB_ONBOARDING_SURFACE,
  claimOpeningTurn,
  createFirstAgent,
  probeOllama,
  readOnboarding,
  rebindBrain,
  updateFirstAgent,
  withFirstRunFacts,
  type OnboardingDeps,
} from './onboarding.js';
import {
  TelegramWebError,
  saveTelegramToken,
  telegramPairing,
  telegramStatus,
  type TelegramControl,
  type TelegramWebDeps,
} from './telegram.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentCatalog, JobControl, JobState, ToolContext, ToolRegistry } from '@buddi/core';
import { getAction, inRecovery, isJobState, snoozeFinding } from '@buddi/core';
import type { Pool } from 'pg';
import { hostBrowser, type BrowserController } from '@buddi/tool-browser';
import { hostService } from '@buddi/tool-host';
import { listToolPermissions, revokeToolPermission, getArtifact, readArtifactBytes, artifactBytesExist, discardUnreferencedUpload, listLibrary, getLibraryEntry, decodeCursor, filterKey, textPreviewable, readArtifactPrefix, FILE_FAMILIES, LIBRARY_PAGE_MAX, type FileFamily, type FileOrigin, getOwnerProfile, setOwnerProfile, isKnownTimezone, listGroups, getGroup, createGroup, archiveGroup, createGroupConversation, listGroupConversations, latestGroupConversation, openGroupRequest, conversationGroup, type GroupRow, type OwnerProfilePatch, type PermissionScope } from '@buddi/core';
import { beginOnboarding, completeOnboarding, markStepDone, setOnboardingDetails, skipOnboarding } from '@buddi/core';
import { listMemory, setPreference, forgetPreference, updateNote, forgetNote } from '@buddi/tool-memory';
import {
  engineChangeFromBody,
  readAgentEngines,
  readEngineOptions,
  setAgentEngineFromWeb,
} from './agents.js';
import { readAgentProfile } from './profile.js';
import { AVATAR_IMAGE } from './chat.js';
import path_ from 'node:path';
import { readFileSync } from 'node:fs';
import {
  ATTACHMENTS_UNAVAILABLE,
  CHAT_CONVERSATIONS_LIMIT,
  CHAT_UNAVAILABLE,
  WEB_CHAT_SURFACE,
  WebChat,
  conversationAgent,
  readChatAgents,
  readChatConversations,
  readChatTranscript,
  type WebChatDeps,
} from './chat.js';
import { readAgentAttention, streamAttention } from './attention.js';
import { allowedOrigins, isLoopback, webAssetsDir, webUrl, type WebConfig } from './config.js';
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
  BodyTooLargeError,
  first,
  cookieHeader,
  parseCookies,
  parseUrl,
  readJsonBody,
  remoteKey,
  requestOrigin,
  requestScope,
  sendEmpty,
  sendJson,
  sendText,
} from './http.js';
import {
  boundedLimit,
  readAgents,
  readApprovals,
  readConversation,
  readConversations,
  readEventKinds,
  readEvents,
  readJobs,
  readMissions,
  readOverview,
  readOffers,
  readReminders,
  readSentinels,
  toApprovalView,
} from './read.js';
import {
  RateLimiter,
  SessionStore,
  SpentTickets,
  type Session,
  type SessionScope,
} from './sessions.js';
import { supervisorCall } from './service.js';
import {
  backupJobRoute,
  createBackupRoute,
  discardUpload,
  listBackups,
  passphraseRoute,
  receiveUpload,
  restoreRoute,
  scheduleRoute,
  verifyBackupRoute,
  type RouteReply,
} from './backups.js';
import {
  approveRoute,
  listPlugins,
  pluginJobRoute,
  receivePluginUpload,
  rejectRoute,
  stageRoute,
  uninstallRoute,
  updateRoute,
  uploadRoute,
  type PluginsDeps,
  type PluginsEngine,
} from './plugins.js';
import { leaveRecoveryMode, readRecoveryView } from './recovery.js';
import { BUILD_MISSING, serveAsset } from './static.js';
import { StreamBudget, resumeCursor, streamConversation } from './stream.js';
import { ensureWebToken, verifyTicket } from './token.js';
import { MAX_UPLOAD_BYTES, readUpload } from './upload.js';
import {
  cancelJobFromWeb,
  cancelReminderFromWeb,
  decideApprovalFromWeb,
  retryJobFromWeb,
  setMissionEnabledFromWeb,
  setPausedFromWeb,
  setScheduleFromWeb,
  takeOfferFromWeb,
  type WriteDeps,
  type WriteResult,
} from './write.js';

export interface WebServerDeps {
  /** Host controller; test instances can inject a fake. Reads never enable it. */
  browser?: BrowserController;
  pool: Pool;
  registry: ToolRegistry;
  catalog: AgentCatalog;
  ctx: ToolContext;
  timezone: string;
  now: () => Date;
  config: WebConfig;
  /** The installation's dashboard token. Never logged, never sent anywhere. */
  token: string;
  /** The queue, when this process runs one. */
  jobs?: JobControl | undefined;
  /**
   * The environment the engine controls resolve credentials against. Passed
   * explicitly, as everywhere else: nothing here discovers a credential.
   */
  env?: NodeJS.ProcessEnv | undefined;
  providerSettings?: ProviderSettings;
  providerAccounts?: ProviderAccounts;
  /**
   * The plugin engine. Injected only by tests, which fake every one of its
   * functions; a running gateway resolves the real one from `../plugins/`.
   */
  plugins?: PluginsEngine | undefined;
  /**
   * This process's Telegram surface, when it runs one.
   *
   * The dashboard can then take a token from the owner and have the phone
   * working before they put it down. A process without one keeps the token and
   * says it will be there next time buddi starts.
   */
  telegram?: TelegramControl | undefined;
  /** Where the built UI lives. Defaults to `packages/web/dist`. */
  assetsDir?: string | undefined;
  /**
   * Idle session lifetimes, by scope. Injected only by tests — the defaults in
   * `sessions.ts` are the product, and nothing reads this from the environment.
   */
  sessionTtlMs?: Partial<Record<SessionScope, number>> | undefined;
  /**
   * Whether the gate is open regardless of the binding. Derived from the
   * binding itself (loopback is open), and overridable only by tests, which
   * cannot reach a loopback-bound socket from anywhere else and so could not
   * otherwise exercise the closed gate.
   */
  openAccess?: boolean | undefined;
  log?: ((line: string) => void) | undefined;
  /**
   * Everything the browser needs to be a *talking* surface: the per-agent
   * provider adapter, the artifact store, the memory hook, the pause gate.
   *
   * Optional, and the optionality is the point. A process that serves the
   * dashboard but has no provider wired — a test, a read-only deployment —
   * still serves every read and every existing write; the chat routes answer
   * 503 with a sentence saying so, rather than the server failing to start.
   */
  chat?: Omit<WebChatDeps, 'pool' | 'catalog' | 'registry' | 'ctx' | 'now' | 'timezone' | 'log'>;
}

export interface WebServer {
  server: Server;
  /** The port actually bound — resolved after `listen`, so `0` works in tests. */
  port: number;
  url: string;
  /** The chat surface, when this process wired one. */
  chat?: WebChat | undefined;
  close(): Promise<void>;
}

/**
 * Which chat surface belongs to which server.
 *
 * A `WeakMap` rather than a second return value from `createWebApp`: every
 * existing caller keeps its one-line construction, and a server that is
 * garbage-collected takes its queue with it.
 */
const WEB_CHATS = new WeakMap<Server, WebChat>();

/** The chat surface this server is running, if any. */
/** The most of a text file a preview shows; the download has the whole. */
const PREVIEW_TEXT_BYTES = 100_000;

/**
 * How an artifact may be previewed inline, or null for download only. Text
 * is an allowlist of genuinely textual formats, never a binary container
 * however it is named; HTML and SVG count as text and are served as
 * text/plain, so they are read and never rendered.
 */
function previewKind(mime: string, filename: string | null): 'image' | 'pdf' | 'text' | null {
  if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (textPreviewable(mime, filename)) return 'text';
  return null;
}

/** A group as the page draws it. */
function groupView(group: GroupRow): { id: string; name: string; coordinator: string; members: string[]; contextCapChars: number; createdAt: string } {
  return { id: group.id, name: group.name, coordinator: group.coordinator, members: group.members, contextCapChars: group.contextCapChars, createdAt: group.createdAt.toISOString() };
}

/** Every IANA zone this Node knows, for a picker. */
/** A reply the backup module composed, on the wire. */
function reply(res: ServerResponse, out: RouteReply): void {
  sendJson(res, out.status, out.body);
}

function knownTimezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try { return intl.supportedValuesOf ? intl.supportedValuesOf('timeZone') : []; } catch { return []; }
}

export function webChatOf(server: Server): WebChat | undefined {
  return WEB_CHATS.get(server);
}

/** The query parameter carrying a one-time ticket. */
export const TICKET_PARAM = 't';

export function createWebApp(deps: WebServerDeps): Server {
  const sessions = new SessionStore(deps.sessionTtlMs ?? {});
  const spent = new SpentTickets();
  const limiter = new RateLimiter();
  const assetsDir = deps.assetsDir ?? webAssetsDir();
  const log = deps.log ?? ((line: string) => console.error(line));
  const writeDeps: WriteDeps = {
    pool: deps.pool,
    registry: deps.registry,
    ctx: deps.ctx,
    now: deps.now,
    jobs: deps.jobs,
    log,
  };
  const chat = deps.chat
    ? new WebChat({
        onConversationRollover: (agentId, previousConversationId, conversationId, reason) => continueBrowserTask(deps.pool, deps.browser ?? hostBrowser(deps.env ?? process.env), { ownerId: deps.ctx.ownerId, agentId, previousConversationId, conversationId }, reason),
        pool: deps.pool,
        catalog: deps.catalog,
        registry: deps.registry,
        ctx: deps.ctx,
        now: deps.now,
        timezone: deps.timezone,
        log,
        ...deps.chat,
      })
    : undefined;
  const streams = new StreamBudget();
  const permissionScopes = (tool: string): Record<string, unknown> => deps.registry.lookup(tool)?.reusableApproval
    ? { permissionScopes: ['conversation', 'always'] } : {};
  writeDeps.resumeInteractive = (action, outcome) => chat?.resumeHost(action, outcome);
  // The binding is the credential: loopback is open, anything else keeps the
  // ticket-and-session gate. The override is a test seam, nothing more.
  const openAccess = deps.openAccess ?? (deps.env?.BUDDI_WEB_REQUIRE_AUTH !== '1' && isLoopback(deps.config.host));

  /**
   * The pair a browser holds: the HttpOnly session and the readable CSRF value
   * the page has to echo back in a header. Both carry the same `Max-Age`, which
   * is the lifetime this session's scope earned it.
   */
  const sessionCookies = (session: Session): string[] => {
    const maxAgeSeconds = SessionStore.maxAgeSeconds(session);
    return [
      cookieHeader(SESSION_COOKIE, session.id, { httpOnly: true, maxAgeSeconds, secure: session.scope === 'remote' && !!deps.config.publicOrigin }),
      cookieHeader(CSRF_COOKIE, session.csrf, { httpOnly: false, maxAgeSeconds, secure: session.scope === 'remote' && !!deps.config.publicOrigin }),
    ];
  };

  /**
   * The origins a write may claim, resolved against the port actually bound.
   *
   * It has to be lazy: with `port: 0` the OS picks the port only at `listen`,
   * and an origin set computed from the *requested* port would then reject
   * every write the page itself makes.
   */
  let originCache: { port: number; set: Set<string> } | undefined;
  const allowed = (): Set<string> => {
    const bound = (server.address() as AddressInfo | null)?.port ?? deps.config.port;
    if (originCache?.port !== bound) {
      originCache = { port: bound, set: new Set(allowedOrigins({ ...deps.config, port: bound })) };
    }
    return originCache.set;
  };

  // The chat surface is reachable from the server object it belongs to, so a
  // caller that needs to drain it on shutdown (or in a test) can, without
  // `createWebApp` growing a second return value every existing caller would
  // have to unpack.
  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      // A defect is a 500 with nothing in it. The sentence goes to the log,
      // where only the owner can read it.
      log(`web: ${req.method} ${req.url} failed: ${err instanceof Error ? err.stack : String(err)}`);
      if (!res.headersSent) sendEmpty(res, 500);
      else res.end();
    });
  });

  if (chat) WEB_CHATS.set(server, chat);
  return server;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const now = deps.now();
    const method = (req.method ?? 'GET').toUpperCase();
    const url = parseUrl(req);
    const key = remoteKey(req);

    // No CORS, and therefore no preflight.
    if (method === 'OPTIONS') return sendEmpty(res, 405);

    // A port answering 401 is not evidence that this installation is ready.
    // Domain-separated challenge proof never sends the install secret to that port.
    if (method === 'GET' && url.pathname === '/_buddi/ready' && deps.env?.BUDDI_WEB_REQUIRE_AUTH === '1') {
      const challenge = url.searchParams.get('challenge') ?? '';
      if (!/^[a-f0-9]{64}$/.test(challenge)) return sendEmpty(res, 400);
      return sendJson(res, 200, { proof: createHmac('sha256', deps.token).update(`buddi-ready-v1:${challenge}`).digest('hex') });
    }

    // A remote socket or proxy metadata can only earn remote access. It
    // decides how long a session minted now lives, and it must keep matching
    // for as long as that session is used.
    const scope = requestScope(req);

    // The ticket exchange. Only ever on a GET, and only ever once per ticket.
    const ticket = url.searchParams.get(TICKET_PARAM);
    if (ticket !== null && (method === 'GET' || method === 'HEAD')) {
      const check = verifyTicket(deps.token, ticket, now);
      if (!check.ok || !spent.spend(check.nonce, check.expiresAt, now)) {
        if (limiter.blocked(key, now)) return sendEmpty(res, 429);
        limiter.fail(key, now);
        // Never says which of "wrong", "expired" and "already used" it was.
        return sendEmpty(res, 401);
      }
      limiter.reset(key);
      const session = sessions.create(scope, now);
      const clean = new URL(url.toString());
      clean.searchParams.delete(TICKET_PARAM);
      return sendEmpty(res, 302, {
        Location: `${clean.pathname}${clean.search}`,
        'Set-Cookie': sessionCookies(session),
      });
    }

    const cookies = parseCookies(req.headers.cookie);
    let session = sessions.get(cookies[SESSION_COOKIE], scope, now);

    /*
     * Open on loopback: the request is on this machine and the server is bound
     * to this machine, so there is nothing left to authenticate. A session is
     * minted silently — the page gets its CSRF pair like any other, writes stay
     * gated by rule 5, and the owner is never shown an authentication step.
     * Minting rather than bypassing the store is what keeps one code path for
     * every request; the cookie is a detail of how CSRF works, not a login.
     */
    if (!session && openAccess && scope === 'local') {
      session = sessions.create(scope, now);
      res.setHeader('Set-Cookie', sessionCookies(session));
    }

    if (!session) {
      // Rate-limit failed authentication, not authenticated traffic. A stale
      // tab behind the same proxy must not lock out a valid recovery ticket
      // or an already authenticated owner (nor direct local access).
      if (limiter.blocked(key, now)) return sendEmpty(res, 429);
      limiter.fail(key, now);
      return sendEmpty(res, 401);
    }

    /*
     * Slide the browser's copy, not just the server's.
     *
     * `sessions.get` has already pushed the server-side expiry out; without
     * this the cookie itself would still die at the `Max-Age` it was minted
     * with, and someone who used the dashboard all day would be logged out
     * mid-sentence. The header is attached here rather than at each `send*`
     * so every route — JSON, static asset, event stream — carries it, and
     * `renewCookie` is what keeps it to roughly one response per half-life
     * instead of one per request.
     */
    if (sessions.renewCookie(session, now)) res.setHeader('Set-Cookie', sessionCookies(session));

    const mutating = method !== 'GET' && method !== 'HEAD';
    if (mutating) {
      const origin = requestOrigin(req);
      if (origin === undefined || !allowed().has(origin)) return sendEmpty(res, 403);
      const presented = req.headers[CSRF_HEADER];
      const header = Array.isArray(presented) ? presented[0] : presented;
      if (!SessionStore.csrfMatches(session, header)) return sendEmpty(res, 403);
      if (cookies[CSRF_COOKIE] !== session.csrf) return sendEmpty(res, 403);
    }

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return api(req, res, url, method, now, session);
    }
    if (mutating) return sendEmpty(res, 405);

    const served = await serveAsset(res, assetsDir, url.pathname);
    if (!served.served) sendText(res, 503, BUILD_MISSING);
  }

  /* ---------------------------------------------------------------- *
   * The API
   * ---------------------------------------------------------------- */

  async function api(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
    now: Date,
    session: Session,
  ): Promise<void> {
    const path = url.pathname.replace(/\/+$/, '') || '/api';
    const q = url.searchParams;
    const browser = deps.browser ?? hostBrowser(deps.env ?? process.env);
    /** Everything the first-run routes need, resolved per request. */
    const onboardingDeps = (): OnboardingDeps => ({
      pool: deps.pool,
      catalog: deps.catalog,
      providerAccounts: deps.providerAccounts,
      agentsDir: agentSearchPath(deps.env ?? process.env).owner.dir,
      examplesDir: EXAMPLES_AGENTS_DIR,
      reload: () => (deps.catalog as { reload?: () => void }).reload?.(),
    });
    /** What the backup routes need: the environment, and somewhere to log. */
    const backupDeps = (): { env: NodeJS.ProcessEnv; log: (line: string) => void } => ({
      env: deps.env ?? process.env,
      log,
    });
    /** The same, for the plugin routes, plus the pool migrations and a purge need. */
    const pluginDeps = (): PluginsDeps => ({
      env: deps.env ?? process.env,
      log,
      pool: deps.pool,
      ...(deps.plugins ? { engine: deps.plugins } : {}),
    });
    /**
     * May this installation still be restored over from the first-run screen?
     *
     * Only while nothing has been answered and the owner has no agent of their
     * own: after that a restore is a replacement and needs the typed-back
     * confirmation the ordinary route asks for.
     */
    const onboardingRestoreRefusal = async (): Promise<{ status: number; message: string } | null> => {
      const view = await readOnboarding(onboardingDeps());
      if (view.state !== 'pending') {
        return { status: 409, message: 'This buddi has already been set up. Restore from Settings, where it asks you to confirm.' };
      }
      if (!view.needs.agent) {
        return { status: 409, message: 'This buddi already has an agent. Restore from Settings, where it asks you to confirm.' };
      }
      return null;
    };
    /** What the two Telegram routes need. The environment is the live one. */
    const telegramDeps = (): TelegramWebDeps => ({
      pool: deps.pool,
      env: deps.env ?? process.env,
      ...(deps.telegram ? { telegram: deps.telegram } : {}),
    });

    if (method === 'GET' || method === 'HEAD') {
      /*
       * The library: what the store holds, for a person (docs/files.md). Read
       * only, owner only, never an agent tool. Origin is what the row says.
       */
      if (path === '/api/artifacts') {
        const origin = q.get('origin');
        const family = q.get('family');
        if (origin && !['uploaded', 'produced', 'unknown'].includes(origin)) return sendJson(res, 400, { error: '`origin` must be uploaded, produced or unknown' });
        if (family && !(FILE_FAMILIES as readonly string[]).includes(family)) return sendJson(res, 400, { error: `\`family\` must be one of ${FILE_FAMILIES.join(', ')}` });
        const limitRaw = q.get('limit');
        const limit = limitRaw === null ? undefined : Number(limitRaw);
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > LIBRARY_PAGE_MAX)) return sendJson(res, 400, { error: `\`limit\` must be 1 to ${LIBRARY_PAGE_MAX}` });
        const cursor = q.get('cursor');
        const filters = { ...(q.get('q') ? { q: q.get('q')!.slice(0, 200) } : {}), ...(origin ? { origin: origin as FileOrigin } : {}), ...(family ? { family: family as FileFamily } : {}) };
        // A cursor is bound to the filters it was issued under; with others it would skip rows.
        if (cursor && !decodeCursor(cursor, filterKey(filters))) return sendJson(res, 400, { error: '`cursor` is not one this listing issued for these filters' });
        const page = await listLibrary(deps.pool, {
          ...filters,
          ...(limit !== undefined ? { limit } : {}),
          ...(cursor ? { cursor } : {}),
          knownAgentIds: deps.catalog.list().map((a) => a.id),
        });
        return sendJson(res, 200, page);
      }
      const libraryOne = /^\/api\/artifacts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(path);
      if (libraryOne) {
        const offsetRaw = q.get('contexts');
        const offset = offsetRaw === null ? 0 : Number(offsetRaw);
        if (!Number.isInteger(offset) || offset < 0) return sendJson(res, 400, { error: '`contexts` must be a non-negative integer' });
        const found = await getLibraryEntry(deps.pool, libraryOne[1]!, deps.catalog.list().map((a) => a.id), offset);
        if (!found) return sendJson(res, 404, { error: 'no such file' });
        // The bytes may be gone while the row remains: say so, keep the metadata.
        const artifact = await getArtifact(deps.pool, found.entry.id);
        const available = artifact ? await artifactBytesExist(deps.env ?? process.env, artifact).catch(() => false) : false;
        return sendJson(res, 200, { ...found, available });
      }

      const download = /^\/api\/artifacts\/([0-9a-f-]{36})\/(download|preview)$/.exec(path);
      if (download) {
        const artifact = await getArtifact(deps.pool, download[1]!);
        if (!artifact) return sendEmpty(res, 404);
        const preview = download[2] === 'preview';
        /*
         * What may be shown inline on our origin, and how:
         *  - passive raster images, as themselves;
         *  - PDFs, for the browser's own viewer, which the browser isolates —
         *    the sandbox directive here withholds scripts and plugins from any
         *    document content all the same;
         *  - text families, always as text/plain, so nothing in them is ever
         *    parsed as markup, and bounded to what a preview shows.
         * Everything else stays a download.
         */
        const kind = preview ? previewKind(artifact.mime, artifact.filename) : null;
        if (preview && kind === null) return sendEmpty(res, 415);
        // A text preview reads only its prefix from disk, on a character
        // boundary, and says whether the file went on; nothing else is loaded.
        let bytes: Buffer;
        let truncated = false;
        if (kind === 'text') {
          const prefix = await readArtifactPrefix(deps.env ?? process.env, artifact, PREVIEW_TEXT_BYTES);
          const decoder = new StringDecoder('utf8');
          bytes = Buffer.from(decoder.write(prefix.bytes), 'utf8');
          truncated = prefix.truncated;
        } else {
          bytes = await readArtifactBytes(deps.env ?? process.env, artifact);
        }
        res.setHeader('Content-Type', kind === 'text' ? 'text/plain; charset=utf-8' : preview ? artifact.mime : 'application/octet-stream');
        res.setHeader('Content-Disposition', `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(artifact.filename ?? 'download').replace(/'/g, '%27')}`);
        if (preview) res.setHeader('Content-Security-Policy', kind === 'pdf' ? "default-src 'none'; sandbox allow-same-origin" : "default-src 'none'; sandbox");
        if (kind === 'text') res.setHeader('X-Preview-Truncated', truncated ? '1' : '0');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        res.end(method === 'HEAD' ? undefined : bytes);
        return;
      }
      switch (path) {
        case '/api/host': {
          const host = hostService(deps.env ?? process.env);
          const agentId = q.get('agentId') ?? undefined;
          const conversationId = q.get('conversationId') ?? undefined;
          const permissions = (await listToolPermissions(deps.pool, deps.ctx.ownerId)).filter(p => p.tool === 'host.exec' && (!agentId || p.agentId === agentId) && (!conversationId || !p.conversationId || p.conversationId === conversationId));
          return sendJson(res, 200, { permissions, runs: host.runs(deps.ctx.ownerId, agentId, conversationId) });
        }
        case '/api/host/apps':
          return sendJson(res, 200, { apps: await listInstalledApps() });
        case '/api/host/browser-profiles':
          return sendJson(res, 200, { profiles: await listBrowserProfiles(q.get('app') ?? '') });
        case '/api/browser':
          return sendJson(res, 200, q.has('conversationId') && q.has('agentId')
            ? browser.status({ agentId: q.get('agentId')!, conversationId: q.get('conversationId')! }) : browser.status());
        case '/api/browser/screenshot': {
          const expectedSession = url.searchParams.get('sessionId');
          const current = browser.status(expectedSession !== null ? { sessionId: expectedSession } : undefined);
          const observation = url.searchParams.get('v');
          if ((expectedSession !== null && current.session?.id !== expectedSession) ||
              (observation !== null && current.page?.id !== observation)) return sendEmpty(res, 404);
          const bytes = browser.screenshot(expectedSession ?? undefined);
          if (!bytes) return sendEmpty(res, 404);
          res.setHeader('Content-Type', 'image/jpeg');
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
          res.end(method === 'HEAD' ? undefined : bytes);
          return;
        }
        case '/api/session':
          return sendJson(res, 200, {
            csrf: session.csrf,
            timezone: deps.timezone,
            host: deps.config.host,
            port: deps.config.port,
            // Restored from a backup and not yet checked over. The shell reads
            // this on every page, because the banner belongs on every page.
            recovery: await inRecovery(deps.pool),
            // Where this session was established and when it would lapse if
            // nothing touched it again. Said out loud so the model is legible
            // from the page rather than implied by a number in a source file.
            scope: session.scope,
            expiresAt: session.expiresAt.toISOString(),
          });
        case '/api/overview':
          return sendJson(
            res,
            200,
            await readOverview({
              pool: deps.pool,
              registry: deps.registry,
              catalog: deps.catalog,
              ctx: deps.ctx,
              timezone: deps.timezone,
              now,
            }),
          );
        case '/api/events':
          return sendJson(
            res,
            200,
            await readEvents(deps.pool, {
              kind: q.get('kind') ?? undefined,
              q: q.get('q') ?? undefined,
              since: q.get('since') ?? undefined,
              before: q.get('before') ?? undefined,
              limit: boundedLimit(q.get('limit')),
            }),
          );
        case '/api/events/kinds':
          return sendJson(res, 200, { kinds: await readEventKinds(deps.pool) });
        case '/api/conversations':
          return sendJson(res, 200, {
            conversations: await readConversations(deps.pool, boundedLimit(q.get('limit'), 50)),
          });
        case '/api/missions':
          return sendJson(res, 200, { missions: await readMissions(deps.pool, now) });
        case '/api/jobs': {
          const state = q.get('state');
          return sendJson(
            res,
            200,
            await readJobs(deps.pool, {
              state: state && isJobState(state) ? (state as JobState) : undefined,
              kind: q.get('kind') ?? undefined,
              limit: boundedLimit(q.get('limit')),
              offset: Math.max(0, Math.min(Number(q.get('offset') ?? 0) || 0, 100_000)),
            }),
          );
        }
        case '/api/approvals': {
          const approvals = await readApprovals(deps.pool, now, boundedLimit(q.get('limit'), 50));
          return sendJson(res, 200, { pending: approvals.pending.map(a => ({ ...a, ...permissionScopes(a.tool) })),
            recent: approvals.recent.map(a => ({ ...a, ...permissionScopes(a.tool) })) });
        }
        case '/api/offers':
          return sendJson(res, 200, {
            offers: await readOffers(deps.pool, now, boundedLimit(q.get('limit'))),
          });
        case '/api/reminders':
          return sendJson(res, 200, {
            reminders: await readReminders(deps.pool, boundedLimit(q.get('limit'))),
          });
        case '/api/sentinels':
          return sendJson(
            res,
            200,
            await readSentinels(deps.pool, deps.registry, boundedLimit(q.get('limit'), 50)),
          );
        case '/api/chat/agents':
          return sendJson(res, 200, readChatAgents(deps.catalog));
        // Which agents are waiting on the owner. One small query, and the only
        // definition of "waiting" in the installation — see attention.ts.
        case '/api/chat/attention':
          return sendJson(res, 200, await readAgentAttention(deps.pool, now));
        case '/api/chat/views':
          // How the installed plugins want their tool output drawn. The page
          // owns the renderers and learns the domain mapping from here, so an
          // installation without a plugin serves none of that plugin's mapping.
          return sendJson(res, 200, { views: deps.registry.views() });
        case '/api/agents':
          return sendJson(res, 200, {
            agents: readAgents(deps.catalog),
            // The engine half is read from the files, so a change made a
            // second ago shows even though this process still runs the
            // catalog it booted with — which `restartRequired` reports.
            engines: readAgentEngines(deps.catalog, deps.env ?? process.env),
            providers: readEngineOptions(deps.env ?? process.env),
            providerAccounts: deps.providerAccounts?.view(),
          });
        case '/api/groups':
          return sendJson(res, 200, { groups: (await listGroups(deps.pool)).map(groupView) });
        /*
         * The supervisor, when there is one. A developer checkout has no
         * socket and therefore no service section on the Settings page: the
         * gateway is whatever started it, and it has nothing to report.
         */
        case '/api/service': {
          const socket = (deps.env ?? process.env).BUDDI_SUPERVISOR_SOCKET;
          if (!socket) return sendJson(res, 200, { supervised: false });
          try {
            const reply = await supervisorCall(socket, '/status', 'GET');
            if (reply.status !== 200) return sendJson(res, 502, { error: 'The supervisor refused to report its status.' });
            return sendJson(res, 200, { supervised: true, status: reply.body });
          } catch {
            return sendJson(res, 503, { error: 'The supervisor is not answering on its control socket. Run buddi in a terminal.' });
          }
        }
        /*
         * First run: where the record stands, and what the wizard still has to
         * ask for. A read, and only a read — an installation that has never
         * been asked anything must not acquire a row because a page loaded.
         */
        /*
         * Recovery: the checklist a restored installation has to get through.
         * Read-only, and it says `active: false` on an installation that was
         * never restored rather than 404 — the shell asks unconditionally.
         */
        case '/api/recovery':
          return sendJson(res, 200, await readRecoveryView({ pool: deps.pool, env: deps.env ?? process.env }, deps.ctx.ownerId));
        case '/api/backups':
          return reply(res, await listBackups(backupDeps()));
        case '/api/backups/schedule':
          return reply(res, await scheduleRoute(backupDeps(), 'GET'));
        case '/api/backups/passphrase':
          return reply(res, await passphraseRoute(backupDeps(), 'GET'));
        /*
         * Plugins: what is installed, what is staged and waiting to be read,
         * and the trust sentence the page shows above the install field. A
         * read, and only a read — nothing is fetched by a page loading.
         */
        case '/api/plugins':
          return reply(res, await listPlugins(pluginDeps()));
        case '/api/onboarding':
          return sendJson(res, 200, await readOnboarding(onboardingDeps()));
        /*
         * Is Ollama running on this machine? Asked from here, never from the
         * page: the dashboard bundle reaches no host but its own, and the
         * answer is about the machine buddi runs on rather than the browser's.
         */
        case '/api/onboarding/ollama':
          return sendJson(res, 200, await probeOllama());
        case '/api/telegram':
          return sendJson(res, 200, await telegramStatus(telegramDeps()));
        case '/api/owner': {
          const profile = await getOwnerProfile(deps.pool);
          return sendJson(res, 200, { ...profile, detectedTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone, zones: knownTimezones() });
        }
        case '/api/memory': {
          try {
            return sendJson(res, 200, await listMemory(deps.pool, deps.now()));
          } catch (err) {
            return sendJson(res, 503, { error: `Memory is unavailable: ${err instanceof Error ? err.message : String(err)}` });
          }
        }
        case '/api/provider-accounts':
          if (!deps.providerAccounts) return sendJson(res, 503, { error: 'Provider accounts are unavailable in this process.' });
          await deps.providerAccounts.refresh();
          return sendJson(res, 200, deps.providerAccounts.view(session.id));
        case '/api/providers':
          if (!deps.providerSettings) return sendJson(res, 503, { error: 'Provider management is unavailable in this process.' });
          return sendJson(res, 200, deps.providerSettings.view());
        default:
          break;
      }

      const backupJob = /^\/api\/backups\/jobs\/([0-9a-f-]{36})$/i.exec(path);
      if (backupJob) return reply(res, await backupJobRoute(backupDeps(), backupJob[1] as string));

      const pluginJob = /^\/api\/plugins\/jobs\/([0-9a-f-]{36})$/i.exec(path);
      if (pluginJob) return reply(res, pluginJobRoute(pluginDeps(), pluginJob[1] as string));

      const conversation = /^\/api\/conversations\/([^/]+)$/.exec(path);
      if (conversation) {
        const transcript = await readConversation(deps.pool, decodeURIComponent(conversation[1] as string));
        if (!transcript) return sendJson(res, 404, { error: 'no such conversation' });
        return sendJson(res, 200, transcript);
      }

      // One action, whole: the envelope the approval is bound to and the
      // preview the *tool* rendered. The canvas draws it from this, so it can
      // show what would actually happen rather than a summary of a summary.
      /*
       * One agent, whole: its grant with every tool's tier, its engine, its
       * skills, its delegates. A read and only ever a read — a change to any of
       * it goes through the maker agent, where it becomes an approval.
       */
      const avatar = /^\/api\/agents\/([^/]+)\/avatar$/.exec(path);
      if (avatar) {
        const agent = deps.catalog.get(decodeURIComponent(avatar[1]!));
        const name = agent?.avatar;
        if (!agent || !name || !AVATAR_IMAGE.test(name)) return sendEmpty(res, 404);
        const file = path_.join(path_.dirname(agent.file), name);
        let bytes: Buffer;
        try { bytes = readFileSync(file); } catch { return sendEmpty(res, 404); }
        const ext = name.toLowerCase().split('.').pop()!;
        res.setHeader('Content-Type', ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.end(method === 'HEAD' ? undefined : bytes);
        return;
      }
      const profile = /^\/api\/agents\/([^/]+)\/profile$/.exec(path);
      if (profile) {
        const view = readAgentProfile(
          { catalog: deps.catalog, registry: deps.registry },
          decodeURIComponent(profile[1] as string),
        );
        if (!view) return sendJson(res, 404, { error: 'no such agent' });
        return sendJson(res, 200, view);
      }

      const approval = /^\/api\/approvals\/([^/]+)$/.exec(path);
      if (approval) {
        const action = await getAction(deps.pool, decodeURIComponent(approval[1] as string));
        if (!action) return sendJson(res, 404, { error: 'no such action' });
        return sendJson(res, 200, { action: { ...toApprovalView(action), ...permissionScopes(action.tool) } });
      }

      /* ---------------- chat ---------------- */

      const groupConversations = /^\/api\/groups\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/conversations$/i.exec(path);
      if (groupConversations) {
        const group = await getGroup(deps.pool, groupConversations[1]!);
        if (!group) return sendJson(res, 404, { error: 'no such group' });
        const rows = await listGroupConversations(deps.pool, group.id);
        // The same shape an agent's list has, so the page draws both alike.
        return sendJson(res, 200, {
          conversations: rows.map((row) => ({
            id: row.id,
            createdAt: row.createdAt.toISOString(),
            startedAt: row.createdAt.toISOString(),
            lastMessageAt: row.lastAt?.toISOString() ?? null,
            messageCount: row.messages,
            ...(row.first ? { preview: row.first, opening: row.first } : {}),
          })),
        });
      }
      const groupOne = /^\/api\/groups\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(path);
      if (groupOne) {
        const group = await getGroup(deps.pool, groupOne[1]!);
        if (!group) return sendJson(res, 404, { error: 'no such group' });
        const latest = await latestGroupConversation(deps.pool, group.id);
        const open = latest ? await openGroupRequest(deps.pool, latest) : null;
        return sendJson(res, 200, { ...groupView(group), latestConversationId: latest, openRequest: open ? { id: open.id, state: open.state, awaitingAgentId: open.awaitingAgentId, budgetReserved: open.budgetReserved, budgetTotal: open.budgetTotal } : null });
      }
      const chatConversations = /^\/api\/chat\/([^/]+)\/conversations$/.exec(path);
      if (chatConversations) {
        const agentId = decodeURIComponent(chatConversations[1] as string);
        if (!deps.catalog.get(agentId)) {
          return sendJson(res, 404, { error: `no such agent: ${agentId}` });
        }
        return sendJson(res, 200, {
          conversations: await readChatConversations(
            deps.pool,
            agentId,
            boundedLimit(q.get('limit'), CHAT_CONVERSATIONS_LIMIT),
          ),
        });
      }

      const transcript = /^\/api\/chat\/conversations\/([^/]+)$/.exec(path);
      if (transcript) {
        const found = await readChatTranscript(
          deps.pool,
          decodeURIComponent(transcript[1] as string),
        );
        if (!found) return sendJson(res, 404, { error: 'no such conversation' });
        return sendJson(res, 200, found);
      }

      /*
       * The attention stream: the same event log, tailed without a conversation
       * filter, so a badge lights up for an agent the owner is *not* looking at.
       * It carries no payload — one frame means "ask `/api/chat/attention`
       * again" — which is what keeps the definition of waiting in one place.
       */
      if (path === '/api/chat/attention/stream') {
        const release = streams.take(session.id);
        if (release === null) return sendEmpty(res, 429);
        try {
          await streamAttention(req, res, {
            pool: deps.pool,
            since: resumeCursor(req, q.get('since')),
            now: deps.now,
          });
        } finally {
          release();
        }
        return;
      }

      const stream = /^\/api\/chat\/conversations\/([^/]+)\/stream$/.exec(path);
      if (stream) {
        const conversationId = decodeURIComponent(stream[1] as string);
        if ((await conversationAgent(deps.pool, conversationId)) === null) {
          return sendJson(res, 404, { error: 'no such conversation' });
        }
        // One page, many tabs, but not unboundedly many: each stream is a live
        // socket and a poll, and a leaked EventSource would be both forever.
        const release = streams.take(session.id);
        if (release === null) return sendEmpty(res, 429);
        try {
          await streamConversation(req, res, {
            pool: deps.pool,
            conversationId,
            since: resumeCursor(req, q.get('since')),
            now: deps.now,
            ...(chat ? { live: chat.live } : {}),
          });
        } finally {
          release();
        }
        return;
      }

      return sendJson(res, 404, { error: 'no such endpoint' });
    }

    /*
     * The owner took a file back out of the composer. Only a web upload that no
     * message carries can go this way: a file already sent belongs to its
     * message, and a file a surface or an agent made is not the page's to drop.
     */
    if (method === 'DELETE') {
      const discard = /^\/api\/artifacts\/([0-9a-f-]{36})$/.exec(path);
      if (!discard) return sendEmpty(res, 405);
      const outcome = await discardUnreferencedUpload(deps.pool, discard[1]!, WEB_CHAT_SURFACE, deps.now());
      if (outcome === 'missing') return sendEmpty(res, 404);
      if (outcome === 'discarded') return sendEmpty(res, 204);
      return sendJson(res, 409, { error: outcome === 'referenced' ? 'This file was already sent with a message.' : 'This file did not come from the dashboard.' });
    }

    /*
     * The two settings a backup has that are edited rather than commanded. PUT
     * because they are a whole value replaced, not an action taken; the gate
     * above treats any non-GET as mutating, so they are CSRF-checked like
     * everything else.
     */
    if (method === 'PUT') {
      if (path !== '/api/backups/schedule' && path !== '/api/backups/passphrase') return sendEmpty(res, 405);
      let put: Record<string, unknown>;
      try {
        put = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { error: 'request body must be JSON' });
      }
      return reply(res, path === '/api/backups/schedule'
        ? await scheduleRoute(backupDeps(), 'PUT', put)
        : await passphraseRoute(backupDeps(), 'PUT', put));
    }

    if (method !== 'POST') return sendEmpty(res, 405);
    if (path === '/api/browser/settings' || path === '/api/browser/permissions') {
      const body = await readJsonBody(req);
      try {
        if (path.endsWith('/settings')) {
          if (!browser.configure) return sendJson(res, 409, { error: 'This host does not support changing control modes.' });
          return sendJson(res, 200, await browser.configure(body));
        }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'prompt') || ('prompt' in body && typeof body.prompt !== 'boolean')) return sendJson(res, 400, { error: 'Expected {prompt: boolean}' });
        if (!browser.checkPermissions) return sendJson(res, 409, { error: 'This host does not support native permission checks.' });
        return sendJson(res, 200, await browser.checkPermissions((body as { prompt?: boolean }).prompt === true));
      } catch (error) {
        return sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    const control = /^\/api\/browser\/(stop|takeover|resume|release)$/.exec(path);
    if (control) {
      const body = await readJsonBody(req) as { sessionId?: unknown } | null;
      if (body?.sessionId !== undefined && typeof body.sessionId !== 'string') return sendJson(res, 400, { error: 'sessionId must be a string' });
      try {
        return sendJson(res, 200, await browser.control(control[1] as 'stop' | 'takeover' | 'resume' | 'release', body?.sessionId as string | undefined));
      } catch (error) {
        return sendJson(res, 409, { error: error instanceof Error ? error.message : String(error) });
      }
    }

    /*
     * A restore from a file the owner picked on their own machine.
     *
     * Handled before the JSON body is read, for the same reason the chat
     * attachment is: `readJsonBody` caps at 64 KB and an archive is megabytes.
     * The bytes go straight to `<data>/incoming/` and the *path* the gateway
     * chose is what the supervisor is told — the browser's filename never
     * becomes a path. The passphrase and the typed-back confirmation travel as
     * headers rather than in the URL, so neither can end up in a log line.
     */
    if ((path === '/api/backups/restore' || path === '/api/onboarding/restore') &&
        !(req.headers['content-type'] ?? '').toLowerCase().includes('application/json')) {
      if (path === '/api/onboarding/restore') {
        const refusal = await onboardingRestoreRefusal();
        if (refusal) return sendJson(res, refusal.status, { error: refusal.message });
      }
      const received = await receiveUpload(backupDeps(), req, first(req.headers['x-filename']));
      if ('status' in received) return reply(res, received);
      const out = await restoreRoute(backupDeps(), {
        path: received.path,
        ...(first(req.headers['x-backup-passphrase']) === undefined ? {} : { passphrase: first(req.headers['x-backup-passphrase']) }),
        ...(path === '/api/onboarding/restore' || first(req.headers['x-backup-confirm']) === undefined
          ? {}
          : { confirm: first(req.headers['x-backup-confirm']) }),
      });
      // A refused restore leaves nothing behind: the upload is the owner's
      // file, and keeping a copy of it after saying no would be a surprise.
      if (out.status >= 400) await discardUpload(received.path);
      return reply(res, out);
    }

    /*
     * A plugin tarball the owner has on their own machine, handed over the
     * same way a backup archive is: raw bytes, the filename in a header, and
     * `readJsonBody`'s 64 KB cap never in the way. What lands on disk is
     * staged exactly like a `.tgz` path they could have typed, and the upload
     * is deleted once staging has copied it.
     */
    if (path === '/api/plugins/upload') {
      const received = await receivePluginUpload(pluginDeps(), req, first(req.headers['x-filename']));
      if ('status' in received) return reply(res, received);
      return reply(res, uploadRoute(pluginDeps(), received));
    }

    /*
     * The upload is handled before the JSON body is read, and it is the only
     * other route that is: everything else on this server is a small object, and
     * `readJsonBody` caps at 64 KB for exactly that reason. A 20 MB statement
     * would be refused by that cap before the multipart parser ever saw it.
     */
    if (path === '/api/chat/attachments') {
      if (!chat) return sendJson(res, 503, { error: CHAT_UNAVAILABLE });
      if (!deps.chat?.artifacts) return sendJson(res, 503, { error: ATTACHMENTS_UNAVAILABLE });
      const upload = await readUpload(req, MAX_UPLOAD_BYTES);
      if (!upload.ok) return sendJson(res, upload.status, { error: upload.error });
      const conversationId = url.searchParams.get('conversationId');
      const stored = await deps.chat.artifacts.save({
        bytes: upload.file.bytes,
        mime: upload.file.mime,
        filename: upload.file.filename,
        // The source names the surface and the conversation the file was
        // dropped into, which is what makes dedup per-chat rather than global:
        // the same statement dropped in two conversations is two artifacts.
        source: {
          surface: WEB_CHAT_SURFACE,
          chatId: conversationId && conversationId.trim() !== '' ? conversationId : 'web',
          messageId: randomUUID(),
        },
        createdBy: deps.ctx.ownerId,
        ...(conversationId && conversationId.trim() !== '' ? { conversationId } : {}),
      });
      return sendJson(res, 200, {
        artifactId: stored.id,
        filename: stored.filename ?? upload.file.filename,
        mime: stored.mime,
        kind: stored.kind,
        sizeBytes: stored.sizeBytes,
      });
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) return sendJson(res, 413, { error: err.message });
      return sendJson(res, 400, { error: 'request body must be JSON' });
    }

    const approval = /^\/api\/approvals\/([^/]+)\/(approve|reject)$/.exec(path);
    if (approval) {
      const scope = body.permissionScope ?? 'once';
      if (!['once', 'conversation', 'always'].includes(String(scope)) || typeof scope !== 'string') return sendJson(res, 400, { error: 'Invalid permission scope.' });
      return finish(
        res,
        await decideApprovalFromWeb(
          writeDeps,
          decodeURIComponent(approval[1] as string),
          approval[2] === 'approve' ? 'approved' : 'rejected',
          scope as PermissionScope,
        ),
      );
    }

    if (path === '/api/host/stop' || path === '/api/host/revoke') {
      const host = hostService(deps.env ?? process.env);
      if (path.endsWith('/revoke')) {
        if (typeof body.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.id)) return sendJson(res, 400, { error: 'Expected permission id.' });
        const permission = (await listToolPermissions(deps.pool, deps.ctx.ownerId)).find(p => p.id === body.id && p.tool === 'host.exec');
        if (!permission) return sendEmpty(res, 404);
        await revokeToolPermission(deps.pool, deps.ctx.ownerId, permission.id);
        host.stop(deps.ctx.ownerId, permission.agentId, permission.conversationId || undefined);
        return sendJson(res, 200, { revoked: true });
      }
      if (typeof body.agentId !== 'string' || typeof body.conversationId !== 'string') return sendJson(res, 400, { error: 'Expected agentId and conversationId.' });
      return sendJson(res, 200, { stopped: host.stop(deps.ctx.ownerId, body.agentId, body.conversationId) });
    }

    const alert = /^\/api\/alerts\/([^/]+)\/snooze$/.exec(path);
    if (alert) {
      if (typeof body.snoozed !== 'boolean') return sendJson(res, 400, { error: '`snoozed` must be true or false' });
      const finding = await snoozeFinding(deps.pool, decodeURIComponent(alert[1]!), body.snoozed, deps.now());
      if (!finding) return sendJson(res, 404, { error: 'No open alert has that key.' });
      return sendJson(res, 200, { key: finding.key, snoozedAt: finding.snoozedAt ? finding.snoozedAt.toISOString() : null });
    }

    if (path === '/api/pause') {
      const paused = body.paused;
      if (typeof paused !== 'boolean') {
        return sendJson(res, 400, { error: '`paused` must be true or false' });
      }
      return finish(res, await setPausedFromWeb(writeDeps, paused));
    }

    const missionEnabled = /^\/api\/missions\/([^/]+)\/enabled$/.exec(path);
    if (missionEnabled) {
      const enabled = body.enabled;
      if (typeof enabled !== 'boolean') {
        return sendJson(res, 400, { error: '`enabled` must be true or false' });
      }
      return finish(
        res,
        await setMissionEnabledFromWeb(
          writeDeps,
          decodeURIComponent(missionEnabled[1] as string),
          enabled,
        ),
      );
    }

    const missionSchedule = /^\/api\/missions\/([^/]+)\/schedule$/.exec(path);
    if (missionSchedule) {
      return finish(
        res,
        await setScheduleFromWeb(writeDeps, decodeURIComponent(missionSchedule[1] as string), {
          cron: typeof body.cron === 'string' ? body.cron : undefined,
          timezone: typeof body.timezone === 'string' ? body.timezone : undefined,
          misfirePolicy: typeof body.misfirePolicy === 'string' ? body.misfirePolicy : undefined,
          deadlineMinutes:
            body.deadlineMinutes === null
              ? null
              : typeof body.deadlineMinutes === 'number'
                ? body.deadlineMinutes
                : undefined,
        }),
      );
    }

    const anthropicRoute = /^\/api\/provider-accounts\/([^/]+)\/anthropic\/(login|complete-login|cancel-login|logout)$/.exec(path);
    const accountRoute = /^\/api\/provider-accounts\/([^/]+)\/(test|remove|login|cancel-login|logout|models)$/.exec(path);
    const accountAssignment = /^\/api\/agents\/([^/]+)\/account$/.exec(path);
    if (path === '/api/provider-accounts/save' || path === '/api/provider-accounts/probe-models' || accountRoute || accountAssignment || anthropicRoute) {
      if (!deps.providerAccounts) return sendJson(res, 503, { error: 'Provider accounts are unavailable in this process.' });
      try {
        const result = path === '/api/provider-accounts/probe-models'
          ? await deps.providerAccounts.probeModels(body)
          : anthropicRoute
          ? await deps.providerAccounts.anthropicAction(decodeURIComponent(anthropicRoute[1]!), anthropicRoute[2] as 'login' | 'complete-login' | 'cancel-login' | 'logout', body, session.id)
          : accountAssignment
          ? await deps.providerAccounts.assign(decodeURIComponent(accountAssignment[1]!), body)
          : accountRoute ? accountRoute[2] === 'models'
            ? await deps.providerAccounts.models(decodeURIComponent(accountRoute[1]!), body.refresh === true)
            : accountRoute[2] === 'test'
            ? await deps.providerAccounts.test(decodeURIComponent(accountRoute[1]!))
            : accountRoute[2] === 'remove'
              ? await deps.providerAccounts.remove(decodeURIComponent(accountRoute[1]!), body.revision as number)
              : await deps.providerAccounts.codexAction(decodeURIComponent(accountRoute[1]!), accountRoute[2] as 'login' | 'cancel-login' | 'logout', body.revision)
          : await deps.providerAccounts.save(body);
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error instanceof ProviderAccountError ? error.status : 500,
          { error: error instanceof ProviderAccountError ? error.message : 'Account operation failed. Check vault and database availability.' });
      }
    }
    const providerSettingsRoute = /^\/api\/providers\/(anthropic|openai)\/(settings|test)$/.exec(path);
    const credentialRoute = /^\/api\/providers\/credentials\/([^/]+)\/(save|remove)$/.exec(path);
    if (providerSettingsRoute || credentialRoute) {
      if (deps.providerAccounts) return sendJson(res, 410, { error: 'Global credentials have been replaced by named provider accounts. Reload the dashboard.' });
      if (!deps.providerSettings) return sendJson(res, 503, { error: 'Provider management is unavailable in this process.' });
      try {
        const result = providerSettingsRoute
          ? providerSettingsRoute[2] === 'test' ? await deps.providerSettings.test(providerSettingsRoute[1]!) : await deps.providerSettings.configure(providerSettingsRoute[1]!, body)
          : await deps.providerSettings.credential(credentialRoute![1]!, credentialRoute![2] as 'save' | 'remove', body);
        return sendJson(res, 200, result);
      } catch (error) {
        return sendJson(res, error instanceof ProviderSettingsError ? error.status : 500,
          { error: error instanceof ProviderSettingsError ? error.message : 'Provider settings could not be applied. Check vault access and database availability, then retry.' });
      }
    }

    /*
     * Backups, and leaving recovery.
     *
     * Every one of these is forwarded to the supervisor when there is one and
     * run in this process when there is not; `backups.ts` is where that fork
     * lives, so the routes here are the gate and nothing else.
     */
    /*
     * Plugins.
     *
     * Staging is a job because fetching and installing dependencies takes as
     * long as it takes; approving is separate and carries back the integrity
     * the owner was shown, so a click can only ever approve the thing that was
     * read about. `plugins.ts` holds every one of those decisions.
     */
    if (path === '/api/plugins/stage') return reply(res, stageRoute(pluginDeps(), body));
    const stagedApprove = /^\/api\/plugins\/staged\/([A-Za-z0-9._-]{1,128})\/(approve|reject)$/.exec(path);
    if (stagedApprove) {
      const id = stagedApprove[1] as string;
      return reply(res, stagedApprove[2] === 'approve'
        ? await approveRoute(pluginDeps(), id, body)
        : rejectRoute(pluginDeps(), id));
    }
    const pluginAction = /^\/api\/plugins\/([^/]+)\/(update|uninstall)$/.exec(path);
    if (pluginAction) {
      const name = decodeURIComponent(pluginAction[1] as string);
      return reply(res, pluginAction[2] === 'update'
        ? updateRoute(pluginDeps(), name, body)
        : await uninstallRoute(pluginDeps(), name, body));
    }

    if (path === '/api/backups') return reply(res, await createBackupRoute(backupDeps(), body));
    if (path === '/api/backups/verify') return reply(res, await verifyBackupRoute(backupDeps(), body));
    if (path === '/api/backups/restore') {
      return reply(res, await restoreRoute(backupDeps(), {
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.passphrase === 'string' ? { passphrase: body.passphrase } : {}),
        ...(typeof body.confirm === 'string' ? { confirm: body.confirm } : {}),
      }));
    }
    /*
     * First run, restoring instead of starting: the one restore that needs no
     * typed-back confirmation, because there is nothing here to lose yet. That
     * is also exactly what is checked — a pending onboarding and no agent of
     * the owner's own. The moment either is false this is an ordinary restore
     * and goes through `/api/backups/restore`, confirmation and all.
     */
    if (path === '/api/onboarding/restore') {
      const refusal = await onboardingRestoreRefusal();
      if (refusal) return sendJson(res, refusal.status, { error: refusal.message });
      return reply(res, await restoreRoute(backupDeps(), {
        ...(typeof body.name === 'string' ? { name: body.name } : {}),
        ...(typeof body.passphrase === 'string' ? { passphrase: body.passphrase } : {}),
      }));
    }
    if (path === '/api/recovery/leave') {
      if (body.dropPending !== undefined && typeof body.dropPending !== 'boolean') {
        return sendJson(res, 400, { error: '`dropPending` must be true or false' });
      }
      const keep = body.keepGrants;
      if (keep !== undefined && (!Array.isArray(keep) || keep.some((id) => typeof id !== 'string'))) {
        return sendJson(res, 400, { error: '`keepGrants` must be a list of grant ids' });
      }
      /*
       * The loops are decided once, at startup (see `serve.ts`), so leaving
       * recovery is finished by a restart rather than by flipping anything
       * live — and a row cleared without that restart is an installation that
       * says it has recovered while every loop it needs is still off.
       *
       * So the supervisor is *asked whether it is there* first, and nothing is
       * dropped or cleared when it is not: the owner is told where the button
       * is instead. The restart itself is asked for only once the reply is on
       * the wire, because it kills this process — ordering it before the work
       * meant the SIGTERM landed in the middle of dropping the pending jobs,
       * with the pool ending under the request that was clearing the row. In a
       * checkout there is no supervisor to ask and the loops start the next
       * time `buddi serve` is started by whoever started this.
       */
      const socket = (deps.env ?? process.env).BUDDI_SUPERVISOR_SOCKET;
      if (socket) {
        try {
          const reachable = await supervisorCall(socket, '/status', 'GET');
          if (reachable.status >= 300) throw new Error(`the supervisor answered ${reachable.status}`);
        } catch (err) {
          log(`web: supervisor restart after leaving recovery failed: ${err instanceof Error ? err.message : String(err)}`);
          return sendJson(res, 502, {
            error: 'Recovery is finished but the service could not be restarted; use Settings → Service → Restart',
          });
        }
      }
      const outcome = await leaveRecoveryMode(
        { pool: deps.pool, env: deps.env ?? process.env, log },
        deps.ctx.ownerId,
        { dropPending: body.dropPending !== false, keepGrants: keep as string[] | undefined },
        now,
      );
      if (socket) {
        res.once('finish', () => {
          void supervisorCall(socket, '/restart', 'POST').catch((err: unknown) => {
            log(`web: supervisor restart after leaving recovery failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        });
      }
      return sendJson(res, socket ? 202 : 200, { ...outcome, restarting: socket !== undefined });
    }

    /*
     * Start, stop or restart the gateway through the supervisor.
     *
     * Behind the same session, Origin and CSRF gate as every other write, and
     * nothing more: the socket is owner-only already.
     *
     * `start` is answered with the supervisor's new status, because the
     * gateway answering is the one that stays up. `stop` and `restart` are
     * not: the supervisor's very next act is to kill this process, and
     * `serve`'s shutdown destroys open connections, so a reply composed after
     * the action would never reach the browser. They are therefore accepted
     * first and performed once the reply is on the wire. The page warns that
     * it is about to close itself, and `buddi` from a terminal is the way back
     * from a gateway that is down — a stopped gateway cannot serve its own
     * Start button.
     */
    const serviceAction = /^\/api\/service\/(start|stop|restart)$/.exec(path);
    if (serviceAction) {
      const socket = (deps.env ?? process.env).BUDDI_SUPERVISOR_SOCKET;
      if (!socket) return sendJson(res, 404, { error: 'This gateway is not run by a supervisor; there is nothing to control.' });
      const action = serviceAction[1]!;
      if (action === 'start') {
        try {
          const reply = await supervisorCall(socket, '/start', 'POST');
          if (reply.status !== 200) return sendJson(res, 502, { error: 'The supervisor refused that action.' });
          return sendJson(res, 200, { supervised: true, status: reply.body });
        } catch {
          return sendJson(res, 503, { error: 'The supervisor is not answering on its control socket. Run buddi in a terminal.' });
        }
      }
      res.once('finish', () => {
        void supervisorCall(socket, `/${action}`, 'POST').catch((err: unknown) => {
          log(`web: supervisor ${action} failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      });
      return sendJson(res, 202, { supervised: true, pending: action });
    }

    /* Groups: create one, send to one, stop its current request. */
    if (path === '/api/groups') {
      if (!chat) return sendJson(res, 503, { error: CHAT_UNAVAILABLE });
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const coordinator = typeof body.coordinator === 'string' ? body.coordinator.trim() : '';
      if (!Array.isArray(body.members) || body.members.some((m) => typeof m !== 'string' || m.trim() === '')) return sendJson(res, 400, { error: '`members` must be a list of agent ids.' });
      const members = (body.members as string[]).map((m) => m.trim());
      if (name === '' || name.length > 80) return sendJson(res, 400, { error: 'A group needs a name, up to 80 characters.' });
      if (!deps.catalog.get(coordinator)) return sendJson(res, 400, { error: 'Pick a coordinator from the installed agents.' });
      const unknown = members.filter((m) => !deps.catalog.get(m));
      if (unknown.length > 0) return sendJson(res, 400, { error: `Not installed: ${unknown.join(', ')}` });
      if (new Set([coordinator, ...members]).size < 2) return sendJson(res, 400, { error: 'A group needs at least one member besides the coordinator.' });
      const group = await createGroup(deps.pool, { name, coordinator, members });
      return sendJson(res, 200, groupView(group));
    }
    const groupMessages = /^\/api\/groups\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/messages$/i.exec(path);
    if (groupMessages) {
      if (!chat) return sendJson(res, 503, { error: CHAT_UNAVAILABLE });
      if (typeof body.text !== 'string') return sendJson(res, 400, { error: '`text` must be a string' });
      if (body.conversationId !== undefined && typeof body.conversationId !== 'string') return sendJson(res, 400, { error: '`conversationId` must be a string' });
      const ids = body.attachmentIds;
      if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))) return sendJson(res, 400, { error: '`attachmentIds` must be an array of artifact ids' });
      const sent = await chat.sendToGroup({
        groupId: groupMessages[1]!,
        ...(typeof body.conversationId === 'string' ? { conversationId: body.conversationId } : {}),
        text: body.text,
        ...(ids ? { attachmentIds: ids as string[] } : {}),
      });
      if (!sent.ok) return sendJson(res, sent.status, { error: sent.error });
      return sendJson(res, 202, { conversationId: sent.conversationId, runId: sent.runId, requestId: sent.requestId, ...(sent.rolledOver ? { rolledOver: true } : {}) });
    }
    const groupNewConversation = /^\/api\/groups\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/conversations$/i.exec(path);
    if (groupNewConversation) {
      const group = await getGroup(deps.pool, groupNewConversation[1]!);
      if (!group) return sendJson(res, 404, { error: 'no such group' });
      return sendJson(res, 200, { conversationId: await createGroupConversation(deps.pool, group) });
    }
    const groupArchive = /^\/api\/groups\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/archive$/i.exec(path);
    if (groupArchive) {
      return (await archiveGroup(deps.pool, groupArchive[1]!, deps.now())) ? sendEmpty(res, 204) : sendEmpty(res, 404);
    }

    /*
     * First run, from the dashboard.
     *
     * Four writes against the one record core already owns. `complete` and
     * `skip` both close the machine, and closing it is what keeps the Telegram
     * interview and its nudge arc from ever opening for an owner who did this
     * here instead.
     */
    if (path === '/api/onboarding/step') {
      const step = typeof body.step === 'string' ? body.step.trim() : '';
      if (!(WEB_ONBOARDING_STEPS as readonly string[]).includes(step)) {
        return sendJson(res, 400, { error: `\`step\` must be one of ${WEB_ONBOARDING_STEPS.join(', ')}` });
      }
      // A step may carry the two facts the step name cannot: which
      // conversation the handover opened, and which account the owner chose.
      // Both are provenance a reload reads back, and both are refused as
      // anything but a string.
      for (const key of ['conversationId', 'accountId'] as const) {
        if (body[key] !== undefined && typeof body[key] !== 'string') {
          return sendJson(res, 400, { error: `\`${key}\` must be a string` });
        }
      }
      // The first step recorded is also what starts the record, with this
      // surface's name on it. Already in progress, done or skipped: unchanged.
      await beginOnboarding(deps.pool, WEB_ONBOARDING_SURFACE);
      await markStepDone(deps.pool, step);
      await setOnboardingDetails(deps.pool, {
        ...(typeof body.conversationId === 'string' ? { conversationId: body.conversationId } : {}),
        ...(typeof body.accountId === 'string' ? { accountId: body.accountId } : {}),
      });
      return sendJson(res, 200, await readOnboarding(onboardingDeps()));
    }
    if (path === '/api/onboarding/complete' || path === '/api/onboarding/skip') {
      if (path.endsWith('/skip')) {
        // The explicit bypass. It records that the owner declined, and it is
        // allowed from anywhere in the wizard — that is what makes it a skip.
        await skipOnboarding(deps.pool, 'the owner skipped the dashboard wizard');
        return sendJson(res, 200, await readOnboarding(onboardingDeps()));
      }
      const before = await readOnboarding(onboardingDeps());
      // "Done" has to mean done. An installation with no model account or no
      // agent cannot answer anything, and recording it as finished would close
      // the first run — on both surfaces — over an install that does not work.
      const missing = [
        ...(before.needs.model ? ['a model account'] : []),
        ...(before.needs.agent ? ['an agent of your own'] : []),
      ];
      if (missing.length > 0) {
        return sendJson(res, 409, {
          error: `Setup is not finished: this installation still needs ${missing.join(' and ')}. Go back and add it, or set up later.`,
          needs: before.needs,
        });
      }
      await completeOnboarding(deps.pool, WEB_ONBOARDING_SURFACE);
      return sendJson(res, 200, await readOnboarding(onboardingDeps()));
    }
    if (path === '/api/onboarding/agent') {
      try {
        const created = await createFirstAgent(onboardingDeps(), {
          name: typeof body.name === 'string' ? body.name : '',
          handle: typeof body.handle === 'string' ? body.handle : '',
          description: typeof body.description === 'string' ? body.description : '',
          ...(typeof body.avatar === 'string' ? { avatar: body.avatar } : {}),
          ...(typeof body.accountId === 'string' && body.accountId.trim() !== ''
            ? { accountId: body.accountId.trim() }
            : {}),
        });
        const view = readAgents(deps.catalog).find((agent) => agent.id === created.id);
        return sendJson(res, 200, {
          agent: view ?? null,
          id: created.id,
          handle: created.handle,
          file: created.file,
          live: created.live,
          accountId: created.assigned,
        });
      } catch (error) {
        if (error instanceof OnboardingRefusal) return sendJson(res, error.status, { error: error.message });
        return sendJson(res, 500, { error: error instanceof Error ? error.message : 'The agent could not be written.' });
      }
    }

    /*
     * The brain, changed after the assistant exists.
     *
     * Its own route because two things have to move together: the assistant
     * onto the account the thread has just tested, and the shipped maker that
     * was following it. Doing that from the page would be two calls with a
     * rule between them, and the rule belongs on this side.
     */
    if (path === '/api/onboarding/brain') {
      if (typeof body.accountId !== 'string' || typeof body.model !== 'string') {
        return sendJson(res, 400, { error: '`accountId` and `model` must be strings' });
      }
      try {
        return sendJson(res, 200, await rebindBrain(onboardingDeps(), { accountId: body.accountId, model: body.model }));
      } catch (error) {
        if (error instanceof OnboardingRefusal) return sendJson(res, error.status, { error: error.message });
        return sendJson(res, 500, { error: error instanceof Error ? error.message : 'That account could not be given to your assistant.' });
      }
    }

    /*
     * "Change either, or keep them" — after the assistant exists.
     *
     * Writing a *first* agent is refused once there is one, and the thread
     * promises the owner can still change its name, face and purpose. Same
     * file, same writer, reloaded in place: no second agent appears.
     */
    if (path === '/api/onboarding/agent/update') {
      try {
        const changed = updateFirstAgent(onboardingDeps(), {
          ...(typeof body.name === 'string' ? { name: body.name } : {}),
          ...(typeof body.description === 'string' ? { description: body.description } : {}),
          ...(typeof body.avatar === 'string' ? { avatar: body.avatar } : {}),
        });
        const view = readAgents(deps.catalog).find((agent) => agent.id === changed.id);
        return sendJson(res, 200, { agent: view ?? null, ...changed, accountId: null });
      } catch (error) {
        if (error instanceof OnboardingRefusal) return sendJson(res, error.status, { error: error.message });
        return sendJson(res, 500, { error: error instanceof Error ? error.message : 'The assistant could not be changed.' });
      }
    }

    /*
     * Telegram, without a terminal: the token BotFather gave the owner, and
     * then a pairing code for the phone. Both behind the same session, Origin
     * and CSRF gate as every other write — this is the owner acting on their
     * own installation.
     */
    if (path === '/api/telegram/token' || path === '/api/telegram/pairing') {
      try {
        return sendJson(
          res,
          200,
          path === '/api/telegram/token'
            ? await saveTelegramToken(telegramDeps(), body.token)
            : await telegramPairing(telegramDeps()),
        );
      } catch (error) {
        if (error instanceof TelegramWebError) return sendJson(res, error.status, { error: error.message });
        return sendJson(res, 500, { error: 'Telegram could not be set up from here.' });
      }
    }

    /*
     * The owner's own profile. What an agent may write through owner.set_profile
     * the owner may write here directly; the same validation, the same row.
     */
    if (path === '/api/owner') {
      const patch: OwnerProfilePatch = {};
      for (const key of ['preferredName', 'timezone', 'language', 'about'] as const) {
        const given = body[key];
        if (given === undefined) continue;
        if (given !== null && typeof given !== 'string') return sendJson(res, 400, { error: `\`${key}\` must be a string or null` });
        patch[key] = given as string | null;
      }
      if (patch.timezone && !isKnownTimezone(patch.timezone)) return sendJson(res, 400, { error: `"${patch.timezone}" is not a timezone this host knows.` });
      if (patch.preferredName && patch.preferredName.length > 80) return sendJson(res, 400, { error: 'The name is too long (80 characters at most).' });
      if (patch.about && patch.about.length > 1000) return sendJson(res, 400, { error: 'Keep the line about you under 1,000 characters.' });
      const profile = await setOwnerProfile(deps.pool, patch);
      return sendJson(res, 200, { ...profile, detectedTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone, zones: knownTimezones() });
    }

    /* Memory, the owner's side: correct a preference, retire one, edit or forget a note. */
    if (path === '/api/memory/preferences') {
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      const value = typeof body.value === 'string' ? body.value.trim() : '';
      const scope = typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : 'shared';
      if (!/^[a-z0-9_]{1,120}$/.test(key)) return sendJson(res, 400, { error: 'A preference key is lower_snake_case, up to 120 characters.' });
      if (value === '' || value.length > 2000) return sendJson(res, 400, { error: 'A preference needs a value, up to 2,000 characters.' });
      if (scope !== 'shared' && !deps.catalog.list().some((agent) => agent.id === scope)) return sendJson(res, 400, { error: 'The scope must be shared or an agent id.' });
      return sendJson(res, 200, await setPreference(deps.pool, { key, value, scope, now: deps.now() }));
    }
    if (path === '/api/memory/preferences/forget') {
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      const scope = typeof body.scope === 'string' && body.scope.trim() !== '' ? body.scope.trim() : 'shared';
      if (key === '') return sendJson(res, 400, { error: '`key` is required' });
      const forgotten = await forgetPreference(deps.pool, { key, scope, now: deps.now() });
      return forgotten ? sendEmpty(res, 204) : sendEmpty(res, 404);
    }
    const noteRoute = /^\/api\/memory\/notes\/([0-9a-f-]{36})(\/forget)?$/.exec(path);
    if (noteRoute) {
      const id = noteRoute[1]!;
      if (noteRoute[2]) {
        return (await forgetNote(deps.pool, { id, now: deps.now() })) ? sendEmpty(res, 204) : sendEmpty(res, 404);
      }
      const change: { content?: string; scope?: string; kind?: string } = {};
      if (body.content !== undefined) {
        if (typeof body.content !== 'string' || body.content.trim() === '' || body.content.length > 2000) return sendJson(res, 400, { error: 'A note is one to 2,000 characters.' });
        change.content = body.content.trim();
      }
      if (body.scope !== undefined) {
        if (typeof body.scope !== 'string' || (body.scope !== 'shared' && !deps.catalog.list().some((agent) => agent.id === body.scope))) return sendJson(res, 400, { error: 'The scope must be shared or an agent id.' });
        change.scope = body.scope;
      }
      if (body.kind !== undefined) {
        if (body.kind !== 'fact' && body.kind !== 'observation' && body.kind !== 'todo') return sendJson(res, 400, { error: '`kind` must be fact, observation or todo' });
        change.kind = body.kind;
      }
      const updated = await updateNote(deps.pool, { id, ...change });
      return updated ? sendJson(res, 200, updated) : sendEmpty(res, 404);
    }

    const delegatesRoute = /^\/api\/agents\/([^/]+)\/delegates$/.exec(path);
    if (delegatesRoute) {
      const search = agentSearchPath(deps.env ?? process.env);
      return finish(
        res,
        await setDelegatesFromWeb(
          { catalog: deps.catalog, agentsDir: search.owner.dir, examplesDir: EXAMPLES_AGENTS_DIR, reload: () => (deps.catalog as { reload?: () => void }).reload?.() },
          decodeURIComponent(delegatesRoute[1] as string),
          body.delegates,
        ),
      );
    }

    const engine = /^\/api\/agents\/([^/]+)\/engine$/.exec(path);
    if (engine) {
      if (deps.providerAccounts && (body.provider !== undefined || body.model !== undefined)) {
        return sendJson(res, 400, { error: 'Choose the account and model using the account selector; global provider choices are no longer used.' });
      }
      const change = engineChangeFromBody(body);
      if (typeof change === 'string') return sendJson(res, 400, { error: change });
      return finish(
        res,
        setAgentEngineFromWeb(
          { catalog: deps.catalog, env: deps.env ?? process.env },
          decodeURIComponent(engine[1] as string),
          change,
        ),
      );
    }

    const job = /^\/api\/jobs\/([^/]+)\/(retry|cancel)$/.exec(path);
    if (job) {
      const jobId = decodeURIComponent(job[1] as string);
      return finish(
        res,
        job[2] === 'retry'
          ? await retryJobFromWeb(writeDeps, jobId)
          : await cancelJobFromWeb(writeDeps, jobId),
      );
    }

    const offer = /^\/api\/offers\/([^/]+)\/take$/.exec(path);
    if (offer) {
      return finish(res, await takeOfferFromWeb(writeDeps, decodeURIComponent(offer[1] as string)));
    }

    const reminder = /^\/api\/reminders\/([^/]+)\/cancel$/.exec(path);
    if (reminder) {
      return finish(
        res,
        await cancelReminderFromWeb(
          writeDeps,
          decodeURIComponent(reminder[1] as string),
          typeof body.reason === 'string' ? body.reason : '',
        ),
      );
    }

    /* ---------------- chat ---------------- */

    const newConversation = /^\/api\/chat\/([^/]+)\/conversations$/.exec(path);
    if (newConversation) {
      if (!chat) return sendJson(res, 503, { error: CHAT_UNAVAILABLE });
      const created = await chat.newConversation(decodeURIComponent(newConversation[1] as string));
      if (!created.ok) return sendJson(res, created.status, { error: created.error });
      return sendJson(res, 200, { conversationId: created.conversationId });
    }

    const messages = /^\/api\/chat\/([^/]+)\/messages$/.exec(path);
    if (messages) {
      if (!chat) return sendJson(res, 503, { error: CHAT_UNAVAILABLE });
      if (typeof body.text !== 'string') {
        return sendJson(res, 400, { error: '`text` must be a string' });
      }
      if (body.conversationId !== undefined && typeof body.conversationId !== 'string') {
        return sendJson(res, 400, { error: '`conversationId` must be a string' });
      }
      const ids = body.attachmentIds;
      if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))) {
        return sendJson(res, 400, { error: '`attachmentIds` must be an array of artifact ids' });
      }
      /*
       * The one turn first run sends on the owner's behalf.
       *
       * Claimed against the onboarding record before it is queued, so a reload
       * mid-handover rejoins the conversation it already started instead of
       * opening a second one and having the assistant introduce itself twice.
       * It needs a conversation to claim, so it is refused without one.
       */
      if (body.opening === true) {
        if (typeof body.conversationId !== 'string') {
          return sendJson(res, 400, { error: '`opening` needs the conversation it opens' });
        }
        try {
          await claimOpeningTurn(onboardingDeps(), body.conversationId);
        } catch (error) {
          if (error instanceof OnboardingRefusal) return sendJson(res, error.status, { error: error.message });
          throw error;
        }
      }
      const sent = await chat.send({
        agentId: decodeURIComponent(messages[1] as string),
        ...(typeof body.conversationId === 'string' ? { conversationId: body.conversationId } : {}),
        text: body.opening === true ? await withFirstRunFacts(onboardingDeps(), body.text) : body.text,
        ...(ids ? { attachmentIds: ids as string[] } : {}),
        ...(body.opening === true ? { opening: true } : {}),
      });
      if (!sent.ok) return sendJson(res, sent.status, { error: sent.error });
      // 202: the turn is *accepted*, not answered. What happens next is on the
      // stream, which is where a run that takes forty seconds belongs.
      return sendJson(res, 202, {
        conversationId: sent.conversationId,
        runId: sent.runId,
        // Present only when the conversation the page was in had ended and this
        // message opened a new one. The page follows the id either way; the
        // note is what stops the empty thread reading as amnesia.
        ...(sent.boundary ? { boundary: sent.boundary } : {}),
      });
    }

    const questionAnswer = /^\/api\/chat\/questions\/([^/]+)\/answer$/.exec(path);
    if (questionAnswer) {
      if (!chat) return sendJson(res, 503, { error: CHAT_UNAVAILABLE });
      if (typeof body.answer !== 'string' || body.answer.trim() === '') {
        return sendJson(res, 400, { error: '`answer` must be a non-empty string' });
      }
      if (body.optionId !== undefined && typeof body.optionId !== 'string') {
        return sendJson(res, 400, { error: '`optionId` must be a string' });
      }
      const answered = await chat.answer({
        id: decodeURIComponent(questionAnswer[1] as string),
        answer: body.answer,
        ...(typeof body.optionId === 'string' ? { optionId: body.optionId } : {}),
      });
      if (!answered.ok) return sendJson(res, answered.status, { error: answered.error });
      return sendJson(res, 202, answered);
    }

    const cancel = /^\/api\/chat\/conversations\/([^/]+)\/cancel$/.exec(path);
    if (cancel && chat && (await conversationGroup(deps.pool, decodeURIComponent(cancel[1]!)).catch(() => null))) {
      await chat.stopGroupRequest(decodeURIComponent(cancel[1]!));
      return sendJson(res, 200, { stopped: true });
    }
    if (cancel) {
      hostService(deps.env ?? process.env).stop(deps.ctx.ownerId, undefined, decodeURIComponent(cancel[1]!));
      if (!chat) return sendJson(res, 503, { error: CHAT_UNAVAILABLE });
      return sendJson(res, 200, {
        cancelled: chat.cancel(decodeURIComponent(cancel[1] as string)),
      });
    }

    return sendJson(res, 404, { error: 'no such endpoint' });
  }

  function finish(res: ServerResponse, result: WriteResult<unknown>): void {
    sendJson(res, result.status, result.body);
  }
}

/**
 * Start the dashboard. The token is resolved (and created on first run) before
 * the socket is bound, so a process that cannot keep a secret never listens.
 */
export async function startWebServer(
  deps: Omit<WebServerDeps, 'token'> & { token?: string },
): Promise<WebServer> {
  const token = deps.token ?? (await ensureWebToken()).token;
  const server = createWebApp({ ...deps, token });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(deps.config.port, deps.config.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  const port = address?.port ?? deps.config.port;
  return {
    server,
    port,
    url: webUrl({ host: deps.config.host, port }),
    chat: webChatOf(server),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
