/**
 * Cell addresses: `B7` ⇄ row 7, column 2 (both 1-based, as the file counts),
 * ranges, and moving a formula's relative references — what a shared
 * formula and a conditional rule written for its range's first cell need.
 */

/** The largest row and column a sheet has. */
export const MAX_ROW = 1_048_576;
export const MAX_COL = 16_384;

/** One cell's key in a sheet's map: row and column in one number. */
export function cellKey(row: number, col: number): number {
  return row * (MAX_COL + 1) + col;
}

/** Column letters, as the spreadsheet names them: 1 → A … 27 → AA. */
export function columnName(col: number): string {
  let name = '';
  for (let n = col; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** A column's number from its letters (`AA` → 27), or 0. */
export function columnNumber(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) return 0;
    n = n * 26 + (code - 64);
  }
  return n;
}

/** `B7` → `{ row: 7, col: 2 }`; `$B$7` too. Null for anything else. */
export function parseAddress(ref: string): { row: number; col: number } | null {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref.trim());
  if (!match) return null;
  const col = columnNumber(match[1]!);
  const row = Number(match[2]);
  return col >= 1 && col <= MAX_COL && row >= 1 && row <= MAX_ROW ? { row, col } : null;
}

/** The address of a cell: row 7, column 2 → `B7`. */
export function address(row: number, col: number): string {
  return `${columnName(col)}${row}`;
}

/** A rectangle of cells, corners included. */
export interface CellRange { r1: number; c1: number; r2: number; c2: number }

/** `A1:C3` (or one cell, `B2`) → its rectangle, corners ordered; null for anything else. */
export function parseRange(ref: string): CellRange | null {
  const [from, to] = ref.split(':');
  const a = parseAddress(from ?? '');
  const b = to === undefined ? a : parseAddress(to);
  if (!a || !b) return null;
  return { r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col), r2: Math.max(a.row, b.row), c2: Math.max(a.col, b.col) };
}

/** A space-separated list of ranges (a conditional rule's `sqref`). */
export function parseRanges(sqref: string): CellRange[] {
  return sqref.split(/\s+/).map(parseRange).filter((r): r is CellRange => r !== null);
}

export function inRange(range: CellRange, row: number, col: number): boolean {
  return row >= range.r1 && row <= range.r2 && col >= range.c1 && col <= range.c2;
}

/**
 * A formula with its relative references moved by `rows` and `cols`, as
 * Excel reads a formula written for one cell when it applies to another: a
 * `$` keeps its part; text in quotes and function names are left alone. A
 * reference moved off the sheet becomes `#REF!`.
 */
export function shiftFormula(formula: string, rows: number, cols: number): string {
  if (rows === 0 && cols === 0) return formula;
  const REF = /("(?:[^"]|"")*")|((?:'(?:[^']|'')+'|[A-Za-z_][\w.]*)!)?(?<![\w$.])(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![\w(!])/g;
  return formula.replace(REF, (all, quoted: string | undefined, sheet: string | undefined, colAbs: string, letters: string, rowAbs: string, digits: string) => {
    if (quoted !== undefined) return all;
    const col = colAbs ? columnNumber(letters) : columnNumber(letters) + cols;
    const row = rowAbs ? Number(digits) : Number(digits) + rows;
    if (col < 1 || col > MAX_COL || row < 1 || row > MAX_ROW) return `${sheet ?? ''}#REF!`;
    return `${sheet ?? ''}${colAbs}${columnName(col)}${rowAbs}${row}`;
  });
}
