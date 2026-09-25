/**
 * The loopback client `buddi mcp` speaks to the running gateway with.
 *
 * It is the dashboard's own HTTP API, reached the way `buddi dashboard` reaches
 * it (docs/specs/mcp.md §3): on the default loopback binding the server mints a
 * session for any request that arrives on this machine, and on anything wider
 * the installation's token is turned into a five-minute ticket and exchanged for
 * a session exactly as the dashboard link is. The token itself never leaves
 * this process.
 *
 * Writes carry the session's CSRF header and the dashboard's own origin, like
 * the page does. Every request goes through the one shared transport — one
 * connection per request, nothing pooled — like every other caller here. The only write this client is ever asked to make is
 * `POST /api/mcp/request` (and a chat message for `buddi.ask`): every change
 * becomes an approval on the gateway's side.
 */
import {
  CSRF_COOKIE,
  CSRF_HEADER,
  SESSION_COOKIE,
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

export interface GatewayClientOptions {
  baseUrl: string;
  /** How to sign in when the binding is not open: a five-minute ticket. */
  ticket?: (() => Promise<string>) | undefined;
  transport?: HttpTransport;
}

export class GatewayClient implements Gateway {
  readonly #base: string;
  readonly #ticket: (() => Promise<string>) | undefined;
  readonly #transport: HttpTransport;
  /** The session this client holds: its cookie, and the CSRF value it pairs with. */
  #session: { id: string; csrf: string } | undefined;
  #signedIn: Promise<void> | undefined;

  constructor(opts: GatewayClientOptions) {
    this.#base = opts.baseUrl.replace(/\/+$/, '');
    this.#ticket = opts.ticket;
    this.#transport = opts.transport ?? defaultHttpTransport;
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

  async #send(path: string, method: string, headers: Record<string, string>, body?: string): Promise<TransportResponse> {
    try {
      return await this.#transport(`${this.#base}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    } catch {
      this.#session = undefined;
      this.#signedIn = undefined;
      throw new GatewayUnavailable();
    }
  }

  async #request(path: string, method: string, body?: string, retried = false): Promise<TransportResponse> {
    await this.#signIn();
    const session = this.#session!;
    const headers: Record<string, string> = { cookie: `${SESSION_COOKIE}=${session.id}; ${CSRF_COOKIE}=${session.csrf}` };
    if (method !== 'GET') {
      headers['content-type'] = 'application/json';
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
   * Open a session. On loopback the first request mints one; elsewhere a
   * ticket is exchanged for one. Either way the session cookie is the first
   * `Set-Cookie`, and the CSRF value it pairs with is read from `/api/session`.
   */
  #signIn(): Promise<void> {
    this.#signedIn ??= (async () => {
      const cookieOf = (res: TransportResponse): string | undefined => {
        const line = res.headers.get('set-cookie') ?? '';
        const match = new RegExp(`(?:^|[;,]\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
        return match?.[1];
      };
      let id: string | undefined;
      if (this.#ticket) {
        const exchanged = await this.#send(`/?t=${encodeURIComponent(await this.#ticket())}`, 'GET', {});
        id = cookieOf(exchanged);
      }
      const res = await this.#send('/api/session', 'GET', id ? { cookie: `${SESSION_COOKIE}=${id}` } : {});
      id = cookieOf(res) ?? id;
      const body = res.ok ? ((await res.json().catch(() => null)) as { csrf?: unknown } | null) : null;
      if (!id || typeof body?.csrf !== 'string') {
        throw new GatewayError(res.status, 'buddi answered but would not open a session for this client. Is the dashboard bound somewhere `buddi mcp` cannot sign in?');
      }
      this.#session = { id, csrf: body.csrf };
    })().catch((err: unknown) => {
      this.#signedIn = undefined;
      throw err;
    });
    return this.#signedIn;
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
      const message = typeof body?.error === 'string' ? body.error : `buddi answered ${res.status}`;
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
    return { off: `The dashboard is off (${WEB_ENABLED_VAR}=0), and \`buddi mcp\` reaches buddi through it. Turn it back on and restart the service.` };
  }
  const open = isLoopback(config.host) && env.BUDDI_WEB_REQUIRE_AUTH !== '1';
  return new GatewayClient({
    baseUrl: webUrl(config),
    ...(open ? {} : { ticket: async () => mintTicket((await ensureWebToken({ env })).token) }),
  });
}
