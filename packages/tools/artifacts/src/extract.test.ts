import { describe, expect, it } from 'vitest';
import { clamp, extractText, imageDimensions, isExtractable, tidy } from './extract.js';

describe('isExtractable', () => {
  it('accepts PDFs and text, refuses everything else', () => {
    expect(isExtractable('application/pdf')).toBe(true);
    expect(isExtractable('text/plain; charset=utf-8')).toBe(true);
    expect(isExtractable('text/csv')).toBe(true);
    expect(isExtractable('application/json')).toBe(true);
    expect(isExtractable('image/png')).toBe(false);
    expect(isExtractable('audio/ogg')).toBe(false);
  });
});

describe('tidy / clamp', () => {
  it('collapses the ragged whitespace a text layer leaves behind', () => {
    expect(tidy('a  \r\n\n\n\nb   \n')).toBe('a\n\nb');
  });

  it('reports truncation rather than hiding it', () => {
    expect(clamp('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
    expect(clamp('abc', 3)).toEqual({ text: 'abc', truncated: false });
  });
});

describe('extractText', () => {
  it('reads a text file and honours the cap', async () => {
    const bytes = Buffer.from('line one\n\n\n\nline two', 'utf8');
    expect(await extractText(bytes, 'text/plain', 1000)).toEqual({
      text: 'line one\n\nline two',
      truncated: false,
    });
    const capped = await extractText(bytes, 'text/plain', 5);
    expect(capped).toEqual({ text: 'line ', truncated: true });
  });

  it('refuses a type it cannot read, and says images are shown directly', async () => {
    await expect(extractText(Buffer.from('x'), 'image/png', 100)).rejects.toThrow(
      /shown to you directly/,
    );
    await expect(extractText(Buffer.from('x'), 'audio/ogg', 100)).rejects.toThrow(
      /cannot extract text/,
    );
  });
});

/* ---------------- image headers ---------------- */

function png(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function gif(width: number, height: number): Buffer {
  const b = Buffer.alloc(20);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

function jpeg(width: number, height: number): Buffer {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const jfif = Buffer.alloc(14); // rest of the APP0 segment
  const sof = Buffer.alloc(11);
  sof.writeUInt8(0xff, 0);
  sof.writeUInt8(0xc0, 1);
  sof.writeUInt16BE(8, 2); // segment length
  sof.writeUInt8(8, 4); // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([head, jfif, sof, Buffer.alloc(8)]);
}

describe('imageDimensions', () => {
  it('reads PNG, GIF and JPEG headers', () => {
    expect(imageDimensions(png(1200, 800))).toEqual({ width: 1200, height: 800 });
    expect(imageDimensions(gif(64, 48))).toEqual({ width: 64, height: 48 });
    expect(imageDimensions(jpeg(1920, 1080))).toEqual({ width: 1920, height: 1080 });
  });

  it('returns null rather than guessing at an unknown format', () => {
    expect(imageDimensions(Buffer.alloc(4))).toBeNull();
    expect(imageDimensions(Buffer.from('not an image at all, really', 'utf8'))).toBeNull();
  });
});
