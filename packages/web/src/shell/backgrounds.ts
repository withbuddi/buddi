/**
 * The pictures the lock screen can be drawn on beside Earth, as listed in
 * `public/backgrounds/manifest.json`: an id, a title, the credit said under
 * the picker, and a landscape file, a portrait file or both (plus a small
 * thumbnail for the picker). Files sit next to the manifest, JPEGs of at most
 * 2560 pixels on the long side with no metadata. The gateway checks a pick
 * against the same manifest (gateway web/lock-backgrounds.ts).
 *
 * The screen takes the file for its shape: portrait on a tall screen (a
 * phone), landscape on a wide one, and the other one when the picture has
 * only that. A portrait-only picture on a wide screen is shown whole, in the
 * middle, over the field gradient, rather than cropped to a sliver.
 *
 * Credits are text, never links: the page names no host it does not fetch.
 *
 * - Peoria autumn waterfront: made with AI for buddi.
 * - Golden streak: after a photo by Valentine Rutto on Unsplash, reworked with
 *   AI. The Unsplash License (https://unsplash.com/license) grants an
 *   irrevocable, worldwide right to copy, modify, distribute and use the
 *   photos for free, commercial use included, without asking; modifying is
 *   named, so a reworked derivative is allowed. It forbids selling unaltered
 *   copies and compiling photos into a competing service, neither of which
 *   this is.
 */
import { useEffect, useState } from 'react';
import type { LockBackground } from '../api';

/** Where the list is, relative to the page (the build's base is `./`). */
export const LOCK_PICTURES_DIR = 'backgrounds/';
export const LOCK_PICTURES_MANIFEST = `${LOCK_PICTURES_DIR}manifest.json`;

export interface LockPicture {
  id: string;
  title: string;
  credit: string;
  /** The page-relative paths of its files; at least one of landscape and portrait. */
  landscape: string | null;
  portrait: string | null;
  thumb: string | null;
}

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FILE = /^[\w.-]+\.jpg$/;

/** The manifest, made sound: an entry missing what it needs is left out, never guessed at. */
export function lockPicturesOf(raw: unknown): LockPicture[] {
  const list = (raw as { pictures?: unknown } | null)?.pictures;
  if (!Array.isArray(list)) return [];
  const out: LockPicture[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const p = entry as Record<string, unknown>;
    if (typeof p.id !== 'string' || !ID.test(p.id) || p.id.length > 64 || out.some((o) => o.id === p.id)) continue;
    if (typeof p.title !== 'string' || !p.title.trim() || typeof p.credit !== 'string' || !p.credit.trim()) continue;
    const file = (v: unknown): string | null | undefined => (v === undefined ? null : typeof v === 'string' && FILE.test(v) ? `${LOCK_PICTURES_DIR}${v}` : undefined);
    const landscape = file(p.landscape);
    const portrait = file(p.portrait);
    const thumb = file(p.thumb);
    if (landscape === undefined || portrait === undefined || thumb === undefined || (!landscape && !portrait)) continue;
    out.push({ id: p.id, title: p.title.trim(), credit: p.credit.trim(), landscape, portrait, thumb });
  }
  return out;
}

let loaded: Promise<LockPicture[]> | null = null;

/** The list, read once per page; a failed read is tried again next time. */
export function loadLockPictures(): Promise<LockPicture[]> {
  if (!loaded) {
    const attempt = (async () => {
      const res = await fetch(LOCK_PICTURES_MANIFEST, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`manifest ${res.status}`);
      return lockPicturesOf(await res.json());
    })();
    loaded = attempt;
    attempt.catch(() => { if (loaded === attempt) loaded = null; });
  }
  return loaded;
}

/** For tests: forget the list read so far. */
export function forgetLockPictures(): void {
  loaded = null;
}

/** The pictures, null until read (an empty list when the read failed). Reads only when `wanted`. */
export function useLockPictures(wanted = true): LockPicture[] | null {
  const [pictures, setPictures] = useState<LockPicture[] | null>(null);
  useEffect(() => {
    if (!wanted) return undefined;
    let live = true;
    loadLockPictures().then((list) => { if (live) setPictures(list); }, () => { if (live) setPictures([]); });
    return () => { live = false; };
  }, [wanted]);
  return pictures;
}

const PREFIX = 'picture:';

/** A picture's background value, `picture:<id>`. */
export function pictureBackground(id: string): LockBackground {
  return `${PREFIX}${id}`;
}

/** The manifest id a background names, or null when it is not a picture. */
export function pictureIdOf(background: LockBackground | undefined | null): string | null {
  return typeof background === 'string' && background.startsWith(PREFIX) ? background.slice(PREFIX.length) : null;
}

/**
 * The file for a screen of this shape. `cover` fills the screen; `contain`
 * is a portrait-only picture on a wide screen, shown whole over the field.
 */
export function pictureSource(picture: Pick<LockPicture, 'landscape' | 'portrait'>, portrait: boolean): { src: string; fit: 'cover' | 'contain' } {
  if (portrait) return { src: (picture.portrait ?? picture.landscape)!, fit: 'cover' };
  if (picture.landscape) return { src: picture.landscape, fit: 'cover' };
  return { src: picture.portrait!, fit: 'contain' };
}

/** The owner's picture for a screen of this shape: its portrait version on a tall screen when there is one. */
export function ownImageSource(image: string, imagePortrait: string | null | undefined, portrait: boolean): string {
  return portrait && imagePortrait ? imagePortrait : image;
}
