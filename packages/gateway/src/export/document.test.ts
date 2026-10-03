/**
 * Every export, parsed back: the PDF's text through the same extractor the
 * agents read with, the Word file's XML, the spreadsheet through a reader.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { readSheet } from 'read-excel-file/node';
import { describe, expect, it } from 'vitest';
import { extractText } from '@buddi/tool-artifacts';
import { ExportRefused, exportBusy, runExport } from './convert.js';
import { MAX_EXPORT_SOURCE_BYTES, csvToXlsx, exportDocument, exportFormats, exportName, markdownToDocx, markdownToPdf, parseCsv } from './document.js';
import { parseMarkdown } from './markdown.js';

const REPORT = [
  '# Heat pumps compared',
  '',
  '_2 October 2026_',
  '',
  'Three models, **one** clear pick. See [the test](https://example.com/test) & notes.',
  '',
  '## Shortlist',
  '',
  '1. Daikin Altherma',
  '2. Mitsubishi Ecodan',
  '   - quiet',
  '- [x] checked the price',
  '',
  '| Model | Price |',
  '|---|--:|',
  '| Daikin | 9 800 |',
  '| Ecodan | 10 200 |',
  '',
  '```',
  'cop = heat / power',
  '```',
  '',
  '> Quiet matters most.',
  '',
  '---',
  '',
  'Sources: Which? 2026; javascript:alert(1)',
].join('\n');

describe('reading Markdown', () => {
  it('turns tokens into blocks, keeping only safe links', () => {
    const blocks = parseMarkdown('A [ok](https://a.b) and [bad](javascript:alert(1)) <b>x</b>');
    expect(blocks).toHaveLength(1);
    const runs = (blocks[0] as any).runs;
    expect(runs.find((r: any) => r.text === 'ok').link).toBe('https://a.b');
    expect(runs.find((r: any) => r.text === 'bad').link).toBeUndefined();
  });
});

describe('exports', () => {
  it('offers PDF and Word for Markdown, Excel for a table, nothing for the rest', () => {
    expect(exportFormats('text/markdown', 'a.md')).toEqual(['md', 'pdf', 'docx']);
    expect(exportFormats('text/plain', 'a.md')).toEqual(['md', 'pdf', 'docx']);
    expect(exportFormats('text/csv', 'a.csv')).toEqual(['csv', 'xlsx']);
    expect(exportFormats('image/png', 'a.png')).toEqual([]);
    expect(exportName('Report (v2).md', 'pdf')).toBe('Report (v2).pdf');
  });

  it('makes a PDF whose text reads back', async () => {
    const pdf = await markdownToPdf(REPORT, 'Heat pumps compared.md');
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    const { text } = await extractText(pdf, 'application/pdf', 100_000);
    for (const expected of ['Heat pumps compared', 'Shortlist', 'Daikin Altherma', 'Ecodan', '10 200', 'cop = heat / power', 'Quiet matters most.', '& notes']) {
      expect(text).toContain(expected);
    }
    expect(pdf.toString('latin1')).toContain('https://example.com/test');
  }, 30_000);

  it('makes a Word file with headings, lists, a table and the link', async () => {
    const docx = await markdownToDocx(REPORT, 'Heat pumps compared.md');
    const files = unzipSync(new Uint8Array(docx));
    expect(Object.keys(files)).toContain('word/document.xml');
    const xml = strFromU8(files['word/document.xml']!);
    expect(xml).toContain('Heading1');
    expect(xml).toContain('Daikin Altherma');
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('<w:numPr>');
    const rels = strFromU8(files['word/_rels/document.xml.rels']!);
    expect(rels).toContain('https://example.com/test');
    expect(rels).not.toContain('javascript:');
  });

  it('makes a spreadsheet that reads back with numbers as numbers', async () => {
    const csv = 'Item,Amount,Code\r\nRent,1200,007\r\n"Food, misc",400.5,12\r\n';
    const rows = await readSheet(await csvToXlsx(csv, 'Budget.csv'));
    expect(rows).toEqual([['Item', 'Amount', 'Code'], ['Rent', 1200, '007'], ['Food, misc', 400.5, 12]]);
  });

  it('parses quoted CSV', () => {
    expect(parseCsv('a,"b ""c""",d\n1,"x\ny"\n')).toEqual([['a', 'b "c"', 'd'], ['1', 'x\ny', '']]);
  });

  it('hands the stored format back as stored, and refuses one the file does not offer', async () => {
    const bytes = Buffer.from('# Hi\n');
    expect(await exportDocument({ bytes, mime: 'text/markdown', filename: 'a.md' }, 'md')).toBe(bytes);
    expect(await exportDocument({ bytes, mime: 'text/markdown', filename: 'a.md' }, 'xlsx')).toBeNull();
    expect(await exportDocument({ bytes, mime: 'image/png', filename: 'a.png' }, 'pdf')).toBeNull();
  });
});

describe('what a conversion refuses, quickly', () => {
  const quick = (fn: () => unknown, pattern: RegExp, ms = 1_000): void => {
    const started = performance.now();
    expect(fn).toThrow(pattern);
    expect(performance.now() - started).toBeLessThan(ms);
  };

  it('ragged CSV rows are never padded past the cell budget', () => {
    // 3 KB: one row of 1,000 columns under 1,000 one-cell rows asks for a million cells.
    const csv = `${','.repeat(999)}\n${'a\n'.repeat(1_000)}`;
    expect(csv.length).toBeLessThan(4_000);
    quick(() => parseCsv(csv), /cells; too many to convert/, 200);
    quick(() => parseCsv(`${','.repeat(1_000)}\n`), /more than 1000 columns/, 200);
  });

  it('150,000 one-column rows are refused as too many rows, not a RangeError', () => {
    quick(() => parseCsv('a\n'.repeat(150_000)), /more than 100000 rows/, 500);
    expect(parseCsv('a,b\n1\n')).toEqual([['a', 'b'], ['1', '']]);
  });

  it('runs of emphasis markers are refused before the lexer reads them', () => {
    quick(() => parseMarkdown(`${'*'.repeat(40_000)}a${'_'.repeat(40_000)}`), /\* and _ marks/, 200);
    quick(() => parseMarkdown('*a '.repeat(100_000)), /\* and _ marks/, 200);
    // A long tight list of bold names is ordinary.
    expect(parseMarkdown(Array.from({ length: 600 }, (_, i) => `* **Name ${i}**: note`).join('\n'))).toHaveLength(1);
  });

  it('deep nesting is refused before the lexer reads it', () => {
    quick(() => parseMarkdown(Array.from({ length: 1_400 }, (_, i) => `${'  '.repeat(i)}- x`).join('\n')), /indented/, 200);
    quick(() => parseMarkdown(`${'>'.repeat(20_000)} x`), /nested too deep/, 200);
    quick(() => parseMarkdown(Array.from({ length: 20 }, (_, i) => `${'  '.repeat(i)}- x`).join('\n')), /nests deeper than 16/, 500);
  });

  it('a document with too many parts is refused after reading, before drawing', () => {
    quick(() => parseMarkdown('- a\n'.repeat(120_000)), /more than 50000 parts/, 2_000);
    const table = `|${' a |'.repeat(100)}\n|${'---|'.repeat(100)}\n${`|${' 1 |'.repeat(100)}\n`.repeat(250)}`;
    quick(() => parseMarkdown(table), /more than 20000 cells/, 2_000);
  });
});

describe('running a conversion', () => {
  it('hands the stored format back at any size, and refuses a conversion past 512 KiB', async () => {
    const big = Buffer.from(`# Big\n\n${'word '.repeat(150_000)}\n`);
    expect(big.length).toBeGreaterThan(MAX_EXPORT_SOURCE_BYTES);
    expect(await runExport({ bytes: big, mime: 'text/markdown', filename: 'big.md' }, 'md')).toBe(big);
    await expect(runExport({ bytes: big, mime: 'text/markdown', filename: 'big.md' }, 'pdf')).rejects.toMatchObject({ status: 413 });
  });

  it('one at a time: a second conversion is told to retry, a waiting one queues', async () => {
    const source = { bytes: Buffer.from('# One\n\nText.\n'), mime: 'text/markdown', filename: 'one.md' };
    const first = runExport(source, 'pdf');
    expect(exportBusy()).toBe(true);
    await expect(runExport(source, 'docx')).rejects.toMatchObject({ status: 503, retryAfter: 5 });
    const queued = runExport(source, 'docx', { wait: true });
    expect((await first)?.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect((await queued)?.length).toBeGreaterThan(0);
    expect(exportBusy()).toBe(false);
  }, 30_000);

  it('maps a refused document to 413', async () => {
    await expect(runExport({ bytes: Buffer.from(`${'>'.repeat(100)} x`), mime: 'text/markdown', filename: 'q.md' }, 'pdf')).rejects.toBeInstanceOf(ExportRefused);
    await expect(runExport({ bytes: Buffer.from(`${','.repeat(999)}\n${'a\n'.repeat(1_000)}`), mime: 'text/csv', filename: 'r.csv' }, 'xlsx')).rejects.toMatchObject({ status: 413 });
  });
});

/*
 * The worker itself is the compiled file: these run against dist when it is
 * built (CI builds before it tests), checking the deadline and the heap
 * limit really stop a conversion off the event loop.
 */
const distConvert = new URL('../../dist/export/convert.js', import.meta.url);
const built = existsSync(fileURLToPath(distConvert)) && existsSync(fileURLToPath(new URL('../../dist/export/worker.js', import.meta.url)));
describe.skipIf(!built)('the conversion worker (dist)', () => {
  it('converts in a worker, and stops one past its deadline with 504', async () => {
    const mod = (await import(distConvert.href)) as typeof import('./convert.js');
    const source = { bytes: Buffer.from(REPORT), mime: 'text/markdown', filename: 'r.md' };
    const pdf = await mod.runExport(source, 'pdf');
    expect(pdf?.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    await expect(mod.runExport(source, 'pdf', { limits: { timeoutMs: 1 } })).rejects.toMatchObject({ status: 504 });
    // The event loop stayed free: the next conversion runs at once.
    expect(mod.exportBusy()).toBe(false);
  }, 30_000);

  it('a conversion that outgrows its heap is refused with 413, and the gateway lives on', async () => {
    const mod = (await import(distConvert.href)) as typeof import('./convert.js');
    const source = { bytes: Buffer.from(REPORT.repeat(200)), mime: 'text/markdown', filename: 'r.md' };
    await expect(mod.runExport(source, 'pdf', { limits: { memoryMb: 8, timeoutMs: 20_000 } })).rejects.toMatchObject({ status: 413 });
  }, 30_000);
});
