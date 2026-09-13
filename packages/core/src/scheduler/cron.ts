/**
 * A small 5-field cron parser and next-instant solver.
 *
 * Fields: `minute hour day-of-month month day-of-week`, supporting `*`, lists
 * (`1,15`), ranges (`1-5`), steps (`*\/15`, `0-30/10`, `5/10`) and the usual
 * three-letter month/day names. Day-of-month and day-of-week follow the
 * traditional Vixie rule: when *both* are restricted the match is a union.
 *
 * Timezones are resolved with `Intl.DateTimeFormat` alone — core takes no
 * external dependency for this. DST is defined explicitly:
 *   - a wall-clock time that does not exist (spring-forward gap) is skipped;
 *   - a wall-clock time that happens twice (fall-back) fires on the *first*
 *     instant, and `nextAfter` still only ever returns instants strictly after
 *     `from`, so the repeated hour cannot produce a duplicate occurrence.
 */

export type CronSpec = {
  readonly source: string;
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
};

type FieldDef = {
  name: string;
  min: number;
  max: number;
  names?: Record<string, number>;
};

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

const FIELDS: readonly FieldDef[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { name: 'day-of-week', min: 0, max: 7, names: DOW_NAMES },
];

function parseValue(raw: string, field: FieldDef): number {
  const token = raw.trim().toLowerCase();
  if (field.names && token in field.names) return field.names[token] as number;
  if (!/^\d+$/.test(token)) {
    throw new Error(`cron: invalid ${field.name} value "${raw}"`);
  }
  const n = Number(token);
  if (n < field.min || n > field.max) {
    throw new Error(
      `cron: ${field.name} value ${n} out of range ${field.min}-${field.max}`,
    );
  }
  return n;
}

function parseField(raw: string, field: FieldDef): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  let restricted = false;

  for (const part of raw.split(',')) {
    const piece = part.trim();
    if (piece === '') throw new Error(`cron: empty ${field.name} element in "${raw}"`);

    const [rangePart, stepPart, ...rest] = piece.split('/');
    if (rest.length > 0) throw new Error(`cron: invalid step in ${field.name} "${piece}"`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) === 0) {
        throw new Error(`cron: invalid step "${stepPart}" in ${field.name}`);
      }
      step = Number(stepPart);
    }

    let lo: number;
    let hi: number;
    const range = (rangePart ?? '').trim();
    if (range === '*' || range === '?') {
      lo = field.min;
      hi = field.max;
    } else if (range.includes('-')) {
      const [a, b, ...extra] = range.split('-');
      if (extra.length > 0 || a === undefined || b === undefined) {
        throw new Error(`cron: invalid ${field.name} range "${range}"`);
      }
      lo = parseValue(a, field);
      hi = parseValue(b, field);
      restricted = true;
    } else {
      lo = parseValue(range, field);
      hi = stepPart !== undefined ? field.max : lo;
      restricted = true;
    }

    if (lo > hi) throw new Error(`cron: inverted ${field.name} range "${range}"`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }

  if (field.name === 'day-of-week' && values.has(7)) {
    values.delete(7);
    values.add(0);
  }
  if (values.size === 0) throw new Error(`cron: ${field.name} matches nothing`);
  return { values, restricted };
}

/** Parse a 5-field cron expression. Throws on anything it cannot represent. */
export function parseCron(expression: string): CronSpec {
  const source = expression.trim();
  if (source === '') throw new Error('cron: empty expression');
  const parts = source.split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron: expected 5 fields, got ${parts.length} in "${expression}"`);
  }

  const parsed = parts.map((part, i) => parseField(part, FIELDS[i] as FieldDef));

  return {
    source,
    minutes: parsed[0]!.values,
    hours: parsed[1]!.values,
    daysOfMonth: parsed[2]!.values,
    months: parsed[3]!.values,
    daysOfWeek: parsed[4]!.values,
    domRestricted: parsed[2]!.restricted,
    dowRestricted: parsed[4]!.restricted,
  };
}

// ---------------------------------------------------------------------------
// Timezone plumbing (Intl only)
// ---------------------------------------------------------------------------

export type WallClock = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      throw new Error(`cron: unknown timezone "${timeZone}"`);
    }
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** The wall-clock reading of `date` in `timeZone`. */
export function toWallClock(date: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    if (!found) throw new Error(`cron: missing ${type} part for ${timeZone}`);
    return Number(found.value);
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset of `timeZone` from UTC at instant `date`, in milliseconds (east positive). */
export function zoneOffsetMs(date: Date, timeZone: string): number {
  const w = toWallClock(date, timeZone);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asIfUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function sameWall(a: WallClock, b: WallClock): boolean {
  return (
    a.year === b.year &&
    a.month === b.month &&
    a.day === b.day &&
    a.hour === b.hour &&
    a.minute === b.minute
  );
}

/**
 * Convert a wall-clock reading in `timeZone` to an instant.
 * Returns `null` when the local time does not exist (spring-forward gap).
 * Ambiguous times (fall-back) resolve to the earlier of the two instants.
 */
export function wallClockToInstant(wall: WallClock, timeZone: string): Date | null {
  const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  let ts = target - zoneOffsetMs(new Date(target), timeZone);
  ts = target - zoneOffsetMs(new Date(ts), timeZone);

  const candidates = [ts, ts - 3_600_000, ts + 3_600_000];
  let best: number | null = null;
  for (const c of candidates) {
    if (sameWall(toWallClock(new Date(c), timeZone), wall)) {
      if (best === null || c < best) best = c;
    }
  }
  return best === null ? null : new Date(best);
}

// ---------------------------------------------------------------------------
// next-instant solver
// ---------------------------------------------------------------------------

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function dateMatches(spec: CronSpec, year: number, month: number, day: number): boolean {
  if (!spec.months.has(month)) return false;
  const domHit = spec.daysOfMonth.has(day);
  const dowHit = spec.daysOfWeek.has(dayOfWeek(year, month, day));
  if (spec.domRestricted && spec.dowRestricted) return domHit || dowHit;
  if (spec.domRestricted) return domHit;
  if (spec.dowRestricted) return dowHit;
  return true;
}

function sortedAsc(set: ReadonlySet<number>): number[] {
  return [...set].sort((a, b) => a - b);
}

const MAX_DAY_SCAN = 366 * 5;

/**
 * The first instant strictly after `from` that matches `spec` in `timezone`.
 * Returns `null` if nothing matches within five years (e.g. `0 0 30 2 *`).
 */
export function nextAfter(
  spec: CronSpec | string,
  from: Date,
  timezone: string,
): Date | null {
  const cron = typeof spec === 'string' ? parseCron(spec) : spec;
  const minutes = sortedAsc(cron.minutes);
  const hours = sortedAsc(cron.hours);

  // Earliest candidate: the minute after `from`, floor-ed to the minute.
  const startTs = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  let wall: WallClock = { ...toWallClock(new Date(startTs), timezone), second: 0 };

  let daysScanned = 0;
  while (daysScanned <= MAX_DAY_SCAN) {
    if (!dateMatches(cron, wall.year, wall.month, wall.day)) {
      wall = nextDay(wall);
      daysScanned += 1;
      continue;
    }

    const hour = hours.find((h) => h >= wall.hour);
    if (hour === undefined) {
      wall = nextDay(wall);
      daysScanned += 1;
      continue;
    }
    const minute =
      hour === wall.hour ? minutes.find((m) => m >= wall.minute) : minutes[0];
    if (minute === undefined) {
      wall = { ...wall, hour: wall.hour + 1, minute: 0 };
      if (wall.hour > 23) {
        wall = nextDay(wall);
        daysScanned += 1;
      }
      continue;
    }

    const candidate: WallClock = { ...wall, hour, minute, second: 0 };
    const instant = wallClockToInstant(candidate, timezone);
    if (instant !== null && instant.getTime() > from.getTime()) return instant;

    // Nonexistent local time (DST gap), or an ambiguous repeat that would land
    // at or before `from`: step one wall minute and keep looking.
    wall = addWallMinute(candidate);
    if (wall.day !== candidate.day) daysScanned += 1;
  }
  return null;
}

function nextDay(wall: WallClock): WallClock {
  let { year, month, day } = wall;
  day += 1;
  if (day > daysInMonth(year, month)) {
    day = 1;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return { year, month, day, hour: 0, minute: 0, second: 0 };
}

function addWallMinute(wall: WallClock): WallClock {
  let { hour, minute } = wall;
  minute += 1;
  if (minute > 59) {
    minute = 0;
    hour += 1;
  }
  if (hour > 23) return nextDay(wall);
  return { ...wall, hour, minute, second: 0 };
}

/**
 * All matching instants in `(after, through]`, oldest first.
 * `limit` bounds the catch-up window so a long sleep cannot allocate forever.
 */
export function instantsBetween(
  spec: CronSpec | string,
  after: Date,
  through: Date,
  timezone: string,
  limit = 10_000,
): Date[] {
  const cron = typeof spec === 'string' ? parseCron(spec) : spec;
  const out: Date[] = [];
  let cursor = after;
  while (out.length < limit) {
    const next = nextAfter(cron, cursor, timezone);
    if (next === null || next.getTime() > through.getTime()) break;
    out.push(next);
    cursor = next;
  }
  return out;
}
