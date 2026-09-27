/**
 * The page's one speaker: a sound a tool answered with, played and forgotten.
 *
 * `docs/plugin-pages.md` §4, "A sound". A page action whose tool result carries
 * `play: { mime, data }` has it played here, through a single shared `Audio`
 * element and a blob URL that is revoked the moment the sound stops. Nothing
 * is written anywhere — not the Files library, not browser storage — and a
 * second sound stops the first, so two buttons can never talk over each other.
 *
 * Whoever started the sound is remembered by an opaque key, so the button that
 * started it can draw itself as a stop button and nobody else does.
 */
import { useSyncExternalStore } from 'react';
import type { PagePlay } from './types';

/** The most audio a `play` result may carry, decoded: core's `PAGE_PLAY_MAX_BYTES`. */
export const PLAY_MAX_BYTES = 512 * 1024;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The `play` of a tool result, when it is one the page may play; null otherwise. */
export function playOf(result: unknown): PagePlay | null {
  const play = (result as { play?: unknown } | null | undefined)?.play;
  if (typeof play !== 'object' || play === null) return null;
  const { mime, data } = play as { mime?: unknown; data?: unknown };
  if (typeof mime !== 'string' || !/^audio\/[a-z0-9.+-]+$/i.test(mime.split(';')[0]!.trim())) return null;
  if (typeof data !== 'string' || data === '' || !BASE64.test(data)) return null;
  // Decoded size, from the base64 length: three bytes per four characters.
  if (Math.floor((data.length * 3) / 4) > PLAY_MAX_BYTES + 2) return null;
  return { mime, data };
}

/** A tool result's `message`, when it has one to say. */
export function messageOf(result: unknown): string | null {
  const message = (result as { message?: unknown } | null | undefined)?.message;
  return typeof message === 'string' && message.trim() !== '' ? message : null;
}

let element: HTMLAudioElement | null = null;
let url: string | null = null;
let owner: string | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Let go of the current sound, if any: pause it and revoke its URL. */
function release(): void {
  if (element) {
    element.onended = null;
    element.onerror = null;
    element.pause();
  }
  if (url) URL.revokeObjectURL(url);
  url = null;
  if (owner !== null) {
    owner = null;
    notify();
  }
}

/**
 * Play a sound; resolves once it has started, rejects when the browser will
 * not play it. Whatever was playing stops first.
 */
export async function playSound(play: PagePlay, by: string): Promise<void> {
  release();
  const binary = atob(play.data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  element ??= new Audio();
  url = URL.createObjectURL(new Blob([bytes], { type: play.mime }));
  owner = by;
  element.onended = release;
  element.onerror = release;
  element.src = url;
  notify();
  try {
    await element.play();
  } catch {
    // Autoplay refused, or a format this browser cannot decode.
    release();
    throw new Error('The browser would not play the sound.');
  }
}

/** Stop the sound — only when `by` started it, when a key is given. */
export function stopSound(by?: string): void {
  if (by !== undefined && owner !== by) return;
  release();
}

/** The key of whoever's sound is playing now, or null. */
export function usePlaying(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => owner,
    () => null,
  );
}

/** For tests: forget the element, so a fresh mock is used. */
export function resetPlayer(): void {
  release();
  element = null;
}
