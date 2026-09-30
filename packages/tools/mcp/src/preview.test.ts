import { describe, expect, it } from 'vitest';
import { callPreview, describeValue, humanTool } from './preview.js';

describe('the approval preview', () => {
  it('names the call in words and summarises each argument, never raw JSON', () => {
    const text = callPreview({
      tool: 'update_document',
      where: 'CDC Training (a program on this computer)',
      destructive: true,
      input: { collection: 'rapport', id: 'doc-42', data: { title: 'Déclaration générale, Exercice 2024-60', documents: [{ _type: 'media' }], status: 'draft' } },
    });
    expect(text.split('\n')).toEqual([
      'Update document on CDC Training (a program on this computer). It can change or delete something.',
      'Collection: rapport',
      'Id: doc-42',
      'Data: 3 fields: title, documents, status',
    ]);
  });

  it('keeps lists, long text and many arguments short', () => {
    expect(humanTool('listSites')).toBe('List sites');
    expect(describeValue(['a', 'b'])).toBe('a, b');
    expect(describeValue([{}, {}])).toBe('2 items');
    expect(describeValue('x'.repeat(200))).toHaveLength(80);
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i]));
    const lines = callPreview({ tool: 'x', where: 'Y', destructive: false, input: many }).split('\n');
    expect(lines).toHaveLength(10);
    expect(lines.at(-1)).toBe('and 3 more');
  });
});
