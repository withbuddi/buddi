/** Load something, poll it if asked, and say how it went. */
import { useEffect, useState } from 'react';
import { ApiError } from '../api';

export function useAsync<T>(
  load: () => Promise<T>,
  deps: unknown[],
  pollMs?: number,
): { data: T | undefined; error: string | null; reload: () => void; loading: boolean } {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    load()
      .then((value) => {
        if (cancelled) return;
        setData(value);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : String(err));
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
    const handle = window.setInterval(() => setTick((n) => n + 1), pollMs);
    return () => window.clearInterval(handle);
  }, [pollMs]);

  return { data, error, loading, reload: () => setTick((n) => n + 1) };
}
