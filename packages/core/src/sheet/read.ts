/**
 * A workbook's sheets as the sheet engine reads them: every cell's cached
 * value, formula and format, and per sheet its column widths, row heights,
 * frozen panes, merges and conditional rules. Read-only, from the bytes,
 * each part inflated within the Office limits (`unzipOffice`). Cells are
 * kept sparsely, by address: a workbook with one cell in its far corner is
 * one cell, not a million rows.
 *
 * Values here are the file's own: a number (a date is its serial), text, a
 * boolean, an error such as `#DIV/0!`, or null. read-excel-file stays what
 * turns them into dates and text for the agent's CSV; the page's table
 * shows them through `formatCell`.
 */
import { OFFICE_ZIP_LIMITS } from '../office-files.js';
import { unzipOffice, type ZipLimits } from '../office-zip.js';
import { cellKey, parseAddress, parseRange, parseRanges, shiftFormula, type CellRange } from './refs.js';
import { readStyles, type StyleSheet } from './styles.js';
import { attr, boolAttr, decodeXml, numAttr, runText } from './xml.js';

/** An error a cell holds, as Excel writes it: `#DIV/0!`, `#N/A`, `#NAME?`, `#REF!`, `#VALUE!`, `#NUM!`, `#NULL!`. */
export interface SheetError { error: string }

export type CellValue = number | string | boolean | SheetError | null;

export const isSheetError = (value: unknown): value is SheetError =>
  typeof value === 'object' && value !== null && typeof (value as SheetError).error === 'string';

export interface CellModel {
  row: number;
  col: number;
  /** What the file says the cell holds: its cached value for a formula. */
  value: CellValue;
  /** The formula, without its `=`, when the cell has one. */
  formula?: string;
  /** Whether the file carries a value for it (a formula from openpyxl or write-excel-file has none). */
  hasValue: boolean;
  /** The cell format (`s`), an index into `StyleSheet.cells`. */
  style: number;
}

export type ConditionalType = 'cellIs' | 'expression' | 'containsText' | 'notContainsText' | 'beginsWith' | 'endsWith' | 'other';

export interface ConditionalRule {
  type: ConditionalType;
  /** cellIs: `greaterThan`, `between`…; containsText: `containsText`. */
  operator?: string;
  /** Its formulas, without `=`, written for the first cell of its first range. */
  formulas: string[];
  text?: string;
  /** The format it applies (`StyleSheet.dxfs`), or null. */
  dxf: number | null;
  priority: number;
  stopIfTrue: boolean;
}

export interface ConditionalBlock { ranges: CellRange[]; rules: ConditionalRule[] }

export interface SheetModel {
  name: string;
  /** The part it was read from, e.g. `xl/worksheets/sheet1.xml`. */
  path: string;
  hidden: boolean;
  cells: Map<number, CellModel>;
  /** The last row and column holding a cell. */
  maxRow: number;
  maxCol: number;
  /** Widths in characters, by column range (`<col min max width>`). */
  columns: Array<{ min: number; max: number; width: number; hidden: boolean }>;
  /** Heights in points, by row, where the file sets one. */
  rowHeights: Map<number, number>;
  frozen: { rows: number; cols: number };
  merges: CellRange[];
  conditional: ConditionalBlock[];
}

export interface WorkbookModel {
  sheets: SheetModel[];
  styles: StyleSheet;
  /** Dates count from 1904 (old Mac workbooks). */
  date1904: boolean;
  /**
   * Set when buddi does not read this workbook, and then it has no sheets
   * (`workbookUnsupported`): `prefixed`, its SpreadsheetML written with a
   * namespace prefix (`<x:workbook>`), which some exporters do and this
   * reader does not follow; `unreadable`, any other workbook part whose
   * root is not a plain `<workbook>` found where it is looked for.
   */
  unsupported?: WorkbookUnsupported;
}

export type WorkbookUnsupported = 'prefixed' | 'unreadable';

/** What a reader says of a workbook it does not read (`WorkbookModel.unsupported`). */
export const UNSUPPORTED_WORKBOOK: Readonly<Record<WorkbookUnsupported, string>> = {
  prefixed: 'it writes its spreadsheet markup with a namespace prefix, which buddi does not read',
  unreadable: 'its workbook part is not one buddi reads',
};

/** How far into the workbook part its root is looked for. */
const ROOT_WITHIN = 64 * 1024;

/**
 * Whether buddi reads this workbook part, failing closed: only a root
 * element that is exactly an unprefixed `<workbook` followed by
 * whitespace, `>` or `/`, found within the part's first 64 KB past the XML
 * declaration, comments and a doctype, is read (null). A `:` before
 * `workbook` is `prefixed`; anything else (no part, no root within the
 * bound, another name) is `unreadable`. Nothing past the bound is scanned.
 */
export function workbookUnsupported(workbookXml: string | undefined): WorkbookUnsupported | null {
  if (workbookXml === undefined) return 'unreadable';
  const head = workbookXml.slice(0, ROOT_WITHIN);
  let at = 0;
  while (at < head.length) {
    const lt = head.indexOf('<', at);
    if (lt < 0) return 'unreadable';
    // A declaration, a comment or a doctype is skipped; the first other tag is the root.
    const skip = head.startsWith('<?', lt) ? '?>' : head.startsWith('<!--', lt) ? '-->' : head.startsWith('<!', lt) ? '>' : null;
    if (skip === null) {
      if (/^<workbook[\s>/]/.test(head.slice(lt, lt + 10))) return null;
      // The root's name as far as it goes, within 512 characters: a prefix is anything before a colon.
      const name = /^<([^\s>/]*)/.exec(head.slice(lt, lt + 512))?.[1] ?? '';
      return /:workbook$/.test(name) ? 'prefixed' : 'unreadable';
    }
    const close = head.indexOf(skip, lt + 2);
    if (close < 0) return 'unreadable';
    at = close + skip.length;
  }
  return 'unreadable';
}

/** The parts a workbook is read from, by name, as text. */
export type WorkbookParts = Record<string, string>;

export type { ZipLimits };

/** The parts of an xlsx this reader reads: the workbook, its relations, sheets, shared strings, styles, theme. */
export function isWorkbookPart(name: string): boolean {
  return name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels'
    || name === 'xl/sharedStrings.xml' || name === 'xl/styles.xml' || /^xl\/theme\/theme\d*\.xml$/.test(name)
    || /^xl\/worksheets\/[^/]+\.xml$/.test(name);
}

/**
 * A package's parts, inflated within the Office limits by core's one rule
 * (`unzipOffice`): the zip directory is checked first, and a part that
 * inflates past the size it declared is refused, not read.
 */
export function unzipBounded(bytes: Uint8Array, want: (name: string) => boolean = () => true, limits: ZipLimits = OFFICE_ZIP_LIMITS): Record<string, Uint8Array> {
  const parts = unzipOffice(bytes, want, limits);
  if (typeof parts === 'string') throw new Error(`the workbook cannot be read: ${parts}`);
  return parts;
}

/** The parts of an xlsx this reader needs, unzipped within the Office limits. */
export function workbookParts(bytes: Uint8Array, limits: ZipLimits = OFFICE_ZIP_LIMITS): WorkbookParts {
  const parts = unzipBounded(bytes, isWorkbookPart, limits);
  const decoder = new TextDecoder();
  return Object.fromEntries(Object.entries(parts).map(([name, data]) => [name, decoder.decode(data)]));
}

/** Where each sheet's part is, from the workbook's relations. */
function sheetTargets(parts: WorkbookParts): Array<{ name: string; path: string; hidden: boolean }> {
  const rels = new Map<string, string>();
  for (const m of (parts['xl/_rels/workbook.xml.rels'] ?? '').matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1]!, 'Id');
    const target = attr(m[1]!, 'Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`.replace(/\/\.\//g, '/'));
  }
  const out: Array<{ name: string; path: string; hidden: boolean }> = [];
  for (const m of (parts['xl/workbook.xml'] ?? '').matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = attr(m[1]!, 'name');
    const id = attr(m[1]!, 'r:id');
    const path = id ? rels.get(id) : undefined;
    if (name !== null && path) out.push({ name, path, hidden: (attr(m[1]!, 'state') ?? 'visible') !== 'visible' });
  }
  return out;
}

function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => runText(m[1] ?? ''));
}

const stripEquals = (formula: string): string => formula.replace(/^\s*=/, '');

/** A cell's value from its type and `<v>` text. */
function valueOf(type: string | null, raw: string, strings: string[]): CellValue {
  switch (type) {
    case 's': return strings[Number(raw)] ?? '';
    case 'str':
    case 'inlineStr': return raw;
    case 'b': return raw === '1' || raw.toLowerCase() === 'true';
    case 'e': return { error: raw };
    case 'd': return raw;
    default: {
      const n = Number(raw);
      return raw.trim() !== '' && Number.isFinite(n) ? n : raw;
    }
  }
}

function readSheet(xml: string, target: { name: string; path: string; hidden: boolean }, strings: string[]): SheetModel {
  const cells = new Map<number, CellModel>();
  const rowHeights = new Map<number, number>();
  const shared = new Map<string, { formula: string; row: number; col: number }>();
  let maxRow = 0;
  let maxCol = 0;
  let row = 0;
  let col = 0;
  const data = /<sheetData\b[^>]*>([\s\S]*?)<\/sheetData>/.exec(xml)?.[1] ?? '';
  for (const m of data.matchAll(/<row\b([^>]*?)(\/?)>|<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    if (m[1] !== undefined) {
      row = numAttr(m[1], 'r') ?? row + 1;
      col = 0;
      const ht = numAttr(m[1], 'ht');
      if (ht !== null && boolAttr(m[1], 'customHeight')) rowHeights.set(row, ht);
      continue;
    }
    const tag = m[3] ?? '';
    const body = m[4] ?? '';
    const at = parseAddress(attr(tag, 'r') ?? '');
    if (at) { row = at.row; col = at.col; } else col += 1;
    if (row === 0) row = 1;
    const type = attr(tag, 't');
    const style = numAttr(tag, 's') ?? 0;
    const fTag = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/.exec(body);
    let formula: string | undefined;
    if (fTag) {
      const fAttrs = fTag[1] ?? '';
      const text = fTag[2] === undefined ? '' : stripEquals(decodeXml(fTag[2]));
      if (attr(fAttrs, 't') === 'shared') {
        const si = attr(fAttrs, 'si') ?? '';
        if (text !== '') shared.set(si, { formula: text, row, col });
        const master = shared.get(si);
        if (master) formula = text !== '' ? text : shiftFormula(master.formula, row - master.row, col - master.col);
      } else if (text !== '') formula = text;
    }
    const vMatch = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body);
    const inline = type === 'inlineStr' ? runText(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '') : null;
    const raw = vMatch ? decodeXml(vMatch[1]!) : /<v(?:\s[^>]*)?\/>/.test(body) ? '' : null;
    // openpyxl writes an empty `<v></v>` (or `<v/>`) after a formula: no value. Typed `str`, either is a
    // saved empty string (an IF that returned "").
    const hasValue = inline !== null || (raw !== null && (raw !== '' || type === 'str'));
    const value = inline !== null ? inline : hasValue ? valueOf(type, raw!, strings) : null;
    if (formula === undefined && !hasValue && style === 0) continue;
    cells.set(cellKey(row, col), { row, col, value, hasValue, style, ...(formula === undefined ? {} : { formula }) });
    if (formula !== undefined || hasValue) {
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
    }
  }

  const columns = [...(/<cols\b[^>]*>([\s\S]*?)<\/cols>/.exec(xml)?.[1] ?? '').matchAll(/<col\b([^>]*)\/?>/g)].flatMap((c) => {
    const min = numAttr(c[1]!, 'min');
    const max = numAttr(c[1]!, 'max');
    const width = numAttr(c[1]!, 'width');
    return min !== null && max !== null && width !== null ? [{ min, max, width, hidden: boolAttr(c[1]!, 'hidden') }] : [];
  });

  const pane = /<pane\b([^>]*)\/?>/.exec(/<sheetView\b[\s\S]*?(?:<\/sheetView>|\/>)/.exec(xml)?.[0] ?? '')?.[1];
  const frozenState = pane ? attr(pane, 'state') : null;
  const frozen = pane && (frozenState === 'frozen' || frozenState === 'frozenSplit')
    ? { rows: Math.max(0, Math.round(numAttr(pane, 'ySplit') ?? 0)), cols: Math.max(0, Math.round(numAttr(pane, 'xSplit') ?? 0)) }
    : { rows: 0, cols: 0 };

  const merges = [...xml.matchAll(/<mergeCell\b([^>]*)\/?>/g)]
    .map((mc) => parseRange(attr(mc[1]!, 'ref') ?? ''))
    .filter((r): r is CellRange => r !== null);

  const conditional: ConditionalBlock[] = [];
  for (const block of xml.matchAll(/<conditionalFormatting\b([^>]*)>([\s\S]*?)<\/conditionalFormatting>/g)) {
    const ranges = parseRanges(attr(block[1]!, 'sqref') ?? '');
    if (ranges.length === 0) continue;
    const rules = [...block[2]!.matchAll(/<cfRule\b([^>]*?)(?:\/>|>([\s\S]*?)<\/cfRule>)/g)].map((rule): ConditionalRule => {
      const tag = rule[1] ?? '';
      const t = attr(tag, 'type') ?? '';
      const type: ConditionalType = ['cellIs', 'expression', 'containsText', 'notContainsText', 'beginsWith', 'endsWith'].includes(t) ? t as ConditionalType : 'other';
      const operator = attr(tag, 'operator');
      const text = attr(tag, 'text');
      return {
        type,
        ...(operator === null ? {} : { operator }),
        ...(text === null ? {} : { text }),
        formulas: [...(rule[2] ?? '').matchAll(/<formula>([\s\S]*?)<\/formula>/g)].map((f) => stripEquals(decodeXml(f[1]!))),
        dxf: numAttr(tag, 'dxfId'),
        priority: numAttr(tag, 'priority') ?? 0,
        stopIfTrue: boolAttr(tag, 'stopIfTrue'),
      };
    });
    conditional.push({ ranges, rules });
  }

  return { name: target.name, path: target.path, hidden: target.hidden, cells, maxRow, maxCol, columns, rowHeights, frozen, merges, conditional };
}

/** A workbook read from its parts (`workbookParts`). */
export function readWorkbookParts(parts: WorkbookParts): WorkbookModel {
  const unsupported = workbookUnsupported(parts['xl/workbook.xml']);
  if (unsupported !== null) return { sheets: [], styles: readStyles(undefined, undefined), date1904: false, unsupported };
  const strings = sharedStrings(parts['xl/sharedStrings.xml']);
  const theme = Object.keys(parts).filter((p) => /^xl\/theme\/theme\d*\.xml$/.test(p)).sort()[0];
  const sheets = sheetTargets(parts).flatMap((target) => {
    const xml = parts[target.path];
    return xml === undefined ? [] : [readSheet(xml, target, strings)];
  });
  const workbookPr = /<workbookPr\b([^>]*)\/?>/.exec(parts['xl/workbook.xml'] ?? '')?.[1] ?? '';
  return { sheets, styles: readStyles(parts['xl/styles.xml'], theme ? parts[theme] : undefined), date1904: boolAttr(workbookPr, 'date1904') };
}

/** A workbook read from an xlsx's bytes. */
export function readWorkbook(bytes: Uint8Array, limits: ZipLimits = OFFICE_ZIP_LIMITS): WorkbookModel {
  return readWorkbookParts(workbookParts(bytes, limits));
}
