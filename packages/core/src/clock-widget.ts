/**
 * The World clock: a widget buddi itself provides (no plugin to install) —
 * the time at the owner's places in other zones, or at any town they pick,
 * in the owner's format unless the placement says otherwise. Digital draws
 * a figure or rows; Analog answers a `clocks` body the page ticks itself.
 *
 * It reads nothing but the clock and the settings it is handed (places come
 * resolved, `widget-settings.ts`), so it is produced on every answer rather
 * than cached: a clock a minute late is a wrong clock.
 */
import type { OwnerPlace } from './places.js';
import { WIDGET_CLOCKS_MAX, type WidgetBody, type WidgetClocks, type WidgetSize } from './widgets.js';
import type { WidgetPlace, WidgetSettingField, WidgetSettings } from './widget-settings.js';

export const CLOCK_WIDGET_ID = 'buddi.clock';

/** The definition the gallery and the settings sheet read. */
export const CLOCK_WIDGET = {
  id: CLOCK_WIDGET_ID,
  plugin: 'buddi',
  title: 'World clock',
  sizes: ['small', 'medium'] as WidgetSize[],
  settings: [
    {
      key: 'style', kind: 'select', label: 'Style', default: 'digital',
      options: [{ value: 'digital', label: 'Digital' }, { value: 'analog', label: 'Analog' }],
      hint: 'Analog: a face for each place, yours first — four at medium, two at small.',
    },
    { key: 'places', kind: 'place', multiple: true, label: 'Places', hint: 'Up to three. None picked: your places in other zones.' },
    { key: 'time', kind: 'timeFormat', label: 'Times', hint: 'Analog faces say it on hover and to a screen reader.' },
  ] as WidgetSettingField[],
};

function parts(at: Date, zone: string): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
}

/** Minutes a zone is ahead of UTC at a moment. */
function offsetMinutes(at: Date, zone: string): number {
  const p = parts(at, zone);
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute));
  return Math.round((local - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000);
}

/** "08:32" or "8:32 AM"; Auto (null) reads as 24-hour, the way most of the world does. */
export function clockText(at: Date, zone: string, format: '12h' | '24h' | null): string {
  try {
    return format === '12h'
      ? new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', hourCycle: 'h12' }).format(at)
      : new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  } catch {
    return '—';
  }
}

/** "6 h behind", "5 h 30 ahead", "Same time", with "tomorrow" or "yesterday" when the day differs. */
export function zoneOffsetText(at: Date, zone: string, home: string): string {
  let diff: number;
  try {
    diff = offsetMinutes(at, zone) - offsetMinutes(at, home);
  } catch {
    return '';
  }
  const day = parts(at, zone).day !== parts(at, home).day ? (diff > 0 ? ', tomorrow' : ', yesterday') : '';
  if (diff === 0) return 'Same time';
  const h = Math.floor(Math.abs(diff) / 60);
  const m = Math.abs(diff) % 60;
  const span = m === 0 ? `${h} h` : h === 0 ? `${m} min` : `${h} h ${m}`;
  return `${span} ${diff > 0 ? 'ahead' : 'behind'}${day}`;
}

const town = (p: WidgetPlace | OwnerPlace): string => p.name.split(',')[0]?.trim() || p.label;

/** "Lisbon" from "Europe/Lisbon", "New York" from "America/New_York". */
export function zoneCity(zone: string): string {
  return (zone.split('/').pop() ?? zone).replace(/_/g, ' ');
}

/**
 * The Analog style: the owner's own zone first — named by their place there,
 * Home before the others, or by the zone's city — then the places, as many as
 * the size draws. Zones and labels only; the page ticks the faces.
 */
function produceFaces(
  places: Array<WidgetPlace | OwnerPlace>,
  size: WidgetSize,
  format: '12h' | '24h' | null,
  opts: { timezone: string; places: readonly OwnerPlace[] },
): WidgetClocks {
  const here = opts.places.filter((p) => p.timezone === opts.timezone).sort((a, b) => Number(b.id === 'home') - Number(a.id === 'home'))[0];
  const own = { label: here ? town(here) : zoneCity(opts.timezone), zone: opts.timezone };
  const others = places
    .map((p) => ({ label: p.label, zone: p.timezone! }))
    .filter((c) => !(c.zone === own.zone && c.label === own.label))
    .slice(0, (size === 'medium' ? WIDGET_CLOCKS_MAX : 2) - 1);
  return { kind: 'clocks', home: opts.timezone, clocks: [own, ...others], ...(format ? { time: format } : {}) };
}

/**
 * The body for now: one place as a figure, several as rows. With none picked,
 * the owner's places in another zone; with none of those, where to start.
 */
export function produceClock(
  settings: WidgetSettings,
  size: WidgetSize,
  opts: { now: Date; timezone: string; places: readonly OwnerPlace[] },
): WidgetBody {
  const picked = Array.isArray(settings.places) ? (settings.places as WidgetPlace[]) : [];
  const format = settings.time === '12h' || settings.time === '24h' ? settings.time : null;
  const away = opts.places.filter((p) => p.timezone && p.timezone !== opts.timezone);
  const places = (picked.length > 0 ? picked : away).filter((p) => p.timezone).slice(0, 3);
  if (settings.style === 'analog') return produceFaces(places, size, format, opts);
  if (places.length === 0) {
    return {
      kind: 'text',
      icon: 'clock',
      text: picked.length > 0 ? 'None of these places has a timezone yet.' : 'Pick a town in its settings, or add a place in another zone on Settings → Profile.',
    };
  }
  const rows = places.map((p) => ({
    title: p.label,
    town: town(p),
    time: clockText(opts.now, p.timezone!, format),
    offset: zoneOffsetText(opts.now, p.timezone!, opts.timezone),
  }));
  if (rows.length === 1) {
    const r = rows[0]!;
    return { kind: 'stat', icon: 'clock', value: r.time, caption: r.title === r.town ? r.town : `${r.title} · ${r.town}`, ...(r.offset ? { foot: r.offset } : {}) };
  }
  return {
    kind: 'list',
    rows: rows.map((r) => ({
      title: r.title,
      ...(size === 'medium' ? { sub: [r.title === r.town ? undefined : r.town, r.offset].filter(Boolean).join(' · ') } : {}),
      side: r.time,
    })),
  };
}
