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

