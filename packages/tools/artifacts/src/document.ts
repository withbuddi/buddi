/**
 * The pure half of `artifacts.write`: what a document's file is called, which
 * version it is, and how a JSON table becomes a CSV. No database, no disk.
 */

/**
 * The most a written document may hold: 512 KiB once saved (about a
 * 150-page report), the most buddi converts to PDF, Word or Excel. The
 * character cap is what the tool's input refuses outright.
 */
export const MAX_DOCUMENT_BYTES = 512 * 1024;
export const MAX_DOCUMENT_CHARS = MAX_DOCUMENT_BYTES;
/** Longest title kept in the file name; the rest is cut at a word. */
export const MAX_TITLE_CHARS = 100;
/** Longest folder label. */
export const MAX_FOLDER_CHARS = 60;
/** Most rows and columns a JSON table may have. */
export const MAX_TABLE_ROWS = 50_000;
export const MAX_TABLE_COLUMNS = 200;
/** Most cells (rows × columns) a JSON table may describe, checked before any row is built. */
export const MAX_TABLE_CELLS = 1_000_000;

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
  // Every limit is checked while scanning, before a rectangular table is
  // built: a short input naming many distinct keys must not allocate
  // rows × keys cells first and be refused after.
  const tooManyRows = (n: number): never => {
    throw new Error(`the table has ${n} rows; at most ${MAX_TABLE_ROWS}`);
  };
  const tooManyColumns = (n: number): never => {
    throw new Error(`the table has ${n} columns; at most ${MAX_TABLE_COLUMNS}`);
  };
  const checkSize = (rowCount: number, columnCount: number): void => {
    if (columnCount === 0) throw new Error('the table has no columns');
    if (columnCount > MAX_TABLE_COLUMNS) tooManyColumns(columnCount);
    if (rowCount > MAX_TABLE_ROWS) tooManyRows(rowCount);
    if (rowCount * columnCount > MAX_TABLE_CELLS) {
      throw new Error(`the table has ${rowCount} rows of ${columnCount} columns; at most ${MAX_TABLE_CELLS.toLocaleString('en-US')} cells`);
    }
  };
  const checkRows = (rows: readonly unknown[], width: number, first: number): unknown[][] => {
    rows.forEach((r, i) => {
      if (!Array.isArray(r)) throw new Error('every row must be an array of cells');
      if (r.length > width) throw new Error(`row ${i + first} has ${r.length} cells; the header has ${width}`);
    });
    return rows as unknown[][];
  };

  if (value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as any).columns) && Array.isArray((value as any).rows)) {
    const header = (value as any).columns as unknown[];
    const body = (value as any).rows as unknown[];
    checkSize(body.length, header.length);
    const columns = header.map((c) => String(c));
    return { columns, rows: checkRows(body, columns.length, 1) };
  }
  if (Array.isArray(value) && value.length > 0 && value.every((r) => Array.isArray(r))) {
    const header = value[0] as unknown[];
    checkSize(value.length - 1, header.length);
    const columns = header.map((c) => String(c));
    return { columns, rows: checkRows(value.slice(1), columns.length, 1) };
  }
  if (Array.isArray(value) && value.length > 0 && value.every((r) => r && typeof r === 'object' && !Array.isArray(r))) {
    if (value.length > MAX_TABLE_ROWS) tooManyRows(value.length);
    const seen = new Set<string>();
    for (const row of value as Record<string, unknown>[]) {
      for (const key in row) {
        if (!Object.prototype.hasOwnProperty.call(row, key)) continue;
        seen.add(key);
        if (seen.size > MAX_TABLE_COLUMNS) throw new Error(`the table has more than ${MAX_TABLE_COLUMNS} distinct keys; at most ${MAX_TABLE_COLUMNS} columns`);
      }
    }
    const columns = [...seen];
    checkSize(value.length, columns.length);
    return { columns, rows: (value as Record<string, unknown>[]).map((row) => columns.map((c) => row[c])) };
  }
  throw new Error("for format 'json' send a non-empty array of objects ([{\"Month\":\"Jan\",\"Total\":120}]), an array of arrays with a header row first, or { \"columns\": [...], \"rows\": [[...]] }");
}
