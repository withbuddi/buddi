/**
 * Reading what is inside an artifact.
 *
 * The agent can usually just *look* at an attachment — images and PDFs go to the
 * model as real multimodal blocks. Extraction exists for the other case: a
 * forty-page bank statement that would cost more to look at than to read, and
 * which the agent wants to search rather than see. So this module is
 * deliberately narrow — text out of PDFs, text files and the three Office
 * formats, dimensions out of images from their header bytes — and it never
 * shells out to a converter.
 *
 * Office files are read in this process, in pure JS: a Word document's text
 * with mammoth (BSD-2-Clause), a spreadsheet's cells with read-excel-file
 * (MIT; each sheet as CSV under a `## Sheet` heading), a presentation's slide
 * text from its slide XML (fflate, MIT; one `## Slide n` per slide). Which
 * files those are is core's one rule (`@buddi/core/plugin`'s `officeKindOf`).
 */
import { officeKindOf, type OfficeKind } from '@buddi/core/plugin';
import { unzipSync } from 'fflate';
import mammoth from 'mammoth';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import readExcelFile from 'read-excel-file/node';
import { toCsv } from './document.js';

/** How much text `artifacts.describe` shows before it truncates. */
export const DESCRIBE_TEXT_CHARS = 20_000;
/** Hard ceiling for `artifacts.text`, so one tool result cannot flood a run. */
export const MAX_TEXT_CHARS = 200_000;
/**
 * What `artifacts.text` actually returns, at most: 16 KB. A 35 KB CSV read
 * whole once made the agent paste it into a reply that overflowed the length
 * limit; a statement goes to the plugin that imports it, not into the chat.
 */
export const TEXT_REPLY_BYTES = 16 * 1024;

export interface ExtractedText {
  text: string;
  /** PDFs only. */
  pages?: number;
  /** Spreadsheets only. */
  sheets?: number;
  /** Presentations only. */
  slides?: number;
  truncated: boolean;
}

/** The most an Office file's unpacked part may be before it is refused as too large to read. */
export const MAX_OFFICE_PART_BYTES = 64 * 1024 * 1024;

const TEXTUAL_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/x-ndjson',
  'application/javascript',
]);

/** Whether this plugin can turn the bytes into text at all. */
export function isExtractable(mime: string, filename?: string | null): boolean {
  const m = normalize(mime);
  return m === 'application/pdf' || m.startsWith('text/') || TEXTUAL_MIMES.has(m) || officeKindOf(mime, filename) !== null;
}

function normalize(mime: string): string {
  return (mime.toLowerCase().split(';')[0] ?? '').trim();
}

/** Collapse the ragged whitespace a PDF text layer produces. */
export function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function clamp(text: string, limit: number): { text: string; truncated: boolean } {
  return text.length <= limit
    ? { text, truncated: false }
    : { text: text.slice(0, limit), truncated: true };
}

/**
 * Extract text, capped. Throws a plain Error for an unsupported type — the
 * registry turns that into a refusal the model can read.
 */
export async function extractText(
  bytes: Buffer,
  mime: string,
  limit: number,
  filename?: string | null,
): Promise<ExtractedText> {
  const m = normalize(mime);
  const office = officeKindOf(mime, filename);
  if (office) {
    let read: { text: string; sheets?: number; slides?: number };
    try {
      read = await officeText(bytes, office);
    } catch (err) {
      throw new Error(
        `this ${OFFICE_NAME[office]} could not be read (${err instanceof Error ? err.message : String(err)}); ` +
          'ask the owner to re-save or re-send it',
        { cause: err },
      );
    }
    const { text, truncated } = clamp(tidy(read.text), limit);
    return { text, truncated, ...(read.sheets === undefined ? {} : { sheets: read.sheets }), ...(read.slides === undefined ? {} : { slides: read.slides }) };
  }
  if (m === 'application/pdf') {
    let parsed;
    try {
      parsed = await pdfParse(bytes);
    } catch (err) {
      // A malformed or unsupported PDF is a fact about the file, not a defect
      // here — say so plainly so the agent can ask the owner for another copy.
      throw new Error(
        `this PDF could not be read (${err instanceof Error ? err.message : String(err)}); ` +
          'ask the owner to re-export or re-send it',
        { cause: err },
      );
    }
    const { text, truncated } = clamp(tidy(parsed.text ?? ''), limit);
    return { text, pages: parsed.numpages, truncated };
  }
  if (m.startsWith('text/') || TEXTUAL_MIMES.has(m)) {
    const { text, truncated } = clamp(tidy(bytes.toString('utf8')), limit);
    return { text, truncated };
  }
  throw new Error(
    `cannot extract text from ${mime}; only PDFs, text files and Word, Excel and PowerPoint files are readable this way` +
      (m.startsWith('image/') ? ' — an image is shown to you directly instead' : ''),
  );
}

const OFFICE_NAME: Record<OfficeKind, string> = { docx: 'Word document', xlsx: 'spreadsheet', pptx: 'presentation' };

/** The text of an Office file: a document's paragraphs, a workbook's sheets as CSV, a deck's slides. */
async function officeText(bytes: Buffer, kind: OfficeKind): Promise<{ text: string; sheets?: number; slides?: number }> {
  if (kind === 'docx') {
    const out = await mammoth.extractRawText({ buffer: bytes });
    return { text: out.value };
  }
  if (kind === 'xlsx') {
    const sheets = await readExcelFile(bytes);
    const text = sheets.map(({ sheet, data }) => {
      const rows = data.map((row) => row.map(cellText));
      const width = rows.reduce((w, row) => Math.max(w, row.length), 0);
      if (rows.length === 0 || width === 0) return `## ${sheet}\n\n(empty)`;
      const [head, ...body] = rows.map((row) => [...row, ...Array<string>(width - row.length).fill('')]);
      return `## ${sheet}\n\n${toCsv(head!, body).replace(/\r\n/g, '\n')}`;
    }).join('\n\n');
    return { text, sheets: sheets.length };
  }
  return slideText(bytes);
}

/** A cell as text: a date as its ISO day (or moment), everything else as written. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
  }
  return String(value);
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_all, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    }
    return ENTITIES[code.toLowerCase()] ?? '';
  });
}

/**
 * A presentation's text, slide by slide: the runs (`<a:t>`) of each
 * paragraph (`<a:p>`) of `ppt/slides/slideN.xml`, in slide order. Only the
 * slide parts are unpacked, each at most `MAX_OFFICE_PART_BYTES`.
 */
function slideText(bytes: Buffer): { text: string; slides: number } {
  const SLIDE = /^ppt\/slides\/slide(\d+)\.xml$/;
  const parts = unzipSync(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), {
    filter: (file) => {
      if (!SLIDE.test(file.name)) return false;
      if (file.originalSize > MAX_OFFICE_PART_BYTES) throw new Error(`${file.name} is too large to read`);
      return true;
    },
  });
  const slides = Object.keys(parts)
    .map((name) => ({ name, n: Number(SLIDE.exec(name)![1]) }))
    .sort((a, b) => a.n - b.n);
  const text = slides.map(({ name }, i) => {
    const xml = Buffer.from(parts[name]!).toString('utf8');
    const paragraphs = [...xml.matchAll(/<a:p[\s>][\s\S]*?<\/a:p>/g)]
      .map((p) => [...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decodeXml(t[1]!)).join(''))
      .filter((line) => line.trim() !== '');
    return `## Slide ${i + 1}\n\n${paragraphs.join('\n')}`;
  }).join('\n\n');
  return { text, slides: slides.length };
}

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Width and height from the header bytes of PNG, JPEG, GIF and WebP. Cheap by
 * construction: no decoder, no dependency, and `null` rather than a guess when
 * the format is not one of those.
 */
export function imageDimensions(bytes: Buffer): ImageDimensions | null {
  if (bytes.length < 16) return null;

  // PNG: IHDR is always the first chunk.
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  // GIF87a / GIF89a: little-endian logical screen size.
  if (bytes.subarray(0, 3).toString('latin1') === 'GIF') {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }

  // WebP (VP8 / VP8L / VP8X).
  if (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    const chunk = bytes.subarray(12, 16).toString('latin1');
    if (chunk === 'VP8X' && bytes.length >= 30) {
      const width = 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16));
      const height = 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16));
      return { width, height };
    }
    if (chunk === 'VP8 ' && bytes.length >= 30) {
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    }
    if (chunk === 'VP8L' && bytes.length >= 25) {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }

  // JPEG: walk the markers to the first SOFn frame header.
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1]!;
      // SOF0..SOF15, minus the non-frame markers DHT/JPG/DAC.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2) return null;
      offset += 2 + length;
    }
  }

  return null;
}
