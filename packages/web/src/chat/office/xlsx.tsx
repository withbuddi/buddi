/**
 * A workbook as buddi's own table, one tab per sheet. The cells — values,
 * shown through their number formats — and the look are read by core's
 * sheet engine (`@buddi/core/sheet`), off the page's thread, in the Web
 * Worker `sheet-job.ts` ends if it runs too long. It keeps cells sparsely,
 * so a workbook with one cell in its far corner is one cell, and the table
 * draws only the shown part. The look: bold and italic, font
 * and fill colours, borders, alignment, wrap, column widths, row heights,
 * merged cells, the frozen header and columns, number formats and the
 * conditional rules that compare a cell or test a formula. A formula the
 * file carries no value for (openpyxl writes none) is computed there too,
 * and the footer says so; a cell it cannot compute shows its error. The owner's bytes are only read. Fonts stay the table's.
 * The first 1,000 rows and 50 columns of a sheet are shown, and a sheet
 * with more says so. Loaded only when a .xlsx is opened.
 */
import { SHEET_PREVIEW_COLS, SHEET_PREVIEW_ROWS } from '@buddi/core/office-files';
import {
  cellKey, columnName, conditionalStyles, formatCell, valueOf,
  type BorderEdge, type CellStyle, type SheetModel, type WorkbookModel,
} from '@buddi/core/sheet';
import { confirmUpdate } from '../../shell/freshness';
import { runSheetJob, type SheetComputed } from './sheet-job';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Empty, Notice } from '../../ui';
import type { OfficeViewerProps } from '../OfficePreview';

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
  const [model, setModel] = useState<WorkbookModel | 'loading' | 'failed' | 'too-large'>('loading');
  const [computed, setComputed] = useState<SheetComputed | 'too-large' | null>(null);
  const [at, setAt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setModel('loading');
    setComputed(null);
    setAt(0);
    // Everything off this thread: the page only draws what the worker read.
    const job = runSheetJob(bytes);
    void job.model.then(async (read) => {
      if (cancelled) return;
      if (read) { setModel(read); return; }
      const why = await job.computed;
      if (cancelled) return;
      // The sheet engine never started: the shell asks whether an update is why.
      if (why === 'unstarted') void confirmUpdate();
      setModel(why === 'too-large' ? 'too-large' : 'failed');
    });
    void job.computed.then((out) => {
      if (cancelled || out === 'unstarted' || out === 'failed') return;
      setComputed(out);
    });
    return () => { cancelled = true; job.cancel(); };
  }, [bytes]);

  const workbook = typeof model === 'object' ? model : null;
  const modelSheet = workbook?.sheets[at];
  const view = useMemo(() => {
    if (!modelSheet) return null;
    const totalRows = modelSheet.maxRow;
    const totalCols = modelSheet.maxCol;
    return {
      rows: Math.min(totalRows, SHEET_PREVIEW_ROWS),
      width: Math.min(totalCols, SHEET_PREVIEW_COLS),
      moreRows: totalRows > SHEET_PREVIEW_ROWS,
      moreCols: totalCols > SHEET_PREVIEW_COLS,
    };
  }, [modelSheet]);

  const evaluation = computed !== null && computed !== 'too-large' ? computed.evaluation : null;
  const sheetIndex = at;
  const conditional = useMemo(() => {
    if (!workbook || !modelSheet || !view || modelSheet.conditional.length === 0) return new Map<number, Partial<CellStyle>>();
    if (computed !== null && computed !== 'too-large') return computed.conditional[sheetIndex] ?? new Map<number, Partial<CellStyle>>();
    // Until the worker's colours come (or if it was ended): the rules that compare with a plain number or text.
    const valueAt = (r: number, c: number) => {
      const cell = modelSheet.cells.get(cellKey(r, c));
      return cell ? valueOf(null, modelSheet, cell) : null;
    };
    return conditionalStyles(workbook, modelSheet, { r1: 1, c1: 1, r2: view.rows, c2: view.width }, valueAt, null);
  }, [workbook, modelSheet, view, computed, sheetIndex]);

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

  if (model === 'loading') return <Empty>Reading the workbook…</Empty>;
  if (model === 'too-large') return <Notice>This spreadsheet is too large to preview here. Download it to open it.</Notice>;
  if (model === 'failed') return <Notice>This spreadsheet could not be read. Download it to open it.</Notice>;
  const sheets = model.sheets;
  if (sheets.length === 0 || !view || !modelSheet) return <p className="muted">The workbook is empty.</p>;
  const columns = Array.from({ length: view.width }, (_, i) => i + 1);
  const styles = model.styles;
  const lookOf = (index: number): CellStyle => styles?.cells[index] ?? styles?.cells[0] ?? { numFmt: 'General' };
  const widthOf = (col: number): number => {
    const set = modelSheet.columns.find((c) => col >= c.min && col <= c.max);
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
      <div className="ui-table-wrap office-xlsx-grid" role="tabpanel" aria-label={modelSheet.name}>
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
                const height = modelSheet.rowHeights.get(row);
                return (
                  <tr key={row} data-frozen={row <= frozen.rows ? 'row' : undefined} style={height ? { height: `${Math.round(height * 4 / 3)}px` } : undefined}>
                    <th scope="row" className="office-xlsx-row" data-col={0}>{row}</th>
                    {columns.map((col) => {
                      const key = cellKey(row, col);
                      if (merges.covered.has(key)) return null;
                      const span = merges.spans.get(key);
                      const modelCell = modelSheet.cells.get(key);
                      const look = { ...lookOf(modelCell?.style ?? 0), ...conditional.get(key) };
                      // The file's value, or buddi's for a formula saved without one, as its number format shows it.
                      const value = modelCell ? valueOf(evaluation, modelSheet, modelCell) : null;
                      const shown = formatCell(value, look.numFmt, { date1904: model.date1904 });
                      const text = shown.text;
                      const numberColor = shown.color;
                      const numeric = typeof value === 'number';
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
