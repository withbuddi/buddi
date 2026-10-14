/**
 * The family a file belongs to, for its icon and the word under it — the one
 * rule Files (the list, its kind filter in SQL, a file's page), the canvas and
 * the chat's file tiles all apply. Coarse on purpose: the owner tells a
 * spreadsheet from a photo at a glance, not two zip flavours apart.
 *
 * Office documents come first, by `office-files.ts`'s rule: an Open XML
 * package is a zip whose mime says "xml", which the generic checks below
 * would call an archive or code. A leaf module but for that rule, reached
 * through the `@buddi/core/file-families` subpath so the dashboard bundle
 * loads nothing else from core.
 */
import { OFFICE_FORMATS, officeKindOf, type OfficeKind } from './office-files.js';

export type FileFamily = 'image' | 'pdf' | 'table' | 'text' | 'presentation' | 'code' | 'audio' | 'video' | 'archive' | 'file';
export const FILE_FAMILIES: readonly FileFamily[] = ['image', 'pdf', 'table', 'text', 'presentation', 'code', 'audio', 'video', 'archive', 'file'];

/** The word for each family, wherever a file is labelled. */
export const FAMILY_LABEL: Readonly<Record<FileFamily, string>> = {
  image: 'Image',
  pdf: 'PDF',
  table: 'Spreadsheet',
  text: 'Document',
  presentation: 'Presentation',
  code: 'Code',
  audio: 'Audio',
  video: 'Video',
  archive: 'Archive',
  file: 'File',
};

/** Each Office kind's family: a Word file is a document, a workbook a spreadsheet, a deck a presentation. */
const OFFICE_FAMILY: Readonly<Record<OfficeKind, FileFamily>> = { docx: 'text', xlsx: 'table', pptx: 'presentation' };

const TABLE_EXT = ['csv', 'tsv', 'xls', 'xlsx', 'numbers', 'ods'];
const PRESENTATION_EXT = ['ppt', 'pptx', 'key', 'odp'];
const ARCHIVE_EXT = ['zip', 'gz', 'tgz', 'rar', '7z'];
const CODE_EXT = ['ts', 'tsx', 'js', 'py', 'rb', 'go', 'rs', 'swift', 'json', 'yaml', 'yml', 'toml', 'sh', 'sql', 'html', 'css'];
const TEXT_EXT = ['md', 'txt', 'rtf', 'doc', 'docx', 'pages', 'odt'];

export function familyOf(mime: string, filename?: string | null): FileFamily {
  const value = (mime || '').toLowerCase();
  const ext = (filename ?? '').toLowerCase().split('.').pop() ?? '';
  const office = officeKindOf(value, filename);
  if (office) return OFFICE_FAMILY[office];
  if (value.startsWith('image/')) return 'image';
  if (value === 'application/pdf') return 'pdf';
  if (value.startsWith('audio/')) return 'audio';
  if (value.startsWith('video/')) return 'video';
  if (value === 'text/csv' || value === 'text/tab-separated-values' || value.includes('spreadsheet') || value.includes('excel') || value === OFFICE_FORMATS.numbers!.mime || TABLE_EXT.includes(ext)) return 'table';
  if (value.includes('presentation') || value.includes('powerpoint') || value === OFFICE_FORMATS.key!.mime || PRESENTATION_EXT.includes(ext)) return 'presentation';
  if (value.includes('zip') || value.includes('tar') || value.includes('compressed') || ARCHIVE_EXT.includes(ext)) return 'archive';
  if (value === 'application/json' || value.includes('javascript') || value.includes('xml') || CODE_EXT.includes(ext)) return 'code';
  if (value.startsWith('text/') || value === OFFICE_FORMATS.doc!.mime || value === OFFICE_FORMATS.pages!.mime || value.includes('opendocument.text') || TEXT_EXT.includes(ext)) return 'text';
  return 'file';
}

/**
 * The same classification as SQL, so a family filter runs in the database.
 * `m` is the lower-cased mime, `e` the lower-cased extension.
 */
export function familySql(m: string, e: string): string {
  const inList = (xs: readonly string[]): string => xs.map((x) => `'${x}'`).join(', ');
  // Office first, as officeKindOf: its mime, else its extension for an unnamed type.
  const office = (Object.entries(OFFICE_FORMATS) as Array<[string, { mime: string; kind?: OfficeKind }]>)
    .filter(([, f]) => f.kind)
    .map(([ext, f]) => `when ${m} = '${f.mime}' or (${m} in ('', 'application/octet-stream', 'application/zip') and ${e} = '${ext}') then '${OFFICE_FAMILY[f.kind!]}'`)
    .join('\n    ');
  return `case
    ${office}
    when ${m} like 'image/%' then 'image'
    when ${m} = 'application/pdf' then 'pdf'
    when ${m} like 'audio/%' then 'audio'
    when ${m} like 'video/%' then 'video'
    when ${m} in ('text/csv', 'text/tab-separated-values', '${OFFICE_FORMATS.numbers!.mime}') or ${m} like '%spreadsheet%' or ${m} like '%excel%' or ${e} in (${inList(TABLE_EXT)}) then 'table'
    when ${m} = '${OFFICE_FORMATS.key!.mime}' or ${m} like '%presentation%' or ${m} like '%powerpoint%' or ${e} in (${inList(PRESENTATION_EXT)}) then 'presentation'
    when ${m} like '%zip%' or ${m} like '%tar%' or ${m} like '%compressed%' or ${e} in (${inList(ARCHIVE_EXT)}) then 'archive'
    when ${m} = 'application/json' or ${m} like '%javascript%' or ${m} like '%xml%' or ${e} in (${inList(CODE_EXT)}) then 'code'
    when ${m} like 'text/%' or ${m} in ('${OFFICE_FORMATS.doc!.mime}', '${OFFICE_FORMATS.pages!.mime}') or ${m} like '%opendocument.text%' or ${e} in (${inList(TEXT_EXT)}) then 'text'
    else 'file' end`;
}
