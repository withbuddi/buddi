/**
 * Text files in the canvas's editor: which files are text (core's rule, the
 * one the server's routes apply: `@buddi/core/text-files`), which language
 * the editor reads one as, and which lines a newer version changed. Which
 * files a call opens as a tab is `file-tabs.ts`.
 */
import { extensionOf } from '@buddi/core/office-files';
import { isTextFile } from '@buddi/core/text-files';

export { isTextFile };


/** Markdown gets a Preview beside its Edit. */
export function isMarkdown(filename: string | null | undefined, mime = ''): boolean {
  const ext = extensionOf(filename);
  return ext === 'md' || ext === 'markdown' || mime.toLowerCase().startsWith('text/markdown');
}

/** The editor's language for a file, by extension; null is plain text. */
export type EditorLanguage = 'markdown' | 'json' | 'javascript' | 'typescript' | 'python' | 'yaml' | 'html' | 'css' | 'shell';
export function languageOf(filename: string | null | undefined, mime = ''): EditorLanguage | null {
  const ext = extensionOf(filename);
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
