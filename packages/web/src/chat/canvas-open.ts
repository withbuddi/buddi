/**
 * Whether the desktop canvas is open, per conversation.
 *
 * A conversation starts as a conversation: the chat has the whole width and
 * there is no empty canvas beside it waiting to be filled. The canvas opens by
 * itself the first time something lands on it, and from then on it is the
 * owner's: once he closes it, it stays closed for that conversation, and what
 * arrives later only counts up on the header's Canvas button. He opens it
 * again from there whenever he likes, empty or not.
 *
 * Three states, of which only two are ever stored: never decided (closed
 * until used), open, and closed by the owner. Kept in sessionStorage keyed by
 * conversation, so a reload keeps the choice and a new tab starts fresh. A
 * conversation that has no id yet keeps its state in memory and hands it to
 * the id it is given, so closing the canvas before the first reply sticks.
 *
 * The phone never reads this: there the canvas is a sheet the owner opens.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type CanvasMode = 'open' | 'closed';

const PREFIX = 'buddi.canvas.';
/** The conversation that has no id yet. */
const NEW = '';

function read(id: string): CanvasMode | null {
  try {
    const value = window.sessionStorage.getItem(PREFIX + id);
    return value === 'open' || value === 'closed' ? value : null;
  } catch {
    return null;
  }
}

function write(id: string, mode: CanvasMode): void {
  try {
    window.sessionStorage.setItem(PREFIX + id, mode);
  } catch {
    // Private windows and blocked storage: the choice lasts as long as the page.
  }
}

export function useCanvasOpen(conversationId: string | null, used: boolean): {
  open: boolean;
  /** The owner's decision, or the first arrival's: remembered for this conversation. */
  setMode: (mode: CanvasMode) => void;
} {
  const key = conversationId ?? NEW;
  const [modes, setModes] = useState<Record<string, CanvasMode | null>>({});
  const mode = key in modes ? modes[key] ?? null : conversationId ? read(conversationId) : null;

  const setMode = useCallback((next: CanvasMode): void => {
    setModes((current) => (current[key] === next ? current : { ...current, [key]: next }));
    if (key !== NEW) write(key, next);
  }, [key]);

  /*
   * A fresh conversation's choice follows it to its id; a new one starts
   * undecided again. Switching between two existing conversations carries
   * nothing: each has its own.
   */
  const previous = useRef(key);
  useEffect(() => {
    const before = previous.current;
    previous.current = key;
    if (before === key) return;
    if (before === NEW && key !== NEW) {
      const carried = modes[NEW];
      if (carried && read(key) === null) {
        write(key, carried);
        setModes((current) => ({ ...current, [key]: carried }));
      }
    }
    if (key === NEW) setModes((current) => (current[NEW] === undefined ? current : { ...current, [NEW]: null }));
    // Only on a change of conversation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // The first arrival opens it, and that is remembered: closing every tab
  // afterwards leaves an open, empty canvas rather than folding it away.
  useEffect(() => {
    if (mode === null && used) setMode('open');
  }, [mode, used, setMode]);

  return { open: mode === 'open' || (mode === null && used), setMode };
}
