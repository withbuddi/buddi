/**
 * Wall-clock dates.
 *
 * A `Date` is an instant, not a day. "Today" only becomes a day once someone
 * names a timezone, and the owner's day is the one that matters: rendering an
 * instant with `toISOString().slice(0, 10)` calls it tomorrow from 8 PM in New
 * York onwards, which is exactly when the owner is most likely to be talking to
 * their agents about today.
 *
 * The owner's zone is `BUDDI_TZ` — the same variable the scheduler already
 * reads for mission cron — defaulting to `America/New_York`.
 */

/** The owner's timezone when `BUDDI_TZ` says nothing. */
export const DEFAULT_TIMEZONE = 'America/New_York';

/** The owner's timezone: `BUDDI_TZ`, else New York. */
export function timezoneFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env.BUDDI_TZ ?? '').trim() || DEFAULT_TIMEZONE;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    throw new Error(`unknown timezone "${timezone}"`);
  }
  formatters.set(timezone, formatter);
  return formatter;
}

/**
 * The calendar date `date` falls on in `timezone`, as `YYYY-MM-DD`.
 *
 * This is the one way a tool or a prompt is allowed to turn the clock into a
 * day. An unknown zone throws rather than silently falling back to UTC.
 */
export function localDateString(date: Date, timezone: string): string {
  if (Number.isNaN(date.getTime())) throw new Error('localDateString: invalid date');
  const parts = dateFormatter(timezone).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const year = part('year').padStart(4, '0');
  const month = part('month').padStart(2, '0');
  const day = part('day').padStart(2, '0');
  return `${year}-${month}-${day}`;
}
