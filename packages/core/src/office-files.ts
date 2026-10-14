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

/**
 * A file name's extension, lower-cased, after its last dot ('' for none): the
 * one helper every file rule (text, Office, PDF, family) reads a name with.
 */
export function extensionOf(filename: string | null | undefined): string {
  const name = (filename ?? '').toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1);
}

/** A mime as the rules compare it: lower-cased, its parameters (`; charset=binary`) dropped. */
export function bareMime(mime: string | null | undefined): string {
  return (mime || '').toLowerCase().split(';')[0]!.trim();
}

/**
 * The types that say nothing about a file — none, what a browser or a command
 * gives anything it does not recognise, and the zip every Open XML package
 * is — so the extension decides. Shared with the family rule's SQL.
 */
export const UNTYPED_MIMES: readonly string[] = ['', 'application/octet-stream', 'application/zip'];

/** The Office format a file is, by mime, else by extension for an untyped file. */
function formatOf(mime: string, filename?: string | null): string | null {
  const value = bareMime(mime);
  const byMime = BY_MIME.get(value);
  if (byMime) return byMime;
  if (!UNTYPED_MIMES.includes(value)) return null;
  const ext = extensionOf(filename);
  return OFFICE_EXTS.has(ext) ? ext : null;
}

/**
 * Is this file a PDF: its mime, else `.pdf` on an untyped file. The one rule
 * for a PDF's family, its preview (the server's and the page's) and whether a
 * call that made one opens its tab.
 */
export function isPdf(mime: string, filename?: string | null): boolean {
  const value = bareMime(mime);
  return value === 'application/pdf' || (UNTYPED_MIMES.includes(value) && extensionOf(filename) === 'pdf');
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
  return isPdf(mime, filename) ? 'pdf' : null;
}

/** The newest version of a file, as the rebuild rule reads it. */
export interface NewestVersionFacts {
  id: string;
  version: number;
  createdBy: string;
  /** Made by `artifacts.compose`: a program's output, with the program beside it. */
  composed: boolean;
}

/**
 * What rebuilding a document needs — losing what its newest version had:
 * null when the writer may, else who has to say yes, and what the agent is
 * told. The one rule for both ways a document is made (docs/files.md,
 * "Office documents" and "Composed documents"), decided on the newest
 * version alone:
 *
 *  - `owner`: the newest version is the owner's own (a save in Word, Open in
 *    app, the Canvas, a file he sent). Only he can let it be replaced, on an
 *    approval card buddi raises (the write then runs as an approved action);
 *    nothing the model passes is enough.
 *  - `asked`: from text onto a version a program composed. It is changed by
 *    editing the program; `confirmedRebuild` says the owner asked for the
 *    Markdown rebuild anyway.
 *  - `never`: a presentation from text.
 *
 * A version a program composed is composed again freely, and one an agent
 * wrote is rebuilt freely.
 */
export type RebuildNeed = { need: 'owner' | 'asked' | 'never'; message: string };

export function rebuildNeed(
  file: { name: string | null; mime: string; createdBy: string },
  input: { ownerId?: string; newest?: NewestVersionFacts | null; composing?: boolean },
): RebuildNeed | null {
  const name = file.name ?? 'this file';
  const owners = (by: string): boolean => by === 'owner' || (input.ownerId !== undefined && by === input.ownerId);
  const newest = input.newest ?? null;
  const ownerVersion = (what: string, how: string): RebuildNeed => ({
    need: 'owner',
    message: `v${newest!.version} of ${name} is the owner's own version (a save in Word or another app, or a file he sent). ${what} replaces his edits: read it first (artifacts.text { id: "${newest!.id}" }) and ${how}, tell the owner what you will do, then call again with readVersion: ${newest!.version} and confirmedRebuild: true — buddi then asks him on a card, and saves only if he says yes.`,
  });
  if (input.composing === true) {
    if (newest === null || newest.composed || !owners(newest.createdBy)) return null;
    // A workbook's owner version holds the numbers he typed; artifacts.text gives them as his app saved them.
    return ownerVersion("Composing it again with your program's output", officeKindOf(file.mime, file.name) === 'xlsx'
      ? "carry the inputs he typed into the program's data (never into formula results: those the program computes)"
      : 'carry his changes into the program');
  }
  if (officeKindOf(file.mime, file.name) === 'pptx') {
    return { need: 'never', message: `${name} is a presentation; agents can read it (artifacts.text) but not write it with artifacts.write. ${newest?.composed ? 'It was composed by a program: change it by editing that program (artifacts.compose { fileId, source: true }).' : 'A deck is made with artifacts.compose.'}` };
  }
  const made = madeDocumentOf(file.mime, file.name);
  if (made === null) return null;
  const from = made === 'xlsx' ? 'a table' : 'Markdown';
  if (newest?.composed) {
    return { need: 'asked', message: `${name} was composed by a program: change it by editing its program (artifacts.compose { fileId, source: true }, then artifacts.compose with the edited program). Writing it from ${from} would rebuild it and lose its design; only if the owner asks for that, write again with confirmedRebuild: true.` };
  }
  if (!owners(newest?.createdBy ?? file.createdBy)) return null;
  if (newest === null) return null;
  return ownerVersion(`Writing it from ${from} rebuilds its formatting and`, 'keep his changes in your text');
}

/**
 * The refusal a write meets, or null when it goes ahead: `rebuildNeed`, with
 * `approved` (the call runs as an action the owner approved — the host knows
 * that from the context, never from the model) and `confirmedRebuild` (the
 * agent says the owner asked for a rebuild from text).
 */
export function officeRebuildRefusal(
  file: { name: string | null; mime: string; createdBy: string },
  input: { confirmedRebuild?: boolean; approved?: boolean; ownerId?: string; newest?: NewestVersionFacts | null; composing?: boolean },
): string | null {
  const rule = rebuildNeed(file, input);
  if (rule === null) return null;
  if (rule.need === 'owner' && input.approved === true) return null;
  if (rule.need === 'asked' && input.confirmedRebuild === true) return null;
  return rule.message;
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
