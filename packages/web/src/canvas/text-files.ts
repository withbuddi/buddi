/**
 * Text files a run produced, as the canvas knows them: only what the gateway
 * says a call made or opened (`files` on a tool result, each with its file's
 * id), never read from the shape of a result.
 *
 * A file is known across its versions by its `fileId` (the gateway says
 * which file each version is of): writing it again updates the tab that has
 * it open rather than opening another. Which files are text is core's rule,
 * the one the server's routes apply (`@buddi/core/text-files`).
 */
import { madeDocumentOf, officeKindOf } from '@buddi/core/office-files';
import { isTextFile } from '@buddi/core/text-files';

export { isTextFile };

/**
 * Which files a call that made them opens as their own tab: a text file (in
 * the editor), a Word, Excel or PowerPoint file and a PDF (in their preview).
 * The one rule the canvas applies to what the gateway says a call made.
 */
export function opensAsFileTab(mime: string, filename?: string | null): boolean {
  return isTextFile(mime, filename) || officeKindOf(mime, filename) !== null || madeDocumentOf(mime, filename) !== null;
}


function extOf(filename: string | null | undefined): string {
  const name = (filename ?? '').toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1);
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

/** The tab id a file is known by: its file id, prefixed (a version's id for a transcript that names no file). */
export function fileTabId(fileId: string): string {
  return `file:${fileId}`;
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
