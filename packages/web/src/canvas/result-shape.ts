/**
 * What a tool result *is*, read from its shape — the registry the generic
 * tool-result card picks its view from.
 *
 * Keyed by shape, never by tool: a profile is an object that names someone,
 * a list of items is rows that each carry a name, settings are a flat object
 * of switches and short values. Whatever matches none of them is drawn as a
 * definition grid of its fields (`fields`), and what is not an object at all
 * goes back to the structured fallback (`other`).
 *
 * The first entry whose `matches` says yes wins, so the order is the
 * precedence. Adding a purpose-built view means a line here and a component
 * in `views/ToolResult.tsx`.
 */
import { isBlank } from './infer';
import { humanise } from './resolve';

export type ResultViewName = 'profile' | 'items' | 'settings' | 'fields' | 'other';

type Json = Record<string, unknown>;

export function isPlainObject(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Keys that name the thing a record is about, best first. */
const IDENTITY_KEYS = ['preferredName', 'displayName', 'fullName', 'name', 'title', 'label', 'subject', 'username', 'email'];
const ROW_NAME = /^(name|title|label|subject|displayName|display_name|heading)$/i;
const URL_KEY = /^(url|link|href|uri|permalink)$/i;
const ID_KEY = /^(id|uuid|_id)$|(Id|_id)$/;

function isScalar(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

/** The key that names this record, when one does. */
export function identityKey(record: Json): string | null {
  return IDENTITY_KEYS.find((key) => typeof record[key] === 'string' && (record[key] as string).trim() !== '') ?? null;
}

/** The rows a list-of-items result is about, and the short facts said with them. */
export interface ItemsShape {
  label: string | null;
  rows: Json[];
  name: string;
  facts: string[];
  /** Scalars sitting beside the rows (`total: 12`), said once above them. */
  extras: Array<[string, unknown]>;
}

/** The longest row a "name + 1–2 facts" line can stand for without dropping what matters. */
const ITEM_MAX_KEYS = 6;

/**
 * `[{ name, ... }]`, or one object holding such an array beside a few
 * scalars (`{ agents: [...], total: 3 }`). Rows that are links stay with
 * the structured view, which draws them as records with their host.
 */
export function itemsShape(value: unknown): ItemsShape | null {
  let rows: unknown = value;
  let label: string | null = null;
  let extras: Array<[string, unknown]> = [];
  if (isPlainObject(value)) {
    const arrays = Object.entries(value).filter(([, child]) => Array.isArray(child));
    const rest = Object.entries(value).filter(([, child]) => !Array.isArray(child));
    if (arrays.length !== 1 || !rest.every(([, child]) => isScalar(child))) return null;
    [label, rows] = [humanise(arrays[0]![0]), arrays[0]![1]];
    extras = rest.filter(([, child]) => !isBlank(child));
  }
  if (!Array.isArray(rows) || rows.length === 0 || !rows.every(isPlainObject)) return null;
  const records = rows as Json[];
  const keys = [...new Set(records.flatMap((row) => Object.keys(row)))];
  if (keys.length > ITEM_MAX_KEYS) return null;
  if (keys.some((key) => URL_KEY.test(key))) return null;
  const name = keys.find((key) => ROW_NAME.test(key) && records.filter((row) => typeof row[key] === 'string').length >= records.length * 0.8);
  if (!name) return null;
  const facts = keys
    .filter((key) => key !== name && !ID_KEY.test(key))
    .filter((key) => records.some((row) => isScalar(row[key]) && !isBlank(row[key])))
    .sort((a, b) => present(records, b) - present(records, a))
    .slice(0, 2);
  return { label, rows: records, name, facts, extras };
}

function present(rows: Json[], key: string): number {
  return rows.filter((row) => !isBlank(row[key])).length;
}

/** A person or a thing that names itself: one object with an identity and a few facts. */
export function isProfile(value: unknown): value is Json {
  return isPlainObject(value) && identityKey(value) !== null && Object.keys(value).length >= 3;
}

/** Short enough to be a setting's value rather than a paragraph. */
const SETTING_CHARS = 60;

/** A flat object of switches and short values: nothing nested, nothing long. */
export function isSettings(value: unknown): value is Json {
  if (!isPlainObject(value)) return false;
  const values = Object.values(value);
  return values.length >= 2 && values.every((child) =>
    isScalar(child) && (typeof child !== 'string' || child.length <= SETTING_CHARS));
}

/** The registry: first match wins. */
export const RESULT_VIEWS: ReadonlyArray<{ name: ResultViewName; matches: (value: unknown) => boolean }> = [
  { name: 'items', matches: (value) => itemsShape(value) !== null },
  { name: 'profile', matches: isProfile },
  { name: 'settings', matches: isSettings },
  { name: 'fields', matches: (value) => isPlainObject(value) && Object.keys(value).length > 0 },
];

/** Which view draws this result. */
export function resultViewFor(value: unknown): ResultViewName {
  return RESULT_VIEWS.find((view) => view.matches(value))?.name ?? 'other';
}

/* ------------------------------------------------------------------ *
 * One field's value, read for how it should look.
 * ------------------------------------------------------------------ */

export type FieldKind =
  | { kind: 'empty' }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'number'; value: number }
  | { kind: 'day'; value: string }
  | { kind: 'moment'; value: string }
  | { kind: 'link'; value: string }
  | { kind: 'enum'; value: string }
  | { kind: 'text'; value: string }
  | { kind: 'chips'; values: string[] }
  | { kind: 'rows'; values: unknown[] }
  | { kind: 'group'; value: Json };

/** At most this many strings, each at most this long, read as chips. */
export const CHIP_COUNT = 8;
export const CHIP_CHARS = 32;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MOMENT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
/**
 * One lower-case word, or words joined by `_`/`-`: a state, not a sentence.
 * No digits: `claude-sonnet-5` or `v2` is a name, not a state.
 */
const ENUM = /^[a-z]+([_-][a-z]+)*$/;
/** Keys whose value is a name a person chose, never a state. */
const FREE_TEXT_KEY = /(name|title|label|email|subject|text|note|message|description|summary|path|file)$/i;

export function fieldKind(key: string, value: unknown): FieldKind {
  if (isBlank(value)) return { kind: 'empty' };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (typeof value === 'number') return { kind: 'number', value };
  if (typeof value === 'string') {
    const text = value.trim();
    if (DAY.test(text)) return { kind: 'day', value: text };
    if (MOMENT.test(text) && !Number.isNaN(Date.parse(text))) return { kind: 'moment', value: text };
    if (/^https?:\/\/\S+$/i.test(text)) return { kind: 'link', value: text };
    if (text.length <= 24 && ENUM.test(text) && !FREE_TEXT_KEY.test(key)) return { kind: 'enum', value: text };
    return { kind: 'text', value };
  }
  if (Array.isArray(value)) {
    if (value.length <= CHIP_COUNT && value.every((item) => typeof item === 'string' && item.length <= CHIP_CHARS)) {
      return { kind: 'chips', values: value as string[] };
    }
    return { kind: 'rows', values: value };
  }
  if (isPlainObject(value)) return { kind: 'group', value };
  return { kind: 'text', value: String(value) };
}
