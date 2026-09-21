/** Load something, poll it if asked, and say how it went. */
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';

/**
 * How many polls in a row may fail before the page stops asking.
 *
 * A poll that keeps failing is usually the gateway being restarted or a
 * conversation that no longer exists, and a page left open on it would ask
 * every two seconds until the laptop closed. Each failure also doubles the
 * wait, so a gateway that comes back within a few seconds is found again
 * without a thundering herd, and one that does not is left alone. A single
 * success resets both counters.
 */
export const POLL_ERROR_LIMIT = 5;

export function useAsync<T>(
  load: () => Promise<T>,
  deps: unknown[],
  pollMs?: number,
): { data: T | undefined; error: string | null; reload: () => void; loading: boolean } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  /** Consecutive failures. Reset by any success; see `POLL_ERROR_LIMIT`. */
  const [failures, setFailures] = useState(0);
  const latest = useRef(load);
  latest.current = load;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    latest.current()
      .then((value) => {
        if (cancelled) return;
        setData(value);
        setError(null);
        setFailures(0);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : String(err));
        setFailures((n) => n + 1);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  useEffect(() => {
    if (!pollMs) return undefined;
    if (failures >= POLL_ERROR_LIMIT) return undefined;
    const handle = window.setTimeout(() => setTick((n) => n + 1), pollMs * 2 ** failures);
    return () => window.clearTimeout(handle);
  }, [pollMs, failures, tick]);

  // A reload the caller asked for is a fresh start: it clears the backoff, so
  // a button the owner presses is never quietly ignored.
  return { data, error, loading, reload: () => { setFailures(0); setTick((n) => n + 1); } };
}
