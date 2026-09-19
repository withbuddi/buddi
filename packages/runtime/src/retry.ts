/**
 * One retry policy, shared by every adapter.
 *
 * Two adapters with two backoff curves would mean the port's *behaviour* still
 * depended on which provider was pinned, which is the thing the port exists to
 * remove. So the budget, the retryable statuses and the `Retry-After` handling
 * live here and both adapters import them.
 */

/** Backoff before attempts 2, 3 and 4. Three retries, then give up. */
export const RETRY_DELAYS_MS: readonly number[] = [500, 1500, 4000];

/**
 * The same thing for a failure that never reached the model: a socket that was
 * refused, reset or went silent, a DNS answer that did not come.
 *
 * It is deliberately longer than the status curve, because the two are not the
 * same kind of "not now". A 429 is the provider telling us how busy it is, and
 * it will tell us again; a connection that did not come up is a gap in the
 * road, and the only question is how long the gap is. Four seconds of trying —
 * what the one shared curve used to give both — is thinner than an ordinary
 * network event: a wifi handover, a DNS server rotating, a load balancer
 * draining a node all take longer than that, and the owner's turn died inside
 * one of them.
 *
 * Five retries on 0.25s, 0.75s, 2s, 4s, 6s: **thirteen seconds** of waiting
 * across six attempts. Front-loaded on purpose — the first retry is a quarter
 * of a second, because the common case really is one dead socket and the
 * second attempt simply works, and there is no reason to make somebody wait
 * half a second to find that out.
 *
 * `TRANSPORT_RETRY_WINDOW_MS` is the promise that goes with it: no new attempt
 * is *started* more than twenty seconds after the first one was, whatever the
 * curve says and however long the attempts themselves took. So the worst case
 * a person waits is twenty seconds of retrying plus however long the attempt
 * they are inside takes to fail. Twenty is chosen against what a person does:
 * a spinner that has been going for twenty seconds still reads as working, and
 * one still going at a minute reads as hung.
 */
export const TRANSPORT_RETRY_DELAYS_MS: readonly number[] = [250, 750, 2000, 4000, 6000];

/** No attempt begins later than this after the first one did. */
export const TRANSPORT_RETRY_WINDOW_MS = 20_000;

/**
 * Cap on a server-supplied `Retry-After`. A host asking us to sleep for an hour
 * is telling us to fail, not to wait: an owner is usually at a prompt.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/** 429 (rate limit), 529 (Anthropic overloaded) and anything 5xx. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 529 || status >= 500;
}

/**
 * `Retry-After` in milliseconds, or undefined when the header is absent or
 * unusable. Both forms of the header are accepted: delta-seconds and an HTTP
 * date (RFC 9110 §10.2.3).
 */
/** Provider advice for display, not the locally capped retry sleep budget. */
export function providerRetryAt(headers: { get?(name: string): string | null } | undefined, now = Date.now()): string | null {
  const value = headers?.get?.('retry-after')?.trim();
  if (!value) return null;
  const at = /^\d+$/.test(value) ? now + Number(value) * 1000
    : /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(at) && at >= now && at <= now + 366 * 86400_000 ? new Date(at).toISOString() : null;
}

export function retryAfterMs(
  headers: { get?(name: string): string | null } | undefined,
  now: number = Date.now(),
): number | undefined {
  const raw = headers?.get?.('retry-after');
  if (!raw) return undefined;
  const value = raw.trim();
  if (/^\d+$/.test(value)) {
    return Math.min(Number(value) * 1000, MAX_RETRY_AFTER_MS);
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS);
}

/**
 * How long to wait before attempt `attempt` (1-based: the delay *after* the
 * first failure is `nextDelayMs(1, res)`). A server's own `Retry-After` wins
 * over the curve when it asks for longer — it knows its own window.
 */
export function nextDelayMs(
  attempt: number,
  headers?: { get?(name: string): string | null },
  now: number = Date.now(),
): number {
  const backoff = RETRY_DELAYS_MS[attempt - 1] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 0;
  const asked = retryAfterMs(headers, now);
  return asked === undefined ? backoff : Math.max(backoff, asked);
}

/**
 * Wait before transport attempt `attempt` (1-based, as `nextDelayMs`), or
 * `undefined` when there is to be no next attempt.
 *
 * Two bounds, and the tighter one wins: the curve runs out, or the window
 * closes. `elapsedMs` is measured from the first attempt, so a run of attempts
 * that each took four seconds to fail stops after the window even though the
 * curve had delays left — which is the point of having a window at all.
 */
export function nextTransportDelayMs(attempt: number, elapsedMs: number): number | undefined {
  const delay = TRANSPORT_RETRY_DELAYS_MS[attempt - 1];
  if (delay === undefined) return undefined;
  if (elapsedMs + delay > TRANSPORT_RETRY_WINDOW_MS) return undefined;
  return delay;
}

/** How many transport attempts there can be in total, including the first. */
export const MAX_TRANSPORT_ATTEMPTS = TRANSPORT_RETRY_DELAYS_MS.length + 1;

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
