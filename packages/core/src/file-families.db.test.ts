/**
 * The family rule's SQL (the Files filter, the list's family column) says
 * exactly what `familyOf` says, mime parameters and odd names included:
 * Codex P2 on fix/office-docx-canvas, a docx typed with `; charset=binary`
 * listed as Code while the canvas called it a Document.
 */
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from './db.js';
import { familyOf, familySql } from './file-families.js';
import { OFFICE_MIME } from './office-files.js';
import { testDatabaseUrl } from './testing/database-url.js';

const databaseUrl = await testDatabaseUrl();
const suite = databaseUrl ? describe : describe.skip;

const CASES: Array<[string | null, string | null]> = [
  [OFFICE_MIME.docx, 'Congratulations Dr. Rachid AYOUBA.docx'],
  [`${OFFICE_MIME.docx}; charset=binary`, 'Letter.docx'],
  [OFFICE_MIME.xlsx.toUpperCase(), 'Budget.xlsx'],
  [OFFICE_MIME.pptx, 'Deck.pptx'],
  ['application/octet-stream', 'Deck.PPTX'],
  ['application/zip', 'Letter.docx'],
  ['application/zip', 'bundle.zip'],
  ['', 'Report.pdf'],
  ['application/octet-stream; x=y', 'Report.pdf'],
  ['application/pdf', 'x.bin'],
  ['application/msword', 'Old.doc'],
  ['application/vnd.ms-powerpoint', 'Old.ppt'],
  ['application/vnd.apple.keynote', 'Talk.key'],
  ['text/plain; charset=utf-8', 'notes.txt'],
  ['text/html', 'page.html'],
  ['application/json', 'data.json'],
  ['application/xml', 'feed.xml'],
  ['text/csv', 'rows.csv'],
  ['application/octet-stream', 'rows.tar.gz'],
  ['image/png', 'chart.png'],
  ['audio/mpeg', 'voice.mp3'],
  ['video/mp4', 'clip.mp4'],
  ['application/octet-stream', 'blob'],
  ['application/octet-stream', 'csv'],
  ['application/octet-stream', 'archive.'],
  [null, null],
];

suite('the family rule in SQL', () => {
  let pool: Pool;
  beforeAll(() => { pool = createPool(databaseUrl as string); });
  afterAll(async () => { await pool.end(); });

  it('classifies every case exactly as familyOf does', async () => {
    const { rows } = await pool.query(
      `select t.i, ${familySql('t.mime', 't.name')} as family
         from unnest($1::text[], $2::text[]) with ordinality as t(mime, name, i) order by t.i`,
      [CASES.map(([mime]) => mime), CASES.map(([, name]) => name)],
    );
    expect(rows.map((row) => row.family)).toEqual(CASES.map(([mime, name]) => familyOf(mime ?? '', name)));
    expect(rows.slice(0, 2).map((row) => row.family)).toEqual(['text', 'text']);
  });
});
