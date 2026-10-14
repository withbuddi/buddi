/**
 * The sheet engine over a workbook written the way openpyxl writes one:
 * shared strings, formulas with an empty `<v></v>`, a theme part, styles
 * with fonts, fills, borders and number formats, a frozen header, a merge
 * and conditional rules. What the fill writes, what the preview reads.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  address, cellKey, conditionalStyles, criterion, evaluate, fillCachedValues, formatCell, readWorkbook, sheetEngine, shiftFormula, valueOf,
  withFullCalcOnLoad, withoutLeadingEquals,
} from './index.js';

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const THEME = `<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements><a:clrScheme name="Office">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1>
<a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4>
<a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink>
<a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme></a:themeElements></a:theme>`;
const STYLES = `<?xml version="1.0"?><styleSheet ${NS}><numFmts count="2"><numFmt numFmtId="164" formatCode="&quot;€&quot;#,##0.00;[Red]-&quot;€&quot;#,##0.00"/><numFmt numFmtId="165" formatCode="d mmm yyyy"/></numFmts>
<fonts count="3"><font><name val="Calibri"/><family val="2"/><color theme="1"/><sz val="11"/><scheme val="minor"/></font><font><name val="Calibri"/><b val="1"/><color rgb="FFFFFFFF"/><sz val="11"/></font><font><i val="1"/><sz val="11"/></font></fonts>
<fills count="4"><fill><patternFill/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor theme="4"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor theme="4" tint="0.7999816888943144"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF000000"/></top><bottom style="double"/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" applyFont="1" applyFill="1"><alignment horizontal="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="1" fillId="0" borderId="1" applyNumberFormat="1"/><xf numFmtId="10" fontId="2" fillId="3" borderId="0" applyNumberFormat="1"><alignment wrapText="1"/></xf><xf numFmtId="165" fontId="0" fillId="0" borderId="0"/></cellXfs>
<dxfs count="2"><dxf><font><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf><dxf><font><b/></font></dxf></dxfs></styleSheet>`;

/** A workbook as openpyxl writes one: each sheet's `<sheetData>` and what follows it. */
function openpyxlBook(sheets: Array<{ name: string; data: string; before?: string; after?: string }>, strings: string[], workbook?: string): Uint8Array {
  const parts: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
    'xl/workbook.xml': strToU8(workbook ?? `<?xml version="1.0"?><workbook ${NS}><workbookPr/><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="124519" fullCalcOnLoad="1"/></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`),
    'xl/styles.xml': strToU8(STYLES),
    'xl/theme/theme1.xml': strToU8(THEME),
    'xl/sharedStrings.xml': strToU8(`<?xml version="1.0"?><sst ${NS} uniqueCount="${strings.length}">${strings.map((s) => `<si><t>${s}</t></si>`).join('')}</sst>`),
  };
  sheets.forEach((s, i) => {
    parts[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(`<?xml version="1.0"?><worksheet ${NS}>${s.before ?? ''}<sheetData>${s.data}</sheetData>${s.after ?? ''}</worksheet>`);
  });
  // A fixed time, so the same workbook is the same bytes: the page's tests read it as `trip.xlsx`.
  return zipSync(parts, { mtime: new Date('2026-10-13T12:00:00Z') });
}

const S = (ref: string, i: number, s = 0): string => `<c r="${ref}" t="s"${s ? ` s="${s}"` : ''}><v>${i}</v></c>`;
const N = (ref: string, n: number, s = 0): string => `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${n}</v></c>`;
const F = (ref: string, f: string, s = 0): string => `<c r="${ref}"${s ? ` s="${s}"` : ''}><f>${f.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</f><v></v></c>`;
const row = (r: number, ...cells: string[]): string => `<row r="${r}">${cells.join('')}</row>`;

const strings = ['Item', 'Cost', 'Flights', 'Hotel', 'Travel subtotal', 'Food', 'Food subtotal', 'Total', 'Hotel', 'Category', 'travel', 'food', 'Yellow cells are inputs'];
// Costs: two groups with subtotals, a grand total that skips them, an IF and lookups.
const costs = [
  row(1, S('A1', 0, 1), S('B1', 1, 1), S('C1', 9, 1)),
  row(2, S('A2', 2), N('B2', 420.5, 2), S('C2', 10)),
  row(3, S('A3', 3), N('B3', 380, 2), S('C3', 10)),
  row(4, S('A4', 4), F('B4', 'SUBTOTAL(9,B2:B3)', 2)),
  row(5, S('A5', 5), N('B5', 150, 2), S('C5', 11)),
  row(6, S('A6', 6), F('B6', 'SUBTOTAL(9,B5:B5)', 2)),
  row(7, S('A7', 7), F('B7', 'SUBTOTAL(9,B2:B6)', 3)),
  row(8, F('A8', 'IF(B7>900,"over","within")'), F('B8', 'SUMIFS(B2:B6,C2:C6,"travel")'), F('C8', 'COUNTIFS(C2:C6,"travel",B2:B6,">400")')),
  row(9, F('A9', 'INDEX(A2:A6,MATCH("Food",A2:A6,0))'), F('B9', 'VLOOKUP("Hotel",A2:B6,2,FALSE)'), F('C9', 'ROUND(B7/3,2)')),
  row(10, F('A10', 'TEXT(B7,"0.0")'), F('B10', 'IFERROR(1/0,"none")'), F('C10', 'COUNTA(A2:A7)')),
  row(11, F('A11', 'A12+1'), F('B11', 'XLOOKUP("x",A2:A6,B2:B6)'), F('C11', 'B2/0', 4)),
  row(12, F('A12', 'A11+1'), N('B12', 46308, 5), F('C12', 'DATE(2026,10,13)', 5)),
].join('');
// Summary first, reading Costs: a forward reference across sheets.
const summary = [
  row(1, S('A1', 0, 1), S('B1', 1, 1)),
  row(2, S('A2', 7), F('B2', 'Costs!B7', 3)),
  row(3, S('A3', 2), F('B3', "'Costs'!B2*2")),
  row(5, S('A5', 12)),
].join('');

const book = (): Uint8Array => openpyxlBook([
  {
    name: 'Summary', data: summary,
    before: '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="24" customWidth="1"/></cols>',
    after: '<mergeCells count="1"><mergeCell ref="A5:B5"/></mergeCells>',
  },
  {
    name: 'Costs', data: costs,
    after: '<conditionalFormatting sqref="B2:B3 B5"><cfRule type="cellIs" dxfId="0" priority="2" operator="greaterThan"><formula>400</formula></cfRule></conditionalFormatting>'
      + '<conditionalFormatting sqref="A2:C6"><cfRule type="expression" dxfId="1" priority="1"><formula>$C2="food"</formula></cfRule></conditionalFormatting>',
  },
], strings);

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'office', 'trip.xlsx');
// Every formula cached, as buddi's fill leaves one: an IF that returned "" is a `str` with an empty `<v>`.
const CACHED_TEXT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '__fixtures__', 'office', 'cached-text.xlsx');
const cachedText = (): Uint8Array => openpyxlBook([{
  name: 'Budget',
  data: row(1, S('A1', 0, 1), S('B1', 1, 1), S('C1', 1, 1)) + row(2, S('A2', 2), N('B2', 95.5, 2), '<c r="C2" t="str"><f>IF(B2=0,"",B2-100)</f><v></v></c>')
    + row(3, S('A3', 7), '<c r="B3" s="3"><f>SUM(B2:B2)</f><v>95.5</v></c>'),
}], strings);

describe('reading a workbook openpyxl wrote', () => {
  it('is the fixture the page’s preview tests read (BUDDI_WRITE_FIXTURES=1 writes it again)', () => {
    if (process.env.BUDDI_WRITE_FIXTURES === '1') writeFileSync(FIXTURE, book());
    expect(Buffer.from(readFileSync(FIXTURE)).equals(Buffer.from(book()))).toBe(true);
  });

  it('reads values, formulas without values, the frozen header, widths and merges', () => {
    const wb = readWorkbook(book());
    expect(wb.sheets.map((s) => s.name)).toEqual(['Summary', 'Costs']);
    const [summarySheet, costSheet] = wb.sheets;
    expect(summarySheet!.frozen).toEqual({ rows: 1, cols: 0 });
    expect(summarySheet!.columns).toEqual([{ min: 1, max: 1, width: 24, hidden: false }]);
    expect(summarySheet!.merges).toEqual([{ r1: 5, c1: 1, r2: 5, c2: 2 }]);
    const b4 = costSheet!.cells.get(cellKey(4, 2))!;
    expect(b4).toMatchObject({ formula: 'SUBTOTAL(9,B2:B3)', hasValue: false, value: null, style: 2 });
    expect(costSheet!.cells.get(cellKey(2, 1))!.value).toBe('Flights');
    expect(costSheet!.conditional).toHaveLength(2);
  });

  it('resolves styles: theme colours with tint, bold white on accent, borders, alignment, number formats', () => {
    const { styles } = readWorkbook(book());
    expect(styles.cells[1]).toMatchObject({ bold: true, color: '#FFFFFF', fill: '#4F81BD', align: 'center' });
    expect(styles.cells[3]).toMatchObject({ bold: true, numFmt: '"€"#,##0.00;[Red]-"€"#,##0.00', border: { top: { weight: 'thin', color: '#000000' }, bottom: { weight: 'thick' } } });
    expect(styles.cells[4]).toMatchObject({ italic: true, numFmt: '0.00%', wrap: true });
    expect(styles.cells[4]!.fill).toMatch(/^#D[0-9A-F]{5}$/);
    expect(styles.dxfs[0]).toEqual({ color: '#9C0006', fill: '#FFC7CE' });
  });
});

describe('the engine', () => {
  it('computes SUM-style subtotals that skip each other, IF, SUMIFS, COUNTIFS, INDEX/MATCH, VLOOKUP, ROUND, TEXT, IFERROR, COUNTA and cross-sheet references', async () => {
    const wb = readWorkbook(book());
    const evaluation = await evaluate(wb);
    const at = (sheet: string, ref: string): unknown => evaluation.values.get(sheet)?.get(cellKey(Number(ref.slice(1)), ref.charCodeAt(0) - 64));
    expect(at('Costs', 'B4')).toBe(800.5);
    expect(at('Costs', 'B6')).toBe(150);
    expect(at('Costs', 'B7')).toBe(950.5);
    expect(at('Costs', 'A8')).toBe('over');
    expect(at('Costs', 'B8')).toBe(800.5);
    expect(at('Costs', 'C8')).toBe(1);
    expect(at('Costs', 'A9')).toBe('Food');
    expect(at('Costs', 'B9')).toBe(380);
    expect(at('Costs', 'C9')).toBe(316.83);
    expect(at('Costs', 'A10')).toBe('950.5');
    expect(at('Costs', 'B10')).toBe('none');
    expect(at('Costs', 'C10')).toBe(6);
    expect(at('Costs', 'C11')).toEqual({ error: '#DIV/0!' });
    expect(at('Costs', 'C12')).toBe(46308);
    expect(at('Summary', 'B2')).toBe(950.5);
    expect(at('Summary', 'B3')).toBe(841);
  });

  it('gives a circular reference #REF! and an unknown function #NAME?, and leaves them without a value', async () => {
    const evaluation = await evaluate(readWorkbook(book()));
    const failures = Object.fromEntries(evaluation.failed.map((f) => [`${f.sheet}!${f.cell}`, f]));
    expect(failures['Costs!A11']).toMatchObject({ error: '#REF!', reason: 'a circular reference' });
    expect(failures['Costs!A12']).toMatchObject({ error: '#REF!', reason: 'it reads Costs!A11, which buddi could not compute' });
    expect(failures['Costs!B11']).toMatchObject({ error: '#NAME?', formula: 'XLOOKUP("x",A2:A6,B2:B6)' });
    expect(failures['Costs!B11']!.reason).toMatch(/XLOOKUP is not one buddi computes/);
    const costSheet = readWorkbook(book()).sheets[1]!;
    expect(valueOf(evaluation, costSheet, costSheet.cells.get(cellKey(11, 2))!)).toEqual({ error: '#NAME?' });
  });

  it('stops at its caps: formulas per workbook', async () => {
    const evaluation = await evaluate(readWorkbook(book()), { limits: { formulas: 3 } });
    expect(evaluation.computed).toBeLessThanOrEqual(3);
    expect(evaluation.failed.some((f) => /more than 3 formulas/.test(f.reason))).toBe(true);
  });

  it('reads Excel criteria', () => {
    expect(criterion('>400')(420)).toBe(true);
    expect(criterion('>400')('420')).toBe(false);
    expect(criterion('<>')('x')).toBe(true);
    expect(criterion('Fl*')('Flights')).toBe(true);
    expect(criterion('travel')('Travel')).toBe(true);
    expect(criterion(5)(5)).toBe(true);
  });

  it('moves a formula’s relative references, keeping $ parts and text', () => {
    expect(shiftFormula('$C2="food"', 3, 1)).toBe('$C5="food"');
    expect(shiftFormula('SUM(B2:B3)+Costs!A1+"B2"', 1, 1)).toBe('SUM(C3:C4)+Costs!B2+"B2"');
    expect(shiftFormula('LOG10(A1)', 1, 0)).toBe('LOG10(A2)');
  });
});

describe('number formats', () => {
  it('formats currency, percent, dates and negatives in red', () => {
    const euro = '"€"#,##0.00;[Red]-"€"#,##0.00';
    expect(formatCell(1234.5, euro)).toEqual({ text: '€1,234.50' });
    expect(formatCell(-12, euro)).toEqual({ text: '-€12.00', color: '#C00000' });
    expect(formatCell(0.256, '0.0%').text).toBe('25.6%');
    expect(formatCell(46308, 'd mmm yyyy').text).toBe('13 Oct 2026');
    expect(formatCell(1234.5678, '#,##0.00').text).toBe('1,234.57');
    expect(formatCell(0.1 + 0.2, 'General').text).toBe('0.3');
    expect(formatCell({ error: '#REF!' }, '0.00').text).toBe('#REF!');
    expect(formatCell(true).text).toBe('TRUE');
    expect(formatCell('text', '0.00').text).toBe('text');
  });
});

describe('conditional formatting', () => {
  it('applies cellIs and expression rules in priority order', async () => {
    const wb = readWorkbook(book());
    const sheet = wb.sheets[1]!;
    const engine = await sheetEngine(wb);
    const valueAt = (r: number, c: number) => {
      const cell = sheet.cells.get(cellKey(r, c));
      return cell ? valueOf(engine.evaluation, sheet, cell) : null;
    };
    const styles = conditionalStyles(wb, sheet, { r1: 1, c1: 1, r2: 12, c2: 3 }, valueAt, engine);
    expect(styles.get(cellKey(2, 2))).toEqual({ color: '#9C0006', fill: '#FFC7CE' });
    expect(styles.get(cellKey(3, 2))).toBeUndefined();
    expect(styles.get(cellKey(5, 1))).toEqual({ bold: true });
    expect(styles.get(cellKey(5, 2))).toEqual({ bold: true });
    expect(styles.get(cellKey(2, 1))).toBeUndefined();
  });
});

describe('the fill', () => {
  it('writes each computed value with its type and asks the app to recalculate, leaving what it could not compute', async () => {
    const filled = await fillCachedValues(book());
    const parts = unzipSync(filled.bytes);
    const costXml = new TextDecoder().decode(parts['xl/worksheets/sheet2.xml']);
    expect(costXml).toContain('<c r="B7" s="3"><f>SUBTOTAL(9,B2:B6)</f><v>950.5</v></c>');
    expect(costXml).toContain('<c r="A8" t="str"><f>IF(B7&gt;900,"over","within")</f><v>over</v></c>');
    expect(costXml).toContain('<c r="C11" s="4" t="e"><f>B2/0</f><v>#DIV/0!</v></c>');
    expect(costXml).toContain('<c r="B11"><f>XLOOKUP("x",A2:A6,B2:B6)</f><v></v></c>');
    expect(costXml).toContain('<c r="A11"><f>A12+1</f><v></v></c>');
    const summaryXml = new TextDecoder().decode(parts['xl/worksheets/sheet1.xml']);
    expect(summaryXml).toContain('<c r="B2" s="3"><f>Costs!B7</f><v>950.5</v></c>');
    expect(new TextDecoder().decode(parts['xl/workbook.xml'])).toContain('<calcPr calcId="124519" fullCalcOnLoad="1"/>');
    // Read back, the file carries its values.
    const again = readWorkbook(filled.bytes);
    expect(again.sheets[1]!.cells.get(cellKey(7, 2))).toMatchObject({ value: 950.5, hasValue: true });
    expect(again.sheets[1]!.cells.get(cellKey(8, 1))).toMatchObject({ value: 'over', hasValue: true });
    expect(filled.evaluation.failed.map((f) => f.cell).sort()).toEqual(['A11', 'A12', 'B11']);
  });

  it('puts fullCalcOnLoad where the schema has it when a workbook has no calcPr', () => {
    expect(withFullCalcOnLoad('<workbook><sheets><sheet/></sheets><definedNames/></workbook>')).toBe('<workbook><sheets><sheet/></sheets><definedNames/><calcPr fullCalcOnLoad="1"/></workbook>');
    expect(withFullCalcOnLoad('<workbook><calcPr/></workbook>')).toBe('<workbook><calcPr fullCalcOnLoad="1"/></workbook>');
    expect(address(12, 28)).toBe('AB12');
  });
});

describe('what the review found', () => {
  const one = (data: string, workbook?: string): Uint8Array => openpyxlBook([{ name: 'S', data }], strings, workbook);
  const valueAt = async (bytes: Uint8Array, ref: string, opts?: Parameters<typeof evaluate>[1]) => {
    const wb = readWorkbook(bytes);
    const evaluation = await evaluate(wb, opts);
    const at = { row: Number(ref.slice(1)), col: ref.charCodeAt(0) - 64 };
    return { value: evaluation.values.get(wb.sheets[0]!.name)?.get(cellKey(at.row, at.col)), evaluation };
  };

  it('refuses a range too large to calculate, and reads a whole column to the last used row', async () => {
    const sparse = one(row(1, N('A1', 1), F('B1', 'SUM(A1:XFD1048576)')) + row(1048576, N('XFD1048576', 1)));
    const { evaluation } = await valueAt(sparse, 'B1');
    expect(evaluation.failed[0]).toMatchObject({ cell: 'B1', error: '#REF!', reason: expect.stringMatching(/a range too large to calculate/) });
    const column = one(row(1, N('A1', 2), F('B1', 'SUM(A:A)')) + row(3, N('A3', 5)));
    expect((await valueAt(column, 'B1')).value).toBe(7);
    const total = one(row(1, N('A1', 1), F('B1', 'SUM(A1:A100)'), F('C1', 'SUM(A1:A100)')));
    const capped = await valueAt(total, 'C1', { limits: { cellsRead: 150 } });
    expect(capped.evaluation.failed.map((f) => f.cell)).toEqual(['C1']);
  });

  it('inflates a package only within the Office limits, never past what its directory declares', () => {
    expect(() => readWorkbook(book(), { entries: 2_000, entryBytes: 500, totalBytes: 200 * 1024 * 1024 })).toThrow(/unpacks to more than/);
    expect(() => readWorkbook(book(), { entries: 3, entryBytes: 50 * 1024 * 1024, totalBytes: 200 * 1024 * 1024 })).toThrow(/at most 3/);
    // A sheet that says it is 64 bytes is inflated into 64 bytes.
    const bytes = new Uint8Array(book());
    const view = new DataView(bytes.buffer);
    for (let i = 0; i + 46 < bytes.length; i++) {
      if (view.getUint32(i, true) !== 0x02014b50) continue;
      const nameLength = view.getUint16(i + 28, true);
      const name = new TextDecoder().decode(bytes.subarray(i + 46, i + 46 + nameLength));
      if (name === 'xl/worksheets/sheet2.xml') view.setUint32(i + 24, 64, true);
    }
    let read: ReturnType<typeof readWorkbook> | null = null;
    try { read = readWorkbook(bytes); } catch { read = null; }
    expect(read === null || read.sheets[1]!.cells.size === 0).toBe(true);
  });

  it('keeps a range’s size, blanks included', async () => {
    expect((await valueAt(one(row(1, N('A1', 1), F('B1', 'COUNTBLANK(A1:A10)'))), 'B1')).value).toBe(9);
  });

  it('passes an error in the range through SUMIFS, AVERAGEIFS and SUBTOTAL', async () => {
    const data = row(1, F('A1', '1/0'), N('B1', 1), F('C1', 'SUMIFS(A1:A2,B1:B2,1)'), F('D1', 'SUBTOTAL(9,A1:A2)'), F('E1', 'AVERAGEIFS(A1:A2,B1:B2,1)'), F('F1', 'SUBTOTAL(2,A1:A2)'))
      + row(2, N('A2', 5), N('B2', 2));
    const wb = readWorkbook(one(data));
    const values = (await evaluate(wb)).values.get('S')!;
    expect(values.get(cellKey(1, 3))).toEqual({ error: '#DIV/0!' });
    expect(values.get(cellKey(1, 4))).toEqual({ error: '#DIV/0!' });
    expect(values.get(cellKey(1, 5))).toEqual({ error: '#DIV/0!' });
    expect(values.get(cellKey(1, 6))).toBe(1);
  });

  it('fills every formula from what the others now compute, not from their stale values', async () => {
    const stale = one(row(1, '<c r="A1"><f>2+2</f><v>1</v></c>', F('B1', 'A1*2')));
    const filled = await fillCachedValues(stale);
    const xml = new TextDecoder().decode(unzipSync(filled.bytes)['xl/worksheets/sheet1.xml']);
    expect(xml).toContain('<c r="A1"><f>2+2</f><v>4</v></c>');
    expect(xml).toContain('<c r="B1"><f>A1*2</f><v>8</v></c>');
  });

  it('keeps a 1904 workbook’s dates in its own epoch', async () => {
    const workbook = `<?xml version="1.0"?><workbook ${NS}><workbookPr date1904="1"/><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    const bytes = one(row(1, F('A1', 'DATE(2026,10,13)', 5), F('B1', 'YEAR(A1)'), F('C1', 'TEXT(A1,"d mmm yyyy")')), workbook);
    const wb = readWorkbook(bytes);
    expect(wb.date1904).toBe(true);
    const values = (await evaluate(wb)).values.get('S')!;
    expect(values.get(cellKey(1, 1))).toBe(46308 - 1462);
    expect(values.get(cellKey(1, 2))).toBe(2026);
    expect(values.get(cellKey(1, 3))).toBe('13 Oct 2026');
    expect(formatCell(46308 - 1462, 'd mmm yyyy', { date1904: true }).text).toBe('13 Oct 2026');
  });

  it('counts an empty text with COUNTA, and with SUBTOTAL’s COUNTA', async () => {
    // A1 is a formula giving "", A2 a number, A3 empty.
    const data = row(1, F('A1', '""'), F('B1', 'COUNTA(A1:A3)'), F('C1', 'COUNTA("")'), F('D1', 'SUBTOTAL(3,A1:A3)')) + row(2, N('A2', 3));
    const values = (await evaluate(readWorkbook(one(data)))).values.get('S')!;
    expect(values.get(cellKey(1, 2))).toBe(2);
    expect(values.get(cellKey(1, 3))).toBe(1);
    expect(values.get(cellKey(1, 4))).toBe(2);
  });

  it('reads attributes in either quote with space around =, and fills such a cell', async () => {
    const workbook = `<?xml version="1.0"?><workbook ${NS}><sheets><sheet name = 'Quoted' sheetId='1' r:id = 'rId1'/></sheets><calcPr calcId = '1' fullCalcOnLoad = '0'/></workbook>`;
    const bytes = one(`<row r='1'><c r = 'A1'><v>2</v></c><c r='B1' t = 'n'><f>A1*3</f></c></row>`, workbook);
    const wb = readWorkbook(bytes);
    expect(wb.sheets.map((s) => s.name)).toEqual(['Quoted']);
    expect(wb.sheets[0]!.cells.get(cellKey(1, 1))?.value).toBe(2);
    const filled = await fillCachedValues(bytes);
    const parts = unzipSync(filled.bytes);
    expect(new TextDecoder().decode(parts['xl/worksheets/sheet1.xml'])).toContain("<c r='B1'><f>A1*3</f><v>6</v></c>");
    expect(new TextDecoder().decode(parts['xl/workbook.xml'])).toContain("<calcPr calcId = '1' fullCalcOnLoad=\"1\"/>");
  });

  it('takes the leading = off every stored formula, cell and conditional rule, which Numbers refuses, and reads both forms alike', async () => {
    const cf = '<conditionalFormatting sqref="A1:B1"><cfRule type="expression" dxfId="0" priority="1"><formula>=AND($A1&lt;&gt;"",$A1&gt;1)</formula></cfRule></conditionalFormatting>';
    const bytes = openpyxlBook([{ name: 'S', data: row(1, N('A1', 2), '<c r="B1"><f>=A1*3</f></c>', '<c r="C1"><f t="shared" ref="C1:C2" si="0">=A1+1</f></c>'), after: cf }], strings);
    const before = readWorkbook(bytes).sheets[0]!;
    expect(before.cells.get(cellKey(1, 2))).toMatchObject({ formula: 'A1*3', storedWithEquals: true });
    expect(before.conditional[0]!.rules[0]).toMatchObject({ formulas: ['AND($A1<>"",$A1>1)'], storedWithEquals: true });
    const filled = await fillCachedValues(bytes);
    const xml = new TextDecoder().decode(unzipSync(filled.bytes)['xl/worksheets/sheet1.xml']);
    expect(xml).toContain('<c r="B1"><f>A1*3</f><v>6</v></c>');
    expect(xml).toContain('<f t="shared" ref="C1:C2" si="0">A1+1</f><v>3</v>');
    expect(xml).toContain('<formula>AND($A1&lt;&gt;"",$A1&gt;1)</formula>');
    expect(xml).not.toMatch(/<f\b[^>]*>\s*=|<formula>\s*=/);
    const after = readWorkbook(filled.bytes).sheets[0]!;
    expect(after.cells.get(cellKey(1, 2))).toMatchObject({ formula: 'A1*3', value: 6 });
    expect(after.cells.get(cellKey(1, 2))!.storedWithEquals).toBeUndefined();
    expect(after.conditional[0]!.rules[0]!.storedWithEquals).toBeUndefined();
    // A formula without one, a self-closing <f/> and an = inside a formula are left as they are.
    expect(withoutLeadingEquals('<f>A1=1</f><f t="shared" si="0"/><formula>$A1="x"</formula>')).toBe('<f>A1=1</f><f t="shared" si="0"/><formula>$A1="x"</formula>');
  });

  it('counts a cached empty text (an IF that returned "") as a saved value, and openpyxl’s untyped empty <v> as none (cached-text.xlsx, BUDDI_WRITE_FIXTURES=1 writes it again)', () => {
    if (process.env.BUDDI_WRITE_FIXTURES === '1') writeFileSync(CACHED_TEXT, cachedText());
    expect(Buffer.from(readFileSync(CACHED_TEXT)).equals(Buffer.from(cachedText()))).toBe(true);
    expect([...readWorkbook(cachedText()).sheets[0]!.cells.values()].filter((c) => c.formula !== undefined).every((c) => c.hasValue)).toBe(true);
    const data = row(1, '<c r="A1" t="str"><f>IF(1=0,"",1)</f><v></v></c>', F('B1', 'A1&"x"'));
    const sheet = readWorkbook(one(data)).sheets[0]!;
    expect(sheet.cells.get(cellKey(1, 1))).toMatchObject({ value: '', hasValue: true });
    expect(sheet.cells.get(cellKey(1, 2))).toMatchObject({ value: null, hasValue: false });
  });
});
