/**
 * The reads of an Office file the extractor's worker runs (`office-worker.ts`),
 * one switch for the worker and for the caller's thread when run from source:
 * a file's text, a composed document's render summary, and a composed
 * workbook's fill (its formula values written in, `@buddi/core/sheet`) with
 * the summary of the filled workbook. Each first checks the package as its
 * parts truly inflate (`verifiedOfficePackage`) and hands the parsers that
 * verified copy, never the bytes it was given.
 */
import { verifiedOfficePackage, type OfficeKind } from '@buddi/core/plugin';
import { fillCachedValues } from '@buddi/core/sheet';
import { officeText } from './office-text.js';
import { officeRender, xlsxRender } from './render.js';

export type OfficeTask = 'text' | 'render' | 'fill';

export async function officeTask(task: OfficeTask, given: Buffer, kind: OfficeKind): Promise<unknown> {
  const verified = verifiedOfficePackage(new Uint8Array(given.buffer, given.byteOffset, given.byteLength), kind);
  if (typeof verified === 'string') throw new Error(verified);
  const bytes = Buffer.from(verified.buffer, verified.byteOffset, verified.byteLength);
  if (task === 'text') return officeText(bytes, kind);
  if (task === 'render') return officeRender(bytes, kind as 'docx' | 'pptx');
  const filled = await fillCachedValues(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  return { bytes: filled.bytes, render: xlsxRender(filled.workbook, filled.evaluation) };
}
