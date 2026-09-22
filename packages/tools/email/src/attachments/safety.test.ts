/**
 * The three layers between a mail attachment and the owner's file library.
 *
 * Every case here is one somebody has actually been sent.
 */
import { describe, expect, it } from 'vitest';
import {
  bytesRefusal,
  declaredRefusal,
  extensionOf,
  inspectZip,
  isPartId,
  looksLikeZip,
  mimeToStore,
  safeFilename,
  sniffMime,
  zipEntryNames,
  MAX_FILENAME,
} from './safety.js';

/**
 * A minimal but real ZIP holding one entry with the given name.
 *
 * `preamble` prepends bytes before the archive, which is legal (a
 * self-extracting stub does it) and is the shape that used to walk past a
 * check that only looked at byte 0. `comment` goes in the EOCD comment field.
 */
function zipWith(
  name: string,
  opts: { preamble?: number; comment?: Buffer } = {},
): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);

  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(nameBytes.length, 28);
  nameBytes.copy(central, 46);

  const comment = opts.comment ?? Buffer.alloc(0);
  const eocd = Buffer.alloc(22 + comment.length);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // entries total
  eocd.writeUInt32LE(central.length, 12);
  // Relative to the start of the archive, which is after any preamble.
  eocd.writeUInt32LE(local.length, 16);
  eocd.writeUInt16LE(comment.length, 20);
  comment.copy(eocd, 22);

  const head = opts.preamble ? Buffer.alloc(opts.preamble, 0x41) : Buffer.alloc(0);
  return Buffer.concat([head, local, central, eocd]);
}

/** An EOCD claiming ZIP64: the 32-bit fields saturate. */
function zip64(): Buffer {
  const zip = zipWith('word/vbaProject.bin');
  const eocd = zip.length - 22;
  zip.writeUInt16LE(0xffff, eocd + 8);
  zip.writeUInt16LE(0xffff, eocd + 10);
  zip.writeUInt32LE(0xffffffff, eocd + 12);
  zip.writeUInt32LE(0xffffffff, eocd + 16);
  return zip;
}

describe('safeFilename', () => {
  it('strips the trailing spaces and dots Windows strips before executing', () => {
    // The bypass this exists for: `invoice.exe ` used to read as extensionless.
    expect(safeFilename('invoice.exe ')).toBe('invoice.exe');
    expect(safeFilename('invoice.exe.')).toBe('invoice.exe');
    expect(safeFilename('invoice.exe. . ')).toBe('invoice.exe');
  });

  it('keeps only the last path segment, under either separator', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('C:\\windows\\system32\\calc.exe')).toBe('calc.exe');
  });

  it('removes the invisible characters that reverse what a name looks like', () => {
    // U+202E turns `invoice\u202Efdp.exe` into `invoiceexe.pdf` on screen.
    expect(safeFilename('invoice\u202Efdp.exe')).toBe('invoicefdp.exe');
    expect(safeFilename('note\u0000.txt')).toBe('note.txt');
  });

  it('caps the length and answers null for a name that is nothing', () => {
    expect((safeFilename(`${'a'.repeat(400)}.pdf`) as string).length).toBe(MAX_FILENAME);
    expect(safeFilename('   ')).toBeNull();
    expect(safeFilename('...')).toBeNull();
    expect(safeFilename(null)).toBeNull();
  });
});

describe('declaredRefusal', () => {
  it('refuses a trailing-space executable, which is the whole point of the normalisation', () => {
    expect(declaredRefusal(safeFilename('invoice.exe '), 'application/pdf')).toMatch(/\.exe/);
  });

  it('refuses by extension, whatever the sender declared the type to be', () => {
    expect(declaredRefusal('invoice.pdf.exe', 'application/pdf')).toMatch(/\.exe/);
    expect(declaredRefusal('setup.scr', 'application/octet-stream')).toMatch(/\.scr/);
    expect(declaredRefusal('run.js', 'text/plain')).toMatch(/\.js/);
  });

  it('refuses the newer shapes of the same problem', () => {
    for (const name of [
      'x.dmg', 'x.pkg', 'x.app', 'x.command', 'x.sh', 'x.jar', 'x.ps1', 'x.hta', 'x.apk',
      'x.reg', 'x.chm', 'x.cpl', 'x.msc', 'x.msp', 'x.scf', 'x.url', 'x.iso', 'x.img',
      'x.vhd', 'x.vhdx', 'x.appx',
    ]) {
      expect(declaredRefusal(name, 'application/octet-stream')).not.toBeNull();
    }
  });

  it('refuses a document that carries macros', () => {
    for (const name of ['q.docm', 'q.xlsm', 'q.pptm', 'q.xlam', 'q.dotm']) {
      expect(declaredRefusal(name, 'application/octet-stream')).not.toBeNull();
    }
    expect(
      declaredRefusal('q.bin', 'application/vnd.ms-word.document.macroEnabled.12'),
    ).not.toBeNull();
    expect(
      declaredRefusal('q.bin', 'application/vnd.ms-excel.sheet.macroEnabled.12'),
    ).not.toBeNull();
  });

  it('refuses by declared type, whatever the file is called', () => {
    for (const mime of [
      'application/x-msdownload',
      'application/java-archive',
      'application/x-apple-diskimage',
      'application/hta',
      'application/x-sh',
      'text/javascript',
      'application/javascript',
    ]) {
      expect(declaredRefusal('invoice', mime)).not.toBeNull();
    }
    expect(declaredRefusal(null, 'application/x-msdownload; name=x')).not.toBeNull();
  });

  it('keeps the documents mail is actually for', () => {
    expect(declaredRefusal('invoice.pdf', 'application/pdf')).toBeNull();
    expect(
      declaredRefusal(
        'statement.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ),
    ).toBeNull();
    expect(declaredRefusal(null, 'image/jpeg')).toBeNull();
  });
});

describe('bytesRefusal', () => {
  it('refuses a Windows program renamed as a document', () => {
    // The layer that cannot be lied to: this one is called `invoice.pdf` and
    // declared `application/pdf`, and both earlier layers let it through.
    const pe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(64)]);
    expect(declaredRefusal('invoice.pdf', 'application/pdf')).toBeNull();
    expect(bytesRefusal(pe)).toMatch(/Windows program/);
  });

  it('refuses ELF, Mach-O and a shebang script', () => {
    expect(bytesRefusal(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02]))).toMatch(/Linux/);
    expect(bytesRefusal(Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00]))).toMatch(/macOS|Java/);
    expect(bytesRefusal(Buffer.from('#!/bin/sh\necho hi\n'))).toMatch(/shebang/);
  });

  it('refuses a macro-carrying Office document by what is inside the zip', () => {
    expect(bytesRefusal(zipWith('word/vbaProject.bin'))).toMatch(/macros/);
  });

  it('refuses a Java archive by its manifest', () => {
    expect(bytesRefusal(zipWith('META-INF/MANIFEST.MF'))).toMatch(/Java archive/);
  });

  it('keeps an ordinary document, and an ordinary zip-based one', () => {
    expect(bytesRefusal(Buffer.from('%PDF-1.7\n...'))).toBeNull();
    expect(bytesRefusal(zipWith('word/document.xml'))).toBeNull();
  });
});

describe('inspectZip', () => {
  it('reads the central directory rather than searching the whole buffer', () => {
    // A document that merely *mentions* the string must not be refused.
    const zip = zipWith('word/document.xml');
    expect(zipEntryNames(zip)).toEqual(['word/document.xml']);
    expect(bytesRefusal(zip)).toBeNull();
  });

  it('reads an archive that has something in front of it', () => {
    // The bypass: the inspection used to run only when byte 0 was `PK`, so a
    // hundred bytes of padding skipped it entirely.
    const padded = zipWith('word/vbaProject.bin', { preamble: 100 });
    expect(sniffMime(padded)).toBeNull();
    expect(inspectZip(padded)).toEqual({ kind: 'entries', names: ['word/vbaProject.bin'] });
    expect(bytesRefusal(padded)).toMatch(/macros/);
  });

  it('is not fooled by a fake end-of-directory signature in the comment', () => {
    const comment = Buffer.alloc(40);
    comment.writeUInt32LE(0x06054b50, 4);
    const zip = zipWith('word/document.xml', { comment });
    // The fake candidate is tried first, fails validation, and the real
    // record further back is used.
    expect(inspectZip(zip)).toEqual({ kind: 'entries', names: ['word/document.xml'] });
    expect(bytesRefusal(zip)).toBeNull();
  });

  it('refuses a ZIP64 archive as one it cannot look inside', () => {
    const found = inspectZip(zip64());
    expect(found.kind).toBe('uninspectable');
    expect(bytesRefusal(zip64())).toMatch(/ZIP64/);
  });

  it('refuses a truncated archive rather than throwing or passing', () => {
    const zip = zipWith('word/vbaProject.bin');
    // Cut the central directory in half, leaving the end record intact.
    const cut = Buffer.concat([zip.subarray(0, 40), zip.subarray(zip.length - 22)]);
    expect(() => inspectZip(cut)).not.toThrow();
    expect(inspectZip(cut).kind).toBe('uninspectable');
    expect(bytesRefusal(cut)).toMatch(/cannot look inside/);
  });

  it('refuses an archive whose index claims more entries than it holds', () => {
    const zip = zipWith('word/document.xml');
    zip.writeUInt16LE(500, zip.length - 22 + 10);
    expect(() => inspectZip(zip)).not.toThrow();
    expect(inspectZip(zip).kind).toBe('uninspectable');
  });

  it('looks inside anything that claims to be a zip container', () => {
    const padded = zipWith('META-INF/MANIFEST.MF', { preamble: 8 });
    // By declared type and by extension alike, even without the signature
    // being where a sniffer would look for it.
    expect(bytesRefusal(padded, { mime: 'application/zip' })).toMatch(/Java archive/);
    expect(bytesRefusal(padded, { filename: 'report.docx' })).toMatch(/Java archive/);
  });

  it('spots an end record wherever it legally sits, not just at byte 0', () => {
    expect(looksLikeZip(zipWith('a.txt', { preamble: 100 }))).toBe(true);
    expect(looksLikeZip(Buffer.from('an ordinary sentence'))).toBe(false);
  });

  it('answers nothing for something that is not a zip at all', () => {
    expect(zipEntryNames(Buffer.from('not a zip'))).toEqual([]);
    expect(inspectZip(Buffer.from('not a zip'))).toEqual({ kind: 'not-zip' });
    expect(bytesRefusal(Buffer.from('%PDF-1.7'), { filename: 'x.docx' })).toBeNull();
  });

  it('refuses a zip with no end record at all', () => {
    const headerOnly = zipWith('a.txt').subarray(0, 30);
    expect(inspectZip(headerOnly).kind).toBe('uninspectable');
  });
});

describe('sniffMime and mimeToStore', () => {
  it('names what the first bytes actually are', () => {
    expect(sniffMime(Buffer.from('%PDF-1.4'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('nothing in particular'))).toBeNull();
  });

  it('prefers the bytes over what the sender declared', () => {
    expect(mimeToStore('application/pdf', 'application/octet-stream')).toBe('application/pdf');
    expect(mimeToStore('image/png', 'image/jpeg')).toBe('image/png');
  });

  it('keeps a declared type that is more precise about the same bytes', () => {
    // A .docx really is a zip; storing `application/zip` would be a downgrade.
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    expect(mimeToStore('application/zip', docx)).toBe(docx);
    expect(mimeToStore('application/zip', 'application/octet-stream')).toBe('application/zip');
  });

  it('falls back to the declared type, and to octet-stream, when nothing is known', () => {
    expect(mimeToStore(null, 'application/pdf')).toBe('application/pdf');
    expect(mimeToStore(null, '')).toBe('application/octet-stream');
  });
});

describe('isPartId', () => {
  it('accepts a position in a MIME tree', () => {
    expect(isPartId('2')).toBe(true);
    expect(isPartId('1.3')).toBe(true);
    expect(isPartId('4.1.2')).toBe(true);
  });

  it('refuses everything that is not one', () => {
    for (const bad of ['', '0', '1.0', '01', '1.', '.1', 'TEXT', '1 2', '2; x', null, undefined]) {
      expect(isPartId(bad as string)).toBe(false);
    }
  });
});

describe('extensionOf', () => {
  it('reads the last extension, lowercased', () => {
    expect(extensionOf('Invoice.PDF')).toBe('pdf');
    expect(extensionOf('invoice.pdf.exe')).toBe('exe');
    expect(extensionOf('noextension')).toBe('');
    expect(extensionOf(null)).toBe('');
  });
});
