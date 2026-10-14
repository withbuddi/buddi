/**
 * A workbook as buddi's own table, one tab per sheet. The cells' values are
 * read by read-excel-file (MIT) — text, numbers, dates, true/false — and the
 * look by core's sheet engine (`@buddi/core/sheet`): bold and italic, font
 * and fill colours, borders, alignment, wrap, column widths, row heights,
 * merged cells, the frozen header and columns, number formats and the
 * conditional rules that compare a cell or test a formula. A formula the
 * file carries no value for (openpyxl writes none) is computed off the
 * page's thread, in a Web Worker ended if it runs too long (`sheet-job.ts`),
 * and the footer says so; a cell it cannot compute shows its error. The owner's bytes are only read. Fonts stay the table's.
 * The first 1,000 rows and 50 columns of a sheet are shown, and a sheet
 * with more says so. Loaded only when a .xlsx is opened.
 */
import { SHEET_PREVIEW_COLS, SHEET_PREVIEW_ROWS, cellText } from '@buddi/core/office-files';
import {
  cellKey, columnName, conditionalStyles, formatCell, valueOf,
  type BorderEdge, type CellStyle, type SheetModel, type WorkbookModel,
} from '@buddi/core/sheet';
import { runSheetJob, type SheetComputed } from './sheet-job';
import readExcelFile from 'read-excel-file/browser';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Empty, Notice } from '../../ui';
import type { OfficeViewerProps } from '../OfficePreview';

type Cell = string | number | boolean | Date | null;
interface Sheet { name: string; rows: Cell[][] }

/** Characters of a column's width, in pixels: Excel's default is 8.43. */
const CHAR_PX = 7;
const DEFAULT_COL_PX = 64;
/** The row numbers' column. */
const ROW_NUMBER_PX = 44;
const BORDER_PX: Record<BorderEdge['weight'], string> = { thin: '0.5px', medium: '1px', thick: '2px' };

/** Black as a font colour is the app's default text; on buddi's dark theme it is drawn as the table's text. */
const isDefaultText = (color: string | undefined): boolean => color === undefined || color === '#000000';

/** A cell's look as inline style: the file's own colours, borders and alignment. */
function cellStyle(look: Partial<CellStyle>, numberColor: string | undefined): CSSProperties {
  const style: CSSProperties = {};
  if (look.bold) style.fontWeight = 'var(--weight-bold)' as CSSProperties['fontWeight'];
  if (look.italic) style.fontStyle = 'italic';
  const lines = [look.underline ? 'underline' : '', look.strike ? 'line-through' : ''].filter(Boolean).join(' ');
  if (lines) style.textDecoration = lines;
  const text = numberColor ?? look.color;
  if (look.fill) {
    style.background = look.fill;
    // A filled cell keeps the file's own text colour, black by default: it was chosen against that fill.
    style.color = text ?? '#000000';
  } else if (!isDefaultText(text)) style.color = text;
  for (const side of ['top', 'right', 'bottom', 'left'] as const) {
    const edge = look.border?.[side];
    if (!edge) continue;
    const key = `border${side[0]!.toUpperCase()}${side.slice(1)}` as 'borderTop';
    style[key] = `${BORDER_PX[edge.weight]} solid ${edge.color && edge.color !== '#000000' ? edge.color : 'var(--text)'}`;
  }
  if (look.align) style.textAlign = look.align;
  if (look.valign) style.verticalAlign = look.valign === 'center' ? 'middle' : look.valign;
  if (look.wrap) style.whiteSpace = 'normal';
  if (look.indent) style.paddingLeft = `calc(var(--space-2) * ${look.indent})`;
  return style;
}

/** Each covered cell of a merge, and each merge's top-left cell with its span, within the shown part. */
function mergeMap(sheet: SheetModel | undefined, rows: number, cols: number): { spans: Map<number, { rowSpan: number; colSpan: number }>; covered: Set<number> } {
  const spans = new Map<number, { rowSpan: number; colSpan: number }>();
  const covered = new Set<number>();
  for (const m of sheet?.merges ?? []) {
    if (m.r1 > rows || m.c1 > cols) continue;
    const r2 = Math.min(m.r2, rows);
    const c2 = Math.min(m.c2, cols);
    spans.set(cellKey(m.r1, m.c1), { rowSpan: r2 - m.r1 + 1, colSpan: c2 - m.c1 + 1 });
    for (let r = m.r1; r <= r2; r++) for (let c = m.c1; c <= c2; c++) if (r !== m.r1 || c !== m.c1) covered.add(cellKey(r, c));
  }
  return { spans, covered };
}

export default function XlsxPreview({ bytes }: OfficeViewerProps): JSX.Element {
  const [sheets, setSheets] = useState<Sheet[] | 'loading' | 'failed'>('loading');
  const [model, setModel] = useState<WorkbookModel | null>(null);
  const [computed, setComputed] = useState<SheetComputed | 'too-large' | null>(null);
  const [at, setAt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setSheets('loading');
    setModel(null);
    setComputed(null);
    setAt(0);
    readExcelFile(bytes)
      .then((read) => { if (!cancelled) setSheets(read.map((s) => ({ name: s.sheet, rows: s.data as unknown as Cell[][] }))); })
      .catch(() => { if (!cancelled) setSheets('failed'); });
    // The look and the formulas, off this thread: a workbook it cannot read is still shown, as plain values.
    const job = runSheetJob(bytes);
    void job.model.then((read) => { if (!cancelled && read) setModel(read); });
    void job.computed.then((out) => { if (!cancelled && out !== 'failed') setComputed(out); });
    return () => { cancelled = true; job.cancel(); };
  }, [bytes]);

  const sheet = Array.isArray(sheets) ? sheets[at] : undefined;
  const modelSheet = sheet ? model?.sheets.find((s) => s.name === sheet.name) ?? model?.sheets[at] : undefined;
  const view = useMemo(() => {
    if (!sheet) return null;
    const readWidth = sheet.rows.reduce((w, r) => Math.max(w, r.length), 0);
    const totalRows = Math.max(sheet.rows.length, modelSheet?.maxRow ?? 0);
    const totalCols = Math.max(readWidth, modelSheet?.maxCol ?? 0);
    return {
      rows: Math.min(totalRows, SHEET_PREVIEW_ROWS),
      width: Math.min(totalCols, SHEET_PREVIEW_COLS),
      moreRows: totalRows > SHEET_PREVIEW_ROWS,
      moreCols: totalCols > SHEET_PREVIEW_COLS,
    };
  }, [sheet, modelSheet]);

  const evaluation = computed !== null && computed !== 'too-large' ? computed.evaluation : null;
  const sheetIndex = modelSheet && model ? model.sheets.indexOf(modelSheet) : -1;
  const conditional = useMemo(() => {
    if (!model || !modelSheet || !view || modelSheet.conditional.length === 0) return new Map<number, Partial<CellStyle>>();
    if (computed !== null && computed !== 'too-large') return computed.conditional[sheetIndex] ?? new Map<number, Partial<CellStyle>>();
    // Until the worker's colours come (or if it was ended): the rules that compare with a plain number or text.
    const valueAt = (r: number, c: number) => {
      const cell = modelSheet.cells.get(cellKey(r, c));
      return cell ? valueOf(null, modelSheet, cell) : null;
    };
    return conditionalStyles(model, modelSheet, { r1: 1, c1: 1, r2: view.rows, c2: view.width }, valueAt, null);
  }, [model, modelSheet, view, computed, sheetIndex]);

  const frozen = modelSheet?.frozen ?? { rows: 0, cols: 0 };
  const table = useRef<HTMLTableElement>(null);
  // The frozen rows and columns stick where they are drawn: offsets measured from the header and the row numbers.
  useLayoutEffect(() => {
    const el = table.current;
    if (!el || (frozen.rows === 0 && frozen.cols === 0)) return;
    const head = el.tHead?.rows[0];
    let top = head?.getBoundingClientRect().height ?? 0;
    const bodyRows = [...el.tBodies[0]?.rows ?? []];
    bodyRows.slice(0, frozen.rows).forEach((tr) => {
      for (const cell of tr.cells) cell.style.top = `${top}px`;
      top += tr.getBoundingClientRect().height;
    });
    if (frozen.cols > 0 && head) {
      let left = head.cells[0]?.getBoundingClientRect().width ?? 0;
      const lefts: number[] = [];
      for (let c = 1; c <= frozen.cols; c++) { lefts.push(left); left += head.cells[c]?.getBoundingClientRect().width ?? 0; }
      for (const tr of [head, ...bodyRows]) {
        for (const cell of tr.cells) {
          const col = Number(cell.dataset.col);
          if (col >= 1 && col <= frozen.cols) cell.style.left = `${lefts[col - 1]}px`;
        }
      }
    }
  });

  if (sheets === 'loading') return <Empty>Reading the workbook…</Empty>;
  if (sheets === 'failed') return <Notice>This spreadsheet could not be read. Download it to open it.</Notice>;
  if (sheets.length === 0 || !view) return <p className="muted">The workbook is empty.</p>;
  const columns = Array.from({ length: view.width }, (_, i) => i + 1);
  const styles = model?.styles;
  const lookOf = (index: number): CellStyle => styles?.cells[index] ?? styles?.cells[0] ?? { numFmt: 'General' };
  const widthOf = (col: number): number => {
    const set = modelSheet?.columns.find((c) => col >= c.min && col <= c.max);
    return set ? Math.max(12, Math.round(set.width * CHAR_PX)) : DEFAULT_COL_PX;
  };
  const merges = mergeMap(modelSheet, view.rows, view.width);
  // Did buddi work out anything shown on this sheet?
  const calculated = evaluation !== null && modelSheet !== undefined
    && ((evaluation.values.get(modelSheet.name)?.size ?? 0) > 0 || (evaluation.uncomputed.get(modelSheet.name)?.size ?? 0) > 0);
  const valueless = modelSheet !== undefined && [...modelSheet.cells.values()].some((c) => c.formula !== undefined && !c.hasValue);

  return (
    <div className="office-xlsx" data-testid="office-xlsx">
      {sheets.length > 1 ? (
        <div className="office-xlsx-tabs" role="tablist" aria-label="Sheets">
          {sheets.map((s, i) => (
            <button key={`${i}-${s.name}`} type="button" role="tab" className="ui-tab" aria-selected={i === at} onClick={() => setAt(i)}>{s.name}</button>
          ))}
        </div>
      ) : null}
      <div className="ui-table-wrap office-xlsx-grid" role="tabpanel" aria-label={sheet!.name}>
        {view.rows === 0 || view.width === 0 ? <p className="muted">This sheet is empty.</p> : (
          <table className="ui-table office-xlsx-table" ref={table} style={{ width: `${columns.reduce((sum, c) => sum + widthOf(c), ROW_NUMBER_PX)}px` }}>
            <colgroup>
              <col style={{ width: `${ROW_NUMBER_PX}px` }} />
              {columns.map((c) => <col key={c} style={{ width: `${widthOf(c)}px` }} />)}
            </colgroup>
            <thead>
              <tr>
                <th aria-hidden="true" data-col={0} />
                {columns.map((c) => <th key={c} scope="col" data-col={c} data-frozen={c <= frozen.cols ? 'col' : undefined}>{columnName(c)}</th>)}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: view.rows }, (_, r) => r + 1).map((row) => {
                const height = modelSheet?.rowHeights.get(row);
                return (
                  <tr key={row} data-frozen={row <= frozen.rows ? 'row' : undefined} style={height ? { height: `${Math.round(height * 4 / 3)}px` } : undefined}>
                    <th scope="row" className="office-xlsx-row" data-col={0}>{row}</th>
                    {columns.map((col) => {
                      const key = cellKey(row, col);
                      if (merges.covered.has(key)) return null;
                      const span = merges.spans.get(key);
                      const modelCell = modelSheet?.cells.get(key);
                      const look = { ...lookOf(modelCell?.style ?? 0), ...conditional.get(key) };
                      const raw = sheet!.rows[row - 1]?.[col - 1] ?? null;
                      let text: string;
                      let numberColor: string | undefined;
                      let numeric = typeof raw === 'number';
                      if (modelCell && modelSheet && modelCell.formula !== undefined && !modelCell.hasValue) {
                        const value = valueOf(evaluation, modelSheet, modelCell);
                        const shown = formatCell(value, look.numFmt, { date1904: model!.date1904 });
                        text = shown.text;
                        numberColor = shown.color;
                        numeric = typeof value === 'number';
                      } else if (modelCell && typeof modelCell.value === 'number' && look.numFmt !== 'General') {
                        const shown = formatCell(modelCell.value, look.numFmt, { date1904: model!.date1904 });
                        text = shown.text;
                        numberColor = shown.color;
                        numeric = true;
                      } else {
                        text = cellText(raw);
                      }
                      return (
                        <td
                          key={col}
                          data-col={col}
                          data-frozen={col <= frozen.cols ? 'col' : undefined}
                          className={numeric ? 'num' : undefined}
                          style={cellStyle(look, numberColor)}
                          {...(span ? { rowSpan: span.rowSpan, colSpan: span.colSpan } : {})}
                        >{text}</td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {view.moreRows || view.moreCols ? (
        <p className="muted">Showing the first {view.moreRows ? `${SHEET_PREVIEW_ROWS.toLocaleString()} rows` : ''}{view.moreRows && view.moreCols ? ' and ' : ''}{view.moreCols ? `${SHEET_PREVIEW_COLS} columns` : ''} of this sheet. The download has the whole file.</p>
      ) : null}
      {computed === 'too-large' && valueless ? <p className="muted office-xlsx-note">This workbook is too large for buddi to calculate here: its formulas without saved values are left blank. Excel calculates them when it opens the file.</p> : null}
      {calculated ? <p className="muted office-xlsx-note">Totals calculated by buddi: the file has formulas without saved values. Excel recalculates them when it opens the file.</p> : null}
    </div>
  );
}
