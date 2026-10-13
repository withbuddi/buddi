/**
 * Text files a run produced, as the canvas knows them.
 *
 * A file is read by shape, never by tool name: a result that *is* a stored
 * file (`{ artifactId, filename, mime }`, what a document write returns) or
 * one that names the files it left (`{ artifacts: [{ id, filename, mime }] }`,
 * what a command returns as "Generated files"). Only library ids count;
 * nothing a result says is used as a link.
 *
 * A file is known across its versions by its name less the version mark
 * (`Plan (v2).md` is `Plan.md`), within the conversation: writing it again
 * updates the tab that has it open rather than opening another.
 */
import type { AttachmentBlock } from '../chat/attachments';

const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Extensions the editor opens as text, whatever the stored type says. */
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'csv', 'tsv', 'log', 'toml', 'ini', 'conf', 'env', 'xml', 'sql',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'swift', 'sh', 'bash', 'zsh', 'html', 'htm', 'css',
]);
/** Containers that are never text, however they are named. */
const NEVER_TEXT_EXTS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'numbers', 'pages', 'key', 'rtf', 'odt', 'ods', 'odp', 'pdf']);
const TEXT_MIMES = new Set(['application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/yaml', 'application/toml', 'application/sql', 'application/x-sh']);

function extOf(filename: string | null | undefined): string {
  const name = (filename ?? '').toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1);
}

/** Does the editor open this file? The gateway's own text rule, from the page's side. */
export function isTextFile(mime: string, filename: string | null | undefined): boolean {
  const ext = extOf(filename);
  if (NEVER_TEXT_EXTS.has(ext)) return false;
  const value = (mime || '').toLowerCase().split(';')[0]!.trim();
  if (value.startsWith('text/') || TEXT_MIMES.has(value)) return true;
  return (value === '' || value === 'application/octet-stream') && TEXT_EXTS.has(ext);
}

/** Markdown gets a Preview beside its Edit. */
export function isMarkdown(filename: string | null | undefined, mime = ''): boolean {
  const ext = extOf(filename);
  return ext === 'md' || ext === 'markdown' || mime.toLowerCase().startsWith('text/markdown');
}

/** The editor's language for a file, by extension; null is plain text. */
export type EditorLanguage = 'markdown' | 'json' | 'javascript' | 'typescript' | 'python' | 'yaml' | 'html' | 'css' | 'shell';
export function languageOf(filename: string | null | undefined, mime = ''): EditorLanguage | null {
  const ext = extOf(filename);
  switch (ext) {
    case 'md': case 'markdown': return 'markdown';
    case 'json': return 'json';
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'javascript';
    case 'ts': case 'tsx': return 'typescript';
    case 'py': return 'python';
    case 'yaml': case 'yml': return 'yaml';
    case 'html': case 'htm': return 'html';
    case 'css': return 'css';
    case 'sh': case 'bash': case 'zsh': return 'shell';
    default: break;
  }
  if (mime.startsWith('text/markdown')) return 'markdown';
  if (mime === 'application/json') return 'json';
  return null;
}

/** The name a file keeps across its versions, lower-cased: the gateway's rule too. */
export function fileChainName(filename: string | null | undefined): string | null {
  if (!filename) return null;
  return filename.replace(/ \(v\d+\)(\.[^.]+)$/i, '$1').toLowerCase();
}

/** The text files a result stored, oldest first, as the blocks a message carries. */
export function textFilesOf(output: unknown): AttachmentBlock[] {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return [];
  const record = output as Record<string, unknown>;
  const found: AttachmentBlock[] = [];
  const take = (id: unknown, filename: unknown, mime: unknown, size: unknown): void => {
    if (typeof id !== 'string' || !ARTIFACT_ID.test(id) || typeof filename !== 'string' || filename === '') return;
    const type = typeof mime === 'string' ? mime : 'application/octet-stream';
    if (!isTextFile(type, filename)) return;
    found.push({ type: 'attachment', artifactId: id, filename, mime: type, kind: 'document', sizeBytes: typeof size === 'number' ? size : null });
  };
  take(record['artifactId'], record['filename'], record['mime'], record['sizeBytes']);
  if (Array.isArray(record['artifacts'])) {
    for (const item of record['artifacts']) {
      if (item === null || typeof item !== 'object') continue;
      const file = item as Record<string, unknown>;
      take(file['id'], file['filename'], file['mime'], file['sizeBytes']);
    }
  }
  return found;
}

/** Is the result itself the file (a document write), rather than a command that left some? */
export function isFileResult(output: unknown): boolean {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return false;
  const id = (output as Record<string, unknown>)['artifactId'];
  return typeof id === 'string' && ARTIFACT_ID.test(id);
}

/** The tab id a file is known by: its first version's, prefixed. */
export function fileTabId(firstArtifactId: string): string {
  return `file:${firstArtifactId}`;
}

/**
 * The lines of `after` that are new or changed since `before`, 1-based: what
 * the editor marks when buddi writes the file again. Line-by-line, by the
 * longest common run; a file too big to compare marks nothing.
 */
export function changedLines(before: string, after: string, maxCells = 4_000_000): number[] {
  const a = before.replace(/\r\n/g, '\n').split('\n');
  const b = after.replace(/\r\n/g, '\n').split('\n');
  if (a.length * b.length > maxCells) return [];
  const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && a[i] === b[j]) { i++; j++; continue; }
    if (i < a.length && lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { i++; continue; }
    out.push(j + 1);
    j++;
  }
  return out;
}
