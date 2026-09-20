/**
 * One preview for a file, wherever it is opened: the canvas from a chat, or
 * the Files library. The same CSV looks the same in both, because it is drawn
 * by the same code from the same route.
 *
 * Previews are honest about what they are. An image is the image; a PDF is
 * the browser's own viewer over the preview route; text, code and tables are
 * fetched as plain text and drawn as text — a table is parsed here, quoted
 * fields and all, never evaluated. Anything else says so and offers the
 * download. Nothing here fetches off this origin.
 */
import { useEffect, useMemo, useState } from 'react';
import { Empty, Notice } from '../ui';
import { previewUrl, type FileFamily } from './attachments';

export const TEXT_PREVIEW_CHARS = 100_000;
export const TABLE_ROWS = 200;
export const TABLE_COLS = 30;

export interface ArtifactPreviewProps {
  artifactId: string;
  filename: string | null;
  mime: string;
  family: FileFamily;
  /** False when the row remains but the bytes are gone: nothing is fetched. */
  available?: boolean;
}

export function ArtifactPreview({ artifactId, filename, mime, family, available = true }: ArtifactPreviewProps): JSX.Element {
  const [broken, setBroken] = useState(false);
  if (!available) return <Notice>The file is no longer available; its record is kept.</Notice>;
  if (family === 'image' && !broken) {
    return <figure className="file-preview file-preview-image"><img src={previewUrl(artifactId)} alt={filename ?? 'Image'} onError={() => setBroken(true)} /></figure>;
  }
  if (family === 'pdf') {
    return (
      <div className="file-preview file-preview-pdf">
        <object data={previewUrl(artifactId)} type="application/pdf" aria-label={filename ?? 'PDF'}>
          <Notice>Your browser cannot show this PDF here. Download it to open it.</Notice>
        </object>
      </div>
    );
  }
  if (family === 'text' || family === 'code' || family === 'table') return <TextPreview artifactId={artifactId} filename={filename} mime={mime} family={family} />;
  return <Notice>Preview not supported for this kind of file. Download it to open it.</Notice>;
}

function TextPreview({ artifactId, filename, mime, family }: { artifactId: string; filename: string | null; mime: string; family: FileFamily }): JSX.Element {
  const [state, setState] = useState<{ text: string; truncated: boolean } | 'loading' | 'failed'>('loading');
  useEffect(() => {
    let cancelled = false;
    setState('loading');
    fetch(previewUrl(artifactId), { credentials: 'same-origin' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const text = await res.text();
        if (cancelled) return;
        setState({ text: text.slice(0, TEXT_PREVIEW_CHARS), truncated: res.headers.get('X-Preview-Truncated') === '1' || text.length > TEXT_PREVIEW_CHARS });
      })
      .catch(() => { if (!cancelled) setState('failed'); });
    return () => { cancelled = true; };
  }, [artifactId]);
  if (state === 'loading') return <div className="file-preview"><Empty>Loading preview…</Empty></div>;
  if (state === 'failed') return <Notice>The preview could not be loaded. Download the file to open it.</Notice>;
  const isTable = family === 'table' && (/csv|tab-separated/.test(mime) || /\.(csv|tsv)$/i.test(filename ?? ''));
  return (
    <div className="file-preview">
      {isTable ? <CsvTable text={state.text} delimiter={/tab|\.tsv$/i.test(mime + (filename ?? '')) ? '\t' : ','} /> : <pre className="file-preview-text">{state.text}</pre>}
      {state.truncated ? <p className="muted">Showing the first {TEXT_PREVIEW_CHARS.toLocaleString()} characters. The download has the whole file.</p> : null}
    </div>
  );
}

/** A CSV parser that respects quotes and embedded newlines. Cells are data, never evaluated. */
export function parseDelimited(text: string, delimiter: string, maxRows: number, maxCols: number): { rows: string[][]; truncatedRows: boolean; truncatedCols: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let truncatedCols = false;
  let truncatedRows = false;
  const endCell = (): void => { if (row.length < maxCols) row.push(cell); else truncatedCols = true; cell = ''; };
  const endRow = (): void => { endCell(); rows.push(row); row = []; };
  let i = 0;
  for (; i < text.length; i += 1) {
    if (rows.length >= maxRows) {
      // Rows are only "truncated" when there is more input than a blank tail.
      truncatedRows = text.slice(i).trim() !== '';
      break;
    }
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delimiter) { endCell(); continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { endRow(); continue; }
    cell += ch;
  }
  if (rows.length < maxRows && (cell !== '' || row.length > 0)) endRow();
  return { rows, truncatedRows, truncatedCols };
}

function CsvTable({ text, delimiter }: { text: string; delimiter: string }): JSX.Element {
  const parsed = useMemo(() => parseDelimited(text, delimiter, TABLE_ROWS + 1, TABLE_COLS), [text, delimiter]);
  const [head, ...body] = parsed.rows;
  if (!head) return <p className="muted">The file is empty.</p>;
  // As wide as the widest row kept, capped: a ragged file loses no cells.
  const width = Math.min(TABLE_COLS, parsed.rows.reduce((w, r) => Math.max(w, r.length), 0));
  const columns = Array.from({ length: width }, (_, i) => i);
  return (
    <div className="ui-table-wrap file-preview-table">
      <table className="ui-table">
        <thead><tr>{columns.map((i) => <th key={i}>{head[i] ?? ''}</th>)}</tr></thead>
        <tbody>{body.slice(0, TABLE_ROWS).map((r, i) => <tr key={i}>{columns.map((j) => <td key={j}>{r[j] ?? ''}</td>)}</tr>)}</tbody>
      </table>
      {parsed.truncatedRows || parsed.truncatedCols ? (
        <p className="muted">Showing the first {TABLE_ROWS} rows{parsed.truncatedCols ? ` and ${TABLE_COLS} columns` : ''}. The download has the whole file.</p>
      ) : null}
    </div>
  );
}
