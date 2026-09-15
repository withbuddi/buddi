/**
 * Guessing the shape of a tool result nobody described.
 *
 * This is what runs when a plugin has declared no view for a tool — which is
 * most tools, most of the time, and every tool of a plugin somebody wrote this
 * afternoon. A descriptor says "these rows, these columns"; here there is no
 * descriptor, so the shape has to be read out of the data itself.
 *
 * The rules are about *shape*, never about meaning. "An array of objects that
 * mostly agree on their keys is a table" is true of invoices, sensors and
 * chess games alike. "A number whose key sounds like money, in a result that
 * names a currency, is money" is the one inference that leans on words, and it
 * leans on them only to choose a format — getting it wrong prints `1200`
 * instead of `$1,200.00`, never a wrong number.
 *
 * Nothing here knows the name of a tool or a plugin.
 */
import { humanise } from './resolve';

/** How the values in a column are printed. */
export type InferredType = 'text' | 'number' | 'currency' | 'date' | 'boolean';

export interface InferredColumn {
  key: string;
  label: string;
  type: InferredType;
  /** The ISO code money in this column is denominated in, when one was found. */
  currency: string | null;
}

export interface Stat {
  label: string;
  value: unknown;
  type: InferredType;
  currency: string | null;
}

/** A branch of the result that is neither the table nor a headline figure. */
export interface Aside {
  label: string;
  value: unknown;
}

export interface TableShape {
  kind: 'table';
  /** The key the rows came from — `items`, `accounts` — as words. */
  label: string | null;
  columns: InferredColumn[];
  rows: Array<Record<string, unknown>>;
  total: number;
  stats: Stat[];
  notes: string[];
  asides: Aside[];
}

export interface ListShape {
  kind: 'list';
  label: string | null;
  items: unknown[];
  total: number;
  stats: Stat[];
  notes: string[];
  asides: Aside[];
}

export interface RecordShape {
  kind: 'record';
  pairs: Stat[];
  notes: string[];
  asides: Aside[];
}

export interface EmptyShape {
  kind: 'empty';
  note: string;
  stats: Stat[];
}

export interface ErrorShape {
  kind: 'error';
  summary: string;
  detail: unknown;
}

export interface TreeShape {
  kind: 'tree';
  value: unknown;
}

export type Inferred = TableShape | ListShape | RecordShape | EmptyShape | ErrorShape | TreeShape;

/** Rows read when inferring columns and their types. */
const SAMPLE = 50;

/** Columns shown before the rest are left to the raw JSON. */
const MAX_COLUMNS = 9;

/** The union of keys beyond which an "array of objects" is not a table. */
const MAX_UNION = 24;

/** How much of the union an average row must carry for the array to be a table. */
const MIN_CONSISTENCY = 0.6;

/** A string longer than this is prose, not a figure, and reads as a line. */
const PROSE = 48;

/** Keys whose numbers are money, when the result also names a currency. */
const MONEY_KEY =
  /(amount|total|balance|price|cost|paid|pay|payment|net|spend|spent|due|limit|owed|fee|income|charge|burn|minimum|principal|interest|worth|cash|debt|deposit|credit|debit|value|revenue|budget|floor|avg|mean|median)/i;

/** `2026-09-14`, with or without a time after it. */
const DATE_LIKE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}|$)/;

/** An opaque handle: long, unbroken, and different in every row. */
const ID_KEY = /^id$|(^|[a-z0-9])Id$|_id$/;

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A three-letter code, from the row first and the whole result second. */
function currencyIn(...sources: unknown[]): string | null {
  for (const source of sources) {
    if (!isRecord(source)) continue;
    for (const key of ['currency', 'currencyCode']) {
      const value = source[key];
      if (typeof value === 'string' && /^[A-Za-z]{3}$/.test(value)) return value.toUpperCase();
    }
  }
  return null;
}

/**
 * The type of a column, from the values it actually holds. Nulls abstain: a
 * column of dates with one gap in it is still a column of dates.
 */
export function inferType(key: string, values: unknown[], currency: string | null): InferredType {
  const present = values.filter((value) => value !== null && value !== undefined && value !== '');
  if (present.length === 0) return 'text';
  if (present.every((value) => typeof value === 'boolean')) return 'boolean';
  if (present.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    return currency !== null && MONEY_KEY.test(key) ? 'currency' : 'number';
  }
  if (present.every((value) => typeof value === 'string' && DATE_LIKE.test(value))) return 'date';
  return 'text';
}

/**
 * Whether a column is an opaque identifier: named like an id, and different in
 * every row. A column whose every value is unique tells the reader nothing —
 * it exists to be handed back to the tool — and the raw JSON still has it.
 */
function isOpaqueId(key: string, values: unknown[]): boolean {
  if (!ID_KEY.test(key)) return false;
  const present = values.filter((value) => !isBlank(value));
  if (present.length < 2) return false;
  return new Set(present.map((value) => String(value))).size === present.length;
}

/** An empty array or an empty object says as little as a missing value. */
export function isBlank(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

interface Candidate {
  columns: InferredColumn[];
  rows: Array<Record<string, unknown>>;
  /** Columns whose value never varies: a fact about the set, not about a row. */
  constants: Stat[];
}

/**
 * Can this array be drawn as a table? Only if its items are objects that
 * mostly agree about which keys they have — a list of differently-shaped
 * things is a tree, and pretending otherwise produces a grid of dashes.
 */
export function tableCandidate(array: unknown[], root: unknown): Candidate | null {
  const rows = array.filter(isRecord);
  if (rows.length === 0) return null;
  if (rows.length / array.length < 0.8) return null;

  const sample = rows.slice(0, SAMPLE);
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const row of sample) {
    for (const key of Object.keys(row)) {
      if (!counts.has(key)) order.push(key);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  if (counts.size === 0 || counts.size > MAX_UNION) return null;

  const consistency =
    [...counts.values()].reduce((sum, count) => sum + count, 0) / (counts.size * sample.length);
  if (consistency < MIN_CONSISTENCY) return null;

  const ranked = [...counts.keys()].sort((a, b) => {
    const byCount = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
    return byCount !== 0 ? byCount : order.indexOf(a) - order.indexOf(b);
  });

  const columns: InferredColumn[] = [];
  const constants: Stat[] = [];
  for (const key of ranked) {
    const values = sample.map((row) => row[key]);
    const present = values.filter((value) => !isBlank(value));
    // A column that is empty everywhere, or an id nobody can read, is noise.
    if (present.length === 0) continue;
    if (isOpaqueId(key, values)) continue;

    const currency = currencyIn(sample[0], root);
    const type = inferType(key, values, currency);

    // The same value in every row is a fact about the set. It belongs above
    // the table, said once, not repeated down a column.
    if (
      sample.length >= 4 &&
      present.length === values.length &&
      values.every((value) => isScalar(value) && value === values[0])
    ) {
      constants.push({ label: humanise(key), value: values[0], type, currency });
      continue;
    }

    columns.push({ key, label: humanise(key), type, currency: type === 'currency' ? currency : null });
    if (columns.length === MAX_COLUMNS) break;
  }

  if (columns.length === 0) return null;
  return { columns, rows, constants };
}

/** A scalar sibling, turned into a headline figure. */
function statOf(key: string, value: unknown, root: unknown): Stat {
  const currency = currencyIn(root);
  return { label: humanise(key), value, type: inferType(key, [value], currency), currency };
}

/** Prose: a `message` a tool left for the reader, or any long string. */
function isProse(value: unknown): value is string {
  return typeof value === 'string' && value.length > PROSE;
}

function emptyNote(value: unknown): string | null {
  if (value === null || value === undefined) return 'This tool returned nothing.';
  if (typeof value === 'string' && value.trim() === '') return 'This tool returned an empty string.';
  if (Array.isArray(value) && value.length === 0) return 'This tool returned no items.';
  if (isRecord(value) && Object.keys(value).length === 0) return 'This tool returned an empty result.';
  return null;
}

/**
 * The first sentence of a failure. A tool reports its reason in whatever field
 * it likes, so this takes the first string that reads like one and leaves the
 * rest to the detail below.
 */
export function failureSummary(value: unknown): string {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (isRecord(value)) {
    for (const key of ['message', 'error', 'reason', 'detail', 'description']) {
      const found = value[key];
      if (typeof found === 'string' && found.trim() !== '') return found;
      if (isRecord(found)) {
        const nested = failureSummary(found);
        if (nested !== 'The call failed with no reason given.') return nested;
      }
    }
  }
  return 'The call failed with no reason given.';
}

/**
 * The shape of a result, and everything a renderer needs to draw it.
 *
 * Order matters: a failure is a failure whatever it contains, an empty result
 * says so in one line rather than drawing an empty grid, and only then is the
 * data itself read for a shape.
 */
export function inferShape(value: unknown, options: { failed?: boolean } = {}): Inferred {
  if (options.failed) return { kind: 'error', summary: failureSummary(value), detail: detailOf(value) };

  // A result that says it failed is a failure even when the call "succeeded".
  if (isRecord(value)) {
    const error = value['error'];
    const ok = value['ok'];
    if ((typeof error === 'string' && error.trim() !== '') || ok === false) {
      return { kind: 'error', summary: failureSummary(value), detail: detailOf(value) };
    }
  }

  const note = emptyNote(value);
  if (note) return { kind: 'empty', note, stats: [] };

  if (Array.isArray(value)) {
    const candidate = tableCandidate(value, value);
    if (candidate) {
      return {
        kind: 'table',
        label: null,
        columns: candidate.columns,
        rows: candidate.rows,
        total: candidate.rows.length,
        stats: candidate.constants,
        notes: [],
        asides: [],
      };
    }
    if (value.every(isScalar)) {
      return { kind: 'list', label: null, items: value, total: value.length, stats: [], notes: [], asides: [] };
    }
    return { kind: 'tree', value };
  }

  if (!isRecord(value)) return { kind: 'tree', value };

  const entries = Object.entries(value);

  /* The primary array: the longest one that can be a table, else the longest
   * array of scalars. Everything else in the object arranges itself around it. */
  let best: { key: string; candidate: Candidate } | null = null;
  let scalarList: { key: string; items: unknown[] } | null = null;
  for (const [key, child] of entries) {
    if (!Array.isArray(child)) continue;
    const candidate = tableCandidate(child, value);
    if (candidate) {
      if (!best || candidate.rows.length > best.candidate.rows.length) best = { key, candidate };
      continue;
    }
    if (child.length > 0 && child.every(isScalar)) {
      if (!scalarList || child.length > scalarList.items.length) scalarList = { key, items: child };
    }
  }

  const primaryKey = best?.key ?? scalarList?.key ?? null;
  const stats: Stat[] = [];
  const notes: string[] = [];
  const asides: Aside[] = [];
  for (const [key, child] of entries) {
    if (key === primaryKey) continue;
    if (isProse(child)) {
      notes.push(child);
      continue;
    }
    if (isScalar(child)) {
      // A figure of zero or null still counts: "0 late" is an answer.
      if (child === '' ) continue;
      stats.push(statOf(key, child, value));
      continue;
    }
    if (child === undefined) continue;
    asides.push({ label: humanise(key), value: child });
  }

  if (best) {
    return {
      kind: 'table',
      label: humanise(best.key),
      columns: best.candidate.columns,
      rows: best.candidate.rows,
      total: best.candidate.rows.length,
      stats: [...stats, ...best.candidate.constants],
      notes,
      asides,
    };
  }

  if (scalarList) {
    return {
      kind: 'list',
      label: humanise(scalarList.key),
      items: scalarList.items,
      total: scalarList.items.length,
      stats,
      notes,
      asides,
    };
  }

  // An object of arrays that are each empty is an answer of "none", not a grid.
  const emptyArrays = entries.filter(([, child]) => Array.isArray(child) && child.length === 0);
  if (emptyArrays.length > 0 && emptyArrays.length === entries.filter(([, c]) => Array.isArray(c)).length) {
    const label = emptyArrays.map(([key]) => humanise(key).toLowerCase()).join(', ');
    return { kind: 'empty', note: `No ${label} to show.`, stats };
  }

  /* No array at all: one object, read as the facts it states. Nested objects
   * stay nested, one disclosure deep, rather than being flattened into keys
   * nobody wrote. */
  if (entries.every(([, child]) => isScalar(child) || isRecord(child) || Array.isArray(child))) {
    return { kind: 'record', pairs: stats, notes, asides };
  }

  return { kind: 'tree', value };
}

/** Everything about a failure except the sentence already shown. */
function detailOf(value: unknown): unknown {
  if (!isRecord(value)) return null;
  const rest = Object.entries(value).filter(([key]) => key !== 'message' && key !== 'error');
  return rest.length === 0 ? null : Object.fromEntries(rest);
}

/** How many rows the panel shows before it asks. */
export const ROW_CAP = 25;
