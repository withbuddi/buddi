/** The World clock: the time at places in other zones, in the placement's format, never cached. */
import { describe, expect, it } from 'vitest';
import { CLOCK_WIDGET, clockText, produceClock, zoneCity, zoneOffsetText } from './clock-widget.js';
import { parseWidgetSettings } from './widget-settings.js';
import type { OwnerPlace } from './places.js';

const NOW = new Date('2026-10-01T12:32:00Z');
const places: OwnerPlace[] = [
  { id: 'home', label: 'Home', address: null, name: 'Lyon, France', latitude: 45.76, longitude: 4.84, timezone: 'Europe/Paris' },
  { id: 'ben', label: 'Ben', address: null, name: 'Brooklyn, New York, United States', latitude: 40.65, longitude: -73.95, timezone: 'America/New_York' },
];
const tokyo = { id: null, label: 'Tokyo', name: 'Tokyo, Japan', latitude: 35.68, longitude: 139.69, timezone: 'Asia/Tokyo' };

describe('the World clock', () => {
  it('writes the time 12- or 24-hour, Auto as 24-hour', () => {
    expect(clockText(NOW, 'America/New_York', '12h')).toBe('8:32 AM');
    expect(clockText(NOW, 'America/New_York', '24h')).toBe('08:32');
    expect(clockText(NOW, 'America/New_York', null)).toBe('08:32');
  });

  it('says how far ahead or behind, and the other day', () => {
    expect(zoneOffsetText(NOW, 'America/New_York', 'Europe/Paris')).toBe('6 h behind');
    expect(zoneOffsetText(NOW, 'Asia/Kolkata', 'Europe/Paris')).toBe('3 h 30 ahead');
    expect(zoneOffsetText(NOW, 'Europe/Berlin', 'Europe/Paris')).toBe('Same time');
    expect(zoneOffsetText(new Date('2026-10-01T20:30:00Z'), 'Asia/Tokyo', 'Europe/Paris')).toBe('7 h ahead, tomorrow');
  });

  it('with nothing picked, shows the owner’s places in another zone as a figure', () => {
    expect(produceClock({ places: [], time: null }, 'small', { now: NOW, timezone: 'Europe/Paris', places })).toEqual({
      kind: 'stat', icon: 'clock', value: '08:32', caption: 'Ben · Brooklyn', foot: '6 h behind',
    });
  });

  it('shows several picked places as rows, the places in the medium size', () => {
    const settings = { places: [{ ...places[1]!, id: 'ben' }, tokyo], time: '12h' as const };
    expect(produceClock(settings, 'medium', { now: NOW, timezone: 'Europe/Paris', places })).toEqual({
      kind: 'list',
      rows: [
        { title: 'Ben', sub: 'Brooklyn · 6 h behind', side: '8:32 AM' },
        { title: 'Tokyo', sub: '7 h ahead', side: '9:32 PM' },
      ],
    });
    expect(produceClock(settings, 'small', { now: NOW, timezone: 'Europe/Paris', places }).kind).toBe('list');
  });

  it('says where to start when there is no other zone', () => {
    expect(produceClock({ places: [], time: null }, 'small', { now: NOW, timezone: 'Europe/Paris', places: [places[0]!] })).toMatchObject({ kind: 'text', icon: 'clock' });
  });
  it('in the Analog style answers zones and labels, the owner’s own zone first, as many as the size draws', () => {
    const settings = { style: 'analog', places: [{ ...places[1]!, id: 'ben' }, tokyo, { ...tokyo, label: 'Mumbai', timezone: 'Asia/Kolkata' }], time: '12h' as const };
    expect(produceClock(settings, 'medium', { now: NOW, timezone: 'Europe/Paris', places })).toEqual({
      kind: 'clocks', home: 'Europe/Paris', time: '12h',
      clocks: [{ label: 'Lyon', zone: 'Europe/Paris' }, { label: 'Ben', zone: 'America/New_York' }, { label: 'Tokyo', zone: 'Asia/Tokyo' }, { label: 'Mumbai', zone: 'Asia/Kolkata' }],
    });
    expect(produceClock(settings, 'small', { now: NOW, timezone: 'Europe/Paris', places })).toMatchObject({
      clocks: [{ label: 'Lyon' }, { label: 'Ben' }],
    });
  });

  it('in the Analog style with no place there or elsewhere, names the owner’s face by the zone’s city', () => {
    expect(produceClock({ style: 'analog', places: [], time: null }, 'medium', { now: NOW, timezone: 'America/New_York', places: [] })).toEqual({
      kind: 'clocks', home: 'America/New_York', clocks: [{ label: 'New York', zone: 'America/New_York' }],
    });
    expect(zoneCity('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
  });

  it('declares a Style that starts Digital and checks', () => {
    expect(() => parseWidgetSettings('buddi', CLOCK_WIDGET.id, CLOCK_WIDGET.settings)).not.toThrow();
    expect(CLOCK_WIDGET.settings[0]).toMatchObject({ key: 'style', kind: 'select', default: 'digital' });
  });
});
