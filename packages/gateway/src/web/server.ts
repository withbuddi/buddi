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
import { randomUUID } from 'node:crypto';
import { continueBrowserTask } from '../surfaces/browser-continuation.js';
import { ProviderSettingsError, type ProviderSettings } from '../providers.js';
import { ProviderAccountError, type ProviderAccounts } from '../provider-accounts.js';
import { listBrowserProfiles, listInstalledApps } from './apps.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentCatalog, JobControl, JobState, ToolContext, ToolRegistry } from '@buddi/core';
import { getAction, isJobState, snoozeFinding } from '@buddi/core';
import type { Pool } from 'pg';
import { hostBrowser, type BrowserController } from '@buddi/tool-browser';
import { hostService } from '@buddi/tool-host';
import { listToolPermissions, revokeToolPermission, getArtifact, readArtifactBytes, type PermissionScope } from '@buddi/core';
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
  const openAccess = deps.openAccess ?? isLoopback(deps.config.host);

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

    if (method === 'GET' || method === 'HEAD') {
      const download = /^\/api\/artifacts\/([0-9a-f-]{36})\/(download|preview)$/.exec(path);
      if (download) {
        const artifact = await getArtifact(deps.pool, download[1]!);
        if (!artifact) return sendEmpty(res, 404);
        const preview = download[2] === 'preview';
        // Only passive raster formats can be displayed inline on our origin.
        // SVG/HTML and all other outputs remain attachment-only downloads.
        if (preview && !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(artifact.mime)) return sendEmpty(res, 415);
        const bytes = await readArtifactBytes(deps.env ?? process.env, artifact);
        res.setHeader('Content-Type', preview ? artifact.mime : 'application/octet-stream');
        res.setHeader('Content-Disposition', `${preview ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(artifact.filename ?? 'download').replace(/'/g, '%27')}`);
        if (preview) res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
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
          });
        } finally {
          release();
        }
        return;
      }

      return sendJson(res, 404, { error: 'no such endpoint' });
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
     * The upload is handled before the JSON body is read, and it is the only
     * route that is: everything else on this server is a small object, and
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
      const sent = await chat.send({
        agentId: decodeURIComponent(messages[1] as string),
        ...(typeof body.conversationId === 'string' ? { conversationId: body.conversationId } : {}),
        text: body.text,
        ...(ids ? { attachmentIds: ids as string[] } : {}),
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
