/**
 * Retrieving one page, within bounds, with every hop checked.
 *
 * Everything here is a limit. A page is a thing a stranger serves, and a
 * stranger who knows an assistant is reading can serve a 4 GB response, a
 * response that trickles one byte a minute, a chain of redirects with no end,
 * a 200 MB PDF, or a 302 into `127.0.0.1`. Each of those has a line below.
 *
 * ## The four bounds
 *
 *  - **Bytes.** `maxBytes`, enforced *while the body arrives* by the shared
 *    transport (`TransportRequest.maxBytes`), not by checking `content-length`
 *    afterwards. A header is a claim; the byte count is a fact, and by the time
 *    you can check the header the memory is already spent.
 *  - **Time.** One `AbortSignal.timeout` covering the *whole* retrieval,
 *    redirects included, plus a per-request silence budget. A chain of three
 *    hops that each take nine seconds is not "fast enough"; the owner is
 *    waiting for an answer, not for a hop.
 *  - **Hops.** `maxRedirects`, and every hop is re-checked from scratch. This
 *    is the one that matters most: a redirect is a URL nobody approved.
 *  - **Kind.** An allow-list of content types. A PDF, an image, a zip and a
 *    video are all refused with a sentence saying what it was, because "I
 *    cannot read a PDF" is a useful answer and a page of mojibake is not.
 *
 * ## What a failure looks like
 *
 * Never an exception that reaches the model as a stack trace. Every outcome —
 * blocked, too big, too slow, a 404, a login wall, a PDF — is a typed result
 * with `ok: false`, a `reason`, and one sentence the agent can say out loud.
 * An agent that gets a vague failure retries with a different URL; an agent
 * that is told "that is a PDF" says so.
 */
import { defaultHttpTransport, createHttpTransport, type HttpTransport } from '@buddi/runtime';
import { extractTitle, htmlToText, plainToText } from './extract.js';
import {
  BlockedError,
  checkUrl,
  DEFAULT_POLICY,
  guardedLookup,
  type AddressPolicy,
  type BlockReason,
  type LookupAll,
} from './guard.js';

/** The most bytes a page may be before it is refused mid-flight. 2 MiB. */
export const MAX_BYTES = 2 * 1024 * 1024;
/** The whole retrieval, redirects included. */
export const TIMEOUT_MS = 20_000;
/** How long one hop may go silent. */
export const IDLE_TIMEOUT_MS = 10_000;
/** Redirect hops. Three is enough for every `http -> https -> www` in the wild. */
export const MAX_REDIRECTS = 3;
/** The most characters of extracted text handed back by default. */
export const DEFAULT_MAX_CHARS = 20_000;
export const MAX_MAX_CHARS = 60_000;

/**
 * A user agent that says what this is.
 *
 * Not a browser string. A site that would rather not be read by an assistant
 * is entitled to know it is talking to one, and a plugin that lies about it
 * cannot then complain about being blocked.
 */
export const USER_AGENT = 'buddi/0.1 (personal assistant; +https://github.com/buddi)';

/** Types that are text this plugin can honestly turn into prose. */
const TEXTUAL = new Set([
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
  'application/json',
  'application/ld+json',
  'text/csv',
  'application/xml',
  'text/xml',
  'application/rss+xml',
  'application/atom+xml',
]);

/** Types worth naming in the refusal, because the agent can say something useful. */
const NAMED: Array<[RegExp, string]> = [
  [/^application\/pdf/, 'a PDF'],
  [/^image\//, 'an image'],
  [/^video\//, 'a video'],
  [/^audio\//, 'audio'],
  [/^application\/(zip|gzip|x-tar|octet-stream)/, 'a binary file'],
];

export type FetchFailure =
  | { reason: 'blocked'; blockReason: BlockReason }
  | { reason: 'not-found' }
  | { reason: 'forbidden' }
  | { reason: 'unauthorised' }
  | { reason: 'rate-limited' }
  | { reason: 'server-error' }
  | { reason: 'too-large' }
  | { reason: 'timeout' }
  | { reason: 'too-many-redirects' }
  | { reason: 'unsupported-content' }
  | { reason: 'network' };

export type FetchOutcome =
  | {
      ok: true;
      /** The URL that actually answered, after every redirect. */
      url: string;
      /** Its host — the thing a citation names. */
      source: string;
      status: number;
      contentType: string;
      title: string | null;
      text: string;
      truncated: boolean;
      /** How many bytes came off the wire, before extraction. */
      bytes: number;
      /** Every URL in the chain, first to last. Short, and worth seeing. */
      chain: string[];
    }
  | ({
      ok: false;
      /** The URL that failed — the last hop tried, not necessarily the first. */
      url: string;
      source: string;
      status: number | null;
      /** One sentence an agent can repeat to the owner, as-is. */
      message: string;
      chain: string[];
    } & FetchFailure);

export interface FetcherOptions {
  /** The address rules. Always `DEFAULT_POLICY` in anything that ships. */
  policy?: AddressPolicy;
  /** How names are resolved. A test answers here instead of asking a resolver. */
  resolve?: LookupAll;
  /** The transport. Built here so the guarded `lookup` is wired into it. */
  transport?: HttpTransport;
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
}

export interface FetchRequest {
  url: string;
  maxChars?: number;
  /** `GET` for a page. The search providers use this with a POST body. */
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Skip extraction and hand back the raw body — how the providers read JSON. */
  raw?: boolean;
}

export interface RawOutcome {
  ok: boolean;
  status: number;
  body: string;
  contentType: string;
  url: string;
}

export type Fetcher = {
  page(request: FetchRequest): Promise<FetchOutcome>;
  /**
   * The same guarded path, without extraction, for a caller that knows what it
   * is talking to — the search providers, which speak JSON to one declared
   * host. Everything about the guard still applies: a provider whose DNS
   * answered `127.0.0.1` is refused exactly as a page would be.
   */
  json(request: FetchRequest): Promise<RawOutcome>;
};

/**
 * Build a fetcher.
 *
 * The transport is constructed *here*, with the guarded lookup, rather than
 * taken as a default from `@buddi/runtime`: `defaultHttpTransport` resolves
 * names with `dns.lookup`, and a fetcher that used it would have the address
 * check only in front of the socket rather than inside it. That is the
 * difference between checking a URL and checking a connection.
 */
export function createFetcher(options: FetcherOptions = {}): Fetcher {
  const policy = options.policy ?? DEFAULT_POLICY;
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const transport =
    options.transport ??
    createHttpTransport({
      lookup: guardedLookup(options.resolve, policy),
      idleTimeoutMs: IDLE_TIMEOUT_MS,
    });

  async function walk(
    request: FetchRequest,
  ): Promise<
    | { ok: true; status: number; body: string; contentType: string; url: string; bytes: number; chain: string[] }
    | (FetchFailure & { ok: false; url: string; status: number | null; message: string; chain: string[] })
  > {
    // One deadline for the whole thing. A redirect chain that each hop
    // "finishes in time" can still keep the owner waiting a minute.
    const deadline = AbortSignal.timeout(timeoutMs);
    const chain: string[] = [];
    let target = request.url;

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      let checked;
      try {
        // Every hop, from scratch. The first URL is not special.
        checked = checkUrl(target, policy);
      } catch (err) {
        if (err instanceof BlockedError) {
          return {
            ok: false,
            reason: 'blocked',
            blockReason: err.reason,
            url: target,
            status: null,
            message:
              hop === 0
                ? err.message
                : `${err.message} (reached by a redirect from ${chain[chain.length - 1] ?? request.url})`,
            chain,
          };
        }
        throw err;
      }
      chain.push(checked.url.toString());

      let response;
      try {
        response = await transport(checked.url.toString(), {
          method: request.method ?? 'GET',
          headers: {
            'user-agent': USER_AGENT,
            accept: request.raw === true ? 'application/json' : 'text/html,text/plain;q=0.9,*/*;q=0.1',
            'accept-language': 'en,fr;q=0.8',
            ...(request.headers ?? {}),
          },
          ...(request.body === undefined ? {} : { body: request.body }),
          signal: deadline,
          maxBytes,
          idleTimeoutMs: IDLE_TIMEOUT_MS,
        });
      } catch (err) {
        return { ...networkFailure(err, checked.url.toString()), chain };
      }

      const status = response.status;
      const location = response.headers.get('location');
      if (status >= 300 && status < 400 && location !== null && location.trim() !== '') {
        if (hop === maxRedirects) {
          return {
            ok: false,
            reason: 'too-many-redirects',
            url: checked.url.toString(),
            status,
            message: `that URL redirects more than ${maxRedirects} times; I stopped following it`,
            chain,
          };
        }
        // Relative locations are normal and must be resolved against the hop we
        // are on, not against the URL the agent first asked for.
        try {
          target = new URL(location, checked.url).toString();
        } catch {
          return {
            ok: false,
            reason: 'network',
            url: checked.url.toString(),
            status,
            message: `that URL redirected to something that is not a URL (${location.slice(0, 80)})`,
            chain,
          };
        }
        continue;
      }

      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      const body = await response.text();
      const bytes = Buffer.byteLength(body, 'utf8');

      if (!response.ok) {
        return {
          ...statusFailure(status, checked.url.toString(), contentType, body),
          chain,
        };
      }
      return { ok: true, status, body, contentType, url: checked.url.toString(), bytes, chain };
    }

    return {
      ok: false,
      reason: 'too-many-redirects',
      url: target,
      status: null,
      message: `that URL redirects more than ${maxRedirects} times; I stopped following it`,
      chain,
    };
  }

  return {
    async json(request) {
      const result = await walk({ ...request, raw: true });
      if (!result.ok) {
        return { ok: false, status: result.status ?? 0, body: result.message, contentType: '', url: result.url };
      }
      return { ok: true, status: result.status, body: result.body, contentType: result.contentType, url: result.url };
    },

    async page(request) {
      const result = await walk(request);
      if (!result.ok) {
        return { ...result, source: hostOf(result.url) };
      }
      const mime = result.contentType.split(';')[0]?.trim() ?? '';
      if (mime !== '' && !TEXTUAL.has(mime)) {
        const named = NAMED.find(([re]) => re.test(mime))?.[1];
        return {
          ok: false,
          reason: 'unsupported-content',
          url: result.url,
          source: hostOf(result.url),
          status: result.status,
          message: named
            ? `that link is ${named} (${mime}), not a web page — I can only read text, so I did not read it`
            : `that link is ${mime}, which is not text I can read`,
          chain: result.chain,
        };
      }
      const isHtml = mime === 'text/html' || mime === 'application/xhtml+xml' || mime === '';
      const limit = Math.min(request.maxChars ?? DEFAULT_MAX_CHARS, MAX_MAX_CHARS);
      const extracted = isHtml ? htmlToText(result.body, limit) : plainToText(result.body, limit);
      return {
        ok: true,
        url: result.url,
        source: hostOf(result.url),
        status: result.status,
        contentType: mime === '' ? 'text/html' : mime,
        title: isHtml ? extractTitle(result.body) : null,
        text: extracted.text,
        truncated: extracted.truncated,
        bytes: result.bytes,
        chain: result.chain,
      };
    },
  };
}

/** The host a citation names. Never throws — it is used in error paths. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

function statusFailure(
  status: number,
  url: string,
  contentType: string,
  body: string,
): FetchFailure & { ok: false; url: string; status: number; message: string } {
  const base = { ok: false as const, url, status };
  if (status === 404 || status === 410) {
    return { ...base, reason: 'not-found', message: `that page does not exist (HTTP ${status})` };
  }
  if (status === 401 || status === 407) {
    return {
      ...base,
      reason: 'unauthorised',
      message: `that page is behind a login (HTTP ${status}) — I have no account there and did not try to make one`,
    };
  }
  if (status === 403) {
    // The commonest real-world answer, and worth distinguishing: a paywall and
    // a bot-block look identical from here, so say both possibilities.
    const looksLikeWall = /sign in|log ?in|subscribe|paywall|captcha|are you a robot/i.test(
      contentType.startsWith('text/') ? body.slice(0, 4000) : '',
    );
    return {
      ...base,
      reason: 'forbidden',
      message: looksLikeWall
        ? 'that site refused the request and the page looks like a login or paywall — I did not get the content'
        : 'that site refused the request (HTTP 403), most likely because it blocks automated readers',
    };
  }
  if (status === 429) {
    return { ...base, reason: 'rate-limited', message: 'that site is rate-limiting this reader (HTTP 429)' };
  }
  return {
    ...base,
    reason: 'server-error',
    message: `that site answered HTTP ${status}`,
  };
}

function networkFailure(
  err: unknown,
  url: string,
): FetchFailure & { ok: false; url: string; status: null; message: string } {
  const base = { ok: false as const, url, status: null };
  const cause = (err as { cause?: unknown })?.cause;
  const code = (cause as { code?: string } | undefined)?.code ?? (err as { code?: string })?.code;
  const message = err instanceof Error ? err.message : String(err);

  // A blocked address surfaces here when it was the *socket* that refused —
  // i.e. `guardedLookup` did its job on a name that looked perfectly ordinary.
  const blocked = cause instanceof BlockedError ? cause : err instanceof BlockedError ? err : null;
  if (blocked) {
    return { ...base, reason: 'blocked', blockReason: blocked.reason, message: blocked.message };
  }
  if (code === 'ERR_RESPONSE_TOO_LARGE' || /exceeded \d+ bytes/.test(message)) {
    return {
      ...base,
      reason: 'too-large',
      message: `that page is larger than this reader will accept (${MAX_BYTES} bytes) — I stopped downloading it`,
    };
  }
  if (code === 'ABORT_ERR' || code === 'ERR_SOCKET_CONNECTION_TIMEOUT' || /timed out|went silent|aborted/i.test(message)) {
    return { ...base, reason: 'timeout', message: 'that site did not answer in time, so I gave up on it' };
  }
  return { ...base, reason: 'network', message: `I could not reach that site: ${message}` };
}

/** The transport used when a caller supplies neither one nor a lookup seam. */
export { defaultHttpTransport };
