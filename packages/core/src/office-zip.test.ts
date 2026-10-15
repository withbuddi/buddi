/**
 * The zip limit rule as each part truly inflates (`office-zip.ts`): a
 * package whose directory understates a part's size passes the directory
 * check (`lying.docx`, `lying.xlsx`: 30 MB declared as 2 KB and 4 KB) and is
 * refused while it inflates; an honest one is handed on as a copy whose
 * directory states the true sizes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { zipEntries } from './office-files.js';
import { editOfficePackage, officePackageProblem, unzipOffice, verifiedOfficePackage } from './office-zip.js';
import { readWorkbook } from './sheet/read.js';

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__/office', name)));

describe('an Office package, as its parts truly inflate', () => {
  it('refuses a part that inflates past the size its directory declares', () => {
    const lying = fixture('lying.docx');
    // The directory alone is within every limit: the old check let it through.
    const entries = zipEntries(lying);
    expect(Array.isArray(entries) && entries.find((e) => e.name === 'word/document.xml')?.size).toBe(2048);
    const started = performance.now();
    expect(officePackageProblem(lying, 'docx')).toBe('word/document.xml unpacks to more than its zip directory says');
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(verifiedOfficePackage(lying, 'docx')).toBe('word/document.xml unpacks to more than its zip directory says');
    expect(unzipOffice(lying)).toMatch(/unpacks to more than/);
  });

  it('refuses it in the sheet engine too, which reads with the same rule', () => {
    expect(() => readWorkbook(fixture('lying.xlsx'))).toThrow(/xl\/worksheets\/sheet1\.xml unpacks to more than its zip directory says/);
    expect(officePackageProblem(fixture('lying.xlsx'), 'xlsx')).toMatch(/unpacks to more than/);
  });

  it('reads a workbook with one cell in its far corner as two cells, not a rectangle', () => {
    const [sheet] = readWorkbook(fixture('far-corner.xlsx')).sheets;
    expect(sheet!.cells.size).toBe(2);
    expect([sheet!.maxRow, sheet!.maxCol]).toEqual([1_048_576, 16_384]);
  });

  it('hands an honest package on as the same parts under a directory of true sizes', () => {
    for (const [name, kind] of [['letter.docx', 'docx'], ['budget.xlsx', 'xlsx'], ['deck.pptx', 'pptx']] as const) {
      const original = fixture(name);
      const verified = verifiedOfficePackage(original, kind);
      if (typeof verified === 'string') throw new Error(verified);
      const before = unzipSync(original);
      const after = unzipSync(verified);
      expect(Object.keys(after).sort()).toEqual(Object.keys(before).filter((n) => !n.endsWith('/')).sort());
      for (const part of Object.keys(after)) expect(after[part]).toEqual(before[part]);
      expect(officePackageProblem(verified, kind)).toBeNull();
    }
  });

  it('still refuses the honest bomb from its directory, and a damaged or foreign file', () => {
    expect(officePackageProblem(fixture('bomb.docx'), 'docx')).toMatch(/unpacks to more than 50 MB/);
    expect(officePackageProblem(fixture('deck.pptx'), 'docx')).toBe('it has no word/document.xml');
    const whole = fixture('letter.docx');
    expect(officePackageProblem(whole.subarray(0, whole.length - 200), 'docx')).toMatch(/not a zip|damaged/);
  });

  it('edits XML parts of a package within the same limits', () => {
    const edited = editOfficePackage(fixture('letter.docx'), (name, xml) => (name === 'word/document.xml' ? xml.replace('Revenue', 'Income') : null));
    if (typeof edited === 'string') throw new Error(edited);
    expect(strFromU8(unzipSync(edited)['word/document.xml']!)).toContain('Income grew');
    expect(editOfficePackage(fixture('lying.docx'), () => null)).toMatch(/unpacks to more than/);
  });
});
