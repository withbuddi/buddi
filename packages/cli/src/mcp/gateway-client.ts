/**
 * The loopback client `buddi mcp` speaks to the running gateway with.
 *
 * It is the dashboard's own HTTP API, reached the way `buddi dashboard` reaches
 * it (docs/mcp.md §3): the installation's token is turned into a five-minute
 * ticket and exchanged for a session exactly as the dashboard link is — on the
 * open loopback binding too, because only a ticket's session is one the lock
 * screen does not cover. The token itself never leaves this process.
 *
 * Writes carry the session's CSRF header and the dashboard's own origin, like
 * the page does. Every request goes through the one shared transport — one
 * connection per request, nothing pooled — like every other caller here. The only write this client is ever asked to make is
 * `POST /api/mcp/request` (and a chat message for `buddi.ask`): every change
 * becomes an approval on the gateway's side.
 */
import { createHmac, randomBytes } from 'node:crypto';
import {
  csrfCookieName,
  CSRF_HEADER,
  sessionCookieName,
  portOf,
  defaultHttpTransport,
  ensureWebToken,
  isLoopback,
  mintTicket,
  webConfig,
  webUrl,
  WEB_ENABLED_VAR,
  type HttpTransport,
  type TransportResponse,
} from '@buddi/gateway';

/** The header buddi's own clients name themselves with (docs/dashboard.md, "Lock screen"). */
export const CLIENT_HEADER = 'x-buddi-client';

/** The one sentence every call answers with when there is nothing to talk to. */
export const NOT_RUNNING =
  'buddi is not running on this Mac (nothing answered on the dashboard port). Start it with `buddi service start`, then try again.';

export class GatewayUnavailable extends Error {
  constructor(message = NOT_RUNNING) {
    super(message);
    this.name = 'GatewayUnavailable';
  }
}

/** The gateway answered, and said no. `message` is its own sentence. */
export class GatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'GatewayError';
  }
}

export interface Gateway {
  get<T = unknown>(path: string): Promise<T>;
  /** A write; `status` is returned because 202 and 200 mean different things. */
  post<T = unknown>(path: string, body: unknown): Promise<{ status: number; body: T }>;
}

/** Said after every sign-in failure: what most often fixes it. */
const STALE_HINT = 'If buddi was upgraded or moved since this MCP server started, restart the server (in Claude Code: /mcp, then reconnect buddi).';

/** How long a failed sign-in is answered from memory before the gateway is asked again. */
export const SIGN_IN_RETRY_MS = 30_000;

export interface GatewayClientOptions {
  baseUrl: string;
  /**
   * The installation's dashboard token, when the binding is not open. Used to
   * check that the gateway on `baseUrl` holds the same token (`/_buddi/ready`)
   * before a ticket minted from it is ever presented there, and then to mint it.
   */
  token?: (() => Promise<string>) | undefined;
  /**
   * The binding is open (loopback, no sign-in asked): when the token cannot be
   * read, sign in the open way instead of failing. That session is a
   * browser's, so a PIN locks it; only a ticket makes a session the lock
   * screen does not cover.
   */
  openFallback?: boolean;
  /** A five-minute ticket, for a caller that holds no token. Presented unchecked. */
  ticket?: (() => Promise<string>) | undefined;
  transport?: HttpTransport;
  now?: () => number;
}

export class GatewayClient implements Gateway {
  readonly #base: string;
  readonly #ticket: (() => Promise<string>) | undefined;
  readonly #token: (() => Promise<string>) | undefined;
  readonly #openFallback: boolean;
  readonly #transport: HttpTransport;
  readonly #now: () => number;
  /** The last sign-in failure, answered from memory until `until`. */
  #failed: { error: Error; until: number } | undefined;
  /** The session this client holds: its cookie, and the CSRF value it pairs with. */
  #session: { id: string; csrf: string; cookie: string } | undefined;
  #signedIn: Promise<void> | undefined;

  constructor(opts: GatewayClientOptions) {
    this.#base = opts.baseUrl.replace(/\/+$/, '');
    this.#ticket = opts.ticket;
    this.#token = opts.token;
    this.#openFallback = opts.openFallback === true;
    this.#transport = opts.transport ?? defaultHttpTransport;
    this.#now = opts.now ?? (() => Date.now());
  }

  get baseUrl(): string {
    return this.#base;
  }

  async get<T = unknown>(path: string): Promise<T> {
    const res = await this.#request(path, 'GET');
    return (await this.#read(res)) as T;
  }

  async post<T = unknown>(path: string, body: unknown): Promise<{ status: number; body: T }> {
    const res = await this.#request(path, 'POST', JSON.stringify(body ?? {}));
    return { status: res.status, body: (await this.#read(res)) as T };
  }

  /** A delete, as the dashboard's Disconnect sends it: no body, the same CSRF pair. */
  async delete<T = unknown>(path: string): Promise<{ status: number; body: T }> {
    const res = await this.#request(path, 'DELETE');
    return { status: res.status, body: (await this.#read(res)) as T };
  }

  async #send(path: string, method: string, headers: Record<string, string>, body?: string): Promise<TransportResponse> {
    try {
      // Named on every request: on the ticket exchange it makes the session a
      // client's, which the dashboard's lock screen does not cover.
      return await this.#transport(`${this.#base}${path}`, { method, headers: { ...headers, [CLIENT_HEADER]: 'mcp' }, ...(body !== undefined ? { body } : {}) });
    } catch {
      this.#session = undefined;
      this.#signedIn = undefined;
      throw new GatewayUnavailable();
    }
  }

  async #request(path: string, method: string, body?: string, retried = false): Promise<TransportResponse> {
    await this.#signIn();
    const session = this.#session!;
    const headers: Record<string, string> = { cookie: `${session.cookie}=${session.id}; ${csrfCookieName(portOf(new URL(this.#base)))}=${session.csrf}` };
    if (method !== 'GET') {
      if (body !== undefined) headers['content-type'] = 'application/json';
      headers.origin = this.#base;
      headers[CSRF_HEADER] = session.csrf;
    }
    const res = await this.#send(path, method, headers, body);
    // A restarted gateway has forgotten every session: sign in again, once.
    // (The CSRF gate's 403 is empty; a handler's own 403 carries a body and is an answer.)
    const gate = res.status === 401 || (res.status === 403 && !(res.headers.get('content-type') ?? '').includes('json'));
    if (gate && !retried) {
      this.#session = undefined;
      this.#signedIn = undefined;
      return this.#request(path, method, body, true);
    }
    return res;
  }

  /**
   * Open a session, presenting a credential only where it can be right.
   *
   * 1. Only without a token: ask with no credential at all. On the open
   *    loopback binding that is the whole sign-in (a browser's session, which
   *    a PIN locks), and anywhere else an empty 401 that counts as nothing.
   * 2. Holding the token: ask `/_buddi/ready` to prove it holds the same one.
   *    A port answered by some other buddi — a dev checkout, an older install
   *    on a port this process remembers — fails the proof and never sees a
   *    ticket, so it never counts a failed sign-in against this computer.
   * 3. Exchange a five-minute ticket for a session, as the dashboard link does.
   *
   * A failure is remembered for `SIGN_IN_RETRY_MS`: a client asked again and
   * again does not ask the gateway again and again.
   */
  #signIn(): Promise<void> {
    if (this.#failed && this.#now() < this.#failed.until) return Promise.reject(this.#failed.error);
    this.#signedIn ??= this.#openSession().catch((err: unknown) => {
      this.#signedIn = undefined;
      if (err instanceof GatewayError) this.#failed = { error: err, until: this.#now() + SIGN_IN_RETRY_MS };
      throw err;
    });
    return this.#signedIn;
  }

  async #openSession(): Promise<void> {
    const name = sessionCookieName(portOf(new URL(this.#base)));
    const cookieOf = (res: TransportResponse): string | undefined => {
      const line = res.headers.get('set-cookie') ?? '';
      const match = new RegExp(`(?:^|[;,]\\s*)${name}=([^;]+)`).exec(line);
      return match?.[1];
    };
    const csrfOf = async (res: TransportResponse): Promise<string | undefined> => {
      if (!res.ok) return undefined;
      const body = (await res.json().catch(() => null)) as { csrf?: unknown } | null;
      return typeof body?.csrf === 'string' ? body.csrf : undefined;
    };

    // Holding the token, the ticket is the sign-in, open binding or not: the
    // open binding's own session is a browser's, which a PIN locks, and the
    // `x-buddi-client` header alone earns nothing there.
    let token: string | undefined;
    if (this.#token) {
      try {
        token = await this.#token();
      } catch (err) {
        if (!this.#openFallback) {
          throw new GatewayError(0, `This command could not read the dashboard token (${err instanceof Error ? err.message : String(err)}). ${STALE_HINT}`);
        }
      }
    }

    // 1. No token: the open binding, no credential, nothing counted.
    if (token === undefined) {
      const open = await this.#send('/api/session', 'GET', {});
      const openId = cookieOf(open);
      const openCsrf = await csrfOf(open);
      if (openId && openCsrf) {
        this.#session = { id: openId, csrf: openCsrf, cookie: name };
        this.#failed = undefined;
        return;
      }
      if (open.status === 429) throw this.#refused(429);
      if (!this.#ticket) {
        throw new GatewayError(open.status, `buddi on ${this.#base} wants a sign-in, and this command has no dashboard token to make one with. ${STALE_HINT}`);
      }
    }

    // 2. Is this our buddi? Asked before any ticket is presented.
    let ticket: string;
    if (token !== undefined) {
      const challenge = randomBytes(32).toString('hex');
      const ready = await this.#send(`/_buddi/ready?challenge=${challenge}`, 'GET', {});
      if (ready.ok && (ready.headers.get('content-type') ?? '').includes('json')) {
        const proof = ((await ready.json().catch(() => null)) as { proof?: unknown } | null)?.proof;
        const expected = createHmac('sha256', token).update(`buddi-ready-v1:${challenge}`).digest('hex');
        if (proof !== expected) {
          throw new GatewayError(ready.status, `The buddi answering on ${this.#base} is not the one this command belongs to (it holds a different dashboard token), so no sign-in was tried there. ${STALE_HINT}`);
        }
      }
      ticket = mintTicket(token);
    } else {
      ticket = await this.#ticket!();
    }

    // 3. The ticket exchange, as the dashboard link does it.
    const exchanged = await this.#send(`/?t=${encodeURIComponent(ticket)}`, 'GET', {});
    const id = cookieOf(exchanged);
    if (exchanged.status === 429) throw this.#refused(429);
    if (!id) {
      throw new GatewayError(exchanged.status, `buddi on ${this.#base} refused this command's sign-in link (HTTP ${exchanged.status}). ${STALE_HINT}`);
    }
    const res = await this.#send('/api/session', 'GET', { cookie: `${name}=${id}` });
    const csrf = await csrfOf(res);
    if (!csrf) {
      throw new GatewayError(res.status, `buddi on ${this.#base} took this command's sign-in link but would not open a session with it (HTTP ${res.status}). ${STALE_HINT}`);
    }
    this.#session = { id: cookieOf(res) ?? id, csrf, cookie: name };
    this.#failed = undefined;
  }

  #refused(status: number): GatewayError {
    return new GatewayError(status, `buddi on ${this.#base} is refusing sign-ins from this computer for a minute (too many failed tries, often a forgotten tab). Try again shortly.`);
  }

  async #read(res: TransportResponse): Promise<unknown> {
    const type = res.headers.get('content-type') ?? '';
    if (res.status === 204) return null;
    if (!type.includes('application/json')) {
      const bytes = await res.arrayBuffer();
      if (res.ok) return { file: { contentType: type || 'application/octet-stream', bytes: bytes.byteLength } };
      throw new GatewayError(res.status, `buddi answered ${res.status}`);
    }
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    if (!res.ok) {
      const failed = (body as { failed?: Array<{ agent?: string; message?: string }> } | null)?.failed;
      const message =
        typeof body?.error === 'string'
          ? body.error
          : Array.isArray(failed) && failed.length > 0
            ? failed.map((f) => `${f.agent ?? '?'}: ${f.message ?? 'refused'}`).join('; ')
            : `buddi answered ${res.status}`;
      throw new GatewayError(res.status, message, body);
    }
    return body;
  }
}

/**
 * The gateway this machine runs, found the way `buddi dashboard` finds it: the
 * dashboard's configured host and port, and — only off loopback, or when auth
 * is required — the installation token to mint a ticket with.
 */
export function gatewayFromEnvironment(env: NodeJS.ProcessEnv = process.env): GatewayClient | { off: string } {
  const config = webConfig(env);
  if (!config.enabled) {
    return { off: `The dashboard is off (${WEB_ENABLED_VAR}=0), and this command reaches buddi through it. Turn it back on and restart the service.` };
  }
  const open = isLoopback(config.host) && env.BUDDI_WEB_REQUIRE_AUTH !== '1';
  return new GatewayClient({
    baseUrl: webUrl(config),
    // Read-only: a missing token is a sentence, never a new token the gateway does not hold.
    // Asked on the open binding too: the ticket is what keeps the lock screen from covering this client.
    token: async () => (await ensureWebToken({ env, readOnly: true })).token,
    openFallback: open,
  });
}
