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
  isPartId,
  mimeToStore,
  safeFilename,
  sniffMime,
  zipEntryNames,
  MAX_FILENAME,
} from './safety.js';

/** A minimal but real ZIP holding one entry with the given name. */
function zipWith(name: string): Buffer {
  const nameBytes = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30 + nameBytes.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(nameBytes.length, 26);
  nameBytes.copy(local, 30);

  const central = Buffer.alloc(46 + nameBytes.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(nameBytes.length, 28);
  nameBytes.copy(central, 46);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // entries total
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16); // central directory offset
  return Buffer.concat([local, central, eocd]);
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

describe('zipEntryNames', () => {
  it('reads the central directory rather than searching the whole buffer', () => {
    // A document that merely *mentions* the string must not be refused.
    const zip = zipWith('word/document.xml');
    const withText = Buffer.concat([Buffer.from('vbaProject.bin'), zip]);
    expect(zipEntryNames(zip)).toEqual(['word/document.xml']);
    expect(bytesRefusal(withText)).toBeNull();
  });

  it('answers nothing for something that is not a zip', () => {
    expect(zipEntryNames(Buffer.from('not a zip'))).toEqual([]);
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
