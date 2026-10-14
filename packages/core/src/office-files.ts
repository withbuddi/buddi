/**
 * Which files are Office documents: the one rule the gateway (previews,
 * text for agents, Open in app, an agent's rebuild) and the dashboard (which
 * preview draws a file) both apply, beside `text-files.ts`'s rule for text.
 *
 * By mime first, then — for the `application/octet-stream` a browser or a
 * command gives anything it does not recognise — by extension. Only the
 * three Open XML formats buddi can read are a kind; the legacy binary,
 * Apple and OpenDocument formats are not (they are downloaded, or opened in
 * the owner's own app). A leaf module (no imports), reached through the
 * `@buddi/core/office-files` subpath so the dashboard bundle loads nothing
 * else from core.
 */

export type OfficeKind = 'docx' | 'xlsx' | 'pptx';

/**
 * Every Office format buddi knows, by extension: its mime, and — for the
 * three Open XML formats it reads — its kind and the part every such
 * package has. The one list the text rule (never text), the store (a
 * document, stored under this extension) and Open in app read.
 */
export const OFFICE_FORMATS: Readonly<Record<string, { mime: string; kind?: OfficeKind; main?: string }>> = {
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'docx', main: 'word/document.xml' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'xlsx', main: 'xl/workbook.xml' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'pptx', main: 'ppt/presentation.xml' },
  doc: { mime: 'application/msword' },
  xls: { mime: 'application/vnd.ms-excel' },
  ppt: { mime: 'application/vnd.ms-powerpoint' },
  rtf: { mime: 'application/rtf' },
  odt: { mime: 'application/vnd.oasis.opendocument.text' },
  ods: { mime: 'application/vnd.oasis.opendocument.spreadsheet' },
  odp: { mime: 'application/vnd.oasis.opendocument.presentation' },
  pages: { mime: 'application/vnd.apple.pages' },
  numbers: { mime: 'application/vnd.apple.numbers' },
  key: { mime: 'application/vnd.apple.keynote' },
};

/** The extensions of every Office format: containers that are never text. */
export const OFFICE_EXTS: ReadonlySet<string> = new Set(Object.keys(OFFICE_FORMATS));

/** The mime each kind is stored under. */
export const OFFICE_MIME: Readonly<Record<OfficeKind, string>> = {
  docx: OFFICE_FORMATS.docx!.mime,
  xlsx: OFFICE_FORMATS.xlsx!.mime,
  pptx: OFFICE_FORMATS.pptx!.mime,
};

const BY_MIME: ReadonlyMap<string, string> = new Map(Object.entries(OFFICE_FORMATS).map(([ext, f]) => [f.mime, ext]));

function extensionOf(filename: string | null | undefined): string {
  const name = (filename ?? '').toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1);
}

function bare(mime: string): string {
  return (mime || '').toLowerCase().split(';')[0]!.trim();
}

/** The Office format a file is, by mime, else by extension for an unnamed type. */
function formatOf(mime: string, filename?: string | null): string | null {
  const value = bare(mime);
  const byMime = BY_MIME.get(value);
  if (byMime) return byMime;
  if (value !== '' && value !== 'application/octet-stream' && value !== 'application/zip') return null;
  const ext = extensionOf(filename);
  return OFFICE_EXTS.has(ext) ? ext : null;
}

/** Which Office document this file is — docx, xlsx or pptx — or null. */
export function officeKindOf(mime: string, filename?: string | null): OfficeKind | null {
  const format = formatOf(mime, filename);
  return format ? OFFICE_FORMATS[format]!.kind ?? null : null;
}

/**
 * Whether "Open in app" is offered for this file: an Office document of any
 * kind, the ones buddi reads and the ones it only hands to the owner's app.
 */
export function opensInApp(mime: string, filename?: string | null): boolean {
  return formatOf(mime, filename) !== null;
}

/** The largest Office file previewed on the Canvas and in Files; a bigger one is Download only. */
export const OFFICE_PREVIEW_BYTES = 20 * 1024 * 1024;

/** What a preview shows of a spreadsheet: the first rows and columns of each sheet. */
export const SHEET_PREVIEW_ROWS = 1_000;
export const SHEET_PREVIEW_COLS = 50;

/**
 * The documents buddi makes from text, with buddi's own exporter: a Word
 * document or a PDF from Markdown, a workbook from a table (CSV). What an
 * agent's `artifacts.write` may ask for, and what a file of that kind is
 * rebuilt from when written again. A presentation is not one.
 */
export type MadeDocument = 'docx' | 'xlsx' | 'pdf';
export const MADE_FROM: Readonly<Record<MadeDocument, { from: 'text/markdown' | 'text/csv'; mime: string }>> = {
  docx: { from: 'text/markdown', mime: OFFICE_MIME.docx },
  xlsx: { from: 'text/csv', mime: OFFICE_MIME.xlsx },
  pdf: { from: 'text/markdown', mime: 'application/pdf' },
};

/** Which made document this file is (written again, it is rebuilt from text), or null. */
export function madeDocumentOf(mime: string, filename?: string | null): MadeDocument | null {
  const kind = officeKindOf(mime, filename);
  if (kind === 'docx' || kind === 'xlsx') return kind;
  return bare(mime) === 'application/pdf' || (bare(mime) === 'application/octet-stream' && extensionOf(filename) === 'pdf') ? 'pdf' : null;
}

/**
 * Who may rebuild a document from text — an agent's Markdown onto a .docx or
 * a .pdf, a table onto a .xlsx — losing what its newest version had beyond
 * the text: null when it may, else why not, which is what the agent is told.
 * A file buddi made (its creator is an agent) may be rebuilt; one the owner
 * made or handed in only once he agreed (`confirmedRebuild`), which the agent
 * passes only after asking him. A presentation is never rebuilt.
 */
export function officeRebuildRefusal(
  file: { name: string | null; mime: string; createdBy: string },
  input: { confirmedRebuild?: boolean; ownerId?: string },
): string | null {
  const name = file.name ?? 'this file';
  if (officeKindOf(file.mime, file.name) === 'pptx') return `${name} is a presentation; agents can read it (artifacts.text) but not write it.`;
  const made = madeDocumentOf(file.mime, file.name);
  if (made === null) return null;
  const owner = file.createdBy === 'owner' || (input.ownerId !== undefined && file.createdBy === input.ownerId);
  if (!owner || input.confirmedRebuild === true) return null;
  const what = made === 'docx' ? 'Word document' : made === 'xlsx' ? 'spreadsheet' : 'PDF';
  return `${name} is the owner's own ${what}. Writing it from ${made === 'xlsx' ? 'a table' : 'Markdown'} rebuilds it and loses its formatting. Ask the owner first; only once they agree, write again with confirmedRebuild: true.`;
}

/**
 * A cell as text, the one rule for the agent's CSV and the page's table: a
 * date as its day (or its moment when it has a time), TRUE/FALSE, the rest
 * as written. Never evaluated.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('T', ' ').replace(/(:00)?\.000Z$/, '');
  }
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return String(value);
}

/**
 * What any Office package may hold before buddi reads it — the server's
 * text for agents, the page's previews, an import from Open in app alike:
 * checked from the zip's central directory, before anything is inflated.
 */
export const OFFICE_ZIP_LIMITS = { entries: 2_000, entryBytes: 50 * 1024 * 1024, totalBytes: 200 * 1024 * 1024 } as const;

/** One entry of a zip's central directory: its name and the sizes it declares. */
export interface ZipEntry { name: string; compressed: number; size: number }

/**
 * The entries a zip's central directory lists, or why it is not a zip buddi
 * will read: no end record, more entries or more expanded bytes than
 * `OFFICE_ZIP_LIMITS`, or a ZIP64 size (more than 4 GiB declared). Reads
 * only the directory; nothing is inflated.
 */
export function zipEntries(bytes: Uint8Array, limits: { entries: number; entryBytes: number; totalBytes: number } = OFFICE_ZIP_LIMITS): ZipEntry[] | string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record: in the last 64 KiB + 22 bytes.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) return 'it is not a zip package';
  const count = view.getUint16(end + 10, true);
  const dirSize = view.getUint32(end + 12, true);
  const dirAt = view.getUint32(end + 16, true);
  if (count === 0xffff || dirAt === 0xffffffff) return 'it is a ZIP64 package, larger than buddi reads';
  if (count > limits.entries) return `it holds ${count} parts; at most ${limits.entries}`;
  if (dirAt + dirSize > end) return 'its zip directory is damaged';
  const out: ZipEntry[] = [];
  let total = 0;
  let at = dirAt;
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) return 'its zip directory is damaged';
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (size === 0xffffffff || compressed === 0xffffffff) return 'it is a ZIP64 package, larger than buddi reads';
    if (size > limits.entryBytes) return `${name} unpacks to more than ${Math.round(limits.entryBytes / 1024 / 1024)} MB`;
    total += size;
    if (total > limits.totalBytes) return `it unpacks to more than ${Math.round(limits.totalBytes / 1024 / 1024)} MB`;
    out.push({ name, compressed, size });
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

/**
 * Why these bytes are not a whole package of this kind buddi will read, or
 * null: within `OFFICE_ZIP_LIMITS`, with `[Content_Types].xml` and the kind's
 * main part. What an Open in app save must be before it is imported (an app
 * half way through writing leaves something that is not), and what every
 * reader checks first.
 */
export function officePackageProblem(bytes: Uint8Array, kind: OfficeKind): string | null {
  const entries = zipEntries(bytes);
  if (typeof entries === 'string') return entries;
  const names = new Set(entries.map((e) => e.name));
  if (!names.has('[Content_Types].xml')) return 'it is not an Office package';
  const main = OFFICE_FORMATS[kind]!.main!;
  if (!names.has(main)) return `it has no ${main}`;
  return null;
}
