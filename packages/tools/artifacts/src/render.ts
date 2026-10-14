/**
 * What a composed document looks like, said in words for the agent that
 * composed it (docs/files.md, "Composed documents"): the page or slide size,
 * the fonts it uses, its outline, how many pages it will run to, and — for a
 * deck — where text is likely to spill out of its box or a shape off the
 * slide; for a workbook, each sheet's shape, header, frozen panes, formats
 * and its formulas with their values. A cheap pass over the package's XML
 * with fflate (MIT) — a workbook's through `@buddi/core/sheet` — beside the
 * extractor's text; nothing is drawn. Pure, so it runs in the extractor's
 * worker (`office-worker.ts`) and, from source, in the caller's thread.
 */
import { address, columnName, formatCell, isSheetError, valueOf, type Evaluation, type WorkbookModel } from '@buddi/core/plugin';
import { unzipSync } from 'fflate';
import { officeText } from './office-text.js';

const EMU_PER_INCH = 914_400;
const TWIPS_PER_INCH = 1_440;
/** How much of a document's text the summary repeats. */
const TEXT_CHARS = 2_000;

export interface DocxRender {
  kind: 'docx';
  page: { width: string; height: string; orientation: 'portrait' | 'landscape'; margins: string; name?: string };
  fonts: string[];
  /** Body text size, in points, as the document's defaults say. */
  bodySize?: number;
  outline: Array<{ level: number; text: string }>;
  pages: { estimated: number; explicitBreaks: number; sections: number };
  tables: Array<{ rows: number; columns: number }>;
  images: number;
  header: boolean;
  footer: boolean;
  text: string;
}

export interface SlideRender {
  n: number;
  title: string | null;
  text: string;
  shapes: number;
  images: number;
}

export interface PptxRender {
  kind: 'pptx';
  slide: { width: string; height: string; name?: string };
  fonts: string[];
  slides: SlideRender[];
  warnings: string[];
}

export interface XlsxSheetRender {
  name: string;
  /** The last row and column holding a value or a formula. */
  rows: number;
  cols: number;
  /** The first row's values, as shown. */
  header: string[];
  frozen: { rows: number; cols: number };
  /** Columns given a width, in characters, by letter. */
  widths: Record<string, number>;
  counts: { styledCells: number; formulas: number; merges: number; conditionalRules: number };
  /** Every number format the sheet's cells use, General left out. */
  numberFormats: string[];
  /** The first 40 formulas with their values as the sheet shows them: read the totals back. */
  formulas: Array<{ cell: string; formula: string; value: string }>;
  /** Formulas whose value is an error, or that buddi could not compute (they have no value in the file). */
  errors: Array<{ cell: string; formula: string; error: string }>;
}

export interface XlsxRender {
  kind: 'xlsx';
  sheets: XlsxSheetRender[];
}

export type OfficeRender = DocxRender | PptxRender | XlsxRender;

const SHEET_LISTED = 40;

/** A workbook said in words, from what the sheet engine read and computed. */
export function xlsxRender(workbook: WorkbookModel, evaluation: Evaluation | null): XlsxRender {
  const style = (index: number) => workbook.styles.cells[index] ?? workbook.styles.cells[0]!;
  const shown = (value: Parameters<typeof formatCell>[0], format: string): string => formatCell(value, format, { date1904: workbook.date1904 }).text;
  const sheets = workbook.sheets.map((sheet): XlsxSheetRender => {
    const cells = [...sheet.cells.values()].sort((a, b) => a.row - b.row || a.col - b.col);
    const formats = new Set<string>();
    let styled = 0;
    const formulas: XlsxSheetRender['formulas'] = [];
    const errors: XlsxSheetRender['errors'] = [];
    let formulaCount = 0;
    for (const cell of cells) {
      const look = style(cell.style);
      if (cell.style !== 0) styled += 1;
      if (look.numFmt !== 'General' && (cell.formula !== undefined || typeof cell.value === 'number')) formats.add(look.numFmt);
      if (cell.formula === undefined) continue;
      formulaCount += 1;
      const value = valueOf(evaluation, sheet, cell);
      const at = address(cell.row, cell.col);
      if (formulas.length < SHEET_LISTED) formulas.push({ cell: at, formula: `=${cell.formula}`, value: shown(value, look.numFmt) });
      const failure = evaluation?.failed.find((f) => f.sheet === sheet.name && f.cell === at);
      if ((failure || isSheetError(value) || (value === null && !cell.hasValue)) && errors.length < SHEET_LISTED) {
        const code = isSheetError(value) ? value.error : failure?.error ?? 'no value';
        errors.push({ cell: at, formula: `=${cell.formula}`, error: failure ? `${code}: ${failure.reason}` : code });
      }
    }
    const header = cells.filter((c) => c.row === 1 && c.col <= 50).map((c) => shown(valueOf(evaluation, sheet, c), style(c.style).numFmt));
    const widths: Record<string, number> = {};
    for (const col of sheet.columns) for (let c = col.min; c <= Math.min(col.max, 50); c++) widths[columnName(c)] = col.width;
    return {
      name: sheet.name,
      rows: sheet.maxRow,
      cols: sheet.maxCol,
      header,
      frozen: sheet.frozen,
      widths,
      counts: { styledCells: styled, formulas: formulaCount, merges: sheet.merges.length, conditionalRules: sheet.conditional.reduce((n, b) => n + b.rules.length, 0) },
      numberFormats: [...formats].sort(),
      formulas,
      errors,
    };
  });
  return { kind: 'xlsx', sheets };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_all, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[code.toLowerCase()] ?? '';
  });
}

const attr = (xml: string, name: string): string | null => {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(xml);
  return match ? match[1]! : null;
};
const inches = (value: number): string => `${(Math.round(value * 100) / 100).toString()} in`;
const short = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);

/** Paper sizes by their inches, the ones a person names. */
function paperName(w: number, h: number): string | undefined {
  const [a, b] = [Math.min(w, h), Math.max(w, h)];
  const near = (x: number, y: number): boolean => Math.abs(x - y) < 0.05;
  if (near(a, 8.5) && near(b, 11)) return 'US Letter';
  if (near(a, 8.27) && near(b, 11.69)) return 'A4';
  if (near(a, 8.5) && near(b, 14)) return 'US Legal';
  if (near(a, 5.83) && near(b, 8.27)) return 'A5';
  return undefined;
}

function unzip(bytes: Buffer, want: (name: string) => boolean): Record<string, string> {
  const parts = unzipSync(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), { filter: (file) => want(file.name) });
  return Object.fromEntries(Object.entries(parts).map(([name, data]) => [name, Buffer.from(data).toString('utf8')]));
}

/** A composed file, said in words. The package's limits are checked before it is called. */
export async function officeRender(bytes: Buffer, kind: 'docx' | 'pptx'): Promise<OfficeRender> {
  return kind === 'docx' ? docxRender(bytes) : pptxRender(bytes);
}

async function docxRender(bytes: Buffer): Promise<DocxRender> {
  const parts = unzip(bytes, (name) => name === 'word/document.xml' || name === 'word/styles.xml' || /^word\/(header|footer)\d*\.xml$/.test(name));
  const doc = parts['word/document.xml'] ?? '';
  const styles = parts['word/styles.xml'] ?? '';
  const sect = [...doc.matchAll(/<w:sectPr[\s\S]*?<\/w:sectPr>/g)].map((m) => m[0]);
  const last = sect.at(-1) ?? '';
  const pgSz = /<w:pgSz\b[^>]*>/.exec(last)?.[0] ?? '';
  const pgMar = /<w:pgMar\b[^>]*>/.exec(last)?.[0] ?? '';
  const width = Number(attr(pgSz, 'w:w') ?? 11_906) / TWIPS_PER_INCH;
  const height = Number(attr(pgSz, 'w:h') ?? 16_838) / TWIPS_PER_INCH;
  const margin = (side: string): number => Number(attr(pgMar, `w:${side}`) ?? TWIPS_PER_INCH) / TWIPS_PER_INCH;
  const margins = { top: margin('top'), right: margin('right'), bottom: margin('bottom'), left: margin('left') };
  const sameMargins = new Set(Object.values(margins).map((m) => m.toFixed(2))).size === 1;

  const fonts = new Set<string>();
  for (const xml of [doc, styles]) {
    for (const match of xml.matchAll(/<w:rFonts\b[^>]*>/g)) {
      for (const which of ['w:ascii', 'w:hAnsi']) {
        const font = attr(match[0], which);
        if (font) fonts.add(decode(font));
      }
    }
  }
  const defaults = /<w:rPrDefault>[\s\S]*?<\/w:rPrDefault>/.exec(styles)?.[0] ?? '';
  const sz = attr(/<w:sz\b[^>]*>/.exec(defaults)?.[0] ?? '', 'w:val');
  const bodySize = sz ? Number(sz) / 2 : undefined;

  // Which style ids are headings: their name ("heading 1", "Title"), or their outline level.
  const headingLevel = new Map<string, number>();
  for (const style of styles.matchAll(/<w:style\b[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const name = (/<w:name w:val="([^"]+)"/.exec(style[2]!)?.[1] ?? '').toLowerCase();
    const outline = /<w:outlineLvl w:val="(\d)"/.exec(style[2]!)?.[1];
    const heading = /^heading (\d)$/.exec(name)?.[1];
    if (name === 'title') headingLevel.set(style[1]!, 0);
    else if (heading) headingLevel.set(style[1]!, Number(heading));
    else if (outline !== undefined) headingLevel.set(style[1]!, Number(outline) + 1);
  }
  const outline: Array<{ level: number; text: string }> = [];
  let chars = 0;
  let paragraphs = 0;
  for (const paragraph of doc.matchAll(/<w:p[\s>][\s\S]*?<\/w:p>/g)) {
    const xml = paragraph[0];
    const text = [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((t) => decode(t[1]!)).join('');
    chars += text.length;
    paragraphs += 1;
    const style = /<w:pStyle w:val="([^"]+)"/.exec(xml)?.[1];
    const outlineLvl = /<w:outlineLvl w:val="(\d)"/.exec(xml)?.[1];
    const level = style !== undefined && headingLevel.has(style) ? headingLevel.get(style)! : style && /^Heading(\d)$/i.test(style) ? Number(/\d/.exec(style)![0]) : style === 'Title' ? 0 : outlineLvl !== undefined ? Number(outlineLvl) + 1 : null;
    if (level !== null && text.trim() !== '' && outline.length < 60) outline.push({ level, text: short(text.trim(), 120) });
  }
  const tables = [...doc.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map((t) => {
    const rows = [...t[0].matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)];
    const columns = rows.reduce((most, row) => Math.max(most, (row[0].match(/<w:tc[\s>]/g) ?? []).length), 0);
    return { rows: rows.length, columns };
  });
  const explicitBreaks = (doc.match(/<w:br\b[^>]*w:type="page"/g) ?? []).length + (doc.match(/<w:pageBreakBefore(?:\s|\/)/g) ?? []).length;
  // A rough page count: the body's lines at the body size, plus the breaks the program asked for.
  const size = bodySize ?? 11;
  const usableWidth = Math.max(1, width - margins.left - margins.right) * 72;
  const usableHeight = Math.max(1, height - margins.top - margins.bottom) * 72;
  const perLine = Math.max(1, Math.floor(usableWidth / (size * 0.5)));
  const linesPerPage = Math.max(1, Math.floor(usableHeight / (size * 1.35)));
  const tableRows = tables.reduce((n, t) => n + t.rows, 0);
  const lines = Math.ceil(chars / perLine) + paragraphs + tableRows;
  const estimated = Math.max(1, Math.ceil(lines / linesPerPage), explicitBreaks + Math.max(1, sect.length));

  const { text } = await officeText(bytes, 'docx');
  const paperish = paperName(width, height);
  return {
    kind: 'docx',
    page: {
      width: inches(width), height: inches(height), orientation: width > height ? 'landscape' : 'portrait',
      margins: sameMargins ? inches(margins.top) : `${inches(margins.top)} top, ${inches(margins.right)} right, ${inches(margins.bottom)} bottom, ${inches(margins.left)} left`,
      ...(paperish ? { name: paperish } : {}),
    },
    fonts: [...fonts].sort(),
    ...(bodySize === undefined ? {} : { bodySize }),
    outline,
    pages: { estimated, explicitBreaks, sections: Math.max(1, sect.length) },
    tables,
    images: (doc.match(/<w:drawing>/g) ?? []).length,
    header: Object.keys(parts).some((name) => name.startsWith('word/header')),
    footer: Object.keys(parts).some((name) => name.startsWith('word/footer')),
    text: short(text.trim(), TEXT_CHARS),
  };
}

interface Box { x: number; y: number; w: number; h: number }

function pptxRender(bytes: Buffer): PptxRender {
  const SLIDE = /^ppt\/slides\/slide(\d+)\.xml$/;
  const parts = unzip(bytes, (name) => name === 'ppt/presentation.xml' || SLIDE.test(name));
  const presentation = parts['ppt/presentation.xml'] ?? '';
  const sldSz = /<p:sldSz\b[^>]*>/.exec(presentation)?.[0] ?? '';
  const slideW = Number(attr(sldSz, 'cx') ?? 9_144_000);
  const slideH = Number(attr(sldSz, 'cy') ?? 6_858_000);
  const ratio = slideW / slideH;
  const name = Math.abs(ratio - 16 / 9) < 0.02 ? '16:9' : Math.abs(ratio - 4 / 3) < 0.02 ? '4:3' : Math.abs(ratio - 16 / 10) < 0.02 ? '16:10' : undefined;
  const fonts = new Set<string>();
  const warnings: string[] = [];
  const order = Object.keys(parts).filter((p) => SLIDE.test(p)).map((p) => ({ p, n: Number(SLIDE.exec(p)![1]) })).sort((a, b) => a.n - b.n);
  const slides = order.map(({ p }, index): SlideRender => {
    const xml = parts[p]!;
    const n = index + 1;
    for (const font of xml.matchAll(/<a:(?:latin|ea|cs) typeface="([^"]+)"/g)) if (!font[1]!.startsWith('+')) fonts.add(decode(font[1]!));
    const shapes = [...xml.matchAll(/<p:(sp|pic|graphicFrame|cxnSp)>([\s\S]*?)<\/p:\1>/g)];
    let title: string | null = null;
    let biggest = { size: 0, text: '' };
    const texts: string[] = [];
    for (const shape of shapes) {
      const body = shape[2]!;
      const off = /<a:off x="(-?\d+)" y="(-?\d+)"\s*\/>/.exec(body);
      const ext = /<a:ext cx="(\d+)" cy="(\d+)"\s*\/>/.exec(body);
      const box: Box | null = off && ext ? { x: Number(off[1]), y: Number(off[2]), w: Number(ext[1]), h: Number(ext[2]) } : null;
      const paragraphs = [...body.matchAll(/<a:p>([\s\S]*?)<\/a:p>|<a:p\s[^>]*>([\s\S]*?)<\/a:p>/g)].map((m) => {
        const inner = m[1] ?? m[2] ?? '';
        const size = Number(/<a:(?:rPr|defRPr|endParaRPr)\b[^>]*\bsz="(\d+)"/.exec(inner)?.[1] ?? 0) / 100;
        return { text: [...inner.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decode(t[1]!)).join(''), size };
      });
      const text = paragraphs.map((q) => q.text).filter((t) => t.trim() !== '').join('\n');
      const label = text.trim() === '' ? (shape[1] === 'pic' ? 'an image' : 'a shape') : `"${short(text.replace(/\s+/g, ' ').trim(), 40)}"`;
      if (text.trim() !== '') texts.push(text);
      if (/<p:ph\b[^>]*type="(?:title|ctrTitle)"/.test(body) && text.trim() !== '') title = text.trim();
      const top = paragraphs.reduce((m, q) => Math.max(m, q.size), 0);
      if (top > biggest.size && text.trim() !== '') biggest = { size: top, text: text.trim() };
      // The slide number, footer and date fields are the master's, sized by it.
      if (!box || /<p:ph\b[^>]*type="(?:sldNum|ftr|dt)"/.test(body)) continue;
      const tolerance = EMU_PER_INCH * 0.02;
      if (box.x < -tolerance || box.y < -tolerance || box.x + box.w > slideW + tolerance || box.y + box.h > slideH + tolerance) {
        warnings.push(`slide ${n}: ${label} reaches past the slide's edge (${inches(box.x / EMU_PER_INCH)}, ${inches(box.y / EMU_PER_INCH)}, ${inches(box.w / EMU_PER_INCH)} × ${inches(box.h / EMU_PER_INCH)} on a ${inches(slideW / EMU_PER_INCH)} × ${inches(slideH / EMU_PER_INCH)} slide)`);
      }
      if (text.trim() === '') continue;
      // Text past its box: lines from characters × size against the box, insets taken off.
      const bodyPr = /<a:bodyPr\b[^>]*>/.exec(body)?.[0] ?? '';
      const inset = (side: string, fallback: number): number => Number(attr(bodyPr, side) ?? fallback);
      const innerW = Math.max(1, box.w - inset('lIns', 91_440) - inset('rIns', 91_440)) / EMU_PER_INCH * 72;
      const innerH = Math.max(1, box.h - inset('tIns', 45_720) - inset('bIns', 45_720)) / EMU_PER_INCH * 72;
      const needed = paragraphs.reduce((sum, q) => {
        const size = q.size || 18;
        const perLine = Math.max(1, Math.floor(innerW / (size * 0.52)));
        return sum + Math.max(1, Math.ceil(q.text.length / perLine)) * size * 1.2;
      }, 0);
      if (needed > innerH * 1.1) {
        const fits = /<a:normAutofit/.test(body) ? ' (it is set to shrink to fit, which PowerPoint may do, small)' : '';
        warnings.push(`slide ${n}: ${label} likely overflows its box: it needs about ${inches(needed / 72)} of height, the box gives ${inches(innerH / 72)}${fits}. Shorten it, make the box taller or the type smaller, or split the slide.`);
      }
    }
    return {
      n,
      title: title ?? (biggest.text === '' ? null : short(biggest.text.replace(/\s+/g, ' '), 100)),
      text: short(texts.join(' | ').replace(/\s+/g, ' '), 300),
      shapes: shapes.length,
      images: shapes.filter((s) => s[1] === 'pic').length,
    };
  });
  return {
    kind: 'pptx',
    slide: { width: inches(slideW / EMU_PER_INCH), height: inches(slideH / EMU_PER_INCH), ...(name ? { name } : {}) },
    fonts: [...fonts].sort(),
    slides,
    warnings: warnings.slice(0, 40),
  };
}
