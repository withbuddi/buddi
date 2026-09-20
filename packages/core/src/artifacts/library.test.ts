import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, familyOf, filterKey, listLibrary, textPreviewable } from './library.js';

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
    expect(params).toContain('produced');
    expect(params).toContain('pdf');
    expect(sql).toContain('(a.created_at, a.id) <');
  });
});
