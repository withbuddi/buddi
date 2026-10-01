/** A widget's settings: the schema checked at register, a placement's choices made sound, resolved for produce, and named. */
import { describe, expect, it } from 'vitest';
import type { OwnerPlace } from './places.js';
import { parseWidgets } from './widgets.js';
import { parseWidgetSettings, resolveWidgetSettings, sanitizeWidgetSettings, widgetPlacementLabel, type WidgetSettingField } from './widget-settings.js';

const places: OwnerPlace[] = [
  { id: 'home', label: 'Home', address: null, name: 'Lyon, France', latitude: 45.76, longitude: 4.84, timezone: 'Europe/Paris' },
  { id: 'work', label: 'Work', address: null, name: 'Grenoble, France', latitude: 45.19, longitude: 5.72, timezone: 'Europe/Paris' },
  { id: 'ben', label: 'Ben', address: null, name: 'Brooklyn, New York, United States', latitude: 40.65, longitude: -73.95, timezone: 'America/New_York' },
];
const parse = (raw: unknown) => parseWidgetSettings('demo', 'demo.now', raw);
const fields: WidgetSettingField[] = parse([
  { key: 'place', kind: 'place', label: 'Place', inTitle: true },
  { key: 'units', kind: 'select', label: 'Units', options: [{ value: 'metric', label: '°C' }, { value: 'imperial', label: '°F' }] },
  { key: 'calendars', kind: 'multiselect', label: 'Calendars', options: async () => [{ value: 'a', label: 'A' }] },
  { key: 'busy', kind: 'toggle', label: 'Only busy' },
  { key: 'note', kind: 'text', label: 'Note', max: 10 },
  { key: 'zones', kind: 'place', multiple: true, label: 'Zones' },
  { key: 'time', kind: 'timeFormat', label: 'Times' },
])!;

describe('parseWidgetSettings', () => {
  it('takes the vocabulary and leaves no settings as none', () => {
    expect(fields.map((f) => f.kind)).toEqual(['place', 'select', 'multiselect', 'toggle', 'text', 'place', 'timeFormat']);
    expect(fields[4]).toMatchObject({ max: 10 });
    expect(typeof (fields[2] as { options: unknown }).options).toBe('function');
    expect(parse(undefined)).toBeUndefined();
    expect(parse([])).toBeUndefined();
  });

  it.each([
    [[{ key: 'Place', kind: 'place', label: 'P' }], /needs a key/],
    [[{ key: 'a', kind: 'place', label: 'P' }, { key: 'a', kind: 'toggle', label: 'T' }], /twice/],
    [[{ key: 'a', kind: 'colour', label: 'P' }], /kind is one of/],
    [[{ key: 'a', kind: 'toggle', label: '' }], /needs a label/],
    [[{ key: 'a', kind: 'select', label: 'S', options: [] }], /needs 1 to 24 options/],
    [[{ key: 'a', kind: 'select', label: 'S', options: [{ value: 'x', label: 'X' }, { value: 'x', label: 'Y' }] }], /offers "x" twice/],
    [[{ key: 'a', kind: 'select', label: 'S', options: [{ value: 'x', label: 'X' }], default: 'y' }], /not one of its values/],
    [[{ key: 'a', kind: 'toggle', label: 'T', inTitle: true }], /inTitle/],
    [[{ key: 'a', kind: 'text', label: 'T', max: 500 }], /max is 1 to 120/],
    [[{ key: 'a', kind: 'place', label: 'P', multiple: true, inTitle: true }], /cannot name the placement/],
    [Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, kind: 'toggle', label: 'T' })), /more than 8/],
  ])('refuses %j', (raw, message) => {
    expect(() => parse(raw)).toThrow(message);
  });

  it('is checked with the rest of a widget at register', () => {
    const produce = async () => null;
    expect(() => parseWidgets('demo', [{ id: 'demo.now', title: 'Now', sizes: ['small'], settings: [{ key: 'x', kind: 'nope', label: 'X' }], produce }], { pages: [], taken: () => false }))
      .toThrow(/plugin demo: widget demo.now setting x: kind is one of/);
    const [w] = parseWidgets('demo', [{ id: 'demo.now', title: 'Now', sizes: ['small'], settings: [{ key: 'x', kind: 'toggle', label: 'X' }], produce }], { pages: [], taken: () => false });
    expect(w!.settings).toEqual([{ key: 'x', kind: 'toggle', label: 'X' }]);
  });
});

describe('sanitizeWidgetSettings', () => {
  const ok = (raw: unknown, options?: Record<string, Array<{ value: string; label: string }>>) => {
    const r = sanitizeWidgetSettings(fields, raw, { places, ...(options ? { options } : {}) });
    if (!r.ok) throw new Error(r.error);
    return r.settings;
  };

  it('keeps only what differs from the defaults, drops unknown keys', () => {
    expect(ok({ units: 'metric', busy: false, note: '  hi  there ', time: 'profile', stray: 1 })).toEqual({ note: 'hi there' });
    expect(ok({ units: 'imperial', busy: true, time: '12h' })).toEqual({ units: 'imperial', busy: true, time: '12h' });
  });

  it('keeps a place of the owner by id and a town found by name in full; up to three', () => {
    expect(ok({ place: { place: 'work' } })).toEqual({ place: { place: 'work' } });
    const tokyo = { label: 'Tokyo', name: 'Tokyo, Japan', latitude: 35.68, longitude: 139.69, timezone: 'Asia/Tokyo' };
    expect(ok({ zones: [{ place: 'ben' }, tokyo] })).toEqual({ zones: [{ place: 'ben' }, tokyo] });
    expect(ok({ zones: [{ ...tokyo, timezone: 'Mars/Olympus' }] })).toEqual({ zones: [{ ...tokyo, timezone: null }] });
  });

  it('checks a read select against the choices it was read with', () => {
    expect(ok({ calendars: ['a'] }, { calendars: [{ value: 'a', label: 'A' }] })).toEqual({ calendars: ['a'] });
    // Choices that could not be read are kept as sent.
    expect(ok({ calendars: ['z'] })).toEqual({ calendars: ['z'] });
  });

  it.each([
    [{ units: 'kelvin' }, /Units: "kelvin" is not one of its choices/],
    [{ busy: 'yes' }, /Only busy: on or off/],
    [{ note: 'x'.repeat(11) }, /at most 10 characters/],
    [{ place: { place: 'mars' } }, /a place of yours/],
    [{ zones: [{ place: 'home' }, { place: 'work' }, { place: 'ben' }, { place: 'home' }] }, /up to 3 places/],
    [{ time: '13h' }, /Profile, 12-hour or 24-hour/],
    [[1], /is an object/],
  ])('refuses %j', (raw, message) => {
    const r = sanitizeWidgetSettings(fields, raw, { places, options: { calendars: [{ value: 'a', label: 'A' }] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(message);
  });

  it('refuses a read choice the plugin no longer offers', () => {
    const r = sanitizeWidgetSettings(fields, { calendars: ['gone'] }, { places, options: { calendars: [{ value: 'a', label: 'A' }] } });
    expect(r).toEqual({ ok: false, error: 'Calendars: "gone" is not one of its choices' });
  });
});

describe('resolveWidgetSettings', () => {
  it('fills every key: Home for an unset place, the Profile for the time format', () => {
    const r = resolveWidgetSettings(fields, {}, { places, timeFormat: '12h' });
    expect(r).toEqual({
      place: { id: 'home', label: 'Home', name: 'Lyon, France', latitude: 45.76, longitude: 4.84, timezone: 'Europe/Paris' },
      units: 'metric',
      calendars: [],
      busy: false,
      note: '',
      zones: [],
      time: '12h',
    });
  });

  it('reads a place by id now, so a moved place follows; a removed one falls back to Home', () => {
    const moved = places.map((p) => (p.id === 'work' ? { ...p, name: 'Paris, France', latitude: 48.85 } : p));
    expect(resolveWidgetSettings(fields, { place: { place: 'work' } }, { places: moved, timeFormat: null }).place).toMatchObject({ id: 'work', name: 'Paris, France', latitude: 48.85 });
    expect(resolveWidgetSettings(fields, { place: { place: 'work' } }, { places: places.filter((p) => p.id !== 'work'), timeFormat: null }).place).toMatchObject({ id: 'home' });
    expect(resolveWidgetSettings(fields, {}, { places: [], timeFormat: null }).place).toBeNull();
  });

  it('keeps a placement time format over the Profile, and Auto as null', () => {
    expect(resolveWidgetSettings(fields, { time: '24h' }, { places, timeFormat: '12h' }).time).toBe('24h');
    expect(resolveWidgetSettings(fields, {}, { places, timeFormat: null }).time).toBeNull();
  });
});

describe('widgetPlacementLabel', () => {
  it('names a placement by its inTitle choices that are not the default', () => {
    expect(widgetPlacementLabel('Weather', fields, {}, { places })).toBe('Weather');
    expect(widgetPlacementLabel('Weather', fields, { place: { place: 'work' } }, { places })).toBe('Weather · Work');
    const select = parse([{ key: 'place', kind: 'select', label: 'Place', inTitle: true, default: '', options: async () => [] }]);
    expect(widgetPlacementLabel('Weather', select, { place: 'profile-work' }, { places, options: { place: [{ value: '', label: 'Home' }, { value: 'profile-work', label: 'Work' }] } })).toBe('Weather · Work');
    expect(widgetPlacementLabel('Weather', select, { place: '' }, { places, options: { place: [{ value: '', label: 'Home' }] } })).toBe('Weather');
  });
});
