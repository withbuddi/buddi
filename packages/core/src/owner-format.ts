/**
 * Times and dates in the owner's Profile formats, for sentences the server
 * writes (a failure's reset time, a CLI line). The dashboard's `format.ts`
 * is the reference; this is its server twin, without a browser locale: Auto
 * reads as 24-hour and "Fri 2 Oct", the way most of the world writes them.
 */
import { clockText } from './clock-widget.js';

export interface OwnerFormats {
  /** `12h`, `24h`, or null (Auto). */
  timeFormat?: string | null | undefined;
  /** `short`, `long`, `iso`, or null (Auto). */
  dateFormat?: string | null | undefined;
}

function zoneOrUtc(zone: string): string {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return zone; } catch { return 'UTC'; }
}

/** "14:05" or "2:05 PM" in the zone. */
export function ownerClock(at: Date, zone: string, formats: OwnerFormats = {}): string {
  return clockText(at, zoneOrUtc(zone), formats.timeFormat === '12h' ? '12h' : formats.timeFormat === '24h' ? '24h' : null);
}

/**
 * The day with its weekday: "Fri, Oct 2" (short), "Friday, 2 October" (long),
 * "Fri 2026-10-02" (iso), "Fri 2 Oct" (Auto).
 */
export function ownerDate(at: Date, zone: string, formats: OwnerFormats = {}): string {
  const tz = zoneOrUtc(zone);
  const parts = (locale: string, options: Intl.DateTimeFormatOptions): Record<string, string> =>
    Object.fromEntries(new Intl.DateTimeFormat(locale, { timeZone: tz, ...options }).formatToParts(at).map((p) => [p.type, p.value]));
  switch (formats.dateFormat) {
    case 'iso': {
      const p = parts('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' });
      return `${p.weekday} ${p.year}-${p.month}-${p.day}`;
    }
    case 'short': {
      const p = parts('en-US', { month: 'short', day: 'numeric', weekday: 'short' });
      return `${p.weekday}, ${p.month} ${p.day}`;
    }
    case 'long': {
      const p = parts('en-GB', { month: 'long', day: 'numeric', weekday: 'long' });
      return `${p.weekday}, ${p.day} ${p.month}`;
    }
    default: {
      const p = parts('en-GB', { month: 'short', day: 'numeric', weekday: 'short' });
      return `${p.weekday} ${p.day} ${p.month}`.replace(/\bSept\b/g, 'Sep');
    }
  }
}
