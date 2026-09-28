/**
 * The Blob, moving.
 *
 * The still (`public/mascot/<role>.png`) is drawn at once, so the first paint
 * never waits for anything. The first Blob to mount then fetches the player —
 * `lottie-web`'s light SVG build, a chunk of its own that the page never loads
 * otherwise — and the loop's JSON, and the loop takes the still's place in the
 * same box. The still stays when there is no loop for the role, when either
 * file fails, when the owner asks for reduced motion, where `matchMedia`
 * does not exist to ask, and at `xs`, where a breath is too small to see. A
 * loop in a hidden tab is paused.
 */
import { useEffect, useRef, useState } from 'react';
import { mascotAnimUrl, mascotUrl, type MascotAnimState, type MascotRole } from '../views/meet/script';

type Player = typeof import('lottie-web/build/player/lottie_light').default;

let player: Promise<Player> | null = null;
const loops = new Map<string, Promise<string | null>>();

/** The player, fetched once for the page and shared by every Blob. */
function loadPlayer(): Promise<Player> {
  player ??= import('lottie-web/build/player/lottie_light').then((module) => module.default);
  player.catch(() => { player = null; });
  return player;
}

/** A loop's JSON text, fetched once; null when it is not there. */
function loadLoop(url: string): Promise<string | null> {
  let loop = loops.get(url);
  if (!loop) {
    loop = fetch(url)
      .then((response) => (response.ok ? response.text() : null))
      .catch(() => null);
    loops.set(url, loop);
  }
  return loop;
}

/** For tests: forget the player and the loops fetched so far. */
export function forgetBlobCache(): void {
  player = null;
  loops.clear();
}

const REDUCED = '(prefers-reduced-motion: reduce)';

/** Whether this page may move: false under reduced motion, and where it cannot be asked. */
function useMayMove(): boolean {
  const [may, setMay] = useState(() => typeof window.matchMedia === 'function' && !window.matchMedia(REDUCED).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(REDUCED);
    const onChange = (): void => setMay(!query.matches);
    query.addEventListener?.('change', onChange);
    return () => query.removeEventListener?.('change', onChange);
  }, []);
  return may;
}

export type BlobSize = 'xs' | 'sm' | 'md' | 'lg';

export function Blob({
  role = 'core',
  state,
  size,
  still,
  className,
  onStillError,
}: {
  role?: MascotRole;
  state: MascotAnimState;
  /** The box, from the tokens; leave it out when `className` sizes it. */
  size?: BlobSize;
  /** The picture to show until (or instead of) the loop; the role's still by default. */
  still?: string;
  className?: string;
  /** The still failed to load: the caller may draw something else. */
  onStillError?: () => void;
}): JSX.Element {
  const box = useRef<HTMLSpanElement>(null);
  const mayMove = useMayMove();
  const [playing, setPlaying] = useState(false);
  // Below `sm` the motion does not read, so the still is all there is.
  const url = size === 'xs' ? null : mascotAnimUrl(role, state);

  useEffect(() => {
    setPlaying(false);
    if (!mayMove || !url) return undefined;
    let cancelled = false;
    let destroy: (() => void) | null = null;
    void Promise.all([loadPlayer(), loadLoop(url)])
      .then(([lottie, json]) => {
        if (cancelled || !json || !box.current) return;
        // The player writes into the data it is given, so each Blob gets its own copy.
        const animation = lottie.loadAnimation({
          container: box.current,
          renderer: 'svg',
          loop: true,
          autoplay: !document.hidden,
          animationData: JSON.parse(json) as unknown,
          rendererSettings: { preserveAspectRatio: 'xMidYMid meet' },
        });
        const onVisibility = (): void => {
          if (document.hidden) animation.pause();
          else animation.play();
        };
        document.addEventListener('visibilitychange', onVisibility);
        destroy = () => {
          document.removeEventListener('visibilitychange', onVisibility);
          animation.destroy();
        };
        setPlaying(true);
      })
      .catch(() => {
        /* No player, no loop: the still stays. */
      });
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [mayMove, url]);

  return (
    <span
      ref={box}
      className={className ? `ui-blob ${className}` : 'ui-blob'}
      data-size={size}
      data-playing={playing ? 'true' : undefined}
      data-testid="blob"
      data-state={state}
      aria-hidden="true"
    >
      {playing ? null : <img src={still ?? mascotUrl(role)} alt="" onError={onStillError} />}
    </span>
  );
}

/** A picture's rough look: drawn over white into 8×8, the pixels' colours. */
async function glance(src: string): Promise<number[] | null> {
  const image = new Image();
  image.src = src;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.fillStyle = '#fff';
  context.fillRect(0, 0, 8, 8);
  context.drawImage(image, 0, 0, 8, 8);
  return Array.from(context.getImageData(0, 0, 8, 8).data);
}

/**
 * Whether an uploaded picture is the role's bundled still.
 *
 * An agent's face reaches the gateway as an upload, re-encoded, so nothing
 * records that it was the Blob. Home's greeting face moves only when it is
 * — an owner's own photo must never be swapped for a cartoon — so the two
 * are compared at a glance: small enough to ignore the re-encoding, close
 * enough that nothing else passes. The bundled still's own URL needs no
 * glance: it is the Blob, known at once. False until known, and wherever the
 * page may not move.
 */
export function useIsBlobStill(picture: string | null, role: MascotRole = 'core'): boolean {
  const mayMove = useMayMove();
  const bundled = picture !== null && isBundledStill(picture, role);
  const [same, setSame] = useState(false);
  useEffect(() => {
    setSame(false);
    if (!picture || bundled || !mayMove || !mascotAnimUrl(role, 'idle')) return undefined;
    let cancelled = false;
    void Promise.all([glance(picture), glance(mascotUrl(role))])
      .then(([a, b]) => {
        if (cancelled || !a || !b || a.length !== b.length) return;
        const distance = a.reduce((sum, value, i) => sum + Math.abs(value - b[i]!), 0) / a.length;
        setSame(distance < 12);
      })
      .catch(() => {
        /* Cannot tell: the picture stays still. */
      });
    return () => {
      cancelled = true;
    };
  }, [picture, bundled, mayMove, role]);
  return mayMove && mascotAnimUrl(role, 'idle') !== null && (bundled || same);
}

/** Whether a URL is the role's bundled still itself, however it is written. */
function isBundledStill(picture: string, role: MascotRole): boolean {
  const still = mascotUrl(role);
  if (picture === still) return true;
  try {
    const base = typeof window === 'undefined' ? 'http://localhost/' : window.location.href;
    return new URL(picture, base).href === new URL(still, base).href;
  } catch {
    return false;
  }
}
