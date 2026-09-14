/**
 * Reading what is inside an artifact.
 *
 * The agent can usually just *look* at an attachment — images and PDFs go to the
 * model as real multimodal blocks. Extraction exists for the other case: a
 * forty-page bank statement that would cost more to look at than to read, and
 * which the agent wants to search rather than see. So this module is
 * deliberately narrow — text out of PDFs and text files, dimensions out of
 * images from their header bytes — and it never shells out to a converter.
 */
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

/** How much text `artifacts.describe` shows before it truncates. */
export const DESCRIBE_TEXT_CHARS = 20_000;
/** Hard ceiling for `artifacts.text`, so one tool result cannot flood a run. */
export const MAX_TEXT_CHARS = 200_000;

export interface ExtractedText {
  text: string;
  /** PDFs only. */
  pages?: number;
  truncated: boolean;
}

const TEXTUAL_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/x-ndjson',
  'application/javascript',
]);

/** Whether this plugin can turn the bytes into text at all. */
export function isExtractable(mime: string): boolean {
  const m = normalize(mime);
  return m === 'application/pdf' || m.startsWith('text/') || TEXTUAL_MIMES.has(m);
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
): Promise<ExtractedText> {
  const m = normalize(mime);
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
    `cannot extract text from ${mime}; only PDFs and text files are readable this way` +
      (m.startsWith('image/') ? ' — an image is shown to you directly instead' : ''),
  );
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
