/**
 * Pictures made smaller without trusting what they say: a PNG's compressed
 * pixels are inflated with a cap before any decoder sees them.
 */
import { crc32, deflateSync } from 'node:zlib';
import pngjs from 'pngjs';
import { describe, expect, it } from 'vitest';
import { PixelsError, checkPngData, decodeRaster, fitPicture, fitPictureContained } from './pixels.js';

function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}

/** A PNG whose header says `width` × `height` RGBA and whose data inflates to `inflated` bytes. */
function crafted(width: number, height: number, inflated: number, interlace = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[12] = interlace;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(inflated), { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('a PNG decompression bomb', () => {
  it('a tiny file claiming one pixel that inflates to 64 MB is refused before decoding', async () => {
    for (const interlace of [0, 1]) {
      const bomb = crafted(1, 1, 64 * 1024 * 1024, interlace);
      expect(bomb.length).toBeLessThan(100 * 1024);
      expect(() => checkPngData(bomb)).toThrow(PixelsError);
      expect(() => decodeRaster(bomb, 'png')).toThrow(/unpacks to more than its size says/);
      await expect(fitPictureContained(bomb, { longSide: 1568, maxBytes: 1024 * 1024 })).rejects.toThrow(PixelsError);
    }
  });
  it('lets an honest PNG through, interlaced or not', () => {
    const image = new pngjs.PNG({ width: 37, height: 23 });
    image.data.fill(200);
    const honest = pngjs.PNG.sync.write(image);
    expect(() => checkPngData(honest)).not.toThrow();
    expect(fitPicture(honest, { longSide: 1568, maxBytes: 1024 * 1024 })).toMatchObject({ width: 37, height: 23 });
    expect(() => checkPngData(crafted(5, 7, 7 * (1 + 5 * 4), 0))).not.toThrow();
    // Adam7 of 5 × 7 RGBA: the seven passes' rows, each with its filter byte.
    const passes = ([[1, 1], [0, 0], [1, 1], [1, 2], [2, 2], [2, 4], [5, 3]] as Array<[number, number]>).reduce((n, [w, h]) => n + (w === 0 || h === 0 ? 0 : h * (1 + w * 4)), 0);
    expect(() => checkPngData(crafted(5, 7, passes, 1))).not.toThrow();
  });
});
