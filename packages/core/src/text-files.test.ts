import { describe, expect, it } from 'vitest';
import { safeFileName } from './text-files.js';

describe('a file name from a title', () => {
  it('sets off punctuation between words with " - ", never "List- Two"', () => {
    expect(safeFileName('List: Two', 100, 'Document')).toBe('List - Two');
    expect(safeFileName('Q3 plan : budget / staffing', 100, 'Document')).toBe('Q3 plan - budget - staffing');
    expect(safeFileName('Taxes 2026 — draft: v2?', 100, 'Document')).toBe('Taxes 2026 — draft - v2');
  });

  it('keeps punctuation inside a word as a hyphen, and drops it at the ends', () => {
    expect(safeFileName('A/B test at 10:30', 100, 'Document')).toBe('A-B test at 10-30');
    expect(safeFileName('Why?', 100, 'Document')).toBe('Why');
    expect(safeFileName('Plan: ', 100, 'Document')).toBe('Plan');
    expect(safeFileName(': Plan', 100, 'Document')).toBe('Plan');
  });

  it('is still a safe name', () => {
    expect(safeFileName('../../etc/passwd', 100, 'Document')).toBe('etc-passwd');
    expect(safeFileName('a\\b:c*d?e"f<g>h|i', 100, 'Document')).toBe('a-b-c-d-e-f-g-h-i');
    expect(safeFileName('..', 100, 'Document')).toBe('Document');
    expect(safeFileName('nul', 100, 'Document')).toBe('nul-file');
    expect(safeFileName('line\none\u0000two', 100, 'Document')).toBe('line one two');
    expect(safeFileName('.hidden', 100, 'Document')).toBe('hidden');
    expect(safeFileName('word '.repeat(40), 30, 'Document').length).toBeLessThanOrEqual(30);
    expect(safeFileName('   ', 100, 'Document')).toBe('Document');
  });
});
