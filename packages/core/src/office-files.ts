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

/** The mime each kind is stored under. */
export const OFFICE_MIME: Readonly<Record<OfficeKind, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const BY_MIME: ReadonlyMap<string, OfficeKind> = new Map(
  (Object.entries(OFFICE_MIME) as Array<[OfficeKind, string]>).map(([kind, mime]) => [mime, kind]),
);

/** Office formats buddi does not read, which the owner's own app still opens. */
const OTHER_OFFICE_EXTS = new Set(['doc', 'xls', 'ppt', 'rtf', 'pages', 'numbers', 'key', 'odt', 'ods', 'odp']);

function extensionOf(filename: string | null | undefined): string {
  const name = (filename ?? '').toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1);
}

function bare(mime: string): string {
  return (mime || '').toLowerCase().split(';')[0]!.trim();
}

/** Which Office document this file is — docx, xlsx or pptx — or null. */
export function officeKindOf(mime: string, filename?: string | null): OfficeKind | null {
  const value = bare(mime);
  const byMime = BY_MIME.get(value);
  if (byMime) return byMime;
  if (value !== '' && value !== 'application/octet-stream' && value !== 'application/zip') return null;
  const ext = extensionOf(filename);
  return ext === 'docx' || ext === 'xlsx' || ext === 'pptx' ? ext : null;
}

/**
 * Whether "Open in app" is offered for this file: an Office document of any
 * kind, the ones buddi reads and the ones it only hands to the owner's app.
 */
export function opensInApp(mime: string, filename?: string | null): boolean {
  return officeKindOf(mime, filename) !== null || OTHER_OFFICE_EXTS.has(extensionOf(filename));
}

/** The largest Office file previewed on the Canvas and in Files; a bigger one is Download only. */
export const OFFICE_PREVIEW_BYTES = 20 * 1024 * 1024;

/** What a preview shows of a spreadsheet: the first rows and columns of each sheet. */
export const SHEET_PREVIEW_ROWS = 1_000;
export const SHEET_PREVIEW_COLS = 50;

/**
 * Who may rebuild an Office file from text (an agent's `artifacts.write` of
 * Markdown onto a .docx, a CSV onto a .xlsx), losing the formatting its
 * newest version had: null when it may, else why not — what the agent is
 * told. A file buddi made (its creator is an agent) may be rebuilt; one the
 * owner made or handed in only once he agreed (`confirmedRebuild`), which
 * the agent passes only after asking him. A pptx is never rebuilt.
 */
export function officeRebuildRefusal(
  file: { name: string | null; mime: string; createdBy: string },
  input: { confirmedRebuild?: boolean; ownerId?: string },
): string | null {
  const kind = officeKindOf(file.mime, file.name);
  const name = file.name ?? 'this file';
  if (kind === 'pptx') return `${name} is a presentation; agents can read it (artifacts.text) but not write it.`;
  if (kind === null) return null;
  const owner = file.createdBy === 'owner' || (input.ownerId !== undefined && file.createdBy === input.ownerId);
  if (!owner || input.confirmedRebuild === true) return null;
  return `${name} is the owner's own ${kind === 'docx' ? 'Word document' : 'spreadsheet'}. Writing it from ${kind === 'docx' ? 'Markdown' : 'a table'} rebuilds it and loses its formatting. Ask the owner first; only once they agree, write again with confirmedRebuild: true.`;
}
