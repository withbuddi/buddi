import pngjs from 'pngjs';
import * as jpeg from 'jpeg-js';
import { describe, expect, it } from 'vitest';
import { LockImageRefusal, exifOrientation, normaliseLockImage, orient, shrink } from './lock-image.js';

const png = (width: number, height: number, rgba: [number, number, number, number]): Buffer => {
  const image = new pngjs.PNG({ width, height });
  for (let i = 0; i < image.data.length; i += 4) image.data.set(rgba, i);
  return pngjs.PNG.sync.write(image);
};

describe('the lock screen picture', () => {
  it('re-encodes a PNG as a JPEG no longer than 2560 on its long side, transparency laid on the dark field', () => {
    const out = normaliseLockImage(png(3000, 1500, [255, 255, 255, 0]), 'image/png');
    expect([out.width, out.height]).toEqual([2560, 1280]);
    expect(out.jpeg.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
    const back = jpeg.decode(out.jpeg, { useTArray: true });
    expect(back.data[0]).toBeLessThan(40);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps a small picture its size', () => {
    const out = normaliseLockImage(png(40, 30, [10, 200, 30, 255]));
    expect([out.width, out.height]).toEqual([40, 30]);
  });

  it('refuses what is not a JPEG or PNG, an empty file, a lie about the type, and a damaged file', () => {
    expect(() => normaliseLockImage(Buffer.from('GIF89a......'))).toThrow(LockImageRefusal);
    expect(() => normaliseLockImage(Buffer.alloc(0))).toThrow(/empty/);
    expect(() => normaliseLockImage(png(4, 4, [0, 0, 0, 255]), 'image/jpeg')).toThrow(/contents are a PNG/);
    expect(() => normaliseLockImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2]))).toThrow(/damaged/);
  });

  it('averages areas when it shrinks', () => {
    const data = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]);
    const out = shrink({ width: 2, height: 1, data }, 1, 1);
    expect(Array.from(out.data)).toEqual([128, 128, 128, 255]);
  });

  it('turns a picture the way its EXIF orientation says', () => {
    // 2×1: red then blue. Orientation 6 (turn clockwise) makes it 1×2, red on top.
    const data = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]);
    const turned = orient({ width: 2, height: 1, data }, 6);
    expect([turned.width, turned.height]).toEqual([1, 2]);
    expect(Array.from(turned.data.slice(0, 4))).toEqual([255, 0, 0, 255]);
    const ccw = orient({ width: 2, height: 1, data }, 8);
    expect(Array.from(ccw.data.slice(0, 4))).toEqual([0, 0, 255, 255]);
    expect(orient({ width: 2, height: 1, data }, 1).data).toBe(data);
  });

  it('reads the EXIF orientation from a JPEG’s APP1, and 1 when there is none', () => {
    const plain = jpeg.encode({ width: 2, height: 2, data: Buffer.alloc(16, 255) }, 80).data;
    expect(exifOrientation(plain)).toBe(1);
    // APP1: "Exif\0\0", a big-endian TIFF header, one IFD entry: 0x0112 SHORT 1 = 6.
    const tiff = Buffer.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0]);
    const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), Buffer.from([(payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
    const withExif = Buffer.concat([plain.subarray(0, 2), app1, plain.subarray(2)]);
    expect(exifOrientation(withExif)).toBe(6);
    const out = normaliseLockImage(Buffer.concat([plain.subarray(0, 2), app1, jpeg.encode({ width: 4, height: 2, data: Buffer.alloc(32, 255) }, 80).data.subarray(2)]));
    expect([out.width, out.height]).toEqual([2, 4]);
  });
});
