import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, familyOf, filterKey, listLibrary } from './library.js';
import { isTextFile as textPreviewable } from '../text-files.js';
import { FAMILY_LABEL } from '../file-families.js';
import { isPdf, madeDocumentOf, OFFICE_MIME } from '../office-files.js';

describe('the library', () => {
  it('classifies families from the mime first and the extension second', () => {
    expect(familyOf('image/png')).toBe('image');
    expect(familyOf('application/pdf', 'x.bin')).toBe('pdf');
    expect(familyOf('application/octet-stream', 'rows.csv')).toBe('table');
    expect(familyOf('application/octet-stream', 'notes.md')).toBe('text');
    expect(familyOf('text/html', 'page.html')).toBe('code');
    expect(familyOf('application/zip')).toBe('archive');
    expect(familyOf('application/octet-stream', 'blob')).toBe('file');
  });

  it('classifies Office files by core’s Office rule, never as code or an archive', () => {
    // Owner's test on b9a8fe77: a .docx listed as "Code · 10 KB" (its mime says "xml").
    expect(familyOf(OFFICE_MIME.docx, 'Letter.docx')).toBe('text');
    expect(familyOf(OFFICE_MIME.xlsx, 'Budget.xlsx')).toBe('table');
    expect(familyOf(OFFICE_MIME.pptx, 'Deck.pptx')).toBe('presentation');
    expect(familyOf('application/octet-stream', 'Deck.pptx')).toBe('presentation');
    expect(familyOf('application/zip', 'Letter.docx')).toBe('text');
    expect(familyOf('application/vnd.ms-powerpoint', 'old.ppt')).toBe('presentation');
    expect(familyOf(`${OFFICE_MIME.docx}; charset=binary`, 'Letter.docx')).toBe('text');
    // One PDF rule: an untyped .pdf is a PDF to the family, the preview and a made document alike.
    expect(familyOf('application/octet-stream', 'Report.pdf')).toBe('pdf');
    expect(isPdf('application/octet-stream', 'Report.pdf')).toBe(true);
    expect(madeDocumentOf('application/octet-stream', 'Report.pdf')).toBe('pdf');
    expect(familyOf('text/plain', 'Report.pdf')).not.toBe('pdf');
    expect([FAMILY_LABEL.text, FAMILY_LABEL.table, FAMILY_LABEL.presentation]).toEqual(['Document', 'Spreadsheet', 'Presentation']);
  });

  it('previews as text only what is genuinely text, never an Office container', () => {
    expect(textPreviewable('text/plain', 'notes.txt')).toBe(true);
    expect(textPreviewable('application/octet-stream', 'rows.csv')).toBe(true);
    expect(textPreviewable('text/html', 'page.html')).toBe(true);
    expect(textPreviewable('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'memo.docx')).toBe(false);
    expect(textPreviewable('text/plain', 'sheet.xlsx')).toBe(false);
    expect(textPreviewable('application/octet-stream', 'blob.bin')).toBe(false);
  });

  it('round-trips a cursor and refuses one it did not issue', () => {
    const key = filterKey({ q: 'tax' });
    const cursor = encodeCursor('2026-09-20T10:00:00.000Z', '0f6eda1f-2ac5-4a79-b9f1-548d216a797a', key);
    expect(decodeCursor(cursor, key)).toEqual({ createdAt: '2026-09-20T10:00:00.000Z', id: '0f6eda1f-2ac5-4a79-b9f1-548d216a797a' });
    // Issued under one search, refused under another.
    expect(decodeCursor(cursor, filterKey({ q: 'rent' }))).toBeNull();
    expect(decodeCursor('zzz')).toBeNull();
    expect(decodeCursor(Buffer.from('not-a-date|nope').toString('base64url'))).toBeNull();
  });

  it('escapes the search and binds the filters and the cursor as parameters', async () => {
    const seen: Array<{ sql: string; params: any[] }> = [];
    const pool = { query: async (sql: string, params: any[] = []) => { seen.push({ sql, params }); return { rows: [] }; } };
    const filters = { q: "50%_off'", origin: 'produced' as const, family: 'pdf' as const };
    await listLibrary(pool, { ...filters, cursor: encodeCursor('2026-09-20T10:00:00.000Z', '0f6eda1f-2ac5-4a79-b9f1-548d216a797a', filterKey(filters)), knownAgentIds: ['ledger'] });
    const { sql, params } = seen[0]!;
    expect(params[1]).toBe("%50\\%\\_off'%");
    expect(sql).not.toContain("off'");
    // The label a document was filed under is found by the same search.
    expect(sql).toContain('a.caption ilike');
    expect(params).toContain('produced');
    expect(params).toContain('pdf');
    expect(sql).toContain('(a.created_at, a.id) <');
  });

  it('issues the next cursor from the timestamp as the database wrote it, not a rounded one', async () => {
    const exact = '2026-09-20 10:00:00.123456+00';
    const row = (id: string) => ({ id, filename: 'a', mime: 'text/plain', size_bytes: 1, created_at: new Date('2026-09-20T10:00:00.123Z'), created_at_exact: exact, created_by: 'owner', deleted_at: null, origin: 'uploaded', family: 'text', contexts: 0, use_agent: null, context_agent: null, context_group: null });
    const pool = { query: async () => ({ rows: [row('0f6eda1f-2ac5-4a79-b9f1-548d216a797a'), row('1f6eda1f-2ac5-4a79-b9f1-548d216a797a')] }) };
    const page = await listLibrary(pool, { limit: 1, knownAgentIds: [] });
    expect(page.next).not.toBeNull();
    expect(decodeCursor(page.next!, filterKey({}))?.createdAt).toBe(exact);
  });
});
