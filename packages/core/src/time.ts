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

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormatter(timezone: string): Intl.DateTimeFormat {
  const cached = dateTimeFormatters.get(timezone);
  if (cached) return cached;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      // `h23` rather than `hour12: false`: the latter renders midnight as 24.
      hourCycle: 'h23',
      timeZoneName: 'short',
    });
  } catch {
    throw new Error(`unknown timezone "${timezone}"`);
  }
  dateTimeFormatters.set(timezone, formatter);
  return formatter;
}

/**
 * The instant as the owner's wall clock shows it: `2026-09-13 17:35 EDT`.
 *
 * Sortable like the date it extends, minutes only — a paired device is not an
 * event whose second matters — and always with the zone spelled out, because a
 * timestamp with no zone is exactly the ambiguity this module exists to remove.
 */
export function localDateTimeString(date: Date, timezone: string): string {
  if (Number.isNaN(date.getTime())) throw new Error('localDateTimeString: invalid date');
  const parts = dateTimeFormatter(timezone).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  const year = part('year').padStart(4, '0');
  const month = part('month').padStart(2, '0');
  const day = part('day').padStart(2, '0');
  const hour = part('hour').padStart(2, '0');
  const minute = part('minute').padStart(2, '0');
  const zone = part('timeZoneName');
  return `${year}-${month}-${day} ${hour}:${minute}${zone === '' ? '' : ` ${zone}`}`;
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

/**
 * Is this a zone `Intl` actually knows?
 *
 * The one check anything writing a timezone must pass. `Intl` is the authority
 * rather than a list shipped here: the zone database changes, and a hardcoded
 * set would start refusing real places. A name it does not know is refused
 * without a suggestion — guessing "EST" meant `America/New_York` is exactly
 * how an installation ends up a day off twice a year.
 */
export function isKnownTimezone(timezone: string): boolean {
  const name = timezone.trim();
  if (name === '') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** `HH:MM` on a 24-hour clock, `00:00` to `23:59`. */
export const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Minutes since local midnight for `HH:MM`; throws on anything else. */
export function minutesOfLocalTime(hhmm: string): number {
  const match = LOCAL_TIME.exec(hhmm.trim());
  if (!match) throw new Error(`"${hhmm}" is not a time like 18:00`);
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Where the owner's wall clock stands at `date`, in minutes since local midnight. */
export function localMinutesOfDay(date: Date, timezone: string): number {
  const parts = dateTimeFormatter(timezone).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return part('hour') * 60 + part('minute');
}

/** How far `timezone` is ahead of UTC at `instant`, in milliseconds, to the minute. */
function zoneOffsetMs(instant: number, timezone: string): number {
  const parts = dateTimeFormatter(timezone).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'));
  return wall - Math.floor(instant / 60_000) * 60_000;
}

/** The instant the owner's clock reads `minutes` past midnight on the local day `y-m-d`. */
function instantOfLocal(y: number, m: number, d: number, minutes: number, timezone: string): Date {
  const wall = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let at = wall - zoneOffsetMs(wall, timezone);
  // Once more, for a day on which the offset changes between the guess and the answer.
  const second = wall - zoneOffsetMs(at, timezone);
  if (second !== at) at = second;
  return new Date(at);
}

/**
 * The next instant after `after` at which the owner's clock reads `hhmm`:
 * today when that time is still ahead, tomorrow otherwise. The end of the
 * working day, the end of quiet hours.
 */
export function nextLocalTime(after: Date, timezone: string, hhmm: string): Date {
  const minutes = minutesOfLocalTime(hhmm);
  const [y, m, d] = localDateString(after, timezone).split('-').map(Number) as [number, number, number];
  const today = instantOfLocal(y, m, d, minutes, timezone);
  if (today.getTime() > after.getTime()) return today;
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
  return instantOfLocal(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), minutes, timezone);
}
