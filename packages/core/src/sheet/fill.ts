/**
 * The fill: a workbook buddi composed gets its formulas' values written in
 * (`<v>`, typed `str`, `b` or `e` where it is not a number) and
 * `calcPr fullCalcOnLoad="1"`, so Quick Look, Telegram, mail and a phone
 * show the totals, and Excel and Numbers recompute them on open. Only ever
 * on bytes buddi made (a compose program's output): an upload, a command's
 * output and an owner's save are never changed. A formula buddi could not
 * compute is left without a value, as the program wrote it.
 */
import { zipSync, type Zippable } from 'fflate';
import { evaluate, type Evaluation } from './evaluate.js';
import { isSheetError, isWorkbookPart, readWorkbookParts, unzipBounded, type CellValue, type WorkbookModel, type WorkbookParts } from './read.js';
import { cellKey, parseAddress } from './refs.js';
import { attr, encodeXml, withoutAttr } from './xml.js';

export interface FilledWorkbook {
  bytes: Uint8Array;
  workbook: WorkbookModel;
  evaluation: Evaluation;
}

/** A value as `<v>` and the type attribute that goes with it. */
function written(value: CellValue): { t: string | null; v: string } {
  if (isSheetError(value)) return { t: 'e', v: value.error };
  if (typeof value === 'boolean') return { t: 'b', v: value ? '1' : '0' };
  if (typeof value === 'number') return { t: null, v: String(value) };
  return { t: 'str', v: value ?? '' };
}

/** A sheet's XML with each computed formula's value written after its `<f>`. */
function fillSheet(xml: string, values: Map<number, CellValue>): string {
  if (values.size === 0) return xml;
  return xml.replace(/<c\b([^>]*?)(?<!\/)>([\s\S]*?)<\/c>/g, (all, attrs: string, body: string) => {
    if (!/<f\b/.test(body)) return all;
    const ref = attr(attrs, 'r');
    const at = ref ? parseAddress(ref) : null;
    if (!at) return all;
    const value = values.get(cellKey(at.row, at.col));
    if (value === undefined) return all;
    // A value already there (an empty `<v/>` included) is replaced: these are bytes buddi made.
    const withoutValue = body.replace(/<v(?:\s[^>]*)?\/>|<v(?:\s[^>]*)?>[\s\S]*?<\/v>/g, '');
    const { t, v } = written(value);
    const cleaned = withoutAttr(attrs, 't');
    const typed = t === null ? cleaned : `${cleaned} t="${t}"`;
    const formulaEnd = /<\/f>|<f\b[^>]*\/>/.exec(withoutValue);
    const at2 = formulaEnd ? formulaEnd.index + formulaEnd[0].length : withoutValue.length;
    return `<c${typed}>${withoutValue.slice(0, at2)}<v>${encodeXml(v)}</v>${withoutValue.slice(at2)}</c>`;
  });
}

/** `workbook.xml` asking the app to recalculate every formula when it opens the file. */
export function withFullCalcOnLoad(xml: string): string {
  if (/<calcPr\b/.test(xml)) {
    return xml.replace(/<calcPr\b([^>]*?)(\/?)>/, (_all, attrs: string, close: string) =>
      `<calcPr${withoutAttr(attrs, 'fullCalcOnLoad')} fullCalcOnLoad="1"${close}>`);
  }
  // Its place in the schema: after the sheets and defined names, before what follows them.
  const after = /<\/definedNames>|<definedNames\s*\/>|<\/sheets>/g;
  let last: RegExpExecArray | null = null;
  for (let m = after.exec(xml); m; m = after.exec(xml)) last = m;
  if (!last) return xml.replace(/<\/workbook>/, '<calcPr fullCalcOnLoad="1"/></workbook>');
  const at = last.index + last[0].length;
  return `${xml.slice(0, at)}<calcPr fullCalcOnLoad="1"/>${xml.slice(at)}`;
}

/** The workbook with every formula's value filled in that buddi could compute, and what it computed. */
export async function fillCachedValues(bytes: Uint8Array): Promise<FilledWorkbook> {
  const raw = unzipBounded(bytes);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const parts: WorkbookParts = {};
  for (const name of Object.keys(raw)) if (isWorkbookPart(name)) parts[name] = decoder.decode(raw[name]);
  const workbook = readWorkbookParts(parts);
  const evaluation = await evaluate(workbook, { want: (_sheet, cell) => cell.formula !== undefined });
  const out: Zippable = {};
  for (const [name, data] of Object.entries(raw)) out[name] = data;
  for (const sheet of workbook.sheets) {
    const values = evaluation.values.get(sheet.name);
    if (values && values.size > 0) out[sheet.path] = encoder.encode(fillSheet(parts[sheet.path]!, values));
  }
  if (parts['xl/workbook.xml'] !== undefined) out['xl/workbook.xml'] = encoder.encode(withFullCalcOnLoad(parts['xl/workbook.xml']));
  // The values are buddi's now: read back what was written, so a reader of the result sees the file it is.
  const filled = zipSync(out, { level: 6 });
  for (const sheet of workbook.sheets) {
    const values = evaluation.values.get(sheet.name);
    if (!values) continue;
    for (const [key, value] of values) {
      const cell = sheet.cells.get(key);
      if (cell) { cell.value = value; cell.hasValue = true; }
    }
  }
  return { bytes: filled, workbook, evaluation };
}
