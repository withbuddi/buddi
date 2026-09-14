/**
 * The dashboard's HTTP server — bound to loopback, session-authenticated,
 * CSRF-checked, and CORS-free.
 *
 * ARCHITECTURE.md, "Owner and surface authentication": *«Web UI: session auth,
 * CSRF protection, Origin checks, bound to localhost by default (remote access
 * = explicit authenticated transport).»* Each clause is enforced here, in this
 * order, before any handler sees a request:
 *
 *   1. **Rate limit.** Failed authentications are counted per address; over
 *      budget is `429` with no body.
 *   2. **The ticket exchange.** A `?t=` on any GET is verified against the
 *      installation's token, spent once, and answered with a redirect to a
 *      clean URL carrying an HttpOnly session cookie. The token never appears
 *      in a log line, an error, or the redirect target.
 *   3. **The session.** Anything else without a live session cookie is `401`
 *      with an empty body. Not a message, not a `WWW-Authenticate`, not a
 *      different status for "expired" — one bit, and no hint.
 *   4. **Writes.** A mutating method additionally needs the double-submit CSRF
 *      header to match its cookie *and* an `Origin`/`Referer` that is the bound
 *      address. Either failing is `403`, empty.
 *
 * No `Access-Control-*` header is ever emitted, and `OPTIONS` is refused: a
 * page on another origin gets no preflight and no permission.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AgentCatalog, JobControl, JobState, ToolContext, ToolRegistry } from '@buddi/core';
import { isJobState } from '@buddi/core';
import type { Pool } from 'pg';
import { allowedOrigins, webAssetsDir, webUrl, type WebConfig } from './config.js';
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
  readReminders,
  readSentinels,
} from './read.js';
import { RateLimiter, SessionStore, SpentTickets, SESSION_TTL_MS } from './sessions.js';
import { BUILD_MISSING, serveAsset } from './static.js';
import { ensureWebToken, verifyTicket } from './token.js';
import {
  cancelJobFromWeb,
  cancelReminderFromWeb,
  decideApprovalFromWeb,
  retryJobFromWeb,
  setMissionEnabledFromWeb,
  setPausedFromWeb,
  setScheduleFromWeb,
  type WriteDeps,
  type WriteResult,
} from './write.js';

export interface WebServerDeps {
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
  /** Where the built UI lives. Defaults to `packages/web/dist`. */
  assetsDir?: string | undefined;
  log?: ((line: string) => void) | undefined;
}

export interface WebServer {
  server: Server;
  /** The port actually bound — resolved after `listen`, so `0` works in tests. */
  port: number;
  url: string;
  close(): Promise<void>;
}

/** The query parameter carrying a one-time ticket. */
export const TICKET_PARAM = 't';

export function createWebApp(deps: WebServerDeps): Server {
  const sessions = new SessionStore();
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
      originCache = { port: bound, set: new Set(allowedOrigins({ host: deps.config.host, port: bound })) };
    }
    return originCache.set;
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      // A defect is a 500 with nothing in it. The sentence goes to the log,
      // where only the owner can read it.
      log(`web: ${req.method} ${req.url} failed: ${err instanceof Error ? err.stack : String(err)}`);
      if (!res.headersSent) sendEmpty(res, 500);
      else res.end();
    });
  });

  return server;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const now = deps.now();
    const method = (req.method ?? 'GET').toUpperCase();
    const url = parseUrl(req);
    const key = remoteKey(req);

    // No CORS, and therefore no preflight.
    if (method === 'OPTIONS') return sendEmpty(res, 405);

    if (limiter.blocked(key, now)) return sendEmpty(res, 429);

    // The ticket exchange. Only ever on a GET, and only ever once per ticket.
    const ticket = url.searchParams.get(TICKET_PARAM);
    if (ticket !== null && (method === 'GET' || method === 'HEAD')) {
      const check = verifyTicket(deps.token, ticket, now);
      if (!check.ok || !spent.spend(check.nonce, check.expiresAt, now)) {
        limiter.fail(key, now);
        // Never says which of "wrong", "expired" and "already used" it was.
        return sendEmpty(res, 401);
      }
      limiter.reset(key);
      const session = sessions.create(now);
      const clean = new URL(url.toString());
      clean.searchParams.delete(TICKET_PARAM);
      const maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000);
      return sendEmpty(res, 302, {
        Location: `${clean.pathname}${clean.search}`,
        'Set-Cookie': [
          cookieHeader(SESSION_COOKIE, session.id, { httpOnly: true, maxAgeSeconds }),
          // Readable by the page on purpose: it is the half of the
          // double-submit pair the page has to echo back in a header.
          cookieHeader(CSRF_COOKIE, session.csrf, { httpOnly: false, maxAgeSeconds }),
        ],
      });
    }

    const cookies = parseCookies(req.headers.cookie);
    const session = sessions.get(cookies[SESSION_COOKIE], now);
    if (!session) {
      limiter.fail(key, now);
      return sendEmpty(res, 401);
    }

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
      return api(req, res, url, method, now, session.csrf);
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
    csrf: string,
  ): Promise<void> {
    const path = url.pathname.replace(/\/+$/, '') || '/api';
    const q = url.searchParams;

    if (method === 'GET' || method === 'HEAD') {
      switch (path) {
        case '/api/session':
          return sendJson(res, 200, {
            csrf,
            timezone: deps.timezone,
            host: deps.config.host,
            port: deps.config.port,
          });
        case '/api/overview':
          return sendJson(
            res,
            200,
            await readOverview({
              pool: deps.pool,
              registry: deps.registry,
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
        case '/api/approvals':
          return sendJson(
            res,
            200,
            await readApprovals(deps.pool, now, boundedLimit(q.get('limit'), 50)),
          );
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
        case '/api/agents':
          return sendJson(res, 200, { agents: readAgents(deps.catalog) });
        default:
          break;
      }

      const conversation = /^\/api\/conversations\/([^/]+)$/.exec(path);
      if (conversation) {
        const transcript = await readConversation(deps.pool, decodeURIComponent(conversation[1] as string));
        if (!transcript) return sendJson(res, 404, { error: 'no such conversation' });
        return sendJson(res, 200, transcript);
      }

      return sendJson(res, 404, { error: 'no such endpoint' });
    }

    if (method !== 'POST') return sendEmpty(res, 405);

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err instanceof BodyTooLargeError) return sendJson(res, 413, { error: err.message });
      return sendJson(res, 400, { error: 'request body must be JSON' });
    }

    const approval = /^\/api\/approvals\/([^/]+)\/(approve|reject)$/.exec(path);
    if (approval) {
      return finish(
        res,
        await decideApprovalFromWeb(
          writeDeps,
          decodeURIComponent(approval[1] as string),
          approval[2] === 'approve' ? 'approved' : 'rejected',
        ),
      );
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
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
