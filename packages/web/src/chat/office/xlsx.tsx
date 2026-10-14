/**
 * A workbook as buddi's own table, one tab per sheet: the cells read by
 * read-excel-file (MIT) as values — text, numbers, dates, true/false — and
 * drawn as text, never evaluated. The first 1,000 rows and 50 columns of a
 * sheet are shown, and a sheet with more says so. Charts, styles and number
 * formats are not drawn. Loaded only when a .xlsx is opened.
 */
import { SHEET_PREVIEW_COLS, SHEET_PREVIEW_ROWS, cellText } from '@buddi/core/office-files';
import readExcelFile from 'read-excel-file/browser';
import { useEffect, useMemo, useState } from 'react';
import { Empty, Notice } from '../../ui';
import type { OfficeViewerProps } from '../OfficePreview';

type Cell = string | number | boolean | Date | null;
interface Sheet { name: string; rows: Cell[][] }

/** Column letters, as the spreadsheet names them: A … Z, AA … */
function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

export default function XlsxPreview({ bytes }: OfficeViewerProps): JSX.Element {
  const [sheets, setSheets] = useState<Sheet[] | 'loading' | 'failed'>('loading');
  const [at, setAt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setSheets('loading');
    setAt(0);
    readExcelFile(bytes)
      .then((read) => { if (!cancelled) setSheets(read.map((s) => ({ name: s.sheet, rows: s.data as unknown as Cell[][] }))); })
      .catch(() => { if (!cancelled) setSheets('failed'); });
    return () => { cancelled = true; };
  }, [bytes]);

  const sheet = Array.isArray(sheets) ? sheets[at] : undefined;
  const view = useMemo(() => {
    if (!sheet) return null;
    const rows = sheet.rows.slice(0, SHEET_PREVIEW_ROWS);
    const widest = sheet.rows.reduce((w, r) => Math.max(w, r.length), 0);
    return { rows, width: Math.min(widest, SHEET_PREVIEW_COLS), moreRows: sheet.rows.length > SHEET_PREVIEW_ROWS, moreCols: widest > SHEET_PREVIEW_COLS };
  }, [sheet]);

  if (sheets === 'loading') return <Empty>Reading the workbook…</Empty>;
  if (sheets === 'failed') return <Notice>This spreadsheet could not be read. Download it to open it.</Notice>;
  if (sheets.length === 0 || !view) return <p className="muted">The workbook is empty.</p>;
  const columns = Array.from({ length: view.width }, (_, i) => i);
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
        {view.rows.length === 0 || view.width === 0 ? <p className="muted">This sheet is empty.</p> : (
          <table className="ui-table">
            <thead><tr><th aria-hidden="true" />{columns.map((i) => <th key={i} scope="col">{columnName(i)}</th>)}</tr></thead>
            <tbody>
              {view.rows.map((row, r) => (
                <tr key={r}>
                  <th scope="row" className="office-xlsx-row">{r + 1}</th>
                  {columns.map((c) => {
                    const value = row[c];
                    return <td key={c} className={typeof value === 'number' ? 'num' : undefined}>{cellText(value)}</td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {view.moreRows || view.moreCols ? (
        <p className="muted">Showing the first {view.moreRows ? `${SHEET_PREVIEW_ROWS.toLocaleString()} rows` : ''}{view.moreRows && view.moreCols ? ' and ' : ''}{view.moreCols ? `${SHEET_PREVIEW_COLS} columns` : ''} of this sheet. The download has the whole file.</p>
      ) : null}
    </div>
  );
}
