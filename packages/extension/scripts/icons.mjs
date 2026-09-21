/*
 * The extension's mark, drawn here instead of committed as four binaries.
 *
 * It is the same mark the dashboard rail draws: a rounded square in the buddi
 * accent with a lowercase b in it. Generating it keeps the repository free of
 * binary assets nobody can diff, and keeps the colour a single number that
 * matches `--accent` in `packages/web/src/tokens.css`. No external asset is
 * fetched, at build time or after.
 */
import { deflateSync } from 'node:zlib';

/** --accent, light theme. */
const ACCENT = [0x3d, 0x5b, 0xd6];
const INK = [0xff, 0xff, 0xff];

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const body = Buffer.concat([head.subarray(4), data]);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([head, data, tail]);
}

/** Rows of RGBA, one filter byte each, deflated: the whole of the PNG format we need. */
export function png(size, pixel) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      const at = y * stride + 1 + x * 4;
      raw[at] = r; raw[at + 1] = g; raw[at + 2] = b; raw[at + 3] = a;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6; // 8 bits, truecolour with alpha.
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function icon(size) {
  const radius = Math.max(2, Math.round(size * 0.22));
  // The mark is geometry, not a bitmap, so it stays crisp at 16 and at 128: a
  // stem and a bowl, in fractions of the square.
  const stem = { x0: 0.30, x1: 0.40, y0: 0.18, y1: 0.82 };
  const bowl = { cx: 0.575, cy: 0.585, outer: 0.235, inner: 0.125 };
  return png(size, (x, y) => {
    const u = (x + 0.5) / size;
    const v = (y + 0.5) / size;
    // Corners: outside the rounded square the pixel is simply not there.
    const dx = Math.min(x, size - 1 - x);
    const dy = Math.min(y, size - 1 - y);
    if (dx < radius && dy < radius && Math.hypot(radius - dx, radius - dy) > radius) return [0, 0, 0, 0];
    const inStem = u >= stem.x0 && u <= stem.x1 && v >= stem.y0 && v <= stem.y1;
    const far = Math.hypot(u - bowl.cx, v - bowl.cy);
    const inBowl = far <= bowl.outer && far >= bowl.inner && v <= stem.y1;
    return inStem || inBowl ? [...INK, 255] : [...ACCENT, 255];
  });
}

export const SIZES = [16, 32, 48, 128];
