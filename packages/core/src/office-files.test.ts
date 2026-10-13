import { describe, expect, it } from 'vitest';
import { OFFICE_MIME, officeKindOf, officeRebuildRefusal, opensInApp } from './office-files.js';
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
