import { describe, expect, it } from 'vitest';
import { MAX_DOCUMENT_CHARS, MAX_TABLE_COLUMNS, parseJsonTable, toCsv } from './document.js';

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

  it('refuses many distinct keys while scanning, before building rows × keys cells', () => {
    // 30,000 one-key objects, every key new: 900 million cells if built first.
    const content = JSON.stringify(Array.from({ length: 30_000 }, (_, i) => ({ [`k${i}`]: 1 })));
    expect(content.length).toBeLessThan(MAX_DOCUMENT_CHARS);
    const started = performance.now();
    expect(() => parseJsonTable(content)).toThrow(new RegExp(`at most ${MAX_TABLE_COLUMNS} columns`));
    // Building them first takes many seconds; a slow shared runner takes well under two.
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('refuses a table past the cell budget, and a row wider than its header, in every shape', () => {
    const keys = Array.from({ length: 200 }, (_, i) => `c${i}`);
    const wide = JSON.stringify(Array.from({ length: 5_001 }, (_, r) => (r === 0 ? Object.fromEntries(keys.map((k) => [k, 1])) : { c0: r })));
    const started = performance.now();
    expect(() => parseJsonTable(wide)).toThrow(/cells/);
    // Building them first takes many seconds; a slow shared runner takes well under two.
    expect(performance.now() - started).toBeLessThan(2000);
    expect(() => parseJsonTable('[["a","b"],[1,2,3]]')).toThrow(/row 1 has 3 cells; the header has 2/);
    expect(() => parseJsonTable('{"columns":["a"],"rows":[[1],[2,3]]}')).toThrow(/row 2 has 2 cells/);
    expect(() => parseJsonTable('{"columns":["a"],"rows":[1]}')).toThrow(/array of cells/);
    expect(() => parseJsonTable(JSON.stringify([Array.from({ length: 201 }, (_, i) => `c${i}`)]))).toThrow(/at most 200/);
    // A short row is allowed: its missing cells are empty.
    expect(parseJsonTable('[["a","b"],[1]]').rows).toEqual([[1]]);
  });

  it('writes CSV that quotes what needs quoting', () => {
    expect(toCsv(['Name', 'Note'], [['Ann', 'says "hi", twice'], ['Bo', null]])).toBe('Name,Note\r\nAnn,"says ""hi"", twice"\r\nBo,\r\n');
  });
});
