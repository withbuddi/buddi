/** Rendering helpers. Dates are shown in the *owner's* zone, never in UTC. */

/*
 * Times and dates, the owner's way (Settings → Profile): every date and time
 * the dashboard draws goes through here. Time is 12-hour, 24-hour or Auto (the
 * browser's language decides); dates are "Thu, Oct 1", "Thursday, 1 October",
 * ISO "2026-10-01" or Auto. The shell sets the choice once from the session
 * and again when the owner saves it.
 */
export type TimeFormat = 'auto' | '12h' | '24h';
export type DateFormat = 'auto' | 'short' | 'long' | 'iso';

let formats: { time: TimeFormat; date: DateFormat; locale: string | undefined } = { time: 'auto', date: 'auto', locale: undefined };

/**
 * Set how times and dates read: a key left out keeps what it was, null or an
 * unknown word is Auto. `locale` is for tests; the browser's otherwise.
 */
export function setDisplayFormats(next: { timeFormat?: string | null; dateFormat?: string | null; locale?: string }): void {
  const time = next.timeFormat === undefined ? formats.time : next.timeFormat === '12h' || next.timeFormat === '24h' ? next.timeFormat : 'auto';
  const date =
    next.dateFormat === undefined ? formats.date : next.dateFormat === 'short' || next.dateFormat === 'long' || next.dateFormat === 'iso' ? next.dateFormat : 'auto';
  formats = { time, date, locale: next.locale ?? formats.locale };
}

export function displayFormats(): { time: TimeFormat; date: DateFormat } {
  return { time: formats.time, date: formats.date };
}

/** What `fn` draws under other formats, the current ones put back after: the picker's examples. */
export function underFormats<T>(next: { timeFormat?: string | null; dateFormat?: string | null }, fn: () => T): T {
  const kept = formats;
  setDisplayFormats(next);
  try {
    return fn();
  } finally {
    formats = kept;
  }
}

/** Tell the open pages the owner changed how times and dates read: the shell draws again. */
export const FORMATS_CHANGED = 'buddi:formats';

function browserLocale(): string {
  if (formats.locale) return formats.locale;
  try {
    return typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US';
  } catch {
    return 'en-US';
  }
}

const cache = new Map<string, Intl.DateTimeFormat>();
function intl(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let found = cache.get(key);
  if (!found) {
    try {
      found = new Intl.DateTimeFormat(locale, options);
    } catch {
      // An unknown zone: the same reading in UTC, never a thrown page.
      found = new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' });
    }
    cache.set(key, found);
  }
  return found;
}

function parts(at: Date, timezone: string, locale: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  return Object.fromEntries(intl(locale, { timeZone: timezone, ...options }).formatToParts(at).map((p) => [p.type, p.value]));
}

function clockOptions(): Intl.DateTimeFormatOptions {
  if (formats.time === '12h') return { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' };
  if (formats.time === '24h') return { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  // Auto: the browser's clock — two-digit hours where the day runs to 24 ("09:30"), not where it runs to 12.
  return { hour: usesTwelveHours() ? 'numeric' : '2-digit', minute: '2-digit' };
}

function clockLocale(): string {
  // 12-hour and 24-hour are spelled the English way ("2:05 PM", "14:05") whatever the browser says.
  return formats.time === 'auto' ? browserLocale() : 'en-US';
}

/** "14:05" or "2:05 PM", in the zone. */
export function fmtClock(at: Date, timezone: string): string {
  if (Number.isNaN(at.getTime())) return '—';
  return intl(clockLocale(), { timeZone: timezone, ...clockOptions() }).format(at);
}

/** Minutes after midnight as a clock: 570 → "09:30" or "9:30 AM". The calendar's grid and chips. */
export function fmtMinutes(minutes: number): string {
  // The end of a day is 24:00 on a 24-hour clock, midnight on a 12-hour one.
  if (minutes >= 1440 && !usesTwelveHours()) return '24:00';
  return fmtClock(new Date(Date.UTC(2026, 0, 1, Math.floor(minutes / 60) % 24, minutes % 60)), 'UTC');
}

/** Whether a clock in the owner's format runs to 12: "AM"/"PM" follow. */
export function usesTwelveHours(): boolean {
  if (formats.time !== 'auto') return formats.time === '12h';
  return intl(browserLocale(), { hour: 'numeric' }).resolvedOptions().hourCycle?.startsWith('h1') === true;
}

/** The Profile choice of a time format, saying what it means now: "Profile (12-hour)". */
export function profileTimeLabel(): string {
  return `Profile (${usesTwelveHours() ? '12-hour' : '24-hour'})`;
}

/** Whether the owner's dates put the month before the day ("Oct 1"), for ranges built by hand. */
export function monthFirst(): boolean {
  if (formats.date !== 'auto') return formats.date === 'short';
  const order = intl(browserLocale(), { month: 'short', day: 'numeric' }).formatToParts(new Date(Date.UTC(2026, 9, 1))).map((p) => p.type);
  return order.indexOf('month') < order.indexOf('day');
}

/**
 * The day, the owner's way. `weekday` adds the day's name (a heading: Home,
 * the lock screen); `year` adds the year; `compact` keeps a month short (a
 * table cell).
 */
export function fmtDate(at: Date, timezone: string, opts: { weekday?: boolean; year?: boolean; compact?: boolean } = {}): string {
  // One spelling of September's short name everywhere: some locales write "Sept".
  return dateText(at, timezone, opts).replace(/\bSept\b/g, 'Sep');
}

function dateText(at: Date, timezone: string, opts: { weekday?: boolean; year?: boolean; compact?: boolean }): string {
  if (Number.isNaN(at.getTime())) return '—';
  const { weekday = false, year = false, compact = false } = opts;
  switch (formats.date) {
    case 'iso': {
      const p = parts(at, timezone, 'en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', ...(weekday ? { weekday: compact ? 'short' : 'long' } : {}) });
      const day = `${p.year}-${p.month}-${p.day}`;
      return weekday ? `${p.weekday} ${day}` : day;
    }
    case 'short': {
      const p = parts(at, timezone, 'en-US', { month: 'short', day: 'numeric', year: 'numeric', weekday: 'short' });
      return `${weekday ? `${p.weekday}, ` : ''}${p.month} ${p.day}${year ? `, ${p.year}` : ''}`;
    }
    case 'long': {
      const p = parts(at, timezone, 'en-GB', { month: compact ? 'short' : 'long', day: 'numeric', year: 'numeric', weekday: compact ? 'short' : 'long' });
      return `${weekday ? `${p.weekday}, ` : ''}${p.day} ${p.month}${year ? ` ${p.year}` : ''}`;
    }
    default:
      return intl(browserLocale(), {
        timeZone: timezone,
        month: compact ? 'short' : 'long',
        day: 'numeric',
        ...(year ? { year: 'numeric' } : {}),
        ...(weekday ? { weekday: compact ? 'short' : 'long' } : {}),
      }).format(at);
  }
}

/**
 * A month as a heading, the owner's way: "October 2026" (short and long),
 * "2026-10" (ISO), or the browser's own words on Auto ("octobre 2026").
 */
export function fmtMonth(year: number, month: number): string {
  if (formats.date === 'iso') return `${year}-${String(month).padStart(2, '0')}`;
  const at = new Date(Date.UTC(year, month - 1, 15));
  const locale = formats.date === 'auto' ? browserLocale() : 'en-GB';
  return intl(locale, { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(at);
}

/** A calendar day (`2026-10-01`), the owner's way, read as that day wherever it is drawn. */
export function fmtDay(day: string, opts: { weekday?: boolean; year?: boolean; compact?: boolean } = {}): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!match) return day;
  const at = new Date(`${match[0]}T12:00:00Z`);
  return Number.isNaN(at.getTime()) ? day : fmtDate(at, 'UTC', opts);
}

/** A moment in a table or a sheet: the day with its year, and the time. */
export function fmtTime(iso: string | null | undefined, timezone: string): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return `${fmtDate(date, timezone, { year: true, compact: true })}, ${fmtClock(date, timezone)}`;
}

/** A moment with no year, for a short line: "Thu, Oct 1, 2:05 PM". */
export function fmtMoment(at: Date, timezone: string): string {
  return `${fmtDate(at, timezone, { weekday: true, compact: true })}, ${fmtClock(at, timezone)}`;
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


/**
 * A notification's title as the dashboard draws it. An agent's own message
 * (`owner.notify`) is stored signed — "@ledger: Charged twice" — because
 * Telegram and the end-of-day summary need to say who wrote it; on the
 * dashboard the agent is already named beside it (its face, its name), so the
 * signature is left off. Only the first "@handle: " of an agent message goes.
 */
export function notificationTitle(row: { kind: string; title: string }): string {
  if (row.kind !== 'agent') return row.title;
  const bare = row.title.replace(/^@[^\s:]+:\s+/, '');
  return bare.trim() === '' ? row.title : bare;
}
