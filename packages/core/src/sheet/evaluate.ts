/**
 * Formula values buddi works out itself, for formulas the file carries no
 * value for: what a composed workbook is filled with before it is stored,
 * and what the preview shows for a sheet openpyxl wrote. A preview of the
 * value, never the truth: a filled workbook also asks Excel and Numbers to
 * recalculate when it opens (`fullCalcOnLoad`).
 *
 * The parser and functions are `fast-formula-parser` (MIT; pinned, loaded
 * only when there is something to compute), over buddi's own cell reader
 * (`read.ts`); the functions the library leaves empty that the xlsx guide
 * names are buddi's own below (COUNTA, COUNTBLANK, SUMIFS, COUNTIFS,
 * AVERAGEIFS, MATCH, SUBTOTAL). Swappable behind this module: nothing else
 * imports the library. A 1904 workbook's dates are moved to and from the
 * library's 1900 serials at its date functions.
 *
 * Caps: 20,000 formula cells a workbook, 2 s a sheet (checked inside range
 * reads too), 100,000 cells in one range and 2,000,000 read in all; a range
 * past them is `#REF!`, "too large to calculate". A whole-column or
 * whole-row reference (`A:A`) is read to the workbook's last used row or
 * column; any other range keeps its size, blanks included. A circular
 * reference is `#REF!`; a function it does not know, `#NAME?`; neither gets
 * a value. Cells with a value in the file are read, never recomputed,
 * unless `want` picks them (the fill recomputes every formula).
 */
import { isSheetError, type CellModel, type CellValue, type SheetError, type SheetModel, type WorkbookModel } from './read.js';
import { address, cellKey } from './refs.js';

export const EVALUATE_LIMITS = { formulas: 20_000, msPerSheet: 2_000, depth: 200, listed: 200, rangeCells: 100_000, cellsRead: 2_000_000 } as const;

/** A formula buddi could not give a value. */
export interface UncomputedCell {
  sheet: string;
  cell: string;
  formula: string;
  /** What a spreadsheet would show: `#NAME?`, `#REF!`… */
  error: string;
  /** Why, in a few words. */
  reason: string;
}

export interface Evaluation {
  /** What buddi computed, by sheet name, then by `cellKey`. An error result (`#DIV/0!`) is a value too. */
  values: Map<string, Map<number, CellValue>>;
  /** The formulas it could not compute (at most 200 listed; `failedCount` counts them all). */
  failed: UncomputedCell[];
  failedCount: number;
  /** Every formula it could not compute, by sheet name, then by `cellKey`: its error. */
  uncomputed: Map<string, Map<number, string>>;
  /** How many formula cells it computed. */
  computed: number;
}

export interface EvaluateOptions {
  /** Which formula cells to compute; by default every one without a value in the file. Their inputs are computed as needed. */
  want?: (sheet: SheetModel, cell: CellModel) => boolean;
  limits?: Partial<Record<keyof typeof EVALUATE_LIMITS, number>>;
}

/* The library's surface, as far as buddi uses it (it ships no types). */
interface FormulaErrorLike { error: string; message: string }
interface ParserRef { sheet?: string; row?: number; col?: number; from?: { row: number; col: number }; to?: { row: number; col: number } }
interface Arg { value: unknown; isArray?: boolean; omitted?: boolean }
interface ParserLike {
  parse(formula: string, position: { sheet: string; row: number; col: number }): unknown;
  position: { sheet: string; row: number; col: number };
  utils: { extractRefValue(arg: unknown): { val: unknown; isArray: boolean } };
  funsNeedContextAndNoDataRetrieve: string[];
  funsNeedContext: string[];
  functions: Record<string, (...args: unknown[]) => unknown>;
}
interface LibraryLike {
  new (config: {
    functions?: Record<string, (...args: never[]) => unknown>;
    onCell: (ref: ParserRef) => unknown;
    onRange: (ref: ParserRef) => unknown;
    onVariable: (name: string, sheet: string) => unknown;
  }): ParserLike;
  FormulaError: { new (code: string): FormulaErrorLike; NA: FormulaErrorLike; VALUE: FormulaErrorLike; REF: FormulaErrorLike; DIV0: FormulaErrorLike; NAME: FormulaErrorLike };
  MAX_ROW: number;
  MAX_COLUMN: number;
}

let library: Promise<LibraryLike> | null = null;
/** The library, loaded once, on first need (in the page, its own chunk). */
function loadLibrary(): Promise<LibraryLike> {
  library ??= import('fast-formula-parser').then((mod) => ((mod as { default?: unknown }).default ?? mod) as LibraryLike);
  return library;
}

class TimeUp extends Error {}
/** A range past `rangeCells`, or past `cellsRead` in all. */
class TooLarge extends Error {}

/** Days between the 1900 and the 1904 date systems. */
const DAYS_1904 = 1462;
/** The library's date functions, by what they take and give: moved for a 1904 workbook. */
const DATE_OUT = ['DATE', 'DATEVALUE', 'TODAY', 'NOW'];
const DATE_IN = ['YEAR', 'MONTH', 'DAY', 'WEEKDAY', 'WEEKNUM', 'ISOWEEKNUM', 'TEXT'];
const DATE_IN_OUT = ['EDATE', 'EOMONTH', 'WORKDAY'];
const DATES_IN = ['DATEDIF', 'YEARFRAC', 'DAYS360', 'NETWORKDAYS'];

/** A 1904 workbook's serials are the library's less 1,462 days: shift what goes in, and what comes out. */
function in1904(functions: Record<string, (...args: unknown[]) => unknown>): void {
  const shiftArg = (arg: unknown): unknown => {
    const held = arg as Arg | null;
    return held && typeof held === 'object' && typeof held.value === 'number' ? { ...held, value: held.value + DAYS_1904 } : arg;
  };
  const shiftOut = (out: unknown): unknown => (typeof out === 'number' ? out - DAYS_1904 : out);
  const wrap = (name: string, ins: number, out: boolean): void => {
    const original = functions[name];
    if (!original) return;
    functions[name] = (...args: unknown[]) => {
      const moved = args.map((a, i) => (i < ins ? shiftArg(a) : a));
      const result = original(...moved);
      return out ? shiftOut(result) : result;
    };
  };
  for (const name of DATE_OUT) wrap(name, 0, true);
  for (const name of DATE_IN) wrap(name, 1, false);
  for (const name of DATE_IN_OUT) wrap(name, 1, true);
  for (const name of DATES_IN) wrap(name, 2, false);
}

/** Excel's criteria (`">100"`, `"<>"`, `"Fl*"`, `5`) as a test of one value. */
export function criterion(spec: unknown): (value: unknown) => boolean {
  if (typeof spec === 'number') return (v) => (typeof v === 'number' ? v === spec : typeof v === 'string' && v.trim() !== '' && Number(v) === spec);
  if (typeof spec === 'boolean') return (v) => v === spec;
  const text = spec === null || spec === undefined ? '' : String(spec);
  const op = /^(<=|>=|<>|<|>|=)?([\s\S]*)$/.exec(text)!;
  const operator = op[1] ?? '=';
  const operand = op[2] ?? '';
  const num = operand.trim() !== '' && Number.isFinite(Number(operand)) ? Number(operand) : null;
  const blank = (v: unknown): boolean => v === null || v === undefined || v === '';
  if (operand === '' && operator === '=') return blank;
  if (operand === '' && operator === '<>') return (v) => !blank(v);
  if (num !== null) {
    const cmp = (v: unknown): number | null => (typeof v === 'number' ? v - num : null);
    switch (operator) {
      case '<': return (v) => (cmp(v) ?? 0) < 0 && cmp(v) !== null;
      case '<=': return (v) => cmp(v) !== null && cmp(v)! <= 0;
      case '>': return (v) => cmp(v) !== null && cmp(v)! > 0;
      case '>=': return (v) => cmp(v) !== null && cmp(v)! >= 0;
      case '<>': return (v) => cmp(v) !== 0;
      default: return (v) => cmp(v) === 0 || (typeof v === 'string' && v.trim() !== '' && Number(v) === num);
    }
  }
  const lower = operand.toLowerCase();
  if (operator === '=' || operator === '<>') {
    const pattern = /[*?~]/.test(operand)
      ? new RegExp(`^${operand.replace(/~([*?~])|([*?])|([.+^${}()|[\]\\])/g, (_m, esc: string, wild: string, meta: string) => (esc ? `\\${esc}` : wild === '*' ? '[\\s\\S]*' : wild === '?' ? '[\\s\\S]' : `\\${meta}`))}$`, 'i')
      : null;
    const equal = (v: unknown): boolean => typeof v === 'string' && (pattern ? pattern.test(v) : v.toLowerCase() === lower);
    return operator === '=' ? equal : (v) => !equal(v);
  }
  const cmp = (v: unknown): number | null => (typeof v === 'string' ? v.toLowerCase().localeCompare(lower) : null);
  switch (operator) {
    case '<': return (v) => cmp(v) !== null && cmp(v)! < 0;
    case '<=': return (v) => cmp(v) !== null && cmp(v)! <= 0;
    case '>': return (v) => cmp(v) !== null && cmp(v)! > 0;
    default: return (v) => cmp(v) !== null && cmp(v)! >= 0;
  }
}

const grid = (arg: Arg | undefined): unknown[][] => {
  const value = arg?.value;
  if (Array.isArray(value)) return value.map((row) => (Array.isArray(row) ? row : [row]));
  return [[value]];
};
const flat = (args: Arg[]): unknown[] => args.flatMap((a) => (a.omitted ? [] : grid(a).flat()));
/** A formula error value as the library carries one (its FormulaError). */
const isError = (v: unknown): v is FormulaErrorLike => v instanceof Error;
/** Present, for COUNTA: anything but an empty cell; an empty text ("") counts, as in Excel. */
const present = (v: unknown): boolean => v !== null && v !== undefined;

/** The functions buddi computes itself: the ones the guide names that the library leaves empty. */
function buddiFunctions(lib: LibraryLike, isSubtotal: (sheet: string, row: number, col: number) => boolean) {
  const E = lib.FormulaError;
  const ifs = (pairs: Arg[], shape: unknown[][]): boolean[][] => {
    if (pairs.length % 2 !== 0) throw E.VALUE;
    const tests: Array<{ cells: unknown[][]; test: (v: unknown) => boolean }> = [];
    for (let i = 0; i < pairs.length; i += 2) {
      const cells = grid(pairs[i]);
      if (cells.length !== shape.length || (cells[0]?.length ?? 0) !== (shape[0]?.length ?? 0)) throw E.VALUE;
      tests.push({ cells, test: criterion(grid(pairs[i + 1])[0]?.[0]) });
    }
    return shape.map((row, r) => row.map((_v, c) => tests.every((t) => t.test(t.cells[r]?.[c]))));
  };
  const aggregate = (fn: number, values: unknown[]): unknown => {
    // An error in the range is the result, except where Excel counts: COUNT skips it, COUNTA counts it.
    const mode = fn % 100;
    if (mode !== 2 && mode !== 3) { const err = values.find(isError); if (err) throw err; }
    const nums = values.filter((v): v is number => typeof v === 'number');
    const sum = nums.reduce((s, n) => s + n, 0);
    const mean = nums.length ? sum / nums.length : NaN;
    const variance = (sample: boolean): number => {
      const n = nums.length - (sample ? 1 : 0);
      if (n <= 0) throw E.DIV0;
      return nums.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
    };
    switch (fn % 100) {
      case 1: if (!nums.length) throw E.DIV0; return mean;
      case 2: return nums.length;
      case 3: return values.filter(present).length;
      case 4: return nums.length ? Math.max(...nums) : 0;
      case 5: return nums.length ? Math.min(...nums) : 0;
      case 6: return nums.reduce((p, n) => p * n, 1);
      case 7: return Math.sqrt(variance(true));
      case 8: return Math.sqrt(variance(false));
      case 9: return sum;
      case 10: return variance(true);
      case 11: return variance(false);
      default: throw E.VALUE;
    }
  };
  return {
    COUNTA: (...args: Arg[]) => flat(args).filter(present).length,
    COUNTBLANK: (range: Arg) => grid(range).flat().filter((v) => v === null || v === undefined || v === '').length,
    SUMIFS: (sumRange: Arg, ...pairs: Arg[]) => {
      const cells = grid(sumRange);
      const pass = ifs(pairs, cells);
      let sum = 0;
      cells.forEach((row, r) => row.forEach((v, c) => {
        if (!pass[r]![c]) return;
        if (isError(v)) throw v;
        if (typeof v === 'number') sum += v;
      }));
      return sum;
    },
    COUNTIFS: (...pairs: Arg[]) => {
      const pass = ifs(pairs, grid(pairs[0]));
      return pass.flat().filter(Boolean).length;
    },
    AVERAGEIFS: (avgRange: Arg, ...pairs: Arg[]) => {
      const cells = grid(avgRange);
      const pass = ifs(pairs, cells);
      const chosen = cells.flatMap((row, r) => row.filter((_v, c) => pass[r]![c]));
      const err = chosen.find(isError);
      if (err) throw err;
      const picked = chosen.filter((v): v is number => typeof v === 'number');
      if (picked.length === 0) throw E.DIV0;
      return picked.reduce((s, n) => s + n, 0) / picked.length;
    },
    MATCH: (lookup: Arg, array: Arg, type?: Arg) => {
      const want = grid(lookup)[0]?.[0];
      const cells = grid(array);
      const line = cells.length === 1 ? cells[0]! : cells.map((row) => row[0]);
      const mode = type === undefined || type.omitted ? 1 : Number(grid(type)[0]?.[0] ?? 1);
      if (mode === 0) {
        const test = typeof want === 'string' ? criterion(`=${want}`) : (v: unknown) => v === want;
        const at = line.findIndex((v) => test(v));
        if (at < 0) throw E.NA;
        return at + 1;
      }
      const cmp = (v: unknown): number | null => {
        if (typeof want === 'number' && typeof v === 'number') return v - want;
        if (typeof want === 'string' && typeof v === 'string') return v.toLowerCase().localeCompare(want.toLowerCase());
        return null;
      };
      let found = -1;
      for (let i = 0; i < line.length; i++) {
        const c = cmp(line[i]);
        if (c === null) continue;
        if (mode > 0 ? c <= 0 : c >= 0) found = i; else break;
      }
      if (found < 0) throw E.NA;
      return found + 1;
    },
    // Raw references, so the cells that are SUBTOTALs themselves are left out, as Excel does.
    SUBTOTAL: (context: ParserLike, fnArg: unknown, ...refs: unknown[]) => {
      const fn = Number(context.utils.extractRefValue(fnArg).val);
      if (!Number.isInteger(fn)) throw E.VALUE;
      const values: unknown[] = [];
      for (const raw of refs) {
        const ref = (raw as { ref?: ParserRef } | null)?.ref;
        if (!ref) { values.push(context.utils.extractRefValue(raw).val); continue; }
        const sheet = ref.sheet ?? context.position.sheet;
        const from = ref.from ?? { row: ref.row!, col: ref.col! };
        const to = ref.to ?? from;
        const cells = context.utils.extractRefValue(raw).val;
        const rows = Array.isArray(cells) ? cells : [[cells]];
        rows.forEach((row: unknown, r: number) => (Array.isArray(row) ? row : [row]).forEach((v: unknown, c: number) => {
          if (!isSubtotal(sheet, from.row + r, from.col + c) && from.row + r <= to.row) values.push(v);
        }));
      }
      return aggregate(fn, values);
    },
    // Never the network from a formula.
    WEBSERVICE: () => undefined,
  };
}

/** The engine over one workbook: what it computed, and a formula worked out at any cell (a conditional rule's). */
export interface SheetEngine {
  evaluation: Evaluation;
  /** A formula's value as if it were in this cell, or null when it cannot be computed. */
  formulaAt(sheet: string, row: number, col: number, formula: string): CellValue;
}

/**
 * The values of a workbook's formulas that have none in the file (or the
 * ones `want` picks), and the ones that could not be computed.
 */
export async function evaluate(workbook: WorkbookModel, opts: EvaluateOptions = {}): Promise<Evaluation> {
  const want = opts.want ?? ((_sheet: SheetModel, cell: CellModel) => !cell.hasValue);
  const nothing = workbook.sheets.every((sheet) => ![...sheet.cells.values()].some((c) => c.formula !== undefined && want(sheet, c)));
  if (nothing) return { values: new Map(), failed: [], failedCount: 0, uncomputed: new Map(), computed: 0 };
  return (await sheetEngine(workbook, opts)).evaluation;
}

/** The engine, with the formulas `want` picks (by default every one without a value) computed. */
export async function sheetEngine(workbook: WorkbookModel, opts: EvaluateOptions = {}): Promise<SheetEngine> {
  const limits = { ...EVALUATE_LIMITS, ...opts.limits };
  const want = opts.want ?? ((_sheet: SheetModel, cell: CellModel) => !cell.hasValue);
  const values = new Map<string, Map<number, CellValue>>();
  const failed: UncomputedCell[] = [];
  let failedCount = 0;
  let computed = 0;
  const targets = workbook.sheets.map((sheet) => ({ sheet, cells: [...sheet.cells.values()].filter((c) => c.formula !== undefined && want(sheet, c)) }));
  const uncomputed = new Map<string, Map<number, string>>();

  const lib = await loadLibrary();
  const E = lib.FormulaError;
  const byName = new Map(workbook.sheets.map((s) => [s.name.toLowerCase(), s]));
  for (const sheet of workbook.sheets) { values.set(sheet.name, new Map()); uncomputed.set(sheet.name, new Map()); }
  const failedAt = new Map<string, UncomputedCell>();
  const busy = new Set<string>();
  let deadline = Infinity;
  let evaluated = 0;

  const fail = (sheet: SheetModel, cell: CellModel, error: string, reason: string): SheetError => {
    const id = `${sheet.name}!${cell.row},${cell.col}`;
    if (!failedAt.has(id)) {
      const entry = { sheet: sheet.name, cell: address(cell.row, cell.col), formula: cell.formula ?? '', error, reason };
      failedAt.set(id, entry);
      uncomputed.get(sheet.name)!.set(cellKey(cell.row, cell.col), error);
      failedCount += 1;
      if (failed.length < limits.listed) failed.push(entry);
    }
    return { error };
  };

  const toLibrary = (value: CellValue): unknown => (isSheetError(value) ? new E(value.error) : value);
  const fromLibrary = (result: unknown): CellValue | 'unknown-function' => {
    if (result instanceof Error || (typeof result === 'object' && result !== null && 'error' in result && typeof (result as FormulaErrorLike).error === 'string')) {
      const err = result as FormulaErrorLike;
      if (err.error === '#NAME?' && /not implemented/i.test(err.message ?? '')) return 'unknown-function';
      return { error: err.error };
    }
    if (Array.isArray(result)) return fromLibrary(Array.isArray(result[0]) ? result[0][0] : result[0]);
    if (typeof result === 'number') return Number.isFinite(result) ? result : { error: '#NUM!' };
    if (typeof result === 'string' || typeof result === 'boolean') return result;
    return 0;
  };

  const isSubtotal = (sheetName: string, row: number, col: number): boolean => {
    const formula = byName.get(sheetName.toLowerCase())?.cells.get(cellKey(row, col))?.formula;
    return formula !== undefined && /^\s*(?:_xlfn\.)?SUBTOTAL\s*\(/i.test(formula);
  };

  const pool: ParserLike[] = [];
  const sheetAt: string[] = [];
  const parserAt = (depth: number): ParserLike => {
    let parser = pool[depth];
    if (parser) return parser;
    parser = new lib({
      functions: buddiFunctions(lib, isSubtotal) as unknown as Record<string, (...args: never[]) => unknown>,
      onCell: (ref) => toLibrary(valueAt(ref.sheet ?? sheetAt[depth]!, ref.row!, ref.col!, depth + 1)),
      onRange: (ref) => rangeAt(ref.sheet ?? sheetAt[depth]!, ref, depth + 1),
      onVariable: () => null,
    });
    parser.funsNeedContextAndNoDataRetrieve.push('SUBTOTAL');
    parser.funsNeedContext.push('SUBTOTAL');
    if (workbook.date1904) in1904(parser.functions);
    pool[depth] = parser;
    return parser;
  };

  /** Per depth: the input that could not be computed, when a formula at that depth read one. */
  const tainted: Array<string | null> = [];
  const taintCaller = (depth: number, what: string): void => { if (depth > 0) tainted[depth - 1] ??= what; };

  function compute(sheet: SheetModel, cell: CellModel, depth: number): CellValue {
    const mine = values.get(sheet.name)!;
    const key = cellKey(cell.row, cell.col);
    if (mine.has(key)) return mine.get(key)!;
    const id = `${sheet.name}!${cell.row},${cell.col}`;
    const here = `${sheet.name}!${address(cell.row, cell.col)}`;
    const failure = failedAt.get(id);
    if (failure) { taintCaller(depth, here); return { error: failure.error }; }
    if (Date.now() > deadline) throw new TimeUp();
    const refuse = (error: string, reason: string): SheetError => { taintCaller(depth, here); return fail(sheet, cell, error, reason); };
    if (busy.has(id)) return refuse('#REF!', 'a circular reference');
    if (depth > limits.depth) return refuse('#REF!', 'it depends on too long a chain of formulas');
    if (evaluated >= limits.formulas) return refuse('#VALUE!', `more than ${limits.formulas.toLocaleString('en-US')} formulas in the workbook`);
    evaluated += 1;
    busy.add(id);
    tainted[depth] = null;
    try {
      sheetAt[depth] = sheet.name;
      let result: unknown;
      try {
        result = parserAt(depth).parse(cell.formula!, { sheet: sheet.name, row: cell.row, col: cell.col });
      } catch (err) {
        // The library wraps what a cell read threw in its own #ERROR!; what buddi threw is buddi's.
        const cause = err instanceof TimeUp || err instanceof TooLarge ? err : (err as { details?: unknown } | null)?.details;
        if (cause instanceof TimeUp) throw cause;
        if (cause instanceof TooLarge) return refuse('#REF!', `a range too large to calculate (${cause.message})`);
        const known = err as FormulaErrorLike & { details?: unknown };
        const inner = known?.error === '#ERROR!' && known.details && typeof (known.details as FormulaErrorLike).error === 'string' ? known.details as FormulaErrorLike : known;
        if (inner && typeof inner.error === 'string' && inner.error !== '#ERROR!') result = inner;
        else return refuse('#NAME?', 'buddi could not read the formula');
      }
      // Marked while it ran (it is part of a cycle), or it read a cell that has no value: no value either.
      if (failedAt.has(id)) { taintCaller(depth, here); return { error: failedAt.get(id)!.error }; }
      const from = tainted[depth];
      if (from) return refuse(isSheetError(fromLibrary(result)) ? (fromLibrary(result) as SheetError).error : '#VALUE!', `it reads ${from}, which buddi could not compute`);
      const value = fromLibrary(result);
      if (value === 'unknown-function') {
        const name = /Function (\S+) is not implemented/i.exec((result as FormulaErrorLike).message ?? '')?.[1];
        return refuse('#NAME?', `${name ?? 'a function'} is not one buddi computes; the app computes it on open`);
      }
      mine.set(key, value);
      computed += 1;
      return value;
    } finally {
      busy.delete(id);
    }
  }

  function valueAt(sheetName: string, row: number, col: number, depth: number): CellValue {
    const sheet = byName.get(sheetName.toLowerCase());
    if (!sheet) return { error: '#REF!' };
    const cell = sheet.cells.get(cellKey(row, col));
    if (!cell) return null;
    // A formula `want` picks is computed, a value in the file notwithstanding (the fill): its readers see the new one.
    if (cell.formula !== undefined && (!cell.hasValue || want(sheet, cell))) return compute(sheet, cell, depth);
    return cell.value;
  }

  /** The workbook's last used row and column: where a whole-column or whole-row reference stops. */
  const usedRows = Math.max(1, ...workbook.sheets.map((s) => s.maxRow));
  const usedCols = Math.max(1, ...workbook.sheets.map((s) => s.maxCol));
  let cellsRead = 0;

  function rangeAt(sheetName: string, ref: ParserRef, depth: number): unknown {
    const sheet = byName.get(sheetName.toLowerCase());
    if (!sheet || !ref.from || !ref.to) return E.REF;
    // `A:A` and `1:1` reach the sheet's edge; they read to the last used row or column, the same for every sheet.
    const r2 = ref.to.row >= lib.MAX_ROW ? Math.max(ref.from.row, usedRows) : ref.to.row;
    const c2 = ref.to.col >= lib.MAX_COLUMN ? Math.max(ref.from.col, usedCols) : ref.to.col;
    const size = (r2 - ref.from.row + 1) * (c2 - ref.from.col + 1);
    if (size > limits.rangeCells) throw new TooLarge(`${size.toLocaleString('en-US')} cells; at most ${limits.rangeCells.toLocaleString('en-US')}`);
    if (cellsRead + size > limits.cellsRead) throw new TooLarge(`more than ${limits.cellsRead.toLocaleString('en-US')} cells read in the workbook`);
    cellsRead += size;
    const out: unknown[][] = [];
    for (let row = ref.from.row; row <= r2; row++) {
      if (Date.now() > deadline) throw new TimeUp();
      const line: unknown[] = [];
      for (let col = ref.from.col; col <= c2; col++) line.push(toLibrary(valueAt(sheet.name, row, col, depth)));
      out.push(line);
    }
    return out;
  }

  for (const { sheet, cells } of targets) {
    deadline = Date.now() + limits.msPerSheet;
    let index = 0;
    try {
      for (; index < cells.length; index++) compute(sheet, cells[index]!, 0);
    } catch (err) {
      if (!(err instanceof TimeUp)) throw err;
      busy.clear();
      for (; index < cells.length; index++) {
        const cell = cells[index]!;
        if (!values.get(sheet.name)!.has(cellKey(cell.row, cell.col))) fail(sheet, cell, '#VALUE!', `the sheet took more than ${limits.msPerSheet / 1000} s to compute`);
      }
    }
  }
  const formulaAt = (sheetName: string, row: number, col: number, formula: string): CellValue => {
    const sheet = byName.get(sheetName.toLowerCase());
    if (!sheet || formula.trim() === '') return null;
    deadline = Date.now() + limits.msPerSheet;
    sheetAt[0] = sheet.name;
    try {
      const value = fromLibrary(parserAt(0).parse(formula, { sheet: sheet.name, row, col }));
      return value === 'unknown-function' ? null : value;
    } catch {
      busy.clear();
      return null;
    }
  };
  return { evaluation: { values, failed, failedCount, uncomputed, computed }, formulaAt };
}

/** A formula cell's value as a reader shows it: the file's, else what buddi computed, else the error it could not get past. */
export function valueOf(evaluation: Evaluation | null, sheet: SheetModel, cell: CellModel): CellValue {
  if (cell.hasValue || cell.formula === undefined) return cell.value;
  const key = cellKey(cell.row, cell.col);
  const computed = evaluation?.values.get(sheet.name)?.get(key);
  if (computed !== undefined) return computed;
  const failure = evaluation?.uncomputed.get(sheet.name)?.get(key);
  return failure === undefined ? null : { error: failure };
}
