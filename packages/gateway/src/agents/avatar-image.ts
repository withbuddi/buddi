/**
 * An uploaded agent picture, made safe to serve: whatever came in, a square
 * PNG of at most 512×512 goes out.
 *
 * Pure JavaScript and one WebAssembly module, on purpose. The release installs
 * its dependencies with `--omit=optional --ignore-scripts`, so a native image
 * library (sharp, resvg-js) would arrive without its platform binary and fail
 * on the owner's machine rather than on ours.
 *
 *  - **PNG** is decoded (pngjs) and written again, so nothing but pixels
 *    survives: no text chunks, no APNG frames past the first.
 *  - **GIF** becomes its first frame (omggif). Keeping the animation would mean
 *    resizing every frame and quantising each back to 256 colours; that is an
 *    encoder of our own to trust, for a picture drawn at 44 px.
 *  - **SVG** is rasterised (resvg, as wasm), never served as SVG: an SVG can
 *    carry script, and a picture drawn from pixels cannot. resvg runs no script,
 *    fetches nothing (an external `href` stays unresolved) and, having no system
 *    fonts inside wasm, draws no text.
 *
 * Every input is sniffed from its bytes; the type the browser claimed is only
 * checked against it.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import pngjs from 'pngjs';
import omggif from 'omggif';
import * as jpeg from 'jpeg-js';
import { initWasm, Resvg } from '@resvg/resvg-wasm';

/** The largest file the owner may hand over. */
export const MAX_AVATAR_INPUT_BYTES = 1024 * 1024;
/** The side of the square that is stored, at most. */
export const AVATAR_SIDE = 512;
/** Past this many pixels a 1 MB file is a decompression bomb, not a face. */
const MAX_SOURCE_PIXELS = 4096 * 4096;

export type AvatarSource = 'png' | 'gif' | 'svg';

export interface NormalisedAvatar {
  png: Buffer;
  side: number;
  sha256: string;
  source: AvatarSource;
}

/** A refusal the owner reads as it is. */
export class AvatarRefusal extends Error {
  constructor(message: string, readonly status: 400 | 413 | 415 = 400) {
    super(message);
    this.name = 'AvatarRefusal';
  }
}

/** What the bytes are, whatever the browser said. */
export function sniffAvatar(bytes: Buffer): AvatarSource | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'gif';
  const head = bytes.subarray(0, 4096).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

const CLAIMED: Record<string, AvatarSource> = {
  'image/png': 'png',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

/**
 * Check, decode and re-encode one upload. Throws `AvatarRefusal` with a
 * sentence for anything that is not a PNG, GIF or SVG under the cap.
 */
export async function normaliseAvatar(bytes: Buffer, claimedMime?: string): Promise<NormalisedAvatar> {
  if (bytes.length === 0) throw new AvatarRefusal('The file is empty.');
  if (bytes.length > MAX_AVATAR_INPUT_BYTES) throw new AvatarRefusal('A picture can be at most 1 MB.', 413);
  const source = sniffAvatar(bytes);
  if (!source) throw new AvatarRefusal('A picture must be a PNG, GIF or SVG.', 415);
  const claimed = CLAIMED[(claimedMime ?? '').toLowerCase().split(';')[0]!.trim()];
  if (claimedMime && claimedMime !== 'application/octet-stream' && claimed !== undefined && claimed !== source) {
    throw new AvatarRefusal(`The file says it is ${claimedMime} but its contents are ${source.toUpperCase()}.`, 415);
  }
  const rgba = source === 'png' ? decodePng(bytes) : source === 'gif' ? decodeGif(bytes) : await rasteriseSvg(bytes);
  const square = cropSquare(rgba);
  const side = Math.min(square.width, AVATAR_SIDE);
  const scaled = resample(square, side, side);
  const out = new pngjs.PNG({ width: side, height: side });
  out.data = Buffer.from(scaled.data.buffer, scaled.data.byteOffset, scaled.data.byteLength);
  const png = pngjs.PNG.sync.write(out, { deflateLevel: 9 });
  return { png, side, sha256: createHash('sha256').update(png).digest('hex'), source };
}

/**
 * The stored PNG as a JPEG, for Telegram: `setMyProfilePhoto` takes JPEG only.
 * Transparency is laid on white, and the square is drawn at 512 so a small
 * picture is not refused for being small.
 */
export function avatarJpeg(png: Buffer): Buffer {
  const decoded = pngjs.PNG.sync.read(png);
  const scaled = resample({ width: decoded.width, height: decoded.height, data: new Uint8Array(decoded.data) }, AVATAR_SIDE, AVATAR_SIDE);
  const out = Buffer.alloc(scaled.data.length);
  for (let i = 0; i < scaled.data.length; i += 4) {
    const a = scaled.data[i + 3]! / 255;
    out[i] = Math.round(scaled.data[i]! * a + 255 * (1 - a));
    out[i + 1] = Math.round(scaled.data[i + 1]! * a + 255 * (1 - a));
    out[i + 2] = Math.round(scaled.data[i + 2]! * a + 255 * (1 - a));
    out[i + 3] = 255;
  }
  return jpeg.encode({ width: AVATAR_SIDE, height: AVATAR_SIDE, data: out }, 90).data;
}

interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

function checkSize(width: number, height: number): void {
  if (width <= 0 || height <= 0) throw new AvatarRefusal('The picture has no pixels.');
  if (width * height > MAX_SOURCE_PIXELS) throw new AvatarRefusal('The picture is too large; at most 4096×4096 pixels.');
}

function decodePng(bytes: Buffer): Rgba {
  // IHDR is always first: the size is known before a byte is inflated.
  if (bytes.length < 24) throw new AvatarRefusal('That PNG is damaged.');
  checkSize(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  try {
    const png = pngjs.PNG.sync.read(bytes);
    return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
  } catch {
    throw new AvatarRefusal('That PNG is damaged.');
  }
}

function decodeGif(bytes: Buffer): Rgba {
  let reader: omggif.GifReader;
  try {
    reader = new omggif.GifReader(bytes);
  } catch {
    throw new AvatarRefusal('That GIF is damaged.');
  }
  checkSize(reader.width, reader.height);
  if (reader.numFrames() < 1) throw new AvatarRefusal('That GIF has no frames.');
  const data = new Uint8Array(reader.width * reader.height * 4);
  try {
    reader.decodeAndBlitFrameRGBA(0, data);
  } catch {
    throw new AvatarRefusal('That GIF is damaged.');
  }
  return { width: reader.width, height: reader.height, data };
}

let wasmReady: Promise<void> | undefined;
function resvgReady(): Promise<void> {
  wasmReady ??= initWasm(readFileSync(createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm'))).catch((err) => {
    wasmReady = undefined;
    throw err;
  });
  return wasmReady;
}

async function rasteriseSvg(bytes: Buffer): Promise<Rgba> {
  await resvgReady();
  const svg = bytes.toString('utf8');
  let natural: InstanceType<typeof Resvg>;
  try {
    natural = new Resvg(svg, { font: { loadSystemFonts: false } });
  } catch {
    throw new AvatarRefusal('That SVG could not be read.');
  }
  const wide = natural.width >= natural.height;
  natural.free();
  // Fit the longer side, so a 1×10000 drawing cannot ask for a huge canvas.
  const renderer = new Resvg(svg, {
    font: { loadSystemFonts: false },
    fitTo: wide ? { mode: 'width', value: AVATAR_SIDE } : { mode: 'height', value: AVATAR_SIDE },
  });
  try {
    const image = renderer.render();
    const out = { width: image.width, height: image.height, data: new Uint8Array(image.pixels) };
    image.free();
    checkSize(out.width, out.height);
    return out;
  } catch (err) {
    if (err instanceof AvatarRefusal) throw err;
    throw new AvatarRefusal('That SVG could not be drawn.');
  } finally {
    renderer.free();
  }
}

/** The centred square: a face is in the middle far more often than at an edge. */
function cropSquare(image: Rgba): Rgba {
  const side = Math.min(image.width, image.height);
  if (image.width === image.height) return image;
  const x0 = Math.floor((image.width - side) / 2);
  const y0 = Math.floor((image.height - side) / 2);
  const data = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    const from = ((y + y0) * image.width + x0) * 4;
    data.set(image.data.subarray(from, from + side * 4), y * side * 4);
  }
  return { width: side, height: side, data };
}

/**
 * Area-average resampling, in premultiplied alpha so a transparent pixel's
 * colour never bleeds into its neighbour. Downscaling averages every source
 * pixel a target pixel covers; upscaling repeats them.
 */
export function resample(image: Rgba, width: number, height: number): Rgba {
  if (image.width === width && image.height === height) return image;
  const pre = new Float64Array(image.width * image.height * 4);
  for (let i = 0; i < pre.length; i += 4) {
    const a = image.data[i + 3]! / 255;
    pre[i] = image.data[i]! * a;
    pre[i + 1] = image.data[i + 1]! * a;
    pre[i + 2] = image.data[i + 2]! * a;
    pre[i + 3] = image.data[i + 3]!;
  }
  const horizontal = pass(pre, image.width, image.height, width, true);
  const both = pass(horizontal, width, image.height, height, false);
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const a = both[i + 3]!;
    const k = a > 0 ? 255 / a : 0;
    data[i] = clamp(both[i]! * k);
    data[i + 1] = clamp(both[i + 1]! * k);
    data[i + 2] = clamp(both[i + 2]! * k);
    data[i + 3] = clamp(a);
  }
  return { width, height, data };
}

function clamp(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
}

/** One axis of the area average. `across` resizes rows; otherwise columns. */
function pass(src: Float64Array, w: number, h: number, target: number, across: boolean): Float64Array {
  const srcLen = across ? w : h;
  const lines = across ? h : w;
  const out = new Float64Array((across ? target * h : w * target) * 4);
  const scale = srcLen / target;
  for (let t = 0; t < target; t++) {
    const start = t * scale;
    const end = start + scale;
    for (let line = 0; line < lines; line++) {
      let r = 0, g = 0, b = 0, a = 0, weight = 0;
      for (let s = Math.floor(start); s < Math.min(Math.ceil(end), srcLen); s++) {
        const cover = Math.min(end, s + 1) - Math.max(start, s);
        if (cover <= 0) continue;
        const i = (across ? line * w + s : s * w + line) * 4;
        r += src[i]! * cover;
        g += src[i + 1]! * cover;
        b += src[i + 2]! * cover;
        a += src[i + 3]! * cover;
        weight += cover;
      }
      const o = (across ? line * target + t : t * w + line) * 4;
      out[o] = r / weight;
      out[o + 1] = g / weight;
      out[o + 2] = b / weight;
      out[o + 3] = a / weight;
    }
  }
  return out;
}
