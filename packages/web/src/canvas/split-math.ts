/**
 * The arithmetic of the grip between the conversation and the canvas.
 *
 * Kept apart from the component so it can be tested without a layout engine:
 * jsdom measures nothing, and every rule here is a rule about numbers.
 *
 * Widths are the conversation column's, in CSS pixels. `shared` is the room
 * the two panes split between them — the column plus the canvas — so the
 * snap points are fractions of what the owner is actually dividing, not of
 * the window with its rails.
 */

/** The conversation never gets narrower than a readable column. */
export const CHAT_MIN = 320;
/** Nor the canvas narrower than a panel that still draws a table. */
export const CANVAS_MIN = 280;
/** One arrow key press. */
export const KEY_STEP = 24;
/** How close to a snap point a drag has to come to stick to it. */
export const DETENT = 12;
/** A third, a half, two thirds of the shared room. */
export const SNAPS: readonly number[] = [1 / 3, 1 / 2, 2 / 3];

/** Where the width is kept, per device. The key predates this file. */
export const WIDTH_KEY = 'buddi.chatWidth';

/** The column's narrowest and widest, for this much shared room. */
export function bounds(shared: number): { min: number; max: number } {
  return { min: CHAT_MIN, max: Math.max(CHAT_MIN, Math.round(shared) - CANVAS_MIN) };
}

/** A width both panes can live with. Without a measure (0), only the floor holds. */
export function clamp(width: number, shared: number): number {
  const { min, max } = bounds(shared);
  if (!Number.isFinite(width)) return min;
  if (shared <= 0) return Math.max(min, Math.round(width));
  return Math.min(max, Math.max(min, Math.round(width)));
}

/**
 * The soft detent: within `DETENT` of a third, a half or two thirds, the
 * width sits exactly on it. Past that it follows the pointer again, so a
 * snap point is felt, not imposed.
 */
export function snap(width: number, shared: number): number {
  if (shared <= 0) return width;
  for (const fraction of SNAPS) {
    const target = Math.round(shared * fraction);
    if (Math.abs(width - target) <= DETENT) return target;
  }
  return width;
}

/** A drag's width: snapped, then held inside both panes' minimums. */
export function dragWidth(raw: number, shared: number): number {
  return clamp(snap(raw, shared), shared);
}

/**
 * What a key does to the width when the grip has focus, or null for a key
 * it leaves alone. Arrows move a step; Home and End go to the ends. Keys do
 * not snap: a keyboard user asked for exactly 24 pixels.
 */
export function keyWidth(current: number, key: string, shared: number): number | null {
  const { min, max } = bounds(shared);
  switch (key) {
    case 'ArrowLeft':
      return clamp(current - KEY_STEP, shared);
    case 'ArrowRight':
      return clamp(current + KEY_STEP, shared);
    case 'Home':
      return min;
    case 'End':
      return shared > 0 ? max : null;
    default:
      return null;
  }
}

/** The saved width, or null for the kit's own flex. Never throws. */
export function readWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(WIDTH_KEY);
    if (raw === null) return null;
    const stored = Number(raw);
    return Number.isFinite(stored) && stored >= CHAT_MIN ? Math.round(stored) : null;
  } catch {
    return null;
  }
}

/** Keep the width on this device; null forgets it. A private window just forgets. */
export function saveWidth(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(WIDTH_KEY);
    else window.localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
  } catch {
    /* storage refused: the width lasts as long as the page */
  }
}
