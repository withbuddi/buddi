/**
 * The lock screen's shipped pictures: the manifest the picker and the lock
 * screen read, the files it names (JPEGs of at most 2560 pixels, no
 * metadata, kept out of the worker's precache), and which file a screen gets
 * for how it is held.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import manifest from '../../public/backgrounds/manifest.json';
import { forgetLockPictures, lockPicturesOf, ownImageSource, pictureBackground, pictureIdOf, pictureSource } from './backgrounds';
import { LockFace, type LockFaceData } from './LockScreen';
import { EARTH_PHOTO } from './earth';
import { precacheList } from '../precache';

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

describe('the manifest', () => {
  it('lists Peoria (landscape) and Golden streak (portrait only) with their credits', () => {
    expect(lockPicturesOf(manifest)).toEqual([
      { id: 'peoria-autumn-waterfront', title: 'Peoria autumn waterfront', credit: 'Made with AI', landscape: 'backgrounds/peoria-autumn-waterfront.jpg', portrait: null, thumb: 'backgrounds/peoria-autumn-waterfront-thumb.jpg' },
      { id: 'golden-streak', title: 'Golden streak', credit: 'After a photo by Valentine Rutto on Unsplash, reworked with AI', landscape: null, portrait: 'backgrounds/golden-streak-portrait.jpg', thumb: 'backgrounds/golden-streak-thumb.jpg' },
    ]);
  });

  it('leaves out an entry missing what it needs, or naming a file outside its folder', () => {
    const ok = { id: 'a', title: 'A', credit: 'Made with AI', landscape: 'a.jpg' };
    expect(lockPicturesOf({ pictures: [ok, ok] })).toHaveLength(1);
    expect(lockPicturesOf({ pictures: [{ ...ok, id: 'Bad Id' }] })).toEqual([]);
    expect(lockPicturesOf({ pictures: [{ ...ok, credit: '' }] })).toEqual([]);
    expect(lockPicturesOf({ pictures: [{ id: 'a', title: 'A', credit: 'c' }] })).toEqual([]);
    expect(lockPicturesOf({ pictures: [{ ...ok, landscape: '../secret.jpg' }] })).toEqual([]);
    expect(lockPicturesOf({ pictures: [{ ...ok, portrait: 'https://example.com/x.jpg' }] })).toEqual([]);
    expect(lockPicturesOf(null)).toEqual([]);
  });

  it('names JPEGs of at most 2560 pixels with no metadata, quality around 82, none precached', () => {
    const files = (manifest.pictures as Array<Record<string, string | undefined>>).flatMap((p) => [p.landscape, p.portrait, p.thumb]).filter(Boolean);
    expect(files.length).toBe(4);
    for (const name of files) {
      const bytes = readFileSync(path.join(PUBLIC, 'backgrounds', name!));
      expect(bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), name).toBe(true);
      // Walk the markers up to the scan: a JFIF header and tables, no EXIF/XMP (APP1), no ICC (APP2), no comment.
      let at = 2;
      let size: { w: number; h: number } | null = null;
      while (at + 4 < bytes.length && bytes[at] === 0xff) {
        const marker = bytes[at + 1]!;
        if (marker === 0xda) break;
        const length = bytes.readUInt16BE(at + 2);
        expect([0xe1, 0xe2, 0xed, 0xfe], `${name} carries marker ${marker.toString(16)}`).not.toContain(marker);
        if (marker >= 0xc0 && marker <= 0xc2) size = { h: bytes.readUInt16BE(at + 5), w: bytes.readUInt16BE(at + 7) };
        at += 2 + length;
      }
      expect(size, name).not.toBeNull();
      expect(Math.max(size!.w, size!.h), name).toBeLessThanOrEqual(2560);
      expect(bytes.includes(Buffer.from('GPS')), name).toBe(false);
    }
    expect(precacheList(['assets/index-abc12345.js'], ['backgrounds/manifest.json', ...files.map((f) => `backgrounds/${f}`)])).toEqual(['index.html', 'assets/index-abc12345.js']);
  });
});

describe('which file a screen gets', () => {
  const both = { landscape: 'w.jpg', portrait: 't.jpg' };
  it('takes portrait when tall and landscape when wide, the other one when it has only that', () => {
    expect(pictureSource(both, true)).toEqual({ src: 't.jpg', fit: 'cover' });
    expect(pictureSource(both, false)).toEqual({ src: 'w.jpg', fit: 'cover' });
    expect(pictureSource({ landscape: 'w.jpg', portrait: null }, true)).toEqual({ src: 'w.jpg', fit: 'cover' });
    // Portrait only, on a wide screen: shown whole, over the field.
    expect(pictureSource({ landscape: null, portrait: 't.jpg' }, false)).toEqual({ src: 't.jpg', fit: 'contain' });
    expect(ownImageSource('/a', '/a-tall', true)).toBe('/a-tall');
    expect(ownImageSource('/a', '/a-tall', false)).toBe('/a');
    expect(ownImageSource('/a', null, true)).toBe('/a');
    expect(pictureIdOf(pictureBackground('golden-streak'))).toBe('golden-streak');
    expect(pictureIdOf('earth')).toBeNull();
  });
});

describe('the lock face on a shipped picture', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const face = (background: LockFaceData['background'], extra: Partial<LockFaceData> = {}): LockFaceData => ({ timezone: 'UTC', background, image: null, focus: null, approvals: 0, needs: 0, widgets: [], ...extra });

  beforeEach(() => {
    forgetLockPictures();
    // The manifest answers; anything else fails as an unbuilt page's relative fetch does.
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url) === 'backgrounds/manifest.json') return new Response(JSON.stringify(manifest), { status: 200, headers: { 'Content-Type': 'application/json' } });
      throw new TypeError('Failed to parse URL');
    }));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    forgetLockPictures();
  });

  it('draws Peoria on a desk and Golden streak whole in the middle of the field there', async () => {
    const peoria = render(<LockFace data={face('picture:peoria-autumn-waterfront')} now={now} phone={false} />);
    await waitFor(() => expect(peoria.container.querySelector('img.lk-photo')).not.toBeNull());
    const img = peoria.container.querySelector('img.lk-photo')!;
    expect(img.getAttribute('src')).toBe('backgrounds/peoria-autumn-waterfront.jpg');
    expect(img.getAttribute('data-fit')).toBe('cover');
    peoria.unmount();

    const golden = render(<LockFace data={face('picture:golden-streak')} now={now} phone={false} />);
    await waitFor(() => expect(golden.container.querySelector('img.lk-photo')).not.toBeNull());
    expect(golden.container.querySelector('img.lk-photo')!.getAttribute('src')).toBe('backgrounds/golden-streak-portrait.jpg');
    expect(golden.container.querySelector('.lk-ground')!.getAttribute('data-fit')).toBe('contain');
    expect(golden.container.querySelector('.lk-ground')!.classList.contains('ui-fieldbg')).toBe(true);
  });

  it('gives a phone the portrait file, and the landscape one when there is none', async () => {
    const golden = render(<LockFace data={face('picture:golden-streak')} now={now} phone />);
    await waitFor(() => expect(golden.container.querySelector('img.lk-photo')).not.toBeNull());
    expect(golden.container.querySelector('img.lk-photo')!.getAttribute('data-fit')).toBe('cover');
    golden.unmount();
    // A phone held on its side is a wide screen.
    const sideways = render(<LockFace data={face('picture:golden-streak')} now={now} phone portrait={false} />);
    await waitFor(() => expect(sideways.container.querySelector('img.lk-photo')).not.toBeNull());
    expect(sideways.container.querySelector('img.lk-photo')!.getAttribute('data-fit')).toBe('contain');
    sideways.unmount();
    const peoria = render(<LockFace data={face('picture:peoria-autumn-waterfront')} now={now} phone />);
    await waitFor(() => expect(peoria.container.querySelector('img.lk-photo')?.getAttribute('src')).toBe('backgrounds/peoria-autumn-waterfront.jpg'));
  });

  it('gives a phone the owner’s portrait version, and falls back to Earth for a picture the list no longer has', async () => {
    const own = render(<LockFace data={face('image', { image: '/api/lock/background?v=1', imagePortrait: '/api/lock/background/portrait?v=2' })} now={now} phone />);
    expect(own.container.querySelector('img.lk-photo')!.getAttribute('src')).toBe('/api/lock/background/portrait?v=2');
    own.unmount();
    const gone = render(<LockFace data={face('picture:retired')} now={now} phone={false} />);
    await waitFor(() => expect(gone.container.querySelector('img.lk-photo[data-earth="true"]')?.getAttribute('src')).toBe(EARTH_PHOTO.desk));
  });
});
