/**
 * File tabs on the canvas: one tab per file (`file:<fileId>`), across its
 * versions, for what the gateway says a call made or opened (`files` on a
 * tool result), never read from the shape of a result. A text file opens in
 * the editor (`text-files.ts`); an Office document or a PDF in its preview.
 */
import { madeDocumentOf, officeKindOf } from '@buddi/core/office-files';
import { isTextFile } from '@buddi/core/text-files';

/** The tab id a file is known by: its file id, prefixed (a version's id for a transcript that names no file). */
export function fileTabId(fileId: string): string {
  return `file:${fileId}`;
}

/**
 * Which files a call that made them opens as their own tab: text, the
 * documents buddi makes and reads (Word, Excel, PDF) and a presentation.
 * The one rule for a document write and a command's generated files alike.
 */
export function opensAsFileTab(mime: string, filename?: string | null): boolean {
  return isTextFile(mime, filename) || madeDocumentOf(mime, filename) !== null || officeKindOf(mime, filename) === 'pptx';
}
