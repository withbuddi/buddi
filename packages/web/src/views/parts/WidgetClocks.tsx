/**
 * The `clocks` body: analog faces side by side, the World clock's Analog
 * style. The gateway sends zones and labels only; each face's time is read
 * here from the device's clock, so the faces tick without a new answer.
 *
 * A face is light while it is day there and dark at night, whatever the
 * theme: from sunrise to sunset at the face's place when the body says where
 * it is (`sun.ts`), else from 6:00 to 18:00 in its zone. Under it: the place, the day against the owner's
 * (Today / Tomorrow / Yesterday) and the offset ("+6 h", "−1 h 30"); a first
 * face in the owner's zone reads "Here". Reduced motion drops the second hand
 * and moves the minute hand once a minute.
 */
import { useEffect, useState } from 'react';
import type { WidgetBody, WidgetSize } from '../../api';
import { fmtClock, underFormats } from '../../format';
import { sunIsUp } from '../../sun';
import { useMediaQuery } from '../../useMediaQuery';

type ClocksBody = Extract<WidgetBody, { kind: 'clocks' }>;

/** Faces drawn by size. */
const FACES: Record<WidgetSize, number> = { small: 2, medium: 4 };

interface ZoneTime {
  /** "2026-10-01" there. */
  date: string;
  h: number;
  m: number;
  s: number;
  /** Minutes ahead of UTC there, now. */
  offset: number;
}

const readers = new Map<string, Intl.DateTimeFormat>();
function reader(zone: string): Intl.DateTimeFormat {
  let found = readers.get(zone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    readers.set(zone, found);
  }
  return found;
}

/** The wall clock in a zone at a moment. */
export function zoneTime(at: Date, zone: string): ZoneTime {
  const p = Object.fromEntries(reader(zone).formatToParts(at).map((x) => [x.type, x.value]));
  const h = Number(p.hour) % 24;
  const m = Number(p.minute);
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), h, m);
  return { date: `${p.year}-${p.month}-${p.day}`, h, m, s: Number(p.second), offset: Math.round((local - Math.floor(at.getTime() / 60_000) * 60_000) / 60_000) };
}

/** "+6 h", "−1 h 30", "+30 min", "Same time": the owner's way of writing an offset. */
export function offsetLabel(diff: number): string {
  if (diff === 0) return 'Same time';
  const h = Math.floor(Math.abs(diff) / 60);
  const m = Math.abs(diff) % 60;
  return `${diff > 0 ? '+' : '−'}${h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m}`}`;
}

/** The same, for a screen reader: "6 hours ahead", "1 hour 30 minutes behind". */
export function offsetWords(diff: number): string {
  if (diff === 0) return 'same time';
  const h = Math.floor(Math.abs(diff) / 60);
  const m = Math.abs(diff) % 60;
  const span = [h ? `${h} hour${h === 1 ? '' : 's'}` : '', m ? `${m} minute${m === 1 ? '' : 's'}` : ''].filter(Boolean).join(' ');
  return `${span} ${diff > 0 ? 'ahead' : 'behind'}`;
}

export interface FaceFacts extends ZoneTime {
  day: 'Today' | 'Tomorrow' | 'Yesterday';
  /** The sun is up there; 6:00 to 18:00 in its zone when the face has no place. */
  daytime: boolean;
  /** Under the face: "Here", "+6 h". */
  offsetText: string;
  /** "8:05 PM" or "20:05", the placement's way. */
  time: string;
  /** "Paris, 8:05 PM, 6 hours ahead". */
  label: string;
}

/** One face's facts against the owner's zone. `own` is the owner's own face. */
export function faceFacts(at: Date, face: { label: string; zone: string; latitude?: number; longitude?: number }, home: string, own: boolean, format?: '12h' | '24h'): FaceFacts {
  const there = zoneTime(at, face.zone);
  const mine = zoneTime(at, home);
  const day = there.date === mine.date ? 'Today' : there.date > mine.date ? 'Tomorrow' : 'Yesterday';
  const diff = there.offset - mine.offset;
  const time = underFormats(format ? { timeFormat: format } : {}, () => fmtClock(at, face.zone));
  const relative = own ? 'your time' : offsetWords(diff);
  return {
    ...there,
    day,
    daytime:
      typeof face.latitude === 'number' && typeof face.longitude === 'number'
        ? sunIsUp(at, face.latitude, face.longitude)
        : there.h >= 6 && there.h < 18,
    offsetText: own ? 'Here' : offsetLabel(diff),
    time,
    label: `${face.label}, ${time}${day === 'Today' ? '' : ` ${day.toLowerCase()}`}, ${relative}`,
  };
}

/** The hands' angles in degrees from 12, the second hand's only when it is drawn. */
export function handAngles(t: Pick<ZoneTime, 'h' | 'm' | 's'>, seconds: boolean): { hour: number; minute: number; second: number | null } {
  const s = seconds ? t.s : 0;
  return { hour: ((t.h % 12) + t.m / 60 + s / 3600) * 30, minute: (t.m + s / 60) * 6, second: seconds ? t.s * 6 : null };
}

/** Now, on every second, or on every minute when `seconds` is off. */
function useNow(seconds: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const step = seconds ? 1000 : 60_000;
    let timer: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      timer = setTimeout(() => { setNow(new Date()); arm(); }, step - (Date.now() % step) + 5);
    };
    setNow(new Date());
    arm();
    return () => clearTimeout(timer);
  }, [seconds]);
  return now;
}

/** A hand: a thin stem off the pin, then the blade, both round. */
function Hand({ angle, length, width }: { angle: number; length: number; width: number }): JSX.Element {
  return (
    <g className="wg-clock-hand" transform={`rotate(${angle} 50 50)`}>
      <line x1="50" y1="50" x2="50" y2="42" strokeWidth={Math.min(width, 1.8)} />
      <line x1="50" y1="42" x2="50" y2={50 - length} strokeWidth={width} />
    </g>
  );
}

const TICKS = Array.from({ length: 12 }, (_, i) => i);

export function ClockDial({ time, seconds }: { time: Pick<ZoneTime, 'h' | 'm' | 's'>; seconds: boolean }): JSX.Element {
  const a = handAngles(time, seconds);
  return (
    <svg className="wg-clock-face" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
      <circle className="wg-clock-dial" cx="50" cy="50" r="49.25" />
      {TICKS.map((i) => (
        <line key={i} className="wg-clock-tick" data-major={i % 3 === 0 ? 'true' : undefined} x1="50" y1={i % 3 === 0 ? 6.5 : 7.5} x2="50" y2={i % 3 === 0 ? 14 : 12} transform={`rotate(${i * 30} 50 50)`} />
      ))}
      <Hand angle={a.hour} length={24} width={4.6} />
      <Hand angle={a.minute} length={37} width={3.4} />
      {a.second === null ? null : (
        <g className="wg-clock-second" data-testid="second-hand" transform={`rotate(${a.second} 50 50)`}>
          <line x1="50" y1="59" x2="50" y2="9" />
        </g>
      )}
      <circle className="wg-clock-pin" cx="50" cy="50" r="2.8" />
      {a.second === null ? null : <circle className="wg-clock-pin-second" cx="50" cy="50" r="1.5" />}
    </svg>
  );
}

export function ClocksView({ body, size }: { body: ClocksBody; size: WidgetSize }): JSX.Element {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const now = useNow(!reduced);
  const faces = body.clocks.slice(0, FACES[size]);
  return (
    <div className="wg-clocks" data-count={faces.length}>
      {faces.map((face, i) => {
        let f: FaceFacts;
        try {
          f = faceFacts(now, face, body.home, i === 0 && face.zone === body.home, body.time);
        } catch {
          return null; // a zone this browser does not know: the face is left out, never a broken widget
        }
        return (
          <div key={`${face.label}-${face.zone}`} className="wg-clock" data-night={f.daytime ? undefined : 'true'} role="img" aria-label={f.label} title={`${face.label} · ${f.time}`}>
            <ClockDial time={f} seconds={!reduced} />
            <span className="wg-clock-words" aria-hidden="true">
              <span className="wg-clock-city">{face.label}</span>
              <span className="wg-clock-day" data-today={f.day === 'Today' ? 'true' : undefined}>{f.day}</span>
              <span className="wg-clock-off">{f.offsetText}</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
