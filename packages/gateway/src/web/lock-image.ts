/**
 * The owner's picture behind the lock screen, made safe and small enough to
 * serve: whatever came in (a JPEG or a PNG of at most 10 MB), a JPEG of at most
 * 2560 pixels on its long side goes out, turned the way the camera meant it.
 *
 * Pure JavaScript, like the agent pictures (`agents/avatar-image.ts`): the
 * release installs without native image libraries. Nothing but pixels
 * survives the round trip — no EXIF (so no location), no comments, no ICC.
 * The downscale streams source rows into one output row at a time, so a
 * 48-megapixel phone photo costs its decoded pixels and little more.
 */
import { createHash } from 'node:crypto';
import pngjs from 'pngjs';
import * as jpeg from 'jpeg-js';

/** The largest file the owner may hand over. */
export const MAX_LOCK_IMAGE_BYTES = 10 * 1024 * 1024;
/** The long side of what is kept, at most. */
export const LOCK_IMAGE_LONG_SIDE = 2560;
/** Past this many source pixels a file is a decompression bomb, not a photo. */
const MAX_SOURCE_PIXELS = 50_000_000;
/** What a transparent pixel is laid on: the dark field the lock screen draws a picture over. */
const UNDER = [16, 27, 46] as const;

export interface LockImage {
  jpeg: Buffer;
  sha256: string;
  width: number;
  height: number;
}

/** A refusal the owner reads as it is. */
export class LockImageRefusal extends Error {
  constructor(message: string, readonly status: 400 | 413 | 415 = 400) {
    super(message);
    this.name = 'LockImageRefusal';
  }
}

interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

type Kind = 'jpeg' | 'png';

function sniff(bytes: Buffer): Kind | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

function checkSize(width: number, height: number): void {
  if (width <= 0 || height <= 0) throw new LockImageRefusal('The picture has no pixels.');
  if (width * height > MAX_SOURCE_PIXELS) throw new LockImageRefusal('The picture is too large; at most 50 megapixels.');
}

/** The JPEG's size from its first frame header, before a byte is decoded. */
function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
    const length = bytes.readUInt16BE(i + 2);
    // SOF0–SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  return null;
}

/**
 * The EXIF orientation (1–8) of a JPEG, 1 when it has none. Phones store a
 * portrait photo sideways and say so here; the decoder does not read it.
 */
export function exifOrientation(bytes: Buffer): number {
  let i = 2;
  while (i + 4 < bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    const length = bytes.readUInt16BE(i + 2);
    if (marker === 0xe1 && bytes.subarray(i + 4, i + 10).toString('latin1') === 'Exif\0\0') {
      const tiff = i + 10;
      const little = bytes.subarray(tiff, tiff + 2).toString('latin1') === 'II';
      const u16 = (at: number): number => (little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at));
      const u32 = (at: number): number => (little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
      try {
        const ifd = tiff + u32(tiff + 4);
        const entries = u16(ifd);
        for (let e = 0; e < entries; e++) {
          const at = ifd + 2 + e * 12;
          if (u16(at) === 0x0112) {
            const value = u16(at + 8);
            return value >= 1 && value <= 8 ? value : 1;
          }
        }
      } catch {
        return 1;
      }
      return 1;
    }
    i += 2 + length;
  }
  return 1;
}

function decode(bytes: Buffer, kind: Kind): Rgba {
  if (kind === 'png') {
    if (bytes.length < 24) throw new LockImageRefusal('That PNG is damaged.');
    checkSize(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
    try {
      const png = pngjs.PNG.sync.read(bytes);
      return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
    } catch {
      throw new LockImageRefusal('That PNG is damaged.');
    }
  }
  const size = jpegSize(bytes);
  if (!size) throw new LockImageRefusal('That JPEG is damaged.');
  checkSize(size.width, size.height);
  try {
    const out = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 50, maxMemoryUsageInMB: 512 });
    return { width: out.width, height: out.height, data: out.data };
  } catch {
    throw new LockImageRefusal('That JPEG is damaged.');
  }
}

/**
 * Area-average downscale to `width` × `height`, alpha laid on `UNDER`, out as
 * opaque RGBA. Streams: each output row gathers the source rows it covers,
 * each horizontally reduced on the way in.
 */
export function shrink(image: Rgba, width: number, height: number): Rgba {
  const { width: sw, height: sh, data: src } = image;
  // Which output column each source column feeds, and how much.
  const xs: Array<{ from: number; to: number; w: number }> = [];
  const sx = sw / width;
  for (let x = 0; x < width; x++) {
    const start = x * sx;
    const end = start + sx;
    for (let s = Math.floor(start); s < Math.min(Math.ceil(end), sw); s++) {
      const cover = Math.min(end, s + 1) - Math.max(start, s);
      if (cover > 0) xs.push({ from: s, to: x, w: cover / sx });
    }
  }
  const out = new Uint8Array(width * height * 4);
  const rowSum = new Float64Array(width * 3);
  const acc = new Float64Array(width * 3);
  const sy = sh / height;
  for (let y = 0; y < height; y++) {
    acc.fill(0);
    const start = y * sy;
    const end = start + sy;
    for (let s = Math.floor(start); s < Math.min(Math.ceil(end), sh); s++) {
      const cover = (Math.min(end, s + 1) - Math.max(start, s)) / sy;
      if (cover <= 0) continue;
      rowSum.fill(0);
      const base = s * sw * 4;
      for (const { from, to, w } of xs) {
        const i = base + from * 4;
        const a = src[i + 3]! / 255;
        rowSum[to * 3]! += (src[i]! * a + UNDER[0] * (1 - a)) * w;
        rowSum[to * 3 + 1]! += (src[i + 1]! * a + UNDER[1] * (1 - a)) * w;
        rowSum[to * 3 + 2]! += (src[i + 2]! * a + UNDER[2] * (1 - a)) * w;
      }
      for (let k = 0; k < acc.length; k++) acc[k]! += rowSum[k]! * cover;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = Math.round(acc[x * 3]!);
      out[o + 1] = Math.round(acc[x * 3 + 1]!);
      out[o + 2] = Math.round(acc[x * 3 + 2]!);
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/** Turn and mirror the pixels the way EXIF `orientation` says the camera held it. */
export function orient(image: Rgba, orientation: number): Rgba {
  if (orientation <= 1 || orientation > 8) return image;
  const { width: w, height: h, data } = image;
  const swap = orientation >= 5;
  const ow = swap ? h : w;
  const oh = swap ? w : h;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number;
      let ny: number;
      switch (orientation) {
        case 2: nx = w - 1 - x; ny = y; break;
        case 3: nx = w - 1 - x; ny = h - 1 - y; break;
        case 4: nx = x; ny = h - 1 - y; break;
        case 5: nx = y; ny = x; break;
        case 6: nx = h - 1 - y; ny = x; break;
        case 7: nx = h - 1 - y; ny = w - 1 - x; break;
        default: nx = y; ny = w - 1 - x; break; // 8
      }
      const from = (y * w + x) * 4;
      const to = (ny * ow + nx) * 4;
      out[to] = data[from]!;
      out[to + 1] = data[from + 1]!;
      out[to + 2] = data[from + 2]!;
      out[to + 3] = data[from + 3]!;
    }
  }
  return { width: ow, height: oh, data: out };
}

/** Check, decode, turn, shrink and re-encode one upload. */
export function normaliseLockImage(bytes: Buffer, claimedMime?: string): LockImage {
  if (bytes.length === 0) throw new LockImageRefusal('The file is empty.');
  if (bytes.length > MAX_LOCK_IMAGE_BYTES) throw new LockImageRefusal('A picture can be at most 10 MB.', 413);
  const kind = sniff(bytes);
  if (!kind) throw new LockImageRefusal('A picture must be a JPEG or a PNG.', 415);
  const claimed = (claimedMime ?? '').toLowerCase().split(';')[0]!.trim();
  if (claimed === 'image/png' && kind !== 'png') throw new LockImageRefusal(`The file says it is ${claimed} but its contents are a JPEG.`, 415);
  if ((claimed === 'image/jpeg' || claimed === 'image/jpg') && kind !== 'jpeg') throw new LockImageRefusal(`The file says it is ${claimed} but its contents are a PNG.`, 415);
  const decoded = decode(bytes, kind);
  const scale = Math.min(1, LOCK_IMAGE_LONG_SIDE / Math.max(decoded.width, decoded.height));
  const small = shrink(decoded, Math.max(1, Math.round(decoded.width * scale)), Math.max(1, Math.round(decoded.height * scale)));
  const turned = kind === 'jpeg' ? orient(small, exifOrientation(bytes)) : small;
  const encoded = jpeg.encode({ width: turned.width, height: turned.height, data: Buffer.from(turned.data.buffer, turned.data.byteOffset, turned.data.byteLength) }, 82).data;
  return { jpeg: encoded, sha256: createHash('sha256').update(encoded).digest('hex'), width: turned.width, height: turned.height };
}
