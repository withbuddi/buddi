/**
 * Earth, the lock screen's default background: the rule that picks it, the
 * picture a phone and a desk get, and the files themselves — small, without
 * the original's metadata, left out of the worker's precache, and shipped by
 * any build that draws them.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EARTH_PHOTO, earthSource } from './earth';
import { LockFace, lockBackgroundOf, type LockFaceData } from './LockScreen';
import { precacheList } from '../precache';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE = path.resolve(HERE, '../..');
const DIST = path.resolve(PACKAGE, 'dist');

afterEach(cleanup);

describe('which background the lock screen is drawn on', () => {
  it('is Earth until the state answers, and Earth again for a picture that is gone', () => {
    expect(lockBackgroundOf(undefined, null)).toBe('earth');
    expect(lockBackgroundOf('image', null)).toBe('earth');
    expect(lockBackgroundOf('image', '/api/lock/background?v=1')).toBe('image');
    expect(lockBackgroundOf('field', null)).toBe('field');
    expect(lockBackgroundOf('dusk', null)).toBe('dusk');
  });
});

describe('the Earth photo', () => {
  const face = (background: LockFaceData['background']): LockFaceData => ({ timezone: 'UTC', background, image: null, focus: null, approvals: 0, unread: 0, widgets: [] });

  it('gives a phone its portrait crop and a desk the whole frame, under the scrim', () => {
    const now = new Date('2026-10-01T12:00:00Z');
    const desk = render(<LockFace data={face('earth')} now={now} phone={false} />);
    const deskPhoto = desk.container.querySelector('img.lk-photo[data-earth="true"]');
    expect(deskPhoto?.getAttribute('src')).toBe(EARTH_PHOTO.desk);
    expect(desk.container.querySelector('.lk-scrim')).not.toBeNull();
    desk.unmount();
    const phone = render(<LockFace data={face('earth')} now={now} phone />);
    expect(phone.container.querySelector('img.lk-photo[data-earth="true"]')?.getAttribute('src')).toBe(EARTH_PHOTO.phone);
    phone.unmount();
    expect(earthSource(true)).not.toBe(earthSource(false));
    // A gradient is still a gradient.
    const field = render(<LockFace data={face('sea')} now={now} phone={false} />);
    expect(field.container.querySelector('img.lk-photo')).toBeNull();
  });

  /** The RIFF chunks of a WebP file. */
  const chunks = (bytes: Buffer): string[] => {
    expect(bytes.toString('ascii', 0, 4)).toBe('RIFF');
    expect(bytes.toString('ascii', 8, 12)).toBe('WEBP');
    const found: string[] = [];
    for (let at = 12; at + 8 <= bytes.length;) {
      const id = bytes.toString('ascii', at, at + 4);
      const size = bytes.readUInt32LE(at + 4);
      found.push(id);
      at += 8 + size + (size % 2);
    }
    return found;
  };

  it('is three small WebP files with nothing of the original’s metadata (no EXIF, no location, no XMP)', () => {
    const files = { desk: ['earth-2560.webp', 350_000], phone: ['earth-phone.webp', 150_000], thumb: ['earth-thumb.webp', 8_000] } as const;
    for (const [key, [name, max]] of Object.entries(files)) {
      // The import resolves to the file beside this module (the swatch, under Vite's inline limit, may be inlined).
      const src = EARTH_PHOTO[key as keyof typeof EARTH_PHOTO];
      expect(src.includes(name) || src.startsWith('data:image/webp')).toBe(true);
      const bytes = readFileSync(path.join(HERE, 'earth', name));
      expect(bytes.length).toBeLessThanOrEqual(max);
      const ids = chunks(bytes);
      expect(ids.some((id) => ['EXIF', 'XMP ', 'ICCP'].includes(id))).toBe(false);
      expect(ids.every((id) => ['VP8 ', 'VP8L', 'VP8X'].includes(id))).toBe(true);
      expect(bytes.includes(Buffer.from('GPS'))).toBe(false);
    }
  });

  it('is not kept by the service worker, which keeps only the shell', () => {
    expect(precacheList(['assets/index-abc12345.js', 'assets/earth-2560-abc12345.webp', 'assets/earth-phone-abc12345.webp'], [])).toEqual(['index.html', 'assets/index-abc12345.js']);
  });

  /*
   * Any build whose page draws Earth ships its pictures, hashed (so the gateway
   * caches them for good), and the page names them. A build from before Earth
   * — a stale dist in a checkout — has nothing to say here.
   */
  const built = existsSync(DIST) ? readdirSync(path.join(DIST, 'assets')).filter((f) => f.endsWith('.js')).map((f) => readFileSync(path.join(DIST, 'assets', f), 'utf8')).join('\n') : '';
  it.runIf(built.includes('outer-space-photography-of-earth'))('is in the build, hashed, and named by the page', () => {
    const assets = readdirSync(path.join(DIST, 'assets'));
    for (const stem of ['earth-2560', 'earth-phone']) {
      const file = assets.find((f) => new RegExp(`^${stem}-[A-Za-z0-9_-]{8,}\\.webp$`).test(f));
      expect(file, stem).toBeDefined();
      // Named relative to the chunk (the page is served wherever it is mounted).
      expect(built.includes(`"${file}"`) || built.includes(`assets/${file}`), `the page names ${file}`).toBe(true);
    }
  });
});
