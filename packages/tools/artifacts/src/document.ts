/**
 * The pure half of `artifacts.write`: what a document's file is called, which
 * version it is, and how a JSON table becomes a CSV. No database, no disk.
 */

/** The most a written document may hold, in characters (about a 300-page report). */
export const MAX_DOCUMENT_CHARS = 1_000_000;
/** Longest title kept in the file name; the rest is cut at a word. */
export const MAX_TITLE_CHARS = 100;
/** Longest folder label. */
export const MAX_FOLDER_CHARS = 60;
/** Most rows and columns a JSON table may have. */
export const MAX_TABLE_ROWS = 50_000;
export const MAX_TABLE_COLUMNS = 200;

export type DocumentFormat = 'markdown' | 'csv' | 'json';

/** The stored type for each format. A JSON table is stored as the CSV it describes. */
export const FORMAT_FILE: Record<DocumentFormat, { mime: string; ext: string }> = {
  markdown: { mime: 'text/markdown', ext: 'md' },
  csv: { mime: 'text/csv', ext: 'csv' },
  json: { mime: 'text/csv', ext: 'csv' },
};

/**
 * A title made safe to be a file name on every system the owner might save it
 * to: no separators, no control characters, nothing a shell or Windows refuses,
 * no leading dots (so never `..` or a hidden file). Spaces and letters stay.
 */
export function safeName(raw: string, max: number, fallback: string): string {
  let name = raw
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\-\s]+/, '')
    .replace(/[.\s]+$/, '');
  if (name.length > max) {
    const cut = name.slice(0, max);
    const space = cut.lastIndexOf(' ');
    name = (space > max / 2 ? cut.slice(0, space) : cut).replace(/[.\s-]+$/, '');
  }
  // Names Windows reserves for devices, whatever the extension.
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name)) name = `${name}-file`;
  return name === '' ? fallback : name;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The version a new write of `base` gets, given the file names already in the
 * conversation: one past the highest of `base.ext` (version 1) and
 * `base (vN).ext`. Comparison ignores case, as the owner's file system may.
 */
export function nextVersion(base: string, ext: string, existing: readonly (string | null)[]): number {
  const pattern = new RegExp(`^${escapeRegExp(base)}(?: \\(v(\\d+)\\))?\\.${escapeRegExp(ext)}$`, 'i');
  let highest = 0;
  for (const name of existing) {
    const match = name ? pattern.exec(name) : null;
    if (!match) continue;
    highest = Math.max(highest, match[1] ? Number(match[1]) : 1);
  }
  return highest + 1;
}

export function versionedName(base: string, ext: string, version: number): string {
  return version <= 1 ? `${base}.${ext}` : `${base} (v${version}).${ext}`;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/**
 * A JSON table as columns and rows. Three shapes are read, because those are
 * the three a model writes without being told: an array of objects (columns
 * are the keys, in first-seen order), an array of arrays (the first is the
 * header), and `{ columns, rows }`. Anything else is refused with what to send.
 */
export function parseJsonTable(content: string): { columns: string[]; rows: unknown[][] } {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (err) {
    throw new Error(`content is not valid JSON (${err instanceof Error ? err.message : String(err)}); for format 'json' send an array of objects, e.g. [{"Month":"Jan","Total":120}]`);
  }
  let columns: string[];
  let rows: unknown[][];
  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as any).columns) && Array.isArray((value as any).rows)) {
    columns = (value as any).columns.map((c: unknown) => String(c));
    rows = (value as any).rows.map((r: unknown) => {
      if (!Array.isArray(r)) throw new Error('every entry of `rows` must be an array of cells');
      return r;
    });
  } else if (Array.isArray(value) && value.length > 0 && value.every((r) => Array.isArray(r))) {
    columns = (value[0] as unknown[]).map((c) => String(c));
    rows = value.slice(1) as unknown[][];
  } else if (Array.isArray(value) && value.length > 0 && value.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
    const seen = new Set<string>();
    for (const row of value as Record<string, unknown>[]) for (const key of Object.keys(row)) seen.add(key);
    columns = [...seen];
    rows = (value as Record<string, unknown>[]).map((row) => columns.map((c) => row[c]));
  } else {
    throw new Error("for format 'json' send a non-empty array of objects ([{\"Month\":\"Jan\",\"Total\":120}]), an array of arrays with a header row first, or { \"columns\": [...], \"rows\": [[...]] }");
  }
  if (columns.length === 0) throw new Error('the table has no columns');
  if (columns.length > MAX_TABLE_COLUMNS) throw new Error(`the table has ${columns.length} columns; at most ${MAX_TABLE_COLUMNS}`);
  if (rows.length > MAX_TABLE_ROWS) throw new Error(`the table has ${rows.length} rows; at most ${MAX_TABLE_ROWS}`);
  return { columns, rows };
}
