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
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { inflateSync } from 'node:zlib';
import pngjs from 'pngjs';
import omggif from 'omggif';
import * as jpeg from 'jpeg-js';
import { AssetRefusal, ASSET_SIZES, type AssetImageCodec, type AssetSize } from '@buddi/core';
import { resample } from '../agents/avatar-image.js';

/**
 * A logo is drawn at 128 px. Past a megapixel (or 2048 on a side) a 256 KB
 * file is a decompression bomb, not a logo: a solid 4096² PNG is 72 KB and
 * costs over a gigabyte to decode. Every format is held to this before any
 * pixel buffer is allocated.
 */
export const MAX_SOURCE_SIDE = 2048;
export const MAX_SOURCE_PIXELS = 1024 * 1024;

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
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new AssetRefusal('the image has no pixels');
  if (width > MAX_SOURCE_SIDE || height > MAX_SOURCE_SIDE || width * height > MAX_SOURCE_PIXELS) {
    throw new AssetRefusal('the image is too large; at most a megapixel (1024×1024), 2048 on a side');
  }
}

/** Bits per pixel for a PNG colour type and bit depth, or null when the pair is not one PNG allows. */
function pngBitsPerPixel(colorType: number, depth: number): number | null {
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const allowed: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!(allowed[colorType] ?? []).includes(depth)) return null;
  return channels[colorType]! * depth;
}

/**
 * Walk a PNG's chunks before pngjs sees it: exactly one IHDR and it comes
 * first (pngjs honours a later one, whose dimensions nothing checked), its
 * dimensions within the cap, and the image data inflating to no more than
 * those dimensions can need — checked with a bounded inflate, so a few
 * kilobytes that would inflate to megabytes (pngjs's interlaced path inflates
 * with no limit at all) stop at the budget. Once this passes, pngjs's own
 * inflate cannot produce more than the budget either.
 */
/** Adam7's passes: start column and row, then the step across and down. */
const ADAM7: ReadonlyArray<[number, number, number, number]> = [
  [0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2],
];

function checkPngStructure(bytes: Buffer): void {
  const damaged = (): AssetRefusal => new AssetRefusal('that PNG is damaged');
  let at = 8;
  let header: { width: number; height: number; bpp: number; interlaced: boolean } | undefined;
  const idat: Buffer[] = [];
  let ended = false;
  while (at + 8 <= bytes.length && !ended) {
    const length = bytes.readUInt32BE(at);
    const type = bytes.subarray(at + 4, at + 8).toString('latin1');
    const dataAt = at + 8;
    if (length > bytes.length || dataAt + length + 4 > bytes.length) throw damaged();
    const data = bytes.subarray(dataAt, dataAt + length);
    if (type === 'IHDR') {
      if (header !== undefined || at !== 8 || length !== 13) throw damaged();
      const width = data.readUInt32BE(0);
      const height = data.readUInt32BE(4);
      checkSize(width, height);
      const bpp = pngBitsPerPixel(data[9]!, data[8]!);
      if (bpp === null || data[10] !== 0 || data[11] !== 0 || data[12]! > 1) throw damaged();
      header = { width, height, bpp, interlaced: data[12] === 1 };
    } else if (header === undefined) {
      throw damaged();
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      ended = true;
    }
    at = dataAt + length + 4;
  }
  if (header === undefined || idat.length === 0) throw damaged();
  const { width, height, bpp } = header;
  // Exactly what the filtered scanlines take: a filter byte per row, per Adam7 pass when interlaced.
  const rows = (w: number, h: number): number => (w === 0 || h === 0 ? 0 : h * (1 + Math.ceil((w * bpp) / 8)));
  const budget = header.interlaced
    ? ADAM7.reduce((sum, [x0, y0, dx, dy]) => sum + rows(Math.ceil((width - x0) / dx), Math.ceil((height - y0) / dy)), 0)
    : rows(width, height);
  try {
    inflateSync(Buffer.concat(idat), { maxOutputLength: budget });
  } catch {
    throw new AssetRefusal('that PNG is damaged or inflates past its own size');
  }
}

function decodePng(bytes: Buffer): Rgba {
  if (bytes.length < 24) throw new AssetRefusal('that PNG is damaged');
  checkPngStructure(bytes);
  try {
    const png = pngjs.PNG.sync.read(bytes);
    return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
  } catch {
    throw new AssetRefusal('that PNG is damaged');
  }
}

function decodeJpeg(bytes: Buffer): Rgba {
  try {
    const decoded = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: MAX_SOURCE_PIXELS / 1_000_000, maxMemoryUsageInMB: 64 });
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
  // omggif sizes its buffers from the frame, not the canvas: a 1×1 canvas
  // can carry a 65535×65535 frame. The frame is held to the same cap and must
  // sit inside the canvas.
  const frame = reader.frameInfo(0);
  checkSize(frame.width, frame.height);
  if (frame.x < 0 || frame.y < 0 || frame.x + frame.width > reader.width || frame.y + frame.height > reader.height) {
    throw new AssetRefusal('that GIF is damaged');
  }
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
  const height = Math.floor(Math.abs(dib.readInt32LE(8)) / 2);
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

/** Decode one image and draw it at every kept size, on this thread. Refusals are `AssetRefusal`s. */
export function normaliseAssetHere(bytes: Buffer): Record<AssetSize, Buffer> {
  const kind = sniffAsset(bytes);
  if (kind === null) throw new AssetRefusal('the bytes are not a PNG, JPEG, GIF or ICO');
  const rgba = kind === 'png' ? decodePng(bytes) : kind === 'jpeg' ? decodeJpeg(bytes) : kind === 'gif' ? decodeGif(bytes) : decodeIco(bytes);
  const out = {} as Record<AssetSize, Buffer>;
  for (const side of ASSET_SIZES) out[side] = fitSquare(rgba, side);
  return out;
}

/** The decoder's thread budget: memory and time a hostile image may cost before it is refused. */
export const ASSET_DECODE_LIMITS = { timeoutMs: 5_000, memoryMb: 256 };

const workerUrl = new URL('./asset-image-worker.js', import.meta.url);
const hasWorker = import.meta.url.endsWith('.js') && existsSync(fileURLToPath(workerUrl));

/** One decode at a time per process: concurrent puts queue instead of each holding a decode's memory. */
let queue: Promise<unknown> = Promise.resolve();

function inWorker(bytes: Buffer): Promise<Record<AssetSize, Buffer>> {
  return new Promise((resolve, reject) => {
    const copy = new Uint8Array(bytes);
    const worker = new Worker(workerUrl, {
      workerData: { bytes: copy },
      transferList: [copy.buffer],
      resourceLimits: { maxOldGenerationSizeMb: ASSET_DECODE_LIMITS.memoryMb, maxYoungGenerationSizeMb: 32, stackSizeMb: 4 },
    });
    let settled = false;
    const done = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(() => done(() => reject(new AssetRefusal('the image takes too long to read'))), ASSET_DECODE_LIMITS.timeoutMs);
    worker.once('message', (msg: { ok: true; sizes: Array<[number, Uint8Array]> } | { ok: false; refused: boolean; message: string }) => {
      done(() => {
        if (msg.ok) {
          const out = {} as Record<AssetSize, Buffer>;
          for (const [side, png] of msg.sizes) out[side as AssetSize] = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
          resolve(out);
        } else reject(msg.refused ? new AssetRefusal(msg.message) : new Error(msg.message));
      });
    });
    worker.once('error', (err: Error & { code?: string }) => {
      done(() => reject(err.code === 'ERR_WORKER_OUT_OF_MEMORY' ? new AssetRefusal('the image is too large or too complex to read') : err));
    });
    worker.once('exit', (code) => done(() => reject(new Error(`the image decoder stopped (exit ${code})`))));
  });
}

/**
 * Decode one image and draw it at every kept size. In the built gateway the
 * decode runs in a worker thread with a memory limit and a deadline, one at a
 * time, so a hostile image costs that thread and never the event loop.
 */
export async function normaliseAsset(bytes: Buffer, opts: { inThread?: boolean } = {}): Promise<Record<AssetSize, Buffer>> {
  // Cheap refusals first, on this thread: no worker for bytes that are not an image.
  if (sniffAsset(bytes) === null) throw new AssetRefusal('the bytes are not a PNG, JPEG, GIF or ICO');
  const run = queue.then(() => (hasWorker && opts.inThread !== true ? inWorker(bytes) : normaliseAssetHere(bytes)));
  queue = run.catch(() => undefined);
  return run;
}

/** The codec the composition root hands the plugin host. */
export const assetImageCodec: AssetImageCodec = {
  normalise: (bytes) => normaliseAsset(bytes),
};
