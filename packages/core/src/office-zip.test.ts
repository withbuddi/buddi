/**
 * The zip limit rule as each part truly inflates (`office-zip.ts`): a
 * package whose directory understates a part's size passes the directory
 * check (`lying.docx`, `lying.xlsx`: 30 MB declared as 2 KB and 4 KB) and is
 * refused while it inflates; an honest one is handed on as a copy whose
 * directory states the true sizes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { zipEntries } from './office-files.js';
import { editOfficePackage, officePackageProblem, unzipOffice, verifiedOfficePackage } from './office-zip.js';
import { readWorkbook } from './sheet/read.js';

/**
 * A zip written by hand: each entry's local header and data once, and a
 * directory that may point several entries at the same local header
 * (`alias`), as Codex's aliasing case does.
 */
function handZip(files: Array<{ name: string; data: Uint8Array; method: 0 | 8; size: number; localName?: string }>, alias: Array<{ name: string; of: string }> = []): Uint8Array {
  const encoder = new TextEncoder();
  const local: Uint8Array[] = [];
  const dir: Uint8Array[] = [];
  const offsets = new Map<string, number>();
  let at = 0;
  const header = (name: Uint8Array, f: { method: number; data: Uint8Array; size: number }, central: boolean, offset: number): Uint8Array => {
    const out = new Uint8Array((central ? 46 : 30) + name.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, central ? 0x02014b50 : 0x04034b50, true);
    const o = central ? 2 : 0;
    view.setUint16(4 + o, 20, true);
    view.setUint16(8 + o, f.method, true);
    view.setUint32(18 + o, f.data.length, true);
    view.setUint32(22 + o, f.size, true);
    view.setUint16(26 + o, name.length, true);
    if (central) view.setUint32(42, offset, true);
    out.set(name, central ? 46 : 30);
    return out;
  };
  for (const f of files) {
    const name = encoder.encode(f.localName ?? f.name);
    offsets.set(f.name, at);
    const head = header(name, f, false, 0);
    local.push(head, f.data);
    at += head.length + f.data.length;
  }
  const all = [...files.map((f) => ({ ...f, offset: offsets.get(f.name)! })), ...alias.map((a) => ({ ...files.find((f) => f.name === a.of)!, name: a.name, offset: offsets.get(a.of)! }))];
  for (const f of all) dir.push(header(encoder.encode(f.name), f, true, f.offset));
  const dirSize = dir.reduce((n, d) => n + d.length, 0);
  const end = new Uint8Array(22);
  const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, all.length, true);
  view.setUint16(10, all.length, true);
  view.setUint32(12, dirSize, true);
  view.setUint32(16, at, true);
  const parts = [...local, ...dir, end];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__/office', name)));

describe('an Office package, as its parts truly inflate', () => {
  it('refuses a part that inflates past the size its directory declares', () => {
    const lying = fixture('lying.docx');
    // The directory alone is within every limit: the old check let it through.
    const entries = zipEntries(lying);
    expect(Array.isArray(entries) && entries.find((e) => e.name === 'word/document.xml')?.size).toBe(2048);
    const started = performance.now();
    expect(officePackageProblem(lying, 'docx')).toBe('word/document.xml unpacks to more than its zip directory says');
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(verifiedOfficePackage(lying, 'docx')).toBe('word/document.xml unpacks to more than its zip directory says');
    expect(unzipOffice(lying)).toMatch(/unpacks to more than/);
  });

  it('refuses it in the sheet engine too, which reads with the same rule', () => {
    expect(() => readWorkbook(fixture('lying.xlsx'))).toThrow(/xl\/worksheets\/sheet1\.xml unpacks to more than its zip directory says/);
    expect(officePackageProblem(fixture('lying.xlsx'), 'xlsx')).toMatch(/unpacks to more than/);
  });

  it('refuses parts that share their data, so the verified copy is never larger than the file', () => {
    // Codex's case: ~100 KB of empty stored DEFLATE blocks, inflating to nothing, under 100 names at one offset.
    const empty = new Uint8Array(100_000);
    for (let i = 0; i + 5 <= empty.length; i += 5) empty.set([0x00, 0x00, 0x00, 0xff, 0xff], i);
    empty.set([0x01, 0x00, 0x00, 0xff, 0xff], empty.length - 5);
    const text = (s: string): { data: Uint8Array; method: 0; size: number } => { const data = new TextEncoder().encode(s); return { data, method: 0, size: data.length }; };
    const files = [
      { name: '[Content_Types].xml', ...text('<Types/>') },
      { name: 'word/document.xml', ...text('<w:document/>') },
      { name: 'pad.bin', data: empty, method: 8 as const, size: 0 },
    ];
    const aliased = handZip(files, Array.from({ length: 100 }, (_, i) => ({ name: `pad${i}.bin`, of: 'pad.bin' })));
    // 100 bytes unpacked in all: the directory declares only the two small parts' sizes.
    const tight = { entries: 2_000, entryBytes: 100, totalBytes: 100 };
    expect(officePackageProblem(aliased, 'docx', tight)).toBe('its parts overlap in the zip');
    expect(verifiedOfficePackage(aliased, 'docx', tight)).toBe('its parts overlap in the zip');
    expect(unzipOffice(aliased)).toBe('its parts overlap in the zip');
    // The same parts, each stored once, pass, and the verified copy is no larger than the file.
    const honest = handZip(files);
    const verified = verifiedOfficePackage(honest, 'docx', tight);
    if (typeof verified === 'string') throw new Error(verified);
    expect(verified.length).toBeLessThanOrEqual(honest.length);
  });

  it('refuses a package whose verified copy would be longer than the file (Codex: 210 bytes rebuilt as 246)', () => {
    // Local headers with no names, the central directory naming them: the rebuild writes each name twice.
    const text = (s: string): { data: Uint8Array; method: 0; size: number } => { const data = new TextEncoder().encode(s); return { data, method: 0, size: data.length }; };
    const short = handZip([
      { name: '[Content_Types].xml', localName: '', ...text('<Types/>') },
      { name: 'word/document.xml', localName: '', ...text('<w:document/>') },
    ]);
    expect(short.length).toBeLessThan(250);
    expect(verifiedOfficePackage(short, 'docx')).toBe('its zip directory does not match its parts');
    expect(officePackageProblem(short, 'docx')).toBe('its zip directory does not match its parts');
    // Every honest fixture's copy fits in the file it came from.
    for (const [name, kind] of [['letter.docx', 'docx'], ['budget.xlsx', 'xlsx'], ['deck.pptx', 'pptx'], ['budget-prefixed.xlsx', 'xlsx']] as const) {
      const verified = verifiedOfficePackage(fixture(name), kind);
      expect(typeof verified === 'string' ? verified : verified.length <= fixture(name).length).toBe(true);
    }
  });

  it('reads a workbook with one cell in its far corner as two cells, not a rectangle', () => {
    const [sheet] = readWorkbook(fixture('far-corner.xlsx')).sheets;
    expect(sheet!.cells.size).toBe(2);
    expect([sheet!.maxRow, sheet!.maxCol]).toEqual([1_048_576, 16_384]);
  });

  it('hands an honest package on as the same parts under a directory of true sizes', () => {
    for (const [name, kind] of [['letter.docx', 'docx'], ['budget.xlsx', 'xlsx'], ['deck.pptx', 'pptx']] as const) {
      const original = fixture(name);
      const verified = verifiedOfficePackage(original, kind);
      if (typeof verified === 'string') throw new Error(verified);
      const before = unzipSync(original);
      const after = unzipSync(verified);
      expect(Object.keys(after).sort()).toEqual(Object.keys(before).filter((n) => !n.endsWith('/')).sort());
      for (const part of Object.keys(after)) expect(after[part]).toEqual(before[part]);
      expect(officePackageProblem(verified, kind)).toBeNull();
    }
  });

  it('still refuses the honest bomb from its directory, and a damaged or foreign file', () => {
    expect(officePackageProblem(fixture('bomb.docx'), 'docx')).toMatch(/unpacks to more than 50 MB/);
    expect(officePackageProblem(fixture('deck.pptx'), 'docx')).toBe('it has no word/document.xml');
    const whole = fixture('letter.docx');
    expect(officePackageProblem(whole.subarray(0, whole.length - 200), 'docx')).toMatch(/not a zip|damaged/);
  });

  it('edits XML parts of a package within the same limits', () => {
    const edited = editOfficePackage(fixture('letter.docx'), (name, xml) => (name === 'word/document.xml' ? xml.replace('Revenue', 'Income') : null));
    if (typeof edited === 'string') throw new Error(edited);
    expect(strFromU8(unzipSync(edited)['word/document.xml']!)).toContain('Income grew');
    expect(editOfficePackage(fixture('lying.docx'), () => null)).toMatch(/unpacks to more than/);
  });
});
