/**
 * What a provider's "not now" says about when to come back.
 *
 * A 429 is rarely silent about its window. Each provider says it its own way:
 *
 *  - the standard `Retry-After` (seconds or an HTTP date), and OpenAI's
 *    `retry-after-ms` beside it;
 *  - OpenAI's `x-ratelimit-reset-requests` / `-tokens` ("6m0s", "20ms") with
 *    the matching `x-ratelimit-remaining-*` at zero;
 *  - Anthropic's `anthropic-ratelimit-*-reset` (RFC 3339 instants);
 *  - Google, through its OpenAI-compatible address, in the *body*: a
 *    `RetryInfo` detail (`"retryDelay": "20s"`), a `QuotaFailure` detail naming
 *    the quota (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`, value
 *    `20`), and the same facts again in prose ("limit: 20 … Please retry in
 *    20.6s").
 *
 * The distinction that matters most is **burst or day**. Google's free tier
 * answers its twenty-first request of the day with "retry in 20s" — and the
 * twenty-second request, twenty seconds later, is refused again, because the
 * limit that ran out was the day's, not the minute's. Waiting seconds and
 * trying again is hammering. So a quota the provider names as per-day is
 * reported as `scope: 'day'`, with the time it resets, and nobody retries it.
 *
 * Read only to choose between our own sentences and our own waits: nothing
 * here is ever shown verbatim to the owner.
 */

export interface RateLimitInfo {
  /**
   * `day`: a daily quota is used up — waiting seconds will not help, and the
   * account is rate-limited until `retryAt`. `burst`: a short window (per
   * minute, per second, an overloaded host); a wait of `waitMs` is the cure.
   */
  scope: 'day' | 'burst';
  /** When the provider said to come back, or when the day's quota resets. */
  retryAt: string | null;
  /** The provider's own wait from now, in ms, uncapped. Null when it named none. */
  waitMs: number | null;
  /** The quota's size when the provider said it ("limit: 20"). */
  limit?: number;
  /** What the quota counts, when the provider said. */
  unit?: 'requests' | 'tokens';
  /** The quota is a free tier's. */
  freeTier?: boolean;
  /** Who answered, in the owner's words: "Gemini", "OpenAI". */
  provider?: string;
  /** The model the quota is for, when the provider named one. */
  model?: string;
}

/** Statuses whose answer may carry a window worth reading. */
export function isLimitStatus(status: number): boolean {
  return status === 429 || status === 503 || status === 529;
}

/** Headers the way every transport hands them over. */
export interface HeaderBag {
  get?(name: string): string | null;
}

/** A Go-style duration: "1s", "6m0s", "20ms", "1h2m3.5s", "20.632s". */
export function parseDuration(text: string | null | undefined): number | undefined {
  const value = text?.trim();
  if (!value) return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) return Math.round(Number(value) * 1000);
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let consumed = '';
  for (const match of value.matchAll(re)) {
    const n = Number(match[1]);
    total += match[2] === 'h' ? n * 3_600_000 : match[2] === 'm' ? n * 60_000 : match[2] === 's' ? n * 1000 : n;
    consumed += match[0];
  }
  return consumed === value && Number.isFinite(total) ? Math.round(total) : undefined;
}

/** A wait read from the headers, in ms from `now`. */
export function headerWaitMs(headers: HeaderBag | undefined, now: number = Date.now()): number | undefined {
  const get = (name: string): string | null => headers?.get?.(name)?.trim() || null;
  const ms = get('retry-after-ms');
  if (ms && /^\d+(\.\d+)?$/.test(ms)) return Math.round(Number(ms));
  const after = get('retry-after');
  if (after) {
    if (/^\d+(\.\d+)?$/.test(after)) return Math.round(Number(after) * 1000);
    const at = Date.parse(after);
    if (Number.isFinite(at)) return Math.max(at - now, 0);
  }
  // OpenAI: the reset of whichever budget is spent; both when both are.
  const waits: number[] = [];
  for (const unit of ['requests', 'tokens'] as const) {
    if (get(`x-ratelimit-remaining-${unit}`) !== '0') continue;
    const wait = parseDuration(get(`x-ratelimit-reset-${unit}`));
    if (wait !== undefined) waits.push(wait);
  }
  // Anthropic: an instant per budget, again only for the one that is spent.
  for (const unit of ['requests', 'tokens', 'input-tokens', 'output-tokens']) {
    if (get(`anthropic-ratelimit-${unit}-remaining`) !== '0') continue;
    const at = Date.parse(get(`anthropic-ratelimit-${unit}-reset`) ?? '');
    if (Number.isFinite(at)) waits.push(Math.max(at - now, 0));
  }
  return waits.length > 0 ? Math.max(...waits) : undefined;
}

/** The provider in the owner's words, from the address it answers at. */
export function providerFromBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  let host: string;
  let port: string;
  try { ({ hostname: host, port } = new URL(baseUrl)); } catch { return undefined; }
  if (host === 'generativelanguage.googleapis.com') return 'Gemini';
  if (host === 'api.openai.com') return 'OpenAI';
  if (host === 'api.anthropic.com') return 'Anthropic';
  if (host === 'ollama.com' || host.endsWith('.ollama.com')) return 'Ollama Cloud';
  if (port === '11434') return 'Ollama';
  return undefined;
}

/** The next midnight in a zone, as an instant. Google's daily quotas reset at midnight Pacific. */
export function nextMidnight(timeZone: string, now: number = Date.now()): number {
  const parts = (at: number): Record<string, number> => Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
      .formatToParts(at).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]),
  );
  const p = parts(now);
  const intoDay = ((p.hour as number) * 3600 + (p.minute as number) * 60 + (p.second as number)) * 1000 + (now % 1000);
  let guess = now - intoDay + 86_400_000;
  // A day that is 23 or 25 hours long (a clock change) lands an hour off: step to the hour that reads 00.
  for (let i = 0; i < 3; i++) {
    const g = parts(guess);
    if (g.hour === 0 && g.minute === 0) break;
    guess += g.hour === 23 ? 3_600_000 : -3_600_000;
  }
  return guess;
}

interface GoogleDetail {
  '@type'?: string;
  retryDelay?: string;
  violations?: Array<{ quotaMetric?: string; quotaId?: string; quotaValue?: string; quotaDimensions?: { model?: string } }>;
}

/** Google's error object, whether the body is `{ error }` or `[{ error }]`. */
function googleError(body: unknown): { message?: string; details?: GoogleDetail[] } | undefined {
  const root = Array.isArray(body) ? body[0] : body;
  const error = root && typeof root === 'object' ? (root as { error?: unknown }).error : undefined;
  return error && typeof error === 'object' ? error as { message?: string; details?: GoogleDetail[] } : undefined;
}

/**
 * Everything a refusal says about its window, or null when it says nothing
 * and is not a limit at all.
 */
export function readRateLimit(args: {
  status: number;
  headers?: HeaderBag | undefined;
  /** The response body as text, already read. */
  body?: string | undefined;
  baseUrl?: string | undefined;
  now?: number | undefined;
}): RateLimitInfo | null {
  if (!isLimitStatus(args.status)) return null;
  const now = args.now ?? Date.now();
  const provider = providerFromBaseUrl(args.baseUrl);
  let waitMs = headerWaitMs(args.headers, now);
  let scope: RateLimitInfo['scope'] = 'burst';
  let limit: number | undefined;
  let unit: RateLimitInfo['unit'];
  let freeTier = false;
  let model: string | undefined;

  let parsed: unknown;
  try { parsed = args.body ? JSON.parse(args.body) : undefined; } catch { parsed = undefined; }
  const google = googleError(parsed);
  const prose = typeof google?.message === 'string' ? google.message
    : typeof (parsed as { error?: { message?: unknown } } | undefined)?.error?.message === 'string'
      ? (parsed as { error: { message: string } }).error.message
      : (args.body ?? '').slice(0, 2000);

  for (const detail of google?.details ?? []) {
    const type = detail?.['@type'] ?? '';
    if (/RetryInfo$/.test(type) && waitMs === undefined) waitMs = parseDuration(detail.retryDelay);
    if (/QuotaFailure$/.test(type)) {
      for (const v of detail.violations ?? []) {
        const id = `${v.quotaId ?? ''} ${v.quotaMetric ?? ''}`;
        if (/per_?day/i.test(id)) scope = 'day';
        if (/free_?tier/i.test(id)) freeTier = true;
        if (/token/i.test(id)) unit = 'tokens';
        else if (/request/i.test(id)) unit ??= 'requests';
        const value = Number(v.quotaValue);
        if (Number.isFinite(value) && value > 0) limit = value;
        if (typeof v.quotaDimensions?.model === 'string') model = v.quotaDimensions.model;
      }
    }
  }
  // The same facts in prose, for a body without the structured details.
  if (waitMs === undefined) {
    const said = /retry in (\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(prose);
    if (said) waitMs = Math.round(Number(said[1]) * (said[2]?.toLowerCase() === 'ms' ? 1 : 1000));
  }
  if (limit === undefined) {
    const said = /\blimit: (\d+)\b/i.exec(prose);
    if (said) limit = Number(said[1]);
  }
  if (/PerDay|per day|requests per day|daily (?:quota|limit)/i.test(prose)) scope = 'day';
  if (/free_?tier/i.test(prose)) freeTier = true;
  if (model === undefined) {
    const said = /\bmodel: ([\w.:-]{1,80})/i.exec(prose);
    if (said) model = said[1];
  }
  if (unit === undefined && /_requests\b|requests per/i.test(prose)) unit = 'requests';

  // A 503 or 529 with nothing to say is an outage, not a limit: no window.
  if (args.status !== 429 && waitMs === undefined) return null;

  let retryAt: string | null = null;
  let wait: number | null = waitMs ?? null;
  if (scope === 'day') {
    // A provider's "retry in 20s" on a spent daily quota is the minute's
    // window, not the day's. Google's day ends at midnight Pacific.
    const reset = provider === 'Gemini' ? nextMidnight('America/Los_Angeles', now)
      : wait !== null ? now + wait : null;
    retryAt = reset === null ? null : new Date(reset).toISOString();
    wait = reset === null ? null : reset - now;
  } else if (wait !== null && wait <= 366 * 86_400_000) {
    retryAt = new Date(now + wait).toISOString();
  }

  return {
    scope,
    retryAt,
    waitMs: wait,
    ...(limit !== undefined ? { limit } : {}),
    ...(unit !== undefined ? { unit } : {}),
    ...(freeTier ? { freeTier } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
  };
}
