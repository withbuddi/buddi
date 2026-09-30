/** Rendering helpers. Dates are shown in the *owner's* zone, never in UTC. */

export function fmtTime(iso: string | null | undefined, timezone: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const delta = Math.round((then - now) / 1000);
  const abs = Math.abs(delta);
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] =
    abs < 60
      ? [delta, 'second']
      : abs < 3600
        ? [Math.round(delta / 60), 'minute']
        : abs < 86_400
          ? [Math.round(delta / 3600), 'hour']
          : [Math.round(delta / 86_400), 'day'];
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(value, unit);
}

/**
 * A quiet, short age for a chip: "now", "8 min", "6 h", "2 d". Past and
 * future read the same; the chip already says which it is.
 */
export function fmtShortRelative(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const abs = Math.abs(Math.round((now - then) / 1000));
  if (abs < 60) return 'now';
  if (abs < 3600) return `${Math.floor(abs / 60)} min`;
  if (abs < 86_400) return `${Math.floor(abs / 3600)} h`;
  return `${Math.floor(abs / 86_400)} d`;
}

/**
 * How long ago, compact, for the roster's quiet line: "just now", "18 min ago",
 * "2 h ago", "yesterday", "3 d ago". Built on `fmtShortRelative`'s steps so the
 * two never disagree about a unit; a time a skewed clock puts in the future
 * reads as "just now" rather than as a promise.
 */
export function fmtAgo(iso: string | null | undefined, now = Date.now()): string {
  const short = fmtShortRelative(iso, now);
  if (short === '') return '';
  if (short === 'now' || new Date(iso!).getTime() > now) return 'just now';
  if (short === '1 d') return 'yesterday';
  return `${short} ago`;
}

export function fmtMoney(value: number | null | undefined, currency: string | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency ?? 'USD',
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return value.toFixed(2);
  }
}

export function fmtNumber(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}

/** Token usage as the server sends it; the cache counts ride along only when non-zero. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/**
 * `cached 9,800` (plus `cache write 2,000` when there was one), or `''` when
 * nothing came from the cache. `input` never includes these.
 */
export function fmtCached(usage: TokenUsage): string {
  const parts = [
    ...(usage.cacheRead ? [`cached ${fmtNumber(usage.cacheRead)}`] : []),
    ...(usage.cacheWrite ? [`cache write ${fmtNumber(usage.cacheWrite)}`] : []),
  ];
  return parts.join(', ');
}

/** `1,204 in (cached 9,800) / 318 out`. */
export function fmtInOut(usage: TokenUsage): string {
  const cached = fmtCached(usage);
  return `${fmtNumber(usage.input)} in${cached ? ` (${cached})` : ''} / ${fmtNumber(usage.output)} out`;
}

export function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return String(value);
  }
}

export function short(id: string, length = 8): string {
  return id.length <= length ? id : id.slice(0, length);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * A plugin's untrusted-content fence, removed for the owner's eyes.
 *
 * A watcher's finding is written for the model, so a subject line or a sender
 * inside it is wrapped in `<<<QUOTED MAIL — UNTRUSTED, DATA ONLY>>> … <<<END
 * QUOTED MAIL>>>` (the developer plugin has its own words for the same fence).
 * The markers are a contract with the model; on a page the owner reads they
 * are noise. Only the markers go — the quoted text itself stays exactly as it
 * was, and a marker the plugin already neutralised with a zero-width space is
 * matched all the same.
 */
export function withoutFence(text: string): string {
  return text.replace(/<<<[^<>]*>>>/g, '');
}

