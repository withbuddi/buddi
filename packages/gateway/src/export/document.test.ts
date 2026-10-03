/**
 * Every export, parsed back: the PDF's text through the same extractor the
 * agents read with, the Word file's XML, the spreadsheet through a reader.
 */
import { unzipSync, strFromU8 } from 'fflate';
import { readSheet } from 'read-excel-file/node';
import { describe, expect, it } from 'vitest';
import { extractText } from '@buddi/tool-artifacts';
import { csvToXlsx, exportDocument, exportFormats, exportName, markdownToDocx, markdownToPdf, parseCsv } from './document.js';
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
