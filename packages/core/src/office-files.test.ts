import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OFFICE_MIME, OFFICE_ZIP_LIMITS, cellText, officeKindOf, officePackageProblem, officeRebuildRefusal, opensInApp, zipEntries } from './office-files.js';
import { isTextFile } from './text-files.js';

describe('which files are Office documents', () => {
  it('reads the kind from the mime first', () => {
    expect(officeKindOf(OFFICE_MIME.docx, 'Letter.docx')).toBe('docx');
    expect(officeKindOf(OFFICE_MIME.xlsx, null)).toBe('xlsx');
    expect(officeKindOf(`${OFFICE_MIME.pptx}; charset=binary`, 'x')).toBe('pptx');
    // A mime that says something else wins over the name.
    expect(officeKindOf('text/plain', 'notes.docx')).toBeNull();
    expect(officeKindOf('application/pdf', 'report.xlsx')).toBeNull();
  });

  it('falls back to the extension only for an unnamed type', () => {
    expect(officeKindOf('application/octet-stream', 'Budget.XLSX')).toBe('xlsx');
    expect(officeKindOf('', 'deck.pptx')).toBe('pptx');
    expect(officeKindOf('application/zip', 'Letter.docx')).toBe('docx');
    expect(officeKindOf('application/octet-stream', 'archive.zip')).toBeNull();
  });

  it('reads no legacy, Apple or OpenDocument format, but opens them in the owner’s app', () => {
    for (const name of ['old.doc', 'old.xls', 'old.ppt', 'a.pages', 'a.numbers', 'a.key', 'a.odt', 'a.ods', 'a.odp']) {
      expect(officeKindOf('application/octet-stream', name)).toBeNull();
      expect(opensInApp('application/octet-stream', name)).toBe(true);
    }
    expect(opensInApp(OFFICE_MIME.docx, 'a.docx')).toBe(true);
    expect(opensInApp('text/markdown', 'a.md')).toBe(false);
    expect(opensInApp('application/pdf', 'a.pdf')).toBe(false);
  });

  it('never calls an Office file text', () => {
    for (const kind of ['docx', 'xlsx', 'pptx'] as const) expect(isTextFile('application/octet-stream', `a.${kind}`)).toBe(false);
  });
});

describe('rebuilding an Office file from text', () => {
  const docx = { name: 'Plan.docx', mime: OFFICE_MIME.docx };
  it('is allowed on a file an agent made', () => {
    expect(officeRebuildRefusal({ ...docx, createdBy: 'writer' }, {})).toBeNull();
  });
  it('is refused on the owner’s own file until he agreed, saying to ask him', () => {
    const refusal = officeRebuildRefusal({ ...docx, createdBy: 'owner' }, {});
    expect(refusal).toMatch(/Ask the owner first/);
    expect(refusal).toMatch(/confirmedRebuild: true/);
    expect(officeRebuildRefusal({ ...docx, createdBy: 'owner' }, { confirmedRebuild: true })).toBeNull();
    expect(officeRebuildRefusal({ name: 'B.xlsx', mime: OFFICE_MIME.xlsx, createdBy: 'u-1' }, { ownerId: 'u-1' })).toMatch(/spreadsheet/);
  });
  it('never writes a presentation', () => {
    expect(officeRebuildRefusal({ name: 'Deck.pptx', mime: OFFICE_MIME.pptx, createdBy: 'writer' }, { confirmedRebuild: true })).toMatch(/not write it/);
  });
});

describe('an Office package’s limits, read from its zip directory', () => {
  const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__/office', name)));

  it('accepts the real packages, each with its main part', () => {
    expect(officePackageProblem(fixture('letter.docx'), 'docx')).toBeNull();
    expect(officePackageProblem(fixture('budget.xlsx'), 'xlsx')).toBeNull();
    expect(officePackageProblem(fixture('deck.pptx'), 'pptx')).toBeNull();
    expect(officePackageProblem(fixture('deck.pptx'), 'docx')).toBe('it has no word/document.xml');
  });

  it('refuses a zip bomb before inflating anything, and a half-written file', () => {
    const bomb = fixture('bomb.docx');
    expect(bomb.length).toBeLessThan(100_000);
    const started = performance.now();
    expect(officePackageProblem(bomb, 'docx')).toMatch(/word\/document\.xml unpacks to more than 50 MB/);
    expect(performance.now() - started).toBeLessThan(100);
    const whole = fixture('letter.docx');
    expect(officePackageProblem(whole.subarray(0, whole.length - 200), 'docx')).toMatch(/not a zip|damaged/);
    expect(officePackageProblem(new TextEncoder().encode('not a zip'), 'docx')).toBe('it is not a zip package');
  });

  it('counts entries and expanded bytes against the limits', () => {
    const entries = zipEntries(fixture('budget.xlsx'));
    expect(Array.isArray(entries) && entries.some((e) => e.name === 'xl/workbook.xml')).toBe(true);
    expect(zipEntries(fixture('budget.xlsx'), { ...OFFICE_ZIP_LIMITS, entries: 2 })).toMatch(/parts; at most 2/);
    expect(zipEntries(fixture('budget.xlsx'), { ...OFFICE_ZIP_LIMITS, totalBytes: 100 })).toMatch(/unpacks to more than/);
  });
});

describe('a cell as text', () => {
  it('is one rule for the agent and the page', () => {
    expect(cellText(new Date('2026-03-01T00:00:00Z'))).toBe('2026-03-01');
    expect(cellText(new Date('2026-03-01T09:30:00Z'))).toBe('2026-03-01 09:30');
    expect(cellText(true)).toBe('TRUE');
    expect(cellText(95.5)).toBe('95.5');
    expect(cellText(null)).toBe('');
    expect(cellText('=SUM(A1:A2)')).toBe('=SUM(A1:A2)');
  });
});
