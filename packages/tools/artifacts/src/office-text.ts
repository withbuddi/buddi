/**
 * The text of an Word, Excel or PowerPoint file, for agents: a document's
 * text with mammoth (BSD-2-Clause), a workbook's sheets as CSV under a
 * `## Sheet` heading with read-excel-file (MIT), a deck's slide text from its
 * slide XML with fflate (MIT). Pure, so it runs the same in the worker
 * `extract.ts` starts (`office-worker.ts`) and, from source, in the caller's
 * thread. It is handed a verified package (`office-task.ts`).
 */
import { cellText, decodeEntities, unzipOffice, type OfficeKind } from '@buddi/core/plugin';
import { UNSUPPORTED_WORKBOOK, workbookUnsupported } from '@buddi/core/sheet';
import mammoth from 'mammoth';
import readExcelFile from 'read-excel-file/node';
import { toCsv } from './document.js';

/** The text of an Office file: a document's paragraphs, a workbook's sheets as CSV, a deck's slides. */
export async function officeText(bytes: Buffer, kind: OfficeKind): Promise<{ text: string; sheets?: number; slides?: number }> {
  if (kind === 'docx') {
    const out = await mammoth.extractRawText({ buffer: bytes });
    return { text: out.value };
  }
  if (kind === 'xlsx') {
    // A workbook buddi does not read is said so, not read as empty sheets.
    const workbook = unzipOffice(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), (name) => name === 'xl/workbook.xml');
    if (typeof workbook === 'string') throw new Error(workbook);
    const unsupported = workbookUnsupported(workbook['xl/workbook.xml'] && new TextDecoder().decode(workbook['xl/workbook.xml']));
    if (unsupported) throw new Error(UNSUPPORTED_WORKBOOK[unsupported]);
    const sheets = await readExcelFile(bytes);
    const text = sheets.map(({ sheet, data }) => {
      const rows = data.map((row) => row.map(cellText));
      const width = rows.reduce((w, row) => Math.max(w, row.length), 0);
      if (rows.length === 0 || width === 0) return `## ${sheet}\n\n(empty)`;
      const [head, ...body] = rows.map((row) => [...row, ...Array<string>(width - row.length).fill('')]);
      return `## ${sheet}\n\n${toCsv(head!, body).replace(/\r\n/g, '\n')}`;
    }).join('\n\n');
    return { text, sheets: sheets.length };
  }
  return slideText(bytes);
}

/**
 * A presentation's text, slide by slide: the runs (`<a:t>`) of each
 * paragraph (`<a:p>`) of `ppt/slides/slideN.xml`, in slide order. Only the
 * slide parts are unpacked, within the Office limits.
 */
function slideText(bytes: Buffer): { text: string; slides: number } {
  const SLIDE = /^ppt\/slides\/slide(\d+)\.xml$/;
  const parts = unzipOffice(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), (name) => SLIDE.test(name));
  if (typeof parts === 'string') throw new Error(parts);
  const slides = Object.keys(parts)
    .map((name) => ({ name, n: Number(SLIDE.exec(name)![1]) }))
    .sort((a, b) => a.n - b.n);
  const text = slides.map(({ name }, i) => {
    const xml = Buffer.from(parts[name]!).toString('utf8');
    const paragraphs = [...xml.matchAll(/<a:p[\s>][\s\S]*?<\/a:p>/g)]
      .map((p) => [...p[0].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decodeEntities(t[1]!)).join(''))
      .filter((line) => line.trim() !== '');
    return `## Slide ${i + 1}\n\n${paragraphs.join('\n')}`;
  }).join('\n\n');
  return { text, slides: slides.length };
}

