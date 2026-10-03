/**
 * A widget's settings (host API 1.19): the small schema a definition may
 * declare, what the owner chose for one placement, and those choices made
 * concrete for `produce`.
 *
 * The page draws the fields from a fixed vocabulary and knows no plugin:
 *
 *  - `select`      one of a few named values; `options` fixed, or read when the
 *                  sheet opens (the owner's calendars, mailboxes, places)
 *  - `multiselect` some of them; none chosen means all
 *  - `toggle`      on or off
 *  - `text`        a short line
 *  - `place`       one of the owner's places (Settings → Profile) or a town found
 *                  by name; `multiple` takes up to three
 *  - `timeFormat`  the owner's Profile, 12-hour or 24-hour
 *
 * Every placement owns its settings: the same widget twice on Home, or on Home
 * and the lock screen, are set apart. What is stored is what the owner chose
 * (a place by id, so a renamed or moved place follows); `produce` is handed it
 * resolved — defaults filled, a place with its coordinates and zone, the time
 * format with the Profile applied.
 */
import type { OwnerPlace } from './places.js';
import type { ToolContext } from './tools.js';

export const WIDGET_SETTING_KINDS = ['select', 'multiselect', 'toggle', 'text', 'place', 'timeFormat'] as const;
export type WidgetSettingKind = (typeof WIDGET_SETTING_KINDS)[number];

/** At most this many fields, options, characters and places. */
export const WIDGET_SETTINGS_MAX = 8;
export const WIDGET_OPTIONS_MAX = 24;
export const WIDGET_SETTING_LABEL_MAX = 40;
export const WIDGET_SETTING_HINT_MAX = 160;
export const WIDGET_SETTING_TEXT_MAX = 120;
export const WIDGET_SETTING_TEXT_DEFAULT_MAX = 60;
export const WIDGET_PLACES_MAX = 3;

export interface WidgetSettingOption {
  value: string;
  label: string;
}

/** Fixed, or read when the settings open (read-only, like `produce`). */
export type WidgetSettingOptions = WidgetSettingOption[] | ((ctx: ToolContext) => Promise<WidgetSettingOption[]>);

interface FieldBase {
  /** What `settings[key]` is called: lowercase first, letters, digits, `_`. */
  key: string;
  label: string;
  hint?: string;
  /**
   * Name the placement by this field's choice when it is not the default:
   * "Weather · Work". `select` and `place`; since host API 1.27 a
   * `multiselect` too, by every option ticked: "Top stories · AI, US politics".
   */
  inTitle?: boolean;
}

export interface WidgetSelectField extends FieldBase {
  kind: 'select';
  options: WidgetSettingOptions;
  /** One of the options' values; the first option when left out. */
  default?: string;
}
export interface WidgetMultiselectField extends FieldBase {
  kind: 'multiselect';
  options: WidgetSettingOptions;
  default?: string[];
}
export interface WidgetToggleField extends FieldBase {
  kind: 'toggle';
  default?: boolean;
}
export interface WidgetTextField extends FieldBase {
  kind: 'text';
  placeholder?: string;
  /** Characters, at most 120; 60 when left out. */
  max?: number;
  default?: string;
}
export interface WidgetPlaceField extends FieldBase {
  kind: 'place';
  /** Up to three places instead of one. */
  multiple?: boolean;
}
export interface WidgetTimeFormatField extends FieldBase {
  kind: 'timeFormat';
}

export type WidgetSettingField =
  | WidgetSelectField
  | WidgetMultiselectField
  | WidgetToggleField
  | WidgetTextField
  | WidgetPlaceField
  | WidgetTimeFormatField;

/** A place as `produce` is handed it: the owner's (with its id) or a town found by name. */
export interface WidgetPlace {
  /** The owner's place id (`home`, `work`), or null for a town found by name. */
  id: string | null;
  label: string;
  /** What the geocoder matched: "Lyon, Auvergne-Rhône-Alpes, France". */
  name: string;
  latitude: number;
  longitude: number;
  timezone: string | null;
}

/**
 * What a place field keeps: the owner's place by id, or a town found by name
 * in full (it is no place of theirs to look up later).
 */
export type StoredWidgetPlace = { place: string } | { label: string; name: string; latitude: number; longitude: number; timezone: string | null };

/** One placement's choices, as kept: only what the owner set. */
export type StoredWidgetSettings = Record<string, unknown>;

/**
 * The choices made concrete, by key: a select's value (the default when unset),
 * a multiselect's values (empty: all), a toggle's boolean, a text's line, a
 * place (`WidgetPlace`, or null when the owner has none and chose none) or up
 * to three, and `'12h'`, `'24h'` or null (Auto: the reader's taste) for a time
 * format with the Profile applied.
 */
export type WidgetSettings = Record<string, string | string[] | boolean | WidgetPlace | WidgetPlace[] | null>;

const KEY = /^[a-z][a-zA-Z0-9_]{0,31}$/;

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t === '' || t.length > max ? undefined : t;
}

function staticOptions(plugin: string, where: string, raw: unknown): WidgetSettingOption[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > WIDGET_OPTIONS_MAX) {
    throw new Error(`plugin ${plugin}: ${where} needs 1 to ${WIDGET_OPTIONS_MAX} options, or a function that reads them`);
  }
  const seen = new Set<string>();
  return raw.map((o, i) => {
    const option = o as { value?: unknown; label?: unknown } | null;
    const value = typeof option?.value === 'string' && option.value.length <= 80 ? option.value : undefined;
    const label = text(option?.label, WIDGET_SETTING_LABEL_MAX);
    if (value === undefined || label === undefined) throw new Error(`plugin ${plugin}: ${where} option ${i} needs a value and a label of 1 to ${WIDGET_SETTING_LABEL_MAX} characters`);
    if (seen.has(value)) throw new Error(`plugin ${plugin}: ${where} offers ${JSON.stringify(value)} twice`);
    seen.add(value);
    return { value, label };
  });
}

/**
 * Check a definition's settings at register, the way the rest of a widget is
 * checked: a bad field is a startup error naming the plugin. Returns them as
 * declared, with fixed options checked.
 */
export function parseWidgetSettings(plugin: string, widget: string, raw: unknown): WidgetSettingField[] | undefined {
  if (raw === undefined) return undefined;
  const fail = (message: string): never => {
    throw new Error(`plugin ${plugin}: widget ${widget} ${message}`);
  };
  if (!Array.isArray(raw)) fail('settings must be an array');
  const list = raw as unknown[];
  if (list.length === 0) return undefined;
  if (list.length > WIDGET_SETTINGS_MAX) fail(`declares more than ${WIDGET_SETTINGS_MAX} settings`);
  const keys = new Set<string>();
  return list.map((r, i) => {
    const f = (r ?? {}) as Record<string, unknown>;
    const key = typeof f.key === 'string' ? f.key : '';
    if (!KEY.test(key)) fail(`settings[${i}] needs a key: a lowercase letter, then letters, digits or _`);
    if (keys.has(key)) fail(`declares the setting ${key} twice`);
    keys.add(key);
    const where = `widget ${widget} setting ${key}`;
    const label = text(f.label, WIDGET_SETTING_LABEL_MAX) ?? fail(`setting ${key} needs a label of 1 to ${WIDGET_SETTING_LABEL_MAX} characters`);
    if (f.hint !== undefined && text(f.hint, WIDGET_SETTING_HINT_MAX) === undefined) fail(`setting ${key}: hint is 1 to ${WIDGET_SETTING_HINT_MAX} characters`);
    if (!(WIDGET_SETTING_KINDS as readonly unknown[]).includes(f.kind)) fail(`setting ${key}: kind is one of ${WIDGET_SETTING_KINDS.join(', ')}`);
    const kind = f.kind as WidgetSettingKind;
    if (f.inTitle !== undefined && (typeof f.inTitle !== 'boolean' || (f.inTitle && kind !== 'select' && kind !== 'place' && kind !== 'multiselect'))) {
      fail(`setting ${key}: inTitle is true or false, on a select, a multiselect or a place`);
    }
    const base = { key, label, ...(f.hint !== undefined ? { hint: String(f.hint).trim() } : {}), ...(f.inTitle === true ? { inTitle: true } : {}) };
    switch (kind) {
      case 'select': {
        const options = typeof f.options === 'function' ? (f.options as WidgetSelectField['options']) : staticOptions(plugin, where, f.options);
        if (f.default !== undefined) {
          if (typeof f.default !== 'string') fail(`setting ${key}: default is one of its values`);
          if (Array.isArray(options) && !options.some((o) => o.value === f.default)) fail(`setting ${key}: default ${JSON.stringify(f.default)} is not one of its values`);
        }
        return { ...base, kind, options, ...(f.default !== undefined ? { default: f.default as string } : {}) };
      }
      case 'multiselect': {
        const options = typeof f.options === 'function' ? (f.options as WidgetMultiselectField['options']) : staticOptions(plugin, where, f.options);
        if (f.default !== undefined) {
          const d = f.default;
          if (!Array.isArray(d) || !d.every((v) => typeof v === 'string' && (!Array.isArray(options) || options.some((o) => o.value === v)))) {
            fail(`setting ${key}: default is a list of its values`);
          }
        }
        return { ...base, kind, options, ...(f.default !== undefined ? { default: [...(f.default as string[])] } : {}) };
      }
      case 'toggle':
        if (f.default !== undefined && typeof f.default !== 'boolean') fail(`setting ${key}: default is true or false`);
        return { ...base, kind, ...(f.default !== undefined ? { default: f.default as boolean } : {}) };
      case 'text': {
        const max = f.max === undefined ? WIDGET_SETTING_TEXT_DEFAULT_MAX : f.max;
        if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > WIDGET_SETTING_TEXT_MAX) fail(`setting ${key}: max is 1 to ${WIDGET_SETTING_TEXT_MAX}`);
        if (f.default !== undefined && (typeof f.default !== 'string' || f.default.length > (max as number))) fail(`setting ${key}: default is a line of at most ${max} characters`);
        if (f.placeholder !== undefined && text(f.placeholder, WIDGET_SETTING_LABEL_MAX) === undefined) fail(`setting ${key}: placeholder is 1 to ${WIDGET_SETTING_LABEL_MAX} characters`);
        return {
          ...base, kind, max: max as number,
          ...(f.placeholder !== undefined ? { placeholder: String(f.placeholder).trim() } : {}),
          ...(f.default !== undefined ? { default: f.default as string } : {}),
        };
      }
      case 'place':
        if (f.multiple !== undefined && typeof f.multiple !== 'boolean') fail(`setting ${key}: multiple is true or false`);
        if (f.inTitle === true && f.multiple === true) fail(`setting ${key}: a place field with multiple cannot name the placement`);
        return { ...base, kind, ...(f.multiple === true ? { multiple: true } : {}) };
      case 'timeFormat':
        return { ...base, kind };
    }
    return fail(`setting ${key}: unknown kind`);
  });
}

function storedPlace(raw: unknown, places: readonly OwnerPlace[]): StoredWidgetPlace | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const p = raw as Record<string, unknown>;
  if (typeof p.place === 'string') return places.some((q) => q.id === p.place) ? { place: p.place } : undefined;
  const label = text(p.label, WIDGET_SETTING_LABEL_MAX);
  const name = text(p.name, 160);
  const latitude = Number(p.latitude);
  const longitude = Number(p.longitude);
  if (!label || !name || !Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  const timezone = typeof p.timezone === 'string' && p.timezone.length <= 64 && validZone(p.timezone) ? p.timezone : null;
  return { label, name, latitude, longitude, timezone };
}

function validZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The owner's choices for one placement, made sound before they are kept:
 * unknown keys dropped, each value checked against its field (a select or
 * multiselect against `options`, the resolved list when it was read), a
 * choice equal to the default left out. Refuses with a sentence the sheet can
 * show.
 */
export function sanitizeWidgetSettings(
  fields: readonly WidgetSettingField[] | undefined,
  raw: unknown,
  opts: { options?: Record<string, readonly WidgetSettingOption[] | undefined>; places: readonly OwnerPlace[] },
): { ok: true; settings: StoredWidgetSettings } | { ok: false; error: string } {
  const out: StoredWidgetSettings = {};
  if (raw === undefined || raw === null) return { ok: true, settings: out };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: '`settings` is an object' };
  const given = raw as Record<string, unknown>;
  for (const f of fields ?? []) {
    if (!(f.key in given)) continue;
    const value = given[f.key];
    if (value === undefined || value === null) continue;
    const options = f.kind === 'select' || f.kind === 'multiselect' ? (Array.isArray(f.options) ? f.options : opts.options?.[f.key]) : undefined;
    switch (f.kind) {
      case 'select': {
        if (typeof value !== 'string' || value.length > 80) return { ok: false, error: `${f.label}: pick one of its choices` };
        if (options && !options.some((o) => o.value === value)) return { ok: false, error: `${f.label}: ${JSON.stringify(value)} is not one of its choices` };
        const fallback = f.default ?? (Array.isArray(f.options) ? f.options[0]?.value : undefined);
        if (value !== fallback) out[f.key] = value;
        break;
      }
      case 'multiselect': {
        if (!Array.isArray(value) || value.length > WIDGET_OPTIONS_MAX || !value.every((v) => typeof v === 'string' && v.length <= 80)) {
          return { ok: false, error: `${f.label}: a list of its choices` };
        }
        const list = [...new Set(value as string[])];
        if (options) {
          const bad = list.find((v) => !options.some((o) => o.value === v));
          if (bad !== undefined) return { ok: false, error: `${f.label}: ${JSON.stringify(bad)} is not one of its choices` };
        }
        out[f.key] = list;
        break;
      }
      case 'toggle':
        if (typeof value !== 'boolean') return { ok: false, error: `${f.label}: on or off` };
        if (value !== (f.default ?? false)) out[f.key] = value;
        break;
      case 'text': {
        if (typeof value !== 'string') return { ok: false, error: `${f.label}: a line of text` };
        const line = value.trim().replace(/\s+/g, ' ');
        if (line.length > (f.max ?? WIDGET_SETTING_TEXT_DEFAULT_MAX)) return { ok: false, error: `${f.label}: at most ${f.max ?? WIDGET_SETTING_TEXT_DEFAULT_MAX} characters` };
        if (line !== (f.default ?? '')) out[f.key] = line;
        break;
      }
      case 'place': {
        if (f.multiple) {
          if (!Array.isArray(value) || value.length > WIDGET_PLACES_MAX) return { ok: false, error: `${f.label}: up to ${WIDGET_PLACES_MAX} places` };
          const list = value.map((v) => storedPlace(v, opts.places));
          if (list.some((v) => v === undefined)) return { ok: false, error: `${f.label}: a place of yours, or a town found by name` };
          out[f.key] = list;
        } else {
          const place = storedPlace(value, opts.places);
          if (!place) return { ok: false, error: `${f.label}: a place of yours, or a town found by name` };
          out[f.key] = place;
        }
        break;
      }
      case 'timeFormat':
        if (value !== 'profile' && value !== '12h' && value !== '24h') return { ok: false, error: `${f.label}: Profile, 12-hour or 24-hour` };
        if (value !== 'profile') out[f.key] = value;
        break;
    }
  }
  return { ok: true, settings: out };
}

function placeOf(stored: unknown, places: readonly OwnerPlace[]): WidgetPlace | null {
  if (!stored || typeof stored !== 'object') return null;
  const s = stored as Record<string, unknown>;
  if (typeof s.place === 'string') {
    const p = places.find((q) => q.id === s.place);
    return p ? { id: p.id, label: p.label, name: p.name, latitude: p.latitude, longitude: p.longitude, timezone: p.timezone } : null;
  }
  const found = storedPlace(stored, []);
  return found && !('place' in found) ? { id: null, ...found } : null;
}

/**
 * The choices made concrete for `produce`: every field present, defaults
 * filled. A single place left unset is the owner's Home (their first place
 * when none is called Home), or null with no place at all; a place that has
 * since been removed falls back the same way. A time format left on Profile
 * is the owner's (null: Auto).
 */
export function resolveWidgetSettings(
  fields: readonly WidgetSettingField[] | undefined,
  stored: StoredWidgetSettings | undefined,
  owner: { places: readonly OwnerPlace[]; timeFormat: '12h' | '24h' | null },
): WidgetSettings {
  const out: WidgetSettings = {};
  const s = stored ?? {};
  const home = owner.places.find((p) => p.id === 'home' || p.label.toLowerCase() === 'home') ?? owner.places[0];
  for (const f of fields ?? []) {
    const v = s[f.key];
    switch (f.kind) {
      case 'select':
        out[f.key] = typeof v === 'string' ? v : f.default ?? (Array.isArray(f.options) ? f.options[0]?.value ?? '' : '');
        break;
      case 'multiselect':
        out[f.key] = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [...(f.default ?? [])];
        break;
      case 'toggle':
        out[f.key] = typeof v === 'boolean' ? v : f.default ?? false;
        break;
      case 'text':
        out[f.key] = typeof v === 'string' ? v : f.default ?? '';
        break;
      case 'place':
        if (f.multiple) {
          out[f.key] = Array.isArray(v) ? v.map((x) => placeOf(x, owner.places)).filter((p): p is WidgetPlace => p !== null) : [];
        } else {
          out[f.key] = placeOf(v, owner.places) ?? (home ? placeOf({ place: home.id }, owner.places) : null);
        }
        break;
      case 'timeFormat':
        out[f.key] = v === '12h' || v === '24h' ? v : owner.timeFormat;
        break;
    }
  }
  return out;
}

/**
 * A placement's name: the widget's title, then each `inTitle` choice that is
 * not the default — "Weather · Work". `options` are a select's choices when
 * they had to be read.
 */
export function widgetPlacementLabel(
  title: string,
  fields: readonly WidgetSettingField[] | undefined,
  stored: StoredWidgetSettings | undefined,
  opts: { options?: Record<string, readonly WidgetSettingOption[] | undefined>; places: readonly OwnerPlace[] },
): string {
  const parts = [title];
  for (const f of fields ?? []) {
    if (!f.inTitle) continue;
    const v = stored?.[f.key];
    if (v === undefined) continue;
    if (f.kind === 'select') {
      const options = Array.isArray(f.options) ? f.options : opts.options?.[f.key];
      const label = options?.find((o) => o.value === v)?.label;
      if (label && v !== f.default) parts.push(label);
    } else if (f.kind === 'multiselect' && Array.isArray(v) && v.length > 0) {
      const options = Array.isArray(f.options) ? f.options : opts.options?.[f.key];
      const labels = (options ?? []).filter((o) => (v as unknown[]).includes(o.value)).map((o) => o.label);
      if (labels.length > 0) parts.push(labels.join(', '));
    } else if (f.kind === 'place' && !f.multiple) {
      const place = placeOf(v, opts.places);
      if (place) parts.push(place.label);
    }
  }
  return parts.join(' · ');
}
