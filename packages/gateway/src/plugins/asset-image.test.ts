/**
 * The plugin-asset codec (host API 1.27): a PNG, a JPEG and both kinds of ICO
 * entry come out as square PNGs this process drew, at 64 and 128 px, the
 * picture fitted and centred on transparency; anything else is refused.
 */
import pngjs from 'pngjs';
import * as jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { AssetRefusal } from '@buddi/core';
import { normaliseAsset, sniffAsset } from './asset-image.js';

function png(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const image = new pngjs.PNG({ width, height });
  for (let i = 0; i < width * height; i++) image.data.set(rgba, i * 4);
  return pngjs.PNG.sync.write(image);
}

/** An ICO with one entry: the bytes as given, a side of `side`. */
function ico(entry: Buffer, side: number): Buffer {
  const head = Buffer.alloc(6 + 16);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(1, 4);
  head[6] = side === 256 ? 0 : side;
  head[7] = side === 256 ? 0 : side;
  head.writeUInt32LE(entry.length, 6 + 8);
  head.writeUInt32LE(head.length, 6 + 12);
  return Buffer.concat([head, entry]);
}

/** A 32-bit bottom-up bitmap as an ICO holds it: header, BGRA rows, then the AND mask. */
function dib32(side: number, bgra: [number, number, number, number]): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(side, 4);
  header.writeInt32LE(side * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const pixels = Buffer.alloc(side * side * 4);
  for (let i = 0; i < side * side; i++) pixels.set(bgra, i * 4);
  const mask = Buffer.alloc(Math.ceil(side / 32) * 4 * side);
  return Buffer.concat([header, pixels, mask]);
}

const pixel = (image: Buffer, x: number, y: number): number[] => {
  const decoded = pngjs.PNG.sync.read(image);
  const at = (y * decoded.width + x) * 4;
  return [...decoded.data.subarray(at, at + 4)];
};

describe('the plugin-asset codec', () => {
  it('draws a PNG at 64 and 128 px, fitted inside the square and centred on transparency', async () => {
    const out = await normaliseAsset(png(32, 16, [255, 0, 0, 255]));
    for (const side of [64, 128] as const) {
      const decoded = pngjs.PNG.sync.read(out[side]);
      expect([decoded.width, decoded.height]).toEqual([side, side]);
    }
    // Wide: the band in the middle is red, above and below it nothing.
    expect(pixel(out[64], 32, 32)).toEqual([255, 0, 0, 255]);
    expect(pixel(out[64], 32, 2)[3]).toBe(0);
  });

  it('reads a JPEG, an ICO holding a PNG and an ICO holding a 32-bit bitmap', async () => {
    const data = Buffer.alloc(16 * 16 * 4);
    for (let i = 0; i < 16 * 16; i++) data.set([0, 0, 255, 255], i * 4);
    const jpg = jpeg.encode({ width: 16, height: 16, data }, 90).data;
    const blue = pixel((await normaliseAsset(Buffer.from(jpg)))[64], 32, 32);
    expect(blue[2]).toBeGreaterThan(200);
    expect(blue[0]).toBeLessThan(40);
    expect(pixel((await normaliseAsset(ico(png(16, 16, [0, 255, 0, 255]), 16)))[64], 10, 10)).toEqual([0, 255, 0, 255]);
    // BGRA (255, 0, 0) is blue.
    expect(pixel((await normaliseAsset(ico(dib32(16, [255, 0, 0, 255]), 16)))[64], 10, 10)).toEqual([0, 0, 255, 255]);
  });

  it('refuses what is not an image it reads, and a damaged one, in a sentence', async () => {
    expect(sniffAsset(Buffer.from('<svg/>'))).toBeNull();
    await expect(normaliseAsset(Buffer.from('<html>not a logo</html>'))).rejects.toThrow(/not a PNG, JPEG, GIF or ICO/);
    await expect(normaliseAsset(Buffer.from('<html>not a logo</html>'))).rejects.toBeInstanceOf(AssetRefusal);
    const broken = png(8, 8, [1, 2, 3, 255]).subarray(0, 40);
    await expect(normaliseAsset(Buffer.from(broken))).rejects.toThrow(/PNG is damaged/);
  });
});
