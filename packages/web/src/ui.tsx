/** The handful of shared pieces every view uses. */
import { useEffect, useState, type ReactNode } from 'react';
import { ApiError } from './api';

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

export function Panel({ title, children }: { title?: string; children: ReactNode }): JSX.Element {
  return (
    <>
      {title ? <h3>{title}</h3> : null}
      <div className="wrap">{children}</div>
    </>
  );
}

export function Card({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: 'ok' | 'warn' | 'bad';
}): JSX.Element {
  return (
    <div className="card">
      <div className="k">{label}</div>
      <div className={`v ${tone ?? ''}`}>{value}</div>
      {note ? <div className="n">{note}</div> : null}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string | null }): JSX.Element | null {
  if (!message) return null;
  return <div className="err-banner">{message}</div>;
}

export function Empty({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="muted" style={{ padding: '10px' }}>
      {children}
    </p>
  );
}

export function Drawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className="drawer-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <aside className="drawer">
        <header>
          <h2>{title}</h2>
          <button onClick={onClose}>Close</button>
        </header>
        {children}
      </aside>
    </div>
  );
}

export function StatePill({ state }: { state: string }): JSX.Element {
  const tone =
    state === 'succeeded' || state === 'approved' || state === 'fired'
      ? 'ok'
      : state === 'failed' || state === 'rejected' || state === 'unknown'
        ? 'bad'
        : state === 'pending' || state === 'suspended' || state === 'expired'
          ? 'warn'
          : '';
  return <span className={`pill ${tone}`}>{state}</span>;
}
