import { describe, expect, it } from 'vitest';
import { nextVersion, parseJsonTable, safeName, toCsv, versionedName } from './document.js';

describe('document names', () => {
  it('keeps a title readable and makes it safe as a file name', () => {
    expect(safeName('Heat pumps compared', 100, 'Document')).toBe('Heat pumps compared');
    expect(safeName('../../etc/passwd', 100, 'Document')).toBe('etc-passwd');
    expect(safeName('..', 100, 'Document')).toBe('Document');
    expect(safeName('a\\b:c*d?e"f<g>h|i', 100, 'Document')).toBe('a-b-c-d-e-f-g-h-i');
    expect(safeName('line\none\u0000two', 100, 'Document')).toBe('line one two');
    expect(safeName('.hidden', 100, 'Document')).toBe('hidden');
    expect(safeName('CON', 100, 'Document')).toBe('CON-file');
    expect(safeName('word '.repeat(40), 30, 'Document').length).toBeLessThanOrEqual(30);
    expect(safeName('   ', 100, 'Document')).toBe('Document');
  });

  it('counts versions per base name, ignoring case and other titles', () => {
    expect(nextVersion('Report', 'md', [])).toBe(1);
    expect(nextVersion('Report', 'md', ['Report.md'])).toBe(2);
    expect(nextVersion('Report', 'md', ['report.md', 'Report (v3).md', 'Other.md', null])).toBe(4);
    expect(nextVersion('Report', 'md', ['Report.csv', 'Report (draft).md'])).toBe(1);
    expect(nextVersion('A (b)', 'md', ['A (b).md'])).toBe(2);
    expect(versionedName('Report', 'md', 1)).toBe('Report.md');
    expect(versionedName('Report', 'md', 2)).toBe('Report (v2).md');
  });
});

describe('JSON tables', () => {
  it('reads an array of objects, keys in first-seen order', () => {
    const t = parseJsonTable('[{"Month":"Jan","Total":120},{"Month":"Feb","Note":"late"}]');
    expect(t.columns).toEqual(['Month', 'Total', 'Note']);
    expect(t.rows).toEqual([['Jan', 120, undefined], ['Feb', undefined, 'late']]);
  });

  it('reads arrays with a header, and { columns, rows }', () => {
    expect(parseJsonTable('[["a","b"],[1,2]]')).toEqual({ columns: ['a', 'b'], rows: [[1, 2]] });
    expect(parseJsonTable('{"columns":["a"],"rows":[[1],[2]]}')).toEqual({ columns: ['a'], rows: [[1], [2]] });
  });

  it('refuses what is not a table, saying what to send', () => {
    expect(() => parseJsonTable('not json')).toThrow(/array of objects/);
    expect(() => parseJsonTable('{"a":1}')).toThrow(/array of objects/);
    expect(() => parseJsonTable('[]')).toThrow(/array of objects/);
  });

  it('writes CSV that quotes what needs quoting', () => {
    expect(toCsv(['Name', 'Note'], [['Ann', 'says "hi", twice'], ['Bo', null]])).toBe('Name,Note\r\nAnn,"says ""hi"", twice"\r\nBo,\r\n');
  });
});
