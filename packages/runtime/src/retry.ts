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

export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
