/**
 * Turning a document in Files into the format the owner asked for.
 *
 * An agent writes Markdown or a CSV (`artifacts.write`); buddi, not the
 * model, makes the PDF, the Word file and the spreadsheet, here, in pure JS:
 *
 *  - PDF: `pdfmake` (MIT) over pdfkit, with the Roboto it ships (Apache-2.0)
 *    and the built-in Courier for code. No headless browser.
 *  - Word: `docx` (MIT).
 *  - Excel: `write-excel-file` (MIT, fflate only). Not SheetJS: its npm
 *    package is frozen at a vulnerable 0.18 and the maintained one is only on
 *    its own CDN.
 *
 * Every writer reads the same `parseMarkdown` blocks, and nothing here reaches
 * the network or the disk beyond pdfmake's own font files.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import writeExcelFile from 'write-excel-file/node';
import { parseMarkdown, plain, type Block, type Run } from './markdown.js';

export { DocumentTooComplex } from './markdown.js';

/** What a stored file can be downloaded as. */
export type ExportFormat = 'md' | 'pdf' | 'docx' | 'csv' | 'xlsx';

export const EXPORT_MIME: Record<ExportFormat, string> = {
  md: 'text/markdown; charset=utf-8',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * The largest source a conversion takes (the most `artifacts.write` saves);
 * a bigger file is downloaded as it is.
 */
export const MAX_EXPORT_SOURCE_BYTES = 512 * 1024;

function bareMime(mime: string): string {
  return mime.toLowerCase().split(';')[0]!.trim();
}

/** What a file is, for exporting: a Markdown document, a table, or neither. */
export function documentFamily(mime: string, filename: string | null): 'markdown' | 'table' | null {
  const m = bareMime(mime);
  const ext = (filename ?? '').toLowerCase().split('.').pop() ?? '';
  if (m === 'text/markdown' || m === 'text/x-markdown' || (m === 'text/plain' && (ext === 'md' || ext === 'markdown'))) return 'markdown';
  if (m === 'text/csv' || (m === 'text/plain' && ext === 'csv')) return 'table';
  return null;
}

/** The formats a file offers, its own first. Empty when it is not a document. */
export function exportFormats(mime: string, filename: string | null): ExportFormat[] {
  const family = documentFamily(mime, filename);
  if (family === 'markdown') return ['md', 'pdf', 'docx'];
  if (family === 'table') return ['csv', 'xlsx'];
  return [];
}

/** The download's name: the stored name with the new extension. */
export function exportName(filename: string | null, format: ExportFormat): string {
  const base = (filename ?? 'document').replace(/\.[a-z0-9]{1,8}$/i, '') || 'document';
  return `${base}.${format}`;
}

/** The title a document carries: its first heading, else its file name. */
export function documentTitle(blocks: readonly Block[], filename: string | null): string {
  const heading = blocks.find((b) => b.type === 'heading');
  if (heading && heading.type === 'heading') return plain(heading.runs).trim();
  return (filename ?? 'Document').replace(/\.[a-z0-9]{1,8}$/i, '');
}

/* ------------------------------------------------------------------ PDF */

const require = createRequire(import.meta.url);
let pdfmakeLoaded: any;

function pdfmake(): any {
  if (pdfmakeLoaded) return pdfmakeLoaded;
  const lib = require('pdfmake');
  const fontDir = path.join(path.dirname(require.resolve('pdfmake/package.json')), 'fonts', 'Roboto');
  lib.setFonts({
    Roboto: {
      normal: path.join(fontDir, 'Roboto-Regular.ttf'),
      bold: path.join(fontDir, 'Roboto-Medium.ttf'),
      italics: path.join(fontDir, 'Roboto-Italic.ttf'),
      bolditalics: path.join(fontDir, 'Roboto-MediumItalic.ttf'),
    },
    Courier: { normal: 'Courier', bold: 'Courier-Bold', italics: 'Courier-Oblique', bolditalics: 'Courier-BoldOblique' },
  });
  // The fonts above are the only files a PDF may read, and it fetches nothing.
  lib.setLocalAccessPolicy((file: string) => path.resolve(file).startsWith(fontDir) || /^Courier/.test(file));
  lib.setUrlAccessPolicy(() => false);
  pdfmakeLoaded = lib;
  return lib;
}

const INK = '#1f2328';
const MUTED = '#59636e';
const RULE = '#d0d7de';
const CODE_BG = '#f6f8fa';
const LINK = '#0b62c4';

/** Courier is a standard PDF font: it has no glyph past Latin-1. */
function courierSafe(text: string): string {
  return text.replace(/[^\u0000-ÿ]/g, (c) => (c === '—' || c === '–' ? '-' : c === '‘' || c === '’' ? "'" : c === '“' || c === '”' ? '"' : '?'));
}

function pdfRuns(runs: readonly Run[]): any[] {
  const out: any[] = [];
  for (const run of runs) {
    if (run.breakBefore) out.push('\n');
    const piece: any = { text: run.code ? courierSafe(run.text) : run.text };
    if (run.bold) piece.bold = true;
    if (run.italic) piece.italics = true;
    if (run.strike) piece.decoration = 'lineThrough';
    if (run.code) Object.assign(piece, { font: 'Courier', background: CODE_BG, fontSize: 9.5 });
    if (run.link) Object.assign(piece, { link: run.link, color: LINK, decoration: 'underline' });
    out.push(piece);
  }
  return out.length > 0 ? out : [''];
}

const HEADING_SIZE = [20, 16, 13.5, 12, 11, 11];

function pdfBlocks(blocks: readonly Block[]): any[] {
  return blocks.map((block): any => {
    switch (block.type) {
      case 'heading':
        return { text: pdfRuns(block.runs), fontSize: HEADING_SIZE[block.depth - 1], bold: true, margin: [0, block.depth <= 2 ? 14 : 10, 0, 6], headlineLevel: block.depth };
      case 'paragraph':
        return { text: pdfRuns(block.runs), margin: [0, 0, 0, 8] };
      case 'list': {
        const items = block.items.map((item) => {
          // Roboto has no ballot-box glyph: a task is marked the way it was typed.
          const head = { text: [...(item.checked === undefined ? [] : [item.checked ? '[x] ' : '[ ] ']), ...pdfRuns(item.runs)] };
          return item.children.length > 0 ? { stack: [head, ...pdfBlocks(item.children)] } : head;
        });
        return block.ordered ? { ol: items, start: block.start, margin: [0, 0, 0, 8] } : { ul: items, margin: [0, 0, 0, 8] };
      }
      case 'table': {
        const alignment = (i: number): string => block.align[i] ?? 'left';
        const body = [
          block.header.map((cell, i) => ({ text: pdfRuns(cell), bold: true, fillColor: CODE_BG, alignment: alignment(i) })),
          ...block.rows.map((row) => block.header.map((_, i) => ({ text: pdfRuns(row[i] ?? []), alignment: alignment(i) }))),
        ];
        return {
          table: { headerRows: 1, widths: block.header.map(() => '*'), body },
          layout: { hLineColor: () => RULE, vLineColor: () => RULE, hLineWidth: () => 0.5, vLineWidth: () => 0.5, paddingTop: () => 3, paddingBottom: () => 3 },
          fontSize: 9.5,
          margin: [0, 2, 0, 10],
        };
      }
      case 'code':
        return {
          table: { widths: ['*'], body: [[{ text: courierSafe(block.text), font: 'Courier', fontSize: 9, preserveLeadingSpaces: true }]] },
          layout: { fillColor: () => CODE_BG, hLineWidth: () => 0, vLineWidth: () => 0, paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 6, paddingBottom: () => 6 },
          margin: [0, 0, 0, 10],
        };
      case 'quote':
        return {
          table: { widths: ['*'], body: [[{ stack: pdfBlocks(block.blocks), color: MUTED }]] },
          layout: { hLineWidth: () => 0, vLineWidth: (i: number) => (i === 0 ? 2 : 0), vLineColor: () => RULE, paddingLeft: () => 10 },
          margin: [0, 0, 0, 8],
        };
      case 'rule':
        return { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 483, y2: 0, lineWidth: 0.5, lineColor: RULE }], margin: [0, 6, 0, 12] };
    }
  });
}

/** A Markdown document as an A4 PDF: Roboto 10.5 pt, page numbers, real links. */
export async function markdownToPdf(markdown: string, filename: string | null): Promise<Buffer> {
  const blocks = parseMarkdown(markdown);
  const doc = pdfmake().createPdf({
    info: { title: documentTitle(blocks, filename), creator: 'buddi', producer: 'buddi' },
    pageSize: 'A4',
    pageMargins: [56, 56, 56, 60],
    defaultStyle: { font: 'Roboto', fontSize: 10.5, lineHeight: 1.3, color: INK },
    content: blocks.length > 0 ? pdfBlocks(blocks) : [{ text: '' }],
    footer: (page: number, pages: number) => (pages > 1 ? { text: `${page} / ${pages}`, alignment: 'center', fontSize: 8, color: MUTED, margin: [0, 24, 0, 0] } : null),
    pageBreakBefore: (node: any, rest: any) => Boolean(node.headlineLevel) && rest.getFollowingNodesOnPage().length === 0,
  });
  const buffer: Buffer | Uint8Array = await doc.getBuffer();
  return Buffer.from(buffer);
}

/* ------------------------------------------------------------------ Word */

/** A Markdown document as a Word file, with Word's own heading and list styles (docx.ts). */
export async function markdownToDocx(markdown: string, filename: string | null): Promise<Buffer> {
  const blocks = parseMarkdown(markdown);
  const { blocksToDocx } = await import('./docx.js');
  return blocksToDocx(blocks, documentTitle(blocks, filename));
}

/* ------------------------------------------------------------------ Tables */

/** Limits on a table buddi converts, checked while it is read: never padded past them. */
export const CSV_LIMITS = { rows: 100_000, columns: 1_000, cells: 300_000 } as const;

/** A table too large to convert; the message says which limit. */
export class TableTooLarge extends Error {
  override name = 'TableTooLarge';
}

/**
 * RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. Ragged rows are
 * padded to the widest — after the rows, columns and padded cells are
 * checked against `limits`, as they are read, so a few kilobytes of ragged
 * rows cannot ask for millions of cells.
 */
export function parseCsv(text: string, limits: { rows: number; columns: number; cells: number } = CSV_LIMITS): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let width = 0;
  const pushField = (): void => {
    row.push(field);
    field = '';
    if (row.length > limits.columns) throw new TableTooLarge(`row ${rows.length + 1} has more than ${limits.columns} columns; too many to convert`);
  };
  const pushRow = (): void => {
    rows.push(row);
    if (row.length > width) width = row.length;
    row = [];
    if (rows.length > limits.rows) throw new TableTooLarge(`the table has more than ${limits.rows} rows; too many to convert`);
    if (rows.length * width > limits.cells) throw new TableTooLarge(`the table has more than ${limits.cells} cells; too many to convert`);
  };
  const source = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') pushField();
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i++;
      pushField(); pushRow();
    } else field += c;
  }
  if (field !== '' || row.length > 0) { pushField(); pushRow(); }
  for (const r of rows) while (r.length < width) r.push('');
  return rows;
}

/** A plain decimal, never a code with a leading zero or a long id that would lose digits. */
const NUMBER = /^-?(0|[1-9]\d{0,14})(\.\d+)?$/;

/** A CSV as an .xlsx: the header bold and frozen, numbers as numbers, columns sized to fit. */
export async function csvToXlsx(csv: string, filename: string | null): Promise<Buffer> {
  const rows = parseCsv(csv);
  const sheetData = rows.map((row, r) => row.map((value) => {
    if (r === 0) return { value, fontWeight: 'bold' as const };
    if (value === '') return null;
    if (NUMBER.test(value)) return { value: Number(value), type: Number };
    return { value, type: String };
  }));
  const sample = rows.slice(0, 500);
  const widths = (rows[0] ?? []).map((_, c) => {
    let widest = 8;
    for (const row of sample) widest = Math.max(widest, (row[c] ?? '').length + 2);
    return { width: Math.min(60, widest) };
  });
  const sheet = exportName(filename, 'xlsx').replace(/\.xlsx$/, '').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim() || 'Sheet1';
  const out = await writeExcelFile(sheetData as any, { columns: widths, sheet, stickyRowsCount: rows.length > 1 ? 1 : 0 } as any).toBuffer();
  return Buffer.from(out);
}

/**
 * One conversion, in this thread. `null` when the file does not offer that
 * format; the stored format comes back as the stored bytes. Throws
 * `DocumentTooComplex` or `TableTooLarge` for what it will not convert.
 * The gateway runs it through `runExport` (convert.ts): in a worker, one at
 * a time, with a memory and a time limit.
 */
export async function exportDocument(
  source: { bytes: Buffer; mime: string; filename: string | null },
  format: ExportFormat,
): Promise<Buffer | null> {
  const formats = exportFormats(source.mime, source.filename);
  if (!formats.includes(format)) return null;
  if (format === formats[0]) return source.bytes;
  const text = source.bytes.toString('utf8');
  switch (format) {
    case 'pdf': return markdownToPdf(text, source.filename);
    case 'docx': return markdownToDocx(text, source.filename);
    case 'xlsx': return csvToXlsx(text, source.filename);
    default: return null;
  }
}
