/**
 * The HTTP transport every provider adapter sends on.
 *
 * ## Why this is not `fetch`
 *
 * It used to be. `fetch` is Node's bundled undici, and undici keeps a pool of
 * connections per origin — against `api.anthropic.com` it negotiates HTTP/2 and
 * keeps the **session**. That is the right default for a server answering
 * requests continuously; it is the wrong one for this process, which makes one
 * large POST, then thinks for a while, then makes another. In that shape a
 * pooled connection spends most of its life idle, and an idle connection is one
 * the other end is entitled to close at any moment.
 *
 * When it did, every subsequent request in the process failed, instantly and
 * for ever:
 *
 *     TypeError: fetch failed
 *       <- Error: The session has been destroyed [ERR_HTTP2_INVALID_SESSION]
 *
 * That was read out of the live wedged service through the inspector: the call
 * failed in **one millisecond**, twice in a row, with no packet sent — while in
 * the same process, at the same moment, `https://example.com` returned 200 and
 * a plain `node:https` POST to `api.anthropic.com` returned an ordinary HTTP
 * 401 in 181ms. The network was fine. The pool was holding a corpse and handing
 * it back.
 *
 * It matched every observation: a one-shot `buddi ask` never idles and never
 * failed; a `buddi chat` turn typed after the owner finished reading the
 * previous answer failed, and then *everything* in that session failed,
 * including "hey"; `buddi serve` went dead for hours rather than recovering;
 * twelve unattended jobs died across one quiet evening in a single long-lived
 * process. It also explains why no amount of retrying helped — the adapter's
 * four seconds and the queue's six hours were both spent re-drawing the same
 * dead session out of the same pool.
 *
 * undici will not retry a POST on a socket error, and it is right not to: a
 * POST is not idempotent, and a blind retry of one that may have reached the
 * server is a correctness bug. So the failure has to surface — which means the
 * fix has to be to stop creating it.
 *
 * ## What it does instead
 *
 * **Every provider request gets its own connection.** `node:https` speaks
 * HTTP/1.1, and `keepAlive` is off: there is no pool, no session, no cached
 * client, and nothing held between one request and the next. That is what makes
 * the process **self-healing** rather than merely luckier — a request that has
 * just failed cannot poison the one after it, because there is no place for a
 * dead connection to be kept. The acceptance test says it in one line: a
 * long-lived process that has just seen a connection failure succeeds on its
 * very next request.
 *
 * The cost is one TLS handshake per request — on the order of a tenth of a
 * second against a call that takes seconds — and what it buys is that an entire
 * class of failure cannot happen. For a personal assistant making one model
 * call at a time, that trade is not close.
 *
 * **A connection-level failure on a reused socket is retried immediately, on a
 * fresh one.** This is belt and braces for anyone who configures an agent that
 * does pool (the tests do), and it is the one retry that is provably safe:
 *
 *   - Node sets `request.reusedSocket` when the socket came out of an agent's
 *     free list — i.e. it was idle before we wrote anything to it.
 *   - We only retry when **no byte of a response had arrived**. A server that
 *     closes an idle keep-alive connection has, by definition, already answered
 *     every request it accepted on it; our bytes arrived after its FIN and were
 *     never processed.
 *
 * Both conditions are required, and neither is guessed at — they are facts the
 * client holds. A reset on a *fresh* connection is **not** retried here, and
 * neither is one after any response byte: in both cases the request may have
 * reached the server, and `email.send` is downstream of this path. That retry
 * belongs to the adapter's own budget, where it is a deliberate decision about
 * a request that might have landed, not a silent one.
 */
import { Agent as HttpAgent, request as httpRequest, type ClientRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';

/**
 * The slice of `Response` an adapter actually uses. Narrow on purpose: the
 * global `fetch` satisfies it, so a test may still inject one.
 */
export interface TransportResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<any>;
}

export interface TransportRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
}

export type HttpTransport = (
  url: string,
  init: TransportRequest,
) => Promise<TransportResponse>;

/**
 * How long a socket may go silent before the request is abandoned.
 *
 * Inactivity, not total time: a model that takes four minutes to answer is
 * still sending, and only a connection that has gone quiet is broken. Matches
 * undici's own default so nothing about timeouts changed when the transport did.
 */
export const SOCKET_IDLE_TIMEOUT_MS = 300_000;

/**
 * The agent every provider request uses unless one is injected.
 *
 * `keepAlive: false` is the whole point of the file — see the header. It is a
 * module-level singleton only so that socket options live in one place; with no
 * pool it holds no state between requests.
 */
export const providerHttpsAgent = new HttpsAgent({ keepAlive: false });
export const providerHttpAgent = new HttpAgent({ keepAlive: false });

/** A connection-level failure, with the two facts that decide a safe retry. */
export class TransportError extends Error {
  override readonly name = 'TransportError';
  /** The socket came out of an agent's free list: it was idle before we wrote. */
  readonly reusedSocket: boolean;
  /**
   * No byte of a response had arrived when this failed, so the request was
   * either never delivered or never acted on. Only ever true together with
   * `reusedSocket` for a retry decision — see the header.
   */
  readonly neverSent: boolean;

  constructor(message: string, opts: { cause: unknown; reusedSocket: boolean; neverSent: boolean }) {
    super(message, { cause: opts.cause });
    this.reusedSocket = opts.reusedSocket;
    this.neverSent = opts.neverSent;
  }
}

export interface HttpTransportOptions {
  /** Injected by tests that need a pooling agent or a plain-http server. */
  agent?: HttpsAgent | HttpAgent | undefined;
  idleTimeoutMs?: number | undefined;
}

function responseOf(res: IncomingMessage, body: Buffer): TransportResponse {
  const status = res.statusCode ?? 0;
  const text = (): string => body.toString('utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: res.statusMessage ?? '',
    headers: {
      get(name: string): string | null {
        const value = res.headers[name.toLowerCase()];
        if (value === undefined) return null;
        return Array.isArray(value) ? (value[0] ?? null) : value;
      },
    },
    text: async () => text(),
    json: async () => JSON.parse(text()),
  };
}

/** One attempt. Resolves with the response, or rejects with a `TransportError`. */
function attempt(
  url: string,
  init: TransportRequest,
  options: HttpTransportOptions,
): Promise<TransportResponse> {
  const target = new URL(url);
  const secure = target.protocol === 'https:';
  const send = secure ? httpsRequest : httpRequest;
  const agent =
    options.agent ?? (secure ? providerHttpsAgent : providerHttpAgent);

  return new Promise<TransportResponse>((resolve, reject) => {
    /** Set the moment any response byte arrives. After this, nothing is safe. */
    let responded = false;
    let settled = false;

    const req: ClientRequest = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        ...(target.port === '' ? {} : { port: Number(target.port) }),
        path: `${target.pathname}${target.search}`,
        method: init.method,
        headers: {
          ...init.headers,
          'content-length': String(Buffer.byteLength(init.body, 'utf8')),
        },
        agent,
      },
      (res) => {
        responded = true;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          if (settled) return;
          settled = true;
          resolve(responseOf(res, Buffer.concat(chunks)));
        });
        res.on('error', (err) => fail(err));
      },
    );

    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      const reused = req.reusedSocket === true;
      const message = err instanceof Error ? err.message : String(err);
      reject(
        new TransportError(message, {
          cause: err,
          reusedSocket: reused,
          neverSent: !responded,
        }),
      );
      req.destroy();
    };

    req.setTimeout(options.idleTimeoutMs ?? SOCKET_IDLE_TIMEOUT_MS, () => {
      fail(
        Object.assign(new Error('the connection went silent'), {
          code: 'ERR_SOCKET_CONNECTION_TIMEOUT',
        }),
      );
    });
    req.on('error', fail);
    req.end(init.body);
  });
}

/**
 * Build the transport. The returned function is `fetch`-shaped for the one
 * call an adapter makes, so injecting a fake in a test stays a one-liner.
 */
export function createHttpTransport(options: HttpTransportOptions = {}): HttpTransport {
  return async function transport(url, init) {
    try {
      return await attempt(url, init, options);
    } catch (err) {
      // The one safe retry: an idle pooled socket the far end had already
      // closed, on a request the server provably never acted on.
      if (err instanceof TransportError && err.reusedSocket && err.neverSent) {
        return attempt(url, init, options);
      }
      throw err;
    }
  };
}

/** The transport adapters use when nothing is injected. */
export const defaultHttpTransport: HttpTransport = createHttpTransport();
