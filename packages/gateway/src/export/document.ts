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
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IRunOptions,
  type ParagraphChild,
} from 'docx';
import writeExcelFile from 'write-excel-file/node';
import { parseMarkdown, plain, type Block, type Run } from './markdown.js';

/** What a stored file can be downloaded as. */
export type ExportFormat = 'md' | 'pdf' | 'docx' | 'csv' | 'xlsx';

export const EXPORT_MIME: Record<ExportFormat, string> = {
  md: 'text/markdown; charset=utf-8',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  csv: 'text/csv; charset=utf-8',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** The largest source a conversion takes; a bigger file is downloaded as it is. */
export const MAX_EXPORT_SOURCE_BYTES = 2 * 1024 * 1024;

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

function docxRuns(runs: readonly Run[]): ParagraphChild[] {
  return runs.map((run) => {
    const options: IRunOptions = {
      text: run.text,
      ...(run.breakBefore ? { break: 1 } : {}),
      ...(run.bold ? { bold: true } : {}),
      ...(run.italic ? { italics: true } : {}),
      ...(run.strike ? { strike: true } : {}),
      ...(run.code ? { font: 'Consolas', shading: { type: ShadingType.CLEAR, fill: 'F6F8FA', color: 'auto' } } : {}),
      ...(run.link ? { style: 'Hyperlink' } : {}),
    };
    const text = new TextRun(options);
    return run.link ? new ExternalHyperlink({ link: run.link, children: [text] }) : text;
  });
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];
const ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT } as const;
const CELL_BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'D0D7DE' };

/** Each ordered list restarts its numbering: one numbering instance per list. */
interface DocxState { ordered: number }

function docxBlocks(blocks: readonly Block[], state: DocxState, level = 0, quote = false): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  const indent = quote ? { indent: { left: 400 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'D0D7DE', space: 8 } } } : {};
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        out.push(new Paragraph({ heading: HEADINGS[block.depth - 1], children: docxRuns(block.runs) }));
        break;
      case 'paragraph':
        out.push(new Paragraph({ children: docxRuns(block.runs), ...indent }));
        break;
      case 'list': {
        const instance = block.ordered ? ++state.ordered : 0;
        for (const item of block.items) {
          const box = item.checked === undefined ? [] : [new TextRun({ text: item.checked ? '☑ ' : '☐ ' })];
          out.push(new Paragraph({
            children: [...box, ...docxRuns(item.runs)],
            numbering: block.ordered ? { reference: 'ordered', level: Math.min(level, 8), instance } : { reference: 'bullets', level: Math.min(level, 8) },
          }));
          out.push(...docxBlocks(item.children, state, level + 1, quote));
        }
        break;
      }
      case 'table': {
        const columns = block.header.length;
        const row = (cells: readonly Run[][], header: boolean): TableRow => new TableRow({
          tableHeader: header,
          children: Array.from({ length: columns }, (_, i) => new TableCell({
            borders: { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER },
            ...(header ? { shading: { type: ShadingType.CLEAR, fill: 'F6F8FA', color: 'auto' } } : {}),
            children: [new Paragraph({
              alignment: ALIGN[block.align[i] ?? 'left'],
              children: docxRuns((cells[i] ?? []).map((r) => (header ? { ...r, bold: true } : r))),
            })],
          })),
        });
        out.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [row(block.header, true), ...block.rows.map((r) => row(r, false))] }));
        out.push(new Paragraph({ children: [] }));
        break;
      }
      case 'code':
        out.push(new Paragraph({
          shading: { type: ShadingType.CLEAR, fill: 'F6F8FA', color: 'auto' },
          children: block.text.split('\n').map((line, i) => new TextRun({ text: line, font: 'Consolas', size: 19, ...(i > 0 ? { break: 1 } : {}) })),
        }));
        break;
      case 'quote':
        out.push(...docxBlocks(block.blocks, state, level, true));
        break;
      case 'rule':
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D0D7DE', space: 1 } }, children: [] }));
        break;
    }
  }
  return out;
}

/** A Markdown document as a Word file, with Word's own heading and list styles. */
export async function markdownToDocx(markdown: string, filename: string | null): Promise<Buffer> {
  const blocks = parseMarkdown(markdown);
  const levels = (format: (typeof LevelFormat)[keyof typeof LevelFormat], text: (i: number) => string) =>
    Array.from({ length: 9 }, (_, i) => ({ level: i, format, text: text(i), alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (i + 1), hanging: 360 } } } }));
  const doc = new Document({
    creator: 'buddi',
    title: documentTitle(blocks, filename),
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: {
      config: [
        { reference: 'bullets', levels: levels(LevelFormat.BULLET, (i) => ['•', '◦', '▪'][i % 3]!) },
        { reference: 'ordered', levels: levels(LevelFormat.DECIMAL, (i) => `%${i + 1}.`) },
      ],
    },
    sections: [{ children: docxBlocks(blocks, { ordered: 0 }) }],
  });
  return Packer.toBuffer(doc);
}

/* ------------------------------------------------------------------ Tables */

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. Ragged rows are padded. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.replace(/^﻿/, '');
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!;
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  const width = Math.max(0, ...rows.map((r) => r.length));
  return rows.map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill('')] : r));
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
  const widths = (rows[0] ?? []).map((_, c) => ({ width: Math.min(60, Math.max(8, ...rows.slice(0, 500).map((row) => (row[c] ?? '').length + 2))) }));
  const sheet = exportName(filename, 'xlsx').replace(/\.xlsx$/, '').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31).trim() || 'Sheet1';
  const out = await writeExcelFile(sheetData as any, { columns: widths, sheet, stickyRowsCount: rows.length > 1 ? 1 : 0 } as any).toBuffer();
  return Buffer.from(out);
}

/**
 * The conversion the download route runs. `null` when the file does not offer
 * that format; the stored format comes back as the stored bytes.
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
