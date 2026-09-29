/**
 * The calendar component's arithmetic, kept apart from the drawing so it can
 * be tested without a DOM.
 *
 * Everything is in the owner's zone, never the browser's: a date is a
 * `YYYY-MM-DD` string, a time is minutes after midnight, and an instant from
 * the query is turned into both once, through `Intl`, as it arrives. Weeks
 * start on Monday. The same rules as the design kit's Calendar screen
 * (`buddi-design/design-system/ui_kits/dashboard/Pages.jsx`).
 */
import { readPath } from '../canvas/resolve';
import type { CalendarMap } from './types';

export type CalendarView = 'week' | 'month' | 'list';

/** One event, as the views read it. */
export interface CalEvent {
  id: string;
  title: string;
  allDay: boolean;
  /** Start and end as dates and minutes; an all-day `endDate` is the day after its last. */
  startDate: string;
  startMin: number;
  endDate: string;
  endMin: number;
  calendar: string;
  /** 0 to 3: one of the four pinned tones. */
  tone: number;
  location: string;
}

/** The part of an event on one day. */
export interface DayPart {
  from: number;
  to: number;
  allDay: boolean;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parts(date: string): [number, number, number] {
  return date.split('-').map(Number) as [number, number, number];
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** 0 for Sunday. */
export function weekday(date: string): number {
  const [y, m, d] = parts(date);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function weekdayName(date: string): string {
  return WEEKDAYS[weekday(date)] as string;
}

export function dayOfMonth(date: string): number {
  return parts(date)[2];
}

export function mondayOf(date: string): string {
  return addDays(date, -((weekday(date) + 6) % 7));
}

/** "Mon 28 Sep". */
export function dayLabel(date: string): string {
  const [, m, d] = parts(date);
  return `${weekdayName(date)} ${d} ${MONTHS[m - 1]}`;
}

/** "Today · Mon 28 Sep", "Tomorrow · Tue 29 Sep", then "Wed 30 Sep". */
export function dayTitle(date: string, today: string): string {
  if (date === today) return `Today · ${dayLabel(date)}`;
  if (date === addDays(today, 1)) return `Tomorrow · ${dayLabel(date)}`;
  return dayLabel(date);
}

export function hm(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** An instant's date and minute in the zone. */
export function wallClock(at: Date, timezone: string): { date: string; minutes: number } {
  let format = formatters.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timezone, format);
  }
  const p = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}

export function todayIn(timezone: string, now: Date = new Date()): string {
  return wallClock(now, timezone).date;
}

/** The days a view shows around a date: a week from Monday, six weeks, or seven days from it. */
export function rangeOf(view: CalendarView, anchor: string): { from: string; days: number } {
  if (view === 'week') return { from: mondayOf(anchor), days: 7 };
  if (view === 'month') return { from: mondayOf(`${anchor.slice(0, 8)}01`), days: 42 };
  return { from: anchor, days: 7 };
}

/** One step back or on: a week, or a month (landing on its first). */
export function move(view: CalendarView, anchor: string, dir: -1 | 1): string {
  if (view !== 'month') return addDays(anchor, dir * 7);
  const [y, m] = parts(anchor);
  return new Date(Date.UTC(y, m - 1 + dir, 1)).toISOString().slice(0, 10);
}

/** "28 Sep – 4 Oct 2026", "September 2026". */
export function rangeTitle(view: CalendarView, anchor: string, from: string, days: number): string {
  const [y, m] = parts(anchor);
  if (view === 'month') return `${MONTH_NAMES[m - 1]} ${y}`;
  const last = addDays(from, days - 1);
  const [fy, fm, fd] = parts(from);
  const [ly, lm, ld] = parts(last);
  if (fm === lm && fy === ly) return `${fd} – ${ld} ${MONTHS[lm - 1]} ${ly}`;
  if (fy === ly) return `${fd} ${MONTHS[fm - 1]} – ${ld} ${MONTHS[lm - 1]} ${ly}`;
  return `${fd} ${MONTHS[fm - 1]} ${fy} – ${ld} ${MONTHS[lm - 1]} ${ly}`;
}

function text(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

/**
 * The query's rows as events, or left out: a row without an id, a title or a
 * start it can read is not drawn (and said so in the console, naming where).
 */
export function toEvents(rows: readonly unknown[], map: CalendarMap, timezone: string, where: string): CalEvent[] {
  const out: CalEvent[] = [];
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const id = text(readPath(row, map.id));
    const title = text(readPath(row, map.title));
    const start = text(readPath(row, map.start));
    const end = text(readPath(row, map.end));
    if (id === '' || seen.has(id) || start === '') {
      console.warn(`buddi: ${where}: event ${index} has no id, a repeated one, or no start — not drawn`);
      return;
    }
    seen.add(id);
    const flag = map.allDay === undefined ? undefined : readPath(row, map.allDay);
    const allDay = flag === undefined ? DATE_ONLY.test(start) : flag === true || flag === 'true';
    const toneRaw = map.tone === undefined ? 0 : Number(readPath(row, map.tone));
    const tone = Number.isFinite(toneRaw) ? ((Math.trunc(toneRaw) % 4) + 4) % 4 : 0;
    const common = {
      id,
      title,
      calendar: map.calendar === undefined ? '' : text(readPath(row, map.calendar)),
      tone,
      location: map.location === undefined ? '' : text(readPath(row, map.location)),
    };
    if (allDay) {
      const startDate = start.slice(0, 10);
      const endDate = DATE_ONLY.test(end.slice(0, 10)) && end.slice(0, 10) > startDate ? end.slice(0, 10) : addDays(startDate, 1);
      out.push({ ...common, allDay: true, startDate, startMin: 0, endDate, endMin: 0 });
      return;
    }
    const s = new Date(start);
    if (Number.isNaN(s.getTime())) {
      console.warn(`buddi: ${where}: event ${index} starts at "${start}", which is not a time — not drawn`);
      return;
    }
    const e = new Date(end);
    const a = wallClock(s, timezone);
    const b = Number.isNaN(e.getTime()) || e < s ? a : wallClock(e, timezone);
    out.push({ ...common, allDay: false, startDate: a.date, startMin: a.minutes, endDate: b.date, endMin: b.minutes });
  });
  return out;
}

/** The part of an event on one day, or null when it is not on it. */
export function partOn(event: CalEvent, date: string): DayPart | null {
  if (event.allDay) return date >= event.startDate && date < event.endDate ? { from: 0, to: 1440, allDay: true } : null;
  if (date < event.startDate || date > event.endDate) return null;
  const from = date === event.startDate ? event.startMin : 0;
  const to = date === event.endDate ? event.endMin : 1440;
  const instant = event.startDate === event.endDate && event.startMin === event.endMin;
  if (to <= from && !(instant && date === event.startDate)) return null;
  // A day an event crosses whole is an all-day day for it.
  return { from, to, allDay: from === 0 && to === 1440 };
}

/** A day's events: all-day first, then by start, the longer first. */
export function eventsOn(events: readonly CalEvent[], date: string): Array<{ event: CalEvent; part: DayPart }> {
  return events
    .map((event) => ({ event, part: partOn(event, date) }))
    .filter((x): x is { event: CalEvent; part: DayPart } => x.part !== null)
    .sort(
      (a, b) =>
        Number(b.part.allDay) - Number(a.part.allDay) || a.part.from - b.part.from || b.part.to - a.part.to,
    );
}

/** "09:30–10:00", "All day", "from 22:00", "until 02:00". */
export function timeOf(event: CalEvent, part: DayPart): string {
  if (part.allDay) return 'All day';
  const crosses = event.startDate !== event.endDate;
  if (crosses && part.from === 0) return `until ${hm(part.to)}`;
  if (crosses && part.to === 1440) return `from ${hm(part.from)}`;
  return part.from === part.to ? hm(part.from) : `${hm(part.from)}–${hm(part.to)}`;
}

/** What a screen reader hears for an event. */
export function summaryOf(event: CalEvent, part: DayPart, date: string): string {
  return [timeOf(event, part), event.title, event.location, event.calendar, dayLabel(date)].filter(Boolean).join(', ');
}

/** The shortest an event is drawn, in minutes, so its words fit. */
export const MIN_DRAWN = 30;

/**
 * Side by side where they overlap: each timed part's lane, and how many lanes
 * the cluster it belongs to has.
 */
export function lanesOf<T extends { part: DayPart }>(items: readonly T[]): Array<T & { lane: number; lanes: number }> {
  const out: Array<T & { lane: number; lanes: number }> = [];
  let cluster: Array<T & { lane: number; lanes: number }> = [];
  let clusterEnd = -1;
  const lanes: number[] = [];
  const flush = (): void => {
    const count = Math.max(1, ...cluster.map((c) => c.lane + 1));
    for (const c of cluster) out.push({ ...c, lanes: count });
    cluster = [];
    lanes.length = 0;
  };
  for (const item of items) {
    const end = Math.max(item.part.to, item.part.from + MIN_DRAWN);
    if (cluster.length > 0 && item.part.from >= clusterEnd) flush();
    let lane = lanes.findIndex((free) => free <= item.part.from);
    if (lane === -1) {
      lane = lanes.length;
      lanes.push(end);
    } else lanes[lane] = end;
    cluster.push({ ...item, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, end);
  }
  if (cluster.length > 0) flush();
  return out;
}
