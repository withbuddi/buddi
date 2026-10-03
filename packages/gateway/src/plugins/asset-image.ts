/**
 * The codec behind plugin assets (host API 1.27, `ctx.buddi.assets.put`):
 * whatever a plugin fetched — a PNG, a JPEG, a GIF, a favicon's ICO — comes
 * out as PNGs this process drew itself, 64 and 128 pixels square, the image
 * fitted inside and centred on transparency.
 *
 * Pure JavaScript, like the agent pictures (`agents/avatar-image.ts`): the
 * release installs without native image libraries. Nothing but pixels
 * survives the round trip. SVG never reaches here (core refuses it: it can
 * carry script), and neither does WebP, which no pure-JavaScript decoder
 * here reads yet.
 */
import pngjs from 'pngjs';
import omggif from 'omggif';
import * as jpeg from 'jpeg-js';
import { AssetRefusal, ASSET_SIZES, type AssetImageCodec, type AssetSize } from '@buddi/core';
import { resample } from '../agents/avatar-image.js';

/** Past this many pixels a 256 KB file is a decompression bomb, not a logo. */
const MAX_SOURCE_PIXELS = 4096 * 4096;

interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

type Kind = 'png' | 'jpeg' | 'gif' | 'ico';

/** What the bytes are, whatever the plugin said. */
export function sniffAsset(bytes: Buffer): Kind | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'gif';
  // ICONDIR: reserved 0, type 1 (icon), at least one image.
  if (bytes.length >= 6 && bytes.readUInt16LE(0) === 0 && bytes.readUInt16LE(2) === 1 && bytes.readUInt16LE(4) > 0) return 'ico';
  return null;
}

function checkSize(width: number, height: number): void {
  if (width <= 0 || height <= 0) throw new AssetRefusal('the image has no pixels');
  if (width * height > MAX_SOURCE_PIXELS) throw new AssetRefusal('the image is too large; at most 4096×4096 pixels');
}

function decodePng(bytes: Buffer): Rgba {
  if (bytes.length < 24) throw new AssetRefusal('that PNG is damaged');
  checkSize(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  try {
    const png = pngjs.PNG.sync.read(bytes);
    return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
  } catch {
    throw new AssetRefusal('that PNG is damaged');
  }
}

function decodeJpeg(bytes: Buffer): Rgba {
  try {
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 17, maxMemoryUsageInMB: 128 });
    checkSize(decoded.width, decoded.height);
    return { width: decoded.width, height: decoded.height, data: new Uint8Array(decoded.data) };
  } catch (err) {
    if (err instanceof AssetRefusal) throw err;
    throw new AssetRefusal('that JPEG is damaged');
  }
}

function decodeGif(bytes: Buffer): Rgba {
  let reader: omggif.GifReader;
  try {
    reader = new omggif.GifReader(bytes);
  } catch {
    throw new AssetRefusal('that GIF is damaged');
  }
  checkSize(reader.width, reader.height);
  if (reader.numFrames() < 1) throw new AssetRefusal('that GIF has no frames');
  const data = new Uint8Array(reader.width * reader.height * 4);
  try {
    reader.decodeAndBlitFrameRGBA(0, data);
  } catch {
    throw new AssetRefusal('that GIF is damaged');
  }
  return { width: reader.width, height: reader.height, data };
}

/**
 * An ICO: the largest image in it. A modern favicon's entries are PNGs; an
 * older one's are bitmaps (32-bit with alpha, or 24-bit with the AND mask
 * saying what is transparent), drawn bottom-up.
 */
function decodeIco(bytes: Buffer): Rgba {
  const count = bytes.readUInt16LE(4);
  if (bytes.length < 6 + count * 16) throw new AssetRefusal('that ICO is damaged');
  let best: { size: number; offset: number; length: number } | undefined;
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const side = (bytes[at] || 256) * (bytes[at + 1] || 256);
    const length = bytes.readUInt32LE(at + 8);
    const offset = bytes.readUInt32LE(at + 12);
    if (offset + length > bytes.length || length === 0) continue;
    if (!best || side > best.size) best = { size: side, offset, length };
  }
  if (!best) throw new AssetRefusal('that ICO has no image in it');
  const entry = bytes.subarray(best.offset, best.offset + best.length);
  if (sniffAsset(entry) === 'png') return decodePng(Buffer.from(entry));
  return decodeDib(entry);
}

/** A BITMAPINFOHEADER image as an ICO holds it: twice its height, with the AND mask after the colours. */
function decodeDib(dib: Buffer): Rgba {
  if (dib.length < 40) throw new AssetRefusal('that ICO is damaged');
  const header = dib.readUInt32LE(0);
  const width = dib.readInt32LE(4);
  const height = Math.abs(dib.readInt32LE(8)) / 2;
  const bpp = dib.readUInt16LE(14);
  checkSize(width, height);
  if (bpp !== 32 && bpp !== 24) throw new AssetRefusal(`that ICO's ${bpp}-bit bitmap cannot be read (32- or 24-bit, or a PNG inside)`);
  const stride = Math.ceil((width * bpp) / 32) * 4;
  const maskStride = Math.ceil(width / 32) * 4;
  const pixels = header;
  const maskAt = pixels + stride * height;
  if (dib.length < maskAt) throw new AssetRefusal('that ICO is damaged');
  const data = new Uint8Array(width * height * 4);
  let anyAlpha = false;
  for (let y = 0; y < height; y++) {
    const row = pixels + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const from = row + x * (bpp / 8);
      const to = (y * width + x) * 4;
      data[to] = dib[from + 2]!;
      data[to + 1] = dib[from + 1]!;
      data[to + 2] = dib[from]!;
      const alpha = bpp === 32 ? dib[from + 3]! : 255;
      if (bpp === 32 && alpha !== 0) anyAlpha = true;
      data[to + 3] = alpha;
    }
  }
  // 24-bit, or 32-bit whose alpha is all zero: the AND mask says what shows.
  if (bpp === 24 || !anyAlpha) {
    for (let y = 0; y < height; y++) {
      const row = maskAt + (height - 1 - y) * maskStride;
      for (let x = 0; x < width; x++) {
        const byte = row + (x >> 3) < dib.length ? dib[row + (x >> 3)]! : 0;
        const transparent = (byte >> (7 - (x & 7))) & 1;
        data[(y * width + x) * 4 + 3] = transparent ? 0 : 255;
      }
    }
  }
  return { width, height, data };
}

/** The image fitted inside a `side` square, centred on transparency. */
function fitSquare(image: Rgba, side: number): Buffer {
  const scale = side / Math.max(image.width, image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const scaled = resample(image, width, height);
  const out = new pngjs.PNG({ width: side, height: side });
  out.data.fill(0);
  const x0 = Math.floor((side - width) / 2);
  const y0 = Math.floor((side - height) / 2);
  for (let y = 0; y < height; y++) {
    const from = y * width * 4;
    out.data.set(scaled.data.subarray(from, from + width * 4), ((y + y0) * side + x0) * 4);
  }
  return pngjs.PNG.sync.write(out, { deflateLevel: 9 });
}

/** Decode one image and draw it at every kept size. Refusals are `AssetRefusal`s. */
export async function normaliseAsset(bytes: Buffer): Promise<Record<AssetSize, Buffer>> {
  const kind = sniffAsset(bytes);
  if (kind === null) throw new AssetRefusal('the bytes are not a PNG, JPEG, GIF or ICO');
  const rgba = kind === 'png' ? decodePng(bytes) : kind === 'jpeg' ? decodeJpeg(bytes) : kind === 'gif' ? decodeGif(bytes) : decodeIco(bytes);
  const out = {} as Record<AssetSize, Buffer>;
  for (const side of ASSET_SIZES) out[side] = fitSquare(rgba, side);
  return out;
}

/** The codec the composition root hands the plugin host. */
export const assetImageCodec: AssetImageCodec = {
  normalise: (bytes) => normaliseAsset(bytes),
};
