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
 *
 * ## Why it is not only the provider's transport
 *
 * The hazard is not a fact about `api.anthropic.com`; it is a fact about a
 * pooled client inside a process that lives for weeks. Every long-lived
 * outbound caller in this repo has it, so every one of them sends here — the
 * Telegram Bot API above all, whose wedge would look like a bot that answers
 * nothing at all. To carry them honestly the transport grew three things, and
 * exactly three:
 *
 *  - **Bodies that are bytes.** `body` may be a `Buffer`, so a multipart
 *    upload (a document sent to Telegram) can be assembled by the caller and
 *    written verbatim, rather than being squeezed through a `string` and
 *    corrupted by UTF-8.
 *  - **Responses that are bytes.** `arrayBuffer()` alongside `text()`/`json()`,
 *    because Telegram's file endpoint answers a PDF, not JSON. The global
 *    `fetch` still satisfies the interface, so an injected fake stays a fake.
 *  - **Cancellation, and a per-request silence budget.** A long poll is
 *    deliberately held open with nothing on the wire for ~25 seconds, which is
 *    not the same thing as a dead connection; the caller says how long silence
 *    is allowed, and aborts the request itself on shutdown. An aborted request
 *    is never retried — it was not a failure, it was an instruction.
 *
 * What did **not** grow is the retry rule. It is still exactly one retry, still
 * only on a socket that came out of a free list with no response byte seen. On
 * the default agent `reusedSocket` is never true, so `sendMessage` and
 * `email.send` cannot be duplicated by this file at all; the retry exists only
 * for a caller who injects a pooling agent.
 */
import { Agent as HttpAgent, request as httpRequest, type ClientRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

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
  /** The body as bytes. Telegram's file endpoint answers a PDF, not JSON. */
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface TransportRequest {
  method: string;
  headers: Record<string, string>;
  /**
   * A string body is sent as UTF-8; a `Buffer` is sent verbatim, which is what
   * a `multipart/form-data` upload needs. Omitted for a GET.
   */
  body?: string | Buffer | undefined;
  /**
   * Abort the request — shutdown, or a caller-side deadline. An aborted request
   * is never retried here: it was an instruction, not a failure.
   */
  signal?: AbortSignal | undefined;
  /**
   * How long this one request may go silent, overriding the transport default.
   * A long poll needs more than a chat message does; see `SOCKET_IDLE_TIMEOUT_MS`.
   */
  idleTimeoutMs?: number | undefined;
  /**
   * The most bytes this response may be, refused **while it arrives**.
   *
   * A caller can always check `content-length` afterwards, but "afterwards" is
   * too late: by then the whole body is in this process's memory, and a header
   * is a claim the server makes rather than a fact. So the cap is enforced on
   * the byte stream — the moment the total exceeds it the request is destroyed
   * and the promise rejects with `ERR_RESPONSE_TOO_LARGE`. Nothing is buffered
   * past the limit.
   *
   * Added for the web plugin, which fetches pages nobody in this repository
   * wrote. Omitted everywhere else: a provider's answer is as long as it is.
   */
  maxBytes?: number | undefined;
  /**
   * Called with each piece of the body as it arrives, decoded as UTF-8 on
   * character boundaries, together with the status the response opened with.
   * The body is still buffered in full, so `text()` and `json()` work as
   * before — this is a tap, not a replacement. A provider streaming its
   * answer as server-sent events is read through it.
   */
  onChunk?: ((text: string, status: number) => void) | undefined;
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
  /**
   * The caller asked for this to stop (shutdown, a cancelled poll). Never a
   * network fault, and never retried — a retry would restart work somebody
   * just told us to abandon.
   */
  readonly aborted: boolean;

  constructor(
    message: string,
    opts: { cause: unknown; reusedSocket: boolean; neverSent: boolean; aborted?: boolean },
  ) {
    super(message, { cause: opts.cause });
    this.reusedSocket = opts.reusedSocket;
    this.neverSent = opts.neverSent;
    this.aborted = opts.aborted === true;
  }
}

export interface HttpTransportOptions {
  /** Injected by tests that need a pooling agent or a plain-http server. */
  agent?: HttpsAgent | HttpAgent | undefined;
  idleTimeoutMs?: number | undefined;
  /**
   * How the hostname is resolved, handed straight to the socket.
   *
   * This exists so a caller can *decide* about the address before a packet is
   * sent, and have that decision be the one the connection actually uses.
   * Checking a URL string, or resolving it and then calling `connect(host)`,
   * leaves a gap: the name can answer differently the second time, and the
   * second time is the one that counts (DNS rebinding). A `lookup` closes the
   * gap, because the address this function returns *is* the address dialled.
   *
   * The web plugin passes one that refuses loopback, private, link-local and
   * cloud-metadata addresses. Nothing else sets it, and the default is
   * `dns.lookup`, exactly as before.
   */
  lookup?: LookupFunction | undefined;
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
    async arrayBuffer() {
      // A copy, not a view: `body` may sit inside a larger pooled Buffer, and
      // handing its backing store out would expose bytes from another response.
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    },
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
  const body =
    init.body === undefined
      ? undefined
      : typeof init.body === 'string'
        ? Buffer.from(init.body, 'utf8')
        : init.body;
  const signal = init.signal;

  return new Promise<TransportResponse>((resolve, reject) => {
    /** Set the moment any response byte arrives. After this, nothing is safe. */
    let responded = false;
    let settled = false;

    // Already cancelled: open no socket at all. The caller has stopped — the
    // most honest thing this can do is not knock on the door.
    if (signal?.aborted === true) {
      reject(
        new TransportError('the request was aborted', {
          cause: Object.assign(new Error('the request was aborted'), { code: 'ABORT_ERR' }),
          reusedSocket: false,
          neverSent: true,
          aborted: true,
        }),
      );
      return;
    }

    const req: ClientRequest = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        ...(target.port === '' ? {} : { port: Number(target.port) }),
        path: `${target.pathname}${target.search}`,
        method: init.method,
        headers: {
          ...init.headers,
          // A GET carries no body and must not claim one: a `content-length: 0`
          // on a GET is refused outright by some proxies.
          ...(body === undefined ? {} : { 'content-length': String(body.byteLength) }),
        },
        agent,
        // Only present when the caller supplied one; `undefined` here would
        // override the socket's own default with nothing on some Node versions.
        ...(options.lookup === undefined ? {} : { lookup: options.lookup }),
      },
      (res) => {
        responded = true;
        const chunks: Buffer[] = [];
        let received = 0;
        const cap = init.maxBytes;
        const tap = init.onChunk;
        const decoder = tap ? new StringDecoder('utf8') : null;
        res.on('data', (chunk: Buffer) => {
          received += chunk.byteLength;
          if (cap !== undefined && received > cap) {
            // Refused mid-flight: nothing past the cap is kept, and the
            // connection is torn down rather than drained politely.
            res.destroy();
            fail(
              Object.assign(new Error(`the response exceeded ${cap} bytes`), {
                code: 'ERR_RESPONSE_TOO_LARGE',
              }),
            );
            return;
          }
          chunks.push(chunk);
          if (tap && decoder) {
            const text = decoder.write(chunk);
            if (text !== '') {
              try { tap(text, res.statusCode ?? 0); } catch (err) { fail(err); }
            }
          }
        });
        res.on('end', () => {
          if (settled) return;
          if (tap && decoder) {
            const text = decoder.end();
            if (text !== '') {
              try { tap(text, res.statusCode ?? 0); } catch (err) { fail(err); return; }
            }
          }
          settled = true;
          resolve(responseOf(res, Buffer.concat(chunks)));
        });
        res.on('error', (err) => fail(err));
      },
    );

    const fail = (err: unknown, aborted = false): void => {
      if (settled) return;
      settled = true;
      const reused = req.reusedSocket === true;
      const message = err instanceof Error ? err.message : String(err);
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      reject(
        new TransportError(message, {
          cause: err,
          reusedSocket: reused,
          neverSent: !responded,
          aborted,
        }),
      );
      req.destroy();
    };

    function onAbort(): void {
      fail(
        Object.assign(new Error('the request was aborted'), { code: 'ABORT_ERR' }),
        true,
      );
    }

    // Attached before anything can fail, so a destroyed request is never an
    // unhandled `error` event.
    req.on('error', fail);

    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true });
      // The success path has to let go of the listener too, or a long-lived
      // AbortController would accumulate one per request it never cancelled.
      req.on('close', () => signal.removeEventListener('abort', onAbort));
    }

    req.setTimeout(init.idleTimeoutMs ?? options.idleTimeoutMs ?? SOCKET_IDLE_TIMEOUT_MS, () => {
      fail(
        Object.assign(new Error('the connection went silent'), {
          code: 'ERR_SOCKET_CONNECTION_TIMEOUT',
        }),
      );
    });
    req.end(body);
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
      if (err instanceof TransportError && err.reusedSocket && err.neverSent && !err.aborted) {
        return attempt(url, init, options);
      }
      throw err;
    }
  };
}

/** The transport adapters use when nothing is injected. */
export const defaultHttpTransport: HttpTransport = createHttpTransport();
