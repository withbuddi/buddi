/**
 * The plugin-asset codec (host API 1.27): a PNG, a JPEG and both kinds of ICO
 * entry come out as square PNGs this process drew, at 64 and 128 px, the
 * picture fitted and centred on transparency; anything else is refused.
 */
import { crc32, deflateSync } from 'node:zlib';
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

  it('reads an interlaced PNG', async () => {
    const out = await normaliseAsset(interlacedPng(5, 3, [0, 0, 255, 255]));
    expect(pixel(out[64], 32, 32)).toEqual([0, 0, 255, 255]);
  });
});

/** One PNG chunk, CRC and all. */
function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
  return Buffer.concat([head, data, crc]);
}

function ihdr(width: number, height: number, interlace = 0): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8; // depth
  data[9] = 6; // RGBA
  data[12] = interlace;
  return chunk('IHDR', data);
}

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngOf = (...chunks: Buffer[]): Buffer => Buffer.concat([SIGNATURE, ...chunks, chunk('IEND', Buffer.alloc(0))]);

/** An Adam7 RGBA PNG of one colour, built by hand (pngjs writes no interlaced files). */
function interlacedPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const passes = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] as const;
  const rows: Buffer[] = [];
  for (const [x0, y0, dx, dy] of passes) {
    const w = Math.ceil((width - x0) / dx);
    const h = Math.ceil((height - y0) / dy);
    if (w <= 0 || h <= 0) continue;
    for (let y = 0; y < h; y++) {
      const row = Buffer.alloc(1 + w * 4);
      for (let x = 0; x < w; x++) row.set(rgba, 1 + x * 4);
      rows.push(row);
    }
  }
  return pngOf(ihdr(width, height, 1), chunk('IDAT', deflateSync(Buffer.concat(rows))));
}

/** Time and memory one refusal costs: a bomb must cost neither. */
async function refusalCost(bytes: Buffer, pattern: RegExp): Promise<{ ms: number; grewMb: number }> {
  const before = process.memoryUsage();
  const start = performance.now();
  await expect(normaliseAsset(bytes)).rejects.toThrow(pattern);
  const ms = performance.now() - start;
  const after = process.memoryUsage();
  const grew = Math.max(after.rss - before.rss, after.arrayBuffers - before.arrayBuffers);
  return { ms, grewMb: grew / 1024 / 1024 };
}

describe('images built to exhaust the decoder', () => {
  it('a PNG with a second IHDR is refused before pngjs reads the second one', async () => {
    const bytes = pngOf(ihdr(1, 1), ihdr(4000, 4000), chunk('IDAT', deflateSync(Buffer.alloc(5))));
    const cost = await refusalCost(bytes, /PNG is damaged/);
    expect(cost.ms).toBeLessThan(200);
    expect(cost.grewMb).toBeLessThan(32);
  });

  it('a 1×1 interlaced PNG whose data inflates to 8 MiB stops at its own budget', async () => {
    const payload = deflateSync(Buffer.alloc(8 * 1024 * 1024), { level: 9 });
    expect(payload.length).toBeLessThan(16 * 1024);
    for (const interlace of [1, 0]) {
      const cost = await refusalCost(pngOf(ihdr(1, 1, interlace), chunk('IDAT', payload)), /inflates past its own size/);
      expect(cost.ms).toBeLessThan(200);
      expect(cost.grewMb).toBeLessThan(32);
    }
  });

  it('a small solid PNG past a megapixel is refused from its header', async () => {
    const cost = await refusalCost(pngOf(ihdr(4096, 4096), chunk('IDAT', deflateSync(Buffer.alloc(16)))), /too large/);
    expect(cost.ms).toBeLessThan(100);
    expect(cost.grewMb).toBeLessThan(16);
    await expect(normaliseAsset(pngOf(ihdr(4096, 1), chunk('IDAT', deflateSync(Buffer.alloc(16)))))).rejects.toThrow(/too large/);
  });

  it('an ICO holding the bomb PNG is refused the same way', async () => {
    const payload = deflateSync(Buffer.alloc(8 * 1024 * 1024), { level: 9 });
    await expect(normaliseAsset(ico(pngOf(ihdr(1, 1, 1), chunk('IDAT', payload)), 16))).rejects.toThrow(/inflates past its own size/);
  });

  it('a 35-byte GIF with a 1×1 canvas and a 65535×65535 frame is refused before any allocation', async () => {
    const gif = gifOf(1, 1, { x: 0, y: 0, width: 65535, height: 65535 });
    expect(gif.length).toBeLessThanOrEqual(40);
    const cost = await refusalCost(gif, /too large/);
    expect(cost.ms).toBeLessThan(100);
    expect(cost.grewMb).toBeLessThan(16);
  });

  it('a GIF frame outside its canvas is refused', async () => {
    await expect(normaliseAsset(gifOf(4, 4, { x: 2, y: 0, width: 4, height: 4 }))).rejects.toThrow(/GIF is damaged/);
  });
});

/** A GIF: canvas, a two-colour global palette, one frame descriptor and a token of image data. */
function gifOf(width: number, height: number, frame: { x: number; y: number; width: number; height: number }): Buffer {
  const b = Buffer.alloc(13);
  b.write('GIF89a', 0, 'latin1');
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  b[10] = 0x80; // global table, 2 entries
  const palette = Buffer.from([0, 0, 0, 255, 255, 255]);
  const desc = Buffer.alloc(10);
  desc[0] = 0x2c;
  desc.writeUInt16LE(frame.x, 1);
  desc.writeUInt16LE(frame.y, 3);
  desc.writeUInt16LE(frame.width, 5);
  desc.writeUInt16LE(frame.height, 7);
  return Buffer.concat([b, palette, desc, Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00, 0x3b])]);
}
